# Sprint 1 Specification: Core Engine & Local Laptop Foundation

## Problem Statement

Engineers need to build, run, test, and validate the external Booking Auto Cancellation service directly on their local development laptops within a corporate network environment, without depending on external databases, public inbound IPs, or cloud infrastructure.

Before deploying to AWS, the team must prove that:

1. The core autocancellation state machine accurately ports the validated codec-native logic.
2. The Hexagonal port contracts (LLD §2.2: the room drivers `IRoomPresenceDriver`, `IRoomInteractionDriver`, `ICalendarDriver`, `IDeviceConfigDriver`, `INotificationDriver`, plus `IEventIngressTransport`, `IFleetInventoryDriver`, and `IFleetConfigStore`) properly decouple domain rules from device SDKs, mail transports, and storage.
3. The service can ingest live device telemetry via outbound long-polling using Webex Workspace Integrations.
4. The Startup Check-In Quarantine and the Just-In-Time (JIT) pre-checkout validation work reliably in real-time execution.

---

## Solution

Sprint 1 delivers a functional, locally executable Node.js/TypeScript service implementing the core domain engine, the Webex Workspace Integration adapter, and an outbound long-polling ingress transport.

Sprint 1 delivers:

1. Complete TypeScript project scaffolding in the `service` directory with strict typing, configuration loading, and unit/integration test tooling.
2. The core domain state machine ported from the validated macro, managing in-memory room actors with policy parity (including audio chime alerts, prompt restoration, dual presentation, minimum remaining time guard, and ad hoc booking handling). Where a Webex platform limit forces it, the service is stricter and fails closed (LLD §9); for example, `Bookings.CheckedIn` is not delivered to Workspace Integrations, so startup quarantine lasts until the meeting ends (LLD §5.9). Every intentional difference from the macro is listed in LLD §5.14; all but one add a reason to preserve a booking, and the one platform gap depends on device test DT1.
3. Every port contract from LLD §2.2: presence, user interaction, calendar operations, device configuration, email notifications, event ingress, fleet inventory, and the fleet configuration store.
4. The `WebexWorkspaceAdapter` implementing the presence, interaction, calendar, device configuration, and fleet inventory ports using the official `workspace-integrations` SDK, and enforcing the outbound roster and command gate on every command and configuration write.
5. The `LongPollingTransport` allowing zero-firewall event ingestion on corporate laptops (with webhooks deferred to a future phase).
6. The Two-Tier Reconciler: Tier 1 is the synchronous Just-In-Time (JIT) pre-checkout verification, 50ms sync coalescing, and 5-step bounded readiness recovery; Tier 2 is the 15-minute sweeper, which only detects and blocks (offline, missing, configuration drift) and never restores readiness or rewrites configuration.
7. End-user email notification delivery via corporate SMTP (`outlook.suncorp.com.au:25`), featuring dynamic time calculation to the fixed warning deadline, one warning email per deadline, the fail-closed warning email gate (bypassed when `NOTIFICATIONS_ENABLED=false`), and differentiated templates for No-Show vs Early Departure releases.
8. Configurable exemption engine (duration threshold, VIP organizers, title keywords) and a lightweight Google-style `/admin` dashboard (localhost, shared password) including room enrollment, kill switch, settings, and live SMTP configuration controls.
9. A comprehensive test suite including virtualized time testing, a mock driver harness, and in-memory notification capture.
10. A fleet roster with explicit room enrollment: discovered rooms default to `DISABLED`, and their events are discarded. The durable `IFleetConfigStore` port is delivered with a local JSON-file adapter; the DynamoDB adapter ships with the AWS infrastructure in Sprint 2.

---

## User Stories

