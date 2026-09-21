import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import type { FailureClass } from './types.js';

export interface SupervisedProcessOptions {
  id: string;
  command: string;
  cwd: string;
  env?: Record<string, string>;
  /** Log directory. If omitted, logs are only emitted as events. */
  logDir?: string;
  shell?: string;
  /** Optional readiness probe used to classify failures during startup. */
  onExit?: (info: ExitInfo) => void;
}

export interface ExitInfo {
  id: string;
  pid?: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  startedAt: number;
  endedAt: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface LogLine {
  id: string;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
  at: number;
}

const TAIL_LIMIT = 16 * 1024;

/** Prefix complete lines with ISO timestamps for persisted file logs. */
export function withTimestamps(text: string): string {
  const stamp = new Date().toISOString();
  const endsWithNewline = text.endsWith('\n');
  const lines = endsWithNewline ? text.slice(0, -1).split('\n') : text.split('\n');
  const out = lines.map((line) => `[${stamp}] ${line}`).join('\n');
  return endsWithNewline ? out + '\n' : out;
}

export class SupervisedProcess extends EventEmitter {
  readonly id: string;
  private child: ChildProcess | null = null;
  private opts: SupervisedProcessOptions;
  private outTail = '';
  private errTail = '';
  private outStream: WriteStream | null = null;
  private errStream: WriteStream | null = null;
  private stdoutBuf = '';
  private stderrBuf = '';
  private startedAt = 0;
  private stopping = false;
  private _exit: ExitInfo | null = null;

  constructor(opts: SupervisedProcessOptions) {
    super();
    this.id = opts.id;
    this.opts = { shell: '/bin/bash', ...opts };
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  get running(): boolean {
    return this.child !== null && this._exit === null;
  }

  get exitInfo(): ExitInfo | null {
    return this._exit;
  }

  start(): void {
    if (this.child) throw new Error(`process ${this.id} already started`);
    this.startedAt = Date.now();
    this.stopping = false;
    this._exit = null;

    if (this.opts.logDir) {
      mkdirSync(this.opts.logDir, { recursive: true });
      const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, '-');
      this.outStream = createWriteStream(join(this.opts.logDir, `${this.id}-${stamp}.out.log`), { flags: 'a' });
      this.errStream = createWriteStream(join(this.opts.logDir, `${this.id}-${stamp}.err.log`), { flags: 'a' });
    }

    const child = spawn(this.opts.shell!, ['-lc', this.opts.command], {
      cwd: this.opts.cwd,
      env: { ...process.env, ...(this.opts.env || {}) },
      // detached creates a new process group so we can signal the whole tree.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    this.emitLog('system', `spawned pid=${child.pid} cwd=${this.opts.cwd} cmd=${this.opts.command}`);

    child.stdout?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8');
      this.outTail = (this.outTail + text).slice(-TAIL_LIMIT);
      this.outStream?.write(withTimestamps(text));
      this.emitLines('stdout', text);
    });
    child.stderr?.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8');
      this.errTail = (this.errTail + text).slice(-TAIL_LIMIT);
      this.errStream?.write(withTimestamps(text));
      this.emitLines('stderr', text);
    });

    child.on('error', (err) => {
      this.emitLog('system', `spawn error: ${err.message}`);
      this.finish(null, null);
    });

