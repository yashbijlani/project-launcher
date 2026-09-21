import { createServer } from 'node:http';
import { request } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Allocate a free TCP port by binding to :0 and immediately releasing it. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Isolate launcher config/state/logs/locks in a temp HOME. */
export function isolatedHome(prefix = 'launcher-test-') {
  const home = mkdtempSync(join(tmpdir(), prefix));
  const prev = process.env.LAUNCHER_HOME;
  process.env.LAUNCHER_HOME = home;
  return {
    home,
    restore() {
      if (prev === undefined) delete process.env.LAUNCHER_HOME;
      else process.env.LAUNCHER_HOME = prev;
    },
  };
}

/** POST JSON without a keep-alive agent, so no pooled sockets keep the loop alive. */
export function httpPost(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        agent: false,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), connection: 'close' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = {};
          try {
            parsed = JSON.parse(text);
          } catch {
            parsed = { raw: text };
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
