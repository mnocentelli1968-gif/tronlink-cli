import { TronWeb } from 'tronweb';
import { sunToTrx } from './tronweb.js';
import { outputWarning, createSpinner } from './output.js';
import type { AbiFragment } from './abi.js';

type TW = InstanceType<typeof TronWeb>;
export type Resource = 'ENERGY' | 'BANDWIDTH';

export interface CheckResult {
  ok: boolean;
  reason?: string;
  warnings?: string[];
}

const ACTIVATION_FEE_SUN = 1_000_000;
const MIN_STAKE_SUN = 1_000_000;
const DEFAULT_BANDWIDTH_FEE_SUN = 1000;
const DEFAULT_ENERGY_FEE_SUN = 420;
const SIGNATURE_BYTES = 67; // 65-byte sig + 2-byte protobuf overhead
const ENERGY_BUFFER = 1.1;

// Measure tx bandwidth bytes from a built (unsigned) transaction.
// Used by commands to pass the real size into precheck instead of a constant.
export function measureTxBytes(tx: { raw_data_hex?: string }): number {
  if (!tx.raw_data_hex) {
    throw new Error('Cannot measure tx size: raw_data_hex missing');
  }
  return tx.raw_data_hex.length / 2 + SIGNATURE_BYTES;
}

// Selector of `Error(string)` — used to detect standard Solidity reverts.
const ERROR_STRING_SELECTOR = '08c379a0';

function fmt(sun: number): string {
  return `${sunToTrx(sun)} TRX`;
}

// -------- Chain params cache (per TronWeb instance) --------

interface FeeRates {
  energyFee: number;
  bandwidthFee: number;
}

const feeRatesCache = new WeakMap<TW, Promise<FeeRates>>();

function getFeeRates(tronWeb: TW): Promise<FeeRates> {
  const cached = feeRatesCache.get(tronWeb);
  if (cached) return cached;
  const p = (async () => {
    const params = await tronWeb.trx.getChainParameters();
    let energyFee = DEFAULT_ENERGY_FEE_SUN;
    let bandwidthFee = DEFAULT_BANDWIDTH_FEE_SUN;
    for (const entry of params) {
      if (entry.key === 'getEnergyFee' && entry.value > 0) energyFee = entry.value;
      else if (entry.key === 'getTransactionFee' && entry.value > 0) bandwidthFee = entry.value;
    }
    return { energyFee, bandwidthFee };
  })();
  feeRatesCache.set(tronWeb, p);
  return p;
}

// -------- Helpers --------

async function isActivated(tronWeb: TW, address: string): Promise<boolean> {
  const acc = await tronWeb.trx.getAccount(address);
  return !!acc?.address;
}

interface ResourceState {
  availableEnergy: number;
  availableBandwidth: number;
}

async function getResourceState(tronWeb: TW, address: string): Promise<ResourceState> {
  const r = await tronWeb.trx.getAccountResources(address);
  return {
    availableEnergy: Math.max(0, (r.EnergyLimit || 0) - (r.EnergyUsed || 0)),
    availableBandwidth: Math.max(0, (r.NetLimit || 0) - (r.NetUsed || 0) + (r.freeNetLimit || 0) - (r.freeNetUsed || 0)),
  };
}

function estimateBandwidthFee(availableBandwidth: number, txBytes: number, feePerByte: number): number {
  const shortage = Math.max(0, txBytes - availableBandwidth);
  return shortage * feePerByte;
}

function estimateEnergyFee(availableEnergy: number, energyNeeded: number, feePerEnergy: number): number {
  const shortage = Math.max(0, energyNeeded - availableEnergy);
  return shortage * feePerEnergy;
}

// Shared fee rule: burn > balance → block; burn <= balance → warn.
function applyFeeRule(trxBalance: number, feeSun: number, feeLabel: string): CheckResult {
  if (feeSun > trxBalance) {
    return {
      ok: false,
      reason: `Insufficient TRX for ${feeLabel}: balance ${fmt(trxBalance)}, need ~${fmt(feeSun)}`,
    };
  }
  const warnings: string[] = [];
  if (feeSun > 0) warnings.push(`${feeLabel}: ~${fmt(feeSun)} will be burned from TRX balance`);
  return { ok: true, warnings };
}

