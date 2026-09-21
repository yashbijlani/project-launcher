import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from '../dist/server.js';
import { saveProject } from '../dist/config.js';
import { isolatedHome, httpPost } from './helpers.js';

test('unsafe projects cannot start through the API without explicit approval', async () => {
  const { restore } = isolatedHome();
  let server = null;
  try {
    saveProject({
      id: 'unsafe-api',
      name: 'unsafe-api',
      root: '/tmp',
      metadata: { unsafe: true, unsafeReason: 'test target' },
      services: [{ id: 's', name: 's', command: 'true' }],
    });
    server = await startServer({ port: 0 });
    const port = server.port;
    // No approval at all.
    let r = await httpPost(port, '/api/projects/unsafe-api/start', {});
    assert.equal(r.status, 403);
    // Bare boolean flag is ambiguous and rejected.
    r = await httpPost(port, '/api/projects/unsafe-api/start', { allowUnsafe: true });
    assert.equal(r.status, 403);
    // Malformed approvals are rejected.
    r = await httpPost(port, '/api/projects/unsafe-api/start', { unsafeApproval: { projectId: 'unsafe-api', reason: 'x' } });
    assert.equal(r.status, 403);
    r = await httpPost(port, '/api/projects/unsafe-api/start', { unsafeApproval: { projectId: 'wrong', reason: 'local testing only' } });
    assert.equal(r.status, 403);
    // Well-formed approval is accepted by the gate (the trivial command then runs).
    r = await httpPost(port, '/api/projects/unsafe-api/start', { unsafeApproval: { projectId: 'unsafe-api', reason: 'local testing only' } });
    assert.equal(r.status, 200);
    assert.ok('result' in r.body || 'ok' in r.body);
  } finally {
    server?.close();
    restore();
  }
});

test('safe projects start through the API without approval', async () => {
  const { restore } = isolatedHome();
  let server = null;
  try {
    saveProject({
      id: 'safe-api',
      name: 'safe-api',
      root: '/tmp',
      services: [{ id: 's', name: 's', command: 'true' }],
    });
    server = await startServer({ port: 0 });
    const r = await httpPost(server.port, '/api/projects/safe-api/start', {});
    assert.equal(r.status, 200);
  } finally {
    server?.close();
    restore();
  }
});
