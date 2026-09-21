# Discovery: agentdock

- Path: `/home/penguin/code/agentdock`
- Confidence: **0.50**
- Readiness: **unsafe**
- Unsafe to auto-run: **yes** (compose mounts the Docker socket)
- Stack signals: Docker, Node, Monorepo

## Blockers

- [unsafe] compose mounts the Docker socket

## Runnable targets

- `app-root` — app: `npm run dev`
- `app-apps-server` — app (apps/server): `npm run dev` (cwd apps/server)
- `app-packages-core` — app (packages/core): `npm run dev` (cwd packages/core)
- `stack-root` — stack (primary): `docker compose up`

## Services

### stack
- Command: `docker compose up`
- Working directory: `.`
- Runtime: compose
- Provenance: detector/docker (confidence 0.90)

## Detector evidence

- **DockerDetector** (confidence 0.90)
  - compose file docker-compose.yml with services: agentdock
  - Dockerfile at docker/Dockerfile
- **NodeDetector** (confidence 0.95)
  - package.json at package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - script "dev": `npm run dev --workspace apps/server`
  - workspaces: apps/*, packages/*, packages/adapters/*, workers/*
  - package name: agentdock
  - package.json at apps/cli/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: agentdock
  - package.json at apps/web/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: @agentdock/web
  - package.json at apps/server/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - script "dev": `tsc --watch -p tsconfig.json`
  - package name: @agentdock/server
  - package.json at packages/core/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - script "dev": `tsc --watch -p tsconfig.json`
  - package name: @agentdock/core
  - package.json at packages/agent-sdk/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: @agentdock/agent-sdk
  - package.json at packages/adapters/pi/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: @agentdock/adapter-pi
  - package.json at workers/local-worker/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: @agentdock/local-worker
  - package.json at packages/adapters/fake/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: @agentdock/adapter-fake
  - package.json at packages/adapters/codex/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: @agentdock/adapter-codex
  - package.json at packages/adapters/claude/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: @agentdock/adapter-claude
  - package.json at packages/adapters/copilot/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: @agentdock/adapter-copilot
  - package.json at packages/adapters/generic/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: @agentdock/adapter-generic
  - package.json at packages/adapters/opencode/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: @agentdock/adapter-opencode
  - package.json at packages/reviewer-playwright/package.json
  - package manager: npm (no lockfile found (defaulting to npm))
  - scripts present but no dev/start: build
  - package name: @agentdock/reviewer-playwright
- **MonorepoDetector** (confidence 0.45)
  - workspace globs apps/*, packages/*, packages/adapters/*, workers/* with root service script "dev"
- **UnsafeProjectDetector** (confidence 0.70)
  - compose mounts the Docker socket

## Ambiguous alternates (need a human decision)

- `npm run dev` — role app
- `npm run dev` (cwd apps/server) — role app
- `npm run dev` (cwd packages/core) — role app

## Warnings

- Detected docker-compose: docker-compose.yml
- A docker-compose stack was detected; local Node commands are listed as alternates. Remove the compose stack and re-discover to use local commands.

