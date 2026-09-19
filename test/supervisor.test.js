import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SupervisedProcess, classifyFailure } from '../dist/supervisor.js';
import { isProcessAlive } from '../dist/state.js';

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('supervisor captures stdout and tracks pid', async () => {
  const proc = new SupervisedProcess({ id: 'echo', command: 'echo hello-world', cwd: '/tmp' });
  const lines = [];
  proc.on('log', (l) => lines.push(l.line));
  const exited = new Promise((resolve) => proc.on('exit', resolve));
  proc.start();
  assert.ok(proc.pid > 0);
  await exited;
  assert.ok(lines.some((l) => l.includes('hello-world')));
});

test('stop kills the whole process tree, leaving no children', async () => {
  // The shell sleeps; it spawns a grandchild `sleep 300` in the same process group.
  const proc = new SupervisedProcess({
    id: 'tree',
    command: 'sleep 300 & echo child=$!; wait',
    cwd: '/tmp',
  });
  const lines = [];
  proc.on('log', (l) => lines.push(l.line));
  proc.start();
  await wait(600);
  const childLine = lines.find((l) => l.startsWith('child='));
  assert.ok(childLine, 'expected child pid line');
  const childPid = Number(childLine.split('=')[1]);
  assert.ok(isProcessAlive(childPid), 'grandchild should be alive');
  const leader = proc.pid;

  const info = await proc.stop(3000);
  await wait(500);
  assert.ok(info, 'stop should return exit info');
  assert.equal(isProcessAlive(childPid), false, 'grandchild must be terminated');
  if (leader) assert.equal(isProcessAlive(leader), false, 'leader must be terminated');
});

test('classifies common startup failures', () => {
  const base = { id: 'x', pid: 1, code: 1, signal: null, startedAt: 0, endedAt: 0, stdoutTail: '', stderrTail: '' };
  assert.equal(classifyFailure(base, 'Error: listen EADDRINUSE: address already in use :::8000', ''), 'PORT_CONFLICT');
  assert.equal(classifyFailure(base, 'ModuleNotFoundError: No module named fastapi', ''), 'MISSING_DEPENDENCY');
  assert.equal(classifyFailure(base, 'ImportError: attempted relative import with no known parent package', ''), 'WRONG_MODULE_PATH');
  assert.equal(classifyFailure(base, 'bash: uvicorn: command not found', ''), 'COMMAND_UNKNOWN');
  assert.equal(classifyFailure(base, 'could not connect to server: Connection refused ... postgres', ''), 'DATABASE_REQUIRED');
});