1. As a software engineer, I want a TypeScript project structure with build and test scripts, so that I can compile, run, and test the service locally.
2. As a software engineer, I want process configuration (Webex credentials, dashboard password, kill switch parameter, ingress mode) loaded from environment variables and `.env.local`, and fleet settings (timeouts, grace periods, SMTP) held in the fleet configuration store and seeded from those values on first run, so that I can configure the service easily on my laptop.
3. As a software engineer, I want the core room state machine to manage meeting lifecycles in memory, so that rooms transition accurately between Idle, Quarantined, ActiveMeeting, CountdownScheduled, PromptPending (DRY_RUN), PromptVisible (LIVE), ValidatingJIT, and Released states.
4. As a software engineer, I want the domain logic isolated behind the LLD §2.2 ports (`IRoomPresenceDriver`, `IRoomInteractionDriver`, `ICalendarDriver`, `IDeviceConfigDriver`, `INotificationDriver`, `IEventIngressTransport`, `IFleetInventoryDriver`, `IFleetConfigStore`), so that the core engine has zero direct dependencies on Cisco xAPI, specific mail transports, or a specific database.
5. As a software engineer, I want a Webex adapter implementing the driver interfaces via `workspace-integrations`, so that the service can communicate with real Cisco codecs.
6. As a software engineer working on a corporate laptop, I want the service to ingest Webex events via outbound long-polling, so that I can receive live room events without opening inbound ports or running tunneling tools.
7. As a software engineer, I want an in-memory room registry, so that multiple rooms can be simulated or managed concurrently during local testing.
8. As a meeting attendee, I want meetings already in progress when the service starts (or when a room is promoted) to be quarantined until they end, so that service restarts and mode changes never cancel ongoing meetings.
9. As a meeting attendee, I want an empty room to trigger an actionable warning on the touch controller before any cancellation, so that I can tap "Keep Booking" to preserve the space.
10. As a meeting attendee, I want tapping "Keep Booking" to dismiss the prompt and reset the countdown safely, so that my meeting remains reserved.
11. As a meeting attendee, I want tapping "Check Out" on the controller to prompt for confirmation and then release the room, so that I can free up unused space intentionally.
12. As a meeting organizer, I want meetings longer than two hours to be exempt from autocancellation, so that prolonged meetings are never cancelled automatically.
13. As an enterprise IT collaboration administrator, I want a Just-In-Time release validation executed immediately before checkout, so that a room is preserved if someone walks in right before the release command.
14. As an enterprise IT collaboration administrator, I want dry-run mode supported per room, so that simulated prompt displays, email dispatches, and release intents are logged without sending destructive commands to live rooms or real users.
15. As a software engineer, I want unit tests using virtualized clocks, so that 10-minute timeouts and countdown warning windows can be tested deterministically in milliseconds.
16. As a software engineer, I want a mock driver test harness, so that I can simulate complete end-to-end meeting lifecycles without connecting to physical hardware or mail servers.
17. As an in-room meeting participant, I want an audible alert chime played at 70% volume with automatic restoration when the warning appears, so that I notice the warning even if not looking at the touch panel.
18. As an in-room meeting participant who dismissed the prompt without making a choice, I want the prompt to be automatically restored for the remaining warning duration, so that accidental swipes do not lead to unintentional cancellation.
19. As an executive or VIP meeting organizer, I want meetings organized by designated VIPs or containing specific title keywords to be automatically exempt from autocancellation, so that mission-critical corporate meetings are never cancelled.
20. As an enterprise IT collaboration administrator, I want a lightweight web dashboard to view live room statuses, toggle the emergency kill switch, and update exemption rules, timeout parameters, and SMTP configuration without modifying code or restarting the service, with every change persisted and audited.
21. As a meeting organizer with a short remaining meeting duration (e.g. 12 minutes or less), I want autocancellation skipped, so that meetings about to conclude naturally are preserved without nuisance warnings.
22. As an in-room meeting organizer who booked the room directly from the touch controller (ad hoc), I want my booking treated as already checked in, so that the service sends no automatic check-in and never treats it as a no-show.
23. As a meeting organizer away from the room, I want an urgent warning email sent to my inbox when the room warning prompt displays, stating the real remaining minutes to the release deadline and the local release time, so that I am alerted to the impending cancellation.
24. As a meeting organizer, I want automatic release blocked and my booking preserved if the warning email cannot be sent (unless notifications are disabled fleet-wide), so that I am protected against unannounced cancellations.
25. As a meeting organizer whose room was cancelled, I want to receive a cancellation notice email detailing the room name, scheduled time, and whether it was released due to a No-Show or an Early Departure, so that I have a clear record of why the space was freed.
26. As an enterprise IT collaboration administrator, I want workspaces newly added to Control Hub to be recorded as `DISABLED`, with all of their events discarded, so that no room is ever enrolled in autocancellation without my explicit decision.
27. As an enterprise IT collaboration administrator, I want to see which workspaces were discovered but not enrolled, and which managed devices went missing or were replaced, so that I know exactly what a fleet change means for the service.
28. As an enterprise IT collaboration administrator, I want room enrollment, modes, the kill switch, and all settings to survive service restarts, with an audit trail of who changed what, so that a restart never silently resumes automation or forgets a decision.
29. As an enterprise IT collaboration administrator, I want promotion to `LIVE` to show a readiness report and require my explicit confirmation, so that a room goes live only on my judgement.

---

## Implementation Decisions

### 1. Project Scaffolding & Configuration

- Set up `package.json`, `tsconfig.json`, ESLint/Prettier, and Vitest in the `service` directory.
- Configuration is split in two:
  - **Process configuration**, a strongly typed `Config` schema read from `process.env` and `.env.local`:
    - Webex credentials (`WEBEX_CLIENT_ID`, `WEBEX_CLIENT_SECRET`, `WEBEX_REFRESH_TOKEN`, `WEBEX_APP_URL`, `WEBEX_OAUTH_URL`).
    - `ADMIN_DASHBOARD_PASSWORD` (required; the dashboard binds to 127.0.0.1 and refuses to start without it).
    - `AUTOCANCEL_KILL_SWITCH` (second kill-switch source; re-read every 30 seconds, LLD §8.5).
    - `NOTIFICATION_MODE` (ingress mode, fixed to `longpolling` for Phase 1; webhook deferred).
  - **`FleetSettings`**, held in `IFleetConfigStore` and edited from the dashboard (LLD §2.2). Environment / `.env.local` values only seed a brand-new store; after that, the store is authoritative. Settings are validated per LLD §5.10 and apply only to new workflows:
    - `EMPTY_ROOM_TIMEOUT_MS` (default 10 minutes)
    - `PRE_TIMEOUT_WARNING_MS` (default 5 minutes)
    - `POST_TIMEOUT_GRACE_PERIOD_MS` (default 2 minutes)
    - `LONG_MEETING_EXEMPTION_THRESHOLD_MS` (default 120 minutes)
    - `EXEMPT_ORGANIZERS` (comma-separated list of VIP emails)
    - `EXEMPT_TITLE_KEYWORDS` (comma-separated list of title keywords)
    - `AUTOMATIC_CHECK_IN_DELAY_MS` (default 3 seconds)
    - `BOOKING_SYNC_COALESCE_DELAY_MS` (default 50 ms)
    - `BOOKING_READINESS_RECOVERY_DELAYS_MS` (default `[250, 500, 1000, 2000, 4000]`)
    - `EARLY_DEPARTURE_RELEASE_ENABLED` (boolean, default false)
    - `NATIVE_CHECK_IN_WINDOW_MINUTES` (default 60; allowed 5, 10, 15, 20, 30, 60; must exceed the `LIVE` release horizon)
    - `ULTRASOUND_SENSOR_ENABLED` (boolean, default false)
    - `NOTIFICATIONS_ENABLED` (boolean, default true)
    - `SMTP_HOST` (default `outlook.suncorp.com.au`)
    - `SMTP_PORT` (number, default 25)
    - `SMTP_FROM` (default `no-reply-roombookings@suncorp.com.au`)
    - `SMTP_SECURE` (boolean, default false)
    - The kill switch and the tripped tripwire state.
