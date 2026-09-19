import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Project, RuntimeProjectState } from './types.js';
import { listProjects, loadProject, saveProject, removeProject, slugify } from './config.js';
import { discover } from './discovery.js';
import { configPath } from './config.js';
import { providerFromEnv, validateProposal } from './ai.js';
import { runDetectors } from './detectors/index.js';
import { configDir, ensureDirs, launcherHome, logDir, stateDir } from './paths.js';
import { readState, listStates, isProcessAlive, readLease, removeLease } from './state.js';
import { startLearnSession as _sls, readLearnSession as _rls, finishLearnSession as _fls } from './learn.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
}

export const defaultIO: CliIO = {
  out: (t) => process.stdout.write(t + '\n'),
  err: (t) => process.stderr.write(t + '\n'),
};

function json(o: unknown): string {
  return JSON.stringify(o, null, 2);
}

export async function main(argv: string[], io: CliIO = defaultIO): Promise<number> {
  ensureDirs();
  const [cmd, ...rest] = argv;
  const opts = parseFlags(rest);
  const positional = opts._;

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      io.out(helpText());
      return 0;
    case 'scan':
      return cmdScan(positional[0] || process.cwd(), opts, io);
    case 'discover':
      return await cmdDiscover(positional[0], opts, io);
    case 'projects':
    case 'list':
      return cmdProjects(opts, io);
    case 'add':
      return cmdAdd(positional[0], opts, io);
    case 'remove':
    case 'rm':
      return cmdRemove(positional[0], opts, io);
    case 'show':
    case 'config':
      return cmdShow(positional[0], opts, io);
    case 'start':
      return await cmdStart(positional[0], opts, io);
    case 'stop':
      return await cmdStop(positional[0], opts, io);
    case 'restart':
      return await cmdRestart(positional[0], opts, io);
    case 'status':
      return cmdStatus(positional[0], opts, io);
    case 'logs':
      return cmdLogs(positional[0], opts, io);
    case 'open':
      return cmdOpen(positional[0], opts, io);
    case 'action':
      return await cmdAction(positional[0], positional[1], opts, io);
    case 'learn':
      return cmdLearn(positional[0], opts, io);
    case 'ai-propose':
      return await cmdAiPropose(positional[0], opts, io);
    case 'doctor':
      return cmdDoctor(opts, io);
    case 'serve':
      return cmdServe(opts, io);
    case 'ui':
      return cmdUi(opts, io);
    default:
      io.err(`Unknown command: ${cmd}\n`);
      io.err(helpText());
      return 2;
  }
}

interface Flags {
  json: boolean;
  force: boolean;
  finish: boolean;
  yes: boolean;
  profile?: string;
  service?: string;
  services?: string[];
  allowUnsafe: boolean;
  follow: boolean;
  _: string[];
}

function parseFlags(args: string[]): Flags {
  const flags: Flags = { json: false, force: false, finish: false, yes: false, allowUnsafe: false, follow: false, _: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--json':
        flags.json = true;
        break;
      case '--force':
        flags.force = true;
        break;
      case '--finish':
        flags.finish = true;
        break;
      case '--yes':
      case '-y':
        flags.yes = true;
        break;
      case '--allow-unsafe':
        flags.allowUnsafe = true;
        break;
      case '--follow':
      case '-f':
        flags.follow = true;
        break;
      case '--profile':
        flags.profile = args[++i];
        break;
      case '--service':
        flags.service = args[++i];
        break;
      case '--services':
        flags.services = (args[++i] || '').split(',').filter(Boolean);
        break;
      default:
        flags._.push(a);
    }
  }
  return flags;
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

