# Discovery: desktop-tutor

- Path: `/home/penguin/code/desktop-tutor`
- Confidence: **0.55**
- Readiness: **needs_credentials**
- Unsafe to auto-run: no
- Stack signals: Python

## Blockers

- [credentials] .env is missing; 1 required variable(s) are empty in .env.example
  - suggestion: Copy .env.example to .env and fill in the required values manually

## Services

### backend
- Command: `python3 scripts/run_demo.py`
- Working directory: `.`
- Provenance: detector/python (confidence 0.55)

## Detector evidence

- **PythonDetector** (confidence 0.55)
  - python manifests: requirements.txt
  - .: python entrypoint scripts/run_demo.py (framework unconfirmed)
- **EnvFileDetector** (confidence 0.40)
  - env files present: .env.example

