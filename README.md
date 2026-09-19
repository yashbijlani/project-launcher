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

Service logs live under:

```text
~/.local/share/project-launcher/logs/<project-id>/
```

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

Check status:

```bash
node bin/launcher.js status restaurantbills
```

View logs:

```bash
node bin/launcher.js logs restaurantbills
node bin/launcher.js logs restaurantbills --service backend
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

The dashboard can list projects, discover a path, start/stop/restart projects, and inspect logs.

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
The response must be valid, non-destructive, and explicitly approved before it can influence the
runtime.

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
```

## Validation already performed

- TypeScript compilation passes.
- ESLint passes.
- Automated tests pass.
- Real corpus projects were started, health-checked, stopped, and verified for process cleanup.
- Docker lifecycle was not validated because the local Docker daemon was unavailable.
- No repository source, configuration, dependency, or Git history was edited.
- Successful runtime tests necessarily left normal generated/cache artifacts in the tested
  repositories, such as web-server logs and frontend build caches.

See:

- `ARCHITECTURE.md`
- `DISCOVERY_RESULTS.md`
- `KNOWN_LIMITATIONS.md`
