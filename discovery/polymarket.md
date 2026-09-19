# Discovery: polymarket

- Path: `/home/penguin/code/polymarket`
- Confidence: **0.95**
- Unsafe to auto-run: no
- Stack signals: Docker, Node, FastAPI, Python, ShellScript

## Services

### postgres
- Command: `docker compose up postgres`
- Working directory: `.`

### backend
- Command: `docker compose up backend`
- Working directory: `.`
- Depends on: postgres

### copy-worker
- Command: `docker compose up copy_worker`
- Working directory: `.`
- Depends on: postgres

### agent-worker
- Command: `docker compose up agent_worker`
- Working directory: `.`
- Depends on: postgres

### benchmark-worker
- Command: `docker compose up benchmark_worker`
- Working directory: `.`
- Depends on: postgres

### resolution-worker
- Command: `docker compose up resolution_worker`
- Working directory: `.`
- Depends on: postgres

### frontend
- Command: `docker compose up frontend`
- Working directory: `.`
- Depends on: backend, postgres

## Detector evidence

- **DockerDetector** (confidence 0.90)
  - compose file docker-compose.yml with services: postgres, backend, copy_worker, agent_worker, benchmark_worker, resolution_worker, frontend
  - Dockerfile at backend/Dockerfile
- **NodeDetector** (confidence 0.95)
  - package.json at frontend/package.json
  - package manager: npm (frontend/package-lock.json)
  - script "dev": `vite --host 0.0.0.0 --port 5173`
  - package name: polymarket-dashboard
- **FastAPIDetector** (confidence 0.35)
  - fastapi/uvicorn referenced in backend/requirements.txt
  - no ASGI application object was found
- **PythonDetector** (confidence 0.85)
  - python manifests: backend/requirements.txt
  - backend: FastAPI app at app.main:app (@ app/main.py)
- **ShellScriptDetector** (confidence 0.60)
  - shell scripts: restart.sh, start.sh, status.sh, stop.sh
  - start-like scripts: start.sh
- **EnvFileDetector** (confidence 0.40)
  - env files present: .env, .env.example

## Ambiguous alternates (need a human decision)

- `npm run dev` (cwd frontend) — role frontend
- `npm run preview` (cwd frontend) — role frontend
- `../.venv/bin/python -m uvicorn app.main:app --reload` (cwd backend) — role backend
- `../.venv/bin/python -m uvicorn app.main:app` (cwd backend) — role backend

## Warnings

- Compose services were expanded into individual services. Their internal ports are managed by Docker; health checks are not configured by default.
- Detected docker-compose: docker-compose.yml
- A docker-compose stack was detected; local Node commands are listed as alternates. Remove the compose stack and re-discover to use local commands.

