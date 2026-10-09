# Decisions

One entry per decision: **date — what** — why.

- **2026-10-09 — Test command is `npm test || npm test`** — the jsdom suite is timing-based (PBKDF2 plus 20-60 ms ticks) and fails intermittently under CPU load (seen on about 1 in 4 runs); a real failure fails twice. Fix the tick waits in tests/helpers.js to drop the retry.
