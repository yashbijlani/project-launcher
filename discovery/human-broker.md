# Discovery: human-broker

- Path: `/home/penguin/code/human-broker`
- Confidence: **0.95**
- Unsafe to auto-run: no
- Stack signals: Docker, Node, FastAPI, Python, Monorepo

## Services

### postgres
- Command: `docker compose up postgres`
- Working directory: `.`
- Notes: Infrastructure service managed by docker compose.

### redis
- Command: `docker compose up redis`
- Working directory: `.`
- Notes: Infrastructure service managed by docker compose.

### app
- Command: `npm run dev`
- Working directory: `.`
- Depends on: postgres, redis

### backend-apps-api
- Command: `../../.venv/bin/python -m uvicorn app.main:app --reload`
- Working directory: `apps/api`
- Port: 8000
- Depends on: postgres
- Health: {"type":"http","url":"http://localhost:8000","startPeriodMs":45000}

## Detector evidence

- **DockerDetector** (confidence 0.90)
  - compose file docker-compose.yml with services: postgres, redis
- **NodeDetector** (confidence 0.95)
  - package.json at package.json
  - package manager: npm (package-lock.json)
  - script "dev": `npm --workspace apps/web run dev`
  - workspaces: apps/web, packages/*
  - package name: human-broker
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

- `../../.venv/bin/python -m uvicorn app.main:app` (cwd apps/api) — role backend

## Warnings

- Compose file only contains infrastructure services (database/cache). Application services were detected separately; start order is not inferred beyond compose dependencies.
- Detected docker-compose: docker-compose.yml

## Startup verification

- Not started.
- Classification: `DOCKER_REQUIRED` for the intended PostgreSQL and Redis dependencies.
- The local Docker daemon was unavailable, so infrastructure could not be provided safely.
- Detector correctly retained infrastructure services while also proposing local app/API commands as separate candidates.
- Starting the API without the database would be misleading; the launcher should not present the app services as ready until infrastructure health is established.

