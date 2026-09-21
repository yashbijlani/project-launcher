# V2 Implementation Report

Project Launcher V2 upgrades the existing prototype with verified configurations,
reliable process ownership, a single safety gate, and a daily-use dashboard. It does
not rewrite V1; all V1 detectors, discovery, supervision, health checks, profiles,
actions, logs, CLI, server, hotkey integration, AI adapter, and learn mode remain.

Version: 0.2.0

## What changed and why

### 1. Verification is now a first-class concept

V1 had discovery confidence but no proof that a configuration actually works.
V2 adds an explicit verification model (`src/verify.ts`, `src/fingerprint.ts`).

- `launcher verify <project>` runs: structural validation -> path validation ->
  prerequisite inspection -> ownership acquisition -> start in dependency order ->
  health checks -> port usability -> stop in reverse order -> cleanup confirmation ->
  evidence write -> lock release.
- A project only becomes `verified` after real start/health/stop/cleanup evidence.
- Evidence is stored in the project YAML under `verification:` with status,
  timestamp, launcher version, config fingerprint, environment versions, per-service
  evidence, and dependency order.
- A configuration fingerprint (sha256 over id, root, services, profiles, actions)
  ties verification to the exact configuration. Editing a command, cwd, dependency,
  health check, environment, port, restart policy, runtime, profile, or action
  invalidates it: `verified -> unverified`.
- Verification is never inferred from a spawned process. If health fails, cleanup
  fails, prerequisites are missing, or the project is unsafe without approval, the
  record is `failed` or `blocked`, never `verified`.

### 2. Single authoritative safety gate

V1 allowed the HTTP server to call `start` with `allowUnsafe: true`, bypassing the
unsafe-project protection. V2 removes that.

- `src/safety.ts` exposes `assertSafeToOperate`, used by both `ProjectManager.start`
  and `verifyProject`.
- Unsafe projects require either the CLI flag `--allow-unsafe` or a well-formed
  `unsafeApproval { projectId, reason }` with a reason of at least 8 characters.
- The HTTP server rejects a bare `allowUnsafe` boolean as ambiguous and rejects
  malformed approvals with HTTP 403. The server never authorizes unsafe projects by
  itself; the browser must send an explicit approval with a typed reason.
- The same gate enforces structural validity, dependency references, cycles, runtime
  kinds, and cwd containment for CLI, API, verification, and AI import.

### 3. Real project ownership / locking

V1 leases were informational and could not prevent two launchers from starting the
same project. V2 adds an atomic per-project lock (`src/lock.ts`).

- Locks live in `~/.local/share/project-launcher/locks/<project>.lock`.
- Acquisition uses `open(..., 'wx')` (O_EXCL) for atomicity.
- A lock records owner PID, owner start-time ticks, launcher instance UUID,
  operation, creation time, and heartbeat.
- Ownership is considered live only when the owner PID exists, its kernel start time
  matches (detecting PID reuse), and the heartbeat is fresh.
- Stale locks (dead owner, reused PID, or expired heartbeat) are quarantined and
  acquisition is retried once.
- Nested operations within one process are re-entrant (verify -> start -> stop)
  via an in-process depth counter; cross-process mutual exclusion is unchanged.
- Starting a project that is already owned returns a clear busy message instead of
  launching a duplicate service tree.

### 4. Process identity, not just PIDs

V1 trusted persisted PIDs. V2 adds `src/proc.ts`.

- Identity is read from `/proc/<pid>/stat`: PID, process group, kernel start time
  (field 22), comm, and a command fingerprint.
- The authoritative match is PID + kernel start time. This is stable across `exec`
  (bash -lc commonly execs its command, changing comm/exe) and changes when a PID is
  reused.
- `reconcileWithIdentity` runs before start, stop, restart, status, and verify.
  - identity matches -> keep live state
  - PID alive but identity differs -> stale; clear without signaling
  - PID gone -> crashed
- Stop refuses to signal a process whose identity does not match, so a reused PID
  can never cause the launcher to kill an unrelated process.

### 5. Hardened cwd/path handling

- `resolveInsideRoot` resolves every service and action cwd against the project root
  and rejects traversal outside it (`../../etc`, absolute external paths).
- The rule is centralized in `src/safety.ts` and applied to start, verify, the API,
  and AI proposals, so hand-written YAML is not trusted either.

### 6. Provenance and `launcher explain`

- Services now carry `provenance { source, detector, confidence, evidence }`.
- `launcher explain <project>` shows command, cwd, runtime, dependencies, provenance,
  evidence, readiness, and verification status.
- The dashboard exposes the same via `/api/projects/:id/explain`.

### 7. Readiness model and `launcher doctor <project>`

- `src/prereqs.ts` inspects, without installing anything: Node/npm/pnpm/yarn/bun on
  PATH, package.json scripts and `node_modules`, Python interpreters and modules,
  shell scripts, `.env` vs `.env.example` credential gaps, and Docker daemon
  availability.
