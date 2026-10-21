---
paths:
  - "codec-native/**/*.js"
---

# RoomOS Macro Development

Applies to RoomOS macro code. Supplements `senior-engineering.md` and does not replace local code conventions.

## Runtime And xAPI

- Target QuickJS with ES6 syntax and `import xapi from 'xapi';`; do not depend on CommonJS or transpilation.
- Use `const` by default and `let` for mutable state. Do not use `var`.
- Read relevant xAPI status during startup and subscribe to status for persistent device state; use events for momentary user actions.
- Treat xAPI status as authoritative. Local state is permitted for timers, in-flight operations, workflow ownership, and snapshots that are invalidated or reconciled against xAPI.
- Handle every xAPI operation deliberately with `try`/`catch` or `.catch()`.

## Resource And UI Safety

- Avoid synchronous waits and unbounded loops. Use timers for delays and cancel timers when their workflow ends.
- Bound or stagger command bursts to protect the shared macro process and xAPI command queue.
- For UI extension events, check both the widget identifier and event type. Reset persistent UI state during startup when it could be stale after a restart.

## HttpClient

- Use HTTPS, restrict allowed hosts, set `ResponseSizeLimit`, and never hardcode credentials.
