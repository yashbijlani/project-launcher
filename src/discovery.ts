import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Project,
  Service,
  Detection,
  CandidateCommand,
  ProjectEvidence,
  FailureClass,
} from './types.js';
import { runDetectors } from './detectors/index.js';
import { composeServiceCandidates } from './detectors/docker.js';
import { slugify } from './config.js';
import type { DetectionContext } from './detectors/base.js';

export interface DiscoveryOutcome {
  project: Project;
  detections: Detection[];
  confidence: number;
  warnings: string[];
  evidence: ProjectEvidence;
  /** Commands that need a human decision (ambiguous). */
  ambiguous: CandidateCommand[];
}

/**
 * Deterministic discovery: run detectors, reconcile candidates into services,
 * pick a primary command per role, and generate a project config proposal.
 */
export function discover(root: string, nameHint?: string): DiscoveryOutcome {
  const { detections, context } = runDetectors(root);
  const name = nameHint || basenameSafe(root);
  return reconcile(root, name, detections, context);
}

export function reconcile(
  root: string,
  name: string,
  detections: Detection[],
  ctx: DetectionContext,
): DiscoveryOutcome {
  const warnings: string[] = [];
  const services: Service[] = [];
  const ambiguous: CandidateCommand[] = [];
  const used: CandidateCommand[] = [];

  const unsafeDetection = detections.find((d) => d.type === 'UnsafeProjectDetector');
  const dockerDetection = detections.find((d) => d.type === 'DockerDetector');
  const nodeDetection = detections.find((d) => d.type === 'NodeDetector');
  const pyDetection = detections.find((d) => d.type === 'PythonDetector');
  const androidDetection = detections.find((d) => d.type === 'AndroidDetector');
  const flutterDetection = detections.find((d) => d.type === 'FlutterDetector');
  const makeDetection = detections.find((d) => d.type === 'MakeDetector');
  const shellDetection = detections.find((d) => d.type === 'ShellScriptDetector');

  // --- Docker: expand compose services into individual managed services ---
  let dockerStackProposed = false;
  if (dockerDetection && dockerDetection.confidence >= 0.8 && dockerDetection.candidates.length) {
    const composeCandidates = composeServiceCandidates(ctx).filter((c) => c.serviceId);
    const composePath = (dockerDetection.meta?.composeFile as string) || undefined;
    const infraNames = /^(db|postgres|postgresql|mysql|mariadb|redis|cache|rabbitmq|kafka|minio|mailhog|elasticsearch|mongodb|mongo)$/i;
    const infraOnlyCompose =
      composeCandidates.length > 0 && composeCandidates.every((c) => infraNames.test(c.serviceId || ''));
    if (infraOnlyCompose) {
      // Infrastructure-only compose (db/redis/...): keep them as distinct services
      // and let Node/Python detection provide the application services on top.
      for (const c of composeCandidates) {
        const id = slugify(c.serviceId!);
        services.push({
          id,
          name: c.serviceId!,
          command: c.command,
          cwd: c.cwd,
          restartPolicy: 'never',
          notes: 'Infrastructure service managed by docker compose.',
        });
        used.push(c);
      }
      warnings.push(
        'Compose file only contains infrastructure services (database/cache). Application services were detected separately; start order is not inferred beyond compose dependencies.',
      );
    } else if (composeCandidates.length > 1) {
      for (const c of composeCandidates) {
        const id = slugify(c.serviceId!);
        services.push({
          id,
          name: c.serviceId!,
          command: c.command,
          cwd: c.cwd,
          dependsOn: (c.dependsOn || []).map(slugify).filter((d) => d !== id),
          restartPolicy: 'never',
        });
        used.push(c);
      }
      dockerStackProposed = true;
      warnings.push(
        'Compose services were expanded into individual services. Their internal ports are managed by Docker; health checks are not configured by default.',
      );
    } else {
      const cmd = dockerDetection.candidates[0]!;
      services.push({
        id: 'stack',
        name: 'stack',
        command: cmd.command,
        cwd: cmd.cwd,
        restartPolicy: 'never',
      });
      used.push(cmd);
      dockerStackProposed = true;
    }
    if (composePath) warnings.push(`Detected docker-compose: ${composePath}`);
  }

  // --- Node services (one per package dir) ---
  const nodeCandidates = nodeDetection?.candidates || [];
  if (dockerStackProposed && nodeCandidates.length) {
    for (const c of nodeCandidates) ambiguous.push(c);
    warnings.push('A docker-compose stack was detected; local Node commands are listed as alternates. Remove the compose stack and re-discover to use local commands.');
  }
  const nodeByDir = groupByDir(dockerStackProposed ? [] : nodeCandidates);
  for (const [dir, cands] of nodeByDir) {
    const primary = pickPrimary(cands);
    if (!primary) continue;
    const role = primary.role || 'app';
    const id = uniqueId(services, serviceIdFor(role, dir));
    const svc: Service = {
      id,
      name: dir ? `${role} (${dir})` : role,
      command: primary.command,
      cwd: primary.cwd,
      restartPolicy: 'never',
    };
    const port = guessPortFromCommand(primary.command) ?? (nodeDetection?.meta?.devServerPort as number | undefined);
    if (port) {
      svc.port = port;
      svc.healthCheck = { type: 'http', url: `http://localhost:${port}`, startPeriodMs: 30_000 };
    }
    services.push(svc);
    used.push(primary);
    if (cands.length > 1) {
      for (const alt of cands) if (alt !== primary) ambiguous.push(alt);
    }
  }

  // --- Python services ---
  const pyCandidates = pyDetection?.candidates || [];
  if (dockerStackProposed && pyCandidates.length) {
    for (const c of pyCandidates) ambiguous.push(c);
  }
  const pyByDir = groupByDir(dockerStackProposed ? [] : pyCandidates);
  for (const [dir, cands] of pyByDir) {
    // prefer the --reload variant as primary development command
    const primary = pickPrimary(cands);
    if (!primary) continue;
    const role = primary.role || 'backend';
    const id = uniqueId(services, serviceIdFor(role, dir));
    const svc: Service = {
      id,
      name: dir ? `${role} (${dir})` : role,
      command: primary.command,
      cwd: primary.cwd,
      restartPolicy: 'never',
    };
    const port = guessPortFromCommand(primary.command) ?? guessPortFromTexts(
      [readIfExists(join(root, dir || '.', 'requirements.txt')), readIfExists(join(root, dir || '.', 'README.md'))],
    );
    if (port) {
      svc.port = port;
      svc.healthCheck = { type: 'http', url: `http://localhost:${port}`, startPeriodMs: 45_000 };
    }
    services.push(svc);
    used.push(primary);
    if (cands.length > 1) for (const alt of cands) if (alt !== primary) ambiguous.push(alt);
  }

  // --- Flutter ---
  if (flutterDetection?.candidates.length) {
    const primary = flutterDetection.candidates[0]!;
    services.push({
      id: 'app',
      name: 'flutter app',
      command: primary.command,
      cwd: primary.cwd,
      restartPolicy: 'never',
      notes: 'Flutter requires an attached device/emulator. Not auto-startable in headless environments.',
    });
    used.push(primary);
  }

  // --- Make ---
  if (!services.length && makeDetection?.candidates.length) {
    const primary = makeDetection.candidates[0]!;
    services.push({
      id: 'app',
      name: 'make',
      command: primary.command,
      restartPolicy: 'never',
    });
    used.push(primary);
  }

  // --- Shell scripts ---
  if (!services.length && shellDetection?.candidates.length) {
    const primary = shellDetection.candidates[0]!;
    services.push({
      id: 'app',
      name: primary.command.replace('./', ''),
      command: primary.command,
      restartPolicy: 'never',
    });
    used.push(primary);
  }

  // --- Android fallback (cannot auto-run) ---
  if (!services.length && androidDetection) {
    services.push({
      id: 'android',
      name: 'android app',
      command: androidDetection.candidates[0]?.command || './gradlew build',
      restartPolicy: 'never',
      notes: 'Requires Android SDK, Gradle, and a device/emulator. Marked unsafe to auto-run.',
    });
  }

  // --- Compose projects with no expansion ---
  if (!services.length && dockerDetection?.candidates.length) {
    const primary = dockerDetection.candidates[0]!;
    services.push({
      id: 'stack',
      name: 'stack',
      command: primary.command,
      cwd: primary.cwd,
      restartPolicy: 'never',
    });
    used.push(primary);
  }

  if (!services.length) {
    warnings.push('No deterministic startup command was found. Manual configuration is required.');
  }

  // Infer app -> infra dependencies by scanning manifest text for db/cache usage.
  inferInfraDependencies(root, services);

  // Deduplicate ambiguous against used
  const ambiguousFinal = ambiguous.filter(
    (a) => !used.some((u) => u.command === a.command && u.cwd === a.cwd),
  );

  const unsafe = Boolean(unsafeDetection) || Boolean(androidDetection);
  const project: Project = {
    id: slugify(name),
    name,
    root,
    services,
    metadata: {
      source: 'discovery',
      discoveredAt: new Date().toISOString(),
      stack: detections.map((d) => d.type.replace('Detector', '')).filter((t) => t !== 'EnvFile' && t !== 'UnsafeProject'),
      unsafe,
      unsafeReason: unsafeDetection ? unsafeDetection.evidence.join('; ') : androidDetection ? 'Android/Gradle project requires a device' : undefined,
    },
  };

  // Profiles: development = all services, minimal = primary service only
  if (services.length > 1) {
    project.profiles = {
      minimal: { services: [services[0]!.id], description: 'Primary service only' },
      development: { services: services.map((s) => s.id), description: 'All services' },
    };
  }

  const monorepoWithoutRootService = detections.some(
    (d) => d.type === 'MonorepoDetector' && d.meta?.monorepo === true && d.meta?.rootService === false,
  );
  const onlyNestedServices = services.length > 0 && services.every((s) => Boolean(s.cwd));
  if (monorepoWithoutRootService && onlyNestedServices) {
    warnings.push(
      'This is a workspace monorepo without a root start command. The proposed command belongs to one nested package/example and must be confirmed before use.',
    );
  }

  const overall = computeConfidence(detections, services, unsafe, monorepoWithoutRootService && onlyNestedServices);
  const evidence: ProjectEvidence = {
    name,
    root,
    topDirs: ctx.topDirs,
    manifests: detections.flatMap((d) => (d.meta?.manifests as string[]) || []),
    signals: Object.fromEntries(detections.map((d) => [d.type, d.meta ?? true])),
    readmeTitle: undefined,
    readmeExcerpt: readHeadline(root),
    detections,
  };

  return { project, detections, confidence: overall, warnings, evidence, ambiguous: ambiguousFinal };
}

