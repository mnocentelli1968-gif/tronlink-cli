export interface AbiInput {
  type: string;
  components?: AbiInput[];
}

export interface AbiFragment {
  name: string;
  type: 'function';
  inputs: AbiInput[];
}

function splitTopLevel(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      out.push(body.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = body.slice(start).trim();
  if (last || out.length) out.push(last);
  if (depth !== 0 || out.some((s) => !s)) {
    throw new Error(`Unbalanced or empty segment in "${body}"`);
  }
  return out;
}

/**
 * Parse a type string into an ABI v2 input. Handles tuples and nested arrays:
 *   'address'            → { type: 'address' }
 *   'uint256[]'          → { type: 'uint256[]' }
 *   '(address,uint256)'  → { type: 'tuple', components: [...] }
 *   '(address,uint256)[]'→ { type: 'tuple[]', components: [...] }
 */
function parseType(raw: string): AbiInput {
  const t = raw.trim();
  if (!t) throw new Error('Empty type');
  // Non-tuple: strip optional parameter name, e.g. "address to" → "address".
  if (!t.startsWith('(')) {
    return { type: t.split(/\s+/)[0] };
  }
  // Tuple: find matching ')', then parse the suffix (array brackets, maybe a name).
  let depth = 0;
  let close = -1;
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '(') depth++;
    else if (t[i] === ')') {
      depth--;
      if (depth === 0) { close = i; break; }
    }
  }
  if (close < 0) throw new Error(`Unbalanced tuple type: "${t}"`);
  const inner = t.slice(1, close);
  // Take leading array brackets; anything after is treated as a parameter name.
  const remainder = t.slice(close + 1).trim();
  const tail = remainder.match(/^(\[\d*\])+/)?.[0] ?? '';
  const components = splitTopLevel(inner).map(parseType);
  return { type: 'tuple' + tail, components };
}

export function parseMethodSignature(sig: string): AbiFragment {
  const trimmed = sig.trim();
  const open = trimmed.indexOf('(');
  if (open < 0 || !trimmed.endsWith(')')) {
    throw new Error(`Invalid method signature: "${sig}". Expected format: "name(type1,type2,...)"`);
  }
  const name = trimmed.slice(0, open).trim();
  if (!/^[A-Za-z_]\w*$/.test(name)) {
    throw new Error(`Invalid method name: "${name}"`);
  }
  const body = trimmed.slice(open + 1, -1).trim();
  const inputs = body ? splitTopLevel(body).map(parseType) : [];
  return { name, type: 'function', inputs };
}

export function parseArgsJson(raw: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`--args is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error('--args must be a JSON array, e.g. \'["T...","1000"]\'');
  }
  return parsed;
}
