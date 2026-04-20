import { Command } from 'commander';
import { TronSigner } from 'tronlink-signer';
import { startIPCServer, writeServeState, clearServeState, readServeState, acquireBootLock, isDaemonAlive, tryConnectIPC } from '../lib/ipc.js';

import { validateNetworkOption, type TronNetwork } from '../lib/types.js';
import { outputSuccess, outputResult, outputInfo } from '../lib/output.js';
import { handleError } from '../lib/error.js';

export function registerServeCommand(program: Command): void {
  const serve = program
    .command('serve')
    .description('Manage persistent signer (auto-started by other commands)');

  serve
    .option('--network <name>', 'Network: mainnet, nile, shasta')
    .option('--daemon', 'Run in background (used internally)')
    .action(async (cmdOpts, cmd) => {
      const opts = cmd.optsWithGlobals();
      let releaseBootLock: (() => void) | null = null;
      try {
        validateNetworkOption(cmdOpts.network);

        // Liveness = socket connectivity (not PID). PID is reused by the kernel
        // and cannot be trusted across daemon crashes.
        if (await isDaemonAlive()) {
          const existing = readServeState();
          if (cmdOpts.daemon) process.exit(0);
          const suffix = existing ? ` (PID: ${existing.pid}, port: ${existing.port})` : '';
          console.error(`Serve is already running${suffix}. Use "tronlink serve stop" to stop it first.`);
          process.exit(1);
        }
        // Socket dead → any residual state is stale regardless of PID.
        clearServeState();

        // Short-lived lock guarding only the startup sequence (unlink + listen).
        // Released as soon as listen succeeds — the running daemon is identified
        // by its live socket, not by this lock.
        releaseBootLock = acquireBootLock();
        if (!releaseBootLock) {
          if (cmdOpts.daemon) process.exit(0);
          console.error('Another serve instance is starting. Please wait.');
          process.exit(1);
        }

        const port = opts.port || 3386;
        if (opts.port) {
          process.env.TRON_HTTP_PORT = String(port);
        }

        // Catch unhandled rejections from SDK's attachAbortSignal
        // (promise.finally() creates a floating rejected promise on abort)
        process.on('unhandledRejection', (err) => {
          if (err instanceof Error && err.message === 'CANCELLED_BY_CALLER') return;
          console.error('[serve] Unhandled rejection:', err);
        });

        const signer = new TronSigner();
        await signer.start();

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const actualPort: number = typeof (signer as any).getPort === 'function'
          ? (signer as any).getPort()
          : signer.getConfig().httpPort;

        // Browser UI now shows all pending requests as tabs, so no queue concept on the CLI side.
        const ipcServer = await startIPCServer(async (method, params, signal) => {
          if (method === 'connectWallet') {
            return signer.connectWallet(
              params.network as TronNetwork | undefined,
              { signal },
            );
          }
          if (method === 'getConnectedWallet') {
            return signer.getConnectedWallet();
          }
          if (method === 'signTransaction') {
            // Browser SDK polls on-chain and shows result in UI; CLI client also polls
            // independently. onBroadcasted captures {txId, signedTransaction} on
            // successful broadcast — if the promise later rejects (tab closed,
            // heartbeat timeout, WALLET_CHANGED), we still return a pending-status
            // result so the client keeps polling and the tx isn't lost.
            const broadcast = params.broadcast as boolean | undefined;
            let captured: { txId: string; signedTransaction: Record<string, unknown> } | null = null;
            try {
              return await signer.signTransaction(
                params.transaction as Record<string, unknown>,
                params.network as TronNetwork | undefined,
                broadcast,
                {
                  signal,
                  onBroadcasted: (info) => { captured = info; },
                },
              );
            } catch (err) {
              if (broadcast && captured) {
                return {
                  signedTransaction: (captured as { signedTransaction: Record<string, unknown> }).signedTransaction,
                  txId: (captured as { txId: string }).txId,
                  status: 'pending' as const,
                };
              }
              throw err;
            }
          }
          if (method === 'ping') {
            return { status: 'ok' };
          }
          if (method === 'shutdown') {
            // Defer so the response can ship before the process dies. Signal
            // ourselves — never trust an external PID to avoid killing an
            // unrelated process that inherited a reused PID.
            setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50);
            return { status: 'shutting down' };
          }
          throw new Error(`Unknown IPC method: ${method}`);
        });

        // Listen succeeded — release boot lock immediately. Do NOT hold it for
        // the daemon's lifetime: liveness is tracked via socket, not this lock.
        releaseBootLock();
        releaseBootLock = null;
        writeServeState(actualPort);

        const cleanup = () => {
          clearServeState();
          ipcServer.close();
          signer.stop().catch(() => {});
          process.exit(0);
        };
        process.on('SIGINT', cleanup);
        process.on('SIGTERM', cleanup);

        // Stop serve when browser is closed
        signer.onBrowserDisconnect = () => {
          console.error('[serve] Browser disconnected, shutting down...');
          cleanup();
        };

        // Log wallet-change events — pendings are already rejected by SDK
        signer.onWalletChanged = (reason) => {
          console.error(`[serve] Wallet changed (${reason}) — all pending requests cancelled.`);
        };

        if (cmdOpts.daemon) {
          setInterval(() => {}, 60_000);
        } else {
          outputInfo('Connecting wallet...');
          const network = cmdOpts.network as TronNetwork | undefined;
          const result = await signer.connectWallet(network);
          const walletNetwork = result.network as TronNetwork;

          outputSuccess(`Connected: ${result.address} (${walletNetwork})`);

          outputResult(
            { PID: process.pid, Port: actualPort, Address: result.address, Network: walletNetwork },
            'Serve Running',
            opts.json,
          );
          outputInfo('Signer is running. Other commands will reuse this session.');
          outputInfo('Press Ctrl+C to stop.\n');
          setInterval(() => {}, 60_000);
        }
      } catch (err) {
        if (releaseBootLock) {
          try { releaseBootLock(); } catch { /* ignore */ }
        }
        clearServeState();
        handleError(err);
      }
    });

  serve
    .command('stop')
    .description('Stop the running serve process')
    .action(async () => {
      const state = readServeState();

      if (!(await isDaemonAlive())) {
        clearServeState();
        if (!state) {
          console.error('No serve process is running.');
          process.exit(1);
        }
        outputSuccess('Serve process was not running. State cleaned up.');
        return;
      }

      // Alive — tell it to shut itself down over IPC. Never send signals to
      // state.pid: the kernel may have reassigned that PID to an unrelated
      // process after a daemon crash.
      const client = await tryConnectIPC();
      if (!client) {
        clearServeState();
        console.error('Could not connect to running serve.');
        process.exit(1);
      }
      try {
        await client.call('shutdown', {}, 5000);
      } catch { /* connection closes during shutdown — expected */ }
      client.disconnect();

      // Wait briefly for the daemon's cleanup to finish (socket disappears).
      for (let i = 0; i < 20; i++) {
        if (!(await isDaemonAlive(100))) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      clearServeState();
      outputSuccess(state ? `Serve process (PID: ${state.pid}) stopped.` : 'Serve process stopped.');
    });
}
