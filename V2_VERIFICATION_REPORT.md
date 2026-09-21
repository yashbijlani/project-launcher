# V2 Verification Report

This report records what was actually executed and observed. Nothing here is
claimed unless it was run. The corpus at `/home/penguin/code` changed between V1
and V2 (`vercel`, `omarchy`, `gods-eye-view` are gone; `autonomous-contributor`
appeared), so corpus counts reflect the V2 snapshot.

## Gate results

| Gate | Command | Result |
|---|---|---|
| Tests | `npm test` | **65 tests, 64 pass, 0 fail, 1 skipped** (Docker compose lifecycle: daemon unavailable) |
| Typecheck | `npm run typecheck` | pass (exit 0) |
| Lint | `npm run lint` | pass (exit 0, `--max-warnings=0`) |
| Build | `npm run build` | pass (exit 0) |

Test files:

```text
test/graph.test.js            dependency ordering, cycles, dependents, profiles
test/supervisor.test.js       stdout capture, process-tree cleanup, failure classes
test/detectors.test.js        compose parsing, dev ports, monorepo, unsafe marker
test/learn.test.js            learn session setup
test/lock.test.js             atomic lock, cross-process contention, stale recovery, PID reuse, re-entrancy
test/safety.test.js           unsafe gate, approvals, cwd traversal, fingerprints
test/config-ai.test.js        YAML round-trip, AI proposal validation tiers
test/verify.test.js           verification success/failure/blocked/cleanup/invalidation
test/docker.test.js           compose model + guarded compose lifecycle (skipped without daemon)
test/server.test.js           API unsafe enforcement (403/200)
test/ownership.test.js        duplicate start, orphan reclaim, PID-reuse refusal, restart suppression
test/readiness.test.js        readiness categories + monorepo targets
test/runtime-e2e.test.js      discover -> configure -> verify -> start -> cross-CLI status/stop -> cleanup
```

## Corpus

Snapshot: **21 projects** under `/home/penguin/code` (excluding the launcher).

| Metric | Count |
|---|---|
| Projects inspected (discovery) | 21 |
| Automatically understood (confidence >= 0.8, >= 1 service) | 9 |
| Detected but ambiguous | 9 |
| Nothing detected (unknown) | 3 (`autonomous-contributor`, `geb`, `microsaas`) |
| Unsafe to auto-run | 7 (`agentdock`, `blindfold-chess`, `camera-copilot`, `freedom`, `infinite_zoom`, `phoneaway`, `rune`) |
| Readiness `needs_device` | 5 Android projects |
| Readiness `needs_docker` | 3 (`book-copilot`, `polymarket`, `prospectpilot`) |
| Readiness `needs_credentials` | 2 (`desktop-tutor`, `jobhunter`) |
| Readiness `ready_but_unverified` | 5 (`bullet_engine`, `clash`, `gaze_scroll`, `musicalbook`, `restaurantbills`) |

### Projects verified with real start/health/stop/cleanup

| Project | Services | Order | Evidence |
|---|---|---|---|
| `gaze_scroll` | frontend | frontend | started, HTTP 200, stopped cleanly, port closed |
| `musicalbook` | frontend | frontend | started, HTTP 200, stopped cleanly, port closed |
| `bullet_engine` | backend | backend | started, HTTP 200, stopped cleanly, port closed |
| `restaurantbills` | backend, frontend | backend -> frontend | both started, HTTP 200 (`/docs` and `/`), stopped cleanly in reverse order, ports closed |

Verification records are persisted in each project YAML with status, timestamp,
launcher version, config fingerprint, environment versions, per-service evidence, and
dependency order. Example (`restaurantbills`):

```yaml
verification:
  status: verified
  launcherVersion: 0.2.0
  configFingerprint: 7f3e0c2c5f609cfbd4ff510e29e2ff3f20d2fe1839aefe9b5a779fec193a6aa4
  environment: { nodeVersion: v26.8.1, pythonVersion: Python 3.14.7 }
  services:
    backend:  { started: true, healthy: true, stoppedCleanly: true, health: { type: http, url: http://localhost:8000/docs } }
    frontend: { started: true, healthy: true, stoppedCleanly: true, health: { type: http, url: http://localhost:3000 } }
  dependencyOrder: [backend, frontend]
```

