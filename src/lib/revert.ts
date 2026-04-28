// Decode the revert data returned by triggerConstantContract / on-chain
// receipt's contractResult / constant_result. Recognizes the two
// Solidity-emitted forms (Error(string), Panic(uint256)) and falls through to
// a selector + args breakdown for custom errors so callers can self-resolve
// via 4byte.directory or the contract's full ABI.
//
// Returns null when the input is empty (caller decides whether that means
// "no failure" or "reverted with no reason").

const ERROR_STRING_SELECTOR = '08c379a0';
const PANIC_SELECTOR = '4e487b71';

// Standard Solidity panic codes — see https://docs.soliditylang.org/en/latest/control-structures.html#panic-via-assert-and-error-via-require
const PANIC_REASONS: Record<number, string> = {
  0x00: 'generic compiler panic',
  0x01: 'assertion failed',
  0x11: 'arithmetic overflow or underflow',
  0x12: 'division or modulo by zero',
  0x21: 'conversion to invalid enum value',
  0x22: 'storage byte array incorrectly encoded',
  0x31: 'pop on empty array',
  0x32: 'array out-of-bounds access',
  0x41: 'memory allocation too large or array too large',
  0x51: 'call to invalid internal function',
};

export function decodeRevertData(hex?: string | null): string | null {
  if (!hex) return null;
  const stripped = (hex.startsWith('0x') ? hex.slice(2) : hex).toLowerCase();
  if (!stripped) return null;

  const selector = stripped.slice(0, 8);
  const args = stripped.slice(8);

  if (selector === ERROR_STRING_SELECTOR && args.length >= 128) {
    try {
      // ABI: offset(32B) + length(32B) + utf-8 bytes
      const len = parseInt(args.slice(64, 128), 16);
      if (Number.isFinite(len) && len > 0) {
        const strHex = args.slice(128, 128 + len * 2);
        const decoded = Buffer.from(strHex, 'hex').toString('utf-8');
        if (decoded) return decoded;
      }
    } catch { /* fall through */ }
    return 'Contract reverted';
  }

  if (selector === PANIC_SELECTOR && args.length >= 64) {
    const code = parseInt(args.slice(0, 64), 16);
    if (Number.isFinite(code)) {
      const codeStr = `0x${code.toString(16).padStart(2, '0')}`;
      const reason = PANIC_REASONS[code];
      return reason ? `Panic(${codeStr}): ${reason}` : `Panic(${codeStr})`;
    }
  }

  // Unknown 4-byte selector — likely a custom error (`error E(...)`).
  // Surface selector + args verbatim so the user can resolve externally.
  if (selector.length === 8) {
    return args
      ? `Contract reverted with custom error 0x${selector} (args 0x${args})`
      : `Contract reverted with custom error 0x${selector}`;
  }

  return 'Contract reverted';
}
