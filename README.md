# Project Launcher

Project Launcher is a deterministic local project supervisor. It discovers how a repository is
likely started, saves that startup plan as editable YAML, then starts, monitors, and stops only
the processes it owns.

It is designed to replace this manual workflow:

```text
remember commands → open terminals → activate environments →
start services in order → check ports → kill processes manually
```

with:

```text
launcher discover /code/project --yes
launcher start project
launcher stop project
```

The normal runtime does **not** require an AI model.

## Safety first

- The launcher never modifies the repositories it inspects.
- Discovery is bounded and deterministic.
- Stopping a project signals only its tracked process group.
- It never uses broad process killing such as `pkill node` or `pkill python`.
- Projects explicitly marked unsafe require `--allow-unsafe`.
- Optional AI assistance can only propose a configuration. Every proposal must pass validation
  and explicit user approval.

## Requirements

- Node.js 20 or later
- `/bin/bash`
- Linux for process-group supervision and `learn` observations
- Optional, depending on the project:
  - Docker and the Docker daemon
  - Python virtual environments
  - Node.js dependencies already installed in the repository
  - Android SDK/device for mobile projects

## Install and verify

```bash
cd /home/penguin/code/project-launcher
npm ci
npm run build
node bin/launcher.js doctor
```

Useful checks:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Do not install the launcher globally for this prototype. Run it through:

```bash
node bin/launcher.js <command>
```

## Discover a project

Scan every immediate child of a corpus directory:

```bash
node bin/launcher.js scan /home/penguin/code
```

Show a deterministic proposal without saving it:

```bash
node bin/launcher.js discover /home/penguin/code/restaurantbills
```

Save the proposal:

```bash
node bin/launcher.js discover /home/penguin/code/restaurantbills --yes
```

Inspect the generated configuration:

```bash
node bin/launcher.js show restaurantbills
```

### Discovery confidence

Confidence is a UI heuristic, not mathematical certainty:

- `0.95+`: highly confident
- `0.80–0.95`: probably correct
- `0.50–0.80`: ambiguous
- `<0.50`: unknown

Ambiguous commands are preserved separately. They are displayed for human selection and are
never silently promoted into automatic startup commands.

## Example configuration

```yaml
id: restaurantbills
name: restaurantbills
root: /home/penguin/code/restaurantbills

services:
  backend:
    command: backend/.venv/bin/python -m uvicorn backend.main:app --reload
    port: 8000
    healthcheck:
      type: tcp
      port: 8000
      startPeriodMs: 45000

  frontend:
    command: npm run dev
    cwd: frontend
    port: 3000
    depends_on:
      - backend
    healthcheck:
      type: http
      url: http://localhost:3000
      startPeriodMs: 30000

profiles:
  development:
    services:
      - backend
      - frontend
```

Configurations live under:

```text
~/.local/share/project-launcher/projects/<project-id>.yaml
```

Runtime state lives under:

```text
~/.local/share/project-launcher/state/
```

Ownership locks live under:

```text
~/.local/share/project-launcher/locks/
```

Service logs live under:

```text
~/.local/share/project-launcher/logs/<project-id>/
```

## Verification

Confidence is how sure discovery is. Verification is whether this exact
configuration has actually been tested successfully. They are different things.

```text
confidence: 0.95   verification: unverified   # found, never run
confidence: 0.55   verification: verified     # uncertain guess, proven to work
```

Run a full verification:

```bash
node bin/launcher.js verify restaurantbills
```

Verification performs, deterministically:

1. structural validation and path checks
2. read-only prerequisite inspection (no installs)
3. ownership acquisition
4. start in dependency order
5. wait for configured health checks
6. confirm declared ports are usable
7. stop in reverse dependency order
8. confirm cleanup (processes gone, ports closed)
9. write evidence and release ownership

It is `verified` only with real evidence. A spawned process is not enough.

Evidence is stored in the project YAML:

```yaml
verification:
  status: verified
  verifiedAt: "2026-09-21T12:39:41.245Z"
  launcherVersion: 0.2.0
  configFingerprint: "7f3e0c..."
  environment:
    nodeVersion: v26.8.1
    pythonVersion: Python 3.14.7
  services:
    backend:
      started: true
      healthy: true
      stoppedCleanly: true
      health: { type: http, url: http://localhost:8000/docs }
  dependencyOrder: [backend, frontend]
```

