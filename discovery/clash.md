# Discovery: clash

- Path: `/home/penguin/code/clash`
- Confidence: **0.95**
- Unsafe to auto-run: no
- Stack signals: Node

## Services

### frontend
- Command: `npm run dev`
- Working directory: `.`
- Port: 3000
- Health: {"type":"http","url":"http://localhost:3000","startPeriodMs":30000}

## Detector evidence

- **NodeDetector** (confidence 0.95)
  - package.json at package.json
  - package manager: npm (package-lock.json)
  - script "dev": `next dev`
  - package name: clash
- **EnvFileDetector** (confidence 0.40)
  - env files present: .env.example

## Ambiguous alternates (need a human decision)

- `npm start` — role frontend

