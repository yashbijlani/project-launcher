# Discovery: jobhunter

- Path: `/home/penguin/code/jobhunter`
- Confidence: **0.95**
- Unsafe to auto-run: no
- Stack signals: Docker, Node, FastAPI, Python, ShellScript

## Services

### db
- Command: `docker compose up db`
- Working directory: `.`

### backend
- Command: `docker compose up backend`
- Working directory: `.`
- Depends on: db

### frontend
- Command: `docker compose up frontend`
- Working directory: `.`
- Depends on: backend, db

## Detector evidence

- **DockerDetector** (confidence 0.90)
  - compose file docker-compose.yml with services: db, backend, frontend
  - Dockerfile at backend/Dockerfile
- **NodeDetector** (confidence 0.95)
  - package.json at frontend/package.json
  - package manager: pnpm (frontend/pnpm-lock.yaml)
  - script "dev": `vite`
  - package name: jobhunter-frontend
- **FastAPIDetector** (confidence 0.35)
  - fastapi/uvicorn referenced in backend/requirements.txt, pyproject.toml
  - no ASGI application object was found
- **PythonDetector** (confidence 0.85)
  - python manifests: backend/requirements.txt, pyproject.toml
  - backend: FastAPI app at app.main:app (@ app/main.py)
- **ShellScriptDetector** (confidence 0.60)
  - shell scripts: setup.sh
  - start-like scripts: setup.sh
- **EnvFileDetector** (confidence 0.40)
  - env files present: .env.example

## Ambiguous alternates (need a human decision)

- `pnpm dev` (cwd frontend) — role frontend
- `pnpm preview` (cwd frontend) — role frontend
- `python3 -m uvicorn app.main:app --reload` (cwd backend) — role backend
- `python3 -m uvicorn app.main:app` (cwd backend) — role backend

## Warnings

- Compose services were expanded into individual services. Their internal ports are managed by Docker; health checks are not configured by default.
- Detected docker-compose: docker-compose.yml
- A docker-compose stack was detected; local Node commands are listed as alternates. Remove the compose stack and re-discover to use local commands.

