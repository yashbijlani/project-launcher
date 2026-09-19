# Discovery: restaurantbills

- Path: `/home/penguin/code/restaurantbills`
- Confidence: **0.95**
- Unsafe to auto-run: no
- Stack signals: Node, FastAPI, Python

## Services

### frontend
- Command: `npm run dev`
- Working directory: `frontend`
- Port: 3000
- Health: {"type":"http","url":"http://localhost:3000","startPeriodMs":30000}

### backend
- Command: `backend/.venv/bin/python -m uvicorn backend.main:app --reload`
- Working directory: `.`
- Port: 8000
- Health: {"type":"http","url":"http://localhost:8000","startPeriodMs":45000}

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

## Startup verification

- First attempt failed with `ImportError: attempted relative import with no known parent package`.
- Classification: `WRONG_MODULE_PATH`.
- Resolution: detector now recognizes package-root execution and proposes
  `backend/.venv/bin/python -m uvicorn backend.main:app --reload` from repository root.
- Successful start used manual `depends_on: [backend]` for frontend.
- Backend reached TCP readiness on port 8000; FastAPI root returned 404, so TCP was more accurate than root HTTP.
- Frontend reached HTTP 200 on port 3000.
- Stop order was frontend, then backend; both ports closed and no Next/Uvicorn processes remained.

