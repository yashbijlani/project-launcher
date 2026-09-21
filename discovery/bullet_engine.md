# Discovery: bullet_engine

- Path: `/home/penguin/code/bullet_engine`
- Confidence: **0.55**
- Readiness: **ready_but_unverified**
- Unsafe to auto-run: no
- Stack signals: Node, Python

## Services

### backend
- Command: `.venv/bin/python scripts/web.py`
- Working directory: `.`
- Port: 8000
- Health: {"type":"http","url":"http://localhost:8000","startPeriodMs":45000}
- Provenance: detector/python (confidence 0.55)

## Detector evidence

- **NodeDetector** (confidence 0.45)
  - package.json at web_src/package.json
  - package manager: npm (web_src/package-lock.json)
  - no runnable scripts in package.json
- **PythonDetector** (confidence 0.55)
  - python manifests: requirements.txt, pyproject.toml
  - .: python entrypoint scripts/web.py (framework unconfirmed)

