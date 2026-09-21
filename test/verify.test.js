import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { verifyProject } from '../dist/verify.js';
import { loadProject, saveProject } from '../dist/config.js';
import { isVerificationCurrent } from '../dist/fingerprint.js';
import { isolatedHome, freePort } from './helpers.js';

const here = dirname(fileURLToPath(import.meta.url));
const echoService = join(here, 'fixtures', 'echo-service.mjs');

function base(id, port) {
  return {
    id,
    name: id,
    root: here,
    services: [
      {
        id: 'web',
        name: 'web',
        command: `node ${echoService} ${port}`,
        port,
        healthCheck: { type: 'http', url: `http://127.0.0.1:${port}/health`, startPeriodMs: 8000 },
      },
    ],
  };
}

test('successful verification records evidence and persists it', async () => {
  const { restore } = isolatedHome();
  try {
    const port = await freePort();
    const project = base('verify-ok', port);
    saveProject(project);
    const result = await verifyProject(loadProject('verify-ok'), {});
    assert.equal(result.ok, true);
    assert.equal(result.status, 'verified');
    assert.deepEqual(result.order, ['web']);
    assert.equal(result.services.web.started, true);
    assert.equal(result.services.web.healthy, true);
    assert.equal(result.services.web.stoppedCleanly, true);
    const saved = loadProject('verify-ok');
    assert.equal(saved.verification.status, 'verified');
    assert.equal(isVerificationCurrent(saved), true);
  } finally {
    restore();
  }
});

test('failed health produces a failed verification, not a verified one', async () => {
  const { restore } = isolatedHome();
  try {
    const port = await freePort();
    const project = base('verify-bad-health', port);
    project.services[0].command = 'node -e "setTimeout(() => {}, 30000)"';
    project.services[0].healthCheck = { type: 'http', url: `http://127.0.0.1:${port}/health`, startPeriodMs: 1500 };
    saveProject(project);
    const result = await verifyProject(loadProject('verify-bad-health'), {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    const saved = loadProject('verify-bad-health');
    assert.equal(saved.verification.status, 'failed');
    assert.equal(isVerificationCurrent(saved), false);
  } finally {
    restore();
  }
});

test('crashed startup is classified and reported', async () => {
  const { restore } = isolatedHome();
  try {
    const project = base('verify-crash', 0);
    project.services[0].command = 'node -e "console.error(\'boom\'); process.exit(3)"';
    delete project.services[0].healthCheck;
    delete project.services[0].port;
    saveProject(project);
    const result = await verifyProject(loadProject('verify-crash'), {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.detail || '', /boom|exited/);
  } finally {
    restore();
  }
});

test('editing the config after verification invalidates it', async () => {
  const { restore } = isolatedHome();
  try {
    const port = await freePort();
    const project = base('verify-invalidate', port);
    saveProject(project);
    const result = await verifyProject(loadProject('verify-invalidate'), {});
    assert.equal(result.ok, true);
    const edited = loadProject('verify-invalidate');
    edited.services[0].command = `node ${echoService} ${port} --changed`;
    assert.equal(isVerificationCurrent(edited), false);
  } finally {
    restore();
  }
});

test('leftover ports fail cleanup verification', async () => {
  const { restore } = isolatedHome();
  const port = await freePort();
  // Plant an unrelated listener on the service port: cleanup must report it.
  const squatter = createServer((req, res) => res.end('squat'));
  await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve));
  try {
    const project = {
      id: 'verify-cleanup',
      name: 'verify-cleanup',
      root: here,
      services: [
        {
          id: 'sleeper',
          name: 'sleeper',
          command: 'node -e "setTimeout(() => {}, 30000)"',
          port,
          healthCheck: { type: 'tcp', port, startPeriodMs: 5000 },
        },
      ],
    };
    saveProject(project);
    const result = await verifyProject(loadProject('verify-cleanup'), {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.detail || '', /cleanup incomplete/);
  } finally {
    squatter.close();
    restore();
  }
});

test('unsafe projects are blocked from verification without approval', async () => {
  const { restore } = isolatedHome();
  try {
    const port = await freePort();
    const project = base('verify-unsafe', port);
    project.metadata = { unsafe: true, unsafeReason: 'test target' };
    saveProject(project);
    const blocked = await verifyProject(loadProject('verify-unsafe'), {});
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 'blocked');
    const allowed = await verifyProject(loadProject('verify-unsafe'), { allowUnsafe: true });
    assert.equal(allowed.ok, true);
  } finally {
    restore();
  }
});

test('missing prerequisites block verification with suggestions', async () => {
  const { restore } = isolatedHome();
  try {
    const project = base('verify-prereq', 0);
    project.services[0].command = 'node definitely-not-here-server.mjs';
    delete project.services[0].healthCheck;
    delete project.services[0].port;
    saveProject(project);
    const result = await verifyProject(loadProject('verify-prereq'), {});
    assert.equal(result.ok, false);
    assert.equal(result.status, 'blocked');
    assert.ok(result.blockers.length > 0);
  } finally {
    restore();
  }
});
