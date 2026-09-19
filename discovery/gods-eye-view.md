# Discovery: gods-eye-view

- Path: `/home/penguin/code/gods-eye-view`
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
  - package name: gods-eye-view
- **EnvFileDetector** (confidence 0.40)
  - env files present: .env.example

## Ambiguous alternates (need a human decision)

- `npm run preview` — role frontend

