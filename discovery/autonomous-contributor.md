# Discovery: autonomous-contributor

- Path: `/home/penguin/code/autonomous-contributor`
- Confidence: **0.00**
- Readiness: **unknown**
- Unsafe to auto-run: no
- Stack signals: Docker, Python

## Blockers

- [unknown] No services configured; run discovery or add services manually

## Services

_None detected. Manual configuration required._

## Detector evidence

- **DockerDetector** (confidence 0.60)
  - Dockerfile at docker/Dockerfile
- **PythonDetector** (confidence 0.40)
  - python manifests: pyproject.toml
- **EnvFileDetector** (confidence 0.40)
  - env files present: .env, .env.example

## Warnings

- No deterministic startup command was found. Manual configuration is required.
