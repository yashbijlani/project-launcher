import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import type { Project, Service, Profile, Action } from './types.js';
import { configDir, ensureDirs } from './paths.js';

export interface YamlService {
  command: string;
  cwd?: string;
  port?: number;
  environment?: Record<string, string>;
  depends_on?: string[];
  healthcheck?: {
    type: string;
    url?: string;
    host?: string;
    port?: number;
    command?: string;
    timeoutMs?: number;
    intervalMs?: number;
    startPeriodMs?: number;
    expectStatus?: number[];
    expectBody?: string;
  };
  restart?: string;
  auto_start?: boolean;
  notes?: string;
}

export interface YamlProject {
  id?: string;
  name: string;
  root: string;
  metadata?: {
    description?: string;
    source?: string;
    stack?: string[];
    unsafe?: boolean;
    unsafe_reason?: string;
  };
  services: Record<string, YamlService>;
  profiles?: Record<string, { services: string[]; description?: string }>;
  actions?: Record<string, { command: string; cwd?: string; description?: string }>;
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'project';
}

export function serviceToYaml(s: Service): YamlService {
  const out: YamlService = { command: s.command };
  if (s.cwd) out.cwd = s.cwd;
  if (typeof s.port === 'number') out.port = s.port;
  if (s.environment && Object.keys(s.environment).length) out.environment = s.environment;
  if (s.dependsOn && s.dependsOn.length) out.depends_on = s.dependsOn;
  if (s.healthCheck) {
    const hc: YamlService['healthcheck'] = { type: s.healthCheck.type };
    if (s.healthCheck.url) hc.url = s.healthCheck.url;
    if (s.healthCheck.host) hc.host = s.healthCheck.host;
    if (typeof s.healthCheck.port === 'number') hc.port = s.healthCheck.port;
    if (s.healthCheck.command) hc.command = s.healthCheck.command;
    if (typeof s.healthCheck.timeoutMs === 'number') hc.timeoutMs = s.healthCheck.timeoutMs;
    if (typeof s.healthCheck.intervalMs === 'number') hc.intervalMs = s.healthCheck.intervalMs;
    if (typeof s.healthCheck.startPeriodMs === 'number') hc.startPeriodMs = s.healthCheck.startPeriodMs;
    if (s.healthCheck.expectStatus) hc.expectStatus = s.healthCheck.expectStatus;
    if (s.healthCheck.expectBody) hc.expectBody = s.healthCheck.expectBody;
    out.healthcheck = hc;
  }
  if (s.restartPolicy && s.restartPolicy !== 'never') out.restart = s.restartPolicy;
  if (s.autoStart === false) out.auto_start = false;
  if (s.notes) out.notes = s.notes;
  return out;
}

export function projectToYaml(p: Project): YamlProject {
  const services: Record<string, YamlService> = {};
  for (const s of p.services) services[s.id] = serviceToYaml(s);
  const out: YamlProject = { id: p.id, name: p.name, root: p.root, services };
  if (p.metadata) {
    out.metadata = {};
    if (p.metadata.description) out.metadata.description = p.metadata.description;
    if (p.metadata.source) out.metadata.source = p.metadata.source;
    if (p.metadata.stack?.length) out.metadata.stack = p.metadata.stack;
    if (p.metadata.unsafe) out.metadata.unsafe = true;
    if (p.metadata.unsafeReason) out.metadata.unsafe_reason = p.metadata.unsafeReason;
  }
  if (p.profiles) {
    out.profiles = {};
    for (const [k, v] of Object.entries(p.profiles)) {
      out.profiles[k] = { services: v.services };
      if (v.description) out.profiles[k]!.description = v.description;
    }
  }
  if (p.actions) {
    out.actions = {};
    for (const [k, v] of Object.entries(p.actions)) {
      out.actions[k] = { command: v.command };
      if (v.cwd) out.actions[k]!.cwd = v.cwd;
      if (v.description) out.actions[k]!.description = v.description;
    }
  }
  return out;
}

export function yamlToProject(y: YamlProject, fallbackRoot: string): Project {
  const root = y.root || fallbackRoot;
  const services: Service[] = Object.entries(y.services || {}).map(([id, s]) => {
    const svc: Service = { id, name: id, command: s.command, cwd: s.cwd };
    if (typeof s.port === 'number') svc.port = s.port;
    if (s.environment) svc.environment = s.environment;
    if (s.depends_on) svc.dependsOn = s.depends_on;
    if (s.restart) svc.restartPolicy = s.restart as Service['restartPolicy'];
    if (s.auto_start === false) svc.autoStart = false;
    if (s.notes) svc.notes = s.notes;
    const h = s.healthcheck;
    if (h) {
      svc.healthCheck = { type: h.type as Service['healthCheck'] extends undefined ? never : NonNullable<Service['healthCheck']>['type'] };
      const hc = svc.healthCheck;
      if (h.url) hc.url = h.url;
      if (h.host) hc.host = h.host;
      if (typeof h.port === 'number') hc.port = h.port;
      if (h.command) hc.command = h.command;
      if (typeof h.timeoutMs === 'number') hc.timeoutMs = h.timeoutMs;
      if (typeof h.intervalMs === 'number') hc.intervalMs = h.intervalMs;
      if (typeof h.startPeriodMs === 'number') hc.startPeriodMs = h.startPeriodMs;
      if (h.expectStatus) hc.expectStatus = h.expectStatus;
      if (h.expectBody) hc.expectBody = h.expectBody;
    }
    return svc;
  });
  const profiles: Record<string, Profile> = {};
  for (const [k, v] of Object.entries(y.profiles || {})) profiles[k] = { services: v.services, description: v.description };
  const actions: Record<string, Action> = {};
  for (const [k, v] of Object.entries(y.actions || {})) actions[k] = { command: v.command, cwd: v.cwd, description: v.description };
  const p: Project = {
    id: y.id || slugify(y.name),
    name: y.name,
    root,
    services,
    profiles: Object.keys(profiles).length ? profiles : undefined,
    actions: Object.keys(actions).length ? actions : undefined,
  };
  if (y.metadata) {
    p.metadata = {
      description: y.metadata.description,
      source: y.metadata.source as Project['metadata'] extends undefined ? never : NonNullable<Project['metadata']>['source'],
      stack: y.metadata.stack,
      unsafe: y.metadata.unsafe,
      unsafeReason: y.metadata.unsafe_reason,
    };
  }
  return p;
}

export function configPath(id: string): string {
  return join(configDir(), `${id}.yaml`);
}

export function saveProject(p: Project): string {
  ensureDirsSafe();
  const path = configPath(p.id);
  const header =
    `# project-launcher configuration\n` +
    `# Edit by hand freely. Re-run "launcher discover <root>" to regenerate.\n`;
  writeFileSync(path, header + stringifyYaml(projectToYaml(p) as unknown as Record<string, unknown>, { lineWidth: 100 }));
  return path;
}

export function loadProject(id: string): Project | null {
  const path = configPath(id);
  if (!existsSync(path)) return null;
  return loadProjectFile(path);
}

export function loadProjectFile(path: string): Project {
  const raw = readFileSync(path, 'utf8');
  const y = parseYaml(raw) as YamlProject;
  const fallbackRoot = y.root || path;
  return yamlToProject(y, fallbackRoot);
}

export function listProjects(): Project[] {
  ensureDirsSafe();
  if (!existsSync(configDir())) return [];
  return readdirSync(configDir())
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => loadProjectFile(join(configDir(), f)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function removeProject(id: string): boolean {
  const path = configPath(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

function ensureDirsSafe(): void {
  for (const d of ensureDirs()) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
}
