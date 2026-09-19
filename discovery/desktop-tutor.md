# Discovery: desktop-tutor

- Path: `/home/penguin/code/desktop-tutor`
- Confidence: **0.55**
- Unsafe to auto-run: no
- Stack signals: Python

## Services

### backend
- Command: `python3 scripts/run_demo.py`
- Working directory: `.`

## Detector evidence

- **PythonDetector** (confidence 0.55)
  - python manifests: requirements.txt
  - .: python entrypoint scripts/run_demo.py (framework unconfirmed)
- **EnvFileDetector** (confidence 0.40)
  - env files present: .env.example

## Startup verification

- Not started.
- Classification if attempted now: `MISSING_DEPENDENCY`.
- Evidence: `PySide6` is absent from system Python and the repository has no local virtual environment.
- Additional concern: `.env.example` exposes optional AI credentials/settings and the project involves screen capture, desktop overlay, and automation modes.
- The deterministic proposal remains ambiguous and requires manual environment setup plus explicit user approval.

