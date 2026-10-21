# 11: Fleet Roster, Room Enrollment & Durable Configuration Store

**What to build:** The service manages only the rooms an administrator has explicitly enrolled. All admin-controlled state survives restarts.

- The durable `IFleetConfigStore` port (defined in ticket 01) holds:
  - the roster (one entry per workspace: managed device, mode, inventory status, native CheckIn baseline);
  - the fleet settings (kill switch, tripped tripwire, timings, exemptions, SMTP);
  - an append-only audit log.
- The read-only `IFleetInventoryDriver` (defined in ticket 01, Webex implementation in ticket 07) discovers workspaces from Control Hub. Every newly discovered workspace is recorded as `DISABLED`.
- A roster gate discards every event from `DISABLED`, unrostered, missing, or mismatched devices, and blocks outbound commands and configuration writes to them.
- Mode changes follow the fixed promotion path and the transition rules in LLD §5.7.
- The kill switch and tripwire are fleet gates (LLD §5.8). Sprint 1 delivers the persisted `tripwireTrippedAt` flag, its admin reset, and the fleet-gate behaviour; tripwire rate detection is Sprint 2.

Sprint 1 delivers the domain logic and the `JsonFileFleetConfigStore` laptop adapter. `DynamoFleetConfigStore`, its DynamoDB instance lease, and its Terraform tables ship with the AWS infrastructure in Sprint 2, against the same port contract tests.

**Blocked by:** 01: Core Scaffolding & End-to-End Tracer Bullet, 05: Startup Quarantine, Booking Policy & Lifecycle Guards

**Status:** ready-for-agent

- [ ] `JsonFileFleetConfigStore` implements `IFleetConfigStore` (LLD §2.2: `loadRoster`, `loadSettings`, versioned conditional `putRosterEntry` and `putSettings` where a stale version raises `ConflictError`, and `appendAudit`), persisting to gitignored `service/.local/fleet-config.json` and `fleet-audit.jsonl` with the same version semantics; a fresh file has an empty roster
- [ ] A brand-new store is seeded with `FleetSettings` from environment / `.env.local` values (or defaults); once the store exists, those values are ignored and the store is authoritative
- [ ] A reusable port contract test suite exercises any `IFleetConfigStore` implementation (it is reused for the DynamoDB adapter in Sprint 2)
- [ ] Inventory reconciliation (startup and with the Tier 2 sweeper every 15 minutes) behaves as follows:
  - a new workspace becomes a `DISABLED` entry, audited `RoomDiscovered`;
  - several booking-capable devices give `AmbiguousWorkspace` with `deviceId = null`;
  - a vanished managed device is marked `Missing` and its actor is torn down; if the same device reappears, its actor is recreated with startup semantics (an in-progress meeting is quarantined, ticket 05);
  - a different device in the workspace gives `DeviceMismatch`, a system demotion to `DISABLED`, and a cleared native CheckIn baseline;
  - a managed device listed as `disconnected` halts any countdown or prompt and preserves the booking;
  - the system never promotes a room
