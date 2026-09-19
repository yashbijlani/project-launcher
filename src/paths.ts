import { homedir } from 'node:os';
import { join } from 'node:path';

export function launcherHome(): string {
  return process.env.LAUNCHER_HOME || join(homedir(), '.local', 'share', 'project-launcher');
}

export function configDir(): string {
  return join(launcherHome(), 'projects');
}

export function stateDir(): string {
  return join(launcherHome(), 'state');
}

export function logDir(): string {
  return join(launcherHome(), 'logs');
}

export function runtimeDir(): string {
  return join(launcherHome(), 'run');
}

export function ensureDirs(): string[] {
  const dirs = [launcherHome(), configDir(), stateDir(), logDir(), runtimeDir()];
  return dirs;
}
