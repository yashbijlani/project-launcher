import { connect } from 'node:net';
import { spawn } from 'node:child_process';
import type { HealthCheck } from './types.js';

export interface HealthResult {
  healthy: boolean;
  detail: string;
  at: number;
}

const DEFAULT_TIMEOUT = 3000;

export async function runHealthCheck(hc: HealthCheck, cwd: string): Promise<HealthResult> {
  const timeoutMs = hc.timeoutMs ?? DEFAULT_TIMEOUT;
  try {
    switch (hc.type) {
      case 'http':
        return await httpCheck(hc, timeoutMs);
      case 'tcp':
        return await tcpCheck(hc, timeoutMs);
      case 'command':
        return await commandCheck(hc, cwd, timeoutMs);
      default:
        return { healthy: false, detail: `unsupported health check type: ${hc.type}`, at: Date.now() };
    }
  } catch (err) {
    return { healthy: false, detail: (err as Error).message, at: Date.now() };
  }
}

async function httpCheck(hc: HealthCheck, timeoutMs: number): Promise<HealthResult> {
  if (!hc.url) return { healthy: false, detail: 'http health check missing url', at: Date.now() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(hc.url, { signal: controller.signal, redirect: 'manual' });
    const expected = hc.expectStatus ?? null;
    const statusOk = expected ? expected.includes(res.status) : res.status >= 200 && res.status < 400;
    if (!statusOk) {
      return { healthy: false, detail: `HTTP ${res.status}`, at: Date.now() };
    }
    if (hc.expectBody) {
      const body = await res.text();
      if (!body.includes(hc.expectBody)) {
        return { healthy: false, detail: `HTTP ${res.status} but body missing "${hc.expectBody}"`, at: Date.now() };
      }
    }
    return { healthy: true, detail: `HTTP ${res.status}`, at: Date.now() };
  } catch (err) {
    return { healthy: false, detail: (err as Error).name === 'AbortError' ? 'timeout' : (err as Error).message, at: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

function tcpCheck(hc: HealthCheck, timeoutMs: number): Promise<HealthResult> {
  const port = hc.port;
  if (!port) return Promise.resolve({ healthy: false, detail: 'tcp health check missing port', at: Date.now() });
  const host = hc.host || '127.0.0.1';
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let done = false;
    const finish = (healthy: boolean, detail: string): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve({ healthy, detail, at: Date.now() });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true, `${host}:${port} open`));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (err) => finish(false, err.message));
  });
}

function commandCheck(hc: HealthCheck, cwd: string, timeoutMs: number): Promise<HealthResult> {
  if (!hc.command) return Promise.resolve({ healthy: false, detail: 'command health check missing command', at: Date.now() });
  return new Promise((resolve) => {
    const child = spawn('/bin/bash', ['-lc', hc.command!], { cwd, stdio: 'ignore' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ healthy: false, detail: 'timeout', at: Date.now() });
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      resolve({ healthy: false, detail: err.message, at: Date.now() });
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve({ healthy: code === 0, detail: `exit ${code}`, at: Date.now() });
    });
  });
}

/**
 * Poll a health check until it passes or the start period elapses.
 */
export async function waitForHealthy(
  hc: HealthCheck,
  cwd: string,
  opts: { startPeriodMs?: number; intervalMs?: number; abort?: () => boolean } = {},
): Promise<HealthResult> {
  const deadline = Date.now() + (hc.startPeriodMs ?? opts.startPeriodMs ?? 30_000);
  const interval = hc.intervalMs ?? opts.intervalMs ?? 500;
  let last: HealthResult;
  for (;;) {
    if (opts.abort?.()) return { healthy: false, detail: 'aborted', at: Date.now() };
    last = await runHealthCheck(hc, cwd);
    if (last.healthy) return last;
    if (Date.now() + interval >= deadline) return last;
    await sleep(interval);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