- There is no global dry-run flag: the operating mode is per room, in the roster.

### 2. Hexagonal Domain Interfaces

Define the port contracts exactly as in LLD §2.2:

- `IRoomPresenceDriver`: `getPresence(roomId)`, `onPresenceChange(handler)`.
- `IRoomInteractionDriver`: `readPromptSurfaces(roomId)` (never rejects; `inventoryReadable`, sorted `controllerIds`, `interactiveOsd`), `displayPrompt(roomId, prompt, surfaces)` (always `Target=Controller`; returns `controllerCommandAccepted`, the coordinator decides ownership), `restoreDismissedPrompt(roomId, target, prompt)`, `clearPrompts(roomId, kind)`, `playAudioAlert(roomId)` (one alert; the coordinator owns the 4s hold and 60s repeat), `restoreAudioVolume(roomId)`, `onPromptResponse(handler)`, `onPromptCleared(handler)`.
- `ICalendarDriver`: `getAvailability(roomId)`, `getBookingDetails(roomId, bookingId)`, `getCurrentBooking(roomId)`, `getCheckInState(roomId, bookingId)` (pending device test DT1; removed if DT1 is negative), `checkIn(roomId, bookingId, trackingData)` returning `CheckInResult` (`CheckedIn`, `AlreadyCheckedIn`, `Failed`), `checkOut(roomId, bookingId, reason: 'NoShow' | 'EarlyDeparture' | 'UserConfirmed')`. There is no CheckIn event handler: `Bookings.CheckedIn` is not delivered to Workspace Integrations (LLD §5.9).
- `IDeviceConfigDriver`: `enforceBaselinePresenceConfig(roomId, ultrasoundEnabled)`, `getNativeCheckInEnabled(roomId)`, `getNativeCheckInWindow(roomId)`, `enforceNativeCheckInWindow(roomId, windowMinutes)`, `setNativeCheckInEnabled(roomId, enabled)`, `getCodecTime(roomId)`, `getUptimeSeconds(roomId)` (`SystemUnit.Uptime`), `onBootEvent(handler)` (early trigger only).
- `INotificationDriver`: `sendCancellationWarning(payload)`, `sendCancellationNotice(payload)`.
- `IEventIngressTransport`: `start()`, `stop()`, `onNotification(handler)`, `onConnectivityChange(handler)`.
- `IFleetInventoryDriver`: `listDevices()` (read-only Control Hub device list).
- `IFleetConfigStore`: `loadRoster()`, `loadSettings()`, `putRosterEntry(entry, expectedVersion)`, `putSettings(settings, expectedVersion)`, `appendAudit(record)`.

### 3. Core Room State Machine & Workflow Coordinator

