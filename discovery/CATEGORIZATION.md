# Corpus categorization

Corpus examined: `/home/penguin/code` (with `/home/penguin/code/project-launcher` excluded).
Method: shallow inventory, bounded manifest/README extraction, deterministic detectors,
and selective startup tests. No repository was modified to run these tests.

## Category A — recognizable single-service projects

- `gaze_scroll`: Node/Vite frontend, `npm run dev`, port 5173.
- `bullet_engine`: custom Python web entrypoint, `.venv/bin/python scripts/web.py`, port 8000.
- `clash`: Node/Next frontend, `npm run dev`, port 3000.
- `musicalbook`: Node/Vite frontend, `npm run dev`, port 5173.
- `desktop-tutor`: Python/Qt desktop demo, `python3 scripts/run_demo.py`; GUI dependencies unavailable.
- `gods-eye-view`: Node/Vite application with several maintenance scripts.
- `geb`: static web/research bundle rather than a runnable service.

## Category B — recognizable multi-service projects

- `restaurantbills`: Next frontend plus FastAPI backend.
- `human-broker`: JavaScript app plus FastAPI API, with infrastructure-only Compose.
- `jobhunter`: Compose-managed database, backend, and frontend.
- `polymarket`: Compose-managed PostgreSQL, API, five workers, and frontend.
- `prospectpilot`: Compose-managed database, Redis, backend, and worker.
- `book-copilot`: Compose-managed database, API, and web.

## Category C — Docker-managed projects

- `agentdock`
- `book-copilot`
- `human-broker` (infrastructure only)
- `jobhunter`
- `polymarket`
- `prospectpilot`

Local Docker was unavailable because the Docker daemon was down. Compose files were
parsed and validated with `docker compose config`; no images were built or started.

## Category D — mobile/device projects

- `blindfold-chess`
- `camera-copilot`
- `infinite_zoom`
- `phoneaway`
- `rune`

These are Gradle/Android projects. Their explicit commands are build/install commands,
not local web services. They were not built because doing so requires device,
emulator, SDK, and dependency downloads.

## Category E — unknown, custom, or repository-scale projects

- `freedom`: mixed security/recon/toolkit repository containing an explicitly
  vulnerable local web target.
- `omarchy`: operating-system/desktop configuration and installation repository.
- `vercel`: very large pnpm/workspace monorepo in which nested examples are not
  representative of the repository itself.
- `geb`: static/research content.
- `microsaas`: documentation/data only.

## Category F — do not auto-run

- `freedom`: entrypoint explicitly says it is intentionally vulnerable.
- `omarchy`: installer/system configuration repository.
- `vercel`: large deployment/build monorepo.
- `agentdock`: Compose configuration mounts the Docker socket.
- All Category D projects: device/emulator required.
- `polymarket` worker/browser automation and `jobhunter` browser automation were
  documented but not started.

## Representative test subjects

- Single-service Node: `gaze_scroll`, `musicalbook`.
- Custom Python entrypoint: `bullet_engine`.
- Multi-service with dependencies: `restaurantbills`.
- Hybrid infrastructure plus app: `human-broker`.
- Compose-managed: `book-copilot`.
- GUI/custom: `desktop-tutor`.
- Android: `rune`.
- Explicitly unsafe: `freedom`.
- Workspace/monorepo boundary: `vercel`.
- System/operations boundary: `omarchy`.
