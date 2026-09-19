# Architecture

Project Launcher separates deterministic startup machinery from optional assistance.
Discovery, supervision, dependency planning, health assessment, and configuration are all
possible without AI.

## Runtime data flow

```text
repository
  ↓
bounded inventory and manifest extraction
  ↓
detectors
  ↓
candidate startup commands with evidence
  ↓
discovery reconciliation
  ↓
editable YAML project configuration
  ↓
dependency graph
  ↓
process supervisor and health checks
  ↓
persisted state, leases, and logs
  ↓
CLI, HTTP API, desktop UI, or hotkey
```

Optional AI runs beside this pipeline:

```text
bounded evidence
  ↓
optional AI proposal
  ↓
validation
  ↓
user approval
  ↓
saved configuration
  ↓
normal runtime safety controls
```

AI output can never start a process directly.

## Discovery and detectors

Detector implementations live in `src/detectors/`.

Each detector receives only a bounded context:

- top-level files and directories
- shallow files up to a fixed depth
- explicitly requested manifest contents
- bounded README excerpts

Detectors return:

- a type
- a confidence heuristic
- evidence strings
- candidate commands
- structured metadata

Important detector behaviors learned from the real corpus:

- A `uvicorn` dependency alone does not prove a `module:app` target.
- Relative Python imports require execution from the containing package root.
- A nested example in a workspace monorepo is not a repository-wide startup command.
- Framework text without an application object is weak evidence.
- Interpreter paths should be service-relative when possible.
- Explicitly vulnerable test targets must require human approval.

`src/discovery.ts` reconciles candidates by working directory and role, expands Compose
services, infers infrastructure dependencies conservatively, preserves ambiguous alternates,
warns about monorepo scope, and assigns an overall confidence value.

## Configuration

`src/config.ts` converts validated project objects to and from human-editable YAML.

The configuration model is:

```text
Project
├── metadata
├── services
├── dependencies
├── environment
├── profiles
├── health checks
└── actions
```

A service contains:

- a stable identifier
- a command
- a working directory
- environment variables
- dependencies
- a health check
- a restart policy
- an optional port
- operational notes

Discovery generates configuration. It does not own the repository.

## Process supervisor

`src/supervisor.ts` spawns each service through a shell in a detached process group.

For every service it captures:

- standard output
- standard error
- process ID
- start and exit timestamps
- exit code and signal
- a bounded recent-output tail

Stopping sends `SIGTERM` to the tracked process group, waits for a grace period, then sends
`SIGKILL` if necessary. This removes child processes in the same group without scanning for
unrelated processes by name.

The supervisor also classifies startup failures into categories such as:

- `PORT_CONFLICT`
- `MISSING_DEPENDENCY`
- `WRONG_WORKING_DIRECTORY`
- `WRONG_MODULE_PATH`
- `DATABASE_REQUIRED`
- `DOCKER_REQUIRED`
- `DEVICE_REQUIRED`
- `SERVICE_ORDER`

## Project manager and dependency graph

`src/graph.ts` performs a deterministic topological sort, detects cycles, validates profiles,
expands requested services with their dependencies, and expands stopped services with their
dependents.

`src/manager.ts` coordinates the full lifecycle:

1. Resolve profiles and dependencies.
2. Reject cycles, missing services, and unapproved unsafe projects.
3. Start dependencies first.
4. Wait for health where configured.
5. Record runtime state continuously.
6. Poll health while running.
7. Stop dependents before dependencies.
8. Persist final state and release the lease.

A manager created in a new CLI process seeds its state from disk. This allows a later `stop`
command to reclaim processes started by an earlier `start`, even though the original CLI
process has exited.

## Health system

`src/health.ts` supports:

- process liveness
- TCP connectivity
- HTTP status and body checks
- command execution

`waitForHealthy` polls until success, failure, timeout, or process exit. Periodic checks update
runtime state but do not rewrite configuration.

## State, leases, and logs

`src/state.ts` and `src/paths.ts` manage local launcher data.

Per project, the launcher stores:

- runtime status and PIDs
- a supervisor lease
- timestamped stdout and stderr logs

A stale lease whose supervisor PID no longer exists is treated as orphaned and can be cleaned
by `launcher doctor`.

Local logs are operational records. They may contain application output and therefore are not
a safe place to assume secrets are absent. Only outbound AI evidence is actively redacted.

## CLI

`src/cli.ts` implements discovery, configuration management, lifecycle control, logs, actions,
learning, optional AI proposals, environment checks, and server/UI entry points.

Every operational command supports `--json` for GUI and automation use.

## Desktop client and server

`src/server.ts` exposes a loopback HTTP API and a dependency-free dashboard.

`src/ui.ts` prefers a local WebKitGTK window when available and otherwise opens the default
browser. Desktop presentation is isolated from process supervision.

Global hotkey support is provided by `scripts/install-hotkey.sh` as a Hyprland integration.
It only registers a key binding; it does not alter runtime semantics.

## Optional AI provider

`src/ai.ts` defines:

- `IntelligentDiscoveryProvider`
- an OpenAI-compatible HTTP provider
- a null provider used by default
- evidence redaction
- proposal parsing
- proposal validation

Validation rejects:

- low-confidence proposals
- empty proposals
- empty commands
- `sudo`
- obviously destructive shell operations

## Learn mode

`src/learn.ts` snapshots Linux `/proc` entries scoped to one project root before and after an
opt-in manual startup. It then proposes representative services.

It does not hook shells, record global command history, or infer behavior outside the selected
project root.

## Test layers

- Unit tests cover dependency ordering, cycle detection, profile validation, Compose parsing,
  detector fallbacks, process-tree cleanup, failure classification, and learning setup.
- Corpus discovery tests the detectors against real repositories.
- Manual end-to-end tests verify start, health, logs, status, restart, stop, cleanup, and
  configuration persistence.