Verification is tied to a fingerprint of the startup-relevant configuration
(id, root, services, profiles, actions). Editing a command, cwd, dependency,
health check, environment, port, restart policy, runtime, profile, or action makes
the old verification stale:

```text
VERIFIED --edit command--> UNVERIFIED
```

`status` and the dashboard show this as `verified (current=true|false)`.

## Ownership and safety

- Only one launcher instance may own a project at a time. Ownership uses an atomic
  `O_EXCL` lock with owner PID, kernel process start time, launcher instance UUID,
  and a heartbeat. Stale locks (dead owner, reused PID, expired heartbeat) recover
  safely.
- Starting an already-owned project does not launch a duplicate service tree.
- Process ownership is verified from `/proc` (PID + kernel start time), so a reused
  PID can never cause the launcher to kill an unrelated process.
- All cwd values are resolved against the project root; traversal outside it is
  rejected.
- Unsafe projects require explicit authorization. On the CLI: `--allow-unsafe`.
  Over HTTP: an `unsafeApproval { projectId, reason }` with a reason of at least 8
  characters. A bare `allowUnsafe` boolean is rejected by the API as ambiguous. The
  server never authorizes an unsafe project by itself.

## Readiness and doctor

Ask whether a project can start, without starting it:

```bash
node bin/launcher.js doctor restaurantbills
```

Readiness categories: `ready`, `ready_but_unverified`, `needs_environment`,
`needs_docker`, `needs_device`, `needs_credentials`, `ambiguous`, `unsafe`,
`unknown`, `broken`. Blockers include suggestions. The launcher never installs
dependencies or starts Docker for you.

Explain where a configuration came from:

```bash
node bin/launcher.js explain restaurantbills
```

Each service shows its command, cwd, runtime, dependencies, provenance
(detector/manual/ai/learned/imported with evidence), readiness, and verification.

## Monorepos

List runnable targets in a workspace:

```bash
node bin/launcher.js targets /home/penguin/code/agentdock
```

Save one target instead of the whole repository:

```bash
node bin/launcher.js add /home/penguin/code/agentdock --target app-apps-server
```

Nested examples are never promoted to repository-wide startup commands automatically.

## Start, monitor, and stop

Start every service:

```bash
node bin/launcher.js start restaurantbills
```

Start a profile:

```bash
node bin/launcher.js start restaurantbills --profile development
```

Start selected services, including their dependencies:

```bash
node bin/launcher.js start restaurantbills --services frontend
```

Check status (shows verification and readiness):

```bash
node bin/launcher.js status restaurantbills
```

View logs, follow them, or clear them:

```bash
node bin/launcher.js logs restaurantbills
node bin/launcher.js logs restaurantbills --service backend
node bin/launcher.js logs restaurantbills --follow
node bin/launcher.js logs restaurantbills --clear
```

Restart:

```bash
node bin/launcher.js restart restaurantbills
```

Stop everything:

```bash
node bin/launcher.js stop restaurantbills
```

Stop one service and anything depending on it:

```bash
node bin/launcher.js stop restaurantbills --service backend
```

Print likely browser URLs:

```bash
node bin/launcher.js open restaurantbills
```

All lifecycle and inspection commands support:

```bash
--json
```

## Services, dependencies, and health

Services start in dependency order:

```text
database → backend → frontend
```

They stop in reverse order:

```text
frontend → backend → database
```

Dependency cycles and missing services are reported instead of being executed.

Supported health checks:

- `process`: the tracked process is alive
- `tcp`: a host/port accepts a connection
- `http`: a URL returns an acceptable status and optional body text
- `command`: an external command exits successfully

A process merely existing is not enough for `tcp`, `http`, or `command` health.

## Profiles and actions

Profiles select named subsets of services:

```yaml
profiles:
  minimal:
    services:
      - backend
  development:
    services:
      - backend
      - frontend
```

Actions run named one-shot repository operations:

```yaml
actions:
  test:
    command: pytest
    cwd: backend
```

Run one with:

```bash
node bin/launcher.js action restaurantbills test
```

