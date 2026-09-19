# Discovery: prospectpilot

- Path: `/home/penguin/code/prospectpilot`
- Confidence: **0.90**
- Unsafe to auto-run: no
- Stack signals: Docker, FastAPI, Python

## Services

### db
- Command: `docker compose up db`
- Working directory: `.`

### redis
- Command: `docker compose up redis`
- Working directory: `.`

### backend
- Command: `docker compose up backend`
- Working directory: `.`
- Depends on: db, redis

### worker
- Command: `docker compose up worker`
- Working directory: `.`
- Depends on: db, redis

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

