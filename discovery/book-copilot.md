# Discovery: book-copilot

- Path: `/home/penguin/code/book-copilot`
- Confidence: **0.95**
- Unsafe to auto-run: no
- Stack signals: Docker, Node, FastAPI, Python

## Services

### db
- Command: `docker compose up db`
- Working directory: `.`

### api
- Command: `docker compose up api`
- Working directory: `.`
- Depends on: db

### web
- Command: `docker compose up web`
- Working directory: `.`
- Depends on: api, db

## Detector evidence

- **DockerDetector** (confidence 0.90)
  - compose file docker-compose.yml with services: db, api, web
  - Dockerfile at apps/api/Dockerfile
- **NodeDetector** (confidence 0.95)
  - package.json at apps/web/package.json
  - package manager: npm (apps/web/package-lock.json)
  - script "dev": `next dev`
  - package name: book-copilot-web
- **FastAPIDetector** (confidence 0.35)
  - fastapi/uvicorn referenced in apps/api/requirements.txt
  - no ASGI application object was found
- **PythonDetector** (confidence 0.85)
  - python manifests: apps/api/requirements.txt
  - apps/api: FastAPI app at app.main:app (@ app/main.py)
- **EnvFileDetector** (confidence 0.40)
  - env files present: .env, .env.example

## Ambiguous alternates (need a human decision)

- `npm run dev` (cwd apps/web) — role frontend
- `npm start` (cwd apps/web) — role frontend
- `python3 -m uvicorn app.main:app --reload` (cwd apps/api) — role backend
- `python3 -m uvicorn app.main:app` (cwd apps/api) — role backend

## Warnings

- Compose services were expanded into individual services. Their internal ports are managed by Docker; health checks are not configured by default.
- Detected docker-compose: docker-compose.yml
- A docker-compose stack was detected; local Node commands are listed as alternates. Remove the compose stack and re-discover to use local commands.

## Startup verification

- Not started.
- Classification: `DOCKER_REQUIRED`.
- `docker compose config` parsed successfully and exposed the intended topology:
  - `db` maps host port 5432 and has a `pg_isready` health check.
  - `api` depends on healthy `db` and maps host port 8000.
  - `web` depends on `api` and maps host port 3000.
- The local Docker daemon was unavailable (`docker info` failed), so no containers were built, started, or exposed.
- Local app fallbacks are visible as ambiguous alternates because Compose is authoritative for this repository.