    child.on('exit', (code, signal) => {
      this.finish(code, signal);
    });
  }

  private emitLines(stream: 'stdout' | 'stderr', text: string): void {
    const key = stream === 'stdout' ? 'stdoutBuf' : 'stderrBuf';
    this[key] += text;
    let idx: number;
    while ((idx = this[key].indexOf('\n')) !== -1) {
      const line = this[key].slice(0, idx);
      this[key] = this[key].slice(idx + 1);
      this.emit('log', { id: this.id, stream, line, at: Date.now() } satisfies LogLine);
    }
    if (this[key].length > TAIL_LIMIT) this[key] = this[key].slice(-TAIL_LIMIT);
  }

  private emitLog(stream: LogLine['stream'], line: string): void {
    this.emit('log', { id: this.id, stream, line, at: Date.now() } satisfies LogLine);
  }

  private finish(code: number | null, signal: NodeJS.Signals | null): void {
    if (this._exit) return;
    const endedAt = Date.now();
    // flush partial lines
    if (this.stdoutBuf) this.emit('log', { id: this.id, stream: 'stdout', line: this.stdoutBuf, at: endedAt } satisfies LogLine);
    if (this.stderrBuf) this.emit('log', { id: this.id, stream: 'stderr', line: this.stderrBuf, at: endedAt } satisfies LogLine);
    this._exit = {
      id: this.id,
      pid: this.child?.pid,
      code,
      signal,
      startedAt: this.startedAt,
      endedAt,
      stdoutTail: this.outTail,
      stderrTail: this.errTail,
    };
    this.outStream?.end();
    this.errStream?.end();
    this.outStream = null;
    this.errStream = null;
    this.emit('log', { id: this.id, stream: 'system', line: `exited code=${code} signal=${signal}`, at: endedAt } satisfies LogLine);
    this.emit('exit', this._exit);
    this.opts.onExit?.(this._exit);
  }

  /**
   * Stop the process and everything in its process group.
   * Sends SIGTERM first, then SIGKILL after graceMs.
   * Never targets unrelated processes: signals only this process group.
   */
  async stop(graceMs = 5000): Promise<ExitInfo | null> {
    if (!this.child && this._exit) return this._exit;
    if (!this.child) return null;
    if (this.stopping) {
      await this.waitForExit(graceMs + 5000);
      return this._exit;
    }
    this.stopping = true;
    const pid = this.child.pid;
    if (!pid) {
      this.killTree('SIGKILL');
      await this.waitForExit(graceMs);
      return this._exit;
    }
    this.emitLog('system', `stopping pid=${pid} (SIGTERM to group)`);
    this.killTree('SIGTERM');
    const exited = await this.waitForExit(graceMs);
    if (!exited) {
      this.emitLog('system', `grace period expired, SIGKILL group ${pid}`);
      this.killTree('SIGKILL');
      await this.waitForExit(3000);
    }
    return this._exit;
  }

  private killTree(signal: NodeJS.Signals): void {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      // Negative pid => the whole process group (created via detached: true).
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        /* already gone */
      }
    }
  }

  private waitForExit(ms: number): Promise<boolean> {
    if (this._exit) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.off('exit', onExit);
        resolve(false);
      }, ms);
      const onExit = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.once('exit', onExit);
    });
  }
}

/** Classify why a process failed to become ready, based on its output/exit. */
export function classifyFailure(exit: ExitInfo | null, stderr: string, stdout: string): FailureClass {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  if (/eaddrinuse|address already in use|port .* already in use/.test(text)) return 'PORT_CONFLICT';
  if (/attempted relative import with no known parent package/.test(text)) return 'WRONG_MODULE_PATH';
  if (/modulenotfounderror|no module named|cannot find module|module not found/.test(text)) return 'MISSING_DEPENDENCY';
  if (/importerror/.test(text)) return 'MISSING_DEPENDENCY';
  if (/command not found|not found: |no such file or directory.*(uvicorn|vite|npm|pnpm|python)/.test(text)) return 'COMMAND_UNKNOWN';
  if (/enoent.*no such file or directory/.test(text)) return 'WRONG_WORKING_DIRECTORY';
  if (/keyerror|environment variable|not set|missing.*env/.test(text)) return 'MISSING_ENVIRONMENT_VARIABLE';
  if (/connection refused.*(postgres|database|db)|could not connect to server|database.*does not exist/.test(text)) return 'DATABASE_REQUIRED';
  if (/cannot connect to the docker daemon|docker: command not found/.test(text)) return 'DOCKER_REQUIRED';
  if (/unsupported engine|requires node|node version/.test(text)) return 'NODE_VERSION';
  if (/no such device|device not found|adb: /.test(text)) return 'DEVICE_REQUIRED';
  if (/cuda|cudnn|no gpu|gpu required/.test(text)) return 'GPU_REQUIRED';
  if (/permission denied|eacces/.test(text)) return 'PERMISSION';
  if (/wrong package manager|npm err.*pnpm|use pnpm/.test(text)) return 'WRONG_PACKAGE_MANAGER';
  if (exit && exit.code === 127) return 'COMMAND_UNKNOWN';
  return 'UNKNOWN';
}
