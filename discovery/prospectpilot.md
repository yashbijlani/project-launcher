# Discovery: prospectpilot

- Path: `/home/penguin/code/prospectpilot`
- Confidence: **0.90**
- Readiness: **needs_docker**
- Unsafe to auto-run: no
- Stack signals: Docker, FastAPI, Python

## Blockers

- [docker] Docker daemon unavailable
  - suggestion: Start the Docker daemon, then retry (launcher never starts it automatically)

## Runnable targets

- `backend-backend` — backend (backend): `.venv/bin/python -m uvicorn app.main:app --reload` (cwd backend)
- `stack-root` — stack (primary): `docker compose up db`

## Services

### db
- Command: `docker compose up db`
- Working directory: `.`
- Runtime: compose
- Provenance: detector/docker (confidence 0.90)

### redis
- Command: `docker compose up redis`
- Working directory: `.`
- Runtime: compose
- Provenance: detector/docker (confidence 0.90)

### backend
- Command: `docker compose up backend`
- Working directory: `.`
- Runtime: compose
- Depends on: db, redis
- Provenance: detector/docker (confidence 0.90)

### worker
- Command: `docker compose up worker`
- Working directory: `.`
- Runtime: compose
- Depends on: db, redis
- Provenance: detector/docker (confidence 0.90)

## Detector evidence

- **DockerDetector** (confidence 0.90)
  - compose file docker-compose.yml with services: db, redis, backend, worker
  - Dockerfile at backend/Dockerfile
- **FastAPIDetector** (confidence 0.35)
  - fastapi/uvicorn referenced in backend/requirements.txt
  - no ASGI application object was found
- **PythonDetector** (confidence 0.85)
  - python manifests: backend/requirements.txt
  - backend: FastAPI app at app.main:app (@ app/main.py)
- **EnvFileDetector** (confidence 0.40)
  - env files present: .env, .env.example

## Ambiguous alternates (need a human decision)

- `.venv/bin/python -m uvicorn app.main:app --reload` (cwd backend) — role backend
- `.venv/bin/python -m uvicorn app.main:app` (cwd backend) — role backend

## Warnings

- Compose services were expanded into individual services. Their internal ports are managed by Docker; health checks are not configured by default.
- Detected docker-compose: docker-compose.yml