## Desktop UI and keyboard shortcut

Start the local dashboard:

```bash
node bin/launcher.js serve
```

By default it listens only on:

```text
http://127.0.0.1:8790/
```

The dashboard can list projects, discover a path, start/stop/restart/verify projects,
inspect logs and details, and shows readiness, verification currency, per-service
health, and blockers. It receives live events over Server-Sent Events
(`/api/events`).

Keyboard-first controls:

```text
j / k      move selection
Enter      start (or stop if running)
S          start
X          stop
R          restart
L          logs
D          details / explain
V          verify
```

Unsafe projects started from the UI open a confirmation that requires a typed
reason; that reason is sent as an explicit approval and enforced by the backend.

Start the desktop-oriented launcher:

```bash
node bin/launcher.js ui
```

Install or inspect a Hyprland hotkey binding without changing launcher core behavior:

```bash
scripts/install-hotkey.sh print
scripts/install-hotkey.sh install
scripts/install-hotkey.sh uninstall
```

The default binding is `SUPER+P` to `launcher ui`.

## Optional AI integration

AI is disabled unless both environment variables are set:

```bash
LAUNCHER_AI_BASE_URL=https://example-model-server/v1
LAUNCHER_AI_MODEL=example-model
```

Optionally:

```bash
LAUNCHER_AI_API_KEY=...
```

Request a proposal:

```bash
node bin/launcher.js ai-propose /home/penguin/code/some-project
```

The AI receives only a bounded evidence package. Secrets are redacted before transmission.
Proposals are validated in layers: structure (ids, dependencies, cycles, profiles,
actions, health checks), filesystem (cwd containment, no arbitrary absolute paths),
evidence (directly evidenced vs derived vs AI-invented commands), and security
(sudo, destructive operations, download-and-execute, credential exfiltration, raw
devices). AI-invented commands require stronger approval and should be verified
before routine use. AI never executes anything directly.

## Learn from manual startup

Learning is opt-in and scoped to one project root:

```bash
node bin/launcher.js learn /home/penguin/code/some-project
```

Perform the normal startup in another terminal, then:

```bash
node bin/launcher.js learn /home/penguin/code/some-project --finish
```

The launcher compares processes under that root before and after the observation window. It does
not globally record shell history.

## Repository layout

```text
bin/launcher.js
src/cli.ts
src/config.ts
src/detectors/
src/discovery.ts
src/graph.ts
src/health.ts
src/manager.ts
src/supervisor.ts
src/state.ts
src/server.ts
src/ui.ts
src/ai.ts
src/learn.ts
src/safety.ts        single safety gate + structural/path validation
src/fingerprint.ts   config fingerprint + verification currency
src/lock.ts          atomic per-project ownership lock
src/proc.ts          /proc process identity + PID-reuse detection
src/prereqs.ts       read-only prerequisite inspection + readiness
src/verify.ts        deterministic verification workflow
src/docker.ts        docker compose model (CLI JSON + fallback parser)
scripts/
test/
discovery/
```

Supporting experiment artifacts:

```text
INVENTORY.md
inventory.json
signals.json
discovery/SUMMARY.md
discovery/CATEGORIZATION.md
discovery/<project>.md
V2_IMPLEMENTATION_REPORT.md
V2_VERIFICATION_REPORT.md
```

## Validation already performed

- TypeScript compilation passes.
- ESLint passes (`--max-warnings=0`).
- Automated tests pass (65 tests; Docker compose lifecycle skipped without a daemon).
- Real corpus projects were discovered, verified (start, health, stop, cleanup),
  started, stopped from a separate CLI process, and checked for process cleanup.
- Unsafe, device, credentials, and Docker cases were correctly classified and blocked
  rather than forcibly started.
- Docker lifecycle was not validated because the local Docker daemon was unavailable.
- No repository source, configuration, dependency, or Git history was edited.
- Successful runtime tests necessarily left normal generated/cache artifacts in the tested
  repositories, such as web-server logs and frontend build caches.

See:

- `ARCHITECTURE.md`
- `DISCOVERY_RESULTS.md`
- `KNOWN_LIMITATIONS.md`
- `V2_IMPLEMENTATION_REPORT.md`
- `V2_VERIFICATION_REPORT.md`
