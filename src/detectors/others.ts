import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Detection, CandidateCommand } from '../types.js';
import type { Detector, DetectionContext } from './base.js';
import { relPath } from './base.js';

export class FlutterDetector implements Detector {
  type = 'FlutterDetector';
  detect(ctx: DetectionContext): Detection | null {
    const pubspec = ctx.findFile('pubspec.yaml', 2);
    if (!pubspec) return null;
    let text = '';
    try {
      text = readFileSync(pubspec, 'utf8');
    } catch {
      /* ignore */
    }
    const hasFlutter = /flutter:/.test(text) || existsSync(join(ctx.root, 'lib', 'main.dart'));
    const rel = relPath(ctx, pubspec);
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : undefined;
    const candidates: CandidateCommand[] = [];
    if (hasFlutter) {
      candidates.push({ command: 'flutter run', cwd: dir, role: 'mobile' });
      candidates.push({ command: 'flutter run -d linux', cwd: dir, role: 'desktop' });
    } else {
      candidates.push({ command: 'dart run', cwd: dir, role: 'app' });
    }
    return {
      type: this.type,
      confidence: hasFlutter ? 0.85 : 0.5,
      evidence: [`pubspec.yaml at ${rel}${hasFlutter ? ' (flutter)' : ' (dart)'}`],
      candidates,
      meta: { flutter: hasFlutter },
    };
  }
}

export class AndroidDetector implements Detector {
  type = 'AndroidDetector';
  detect(ctx: DetectionContext): Detection | null {
    const gradlew = ctx.topFiles.includes('gradlew') || existsSync(join(ctx.root, 'gradlew'));
    const gradleKts = ctx.topFiles.includes('build.gradle.kts') || ctx.topFiles.includes('build.gradle');
    if (!gradleKts && !gradlew) return null;
    if (!existsSync(join(ctx.root, 'settings.gradle.kts')) && !existsSync(join(ctx.root, 'settings.gradle'))) {
      return null;
    }
    return {
      type: this.type,
      confidence: 0.75,
      evidence: [
        'Gradle project with settings.gradle(.kts)',
        'Unity/Android-style project requiring a device or emulator',
      ],
      candidates: [
        { command: './gradlew build', role: 'android-build' },
        { command: './gradlew installDebug', role: 'android-install' },
      ],
      meta: { requiresDevice: true, requiresGradle: true },
    };
  }
}