function computeConfidence(
  detections: Detection[],
  services: Service[],
  unsafe: boolean,
  nestedMonorepoOnly: boolean,
): number {
  const meaningful = detections.filter(
    (d) => d.type !== 'EnvFileDetector' && d.type !== 'UnsafeProjectDetector' && d.type !== 'MonorepoDetector',
  );
  if (!services.length) return 0;
  const best = Math.max(0, ...meaningful.map((d) => d.confidence));
  if (unsafe) return Math.min(best, 0.5);
  // A package/example nested in a workspace is not evidence for the repository as a whole.
  if (nestedMonorepoOnly) return Math.min(best, 0.65);
  return best;
}

function pickPrimary(candidates: CandidateCommand[]): CandidateCommand | null {
  if (!candidates.length) return null;
  const priority = (c: CandidateCommand): number => {
    const cmd = c.command;
    if (/--reload/.test(cmd)) return 0;
    if (/ (dev|develop|serve)\b/.test(cmd)) return 1;
    if (/^(pnpm|npm run|yarn|bun) (dev|start)/.test(cmd)) return 1;
    if (/ (start|run)\b/.test(cmd)) return 2;
    if (/uvicorn|flask run|runserver/.test(cmd)) return 2;
    return 5;
  };
  return [...candidates].sort((a, b) => priority(a) - priority(b))[0]!;
}