// Inspect a triggerConstantContract response for failure.
// Handles both `result.code` style errors and standard `Error(string)` reverts
// returned via constant_result[0] with selector 0x08c379a0.
function detectSimulationFailure(simResult: unknown): string | null {
  const r = simResult as {
    result?: { code?: string; message?: string };
    constant_result?: string[];
  };
  if (r.result?.code) {
    return r.result.message
      ? Buffer.from(r.result.message, 'hex').toString('utf-8')
      : r.result.code;
  }
  const data = r.constant_result?.[0];
  if (data && data.toLowerCase().startsWith(ERROR_STRING_SELECTOR)) {
    try {
      // ABI: selector(4B) + offset(32B) + length(32B) + string bytes
      const lenHex = data.slice(8 + 64, 8 + 64 + 64);
      const len = parseInt(lenHex, 16);
      const strHex = data.slice(8 + 64 + 64, 8 + 64 + 64 + len * 2);
      return Buffer.from(strHex, 'hex').toString('utf-8') || 'Contract reverted';
    } catch {
      return 'Contract reverted';
    }
  }
  return null;
}

function getBalanceFromAccount(acc: unknown): number {
  return (acc as { balance?: number })?.balance || 0;
}

// -------- Checks --------

export async function checkTransferTrx(
  tronWeb: TW,
  from: string,
  to: string,
  amountSun: number,
  txBytes: number,
): Promise<CheckResult> {
  const [fromAcc, toActivated, res, rates] = await Promise.all([
    tronWeb.trx.getAccount(from),
    isActivated(tronWeb, to),
    getResourceState(tronWeb, from),
    getFeeRates(tronWeb),
  ]);

  const balance = getBalanceFromAccount(fromAcc);
  const activationFee = toActivated ? 0 : ACTIVATION_FEE_SUN;
  const bwFee = estimateBandwidthFee(res.availableBandwidth, txBytes, rates.bandwidthFee);
  const totalNeed = amountSun + activationFee + bwFee;

  if (balance < totalNeed) {
    const parts = [`amount ${fmt(amountSun)}`];
    if (activationFee) parts.push(`activation ${fmt(activationFee)}`);
    if (bwFee) parts.push(`bandwidth fee ~${fmt(bwFee)}`);
    return {
      ok: false,
      reason: `Insufficient TRX: balance ${fmt(balance)}, need ${fmt(totalNeed)} (${parts.join(' + ')})`,
    };
  }

  const warnings: string[] = [];
  if (!toActivated) warnings.push(`Recipient not activated — ${fmt(ACTIVATION_FEE_SUN)} activation fee will be charged`);
  if (bwFee > 0) warnings.push(`Bandwidth insufficient — ~${fmt(bwFee)} will be burned as fee`);
  return { ok: true, warnings };
}

export async function checkTransferTrc10(
  tronWeb: TW,
  from: string,
  tokenId: string,
  rawAmount: string,
  txBytes: number,
): Promise<CheckResult> {
  const [acc, res, rates] = await Promise.all([
    tronWeb.trx.getAccount(from),
    getResourceState(tronWeb, from),
    getFeeRates(tronWeb),
  ]);
  const balance = getBalanceFromAccount(acc);
  const assetV2 = ((acc as unknown as { assetV2?: { key: string; value: number }[] }).assetV2 || []);
  const entry = assetV2.find(a => a.key === tokenId);
  const tokenBalance = BigInt(entry?.value ?? 0);
  const need = BigInt(rawAmount);
  if (tokenBalance < need) {
    return {
      ok: false,
      reason: `Insufficient TRC10 token #${tokenId}: balance ${tokenBalance}, need ${rawAmount}`,
    };
  }

  const bwFee = estimateBandwidthFee(res.availableBandwidth, txBytes, rates.bandwidthFee);
  return applyFeeRule(balance, bwFee, 'bandwidth fee');
}

