# Discovery: freedom

- Path: `/home/penguin/code/freedom`
- Confidence: **0.50**
- Unsafe to auto-run: **yes** (tools/claude-bug-bounty/serve.py is explicitly marked as an intentionally vulnerable local target)
- Stack signals: Node, Python, Rust

## Services

### backend-tools-claude-bug-bounty
- Command: `python3 serve.py`
- Working directory: `tools/claude-bug-bounty`

## Detector evidence

- **NodeDetector** (confidence 0.60)
  - package.json at recon/intuition/package.json
  - package manager: bun (recon/intuition/bun.lock)
  - scripts present but no dev/start: clean, build, build:ts, extract, build:package, prepublishOnly
  - package name: @0xintuition/contracts-v2
- **PythonDetector** (confidence 0.55)
  - python manifests: tools/claude-bug-bounty/requirements.txt
  - tools/claude-bug-bounty: python entrypoint tools/claude-bug-bounty/serve.py (framework unconfirmed)
- **RustDetector** (confidence 0.50)
  - Cargo.toml at recon/kast/Cargo.toml
- **UnsafeProjectDetector** (confidence 0.70)
  - tools/claude-bug-bounty/serve.py is explicitly marked as an intentionally vulnerable local target

## Startup verification

- Not started.
- Classification: intentionally unsafe to auto-run.
- The nested entrypoint is explicitly documented as vulnerable and local-only.
- Any future execution requires explicit user approval and an isolated local environment.