- [ ] `RoomScheduler` Navigators and peripherals are never roster candidates
- [ ] The Tier 2 sweeper only detects and blocks: offline or missing devices and configuration drift are flagged, active workflows are cancelled, and the booking is demoted to `Blocked / RequiredConfigurationsUnavailable`. It never restores readiness, starts a workflow, or writes configuration (recovery stays event-driven)
- [ ] The roster gate discards ingress events for any device that is not an enrolled, `Present`, matching, non-`DISABLED` room; discards are counted per reason without per-event logging
- [ ] The outbound command gate (consumed by the ticket 07 adapter) rejects every xCommand and configuration write to gated devices, and to `MONITOR_ONLY` devices except the mode-transition clean-up; while a fleet gate is active it also rejects `Bookings.CheckIn` and `Bookings.CheckOut` commands and `Bookings.CheckIn.Enabled` writes for every device, and still allows presence baseline and `Bookings.CheckIn.WindowDuration` writes (LLD §5.12)
- [ ] Mode changes are persisted before they are applied and audited (actor, before, after). Only these transitions are allowed: `DISABLED → MONITOR_ONLY | DRY_RUN`, `MONITOR_ONLY → DRY_RUN`, `DRY_RUN → LIVE`, `LIVE → DRY_RUN`, and any demotion to `MONITOR_ONLY` or `DISABLED`; the system may only demote to `DISABLED`
- [ ] Before the first device write, entering `DRY_RUN` records `nativeCheckInBaseline` (`Bookings.CheckIn.Enabled` and `WindowDuration`); demotion to `MONITOR_ONLY` or `DISABLED` cancels all timers and prompts and restores that baseline (RoomAnalytics settings are left as written), and a failed clean-up flags `CleanupIncomplete`; `LIVE → DRY_RUN` cancels any active workflow, clears prompts, and applies the dry-run baseline (`False`)
- [ ] Promotion into `DRY_RUN` or `LIVE`, and `LIVE → DRY_RUN`, with a meeting in progress quarantines it (`AwaitingStartupCheckIn`, ticket 05); a `DRY_RUN` simulated check-in never carries over to `LIVE`
- [ ] `MONITOR_ONLY` actors subscribe to presence and availability, compute utilization metrics, hold no countdown, prompt, or automatic check-in timers, and make no device writes, emails, or simulated workflow; there is no automatic exit from `MONITOR_ONLY` (it is an optional step)
- [ ] Startup loads settings and roster before any actor is registered or the roster gate opens; if the store is unreachable, reads are retried with capped backoff (1s, 2s, 5s, 10s, then every 30s) and the dashboard banner state **Configuration store unavailable: automation halted** is exposed; until the store loads, every event is discarded and no device is touched; there is no fallback to defaults or a cached file
- [ ] During a runtime store outage, the service runs on the last-known-good roster and settings and rejects writes, except kill-switch activation
- [ ] The kill switch is active if either the stored value or `AUTOCANCEL_KILL_SWITCH` is true; the parameter is re-read every 30 seconds (`KILL_SWITCH_PARAMETER_POLL_MS`; environment on the laptop, SSM in AWS); an unreadable parameter keeps its last value and one never read since startup counts as active. Activation applies in memory even if persisting fails (`active (not persisted)`, retried until persisted); deactivation requires a successful persist
- [ ] A tripped tripwire persists `tripwireTrippedAt` across restarts until an admin resets it; `DRY_RUN` simulated releases never count toward it
- [ ] Fleet-gate behaviour (LLD §5.8): while the kill switch or tripwire is active, every `DRY_RUN` and `LIVE` actor cancels its active countdown, simulated warning, and visible prompt (workflow invalidated, prompts cleared, chime stopped, volume restored in `LIVE`), preserves the booking, starts no new countdown, prompt, warning email, or automatic check-in, and issues no CheckOut, including a user-confirmed one. No native CheckIn write is made on activation, on deactivation, or while a gate is active (including the midnight and recovery re-apply); presence baseline and CheckIn window writes still run. After deactivation, rooms resume on their next relevant event or midnight check
- [ ] Single active instance: before opening the roster gate, the service acquires the instance lease with a stable host holder ID. `JsonFileFleetConfigStore` holds the lease in memory (a single process); the DynamoDB `INSTANCE_LEASE` item is Sprint 2. On lease loss, the instance stops every device command and configuration write and stops starting workflows; when the lease is re-acquired, every actor re-applies its mode's configuration writes and then runs a full revalidation (LLD §5.12) before automation resumes
- [ ] Automated tests cover new-workspace discovery, device replacement, an ambiguous workspace, a `Missing` device reappearing, a disconnected device, Tier 2 detect-and-block, event discards, the command gate, mode-transition rules and the quarantine on promotion, `MONITOR_ONLY` making no writes, restarts with a persisted kill switch and roster, the kill switch cancelling an active workflow, store-unavailable startup, and lease loss
