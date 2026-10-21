# Booking Auto Cancellation

Releases ghost-booked meeting rooms (Cisco RoomOS + Exchange via Webex Hybrid Calendar) only when release is provably safe. The governing invariant everywhere: **when safety cannot be proven, preserve the booking and take no booking-changing action.** `CheckOut` only, never `Delete`.

Engineering standards live in `.claude/rules/` (always loaded; `roomos-macro-dev.md` loads for `codec-native/**/*.js`). Diagnosis and Git delivery rules are the `debugging-protocol` and `git-workflow` skills. These are Claude Code translations of `.github/instructions/*.instructions.md` (the same rules for GitHub Copilot); when one changes, update its counterpart.

## Two halves

- **`codec-native/`: implemented, validated.** A single-room QuickJS macro (`BookingAutoCancellation.js`, v0.1.4) plus its executable contract `test_BookingAutoCancellation.js`. `docs/BookingAutoCancellationSpec.md` is the authoritative behaviour contract (edge-case matrix §16, regression list §17); the HLD/User Manual are governance/operator views.
- **`service/`: docs only, no code yet.** A planned Node/TypeScript hexagonal service for ~800 rooms (Webex Workspace Integration, long-polling, SMTP notifications, admin dashboard). Read in order: `ServiceMasterSpec.md` → `ServiceHighLevelDesign.md` → `ServiceDomainDrivenDesign.md` → `ServiceLowLevelDesign.md`. Sprint 1 work is `.doc/sprints/sprint-1/` (Sprint1Spec + tickets 01–11; 01 is the tracer bullet and unblocks 07/10).
- `.doc/` also holds Webex reference notes and the workspace-integration manifest sample.

The service claims "100% parity" with the macro. **When service docs and the macro disagree, the macro + its spec is the validated behaviour**; flag the conflict instead of silently picking one.

## Running the macro tests

`node codec-native/test_BookingAutoCancellation.js` (no deps, built-ins only; `DEBUG_TEST=1` echoes macro logs). Fail-fast: the first failing assert aborts the run.

Harness gotchas: the macro runs in `vm` with `import xapi` stripped and `AUTO_RELEASE_BOOKING_TEST_MODE` set, so tests call `init()` themselves; timers are mocks fired by hand (`findTimeoutWithDelay(ms)` → `await t.callback()`), and the clock does not advance; some tests locate timers via `callback.toString()`, so renaming macro functions can break them; Test 1 hardcodes `version=0.1.4`. New tests follow the existing `// ---- TEST N ----` block pattern with `createFreshSandbox()` + `loadMacroWithTestConfig(s)`.

## Macro architecture (one file, numbered sections)

01 constants/CONFIG → 02 runtime state (`bookingLifecycle` object) → 03 transitions → 04 presence/prompt surfaces → 05 booking snapshot → 06 policy (`Allowed`/`Blocked` + block reason) → 07 native CheckIn (FIFO write queue) → 08 automatic CheckIn → 09 midnight health check → 10 release workflow → 11 prompt surfaces/expiry/final validation → 12 event handlers/booking sync/readiness recovery → 13 init → 14 logger (defined last; only used inside functions). Place new code in its owning section.

Load-bearing concepts:
- **Generations** (`bookingGeneration`, `runtimeStateVersion`, `releaseWorkflowGeneration`, recovery generation) are captured before every await and rechecked after; stale completions must do nothing.
- **Autocancellation status** is identity-bound to booking ID + end timestamp, and it owns the native `Bookings.CheckIn.Enabled` policy (Allowed→True, VerifyingMeetingLength→no write, other Blocked→False).
- **Startup quarantine** (`AwaitingStartupCheckIn`) is cleared only by a matching RoomOS `Bookings.CheckedIn` event, never by a dry-run simulated CheckIn.
- `FreeUntil`'s TimeStamp is the *next* booking start, never a current end.
- Presence during a visible prompt keeps the prompt (the user can act); presence before the prompt cancels the countdown.
- Dry run (default `DRY_RUN_MODE: true`) omits the post-timeout grace period and still writes RoomAnalytics config and disables native CheckIn.
- Logging: `console.log` is reserved for checkout events (`event=CHECKOUT`); routine info goes to `debug`.

## Scope decision (user, 2026-10-16)