### Projects blocked (correctly)

| Project | Class | Behavior |
|---|---|---|
| `freedom` | unsafe | `launcher start` exit 1 with "UNSAFE TO AUTO-RUN"; `launcher verify` status `blocked`, failure class `PERMISSION` |
| `rune` | device | readiness `needs_device`; no build attempted |
| `book-copilot` | docker | readiness `needs_docker`; compose parsed, no containers started |
| `polymarket`, `prospectpilot` | docker | readiness `needs_docker` |
| `human-broker` | environment | readiness `needs_environment` (hybrid: compose infra + local apps) |
| `jobhunter`, `desktop-tutor` | credentials | readiness `needs_credentials` |
| Android projects | device + unsafe | readiness `needs_device`, marked unsafe |

## Runtime behaviors

| Behavior | Method | Result |
|---|---|---|
| Duplicate-start protection (cross-process) | child launcher process holds lock; second `acquireLock` | rejected with owner instance id and PID |
| Duplicate-start protection (same process) | two `ProjectManager.start` on one project | second adopted the same PID; no duplicate tree |
| Stale-lock recovery | lock file with dead owner PID | quarantined, reacquired, `recoveredStale: true` |
| PID-reuse detection | lock/state with wrong owner start time | treated stale; no signal sent |
| Cross-CLI stop | start with CLI A, stop with CLI B | stopped, port closed, owned process gone |
| Process cleanup | stop after start | no child/descendant processes remain (verified with `ps`) |
| Verification invalidation | verify, edit command, re-check | `current=true` -> `current=false` -> restore -> `current=true` |
| Restart-loop suppression | failing command, `restartMaxAttempts: 2` | "restart loop suppressed", status `failed` |
| Unsafe CLI enforcement | `launcher start freedom` | exit 1, refused |
| Unsafe API enforcement | POST start with `{}`, `{allowUnsafe:true}`, malformed approvals | HTTP 403 for all; only well-formed approval accepted |
| cwd traversal | unit tests | `../../etc` and absolute external cwd rejected |
| Cross-process lock contention | two real launcher processes | second cannot own the project |
| No broad process killing | source review + tests | only negative-PID process-group signals; identity-gated |

## Docker

- Docker CLI is installed (`Docker version 29.7.2`), daemon is **unavailable**
  (`docker info` fails).
- `docker compose config --format json` still works client-side and was validated
  against the safe fixture `test/fixtures/compose/docker-compose.yml`
  (`db` with a healthcheck, `app` depends on healthy `db`). The model correctly
  exposes service names, ports, and `depends_on`, and `buildStartPlan` orders
  `db -> app`.
- The real compose lifecycle test is present but **skipped** because no daemon is
  available. No corpus Compose stack was started. This is the main unverified area.

## UI

- `launcher serve` starts the loopback dashboard and API.
- Dashboard HTML loads; `/api/projects` returns readiness and verification for all
  configured projects.
- `/api/projects/:id/explain` returns provenance and readiness.
- Unsafe start via API returns 403 without a well-formed approval (verified with
  curl for `freedom`: no approval, bare flag, short reason, wrong project id all 403).
- SSE endpoint `/api/events` is implemented; event publishing is exercised by the
  server lifecycle handlers. A dedicated live-stream assertion was not added.
- The WebKitGTK desktop window and the Hyprland hotkey were **not** exercised in this
  session; they remain integration code.

## AI

- No AI provider was configured. `launcher ai-propose` was not run against a live
  model. Proposal validation (structural, filesystem, evidence tiers, security
  patterns) is covered by unit tests.

## Explicitly unverified

- Real Docker Compose start/health/stop/cleanup (daemon unavailable).
- Live AI provider proposals.
- WebKitGTK desktop window and global hotkey on a graphical session.
- SSE delivery to a long-lived browser client.
- cgroup-based ownership (deliberately not implemented; process groups retained).
