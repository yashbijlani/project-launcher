# Discovery results

Experiment date: 2026-09-19 UTC  
Corpus: `/home/penguin/code`  
Prototype: `/home/penguin/code/project-launcher`  
Corpus projects examined, excluding the prototype itself: **23**

No repository source, configuration, dependency, or Git history was edited. Dependencies were
not installed. Services were not exposed publicly. Successful runtime tests necessarily left
normal generated/cache artifacts in the tested repositories, such as service logs and
frontend build caches.

## Headline numbers

- Automatically understood: **10**
  - Definition: at least one proposed service and overall confidence `>= 0.80`.
- Detected but ambiguous: **10**
  - Definition: at least one proposed service but overall confidence `< 0.80`.
- Nothing detected: **3**
  - `geb`, `microsaas`, and `omarchy`.
- Explicitly unsafe to auto-run: **7**
  - `agentdock`
  - `blindfold-chess`
  - `camera-copilot`
  - `freedom`
  - `infinite_zoom`
  - `phoneaway`
  - `rune`
- Fully verified start/health/stop/cleanup on real corpus projects: **4**
  - `gaze_scroll`
  - `bullet_engine`
  - `musicalbook`
  - `restaurantbills`
- Real corpus services started and cleanly stopped: **5**
- Transient real startup failure before a detector fix: **1**
  - `restaurantbills`
- Runtime Docker startups: **0**
  - The Docker daemon was unavailable.
- Live AI startups or proposals: **0**
  - No AI provider was configured; the deterministic core was tested alone.

These numbers describe discovery proposals and only the startups actually attempted. They do
not claim that every high-confidence proposal was executed.

## Common stacks

- Node/Vite single-page frontends:
  - `gaze_scroll`
  - `musicalbook`
- Node/Next frontends:
  - `clash`
  - `restaurantbills`
- FastAPI backends:
  - `restaurantbills`
  - `human-broker`
  - `jobhunter`
  - `polymarket`
  - `prospectpilot`
  - `book-copilot`
- Compose-managed PostgreSQL:
  - `book-copilot`
  - `human-broker`
  - `jobhunter`
  - `polymarket`
  - `prospectpilot`
- Compose-managed Redis or workers:
  - `human-broker`
  - `prospectpilot`
  - `polymarket`
- Custom Python entrypoints:
  - `bullet_engine`
  - `desktop-tutor`
- Gradle/Android:
  - `blindfold-chess`
  - `camera-copilot`
  - `infinite_zoom`
  - `phoneaway`
  - `rune`

## Startup verification

| Project | Services tested | Attempt | Result | Failure class | Resolution |
|---|---|---|---|---|---|
| `gaze_scroll` | `frontend` | `npm run dev` | Success; HTTP 200 on 5173; stop closed port and removed Vite/esbuild processes | None | None |
| `musicalbook` | `frontend` | `npm run dev` | Success; Vite ready in 434 ms; HTTP 200; restart and stop verified | None | None |
| `bullet_engine` | `backend` | `.venv/bin/python scripts/web.py` | Success; HTTP 200 on 8000; stop removed owned process | None | None |
| `restaurantbills` | `backend` | `.venv/bin/python -m uvicorn main:app --reload` from `backend/` | Failed with relative-import `ImportError` | `WRONG_MODULE_PATH` | Detector now runs `backend.main:app` from repository root |
| `restaurantbills` | `backend`, `frontend` | Package-root backend plus frontend depending on backend | Success; backend TCP-ready, frontend HTTP 200; reverse-order stop verified | None after fix | Manual dependency and TCP health retained in YAML |
| `book-copilot` | `db`, `api`, `web` | `docker compose config` only | Compose topology parsed successfully | `DOCKER_REQUIRED` | No containers started because daemon was unavailable |
| `human-broker` | `postgres`, `redis`, app, API | Discovery only | Correct hybrid proposal; no startup | `DOCKER_REQUIRED` | Infrastructure must be healthy before app services |
| `desktop-tutor` | `backend` | Discovery only | Proposal found, but not executed | `MISSING_DEPENDENCY` | `PySide6` absent and no local venv |
| `rune` | `android` | Discovery only | Correct build commands, but not executed | `DEVICE_REQUIRED` | Android SDK/device required |
| `freedom` | nested Python target | Discovery only | Correct command identified, but not executed | Unsafe target | Explicit vulnerable-local marker blocks auto-run |
| `vercel` | nested example | Discovery only | Initially misleading repository-wide proposal | `AMBIGUOUS` | Monorepo warning and reduced confidence |
| `geb`, `microsaas`, `omarchy` | none | Discovery only | Correct refusal to invent commands | `AMBIGUOUS` or `UNKNOWN` | Manual configuration required |