export async function checkTransferTrc20(
  tronWeb: TW,
  contract: string,
  from: string,
  to: string,
  rawAmount: string,
  feeLimitSun: number,
  txBytes: number,
): Promise<CheckResult> {
  const balResult = await tronWeb.transactionBuilder.triggerConstantContract(
    contract,
    'balanceOf(address)',
    {},
    [{ type: 'address', value: from }],
    from,
  );
  const balFail = detectSimulationFailure(balResult);
  if (balFail) return { ok: false, reason: `Failed to query TRC20 balance: ${balFail}` };
  const balHex = balResult.constant_result?.[0];
  if (!balHex) {
    return { ok: false, reason: 'Failed to query TRC20 balance (empty result)' };
  }
  const tokenBalance = BigInt('0x' + balHex);
  const needRaw = BigInt(rawAmount);
  if (tokenBalance < needRaw) {
    return {
      ok: false,
      reason: `Insufficient TRC20 balance: have ${tokenBalance}, need ${rawAmount}`,
    };
  }

  const simResult = await tronWeb.transactionBuilder.triggerConstantContract(
    contract,
    'transfer(address,uint256)',
    {},
    [
      { type: 'address', value: to },
      { type: 'uint256', value: rawAmount },
    ],
    from,
  );
  const simFail = detectSimulationFailure(simResult);
  if (simFail) return { ok: false, reason: `Contract simulation failed: ${simFail}` };
  const energyUsed = (simResult as unknown as { energy_used?: number }).energy_used || 0;
  const energyNeeded = Math.ceil(energyUsed * ENERGY_BUFFER);

  const [acc, res, rates] = await Promise.all([
    tronWeb.trx.getAccount(from),
    getResourceState(tronWeb, from),
    getFeeRates(tronWeb),
  ]);
  const trxBalance = getBalanceFromAccount(acc);

  const bwFee = estimateBandwidthFee(res.availableBandwidth, txBytes, rates.bandwidthFee);
  const energyFee = estimateEnergyFee(res.availableEnergy, energyNeeded, rates.energyFee);
  const totalFee = bwFee + energyFee;

  if (totalFee > feeLimitSun) {
    return {
      ok: false,
      reason: `Estimated fee ~${fmt(totalFee)} exceeds --fee-limit ${fmt(feeLimitSun)} (energy needed ${energyNeeded}, available ${res.availableEnergy}). Raise --fee-limit or stake more TRX for energy`,
    };
  }
  if (totalFee > trxBalance) {
    return {
      ok: false,
      reason: `Insufficient TRX for fee: balance ${fmt(trxBalance)}, need ~${fmt(totalFee)} (energy ${energyNeeded}, available ${res.availableEnergy})`,
    };
  }

  const warnings: string[] = [];
  if (energyFee > 0) warnings.push(`Energy insufficient (need ${energyNeeded}, have ${res.availableEnergy}) — ~${fmt(energyFee)} will be burned`);
  if (bwFee > 0) warnings.push(`Bandwidth insufficient — ~${fmt(bwFee)} will be burned`);
  return { ok: true, warnings };
}

export async function checkTransferTrc721(
  tronWeb: TW,
  contract: string,
  from: string,
  to: string,
  tokenId: string,
  feeLimitSun: number,
  txBytes: number,
): Promise<CheckResult> {
  const ownResult = await tronWeb.transactionBuilder.triggerConstantContract(
    contract,
    'ownerOf(uint256)',
    {},
    [{ type: 'uint256', value: tokenId }],
    from,
  );
  const ownFail = detectSimulationFailure(ownResult);
  if (ownFail) {
    return { ok: false, reason: `NFT #${tokenId} not found on contract ${contract}: ${ownFail}` };
  }
  const ownHex = ownResult.constant_result?.[0];
  if (!ownHex || ownHex.length !== 64 || /^0+$/.test(ownHex)) {
    return { ok: false, reason: `NFT #${tokenId} not found on contract ${contract}` };
  }
  const ownerHex41 = '41' + ownHex.slice(24);
  const ownerBase58 = tronWeb.address.fromHex(ownerHex41);
  if (ownerBase58 !== from) {
    return { ok: false, reason: `NFT #${tokenId} is owned by ${ownerBase58}, not ${from}` };
  }

  const simResult = await tronWeb.transactionBuilder.triggerConstantContract(
    contract,
    'transferFrom(address,address,uint256)',
    {},
    [
      { type: 'address', value: from },
      { type: 'address', value: to },
      { type: 'uint256', value: tokenId },
    ],
    from,
  );
  const simFail = detectSimulationFailure(simResult);
  if (simFail) return { ok: false, reason: `Contract simulation failed: ${simFail}` };
  const energyUsed = (simResult as unknown as { energy_used?: number }).energy_used || 0;
  const energyNeeded = Math.ceil(energyUsed * ENERGY_BUFFER);

  const [acc, res, rates] = await Promise.all([
    tronWeb.trx.getAccount(from),
    getResourceState(tronWeb, from),
    getFeeRates(tronWeb),
  ]);
  const trxBalance = getBalanceFromAccount(acc);

  const bwFee = estimateBandwidthFee(res.availableBandwidth, txBytes, rates.bandwidthFee);
  const energyFee = estimateEnergyFee(res.availableEnergy, energyNeeded, rates.energyFee);
  const totalFee = bwFee + energyFee;

  if (totalFee > feeLimitSun) {
    return {
      ok: false,
      reason: `Estimated fee ~${fmt(totalFee)} exceeds --fee-limit ${fmt(feeLimitSun)} (energy needed ${energyNeeded}, available ${res.availableEnergy})`,
    };
  }
  if (totalFee > trxBalance) {
    return {
      ok: false,
      reason: `Insufficient TRX for fee: balance ${fmt(trxBalance)}, need ~${fmt(totalFee)}`,
    };
  }

  const warnings: string[] = [];
  if (energyFee > 0) warnings.push(`Energy insufficient (need ${energyNeeded}, have ${res.availableEnergy}) — ~${fmt(energyFee)} will be burned`);
  if (bwFee > 0) warnings.push(`Bandwidth insufficient — ~${fmt(bwFee)} will be burned`);
  return { ok: true, warnings };
}