- Port the state machine and policy rules from the codec-native macro to TypeScript classes, following the LLD transition matrix (§3.2):
  - Phases: `Idle`, `Quarantined`, `ActiveMeeting`, `CountdownScheduled`, `PromptPending` (`DRY_RUN` only), `PromptVisible` (`LIVE` only), `ValidatingJIT`, `Released`.
  - Generational counters (`bookingLifecycleId`, `releaseWorkflowId`, `statusEventVersion`) preventing asynchronous races.
  - Startup Check-In Quarantine (`AwaitingStartupCheckIn`) for a booking already active when the actor is created (service start, store load, promotion into `DRY_RUN`/`LIVE`, a `Missing` device reappearing). It lasts until the meeting ends.
  - CheckIn confirmation (LLD §5.9): the service's own successful CheckIn, an `AlreadyCheckedIn` result (how the service learns of a RoomOS native check-in; treating it as confirmation is an intentional, preserve-side difference from macro TEST 34A), `BookedFromDevice = True` (always read, because the service always calls `getBookingDetails()`), or, pending device test DT1, a `CheckedIn` read of the booking's CheckIn state. A `DRY_RUN` simulated CheckIn selects the policy only and never clears quarantine. There is no relay macro and no CheckIn command sent only to discover state.
  - Residual gap if DT1 is negative: a panel check-in followed by an empty room for the whole timeout still gets the countdown, prompt, and warning email, and is released if nobody answers. The warning email is informational only (ticket 10).
  - Minimum remaining time guard, a countdown-start check: a countdown starts only when `timeRemaining` is strictly greater than the release horizon (`EMPTY_ROOM_TIMEOUT_MS + POST_TIMEOUT_GRACE_PERIOD_MS` in `LIVE`, $> 12$ min by default; `EMPTY_ROOM_TIMEOUT_MS` in `DRY_RUN`).
  - Ad hoc booking: `BookedFromDevice === 'True'` records CheckIn confirmation without sending a command, so the booking never enters No-Show.
  - Native CheckIn ownership by the identity-bound status (LLD §5.6).
  - External release observation: detect when availability becomes `Free`/`FreeUntil` externally and emit `[EXTERNAL_RELEASE_OBSERVED]` audit log.
  - Codec-local timezone offset calculation for midnight health check (`CodecTimeUnavailable` guard), run at codec-local midnight plus a per-room jitter of up to 15 minutes.
  - Configuration re-apply (LLD §5.12): actor start, midnight, readiness recovery, ingress reconnect, and lease re-acquire apply the mode's configuration writes first (presence baseline and CheckIn window for `DRY_RUN`/`LIVE`; `Enabled=False` in `DRY_RUN`; the native CheckIn policy in `LIVE`; nothing for `MONITOR_ONLY`), then re-verify.
  - Device reboot detection (LLD §5.13): `SystemUnit.Uptime` is read when a countdown starts, on each 60 s chime tick, and at JIT. A detected reboot aborts with `device_rebooted_during_workflow`, preserves the booking, and restarts the actor with startup semantics. `BootEvent` is an early trigger only.
  - Controller prompt surfaces (LLD §5.11): a Navigator controller is assumed and every prompt is sent with `Target=Controller`. Ownership needs a controller on the reads just before and just after display; each 60 s chime tick re-reads and re-displays with the remaining time on a change; JIT blocks release on an unreadable read, zero controllers, or a changed controller set.
- **Mode scoping** (LLD §3.2, §5.7):
  - `DISABLED`: no actor; every event is discarded at the roster gate.
  - `MONITOR_ONLY`: the actor subscribes to presence and availability and computes utilization metrics only. It holds no countdown, prompt, or automatic CheckIn timers, makes no device writes, sends no emails, and runs no simulated workflow. There is no automatic exit; it is an optional step.
  - `DRY_RUN`: every device-facing side effect is replaced by its dry-run log. The release horizon and warning deadline have no grace period, and JIT skips the actionable-surface check.
  - `LIVE`: full behaviour.
- **Fleet gates** (LLD §5.8): while the kill switch or tripwire is active, active workflows are cancelled and prompts cleared, no new countdown, prompt, warning email, or automatic CheckIn starts, no CheckOut is issued (including user-confirmed), and no native CheckIn write is made on activation, on deactivation, or while a gate is active. Presence baseline and CheckIn window writes still run at midnight and recovery.

### 4. Two-Tier Reconciler, Coalescing & Bounded Recovery

- **50ms Booking Sync Coalescing**: Buffers rapid bursts of `BookedUntil` and `TimeStamp` events.
- **5-Step Bounded Readiness Recovery**: Retries transient missing metadata on `[250ms, 500ms, 1000ms, 2000ms, 4000ms]`. Each attempt rebuilds the full snapshot using `Bookings.Get({ Id })` for a known ID or `Bookings.List({ ScheduleType: 'Current', Limit: 1 })` when the ID is missing. Exhaustion preserves the booking (LLD §5.3).
- **JIT Release Validation**: Synchronous check at the warning deadline running every check of the release validation checklist (LLD §5.5, including the controller-set check 5, service-only gates 9 and 10, the uptime check 11, and the CheckIn state check 12 pending DT1) before calling `checkOut()`.
- **Tier 2 Sweeper** (every 15 minutes, with inventory sync): detect and block only. Offline or missing devices and configuration drift are flagged, active workflows cancelled, and bookings demoted to `RequiredConfigurationsUnavailable`. It never restores readiness, starts a workflow, or writes configuration.
- **Macro parity**: Room behavior follows the codec-native specification and the LLD transition matrix (§3.2). In particular, occupancy before the warning cancels the countdown; occupancy while the prompt is visible retains the prompt (expiry then aborts with `room_not_confirmed_empty`); dismissal restores it; and a user-confirmed checkout uses reason `UserConfirmed` with no cancellation receipt.

### 5. Webex Workspace Integration Adapter

