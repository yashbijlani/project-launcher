# Discovery: book-copilot

- Path: `/home/penguin/code/book-copilot`
- Confidence: **0.90**
- Readiness: **needs_docker**
- Unsafe to auto-run: no
- Stack signals: Docker, FastAPI, Python

## Blockers

- [docker] Docker daemon unavailable
  - suggestion: Start the Docker daemon, then retry (launcher never starts it automatically)

## Runnable targets

- `backend-apps-api` — backend (apps/api): `python3 -m uvicorn app.main:app --reload` (cwd apps/api)
- `stack-root` — stack (primary): `docker compose up db`

## Services

### db
- Command: `docker compose up db`
- Working directory: `.`
- Runtime: compose
- Provenance: detector/docker (confidence 0.90)

### api
- Command: `docker compose up api`
- Working directory: `.`
- Runtime: compose
- Depends on: db
- Provenance: detector/docker (confidence 0.90)

### web
- Command: `docker compose up web`
- Working directory: `.`
- Runtime: compose
- Depends on: api, db
- Provenance: detector/docker (confidence 0.90)

## Detector evidence

- **DockerDetector** (confidence 0.90)
  - compose file docker-compose.yml with services: db, api, web
  - Dockerfile at apps/api/Dockerfile
- **FastAPIDetector** (confidence 0.35)
  - fastapi/uvicorn referenced in apps/api/requirements.txt
  - no ASGI application object was found
- **PythonDetector** (confidence 0.85)
  - python manifests: apps/api/requirements.txt
  - apps/api: FastAPI app at app.main:app (@ app/main.py)
- **EnvFileDetector** (confidence 0.40)
  - env files present: .env, .env.example

## Ambiguous alternates (need a human decision)

- `python3 -m uvicorn app.main:app --reload` (cwd apps/api) — role backend
- `python3 -m uvicorn app.main:app` (cwd apps/api) — role backend

## Warnings

- Compose services were expanded into individual services. Their internal ports are managed by Docker; health checks are not configured by default.
- Detected docker-compose: docker-compose.yml

