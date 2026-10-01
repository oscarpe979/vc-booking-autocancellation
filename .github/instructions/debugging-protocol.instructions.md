# Debugging Protocol

Apply this file when diagnosing a reported bug, error, or regression. The senior-engineering instructions remain the default for implementation and verification.

## Diagnose Before Changing Code

- Reproduce or inspect the failure using the smallest authoritative check available.
- Compare actual and expected state, then state one falsifiable hypothesis before editing.
- Use existing tests, logs, status queries, or debugger data before adding instrumentation.
- Add temporary diagnostic logging only when existing evidence cannot distinguish the plausible causes. Remove it after diagnosis unless it provides meaningful production feedback.
- Do not revert user changes to isolate a cause. Use version-control history, focused tests, or a minimal reproduction instead.

## RoomOS-Specific Diagnosis

- Treat xAPI status as the source of truth when state may have changed outside the macro. Local state may track workflow ownership, timers, or a verified snapshot.
- Check asynchronous command failures and execution-time limits when a macro appears unresponsive or restarts.
- Use the macro's existing log prefix and log only state changes, safety decisions, command outcomes, and failures that an operator can act on.
