# Discovery: human-broker

- Path: `/home/penguin/code/human-broker`
- Confidence: **0.95**
- Readiness: **needs_environment**
- Unsafe to auto-run: no
- Stack signals: Docker, Node, FastAPI, Python, Monorepo

## Blockers

- [environment] (frontend-apps-web) node_modules missing in /home/penguin/code/human-broker/apps/web
  - suggestion: Install dependencies manually (e.g. cd /home/penguin/code/human-broker/apps/web && npm install)
- [docker] Docker daemon unavailable
  - suggestion: Start the Docker daemon, then retry (launcher never starts it automatically)

## Runnable targets

- `app-root` — app (primary): `npm run dev`
- `frontend-apps-web` — frontend (apps/web) (primary): `npm run dev` (cwd apps/web)
- `backend-apps-api` — backend (apps/api) (primary): `../../.venv/bin/python -m uvicorn app.main:app --reload` (cwd apps/api)
- `stack-root` — stack (primary): `docker compose up postgres`

## Services

### postgres
- Command: `docker compose up postgres`
- Working directory: `.`
- Runtime: compose
- Provenance: detector/docker (confidence 0.90)
- Notes: Infrastructure service managed by docker compose.

### redis
- Command: `docker compose up redis`
- Working directory: `.`
- Runtime: compose
- Provenance: detector/docker (confidence 0.90)
- Notes: Infrastructure service managed by docker compose.

### app
- Command: `npm run dev`
- Working directory: `.`
- Depends on: postgres, redis
- Provenance: detector/node (confidence 0.95)

### frontend-apps-web
- Command: `npm run dev`
- Working directory: `apps/web`
- Port: 3000
- Health: {"type":"http","url":"http://localhost:3000","startPeriodMs":30000}
- Provenance: detector/node (confidence 0.95)

### backend-apps-api
- Command: `../../.venv/bin/python -m uvicorn app.main:app --reload`
- Working directory: `apps/api`
- Port: 8000
- Depends on: postgres
- Health: {"type":"http","url":"http://localhost:8000/docs","startPeriodMs":45000}
- Provenance: detector/python (confidence 0.85)

## Detector evidence

- **DockerDetector** (confidence 0.90)
  - compose file docker-compose.yml with services: postgres, redis
- **NodeDetector** (confidence 0.95)
  - package.json at package.json
  - package manager: npm (package-lock.json)
  - script "dev": `npm --workspace apps/web run dev`
  - workspaces: apps/web, packages/*
  - package name: human-broker
  - package.json at apps/web/package.json
  - package manager: npm (package-lock.json)
  - script "dev": `NEXT_DIST_DIR=.next-dev next dev`
  - package name: @human-broker/web
- **FastAPIDetector** (confidence 0.35)
  - fastapi/uvicorn referenced in apps/api/pyproject.toml
  - no ASGI application object was found
- **PythonDetector** (confidence 0.85)
  - python manifests: apps/api/pyproject.toml
  - apps/api: FastAPI app at app.main:app (@ app/main.py)
- **MonorepoDetector** (confidence 0.45)
  - workspace globs apps/web, packages/* with root service script "dev"
- **EnvFileDetector** (confidence 0.40)
  - env files present: .env, .env.example

## Ambiguous alternates (need a human decision)

- `npm start` (cwd apps/web) — role frontend
- `../../.venv/bin/python -m uvicorn app.main:app` (cwd apps/api) — role backend

## Warnings

- Compose file only contains infrastructure services (database/cache). Application services were detected separately; start order is not inferred beyond compose dependencies.
- Detected docker-compose: docker-compose.yml

