# Discovery: musicalbook

- Path: `/home/penguin/code/musicalbook`
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
  - package name: adaptive-soundtrack-reading

## Ambiguous alternates (need a human decision)

- `npm run preview` — role frontend

## Startup verification

- Environment: existing `node_modules`; no installation or repository modification.
- Start: `launcher start musicalbook`; Vite reported ready in 434 ms and health was HTTP 200 on port 5173.
- Restart: `launcher restart musicalbook` stopped and started the service successfully.
- Stop: `launcher stop musicalbook`; port 5173 closed and no Vite processes remained.
- Health check: HTTP `http://localhost:5173`.