- Implement `WebexWorkspaceAdapter` wrapping the official `workspace-integrations` SDK. It implements the presence, interaction, calendar, device configuration, and fleet inventory ports.
- Support xStatus reads (`RoomAnalytics.RoomInUse`, `Bookings.Availability`, `Bookings.Current.Id`, `Peripherals.ConnectedDevice`, `SystemUnit.ProductPlatform`, `SystemUnit.Uptime`, `Time.SystemTime`). Controller topology cannot be subscribed to, so it is read just in time at fixed workflow points (LLD §5.11), with no listener and no polling timer.
- Support xCommands (`UserInterface.Message.Prompt.*`, `Audio.Volume.*`, `Audio.Sound.*`, `Bookings.CheckIn`, `Bookings.CheckOut`, `Bookings.Get`, `Bookings.List`). `Bookings.CheckOut` works only while `Bookings.CheckIn.Enabled = True`. "Already checked in" is classified by substring (exact text pending DT2). `Bookings.CheckIn` and `Bookings.CheckOut` are never retried automatically, except after a `429` received before dispatch.
- Support xConfigs (`RoomAnalytics.*` batched with `setMany` where possible, `Bookings.CheckIn.WindowDuration` from `NATIVE_CHECK_IN_WINDOW_MINUTES`, `Bookings.CheckIn.Enabled` with FIFO serialization queue).
- Support xEvents (`UserInterface.Message.Prompt.Response` with `OptionId` normalized to a string, `UserInterface.Message.Prompt.Cleared`, and the optional `BootEvent`). There is no `Bookings.CheckedIn` subscription.
- Implement `listDevices()` from the Control Hub device list (`connected_with_issues` maps to `connected`; `RoomScheduler` Navigators and accessories are not booking-capable).
- Enforce the outbound roster and command gate (LLD §7.1) on every xCommand and configuration write.
- Retry HTTP `429` with jittered backoff honoring `Retry-After` (the SDK does not).
- Filter out non-controller peripherals (e.g. `RoomScheduler`).

### 6. Outbound Long-Polling Ingress Transport

- Implement `LongPollingTransport`; long polling starts automatically inside the SDK's `connect({ notifications: 'longpolling' })`. The internal polling function is never called directly.
- Connect to Webex cloud message queue via outbound HTTPS with zero inbound ports.
- Report poll errors and recovery through `onConnectivityChange`; a reconnection triggers a full revalidation of every actor (LLD §7.2).
- The SDK cannot stop polling, so shutdown closes the roster gate and exits the process.
- Webhook transport is deferred to a future phase.

### 7. In-Memory Room Registry & Exemption Engine

- Manage room state machines in memory (`Map<string, RoomWorkflowCoordinator>`). Only rooms whose roster mode is `MONITOR_ONLY`, `DRY_RUN`, or `LIVE` and whose inventory status is `Present` have an actor.
- Evaluate exemption rules: duration threshold, VIP organizer email list, and title keywords.
- Support per-room operating modes (`DISABLED`, `MONITOR_ONLY`, `DRY_RUN`, `LIVE`), stored in the roster and changed only along the LLD §5.7 transitions.

### 8. Lightweight "Google-Style" Admin & Configuration Dashboard

