import { Command } from 'commander';
import { getTronWeb, trxToSun, broadcastTx, validateAddress, waitForTxResult } from '../lib/tronweb.js';
import { initSigner, getWalletAddress, signTransaction, stopSigner } from '../lib/signer.js';
import { outputResult, outputAction, createSpinner, confirmOnChain } from '../lib/output.js';
import { handleError } from '../lib/error.js';
import { getExplorerTxUrl, validateNetworkOption, type ResourceType } from '../lib/types.js';
import { runPrecheck, measureTxBytes, checkReclaim } from '../lib/precheck.js';

export function registerReclaimCommand(program: Command): void {
  program
    .command('reclaim')
    .description('Reclaim delegated energy or bandwidth')
    .requiredOption('--fromAddress <address>', 'Address to reclaim from')
    .requiredOption('--amount <amount>', 'Amount of TRX to reclaim')
    .requiredOption('--resource <type>', 'Resource type: energy or bandwidth')
    .option('--network <name>', 'Network: mainnet, nile, shasta')
    .action(async (cmdOpts, cmd) => {
      const opts = cmd.optsWithGlobals();
      try {
        validateNetworkOption(cmdOpts.network);
        validateAddress(cmdOpts.fromAddress, 'target address');
        const resource = parseResource(cmdOpts.resource);
        const amountSun = trxToSun(cmdOpts.amount);

        const signer = await initSigner(opts.port);
        const { address, network } = await getWalletAddress(signer, cmdOpts.network);
        const tronWeb = getTronWeb(network, opts.apiKey);
        const broadcast = !opts.localBroadcast;

        const spinner = createSpinner('Building transaction...');
        const [tx, accountResource] = await Promise.all([
          tronWeb.transactionBuilder.undelegateResource(
            amountSun,
            cmdOpts.fromAddress,
            resource,
            address,
          ),
          tronWeb.trx.getAccountResources(address),
        ]);

        const totalWeight = resource === 'ENERGY'
          ? accountResource.TotalEnergyWeight
          : accountResource.TotalNetWeight;
        const totalLimit = resource === 'ENERGY'
          ? accountResource.TotalEnergyLimit
          : accountResource.TotalNetLimit;
        const estimatedResource = totalWeight > 0
          ? Number(
              (BigInt(amountSun) * BigInt(totalLimit)) /
              (BigInt(totalWeight) * 1_000_000n),
            )
          : 0;

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (tx as any).__options = resource === 'ENERGY'
          ? { estimatedEnergy: estimatedResource }
          : { estimatedBandwidth: estimatedResource };

        spinner.succeed(`Transaction built (estimated ${resource.toLowerCase()}: ${estimatedResource.toLocaleString()})`);

        await runPrecheck('Checking delegated amount...', () =>
          checkReclaim(tronWeb, address, cmdOpts.fromAddress, resource, amountSun, measureTxBytes(tx)));

        outputAction({
          Action: 'Reclaim Delegated Resource',
          Network: network,
          From: cmdOpts.fromAddress,
          Reclaimer: address,
          Amount: `${cmdOpts.amount} TRX`,
          Resource: resource,
          Broadcast: broadcast ? 'Signer' : 'Local',
        });

        const result = await signTransaction(signer, tx, network, broadcast);

        const txId = broadcast ? result.txId! : await broadcastTx(tronWeb, result.signedTransaction);
        await confirmOnChain(waitForTxResult(tronWeb, txId));
        outputResult(
          {
            Status: 'Success',
            TxID: txId,
            From: cmdOpts.fromAddress,
            Reclaimer: address,
            Amount: `${cmdOpts.amount} TRX`,
            Resource: resource,
            Explorer: getExplorerTxUrl(network, txId),
          },
          'Reclaim Result',
          opts.json,
        );
        await stopSigner();
      } catch (err) {
        await stopSigner();
        handleError(err);
      }
    });
}

function parseResource(input: string): ResourceType {
  const upper = input.toUpperCase();
  if (upper === 'ENERGY') return 'ENERGY';
  if (upper === 'BANDWIDTH') return 'BANDWIDTH';
  throw new Error(`Invalid resource type: "${input}". Use "energy" or "bandwidth"`);
}