export async function checkTrigger(
  tronWeb: TW,
  contract: string,
  method: string,
  funcABIV2: AbiFragment,
  parametersV2: unknown[],
  from: string,
  callValueSun: number,
  feeLimitSun: number,
  txBytes: number,
): Promise<CheckResult> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const simResult = await (tronWeb.transactionBuilder as any).triggerConstantContract(
    contract,
    method,
    { callValue: callValueSun, funcABIV2, parametersV2 },
    [],
    from,
  );
  const simFail = detectSimulationFailure(simResult);
  if (simFail) return { ok: false, reason: `Contract simulation failed: ${simFail}` };

  const energyUsed = (simResult as unknown as { energy_used?: number }).energy_used || 0;
  const energyNeeded = Math.ceil(energyUsed * ENERGY_BUFFER);

  const [acc, res, rates] = await Promise.all([
    tronWeb.trx.getAccount(from),
    getResourceState(tronWeb, from),
    getFeeRates(tronWeb),
  ]);
  const trxBalance = getBalanceFromAccount(acc);

  const bwFee = estimateBandwidthFee(res.availableBandwidth, txBytes, rates.bandwidthFee);
  const energyFee = estimateEnergyFee(res.availableEnergy, energyNeeded, rates.energyFee);
  const totalFee = bwFee + energyFee;
  const totalNeed = callValueSun + totalFee;

  if (totalFee > feeLimitSun) {
    return {
      ok: false,
      reason: `Estimated fee ~${fmt(totalFee)} exceeds --fee-limit ${fmt(feeLimitSun)} (energy needed ${energyNeeded}, available ${res.availableEnergy}). Raise --fee-limit or stake more TRX for energy`,
    };
  }
  if (totalNeed > trxBalance) {
    const parts: string[] = [];
    if (callValueSun > 0) parts.push(`callValue ${fmt(callValueSun)}`);
    if (totalFee > 0) parts.push(`fee ~${fmt(totalFee)}`);
    return {
      ok: false,
      reason: `Insufficient TRX: balance ${fmt(trxBalance)}, need ${fmt(totalNeed)} (${parts.join(' + ')})`,
    };
  }

  const warnings: string[] = [];
  if (energyFee > 0) warnings.push(`Energy insufficient (need ${energyNeeded}, have ${res.availableEnergy}) — ~${fmt(energyFee)} will be burned`);
  if (bwFee > 0) warnings.push(`Bandwidth insufficient — ~${fmt(bwFee)} will be burned`);
  return { ok: true, warnings };
}