- Fastify-embedded `/admin` web interface, bound to 127.0.0.1 and protected by the shared `ADMIN_DASHBOARD_PASSWORD`; it refuses to start without it.
- 1-click Emergency Kill Switch (activation applies in memory immediately, even during a store outage; deactivation requires a successful persist) and tripwire reset.
- Search bar to search rooms by name, room ID, organizer, or status.
- Real-time fleet status table showing mode, lifecycle phase, presence, block reason, and countdown timer.
- Enrollment view (discovered workspaces; `Missing`, `DeviceMismatch`, `AmbiguousWorkspace`, `CleanupIncomplete` rooms) and the `DRY_RUN → LIVE` readiness report with explicit, audited confirmation (LLD §8.6).
- Web form allowing administrators to view and update timeout durations, long meeting thresholds, VIP organizer exemptions, per-room operational modes, and SMTP relay settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_SECURE`, `NOTIFICATIONS_ENABLED`) without code changes. Every change is validated (LLD §5.10), persisted through `IFleetConfigStore` before it is applied, and audited.

### 9. Corporate SMTP Email Notification Engine

- **Decoupled Outbound Port**: Encapsulated behind `INotificationDriver` and implemented via `SmtpNotificationAdapter` connecting to `outlook.suncorp.com.au:25` as an unauthenticated direct relay (standard for corporate internal smart hosts).
- **Warning Email Gate (Fail-Closed)** (LLD §5.8): When `NOTIFICATIONS_ENABLED = true`, one warning email is sent to the organizer per warning deadline. If delivery fails after immediate retries, or the organizer email is missing, the prompt stays visible, `warningEmailFailed` is set for the lifecycle, automatic release is blocked at JIT, and no further countdown starts in that lifecycle. With `NOTIFICATIONS_ENABLED = false`, no warning email is sent and the gate does not block release.
- **Dynamic Timing & Local Clock Presentation**: The warning email states the real time remaining to the fixed deadline (`promptExpiresAt`, which includes the grace period in `LIVE`; never hardcoded) and displays the release time in the codec's local clock timezone.
- **Informational Only** (LLD §6.2): the warning states that the room was detected as empty, the release time, and that the reservation is not released if someone is in the room at that time or the booking is kept using the touch controller in the room. No links, buttons, or CheckIn claims, so it stays true in the residual gap pending DT1.
- **One Email per Deadline**: A new deadline (fresh countdown after Keep Booking, or the unconfirmed-guard restore) sends a new email; prompt dismissals and restorations (`restoreDismissedPrompt`) keep the deadline and send none.
- **Differentiated Cancellation Receipts**: Upon a successful automatic release, dispatches a conclusive receipt explicitly distinguishing **No-Show Release** from **Early Departure Release**. A `UserConfirmed` CheckOut sends none.
- **Mode handling**: in `DRY_RUN`, real emails are suppressed and `[DRY RUN - WOULD_SEND_EMAIL]` satisfies the gate; `MONITOR_ONLY` never calls the notification driver.
- **Template Architecture**: Multipart MIME (HTML + RFC-compliant plain text) with corporate styling, meeting title, room location, and plain informational wording (no links or buttons).
- **Local Development**: Emulated via `MockNotificationDriver` with formatted terminal logging and in-memory capture for test assertions.

---

## Testing Decisions

### 1. Unit Testing with Mock Drivers

- Use Vitest with fake timers (`vi.useFakeTimers()`).
- Create `MockPresenceDriver`, `MockInteractionDriver`, `MockCalendarDriver`, `MockDeviceConfigDriver`, `MockNotificationDriver`, `MockFleetInventoryDriver`, and an in-memory `IFleetConfigStore`.
- Run a reusable port contract test suite against every `IFleetConfigStore` implementation (`JsonFileFleetConfigStore` now; `DynamoFleetConfigStore` in Sprint 2).
- Test scenarios:
  1. Standard No-Show Release (empty room $\to$ countdown $\to$ prompt display $\to$ warning email dispatched $\to$ deadline $\to$ JIT check $\to$ checkout $\to$ cancellation email dispatched).
  2. Prompt Response "Keep Booking" (clears the prompt, resets the countdown; a later warning has a new deadline and a new email; prompt restoration sends no duplicate email).
  3. Prompt Response "Check Out" (triggers confirmation prompt, confirms checkout with reason `UserConfirmed` and no cancellation receipt).
  4. Audio Chime & Volume Override (verifies volume set to 70, sound played, volume restored after 4s, repeated every 60s).
  5. Dismissed Prompt Restoration (dismissal without selection restores the dismissed target for the remaining duration; deadline unchanged).
  6. Occupancy Detection: occupancy during the countdown cancels it and schedules automatic CheckIn; occupancy while the prompt is visible keeps the prompt, and expiry aborts with `room_not_confirmed_empty`, preserves the booking, and schedules automatic CheckIn; in `DRY_RUN`, occupancy during `PromptPending` cancels the simulated warning.
  7. Startup Quarantine (meeting active on boot enters quarantine and is never released or prompted until the meeting ends).
  8. Long Meeting Exemption (meetings > 120 minutes are blocked from autocancellation).
  9. VIP Organizer & Title Keyword Exemption (exempt meetings are blocked from autocancellation).
  10. Minimum Remaining Time Guard (a countdown starts only when `timeRemaining` is strictly greater than the horizon).
  11. Ad Hoc Booked from Device (recorded as CheckIn confirmation with no command; never enters No-Show).
  12. JIT Abort on Late Presence (room empty during countdown, becomes occupied at the deadline; checkout blocked).
  13. Bounded Readiness Recovery (simulates missing booking ID on event, verifies 5-step recovery and List fallback).
  14. Warning Email Delivery Failure (warning email fails; the prompt stays visible; automatic release is blocked at expiry; booking preserved; no further countdown this lifecycle).
  15. Dry-Run Suppression (simulates all steps, confirms no device command is sent and real emails are suppressed with structured logs emitted).
  16. New Workspace Discovery (new workspaces become `DISABLED` entries; their events are discarded; no command or configuration write reaches them).
  17. Device Replacement (a different device in the workspace demotes the room to `DISABLED` with `DeviceMismatch`; the new device is never touched).
  18. Store Unavailable at Startup (no actor is registered, every event is discarded, and no device is touched until the store loads).
  19. Kill Switch Survives Restart (activate the kill switch, restart; it is still active and no release occurs).
  20. Kill Switch Cancels Workflow (activating the kill switch cancels an active countdown or prompt, preserves the booking, and blocks a user-confirmed CheckOut).
  21. Mode Promotion Quarantine (promoting a room with a meeting in progress to `DRY_RUN` or `LIVE` quarantines that meeting).
  22. Controller Ownership (ownership only when a controller is present on the reads before and after display; a chime-tick read with a changed controller set re-displays for the remaining time and the JIT check blocks release; a controller connecting mid-prompt in a room that had none is not given the prompt).
  23. Device Reboot Detection (an uptime lower than the baseline, or less than the workflow age, aborts with `device_rebooted_during_workflow` and quarantines the in-progress meeting; an unreadable uptime starts no countdown and blocks release; a `BootEvent` cancels the workflow without releasing).
  24. Midnight Re-Apply (configuration writes run before re-verification, per mode; none for `MONITOR_ONLY`; presence and window writes only while a fleet gate is active; per-room jitter).
  25. Already Checked In (an `AlreadyCheckedIn` result confirms CheckIn, so a later vacancy starts no No-Show: the documented difference from macro TEST 34A).

### 2. Integration Testing with Recorded Webex Payloads

- Test `LongPollingTransport` and event dispatching against serialized real-world Webex notification JSON payloads.

### 3. Pending Device Tests

Run on a real codec as the ticket 05 spike; the procedure is in `.scratch/codec-tests.md`. Until the results are recorded, the fail-closed rules in the LLD apply.

- **DT1**: whether `Bookings.Get`, `Bookings.List`, or an xStatus exposes a booking's CheckIn state. Decides between the `getCheckInState()` read and the documented residual gap (LLD §5.9).
- **DT2**: the exact "already checked in" error text over SSH and through the cloud.
- **DT3**: `Prompt.Display Target=Controller` with no controller connected.
- **DT4**: `SystemUnit.Uptime` across a reboot and `BootEvent` timing.
- **DT5**: `Prompt.Cleared` and `Peripherals.ConnectedDevice` when a Navigator reboots mid-prompt.

---

## Out of Scope for Sprint 1

1. **AWS Infrastructure & CloudWatch Deployment**: Provisioning of the EC2 instance, the release deployment, VPC routes and endpoints, and SSM parameters via Terraform is scheduled for Sprint 2, together with the Dynatrace health push and the Dynatrace alert configuration (LLD §7.3). The `GET /healthz` endpoint itself ships in Sprint 1 (ticket 08).
2. **Inbound Webhook HTTP Server**: Deferred to a future release; initial implementation uses outbound long-polling.
3. **DynamoDB Adapter & Tables**: `DynamoFleetConfigStore`, its `INSTANCE_LEASE` item, and its Terraform-provisioned tables are scheduled for Sprint 2. Sprint 1 persists admin-controlled state through the same port using `JsonFileFleetConfigStore`, which holds the instance lease in memory. Room runtime state is never persisted.
4. **Automated Anomaly Tripwire Rate Detection**: Fleet-wide cancellation rate detection across hundreds of rooms is scheduled for Sprint 2. Sprint 1 delivers only the persisted `tripwireTrippedAt` flag, its admin reset, and the fleet-gate behaviour (LLD §5.8).
5. **Dashboard SSO, Roles, and Remote Access**: Sprint 1 uses a localhost-only dashboard with a shared password and audit actor `admin`.

---

## Sprint 1 Work Items / Ticket Breakdown

The following vertical slices represent the implementation tickets for Sprint 1 (published in `.doc/sprints/sprint-1/tickets/`):

- **TICKET-01: Core Scaffolding & End-to-End Tracer Bullet** (`01-core-scaffolding-tracer-bullet.md`)
  - Initialize `service` folder with `package.json`, `tsconfig.json`, Vitest, and linter.
  - Implement process configuration from `.env.local` and environment variables (Webex credentials, `ADMIN_DASHBOARD_PASSWORD`, `AUTOCANCEL_KILL_SWITCH`, ingress mode); type `FleetSettings`, which live in `IFleetConfigStore`.
  - Define the LLD §2.1 domain types and every LLD §2.2 port: `IRoomPresenceDriver`, `IRoomInteractionDriver`, `ICalendarDriver`, `IDeviceConfigDriver`, `INotificationDriver`, `IEventIngressTransport`, `IFleetInventoryDriver`, `IFleetConfigStore`, with mocks for each.
  - Implement in-memory room registry and prove end-to-end idle-to-active monitoring tracer bullet.

- **TICKET-02: No-Show Release Workflow & Just-In-Time Release Validation** (`02-no-show-release-jit-verification.md`)
  - Implement 50ms booking sync coalescing and 5-step bounded readiness recovery with `Bookings.List` fallback.
  - Implement the countdown-start horizon (strict >; `LIVE` includes grace, `DRY_RUN` does not), the uptime baseline, the CheckIn state read (pending DT1), and the fixed warning deadline.
  - Implement the full JIT checklist (LLD §5.5, including the controller-set check 5, gates 9 and 10, the uptime check 11, and check 12 pending DT1), `RoomUseStatusUnavailable` on unknown presence, and fleet-gate checks.
  - Implement CheckOut (pending service CheckOut marked first; rejection gives `CheckOutFailed`, never `Delete`) and the No-Show cancellation notice.
  - Implement `DRY_RUN` timing and logs (`PromptPending`, no grace, no actionable-surface check, `WOULD_RELEASE`).

- **TICKET-03: In-Room User Interaction (Audio Chimes, Prompts & Check Out)** (`03-in-room-user-interaction.md`)
  - Implement just-in-time controller reads (before and after display, on each 60s chime tick with re-display on a change, at JIT), ownership capture (`controllerIdsAtDisplay`), dual presentation with `Target=Controller` always, and the no-actionable-surface path (strictly ignoring `RoomScheduler`).
  - Implement prompt text variants (`INITIAL` vs `REPEATED`).
  - Implement audio alert chime (volume 70, hold 4s, restore to default, repeat every 60s).
  - Dispatch the warning email per deadline under the ticket 10 email gate.
  - Implement restoration of the dismissed target only, with the deadline unchanged and no new email.
  - Implement "Keep Booking" with presence revalidation and the two-step "Check Out" confirmation guard (`UserConfirmed`, fleet gates clear, no notice).

- **TICKET-04: Occupancy Interruption & Automatic Check-In** (`04-occupancy-interruption-auto-checkin.md`)
  - Occupancy before the prompt cancels the countdown; occupancy during a visible prompt keeps the prompt and aborts the release at expiry; `DRY_RUN` `PromptPending` occupancy cancels the simulated warning.
  - Implement one automatic CheckIn per lifecycle (`BookingAutoCancellation_Automatic`, revalidated) and `CheckInResult` handling (`AlreadyCheckedIn` confirms, a documented difference from macro TEST 34A; failure never blocks No-Show).
  - Treat `BookedFromDevice = True` as CheckIn confirmation without a command or automatic CheckIn; implement `DRY_RUN` intent and simulated CheckIn logs.

- **TICKET-05: Startup Quarantine, Booking Policy & Lifecycle Guards** (`05-startup-quarantine-long-meeting-guards.md`)
  - Implement Startup Check-In Quarantine (`AwaitingStartupCheckIn`) on actor creation, lasting until the meeting ends; run the codec spike (device tests DT1 to DT5, `.scratch/codec-tests.md`).
  - Implement Long-Meeting, VIP organizer, title keyword, and unclassifiable booking classification.
  - Implement native CheckIn ownership (LLD §5.6) per status and mode.
  - Implement meeting end, rollover, end-time change reclassification, and External Release observation (`[EXTERNAL_RELEASE_OBSERVED]`).
  - Implement the codec-local midnight health check with per-room jitter, configuration re-apply before re-verification (LLD §5.12), and the `CodecTimeUnavailable` guard (success and failure).
  - Implement device reboot detection from `SystemUnit.Uptime` (restart with startup semantics) and `BootEvent` as an early trigger only (LLD §5.13).

- **TICKET-06: Early Departure Release Policy** (`06-early-departure-release.md`)
  - Implement vacancy detection after CheckIn confirmation (service CheckIn, `AlreadyCheckedIn`, `BookedFromDevice`), countdown, and warning sequence; off by default.
  - Implement the Early Departure cancellation notice.
  - Implement occupancy handling (countdown cancels; visible prompt is kept).

- **TICKET-07: Webex Workspace Integration Driver Adapter** (`07-webex-workspace-integration-adapter.md`)
  - Integrate `workspace-integrations` SDK.
  - Implement `WebexWorkspaceAdapter` fulfilling the presence, interaction, calendar, device configuration, and fleet inventory ports, including `CheckInResult` mapping (substring classification, no automatic retry of CheckIn/CheckOut), `Prompt.Cleared`, `BootEvent`, `Bookings.Get/List`, `Time.SystemTime`, `SystemUnit.Uptime`, and `SystemUnit.ProductPlatform`.
  - Implement native check-in window enforcement (`NATIVE_CHECK_IN_WINDOW_MINUTES`, default 60, allowed 5/10/15/20/30/60) and the `Bookings.CheckIn.Enabled` FIFO serialization queue.
  - Enforce the outbound roster and command gate on commands and configuration writes; back off on `429` honoring `Retry-After`.

- **TICKET-08: Outbound Long-Polling Ingress Transport & Local Laptop Runner** (`08-long-polling-transport-laptop-runner.md`)
  - Implement `LongPollingTransport` (polling started by `connect()`; connectivity changes trigger full revalidation) with zero inbound open ports.
  - Wire application entrypoint (`src/index.ts`) connecting store, inventory, lease, roster gate, transport, adapter, room registry, and the dashboard for single-command laptop development (`npm run dev`).
  - Shut down by closing the roster gate and exiting.

- **TICKET-09: Lightweight Admin Dashboard & Configuration UI** (`09-admin-dashboard-config-ui.md`)
  - Implement Fastify-embedded `/admin` web interface (127.0.0.1, shared password, refuses to start without it) with clean, minimalist Google-style styling.
  - Implement 1-click Emergency Kill Switch (persistence rules, `active (not persisted)`) and tripwire reset.
  - Implement room search, live status fleet table, enrollment view, and the `DRY_RUN → LIVE` readiness report.
  - Implement the settings editor with LLD §5.10 validation and persist-before-apply for every change, including per-room modes and SMTP relay settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_SECURE`, `NOTIFICATIONS_ENABLED`), without restarting.

