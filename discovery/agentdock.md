# Discovery: agentdock

- Path: `/home/penguin/code/agentdock`
- Confidence: **0.50**
- Unsafe to auto-run: **yes** (compose mounts the Docker socket)
- Stack signals: Docker, Node, Monorepo

## Services

### stack
- Command: `docker compose up`
- Working directory: `.`

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
- **MonorepoDetector** (confidence 0.45)
  - workspace globs apps/*, packages/*, packages/adapters/*, workers/* with root service script "dev"
- **UnsafeProjectDetector** (confidence 0.70)
  - compose mounts the Docker socket

## Ambiguous alternates (need a human decision)

- `npm run dev` — role app

## Warnings

- Detected docker-compose: docker-compose.yml
- A docker-compose stack was detected; local Node commands are listed as alternates. Remove the compose stack and re-discover to use local commands.

