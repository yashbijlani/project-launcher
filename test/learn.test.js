import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startLearnSession } from '../dist/learn.js';

test('learn sessions create their runtime directory before snapshotting', () => {
  const home = mkdtempSync(join(tmpdir(), 'launcher-home-'));
  const fixture = mkdtempSync(join(tmpdir(), 'launcher-learn-fixture-'));
  const previousHome = process.env.LAUNCHER_HOME;
  process.env.LAUNCHER_HOME = home;
  try {
    const session = startLearnSession(fixture, 'learn-smoke');
    assert.equal(session.projectId, 'learn-smoke');
    assert.ok(existsSync(join(home, 'run', 'learn-smoke.learn.json')));
  } finally {
    if (previousHome === undefined) delete process.env.LAUNCHER_HOME;
    else process.env.LAUNCHER_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(fixture, { recursive: true, force: true });
  }
});
