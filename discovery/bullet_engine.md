# Discovery: bullet_engine

- Path: `/home/penguin/code/bullet_engine`
- Confidence: **0.55**
- Unsafe to auto-run: no
- Stack signals: Node, Python

## Services

### backend
- Command: `.venv/bin/python scripts/web.py`
- Working directory: `.`
- Port: 8000
- Health: {"type":"http","url":"http://localhost:8000","startPeriodMs":45000}

## Detector evidence

- **NodeDetector** (confidence 0.45)
  - package.json at web_src/package.json
  - package manager: npm (web_src/package-lock.json)
  - no runnable scripts in package.json
- **PythonDetector** (confidence 0.55)
  - python manifests: requirements.txt, pyproject.toml
  - .: python entrypoint scripts/web.py (framework unconfirmed)

## Startup verification

- Environment: existing repository `.venv`; no installation or repository modification.
- Start: `launcher start bullet-engine`; service reached HTTP 200 on port 8000.
- Stop: `launcher stop bullet-engine`; port 8000 closed and the owned process tree was removed.
- Health check: HTTP `http://localhost:8000`.
- This was the successful custom-script-style Python case: a README-referenced `scripts/*.py` entrypoint rather than a conventional FastAPI module.

