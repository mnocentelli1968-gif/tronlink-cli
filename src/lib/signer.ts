import { spawn } from 'node:child_process';
import { openSync, closeSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { TronSigner } from 'tronlink-signer';
import type { TronNetwork } from './types.js';

import { outputInfo, createSpinner } from './output.js';
import { tryConnectIPC, type IPCClient } from './ipc.js';

export type BroadcastStatus = 'success' | 'pending' | 'failed';

export interface SignTransactionResult {
  signedTransaction?: Record<string, unknown>;
  txId?: string;
  status?: BroadcastStatus;
  error?: string;
}

let signerInstance: TronSigner | null = null;
let ipcClient: IPCClient | null = null;
let signerAbort: AbortController | null = null;

const DEFAULT_TIMEOUT = 300_000; // 5 minutes



/**
 * Initialize signer. Tries to reuse a running serve daemon via IPC.
 * If no daemon is running, auto-starts one in the background.
 * Falls back to in-process signer if daemon start fails.
 */
export async function initSigner(port?: number): Promise<TronSigner> {
  // 1. Try existing serve daemon
  const existing = await tryConnectIPC();
  if (existing) {
    ipcClient = existing;
    outputInfo('Connected to signer');
    return {} as TronSigner;
  }

  // 2. Try to auto-start daemon
  const client = await spawnDaemon(port);
  if (client) {
    ipcClient = client;
    outputInfo('Signer started in background');
    return {} as TronSigner;
  }

  // 3. Fall back to in-process signer
  if (port) {
    process.env.TRON_HTTP_PORT = String(port);
  }
  if (!signerInstance) {
    signerInstance = new TronSigner();
  }
  // Mirror the daemon's safety net (commands/serve.ts) so floating promise
  // rejections from the SDK (e.g. WALLET_CHANGED clearing pendings, abort
  // cleanup) don't crash the CLI process. Real errors still surface via the
  // awaited call paths in getWalletAddress/signTransaction.
  process.on('unhandledRejection', (err) => {
    if (err instanceof Error && err.message === 'CANCELLED_BY_CALLER') return;
    if (err instanceof Error && /^WALLET_CHANGED/.test(err.message)) return;
    console.error('[signer] Unhandled rejection:', err);
  });
  await signerInstance.start();

  // Only stop signer on process exit/SIGTERM, NOT on SIGINT
  // SIGINT (Ctrl+C) should only abort the current operation via createSignerAbort()
  const signer = signerInstance;
  const cleanup = () => {
    signer.stop().catch(() => {});
  };
  process.once('SIGTERM', cleanup);
  process.once('exit', cleanup);

  return signerInstance;
}

/**
 * Spawn serve daemon in background and wait for IPC to be ready.
 */
async function spawnDaemon(port?: number): Promise<IPCClient | null> {
  try {
    const args = [process.argv[1], 'serve', '--daemon'];
    if (port) args.push('--port', String(port));

    const logDir = join(homedir(), '.tronlink-cli');
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    const logPath = join(logDir, 'daemon.log');
    const logFd = openSync(logPath, 'a');
    const child = spawn(process.argv[0], args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
      env: { ...process.env },
    });
    child.unref();
    closeSync(logFd);

    for (let i = 0; i < 50; i++) {
      await new Promise(r => setTimeout(r, 200));
      const client = await tryConnectIPC();
      if (client) return client;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Create an AbortController for the current signer operation.
 * Ctrl+C in non-IPC mode aborts the current operation instead of killing the process.
 */
function createSignerAbort(): AbortController {
  // Clean up previous
  if (signerAbort) signerAbort.abort();
  signerAbort = new AbortController();

  const onSigint = () => {
    signerAbort?.abort();
    // Remove listener so next Ctrl+C kills the process
    process.removeListener('SIGINT', onSigint);
  };
  process.on('SIGINT', onSigint);

  // Clean up SIGINT listener when signal is used or GC'd
  signerAbort.signal.addEventListener('abort', () => {
    process.removeListener('SIGINT', onSigint);
  }, { once: true });

  return signerAbort;
}

export async function getWalletAddress(
  signer: TronSigner,
  network?: TronNetwork,
  forceConnect = false,
): Promise<{ address: string; network: TronNetwork }> {
  // `forceConnect` bypasses the IPC cache and prompts TronLink re-approval.
  // Use it for commands where the cached wallet would be wrong: `connect` and
  // `network` are explicit wallet-interaction commands, and `balance`/`resource`
  // display terminal state with no sign-time WALLET_CHANGED fallback. Transaction
  // commands omit it because the signer rejects stale-cache attempts at sign time.
  const targetNetwork: TronNetwork = network || 'mainnet';
  let address: string;
  let walletNetwork: TronNetwork = targetNetwork;

  if (ipcClient) {
    const cached = forceConnect
      ? null
      : await ipcClient.call('getConnectedWallet', {}) as { address: string; network: string } | null;
    if (cached) {
      address = cached.address;
      outputInfo(`Wallet: ${address} (${walletNetwork})`);
    } else {
      outputInfo('Connecting wallet (check browser tab to approve)...');
      let result: { address: string; network: string };
      try {
        result = await withTimeout(
          ipcClient.call('connectWallet', { network: targetNetwork }) as Promise<{ address: string; network: string }>,
          getTimeout(),
          'Wallet connection timed out. Please try again',
        );
      } catch (err) {
        const reason = walletChangedReason(err);
        if (reason) throw walletChangedError(reason);
        throw err;
      }
      address = result.address;
      walletNetwork = result.network as TronNetwork;
      outputInfo(`Wallet connected: ${address} (${walletNetwork})`);
    }
  } else {
    outputInfo('Connecting wallet...');
    const controller = createSignerAbort();
    const result = await withTimeout(
      signer.connectWallet(targetNetwork, { signal: controller.signal }),
      getTimeout(),
      'Wallet connection timed out. Please try again',
    );
    address = result.address;
    walletNetwork = result.network as TronNetwork;
    outputInfo(`Connected: ${address} (${walletNetwork})`);
  }

  return { address, network: walletNetwork };
}

export async function signTransaction(
  signer: TronSigner,
  transaction: unknown,
  network?: TronNetwork,
  broadcast = true,
): Promise<SignTransactionResult> {
  const approvalSpinner = createSpinner('Awaiting TronLink approval (check browser tab)...');

  // Strategy:
  // - Browser SDK polls on-chain and shows result in UI; CLI also polls independently.
  // - onBroadcasted fires the instant the browser reports a successful broadcast
  //   (via POST /api/broadcasted/:id), before the signTransaction promise resolves.
  //   If the promise later rejects (tab closed, WALLET_CHANGED, heartbeat timeout),
  //   we still have txId + signedTransaction and can treat the tx as broadcasted,
  //   so the caller keeps the on-chain poll path and the tx isn't lost.
  try {
    let result: SignTransactionResult;
    if (ipcClient) {
      // daemon applies the same recovery internally and returns a normal result
      result = await withTimeout(
        ipcClient.call('signTransaction', {
          transaction: transaction as Record<string, unknown>,
          network,
          broadcast,
        }) as Promise<SignTransactionResult>,
        getTimeout(),
        'Transaction signing timed out. Please run the command again',
      );
    } else {
      result = await signInProcess(signer, transaction, network, broadcast);
    }

    if (broadcast && !result.txId) {
      approvalSpinner.fail('Approval failed');
      throw new Error('Signer reported broadcast but returned no transaction ID — the transaction may have been rejected by the network');
    }
    approvalSpinner.succeed(broadcast ? `Broadcasted (TxID: ${result.txId})` : 'Signed');
    return result;
  } catch (err) {
    const reason = walletChangedReason(err);
    if (reason) {
      approvalSpinner.fail('Cancelled: wallet changed in TronLink');
      throw walletChangedError(reason);
    }
    approvalSpinner.fail('Approval failed');
    throw err;
  }
}

async function signInProcess(
  signer: TronSigner,
  transaction: unknown,
  network: TronNetwork | undefined,
  broadcast: boolean,
): Promise<SignTransactionResult> {
  const controller = createSignerAbort();
  let captured: { txId: string; signedTransaction: Record<string, unknown> } | null = null;

  try {
    return await withTimeout(
      signer.signTransaction(
        transaction as Record<string, unknown>,
        network,
        broadcast,
        {
          signal: controller.signal,
          onBroadcasted: (info) => { captured = info; },
        },
      ),
      getTimeout(),
      'Transaction signing timed out. Please run the command again',
    );
  } catch (err) {
    if (broadcast && captured) {
      // Broadcast already succeeded — don't lose the txId just because the browser
      // side couldn't deliver the final response. CLI will poll on-chain result.
      return {
        signedTransaction: (captured as { signedTransaction: Record<string, unknown> }).signedTransaction,
        txId: (captured as { txId: string }).txId,
        status: 'pending',
      };
    }
    throw err;
  }
}

export async function stopSigner(): Promise<void> {
  if (ipcClient) {
    ipcClient.disconnect();
    ipcClient = null;
    return;
  }
  if (signerInstance) {
    await signerInstance.stop();
    signerInstance = null;
  }
}

function getTimeout(): number {
  const env = process.env.TRONLINK_TIMEOUT;
  if (env) {
    const val = Number(env);
    if (!isNaN(val) && val > 0) return val;
  }
  return DEFAULT_TIMEOUT;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise
      .then((val) => { clearTimeout(timer); resolve(val); })
      .catch((err) => { clearTimeout(timer); reject(err); });
  });
}

function walletChangedReason(err: unknown): string | null {
  if (!(err instanceof Error)) return null;
  const m = err.message.match(/^WALLET_CHANGED(?::\s*(.+))?/);
  return m ? (m[1] || 'changed') : null;
}

function walletChangedError(reason: string): Error {
  const text = reason === 'account' ? 'Wallet account switched in TronLink'
    : reason === 'network' ? 'Wallet network switched in TronLink'
    : reason === 'disconnect' ? 'Wallet disconnected in TronLink'
    : `Wallet changed in TronLink (${reason})`;
  return new Error(`${text}. Please re-run the command.`);
}