function groupByDir(cands: CandidateCommand[]): Map<string, CandidateCommand[]> {
  const m = new Map<string, CandidateCommand[]>();
  for (const c of cands) {
    const key = c.cwd || '';
    if (!m.has(key)) m.set(key, []);
    m.get(key)!.push(c);
  }
  return m;
}

function uniqueId(existing: Service[], id: string): string {
  if (!existing.some((s) => s.id === id)) return id;
  let i = 2;
  while (existing.some((s) => s.id === `${id}-${i}`)) i++;
  return `${id}-${i}`;
}

/**
 * Build a concise, human-meaningful service id from a role and a directory.
 * Avoids duplication like "frontend-frontend" and drops long absolute paths.
 */
function serviceIdFor(role: string, dir: string): string {
  const clean = (dir || '').replace(/^\.?\//, '').replace(/\/$/, '');
  if (!clean || clean === '.') return slugify(role);
  const segments = clean.split('/').filter((s) => s && s !== '.');
  const last = segments[segments.length - 1] || role;
  if (last === role) return slugify(role);
  // If the directory is a generic container (apps, packages, src), use the segment before it.
  const generic = new Set(['apps', 'packages', 'src', 'services', 'backend', 'frontend']);
  if (segments.length >= 2 && generic.has(last)) {
    return slugify(`${role}-${segments[segments.length - 2]}`);
  }
  if (segments.length === 1) return slugify(`${role}-${last}`);
  return slugify(`${role}-${segments.slice(-2).join('-')}`);
}

/** Infer app -> infra dependencies by scanning manifest text for db/cache usage. */
function inferInfraDependencies(root: string, services: Service[]): void {
  const infra = services.filter((s) =>
    ['db', 'postgres', 'postgresql', 'mysql', 'mariadb', 'redis', 'cache', 'mongo', 'mongodb'].includes(s.id),
  );
  if (!infra.length) return;
  const apps = services.filter((s) => !infra.includes(s));
  for (const app of apps) {
    const texts: string[] = [];
    const dir = app.cwd ? join(root, app.cwd) : root;
    for (const f of ['requirements.txt', 'package.json', 'pyproject.toml', '.env.example', '.env']) {
      const t = readIfExists(join(dir, f));
      if (t) texts.push(t);
    }
    const blob = texts.join('\n').toLowerCase();
    const deps = new Set(app.dependsOn || []);
    if (/(postgres|psycopg|pg_|database_url|sqlalchemy|prisma|typeorm|sequelize)/.test(blob)) {
      for (const i of infra) if (['db', 'postgres', 'postgresql'].includes(i.id)) deps.add(i.id);
    }
    if (/(redis|bullmq|celery|\brq\b)/.test(blob)) {
      for (const i of infra) if (['redis', 'cache'].includes(i.id)) deps.add(i.id);
    }
    if (/(mongo|mongoose)/.test(blob)) {
      for (const i of infra) if (['mongo', 'mongodb'].includes(i.id)) deps.add(i.id);
    }
    if (deps.size) app.dependsOn = [...deps];
  }
}

export function guessPortFromCommand(cmd: string): number | undefined {
  const patterns = [
    /--port[= ](\d{2,5})/,
    /-p\s*(\d{2,5})/,
    /port[= ](\d{2,5})/,
    /:(\d{4,5})(?:\s|$)/,
  ];
  for (const p of patterns) {
    const m = cmd.match(p);
    if (m) {
      const n = Number(m[1]);
      if (n >= 80 && n <= 65535) return n;
    }
  }
  const known: Record<string, number> = {
    'vite': 5173,
    'next dev': 3000,
    'uvicorn': 8000,
  };
  for (const [k, v] of Object.entries(known)) if (cmd.includes(k)) return v;
  return undefined;
}

export function guessPortFromTexts(texts: Array<string | null>): number | undefined {
  for (const t of texts) {
    if (!t) continue;
    const m =
      t.match(/localhost:(\d{4,5})/i) || t.match(/127\.0\.0\.1:(\d{4,5})/) || t.match(/0\.0\.0\.0:(\d{4,5})/);
    if (m) {
      const n = Number(m[1]);
      if (n >= 80 && n <= 65535) return n;
    }
  }
  return undefined;
}

function readIfExists(p: string): string | null {
  try {
    return readFileSync(p, 'utf8').slice(0, 20_000);
  } catch {
    return null;
  }
}

function readHeadline(root: string): string | undefined {
  try {
    const files = readdirSync(root).filter((f) => /^readme/i.test(f));
    if (!files.length) return undefined;
    const t = readFileSync(join(root, files[0]!), 'utf8').split('\n').slice(0, 30).join('\n');
    const m = t.match(/^#\s+(.+)$/m);
    return m && m[1] ? m[1].trim() : undefined;
  } catch {
    return undefined;
  }
}

function basenameSafe(p: string): string {
  const parts = p.replace(/\/$/, '').split('/');
  return parts[parts.length - 1] || 'project';
}

export function classifyFromStderr(stderr: string, stdout: string): FailureClass {
  const text = `${stderr}\n${stdout}`.toLowerCase();
  if (/eaddrinuse|already in use/.test(text)) return 'PORT_CONFLICT';
  if (/no module named|modulenotfounderror|cannot find module/.test(text)) return 'MISSING_DEPENDENCY';
  if (/command not found/.test(text)) return 'COMMAND_UNKNOWN';
  if (/permission denied/.test(text)) return 'PERMISSION';
  if (/database|postgres/.test(text)) return 'DATABASE_REQUIRED';
  return 'UNKNOWN';
}