function cmdScan(root: string, opts: Flags, io: CliIO): number {
  if (!existsSync(root)) {
    io.err(`Path not found: ${root}`);
    return 1;
  }
  const entries = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const results: unknown[] = [];
  for (const e of entries) {
    const p = join(root, e.name);
    const { detections } = runDetectors(p);
    const meaningful = detections.filter((d) => d.confidence > 0 && d.type !== 'EnvFileDetector');
    results.push({
      name: e.name,
      path: p,
      detectors: meaningful.map((d) => ({
        type: d.type,
        confidence: d.confidence,
        candidates: d.candidates.map((c) => c.command),
      })),
    });
  }
  if (opts.json) {
    io.out(json(results));
  } else {
    io.out(`Scanned ${root}: ${results.length} directories\n`);
    for (const r of results as Array<{ name: string; detectors: Array<{ type: string; confidence: number; candidates: string[] }> }>) {
      const types = r.detectors.map((d) => `${d.type.replace('Detector', '')}(${d.confidence.toFixed(2)})`).join(' ');
      io.out(`${r.name.padEnd(24)} ${types || '(nothing detected)'}`);
      const cmds = r.detectors.flatMap((d) => d.candidates);
      for (const c of cmds.slice(0, 3)) io.out(`    $ ${c}`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// discover
// ---------------------------------------------------------------------------

async function cmdDiscover(path: string | undefined, opts: Flags, io: CliIO): Promise<number> {
  if (!path) {
    io.err('Usage: launcher discover <path>');
    return 2;
  }
  const root = resolve(path);
  if (!existsSync(root)) {
    io.err(`Path not found: ${root}`);
    return 1;
  }
  const outcome = discover(root, root.split('/').pop());

  if (opts.json) {
    io.out(json({
      project: outcome.project,
      confidence: outcome.confidence,
      warnings: outcome.warnings,
      ambiguous: outcome.ambiguous,
      detections: outcome.detections.map((d) => ({ type: d.type, confidence: d.confidence, evidence: d.evidence, candidates: d.candidates })),
    }));
    if (opts.yes || opts.force) {
      saveProject(outcome.project);
      io.err(`Saved ${configPath(outcome.project.id)}`);
    }
    return 0;
  }

  io.out(`Project: ${outcome.project.name}`);
  io.out(`Root:    ${root}`);
  io.out(`Confidence: ${outcome.confidence.toFixed(2)} (${confidenceLabel(outcome.confidence)})`);
  if (outcome.project.metadata?.unsafe) io.out(`\n!! UNSAFE TO AUTO-RUN: ${outcome.project.metadata.unsafeReason}`);
  io.out('');
  io.out('Detections:');
  for (const d of outcome.detections) {
    if (d.confidence === 0 && !d.evidence.length) continue;
    io.out(`  - ${d.type} [${d.confidence.toFixed(2)}]`);
    for (const e of d.evidence.slice(0, 4)) io.out(`      ${e}`);
  }
  io.out('');
  io.out('Proposed services:');
  if (!outcome.project.services.length) io.out('  (none)');
  for (const s of outcome.project.services) {
    io.out(`  ${s.id}: ${s.command}${s.cwd ? `  (cwd: ${s.cwd})` : ''}${s.port ? `  port ${s.port}` : ''}`);
    if (s.dependsOn?.length) io.out(`      depends_on: ${s.dependsOn.join(', ')}`);
  }
  if (outcome.ambiguous.length) {
    io.out('\nAmbiguous alternate commands:');
    for (const a of outcome.ambiguous) io.out(`  ${a.role || '?'}: ${a.command}${a.cwd ? ` (cwd: ${a.cwd})` : ''}`);
  }
  if (outcome.warnings.length) {
    io.out('\nWarnings:');
    for (const w of outcome.warnings) io.out(`  ! ${w}`);
  }

  if (opts.yes || opts.force) {
    saveProject(outcome.project);
    io.out(`\nSaved configuration to ${configPath(outcome.project.id)}`);
  } else {
    io.out('\nDry run. Re-run with --yes to save the configuration.');
  }
  return 0;
}

function confidenceLabel(c: number): string {
  if (c >= 0.95) return 'highly confident';
  if (c >= 0.8) return 'probably correct';
  if (c >= 0.5) return 'ambiguous';
  if (c > 0) return 'unknown';
  return 'nothing detected';
}

// ---------------------------------------------------------------------------
// projects / add / remove / show
// ---------------------------------------------------------------------------

function cmdProjects(opts: Flags, io: CliIO): number {
  const projects = listProjects();
  const states = listStates();
  const stateById = new Map(states.map((s) => [s.projectId, s]));
  if (opts.json) {
    io.out(json(projects.map((p) => ({ ...p, runtime: stateById.get(p.id) || null }))));
    return 0;
  }
  if (!projects.length) {
    io.out(`No projects configured. Config dir: ${configDir()}`);
    io.out('Run: launcher discover <path> --yes');
    return 0;
  }
  for (const p of projects) {
    const st = stateById.get(p.id);
    const dot = aggregateDot(st);
    io.out(`${dot} ${p.name}  (${p.id})`);
    io.out(`    root: ${p.root}`);
    io.out(`    services: ${p.services.map((s) => s.id).join(', ') || '(none)'}`);
    if (p.metadata?.unsafe) io.out(`    !! ${p.metadata.unsafeReason}`);
  }
  return 0;
}

function aggregateDot(st: RuntimeProjectState | undefined): string {
  if (!st) return '⚫';
  const statuses = Object.values(st.services).map((s) => s.status);
  if (!statuses.length) return '⚫';
  if (statuses.some((s) => s === 'crashed' || s === 'failed')) return '🔴';
  if (statuses.some((s) => s === 'healthy' || s === 'running')) return '🟢';
  return '⚫';
}

function cmdAdd(path: string | undefined, opts: Flags, io: CliIO): number {
  if (!path) {
    io.err('Usage: launcher add <path> [--yes]');
    return 2;
  }
  return cmdScanAdd(path, opts, io);
}

function cmdScanAdd(path: string, opts: Flags, io: CliIO): number {
  const root = resolve(path);
  if (!existsSync(root)) {
    io.err(`Path not found: ${root}`);
    return 1;
  }
  const outcome = discover(root, root.split('/').pop());
  saveProject(outcome.project);
  if (opts.json) io.out(json({ saved: configPath(outcome.project.id), project: outcome.project }));
  else io.out(`Saved ${outcome.project.name} -> ${configPath(outcome.project.id)} (confidence ${outcome.confidence.toFixed(2)})`);
  return 0;
}

function cmdRemove(id: string | undefined, opts: Flags, io: CliIO): number {
  if (!id) {
    io.err('Usage: launcher remove <project>');
    return 2;
  }
  const ok = removeProject(id);
  if (opts.json) io.out(json({ removed: ok, id }));
  else io.out(ok ? `Removed ${id}` : `Not found: ${id}`);
  return ok ? 0 : 1;
}

function cmdShow(id: string | undefined, opts: Flags, io: CliIO): number {
  const project = requireProject(id, io, opts);
  if (!project) return 1;
  if (opts.json) {
    io.out(json(project));
    return 0;
  }
  io.out(readFileSync(configPath(project.id), 'utf8'));
  return 0;
}

function requireProject(id: string | undefined, io: CliIO, _opts: Flags): Project | null {
  if (!id) {
    io.err('Missing project id');
    return null;
  }
  try {
    const p = loadProject(id);
    if (!p) io.err(`No configured project "${id}". Run "launcher projects".`);
    return p;
  } catch (err) {
    io.err(`Failed to read configuration for "${id}": ${(err as Error).message}`);
    io.err(`File: ${configPath(id)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// start / stop / restart  (process ownership is persisted so stop can reclaim)
// ---------------------------------------------------------------------------

async function cmdStart(id: string | undefined, opts: Flags, io: CliIO): Promise<number> {
  const project = requireProject(id, io, opts);
  if (!project) return 1;
  const { ProjectManager } = await import('./manager.js');
  const mgr = new ProjectManager(project);

  if (opts.json) {
    const result = await mgr.start({ profile: opts.profile, services: opts.services, allowUnsafe: opts.allowUnsafe, waitHealthy: true });
    io.out(json(result));
    return result.failed.length ? 1 : 0;
  }

  mgr.on('log', (line) => io.out(`[${line.id}] ${line.line}`));
  mgr.on('state', () => {});
  io.out(`Starting ${project.name}${opts.profile ? ` (profile: ${opts.profile})` : ''}...`);
  const result = await mgr.start({ profile: opts.profile, services: opts.services, allowUnsafe: opts.allowUnsafe, waitHealthy: true });
  io.out('');
  for (const s of result.started) io.out(`  ✓ ${s}`);
  for (const f of result.failed) io.out(`  ✗ ${f.id} [${f.failureClass}] ${f.detail}`);
  for (const e of result.errors) io.out(`  ! ${e.message}`);
  io.out(`\nState dir: ${stateDir()}`);
  io.out(`Logs:      ${logDir()}/${project.id}`);
  return result.failed.length ? 1 : 0;
}

async function cmdStop(id: string | undefined, opts: Flags, io: CliIO): Promise<number> {
  const project = requireProject(id, io, opts);
  if (!project) return 1;
  const selected = opts.services?.length ? opts.services : opts.service ? [opts.service] : undefined;
  const { ProjectManager } = await import('./manager.js');
  const mgr = new ProjectManager(project);
  // Reclaim state from a previous run
  await mgr.reconcileOnAttach();
  if (opts.json) {
    const result = await mgr.stop(selected);
    io.out(json(result));
    return 0;
  }
  io.out(`Stopping ${project.name}${selected ? ` (services: ${selected.join(', ')})` : ''}...`);
  const result = await mgr.stop(selected);
  for (const s of result.stopped) io.out(`  ✓ stopped ${s}`);
  for (const f of result.failures) io.out(`  ✗ ${f}`);
  return 0;
}

async function cmdRestart(id: string | undefined, opts: Flags, io: CliIO): Promise<number> {
  const stopCode = await cmdStop(id, { ...opts, json: false }, io);
  if (stopCode !== 0) return stopCode;
  await sleep(500);
  return cmdStart(id, { ...opts, json: false }, io);
}

// ---------------------------------------------------------------------------
// status / logs / open
// ---------------------------------------------------------------------------

function cmdStatus(id: string | undefined, opts: Flags, io: CliIO): number {
  if (!id) {
    const all = listProjects().map((p) => ({ project: p, runtime: readState(p.id) }));
    if (opts.json) {
      io.out(json(all));
    } else {
      for (const { project, runtime } of all) {
        io.out(`${aggregateDot(runtime || undefined)} ${project.name}`);
        if (runtime) for (const s of Object.values(runtime.services)) {
          io.out(`    ${statusDot(s.status)} ${s.id}: ${s.status}${s.pid ? ` pid=${s.pid}` : ''}${s.health?.detail ? ` (${s.health.detail})` : ''}`);
        }
      }
    }
    return 0;
  }
  const project = requireProject(id, io, opts);
  if (!project) return 1;
  const runtime = readState(project.id);
  if (opts.json) {
    io.out(json({ project, runtime }));
    return 0;
  }
  io.out(`${project.name} (${project.id})`);
  if (!runtime) {
    io.out('  no runtime state (never started)');
    return 0;
  }
  for (const s of Object.values(runtime.services)) {
    const alive = s.pid && isProcessAlive(s.pid);
    io.out(`  ${statusDot(s.status)} ${s.id}: ${s.status}${s.pid ? ` pid=${s.pid}${alive ? '' : ' (dead)'}` : ''}${s.health?.detail ? ` — ${s.health.detail}` : ''}`);
  }
  return 0;
}

function statusDot(status: string): string {
  switch (status) {
    case 'healthy':
    case 'running':
      return '🟢';
    case 'starting':
    case 'stopping':
      return '🟡';
    case 'crashed':
    case 'failed':
    case 'unhealthy':
      return '🔴';
    default:
      return '⚫';
  }
}

function cmdLogs(id: string | undefined, opts: Flags, io: CliIO): number {
  const project = requireProject(id, io, opts);
  if (!project) return 1;
  const dir = `${logDir()}/${project.id}`;
  if (!existsSync(dir)) {
    if (opts.json) io.out(json({ files: [] }));
    else io.out('No logs yet.');
    return 0;
  }
  const files = readdirSync(dir)
    .filter((f) => (opts.service ? f.startsWith(`${opts.service}-`) : true))
    .sort();
  if (opts.json) {
    io.out(json({ dir, files }));
    return 0;
  }
  for (const f of files) {
    io.out(`\n== ${f} ==`);
    const content = readFileSync(join(dir, f), 'utf8');
    const lines = content.split('\n');
    io.out(lines.slice(-200).join('\n'));
  }
  return 0;
}

function cmdOpen(id: string | undefined, opts: Flags, io: CliIO): number {
  const project = requireProject(id, io, opts);
  if (!project) return 1;
  const urls: string[] = [];
  for (const s of project.services) {
    if (s.port) urls.push(`http://localhost:${s.port}`);
    const m = s.command.match(/localhost:(\d+)/);
    if (m) urls.push(`http://localhost:${m[1]}`);
  }
  const url = urls[0];
  if (opts.json) {
    io.out(json({ project: project.id, urls }));
    return 0;
  }
  if (!url) {
    io.err(`No port detected for ${project.name}. Configure a service port or health check.`);
    return 1;
  }
  io.out(`Detected URLs: ${urls.join(', ')}`);
  io.out(`Open in browser: ${url}`);
  return 0;
}

// ---------------------------------------------------------------------------
// action
// ---------------------------------------------------------------------------

async function cmdAction(id: string | undefined, actionName: string | undefined, opts: Flags, io: CliIO): Promise<number> {
  const project = requireProject(id, io, opts);
  if (!project) return 1;
  if (!actionName) {
    const names = Object.keys(project.actions || {});
    if (opts.json) io.out(json({ actions: names }));
    else io.out(`Actions for ${project.name}: ${names.join(', ') || '(none)'}`);
    return 0;
  }
  const action = project.actions?.[actionName];
  if (!action) {
    io.err(`No action "${actionName}" for ${project.name}. Available: ${Object.keys(project.actions || {}).join(', ') || '(none)'}`);
    return 1;
  }
  const { SupervisedProcess } = await import('./supervisor.js');
  const cwd = action.cwd ? join(project.root, action.cwd) : project.root;
  io.out(`Running action "${actionName}": ${action.command}`);
  const proc = new SupervisedProcess({ id: `${project.id}-${actionName}`, command: action.command, cwd, env: action.environment });
  proc.on('log', (l) => io.out(`[${actionName}] ${l.line}`));
  const code = await new Promise<number>((resolve) => {
    proc.on('exit', (info) => resolve(info.code ?? 1));
    proc.start();
  });
  io.out(`Action "${actionName}" exited with code ${code}`);
  return code;
}

// ---------------------------------------------------------------------------
// learn
// ---------------------------------------------------------------------------

function cmdLearn(path: string | undefined, opts: Flags, io: CliIO): number {
  if (!path) {
    io.err('Usage: launcher learn <path>   (start)  |  launcher learn <path> --finish');
    return 2;
  }
  const root = resolve(path);
  const id = slugify(root.split('/').pop() || 'project');
  const { startLearnSession, readLearnSession, finishLearnSession } = requireLearnStatic();

  if (opts.finish || opts.force) {
    const session = readLearnSession(id);
    if (!session) {
      io.err(`No learn session for ${id}. Run "launcher learn ${root}" first.`);
      return 1;
    }
    const result = finishLearnSession(session, root.split('/').pop() || id);
    io.out('Observed startup sequence:');
    result.steps.forEach((s, i) => io.out(`  ${i + 1}. ${s.cwd ? `cd ${s.cwd} && ` : ''}${s.command}`));
    if (!result.steps.length) io.out('  (no new processes observed under the project root)');
    saveProject(result.project);
    io.out(`\nSaved learned configuration -> ${configPath(result.project.id)}`);
    io.out('Review it with "launcher show ' + result.project.id + '" before starting.');
    return 0;
  }

  const session = startLearnSession(root, id);
  io.out(`Learning session started for ${root} (${session.baseline.length} baseline processes).`);
  io.out('Now perform your normal startup commands in another terminal.');
  io.out(`When done, run: launcher learn ${root} --finish`);
  return 0;
}

// ---------------------------------------------------------------------------
// ai-propose
// ---------------------------------------------------------------------------

async function cmdAiPropose(path: string | undefined, opts: Flags, io: CliIO): Promise<number> {
  if (!path) {
    io.err('Usage: launcher ai-propose <path>  (requires LAUNCHER_AI_BASE_URL + LAUNCHER_AI_MODEL)');
    return 2;
  }
  const root = resolve(path);
  const outcome = discover(root, root.split('/').pop());
  const provider = providerFromEnv();
  if (provider.id === 'null') {
    io.err('No AI provider configured. Set LAUNCHER_AI_BASE_URL and LAUNCHER_AI_MODEL.');
    return 1;
  }
  const proposal = await provider.analyzeProject(outcome.evidence);
  const validation = validateProposal(proposal);
  if (opts.json) {
    io.out(json({ proposal, validation }));
  } else {
    io.out(`AI proposal for ${proposal.project.name} (confidence ${proposal.confidence}):`);
    for (const s of proposal.project.services) io.out(`  ${s.id}: ${s.command}${s.cwd ? ` (cwd: ${s.cwd})` : ''}`);
    io.out(`Rationale: ${proposal.rationale}`);
    if (proposal.warnings.length) io.out(`Warnings: ${proposal.warnings.join('; ')}`);
    io.out(`Validation: ${validation.ok ? 'PASS' : 'FAIL'} ${validation.errors.join('; ')}`);
  }
  return validation.ok ? 0 : 1;
}

// ---------------------------------------------------------------------------
// doctor / serve / ui
// ---------------------------------------------------------------------------

function cmdDoctor(opts: Flags, io: CliIO): number {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: nodeMajor >= 20, detail: process.versions.node });
  checks.push({ name: 'bash', ok: existsSync('/bin/bash'), detail: '/bin/bash' });
  checks.push({ name: 'config-dir', ok: existsSync(configDir()) || mkdirp(configDir()), detail: configDir() });
  checks.push({ name: 'state-dir', ok: existsSync(stateDir()) || mkdirp(stateDir()), detail: stateDir() });
  checks.push({ name: 'log-dir', ok: existsSync(logDir()) || mkdirp(logDir()), detail: logDir() });
  checks.push({ name: 'codex-cli', ok: which('codex'), detail: 'optional' });

  // detect orphaned leases
  const orphaned: string[] = [];
  for (const p of listProjects()) {
    const lease = readLease(p.id);
    if (lease && !isProcessAlive(lease.supervisorPid)) {
      orphaned.push(p.id);
      removeLease(p.id);
    }
  }
  checks.push({ name: 'orphaned-leases', ok: true, detail: orphaned.length ? `cleaned: ${orphaned.join(', ')}` : 'none' });

  if (opts.json) {
    io.out(json(checks));
  } else {
    for (const c of checks) io.out(`${c.ok ? '✓' : '✗'} ${c.name}: ${c.detail}`);
  }
  return checks.every((c) => c.ok) ? 0 : 1;
}

function mkdirp(p: string): boolean {
  try {
    mkdirSync(p, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function which(bin: string): boolean {
  const paths = (process.env.PATH || '').split(':');
  return paths.some((p) => existsSync(join(p, bin)));
}

function cmdServe(_opts: Flags, io: CliIO): number {
  io.out('Starting launcher HTTP server...');
  import('./server.js').then((m) => m.startServer()).catch((err) => io.err(String(err)));
  return 0;
}

function cmdUi(_opts: Flags, io: CliIO): number {
  io.out('Starting desktop UI (Electron-free, local web UI)...');
  import('./ui.js').then((m) => m.startDesktop()).catch((err) => io.err(String(err)));
  return 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function helpText(): string {
  return `project-launcher

Usage: launcher <command> [options]

Discovery
  scan [dir]                 Lightweight detector scan of a directory (default: cwd)
  discover <path> [--yes]    Show a deterministic discovery proposal; --yes saves it
  add <path>                 Discover and save a project configuration
  ai-propose <path>          OPTIONAL: ask a configured AI provider for a proposal (validated)

Projects
  projects [--json]          List configured projects and their runtime state
  show <project>             Print the YAML config for a project
  remove <project>           Delete a project configuration

Lifecycle
  start <project> [--profile NAME] [--services a,b] [--allow-unsafe] [--json]
  stop <project> [--service NAME] [--json]
  restart <project> [--json]
  status [project] [--json]
  logs <project> [--service NAME] [--json]
  open <project> [--json]
  action <project> <name>

Advanced
  learn <path>               Start an opt-in learning session
  learn <path> --finish      Finish the session and propose a learned config
  doctor [--json]            Verify the environment and clean orphaned leases
  serve                      Start the local HTTP API for the desktop UI
  ui                         Start the desktop launcher UI

All commands accept --json.
Config: ${launcherHome()}
`;
}

// static import of learn to satisfy requireLearnStatic
function requireLearnStatic(): Pick<typeof import('./learn.js'), 'startLearnSession' | 'readLearnSession' | 'finishLearnSession'> {
  return { startLearnSession: _sls, readLearnSession: _rls, finishLearnSession: _fls };
}