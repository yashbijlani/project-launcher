import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Project, ProjectReadiness, ReadinessBlocker } from './types.js';
import { resolveInsideRoot, validateProjectStructure } from './safety.js';

export interface PrereqCheck {
  ok: boolean;
  blockers: ReadinessBlocker[];
  environment: {
    nodeVersion?: string;
    pythonVersion?: string;
    dockerVersion?: string;
    dockerDaemon?: boolean;
  };
}

function runVersion(cmd: string, args: string[]): string | undefined {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) return (r.stdout || '').trim().split('\n')[0];
    return undefined;
  } catch {
    return undefined;
  }
}

function which(bin: string): string | null {
  const paths = (process.env.PATH || '').split(':');
  for (const p of paths) {
    const full = join(p, bin);
    try {
      if (existsSync(full) && statSync(full).isFile()) return full;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Inspect everything needed to start a project WITHOUT starting anything and
 * WITHOUT installing anything. Missing pieces become structured blockers.
 */
export function checkPrereqs(project: Project): PrereqCheck {
  const blockers: ReadinessBlocker[] = [];
  const environment: PrereqCheck['environment'] = {};
  const nodeVersion = runVersion('node', ['--version']);
  if (nodeVersion) environment.nodeVersion = nodeVersion;

  let sawPython = false;
  let sawDocker = false;

  for (const svc of project.services) {
    const cwd = resolveInsideRoot(project.root, svc.cwd, `service ${svc.id} cwd`);
    if (!cwd.ok) {
      blockers.push({ type: 'config', message: cwd.error, service: svc.id });
      continue;
    }
    const cmd = svc.command;

    if (svc.runtime === 'device') {
      blockers.push({
        type: 'device',
        message: `service ${svc.id} requires a device or emulator`,
        service: svc.id,
        suggestion: 'Attach a device/emulator and run the documented build command manually',
      });
      continue;
    }
    if (svc.runtime === 'external') {
      blockers.push({ type: 'config', message: `service ${svc.id} is external and cannot be started`, service: svc.id });
      continue;
    }

    // --- Docker ---
    if (/(^|\s)(docker\s+compose|docker\s+(run|up|compose))/.test(cmd)) {
      sawDocker = true;
      continue; // daemon check below covers all compose services at once
    }

    // --- Node ---
    const nodeMatch = cmd.match(/(^|\s|;|&&)(npm|pnpm|yarn|bun|node|npx|tsx|vite|next)(?=\s|$)/);
    if (nodeMatch) {
      const bin = nodeMatch[2]!;
      if (!which(bin)) {
        blockers.push({ type: 'environment', message: `${bin} is not on PATH`, service: svc.id, suggestion: `Install ${bin} (launcher never installs automatically)` });
      }
      // Direct file execution: node server.mjs
      const nodeFile = cmd.match(/(^|\s|;|&&)(node|bun|tsx)\s+([A-Za-z0-9_./-]+\.m?[jt]s)(?=\s|$)/);
      if (nodeFile) {
        const entry = resolve(cwd.path, nodeFile[3]!);
        const inside = entry === resolve(project.root) || entry.startsWith(resolve(project.root) + '/');
        if (!inside || !existsSync(entry)) {
          blockers.push({ type: 'config', message: `node entrypoint not found: ${nodeFile[3]}`, service: svc.id });
        }
      }
      const pkgPath = join(cwd.path, 'package.json');
      if (/^(npm|pnpm|yarn|bun)(\s+run)?\s+\S/.test(cmd) || /\b(vite|next)\b/.test(cmd)) {
        const pkg = readJson(pkgPath);
        if (!pkg) {
          blockers.push({ type: 'config', message: `package.json not found in ${cwd.path}`, service: svc.id });
        } else {
          const scriptMatch = cmd.match(/(?:npm\s+run\s+|pnpm\s+(?:run\s+)?|yarn\s+(?:run\s+)?|bun\s+(?:run\s+)?)([A-Za-z0-9:_-]+)/);
          if (scriptMatch) {
            const scripts = (pkg.scripts as Record<string, string>) || {};
            if (!scripts[scriptMatch[1]!]) {
              blockers.push({ type: 'config', message: `package.json has no script "${scriptMatch[1]}"`, service: svc.id });
            }
          }
          if (!existsSync(join(cwd.path, 'node_modules'))) {
            blockers.push({
              type: 'environment',
              message: `node_modules missing in ${cwd.path}`,
              service: svc.id,
              suggestion: `Install dependencies manually (e.g. cd ${cwd.path} && npm install)`,
            });
          }
        }
      }
      continue;
    }

    // --- Python ---
    const pyMatch = cmd.match(/(^|\s|;|&&)([A-Za-z0-9_./-]*python[A-Za-z0-9.]*)(?=\s|$)/);
    if (pyMatch) {
      sawPython = true;
      const interp = pyMatch[2]!;
      const interpPath = interp.includes('/') ? resolve(cwd.path, interp) : which(interp);
      if (!interpPath || !existsSync(interpPath)) {
        blockers.push({ type: 'environment', message: `python interpreter not found: ${interp}`, service: svc.id, suggestion: 'Create the virtual environment manually' });
        continue;
      }
      // Entry file checks (read-only).
      const fileRun = cmd.match(/python[A-Za-z0-9.]*\s+([A-Za-z0-9_./-]+\.py)(?=\s|$)/);
      if (fileRun) {
        const entry = resolve(cwd.path, fileRun[1]!);
        const inside = entry === resolve(project.root) || entry.startsWith(resolve(project.root) + '/');
        if (!inside || !existsSync(entry)) {
          blockers.push({ type: 'config', message: `python entrypoint not found: ${fileRun[1]}`, service: svc.id });
        }
      }
      const moduleRun = cmd.match(/python[A-Za-z0-9.]*\s+-m\s+([A-Za-z0-9_.]+)(?:\s+([A-Za-z0-9_.:]+))?/);
      if (moduleRun) {
        const checkModule = (mod: string): boolean => {
          const modPath = mod.replace(/\./g, '/');
          const candidates = [join(cwd.path, `${modPath}.py`), join(cwd.path, modPath, '__main__.py'), join(cwd.path, modPath, '__init__.py')];
          if (candidates.some((c) => existsSync(c))) return true;
          // Fall back to asking the interpreter itself (read-only import).
          // Covers modules installed in the venv (uvicorn, gunicorn, flask, ...).
          if (!interpPath) return false;
          try {
            const r = spawnSync(interpPath, ['-c', `import ${mod.split('.')[0]}`], { encoding: 'utf8', timeout: 15000 });
            return r.status === 0;
          } catch {
            return false;
          }
        };
        if (!checkModule(moduleRun[1]!)) {
          blockers.push({ type: 'config', message: `python module not found: ${moduleRun[1]}`, service: svc.id });
        }
        // For `python -m runner app.module:attr`, also verify the app target on disk.
        const appTarget = moduleRun[2]?.split(':')[0];
        if (appTarget && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(appTarget) && !checkModule(appTarget)) {
          blockers.push({ type: 'config', message: `python app target not found: ${appTarget}`, service: svc.id });
        }
      }
      continue;
    }

    // --- Shell scripts ---
    const scriptMatch = cmd.match(/^\.\/([A-Za-z0-9_./-]+\.sh)\b/);
    if (scriptMatch) {
      const p = resolve(cwd.path, scriptMatch[1]!);
      if (!existsSync(p)) blockers.push({ type: 'config', message: `script not found: ${scriptMatch[1]}`, service: svc.id });
      continue;
    }
  }

  if (sawPython) {
    const v = runVersion('python3', ['--version']) || runVersion('python', ['--version']);
    if (v) environment.pythonVersion = v;
  }

  // --- Credentials: .env.example with empty values and no .env ---
  const examplePath = join(project.root, '.env.example');
  if (existsSync(examplePath) && !existsSync(join(project.root, '.env'))) {
    try {
      const lines = readFileSync(examplePath, 'utf8').split('\n');
      const empty = lines
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#'))
        .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=$/.test(l));
      if (empty.length) {
        blockers.push({
          type: 'credentials',
          message: `.env is missing; ${empty.length} required variable(s) are empty in .env.example`,
          suggestion: 'Copy .env.example to .env and fill in the required values manually',
        });
      }
    } catch {
      /* ignore */
    }
  }

  // --- Docker daemon (once per project) ---
  const needsDocker = project.services.some((s) => /(^|\s)(docker\s+compose|docker\s+(run|up|compose))/.test(s.command));
  if (needsDocker || sawDocker) {
    const dv = runVersion('docker', ['--version']);
    if (dv) environment.dockerVersion = dv;
    const info = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 8000 });
    if (info.status === 0) {
      environment.dockerDaemon = true;
    } else {
      environment.dockerDaemon = false;
      blockers.push({
        type: 'docker',
        message: 'Docker daemon unavailable',
        suggestion: 'Start the Docker daemon, then retry (launcher never starts it automatically)',
      });
    }
  }

  return { ok: blockers.length === 0, blockers, environment };
}