function parsePnpmWorkspaceGlobs(ctx: DetectionContext): string[] {
  if (!ctx.topFiles.includes('pnpm-workspace.yaml')) return [];
  let text: string;
  try {
    text = readFileSync(join(ctx.root, 'pnpm-workspace.yaml'), 'utf8');
  } catch {
    return [];
  }
  const section = text.match(/^packages:\s*\n((?:[ \t]+-[^\n]*\n?)+)/m);
  if (!section || !section[1]) return [];
  return section[1]
    .split('\n')
    .map((line) => line.trim().replace(/^-\s*/, '').replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

export class MonorepoDetector implements Detector {
  type = 'MonorepoDetector';
  detect(ctx: DetectionContext): Detection | null {
    if (!ctx.topFiles.includes('package.json') && !ctx.topFiles.includes('pnpm-workspace.yaml')) return null;
    let pkg: { scripts?: Record<string, string>; workspaces?: string[] | { packages?: string[] } } | null = null;
    if (ctx.topFiles.includes('package.json')) {
      try {
        pkg = JSON.parse(readFileSync(join(ctx.root, 'package.json'), 'utf8'));
      } catch {
        pkg = null;
      }
    }
    const workspaceGlobs = Array.isArray(pkg?.workspaces)
      ? pkg.workspaces
      : pkg?.workspaces?.packages || [...parsePnpmWorkspaceGlobs(ctx)];
    if (!workspaceGlobs.length) return null;
    const rootService = ['dev', 'develop', 'start', 'serve'].find((s) => pkg?.scripts?.[s]);
    if (rootService) {
      return {
        type: this.type,
        confidence: 0.45,
        evidence: [`workspace globs ${workspaceGlobs.join(', ')} with root service script "${rootService}"`],
        candidates: [],
        meta: { monorepo: true, rootService: true },
      };
    }
    return {
      type: this.type,
      confidence: 0.75,
      evidence: [
        `workspace package with no root dev/start/serve script: ${workspaceGlobs.join(', ')}`,
        'Nested example or package commands cannot safely be promoted to the whole-repository startup command.',
      ],
      candidates: [],
      meta: { monorepo: true, rootService: false },
    };
  }
}

export class RustDetector implements Detector {
  type = 'RustDetector';
  detect(ctx: DetectionContext): Detection | null {
    const cargo = ctx.findFile('Cargo.toml', 2);
    if (!cargo) return null;
    let text = '';
    try {
      text = readFileSync(cargo, 'utf8');
    } catch {
      /* ignore */
    }
    const isBin = /\[\[bin\]\]/.test(text) || /src\/main\.rs/.test(text);
    const rel = relPath(ctx, cargo);
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : undefined;
    return {
      type: this.type,
      confidence: isBin ? 0.8 : 0.5,
      evidence: [`Cargo.toml at ${rel}${isBin ? ' with a binary target' : ''}`],
      candidates: isBin ? [{ command: 'cargo run', cwd: dir, role: 'app' }] : [],
      meta: { binary: isBin },
    };
  }
}

export class GoDetector implements Detector {
  type = 'GoDetector';
  detect(ctx: DetectionContext): Detection | null {
    const gomod = ctx.findFile('go.mod', 2);
    if (!gomod) return null;
    const rel = relPath(ctx, gomod);
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : undefined;
    return {
      type: this.type,
      confidence: 0.6,
      evidence: [`go.mod at ${rel}`],
      candidates: [{ command: 'go run .', cwd: dir, role: 'app' }],
    };
  }
}

export class MakeDetector implements Detector {
  type = 'MakeDetector';
  detect(ctx: DetectionContext): Detection | null {
    const makePath = ctx.findFile('Makefile', 1) || ctx.findFile('makefile', 1);
    const taskPath = ctx.findFile('Taskfile.yml', 1) || ctx.findFile('Taskfile.yaml', 1) || ctx.findFile('taskfile.yml', 1);
    if (!makePath && !taskPath) return null;
    const evidence: string[] = [];
    const candidates: CandidateCommand[] = [];
    let confidence = 0.4;

    if (makePath) {
      let text = '';
      try {
        text = readFileSync(makePath, 'utf8');
      } catch {
        /* ignore */
      }
      const targets: string[] = [];
      for (const line of text.split('\n')) {
        const m = line.match(/^([A-Za-z0-9_.-]+):(?!=)/);
        if (m && m[1] && !m[1].startsWith('.')) targets.push(m[1]);
      }
      evidence.push(`Makefile targets: ${targets.slice(0, 12).join(', ') || '(none)'}`);
      for (const t of ['dev', 'run', 'start', 'serve']) {
        if (targets.includes(t)) {
          candidates.push({ command: `make ${t}`, role: 'app' });
          confidence = Math.max(confidence, 0.7);
        }
      }
    }
    if (taskPath) {
      evidence.push(`Taskfile at ${relPath(ctx, taskPath)}`);
      for (const t of ['dev', 'run', 'start']) {
        candidates.push({ command: `task ${t}`, role: 'app' });
        confidence = Math.max(confidence, 0.65);
      }
    }
    return { type: this.type, confidence, evidence, candidates };
  }
}

export class ShellScriptDetector implements Detector {
  type = 'ShellScriptDetector';
  detect(ctx: DetectionContext): Detection | null {
    let scripts: string[];
    try {
      scripts = readdirSync(ctx.root)
        .filter((f) => f.endsWith('.sh'))
        .sort();
    } catch {
      return null;
    }
    if (!scripts.length) return null;
    const startLike = scripts.filter((s) => /^(start|dev|run|setup|launch)/i.test(s));
    const candidates: CandidateCommand[] = [];
    for (const s of startLike) candidates.push({ command: `./${s}`, role: 'app' });
    const evidence = [`shell scripts: ${scripts.join(', ')}`];
    if (startLike.length) evidence.push(`start-like scripts: ${startLike.join(', ')}`);
    return {
      type: this.type,
      confidence: startLike.length ? 0.6 : 0.35,
      evidence,
      candidates,
      meta: { scripts, startLike },
    };
  }
}

export class GenericWebDetector implements Detector {
  type = 'GenericWebDetector';
  detect(ctx: DetectionContext): Detection | null {
    const hasIndex = ctx.topFiles.includes('index.html') || ctx.shallowFiles.includes('index.html');
    if (!hasIndex) return null;
    const hasPkg = ctx.topFiles.includes('package.json');
    if (hasPkg) return null; // Node detector owns this
    const dir = ctx.shallowFiles.includes('index.html') ? undefined : undefined;
    return {
      type: this.type,
      confidence: 0.5,
      evidence: ['static index.html with no package.json'],
      candidates: [
        { command: 'python3 -m http.server 8000', cwd: dir, role: 'web' },
      ],
    };
  }
}

export class EnvFileDetector implements Detector {
  type = 'EnvFileDetector';
  detect(ctx: DetectionContext): Detection | null {
    const envs = ctx.topFiles.filter((f) => /^\.env($|\.)/.test(f));
    if (!envs.length) return null;
    return {
      type: this.type,
      confidence: 0.4,
      evidence: [`env files present: ${envs.join(', ')}`],
      candidates: [],
      meta: { envFiles: envs },
    };
  }
}

export class UnsafeProjectDetector implements Detector {
  type = 'UnsafeProjectDetector';

  detect(ctx: DetectionContext): Detection | null {
    const signals: string[] = [];
    // Huge monorepos are effectively undeployable by a single auto-run command.
    const manifestCount = ctx.shallowFiles.filter((f) =>
      ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pubspec.yaml'].some((m) => f.endsWith(m)),
    ).length;
    if (manifestCount >= 8) {
      signals.push(`large monorepo: ${manifestCount} manifests at shallow depth`);
    }
    const compose =
      ctx.findFile('docker-compose.yml', 1) || ctx.findFile('compose.yml', 1) || ctx.findFile('docker-compose.yaml', 1) || ctx.findFile('compose.yaml', 1);
    if (compose) {
      let text = '';
      try {
        text = readFileSync(compose, 'utf8').toLowerCase();
      } catch {
        /* ignore */
      }
      if (/privileged:\s*true/.test(text)) signals.push('compose uses privileged containers');
      if (/network_mode:\s*host/.test(text)) signals.push('compose uses host networking');
      if (/\/var\/run\/docker\.sock/.test(text)) signals.push('compose mounts the Docker socket');
    }
    if (ctx.readFirst && ctx.findFile('Dockerfile', 1)) {
      const t = ctx.readFirst(ctx.findFile('Dockerfile', 1)!) || '';
      if (/--privileged|ENTRYPOINT.*deploy/i.test(t)) signals.push('Dockerfile appears privileged');
    }
    const dangerous = ctx.topFiles.filter((f) => /^(deploy|destroy|terraform|ansible|helm)/i.test(f) || /\.tf$/.test(f));
    for (const d of dangerous) signals.push(`deployment-like file: ${d}`);
    if (dirHas(ctx, 'deploy') || dirHas(ctx, 'terraform') || dirHas(ctx, 'k8s')) {
      signals.push('deployment directory present');
    }
    // Explicitly vulnerable test targets must require human approval even when local-only.
    for (const entry of ['serve.py', 'server.py', 'app.py', 'main.py']) {
      const entryPath = ctx.findFile(entry, 2);
      if (!entryPath) continue;
      const text = (ctx.readFirst(entryPath, 4000) || '').toLowerCase();
      if (text.includes('intentionally vulnerable') && text.includes('local')) {
        signals.push(`${relPath(ctx, entryPath)} is explicitly marked as an intentionally vulnerable local target`);
        break;
      }
    }
    if (ctx.readFirst) {
      // README: only strong, actionable signals, not mere mentions of "production".
      const readme = ctx.topFiles.find((f) => /^readme/i.test(f));
      if (readme) {
        const t = (ctx.readFirst(join(ctx.root, readme), 8000) || '').toLowerCase();
        if (/terraform (apply|destroy)|kubectl apply|helm (install|upgrade)|aws (ecs|eks|s3) (deploy|sync)/.test(t)) {
          signals.push('README describes infrastructure deployment commands');
        }
        if (/(drop database|delete.*data|destructive|irreversible)/.test(t)) {
          signals.push('README warns about destructive data operations');
        }
        if (/(private key|seed phrase|wallet.*key|mainnet)/.test(t)) {
          signals.push('README references secrets/wallet keys or mainnet');
        }
      }
    }
    if (!signals.length) return null;
    return {
      type: this.type,
      confidence: 0.7,
      evidence: signals,
      candidates: [],
      meta: { unsafe: true, reasons: signals },
    };
  }
}

function dirHas(ctx: DetectionContext, name: string): boolean {
  return ctx.topDirs.includes(name) || existsSync(join(ctx.root, name));
}