export async function checkStake(
  tronWeb: TW,
  from: string,
  amountSun: number,
  txBytes: number,
): Promise<CheckResult> {
  if (amountSun < MIN_STAKE_SUN) {
    return { ok: false, reason: `Minimum stake is ${fmt(MIN_STAKE_SUN)} (requested ${fmt(amountSun)})` };
  }

  const [acc, res, rates] = await Promise.all([
    tronWeb.trx.getAccount(from),
    getResourceState(tronWeb, from),
    getFeeRates(tronWeb),
  ]);
  const balance = getBalanceFromAccount(acc);
  const bwFee = estimateBandwidthFee(res.availableBandwidth, txBytes, rates.bandwidthFee);
  const totalNeed = amountSun + bwFee;
  if (balance < totalNeed) {
    return {
      ok: false,
      reason: `Insufficient TRX: balance ${fmt(balance)}, need ${fmt(totalNeed)} (stake ${fmt(amountSun)}${bwFee ? ` + bandwidth fee ~${fmt(bwFee)}` : ''})`,
    };
  }

  const warnings: string[] = [];
  if (bwFee > 0) warnings.push(`Bandwidth insufficient — ~${fmt(bwFee)} will be burned`);
  return { ok: true, warnings };
}

interface StakedInfo {
  staked: number;
  delegatedOut: number;
  available: number;
}

function readStakedInfo(acc: Record<string, unknown>, resource: Resource): StakedInfo {
  const frozenV2 = (acc.frozenV2 || []) as { type?: string; amount?: number }[];
  let staked = 0;
  for (const f of frozenV2) {
    if (resource === 'ENERGY' && f.type === 'ENERGY') staked = f.amount || 0;
    else if (resource === 'BANDWIDTH' && (!f.type || f.type === 'BANDWIDTH')) staked = f.amount || 0;
  }
  const accResource = (acc.account_resource || {}) as { delegated_frozenV2_balance_for_energy?: number };
  const delegatedOut = resource === 'ENERGY'
    ? (accResource.delegated_frozenV2_balance_for_energy || 0)
    : ((acc.delegated_frozenV2_balance_for_bandwidth as number) || 0);
  return { staked, delegatedOut, available: Math.max(0, staked - delegatedOut) };
}

export async function checkUnstake(
  tronWeb: TW,
  from: string,
  resource: Resource,
  amountSun: number,
  txBytes: number,
): Promise<CheckResult> {
  const [acc, res, rates] = await Promise.all([
    tronWeb.trx.getAccount(from),
    getResourceState(tronWeb, from),
    getFeeRates(tronWeb),
  ]);
  const balance = getBalanceFromAccount(acc);
  const info = readStakedInfo(acc as unknown as Record<string, unknown>, resource);
  if (info.available < amountSun) {
    return {
      ok: false,
      reason: `Insufficient staked ${resource}: available ${fmt(info.available)} (staked ${fmt(info.staked)} − delegated out ${fmt(info.delegatedOut)}), requested ${fmt(amountSun)}`,
    };
  }

  const bwFee = estimateBandwidthFee(res.availableBandwidth, txBytes, rates.bandwidthFee);
  return applyFeeRule(balance, bwFee, 'bandwidth fee');
}

export async function checkDelegate(
  tronWeb: TW,
  from: string,
  resource: Resource,
  amountSun: number,
  txBytes: number,
): Promise<CheckResult> {
  const [acc, res, rates] = await Promise.all([
    tronWeb.trx.getAccount(from),
    getResourceState(tronWeb, from),
    getFeeRates(tronWeb),
  ]);
  const balance = getBalanceFromAccount(acc);
  const info = readStakedInfo(acc as unknown as Record<string, unknown>, resource);
  if (info.available < amountSun) {
    return {
      ok: false,
      reason: `Insufficient delegatable ${resource}: available ${fmt(info.available)} (staked ${fmt(info.staked)} − already delegated ${fmt(info.delegatedOut)}), requested ${fmt(amountSun)}`,
    };
  }

  const bwFee = estimateBandwidthFee(res.availableBandwidth, txBytes, rates.bandwidthFee);
  return applyFeeRule(balance, bwFee, 'bandwidth fee');
}