- Readiness categories: `ready`, `ready_but_unverified`, `needs_environment`,
  `needs_docker`, `needs_device`, `needs_credentials`, `ambiguous`, `unsafe`,
  `unknown`, `broken`, each with structured blockers and suggestions.
- `launcher doctor` (global) checks the environment; `launcher doctor <project>`
  reports per-project readiness and never installs dependencies.

### 8. Docker, hybrid runtimes, monorepo targets, framework health

- `src/docker.ts` prefers `docker compose config --format json` as the authoritative
  model and falls back to the built-in parser when the Docker CLI is unavailable.
- Services carry a `runtime` kind: `process`, `compose`, `container`, `device`,
  `external`. Hybrid graphs (Compose infra + local apps) are expressed in one graph.
- `device`/`external` services are never spawned as plain processes.
- Monorepo discovery now expands workspace globs (`apps/*`, `packages/*`, pnpm
  workspaces) and exposes runnable targets via `launcher targets` and
  `launcher add --target <key>`. Nested examples are not promoted to repository-wide
  commands automatically.
- FastAPI health checks now suggest `/docs` instead of assuming `/` returns 200.

### 9. Crash/restart safeguards

- Restart policies (`never`, `on-failure`, `always`) now have a sliding 60s crash
  window, a maximum attempt count (`restartMaxAttempts`, default 5), exponential
  backoff (`restartBackoffMs`, default 1000ms), and a clear "restart loop suppressed"
  message. A suppressed loop ends in `failed`, not an endless respawn.

### 10. Live events and daily-use dashboard

- The server publishes events over Server-Sent Events at `/api/events`:
  `project.started`, `service.starting`, `service.started`, `service.healthy`,
  `service.failed`, `service.unhealthy`, `service.exited`, `project.stopped`,
  `verification.completed`, and more.
- The dashboard shows readiness, verification (current/stale), per-service health,
  blockers, and actions. Keyboard-first: `j/k` navigate, `Enter` toggles,
  `S` start, `X` stop, `R` restart, `L` logs, `D` details, `V` verify.
- Unsafe start from the UI opens a confirmation that requires a typed reason, which
  is sent as `unsafeApproval` and enforced by the backend.
- CLI logs gained `--follow` and `--clear`; `status` shows verification and readiness.

## Architecture

New modules:

```text
src/safety.ts       single safety gate, structural + path validation
src/fingerprint.ts  stable config fingerprint + verification currency
src/lock.ts         atomic per-project ownership lock + heartbeat + re-entrancy
src/proc.ts         /proc process identity + PID-reuse detection
src/prereqs.ts      read-only prerequisite inspection + readiness
src/verify.ts       deterministic verification workflow
src/docker.ts       docker compose config --format json + fallback
```

Changed modules:

```text
src/types.ts        verification, provenance, runtime, process identity, readiness
src/config.ts       YAML round-trip for verification, provenance, restart options
src/manager.ts      safety gate, locking, identity reconcile, restart safeguards
src/discovery.ts    provenance, targets, runtime kinds, framework health
src/detectors/node.ts  multi-package + workspace glob expansion
src/ai.ts           layered proposal validation (structure/paths/evidence/security)
src/server.ts       unsafe enforcement, verify/doctor/explain endpoints, SSE, dashboard
src/cli.ts          verify, explain, targets, doctor <project>, add --target, logs
```

## Important tradeoffs

- **Stateless CLI retained.** There is still no daemon that owns processes. The CLI
  starts detached process groups and persists identity + state, so a later CLI can
  stop them. Live events exist only while the server is running. This keeps the CLI
  usable without a daemon.
- **Process groups, not cgroups.** A launcher-owned cgroup would be a stronger
  ownership boundary, but cgroup v2 delegation is not portable across the target
  environments and can require elevated setup. V2 keeps process groups and adds
  kernel-start-time identity instead, and documents the boundary honestly.
- **Verification starts real services.** That is the only way to prove health. It is
  gated by prerequisites, unsafe approval, ownership, and cleanup confirmation, and
  it never installs dependencies or modifies repositories.
- **Prerequisite checks are conservative.** Missing `node_modules` or an empty
  `.env.example` variable becomes a blocker/suggestion rather than an automatic fix.
- **Fingerprint scope.** It includes root and id, so identical service definitions in
  different projects do not share fingerprints. It deliberately excludes cosmetic
  fields (notes, metadata, verification itself) so harmless edits do not invalidate.

## Compatibility

- Existing commands keep working: `scan`, `discover`, `add`, `projects`, `show`,
  `remove`, `start`, `stop`, `restart`, `status`, `logs`, `open`, `action`, `learn`,
  `ai-propose`, `doctor`, `serve`, `ui`, `--json`.
- V1 YAML configs load unchanged; verification/provenance are optional.
- V1 runtime state without process identity is trusted once on first read and gains
  identity on the next start.
- `--allow-unsafe` remains the CLI authorization path; the API now additionally
  requires a well-formed approval object.