/** Project-level readiness without starting anything. */
export function computeReadiness(project: Project, verificationCurrent: boolean): ProjectReadiness {
  // No services at all: nothing to run yet. This is "unknown", not "broken".
  if (!project.services.length) {
    return { status: 'unknown', blockers: [{ type: 'unknown', message: 'No services configured; run discovery or add services manually' }] };
  }
  // Runtime kinds that can never be started as local processes take priority
  // over structural validation, so they are reported as their own blocker.
  const device = project.services.filter((s) => s.runtime === 'device');
  if (device.length) {
    return {
      status: 'needs_device',
      blockers: device.map((s) => ({
        type: 'device' as const,
        service: s.id,
        message: `service ${s.id} requires a device or emulator`,
        suggestion: 'Attach a device/emulator and run the documented build command manually',
      })),
    };
  }
  const external = project.services.filter((s) => s.runtime === 'external');
  if (external.length) {
    return {
      status: 'needs_environment',
      blockers: external.map((s) => ({
        type: 'environment' as const,
        service: s.id,
        message: `service ${s.id} is external and is not managed by the launcher`,
      })),
    };
  }
  const structural = validateProjectStructure(project);
  if (structural.length) {
    return {
      status: 'broken',
      blockers: structural.map((message) => ({ type: 'config' as const, message })),
    };
  }
  if (project.metadata?.unsafe) {
    return {
      status: 'unsafe',
      blockers: [{ type: 'unsafe', message: project.metadata.unsafeReason || 'Marked unsafe to auto-run' }],
    };
  }
  if (!project.services.length) {
    return { status: 'unknown', blockers: [{ type: 'unknown', message: 'No services configured' }] };
  }
  const prereqs = checkPrereqs(project);
  if (prereqs.blockers.length) {
    const first = prereqs.blockers[0]!;
    const status =
      first.type === 'docker'
        ? 'needs_docker'
        : first.type === 'device'
          ? 'needs_device'
          : first.type === 'credentials'
            ? 'needs_credentials'
            : 'needs_environment';
    return { status, blockers: prereqs.blockers };
  }
  return {
    status: verificationCurrent ? 'ready' : 'ready_but_unverified',
    blockers: [],
  };
}
