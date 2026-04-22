import { Command } from 'commander';
import { getTronWeb, trxToSun, broadcastTx, validateAddress, waitForTxResult } from '../lib/tronweb.js';
import { initSigner, getWalletAddress, signTransaction, stopSigner } from '../lib/signer.js';
import { outputResult, outputAction, createSpinner, confirmOnChain } from '../lib/output.js';
import { handleError } from '../lib/error.js';
import { getExplorerTxUrl, validateNetworkOption, type TronNetwork } from '../lib/types.js';
import { parseMethodSignature, parseArgsJson, type AbiFragment } from '../lib/abi.js';
import { runPrecheck, measureTxBytes, checkTrigger } from '../lib/precheck.js';

const ARGS_PREVIEW_MAX = 80;

function summarizeArgs(raw: string, parsed: unknown[]): string {
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (compact.length <= ARGS_PREVIEW_MAX) return compact;
  return `[ … ${parsed.length} item${parsed.length === 1 ? '' : 's'} — pass --json for full value ]`;
}

export function registerTriggerCommand(program: Command): void {
  program
    .command('trigger')
    .description('Trigger a smart contract method (constant or writeable)')
    .requiredOption('--contract <address>', 'Contract address')
    .requiredOption('--method <signature>', 'Method signature, e.g. "transfer(address,uint256)" or "swap((address,uint256)[],uint256)"')
    .option('--args <json>', 'Arguments as a JSON array aligned to the method signature, e.g. \'["T...","1000000"]\'', '[]')
    .option('--call-value <trx>', 'TRX sent along with the call (default: 0)')
    .option('--fee-limit <trx>', 'Fee limit in TRX (default: 100)')
    .option('--constant', 'Constant (read-only) call — no signature, no broadcast')
    .option('--address <address>', 'Query address for --constant (skips wallet connection)')
    .option('--network <name>', 'Network: mainnet, nile, shasta')
    .action(async (cmdOpts, cmd) => {
      const opts = cmd.optsWithGlobals();
      try {
        validateNetworkOption(cmdOpts.network);
        validateAddress(cmdOpts.contract, 'contract address');

        const fragment = parseMethodSignature(cmdOpts.method);
        const args = parseArgsJson(cmdOpts.args);
        if (fragment.inputs.length !== args.length) {
          throw new Error(`Args count mismatch: method expects ${fragment.inputs.length}, got ${args.length}`);
        }

        if (cmdOpts.constant) {
          if (cmdOpts.callValue || cmdOpts.feeLimit) {
            throw new Error('--call-value and --fee-limit are not applicable for --constant calls');
          }
          await runConstant(cmdOpts, opts, fragment, args);
        } else {
          if (cmdOpts.address) {
            throw new Error('--address is only valid with --constant');
          }
          await runWriteable(cmdOpts, opts, fragment, args);
        }

        await stopSigner();
      } catch (err) {
        await stopSigner();
        handleError(err);
      }
    });
}

async function runConstant(
  cmdOpts: Record<string, string | undefined>,
  opts: Record<string, unknown>,
  fragment: AbiFragment,
  args: unknown[],
): Promise<void> {
  let owner: string;
  let network: TronNetwork;
  if (cmdOpts.address) {
    validateAddress(cmdOpts.address, 'query address');
    owner = cmdOpts.address;
    network = ((cmdOpts.network as string | undefined)?.toLowerCase() as TronNetwork) || 'mainnet';
  } else {
    const signer = await initSigner(opts.port as number | undefined);
    const wallet = await getWalletAddress(signer, cmdOpts.network as TronNetwork | undefined, true);
    owner = wallet.address;
    network = wallet.network;
  }

  const tronWeb = getTronWeb(network, opts.apiKey as string | undefined);
  const spinner = createSpinner('Calling contract (constant)...');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = await (tronWeb.transactionBuilder as any).triggerConstantContract(
    cmdOpts.contract,
    cmdOpts.method,
    { funcABIV2: fragment, parametersV2: args },
    [],
    owner,
  );
  if (!res?.result?.result) {
    spinner.fail('Constant call failed');
    const msg = res?.result?.message
      ? Buffer.from(res.result.message, 'hex').toString('utf8')
      : 'triggerConstantContract returned no result';
    throw new Error(msg);
  }
  spinner.succeed('Called');

  const hex = res.constant_result?.[0] ?? '';
  outputResult(
    {
      Contract: cmdOpts.contract,
      Method: cmdOpts.method,
      Caller: owner,
      Network: network,
      Result: hex ? `0x${hex}` : '(empty)',
    },
    'Constant Call Result',
    opts.json as boolean,
  );
}

async function runWriteable(
  cmdOpts: Record<string, string | undefined>,
  opts: Record<string, unknown>,
  fragment: AbiFragment,
  args: unknown[],
): Promise<void> {
  const feeLimitSun = cmdOpts.feeLimit ? trxToSun(cmdOpts.feeLimit, 'fee-limit') : 100_000_000;
  const callValueSun = cmdOpts.callValue !== undefined
    ? trxToSun(cmdOpts.callValue, 'call-value', { allowZero: true })
    : 0;

  const signer = await initSigner(opts.port as number | undefined);
  const { address, network } = await getWalletAddress(signer, cmdOpts.network as TronNetwork | undefined);
  const tronWeb = getTronWeb(network, opts.apiKey as string | undefined);
  const broadcast = !opts.localBroadcast;

  const spinner = createSpinner('Building transaction...');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { transaction, result } = await (tronWeb.transactionBuilder as any).triggerSmartContract(
    cmdOpts.contract,
    cmdOpts.method,
    { feeLimit: feeLimitSun, callValue: callValueSun, funcABIV2: fragment, parametersV2: args },
    [],
    address,
  );
  if (!result?.result || !transaction) {
    spinner.fail('Failed to build transaction');
    const msg = result?.message
      ? Buffer.from(result.message, 'hex').toString('utf8')
      : 'triggerSmartContract returned no transaction';
    throw new Error(msg);
  }
  spinner.succeed('Transaction built');

  await runPrecheck('Simulating call and checking fees...', () =>
    checkTrigger(
      tronWeb,
      cmdOpts.contract!,
      cmdOpts.method!,
      fragment,
      args,
      address,
      callValueSun,
      feeLimitSun,
      measureTxBytes(transaction),
    ));

  outputAction({
    Action: 'Trigger Contract',
    Network: network,
    Caller: address,
    Contract: cmdOpts.contract!,
    Method: cmdOpts.method!,
    Args: summarizeArgs(cmdOpts.args || '[]', args),
    CallValue: `${callValueSun / 1_000_000} TRX`,
    FeeLimit: `${feeLimitSun / 1_000_000} TRX`,
    Broadcast: broadcast ? 'Signer' : 'Local',
  });

  const signed = await signTransaction(signer, transaction, network, broadcast);
  const txId = broadcast ? signed.txId! : await broadcastTx(tronWeb, signed.signedTransaction);
  await confirmOnChain(waitForTxResult(tronWeb, txId));

  outputResult(
    {
      Status: 'Success',
      TxID: txId,
      Caller: address,
      Contract: cmdOpts.contract!,
      Method: cmdOpts.method!,
      Explorer: getExplorerTxUrl(network, txId),
    },
    'Trigger Result',
    opts.json as boolean,
  );
}
