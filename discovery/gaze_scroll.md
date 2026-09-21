# Discovery: gaze_scroll

- Path: `/home/penguin/code/gaze_scroll`
- Confidence: **0.95**
- Readiness: **ready_but_unverified**
- Unsafe to auto-run: no
- Stack signals: Node

## Services

### frontend
- Command: `npm run dev`
- Working directory: `.`
- Port: 5173
- Health: {"type":"http","url":"http://localhost:5173","startPeriodMs":30000}
- Provenance: detector/node (confidence 0.95)

## Detector evidence

- **NodeDetector** (confidence 0.95)
  - package.json at package.json
  - package manager: npm (package-lock.json)
  - script "dev": `vite`
  - package name: gaze-scroll

## Ambiguous alternates (need a human decision)

- `npm run preview` — role frontend

