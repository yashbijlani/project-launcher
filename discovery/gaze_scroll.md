# Discovery: gaze_scroll

- Path: `/home/penguin/code/gaze_scroll`
- Confidence: **0.95**
- Unsafe to auto-run: no
- Stack signals: Node

## Services

### frontend
- Command: `npm run dev`
- Working directory: `.`
- Port: 5173
- Health: {"type":"http","url":"http://localhost:5173","startPeriodMs":30000}

## Detector evidence

- **NodeDetector** (confidence 0.95)
  - package.json at package.json
  - package manager: npm (package-lock.json)
  - script "dev": `vite`
  - package name: gaze-scroll

## Ambiguous alternates (need a human decision)

- `npm run preview` — role frontend

## Startup verification

- Environment: existing `node_modules`; no installation or repository modification.
- Start: `launcher start gaze-scroll`; service reached HTTP 200 on port 5173.
- Process supervision: Vite and its esbuild child were in one tracked process group.
- Stop: `launcher stop gaze-scroll`; port 5173 closed and no Vite/esbuild processes remained.
- Health check: HTTP `http://localhost:5173`.
- Shutdown: clean SIGTERM/SIGKILL process-group cleanup; no unrelated processes targeted.