- **TICKET-10: Corporate SMTP Email Notification Engine & Template System** (`10-smtp-email-notification-system.md`)
  - Implement `SmtpNotificationAdapter` connecting to `outlook.suncorp.com.au:25` with anonymous direct relay.
  - Implement `MockNotificationDriver` for local laptop development with rich terminal logging and in-memory test capture.
  - Implement dynamic template renderer (warning email with time to the fixed deadline, local room time, and the informational wording of LLD §6.2; differentiated No-Show vs Early Departure notices; none for `UserConfirmed`).
  - Own the warning email gate (LLD §5.8): one email per deadline, failure or missing organizer keeps the prompt and blocks release, `NOTIFICATIONS_ENABLED=false` bypass, `DRY_RUN` log satisfies the gate, `MONITOR_ONLY` never calls the driver.

- **TICKET-11: Fleet Roster, Room Enrollment & Durable Configuration Store** (`11-fleet-roster-config-store.md`)
  - Implement `JsonFileFleetConfigStore` with versioned conditional writes, an append-only audit log, first-run seeding, and port contract tests.
  - Implement inventory reconciliation and the Tier 2 detect-and-block sweeper: new workspaces become `DISABLED`; handle `Missing` (reappearance quarantines), `DeviceMismatch`, `AmbiguousWorkspace`, and disconnected devices; the system never promotes a room.
  - Implement the roster gate (discard ingress events, block outbound commands and configuration writes), the mode-transition rules (LLD §5.7, including `LIVE → DRY_RUN`), `MONITOR_ONLY` behaviour, and native CheckIn baseline capture and restore.
  - Implement fail-closed startup with store retry backoff, the persisted kill switch (store OR parameter, re-read every 30s), the persisted tripwire flag with admin reset, the fleet-gate behaviour, and the in-memory instance lease.