The service matches the macro's room behaviour exactly and keeps its service-only extras (email, VIP/keyword exemptions, rollout modes, kill switch, tripwire, dashboard), which may only add reasons to preserve a booking. The LLD transition matrix (§3.2), JIT checklist (§5.5), and native CheckIn ownership (§5.6) encode the macro parity.

Fleet decisions (user, 2026-10-16), detailed in LLD §5.7, §7.1, and §8:
- Modes are `DISABLED` (the default for every discovered room: events discarded, nothing sent), `MONITOR_ONLY` (permanent and read-only, for sensitive rooms), `DRY_RUN`, and `LIVE`.
- Only admins promote rooms, and `LIVE` is reachable only from `DRY_RUN`. Time in dry run is the admin's judgement. The system may only demote.
- Admin-controlled state lives in DynamoDB behind `IFleetConfigStore`, with a JSON-file adapter on laptops. Room runtime state stays in memory.
- The architecture sketch is `.doc/Autocancellation Components Diagram.pdf`; the DDD mermaid diagram is its maintained text version.
- Dashboard access is interim: it binds to `127.0.0.1` and uses a shared `ADMIN_DASHBOARD_PASSWORD` (audit actor `admin`). In AWS, admins reach it through SSM Session Manager port forwarding. SSO and roles are deferred (Entra ID OIDC with app roles is the recommended gate before the first production `LIVE` room).
- Compute: one `systemd`-supervised process on a single EC2 RHEL 9 instance (no Auto Scaling Group; an AZ outage fails closed); `GET /healthz` lists the core issues and the service pushes the same snapshot to the local Dynatrace OneAgent; Dynatrace (the run team's tool) raises all alerts, with no custom monitor script (LLD §7.3); OS patching belongs to the Suncorp Wintel team, with reboots outside business hours (`service/docs/adr/ADR-002-compute-ec2-rhel.md`).
- Location-limited Webex activation blocks commands and status reads outside the permitted locations (`403`), but **not** the device list or config writes. The roster gate is the primary control.
- **`Bookings.CheckedIn` is never delivered to Workspace Integrations**, and controller topology isn't subscribable. Check the live list (`https://xapi-a.wbx2.com/xapi/api/apps/supportedSubscriptions`) before relying on any event.
  - CheckIn confirmation is the service's own CheckIn success, an `AlreadyCheckedIn` response (stricter than macro TEST 34A), or `BookedFromDevice`. No relay macro, no CheckIn "probe" command.
  - Pending DT1: if `Bookings.Get`/`List`/xStatus expose CheckIn state, read it at No-Show countdown start and as JIT check 12; if not, the empty-room manual check-in gap applies (LLD §5.9, §5.14). Emails are informational only: no links, buttons, or instructions to tap anything.
  - Startup quarantine lasts until the meeting ends.
  - Controller topology is read just in time: before and after display, on each 60 s chime tick, and before CheckOut. No listener, no polling timer (LLD §5.11).
  - Midnight, recovery, reconnect and lease re-acquire re-apply the mode's settings, then re-verify, with per-room midnight jitter (LLD §5.12).
  - A reboot is detected from `SystemUnit.Uptime` (countdown start, chime tick, JIT): abort, preserve, restart with startup quarantine. `BootEvent` is pre-restart, an early trigger only (LLD §5.13).
  - Device tests DT1–DT5 are tracked in `.scratch/codec-tests.md`.
- **Kill switch / tripwire** stop all automation: they cancel workflows, block every CheckOut, and make no native CheckIn writes (presence and window re-apply still runs). The SSM parameter is re-read every 30 s.
- **Warning email:** a failure keeps the prompt and blocks release for the rest of the lifecycle. One email is sent per warning deadline.
- **Tier 2 sweeper:** detect and block only.

## Repo hygiene

Everything is tracked (user, 2026-10-21): `.claude/` (these rules and skills), `.github/instructions/` (the same rules for Copilot), `.doc/` (sprint spec and tickets, Webex notes, manifest sample, components diagram), and `.scratch/` (pending items and the codec spike). Never commit `.claude/settings.local.json` (personal Claude Code permissions) or `service/.local/` (the laptop config store); both are gitignored. Commits go straight to `main` for now (`git-workflow` skill).
