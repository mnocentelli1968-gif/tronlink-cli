import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SERVE_DIR = path.join(os.homedir(), '.tronlink-cli');
const SERVE_STATE_FILE = path.join(SERVE_DIR, 'serve.json');
const SERVE_LOCK_FILE = path.join(SERVE_DIR, 'serve.lock');
const SOCKET_PATH = path.join(SERVE_DIR, 'serve.sock');

interface ServeState {
  pid: number;
  port: number;
  startedAt: string;
}

// ─── State file ───

function ensureServeDir(): void {
  if (!fs.existsSync(SERVE_DIR)) {
    fs.mkdirSync(SERVE_DIR, { recursive: true, mode: 0o700 });
  } else {
    try { fs.chmodSync(SERVE_DIR, 0o700); } catch { /* ignore */ }
  }
}

export function writeServeState(port: number): void {
  ensureServeDir();
  const state: ServeState = { pid: process.pid, port, startedAt: new Date().toISOString() };
  fs.writeFileSync(SERVE_STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

export function readServeState(): ServeState | null {
  try {
    if (!fs.existsSync(SERVE_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(SERVE_STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function clearServeState(): void {
  try { fs.unlinkSync(SERVE_STATE_FILE); } catch { /* ignore */ }
}

/**
 * Liveness probe: a real daemon is one whose socket accepts connections.
 * PID checks are unreliable because the kernel reuses PIDs — a stale state
 * file could name a PID that belongs to an unrelated process.
 */
export function isDaemonAlive(timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    if (!fs.existsSync(SOCKET_PATH)) return resolve(false);
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      conn.destroy();
      resolve(ok);
    };
    const conn = net.createConnection(SOCKET_PATH, () => done(true));
    conn.on('error', () => done(false));
    setTimeout(() => done(false), timeoutMs);
  });
}

const BOOT_LOCK_STALE_MS = 30_000;

/**
 * Short-lived lock that guards only the startup sequence (unlink residual
 * socket + listen). Release it as soon as listen succeeds — do NOT hold it for
 * the daemon's lifetime. Liveness is determined by socket connectivity, not
 * by this lock.
 *
 * Stale detection is mtime-based. No PID involved: a 30s-old lock is assumed
 * abandoned (startup should take well under a second).
 */
export function acquireBootLock(): (() => void) | null {
  ensureServeDir();
  const tryCreate = (): (() => void) | null => {
    try {
      const fd = fs.openSync(SERVE_LOCK_FILE, 'wx');
      fs.closeSync(fd);
      return () => { try { fs.unlinkSync(SERVE_LOCK_FILE); } catch { /* ignore */ } };
    } catch {
      return null;
    }
  };

  const first = tryCreate();
  if (first) return first;

  try {
    const stat = fs.statSync(SERVE_LOCK_FILE);
    if (Date.now() - stat.mtimeMs > BOOT_LOCK_STALE_MS) {
      try { fs.unlinkSync(SERVE_LOCK_FILE); } catch { /* ignore */ }
      return tryCreate();
    }
  } catch { /* ignore */ }
  return null;
}

// ─── IPC Server (used by `tronlink serve`) ───

export type RequestHandler = (
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export interface IPCServerHandle {
  server: net.Server;
  /**
   * Forcefully close every connected client. Each conn's `close` handler
   * already aborts its in-flight signer operations, which propagates back
   * to the CLI client as `IPC connection closed`. Use this when the daemon
   * needs to invalidate active CLI calls without exiting (e.g. browser
   * disconnect: the in-flight request can no longer be approved, but the
   * daemon itself stays alive for the next command).
   */
  closeActiveConnections(): void;
}

export function startIPCServer(handler: RequestHandler): Promise<IPCServerHandle> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }

  const activeConns = new Set<net.Socket>();

  const server = net.createServer((conn) => {
    activeConns.add(conn);
    let buffer = '';
    // AbortControllers for in-flight operations on this connection
    const activeAborts = new Set<AbortController>();

    // Suppress socket errors (e.g. EPIPE when writing to closed connection)
    conn.on('error', () => {});

    conn.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleMessage(conn, line, handler, activeAborts);
      }
    });

    conn.on('close', () => {
      activeConns.delete(conn);
      // CLI disconnected — abort all in-flight signer operations
      for (const controller of activeAborts) {
        controller.abort();
      }
      activeAborts.clear();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCKET_PATH, () => {
      server.removeListener('error', reject);
      try { fs.chmodSync(SOCKET_PATH, 0o600); } catch { /* ignore */ }
      resolve({
        server,
        closeActiveConnections: () => {
          for (const conn of activeConns) {
            conn.destroy();
          }
          activeConns.clear();
        },
      });
    });
  });
}

function handleMessage(
  conn: net.Socket,
  raw: string,
  handler: RequestHandler,
  activeAborts: Set<AbortController>,
): void {
  let msg: { id: number; method: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const controller = new AbortController();
  activeAborts.add(controller);

  handler(msg.method, msg.params || {}, controller.signal)
    .then((result) => {
      activeAborts.delete(controller);
      if (!conn.destroyed) {
        conn.write(JSON.stringify({ id: msg.id, result }) + '\n');
      }
    })
    .catch((err) => {
      activeAborts.delete(controller);
      if (!conn.destroyed) {
        conn.write(JSON.stringify({ id: msg.id, error: err instanceof Error ? err.message : String(err) }) + '\n');
      }
    });
}

// ─── IPC Client (used by other commands) ───

export async function tryConnectIPC(): Promise<IPCClient | null> {
  // Pure socket probe. No PID / state-file checks: those lie after crashes or
  // PID reuse. If the socket accepts a connection, a daemon is alive.
  if (!fs.existsSync(SOCKET_PATH)) return null;
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.destroy();
        resolve(null);
      }
    }, 1000);
    const conn = net.createConnection(SOCKET_PATH, () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(new IPCClient(conn));
      }
    });
    conn.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }
    });
  });
}

export class IPCClient {
  private conn: net.Socket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';

  constructor(conn: net.Socket) {
    this.conn = conn;
    conn.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.handleResponse(line);
      }
    });
    conn.on('error', () => this.rejectAll('IPC connection lost'));
    conn.on('close', () => this.rejectAll('IPC connection closed'));
  }

  private handleResponse(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) {
        p.reject(new Error(msg.error));
      } else {
        p.resolve(msg.result);
      }
    } catch { /* ignore */ }
  }

  private rejectAll(reason: string): void {
    for (const [, p] of this.pending) {
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 300_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC call "${method}" timed out`));
      }, timeoutMs);
      const orig = this.pending.get(id)!;
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); orig.resolve(v); },
        reject: (e) => { clearTimeout(timer); orig.reject(e); },
      });
      this.conn.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  disconnect(): void {
    this.conn.destroy();
    this.pending.clear();
  }
}