A separate synthetic fixture verified dependency order `c → b → a`, stopping a service also
stops its dependents, profiles, actions, crash detection, and restart behavior. Those were
harness tests, not corpus startups.

## False positives corrected

1. Python package execution:
   - `restaurantbills` initially used the wrong module path.
   - Fixed by detecting relative imports and running from the package root.
2. Uvicorn dependency inference:
   - `vercel` initially produced `uvicorn main.py:app` for a FastHTML example.
   - The detector now prefers the documented runnable script when no ASGI object exists.
3. Monorepo promotion:
   - A nested example was allowed to represent the entire `vercel` repository.
   - The detector now warns and caps confidence when no root start command exists.
4. Framework text without an application object:
   - FastAPI/uvicorn text alone no longer earns high confidence.
5. Unsafe-target handling:
   - `freedom` initially produced an ordinary Python service.
   - Explicit vulnerable-local text now marks the project unsafe.
6. Interpreter portability:
   - A repository-root virtual environment is now expressed relative to the service
     working directory where applicable.

## False negatives corrected

1. README-referenced Python entrypoints:
   - `bullet_engine` initially had no service because its command was `scripts/web.py`.
   - Script scanning now considers documented and directly runnable Python files.
2. Nested entry paths:
   - Nested manifests no longer emit absolute command paths.
   - Commands are expressed relative to the selected service directory.

Remaining non-failures are intentional refusals: static content, documentation-only material,
system installers, devices, unavailable Docker, and vulnerable targets.

## Docker findings

- Six corpus projects use Compose.
- `book-copilot` exposes a particularly informative topology:
  - database health-gated startup;
  - API bound to its container network;
  - web frontend dependent on the API;
  - separate internal and public API URLs.
- `human-broker` demonstrates the hybrid pattern:
  - Compose contains only infrastructure;
  - applications run locally;
  - infrastructure health must precede app startup.
- Because the daemon was unavailable, no image was built and no container lifecycle,
  volume behavior, or Compose shutdown path was validated.

## Main boundary discovered

Deterministic detection works well for:

- explicit Node `dev`/`start` scripts;
- explicit FastAPI application objects;
- explicit Compose service graphs;
- explicit Gradle build/test commands;
- documented script entrypoints.

It becomes ambiguous when:

- a repository is a workspace rather than one deployable app;
- documentation and packaging disagree about working directory;
- relative imports require package-root execution;
- infrastructure exists outside the launcher’s control;
- dependencies are absent and must not be installed automatically;
- commands require credentials, hardware, devices, browsers, models, or destructive access.

Those are precisely the cases where the launcher preserves alternates, lowers confidence,
marks a project unsafe, or refuses to invent a command.

## V2 addendum

V2 re-ran discovery over the live corpus and added readiness, provenance, runtime
kinds, workspace targets, and verification. The corpus changed between V1 and V2:
`vercel`, `omarchy`, and `gods-eye-view` are no longer present, and
`autonomous-contributor` appeared. Current per-project reports live in
`discovery/<project>.md` and the current summary in `discovery/SUMMARY.md`.

V2 snapshot (21 projects):

- automatically understood (confidence >= 0.8, >= 1 service): **9**
- detected but ambiguous: **9**
- nothing detected / unknown: **3**
- unsafe to auto-run: **7**
- readiness `needs_device`: **5**
- readiness `needs_docker`: **3**
- readiness `needs_credentials`: **2**
- readiness `ready_but_unverified`: **5**

Verified with real start/health/stop/cleanup evidence: `gaze_scroll`, `musicalbook`,
`bullet_engine`, and the multi-service `restaurantbills` (backend -> frontend).

New in V2 discovery:

- services carry provenance (detector + confidence + evidence);
- services carry a runtime kind (`process`, `compose`, `device`, `external`);
- workspace globs are expanded so monorepo targets are exposed (`launcher targets`);
- FastAPI health checks suggest `/docs` rather than assuming `/`;
- every project gets a readiness classification with structured blockers.

The deterministic/ambiguous boundary from V1 still holds. V2 adds a second, sharper
boundary: confidence (how sure discovery is) is now separate from verification
(whether the exact configuration was actually proven to start, become healthy, and
stop cleanly).
