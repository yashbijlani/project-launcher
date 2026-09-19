# Discovery: vercel

- Path: `/home/penguin/code/vercel`
- Confidence: **0.60**
- Unsafe to auto-run: no
- Stack signals: Docker, Node, FastAPI, Python, Monorepo, Rust, Go

## Services

### backend-examples-fasthtml
- Command: `python3 main.py`
- Working directory: `examples/fasthtml`
- Port: 5001
- Health: {"type":"http","url":"http://localhost:5001","startPeriodMs":45000}

## Detector evidence

- **DockerDetector** (confidence 0.60)
  - Dockerfile at examples/react-router/Dockerfile
- **NodeDetector** (confidence 0.60)
  - package.json at package.json
  - package manager: pnpm (pnpm-lock.yaml)
  - scripts present but no dev/start: build, vercel-build, pre-commit, test, test-unit, test-e2e
  - package name: vercel-monorepo
- **FastAPIDetector** (confidence 0.35)
  - fastapi/uvicorn referenced in examples/fasthtml/requirements.txt, pyproject.toml
  - no ASGI application object was found
- **PythonDetector** (confidence 0.55)
  - python manifests: examples/fasthtml/requirements.txt, pyproject.toml
  - examples/fasthtml: uvicorn is present but no ASGI app object was identified; using script examples/fasthtml/main.py
- **MonorepoDetector** (confidence 0.75)
  - workspace package with no root dev/start/serve script: packages/*, api, examples, internals/*, python/vercel-runtime, python/vercel-workers
  - Nested example or package commands cannot safely be promoted to the whole-repository startup command.
- **RustDetector** (confidence 0.50)
  - Cargo.toml at Cargo.toml
- **GoDetector** (confidence 0.60)
  - go.mod at examples/gin/go.mod

## Warnings

- This is a workspace monorepo without a root start command. The proposed command belongs to one nested package/example and must be confirmed before use.

## Startup verification

- Not started.
- Classification: `MISSING_DEPENDENCY` plus `AMBIGUOUS` repository scope.
- Evidence: system Python lacks `fasthtml`, and the repository forbids using examples for ad hoc testing.
- Earlier detector versions incorrectly proposed `uvicorn main.py:app`; the corrected detector proposes the documented `python main.py` while keeping the result below automatic-start confidence.
- The correct deterministic outcome is user selection of a package or action, not automatic startup of the whole monorepo.