export async function checkReclaim(
  tronWeb: TW,
  from: string,   // reclaimer (currently-connected address)
  to: string,     // address the resource was delegated to
  resource: Resource,
  amountSun: number,
  txBytes: number,
): Promise<CheckResult> {
  const [delResRaw, acc, res, rates] = await Promise.all([
    tronWeb.trx.getDelegatedResourceV2(from, to),
    tronWeb.trx.getAccount(from),
    getResourceState(tronWeb, from),
    getFeeRates(tronWeb),
  ]);
  const balance = getBalanceFromAccount(acc);

  type DelRes = {
    frozen_balance_for_bandwidth?: number;
    frozen_balance_for_energy?: number;
    expire_time_for_bandwidth?: number;
    expire_time_for_energy?: number;
  };
  const raw = delResRaw as unknown as { delegatedResource: unknown };
  const list: DelRes[] = Array.isArray(raw.delegatedResource)
    ? raw.delegatedResource as DelRes[]
    : raw.delegatedResource
      ? [raw.delegatedResource as DelRes]
      : [];

  // Older delegations can be unlocked while newer ones are still locked; compare the
  // request against the unlocked portion only, so partial reclaims succeed.
  const now = Date.now();
  let totalDelegated = 0;
  let unlocked = 0;
  let earliestLockedExpire = Infinity;
  for (const d of list) {
    const amount = resource === 'ENERGY' ? (d.frozen_balance_for_energy || 0) : (d.frozen_balance_for_bandwidth || 0);
    const expire = resource === 'ENERGY' ? (d.expire_time_for_energy || 0) : (d.expire_time_for_bandwidth || 0);
    if (amount <= 0) continue;
    totalDelegated += amount;
    if (expire <= now) {
      unlocked += amount;
    } else if (expire < earliestLockedExpire) {
      earliestLockedExpire = expire;
    }
  }

  if (totalDelegated < amountSun) {
    return {
      ok: false,
      reason: `Insufficient delegated ${resource} to ${to}: delegated ${fmt(totalDelegated)}, requested ${fmt(amountSun)}`,
    };
  }

  if (unlocked < amountSun) {
    const unlock = new Date(earliestLockedExpire).toISOString();
    return {
      ok: false,
      reason: `Only ${fmt(unlocked)} of delegated ${resource} is unlocked (requested ${fmt(amountSun)}). Remaining locked until ${unlock}`,
    };
  }

  const bwFee = estimateBandwidthFee(res.availableBandwidth, txBytes, rates.bandwidthFee);
  return applyFeeRule(balance, bwFee, 'bandwidth fee');
}

export async function checkVote(
  tronWeb: TW,
  from: string,
  voteMap: Record<string, number>,
  txBytes: number,
): Promise<CheckResult> {
  const [acc, res, rates, srList] = await Promise.all([
    tronWeb.trx.getAccount(from),
    getResourceState(tronWeb, from),
    getFeeRates(tronWeb),
    tronWeb.trx.listSuperRepresentatives(),
  ]);
  const balance = getBalanceFromAccount(acc);

  // Normalize SR addresses to base58 for comparison with voteMap keys.
  const validSRs = new Set<string>();
  for (const sr of srList as unknown as { address?: string }[]) {
    if (!sr.address) continue;
    try {
      validSRs.add(sr.address.startsWith('T') ? sr.address : tronWeb.address.fromHex(sr.address));
    } catch {
      // skip malformed entry
    }
  }
  for (const voteAddr of Object.keys(voteMap)) {
    if (!validSRs.has(voteAddr)) {
      return { ok: false, reason: `Address ${voteAddr} is not a Super Representative` };
    }
  }

  const totalVotes = Object.values(voteMap).reduce((a, b) => a + b, 0);
  const frozenV2 = ((acc as unknown as { frozenV2?: { amount?: number }[] }).frozenV2 || []);
  let totalStakedSun = 0;
  for (const f of frozenV2) totalStakedSun += f.amount || 0;
  const tronPower = Math.floor(totalStakedSun / 1_000_000);

  if (totalVotes > tronPower) {
    return {
      ok: false,
      reason: `Insufficient Tron Power: have ${tronPower} (from ${fmt(totalStakedSun)} staked), need ${totalVotes}`,
    };
  }

  const bwFee = estimateBandwidthFee(res.availableBandwidth, txBytes, rates.bandwidthFee);
  return applyFeeRule(balance, bwFee, 'bandwidth fee');
}

// -------- Runner --------

export async function runPrecheck(
  label: string,
  check: () => Promise<CheckResult>,
): Promise<void> {
  const spinner = createSpinner(label);
  let result: CheckResult;
  try {
    result = await check();
  } catch (err) {
    spinner.fail('Precheck failed');
    throw err;
  }
  if (!result.ok) {
    spinner.fail(result.reason || 'Precheck failed');
    throw new Error(result.reason || 'Precheck failed');
  }
  spinner.succeed('Precheck passed');
  if (result.warnings?.length) {
    for (const w of result.warnings) outputWarning(w);
  }
}
