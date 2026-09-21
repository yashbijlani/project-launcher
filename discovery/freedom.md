# Discovery: freedom

- Path: `/home/penguin/code/freedom`
- Confidence: **0.50**
- Readiness: **unsafe**
- Unsafe to auto-run: **yes** (tools/claude-bug-bounty/serve.py is explicitly marked as an intentionally vulnerable local target)
- Stack signals: Python, Rust

## Blockers

- [unsafe] tools/claude-bug-bounty/serve.py is explicitly marked as an intentionally vulnerable local target

## Services

### backend-tools-claude-bug-bounty
- Command: `python3 serve.py`
- Working directory: `tools/claude-bug-bounty`
- Provenance: detector/python (confidence 0.55)

## Detector evidence

- **PythonDetector** (confidence 0.55)
  - python manifests: tools/claude-bug-bounty/requirements.txt
  - tools/claude-bug-bounty: python entrypoint tools/claude-bug-bounty/serve.py (framework unconfirmed)
- **RustDetector** (confidence 0.50)
  - Cargo.toml at recon/kast/Cargo.toml
- **UnsafeProjectDetector** (confidence 0.70)
  - tools/claude-bug-bounty/serve.py is explicitly marked as an intentionally vulnerable local target

