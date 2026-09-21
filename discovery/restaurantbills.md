# Discovery: restaurantbills

- Path: `/home/penguin/code/restaurantbills`
- Confidence: **0.95**
- Readiness: **ready_but_unverified**
- Unsafe to auto-run: no
- Stack signals: Node, FastAPI, Python

## Runnable targets

- `frontend-frontend` — frontend (frontend) (primary): `npm run dev` (cwd frontend)
- `backend-root` — backend (primary): `backend/.venv/bin/python -m uvicorn backend.main:app --reload`

## Services

### frontend
- Command: `npm run dev`
- Working directory: `frontend`
- Port: 3000
- Health: {"type":"http","url":"http://localhost:3000","startPeriodMs":30000}
- Provenance: detector/node (confidence 0.95)

### backend
- Command: `backend/.venv/bin/python -m uvicorn backend.main:app --reload`
- Working directory: `.`
- Port: 8000
- Health: {"type":"http","url":"http://localhost:8000/docs","startPeriodMs":45000}
- Provenance: detector/python (confidence 0.85)

## Detector evidence

- **NodeDetector** (confidence 0.95)
  - package.json at frontend/package.json
  - package manager: npm (frontend/package-lock.json)
  - script "dev": `next dev`
  - package name: revenue-recovery-auditor
- **FastAPIDetector** (confidence 0.90)
  - fastapi/uvicorn referenced in backend/requirements.txt
  - an ASGI application object was found
- **PythonDetector** (confidence 0.85)
  - python manifests: backend/requirements.txt
  - backend: FastAPI app at backend.main:app (@ main.py) (relative imports; run as a package)

## Ambiguous alternates (need a human decision)

- `npm start` (cwd frontend) — role frontend
- `backend/.venv/bin/python -m uvicorn backend.main:app` — role backend

