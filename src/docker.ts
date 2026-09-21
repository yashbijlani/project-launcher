import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseCompose } from './detectors/docker.js';

export interface ComposeServiceModel {
  name: string;
  image?: string;
  build?: boolean;
  ports: string[];
  dependsOn: string[];
  dependsConditions?: Record<string, string>;
  environment?: Record<string, string>;
  volumes?: string[];
  profiles?: string[];
  healthcheck?: { test?: string[] | string; interval?: string; timeout?: string; retries?: number };
}

export interface ComposeProjectModel {
  source: 'docker-cli' | 'fallback-parser';
  services: ComposeServiceModel[];
}

/**
 * Authoritative Compose model when Docker is available
 * (`docker compose config --format json`), with the built-in fallback parser
 * otherwise. Read-only: never starts containers.
 */
export function getComposeModel(root: string, composeFile?: string): ComposeProjectModel | null {
  const file =
    composeFile ||
    ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
      .map((f) => join(root, f))
      .find((f) => existsSync(f));
  if (!file) return null;

  const cli = tryComposeConfigJson(file);
  if (cli) return { source: 'docker-cli', services: cli };

  const parsed = parseCompose(file);
  if (!parsed) return null;
  return {
    source: 'fallback-parser',
    services: parsed.services.map((s) => ({
      name: s.name,
      image: s.image,
      build: s.build,
      ports: s.ports,
      dependsOn: s.dependsOn,
    })),
  };
}

function tryComposeConfigJson(composeFile: string): ComposeServiceModel[] | null {
  try {
    const r = spawnSync('docker', ['compose', '-f', composeFile, 'config', '--format', 'json'], {
      encoding: 'utf8',
      timeout: 15000,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const data = JSON.parse(r.stdout) as { services?: Record<string, Record<string, unknown>> };
    if (!data.services) return null;
    return Object.entries(data.services).map(([name, s]) => ({
      name,
      image: typeof s.image === 'string' ? s.image : undefined,
      build: s.build !== undefined,
      ports: normalizePorts(s.ports),
      dependsOn: normalizeDependsOn(s.depends_on),
      dependsConditions: normalizeConditions(s.depends_on),
      environment: normalizeEnv(s.environment),
      volumes: Array.isArray(s.volumes) ? s.volumes.map(String) : undefined,
      profiles: Array.isArray(s.profiles) ? s.profiles.map(String) : undefined,
      healthcheck: (s.healthcheck as ComposeServiceModel['healthcheck']) || undefined,
    }));
  } catch {
    return null;
  }
}

function normalizePorts(ports: unknown): string[] {
  if (!Array.isArray(ports)) return [];
  return ports.map((p) => {
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') {
      const o = p as Record<string, unknown>;
      return `${o.published ?? '?'}:${o.target ?? '?'}`;
    }
    return String(p);
  });
}

function normalizeDependsOn(dep: unknown): string[] {
  if (!dep) return [];
  if (Array.isArray(dep)) return dep.map(String);
  if (typeof dep === 'object') return Object.keys(dep as Record<string, unknown>);
  return [];
}

function normalizeConditions(dep: unknown): Record<string, string> | undefined {
  if (!dep || Array.isArray(dep) || typeof dep !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(dep as Record<string, unknown>)) {
    const cond = (v as Record<string, unknown>)?.condition;
    if (typeof cond === 'string') out[k] = cond;
  }
  return Object.keys(out).length ? out : undefined;
}

function normalizeEnv(env: unknown): Record<string, string> | undefined {
  if (!env) return undefined;
  if (Array.isArray(env)) {
    const out: Record<string, string> = {};
    for (const e of env.map(String)) {
      const i = e.indexOf('=');
      if (i > 0) out[e.slice(0, i)] = e.slice(i + 1);
    }
    return out;
  }
  if (typeof env === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
      if (v !== null && v !== undefined) out[k] = String(v);
    }
    return out;
  }
  return undefined;
}

/** Result of `docker info`: daemon reachability without starting anything. */
export function dockerDaemonAvailable(): boolean {  try {
    const r = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}
