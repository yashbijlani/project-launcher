import { existsSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Project, UnsafeApproval } from './types.js';
import { buildStartPlan } from './graph.js';

export interface SafetyDecision {
  ok: boolean;
  errors: string[];
}

/**
 * The single authoritative safety gate for starting or verifying a project.
 * Both the CLI and the HTTP server must go through this function.
 */
export function assertSafeToOperate(
  project: Project,
  opts: { allowUnsafe?: boolean; unsafeApproval?: UnsafeApproval; operation: string },
): SafetyDecision {
  const errors: string[] = [];
  errors.push(...validateProjectStructure(project));
  if (project.metadata?.unsafe && !isUnsafeAuthorized(project, opts.allowUnsafe, opts.unsafeApproval)) {
    errors.push(
      `Project "${project.name}" is marked UNSAFE TO AUTO-RUN (${project.metadata.unsafeReason || 'no reason given'}). ` +
        `Refusing to ${opts.operation} without explicit authorization.`,
    );
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Explicit authorization requires either the CLI flag or a well-formed approval
 * object. Malformed or ambiguous approvals are rejected.
 */
export function isUnsafeAuthorized(
  project: Project,
  allowUnsafe?: boolean,
  approval?: UnsafeApproval,
): boolean {
  if (!project.metadata?.unsafe) return true;
  if (allowUnsafe === true) return true;
  if (!approval || typeof approval !== 'object') return false;
  if (approval.projectId !== project.id) return false;
  if (typeof approval.reason !== 'string' || approval.reason.trim().length < 8) return false;
  return true;
}

/** Resolve a service/action cwd and require it to stay inside the project root. */
export function resolveInsideRoot(
  root: string,
  cwd: string | undefined,
  what: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const base = resolve(root);
  const target = cwd ? resolve(base, cwd) : base;
  if (target !== base && !target.startsWith(base + sep)) {
    return { ok: false, error: `${what} escapes the project root: ${cwd}` };
  }
  return { ok: true, path: target };
}

/** Structural validation shared by start, verify, AI import, and the API. */
export function validateProjectStructure(project: Project): string[] {
  const errors: string[] = [];
  if (!project.id || !/^[a-z0-9][a-z0-9-]*$/.test(project.id)) {
    errors.push(`invalid project id: ${JSON.stringify(project.id)}`);
  }
  if (!project.name) errors.push('project name is required');
  if (!project.root) errors.push('project root is required');
  if (!project.services.length) errors.push('project has no services');

  const ids = new Set<string>();
  for (const s of project.services) {
    if (!s.id || !/^[a-z0-9][a-z0-9-]*$/.test(s.id)) errors.push(`invalid service id: ${JSON.stringify(s.id)}`);
    if (ids.has(s.id)) errors.push(`duplicate service id: ${s.id}`);
    ids.add(s.id);
    if (!s.command || !s.command.trim()) errors.push(`service ${s.id} has an empty command`);
    if (s.runtime === 'device' || s.runtime === 'external') {
      errors.push(`service ${s.id} has runtime "${s.runtime}" and cannot be auto-started`);
    }
    const cwd = resolveInsideRoot(project.root || '/', s.cwd, `service ${s.id} cwd`);
    if (!cwd.ok) errors.push(cwd.error);
    if (s.healthCheck) {
      const h = s.healthCheck;
      if (!['process', 'tcp', 'http', 'command'].includes(h.type)) {
        errors.push(`service ${s.id} has an invalid health check type`);
      }
      if (h.type === 'http' && !h.url) errors.push(`service ${s.id} http health check is missing a url`);
      if (h.type === 'tcp' && typeof h.port !== 'number') {
        errors.push(`service ${s.id} tcp health check is missing a port`);
      }
      if (h.type === 'command' && !h.command) {
        errors.push(`service ${s.id} command health check is missing a command`);
      }
    }
    if (s.restartPolicy && !['never', 'on-failure', 'always'].includes(s.restartPolicy)) {
      errors.push(`service ${s.id} has an invalid restart policy`);
    }
    if (s.provenance?.source && !['detector', 'manual', 'ai', 'learned', 'imported'].includes(s.provenance.source)) {
      errors.push(`service ${s.id} has an invalid provenance source`);
    }
  }

  for (const s of project.services) {
    for (const d of s.dependsOn || []) {
      if (!ids.has(d)) errors.push(`service ${s.id} depends on unknown service "${d}"`);
      if (d === s.id) errors.push(`service ${s.id} depends on itself`);
    }
  }
  const plan = buildStartPlan(project.services.filter((s) => s.runtime !== 'device' && s.runtime !== 'external'));
  for (const e of plan.errors) {
    if (e.kind === 'cycle') errors.push(e.message);
  }

  for (const [name, profile] of Object.entries(project.profiles || {})) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) errors.push(`invalid profile name: ${JSON.stringify(name)}`);
    for (const id of profile.services) {
      if (!ids.has(id)) errors.push(`profile ${name} references unknown service "${id}"`);
    }
  }
  for (const [name, action] of Object.entries(project.actions || {})) {
    if (!/^[a-z0-9][a-z0-9-_]*$/.test(name)) errors.push(`invalid action name: ${JSON.stringify(name)}`);
    if (!action.command?.trim()) errors.push(`action ${name} has an empty command`);
    const cwd = resolveInsideRoot(project.root || '/', action.cwd, `action ${name} cwd`);
    if (!cwd.ok) errors.push(cwd.error);
  }
  return errors;
}

/** Validate that configured paths exist (read-only). */
export function validateProjectPaths(project: Project): string[] {
  const errors: string[] = [];
  if (!existsSync(project.root) || !statSync(project.root).isDirectory()) {
    errors.push(`project root does not exist: ${project.root}`);
    return errors;
  }
  for (const s of project.services) {
    const cwd = resolveInsideRoot(project.root, s.cwd, `service ${s.id} cwd`);
    if (!cwd.ok) {
      errors.push(cwd.error);
      continue;
    }
    if (!existsSync(cwd.path)) errors.push(`service ${s.id} working directory does not exist: ${cwd.path}`);
  }
  for (const [name, action] of Object.entries(project.actions || {})) {
    const cwd = resolveInsideRoot(project.root, action.cwd, `action ${name} cwd`);
    if (cwd.ok && !existsSync(cwd.path)) errors.push(`action ${name} working directory does not exist: ${cwd.path}`);
  }
  return errors;
}
