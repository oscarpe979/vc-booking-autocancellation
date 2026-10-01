# Sprint 1 Specification: Core Engine & Local Laptop Foundation

## Problem Statement

Engineers need to build, run, test, and validate the external Booking Auto Cancellation service directly on their local development laptops within a corporate network environment, without depending on external databases, public inbound IPs, or cloud infrastructure. 

Before deploying to AWS, the team must prove that:
1. The core autocancellation state machine accurately ports the validated codec-native logic.
2. The Hexagonal driver abstractions (`IRoomPresenceDriver`, `IRoomInteractionDriver`, `ICalendarConnector`) properly decouple domain rules from device SDKs.
3. The service can ingest live device telemetry via outbound long-polling using Webex Workspace Integrations.
4. The Startup Check-In Quarantine and Just-In-Time (JIT) pre-checkout probe work reliably in real-time execution.

---

## Solution

Sprint 1 delivers a functional, locally executable Node.js/TypeScript service implementing the core domain engine, the Webex Workspace Integration adapter, and an outbound long-polling ingress transport.

Sprint 1 delivers:
1. Complete TypeScript project scaffolding in the `service` directory with strict typing, configuration loading, and unit/integration test tooling.
2. The core domain state machine ported directly from the validated macro, managing in-memory room actors with 100% policy parity (including audio chime alerts, prompt restoration, dual presentation, minimum remaining time guard, and ad hoc booking guards).
3. Hexagonal driver interfaces isolating presence, user interaction, calendar operations, and device configuration enforcement.
4. The `WebexWorkspaceAdapter` implementing the driver interfaces using the official `workspace-integrations` SDK.
5. The `LongPollingTransport` allowing zero-firewall event ingestion on corporate laptops (with webhooks deferred to a future phase).
6. The Two-Tier Reconciler with synchronous Just-In-Time (JIT) pre-checkout verification, 50ms sync coalescing, and 5-step bounded readiness recovery.
7. Configurable exemption engine (duration threshold, VIP organizers, title keywords) and a lightweight Google-style `/admin` dashboard.
8. A comprehensive test suite including virtualized time testing and a mock driver harness.

---

## User Stories

1. As a software engineer, I want a TypeScript project structure with build and test scripts, so that I can compile, run, and test the service locally.
2. As a software engineer, I want the service configuration loaded from environment variables and `.env.local`, so that I can configure timeouts, grace periods, and Webex credentials easily on my laptop.
3. As a software engineer, I want the core room state machine to manage meeting lifecycles in memory, so that rooms transition accurately between Idle, Quarantined, CountdownScheduled, PromptVisible, and Released states.
4. As a software engineer, I want the domain logic isolated behind driver interfaces (`IRoomPresenceDriver`, `IRoomInteractionDriver`, `ICalendarConnector`, `IDeviceConfigDriver`), so that the core engine has zero direct dependencies on Cisco xAPI.
5. As a software engineer, I want a Webex adapter implementing the driver interfaces via `workspace-integrations`, so that the service can communicate with real Cisco codecs.
6. As a software engineer working on a corporate laptop, I want the service to ingest Webex events via outbound long-polling, so that I can receive live room events without opening inbound ports or running tunneling tools.
7. As a software engineer, I want an in-memory room registry, so that multiple rooms can be simulated or managed concurrently during local testing.
8. As a meeting attendee, I want active meetings present when the service starts to be placed into quarantine, so that service restarts never cancel ongoing meetings.
9. As a meeting attendee, I want an empty room to trigger an actionable warning on the touch controller before any cancellation, so that I can tap "Keep Booking" to preserve the space.
10. As a meeting attendee, I want tapping "Keep Booking" to dismiss the prompt and reset the countdown safely, so that my meeting remains reserved.
11. As a meeting attendee, I want tapping "Check Out" on the controller to prompt for confirmation and then release the room, so that I can free up unused space intentionally.
12. As a meeting organizer, I want meetings longer than two hours to be exempt from autocancellation, so that prolonged meetings are never cancelled automatically.
13. As an enterprise IT collaboration administrator, I want a Just-In-Time verification probe executed immediately before checkout, so that a room is preserved if someone walks in right before the release command.
14. As an enterprise IT collaboration administrator, I want dry-run mode supported locally, so that simulated prompt displays and release intents are logged without sending destructive commands to live rooms.
15. As a software engineer, I want unit tests using virtualized clocks, so that 10-minute timeouts and 5-minute countdowns can be tested deterministically in milliseconds.
16. As a software engineer, I want a mock driver test harness, so that I can simulate complete end-to-end meeting lifecycles without connecting to physical hardware.
17. As an in-room meeting participant, I want an audible alert chime played at 70% volume with automatic restoration when the warning appears, so that I notice the warning even if not looking at the touch panel.
18. As an in-room meeting participant who dismissed the prompt without making a choice, I want the prompt to be automatically restored for the remaining warning duration, so that accidental swipes do not lead to unintentional cancellation.
19. As an executive or VIP meeting organizer, I want meetings organized by designated VIPs or containing specific title keywords to be automatically exempt from autocancellation, so that mission-critical corporate meetings are never cancelled.
20. As an enterprise IT collaboration administrator, I want a lightweight web dashboard to view live room statuses, toggle the emergency kill switch, and update exemption rules and timeout parameters without modifying code or restarting the service.
21. As a meeting organizer with a short remaining meeting duration (e.g. 12 minutes or less), I want autocancellation skipped, so that meetings about to conclude naturally are preserved without nuisance warnings.
22. As an in-room meeting organizer who booked the room directly from the touch controller (ad hoc), I want automatic check-in suppressed, so that the service respects native on-device booking workflows.

---

## Implementation Decisions

### 1. Project Scaffolding & Configuration
- Set up `package.json`, `tsconfig.json`, ESLint/Prettier, and Vitest in the `service` directory.
- Define a strongly typed `Config` schema reading from `process.env`:
  - `EMPTY_ROOM_TIMEOUT_MS` (default 10 minutes)
  - `PRE_TIMEOUT_WARNING_MS` (default 5 minutes)
  - `POST_TIMEOUT_GRACE_PERIOD_MS` (default 2 minutes)
  - `LONG_MEETING_EXEMPTION_THRESHOLD_MS` (default 120 minutes)
  - `EXEMPT_ORGANIZERS` (comma-separated list of VIP emails)
  - `EXEMPT_TITLE_KEYWORDS` (comma-separated list of title keywords)
  - `AUTOMATIC_CHECK_IN_DELAY_MS` (default 3 seconds)
  - `BOOKING_SYNC_COALESCE_DELAY_MS` (default 50 ms)
  - `BOOKING_READINESS_RECOVERY_DELAYS_MS` (default `[250, 500, 1000, 2000, 4000]`)
  - `DRY_RUN_MODE` (boolean)
  - `NOTIFICATION_MODE` (fixed to `longpolling` for Phase 1; webhook deferred)
  - Webex credentials (`WEBEX_CLIENT_ID`, `WEBEX_CLIENT_SECRET`, `WEBEX_REFRESH_TOKEN`, `WEBEX_APP_URL`, `WEBEX_OAUTH_URL`).

### 2. Hexagonal Domain Interfaces
Define the driver contracts in domain types:
- `IRoomPresenceDriver`: `getPresence(roomId)`, `onPresenceChange(handler)`.
- `IRoomInteractionDriver`: `hasActionableSurface(roomId)`, `displayWarning(roomId, prompt)`, `displayConfirmation(roomId, prompt)`, `clearWarning(roomId, promptId)`, `restoreDismissedPrompt(roomId, prompt)`, `playAudioAlert(roomId, alert)`, `restoreAudioVolume(roomId)`, `onPromptResponse(handler)`, `onPromptCleared(handler)`.
- `ICalendarConnector`: `getAvailability(roomId)`, `getBookingDetails(roomId, bookingId)`, `checkIn(roomId, bookingId, trackingData)`, `checkOut(roomId, bookingId, reason)`, `onCheckedIn(handler)`.
- `IDeviceConfigDriver`: `enforceBaselinePresenceConfig(roomId)`, `enforceNativeCheckInWindow(roomId, windowMinutes)`, `setNativeCheckInEnabled(roomId, enabled)`.
- `IEventIngressTransport`: `start()`, `stop()`, `onNotification(handler)`.

### 3. Core Room State Machine & Workflow Coordinator
- Port the state machine and policy rules from the codec-native macro to TypeScript classes with full parity:
  - Generational counters (`bookingLifecycleId`, `releaseWorkflowId`) preventing asynchronous races.
  - Startup Check-In Quarantine (`AwaitingStartupCheckIn`).
  - Minimum remaining time guard: skip autocancellation if `timeRemaining <= EMPTY_ROOM_TIMEOUT_MS + POST_TIMEOUT_GRACE_PERIOD_MS` ($\le 12$ min).
  - Ad hoc booking check: suppress automatic check-in if `BookedFromDevice === 'True'`.
  - External release observation: detect when availability becomes `Free`/`FreeUntil` externally and emit `[EXTERNAL_RELEASE_OBSERVED]` audit log.
  - Codec-local timezone offset calculation for midnight health check (`CodecTimeUnavailable` guard).

### 4. Two-Tier Reconciler, Coalescing & Bounded Recovery
- **50ms Booking Sync Coalescing**: Buffers rapid bursts of `BookedUntil` and `TimeStamp` events.
- **5-Step Bounded Readiness Recovery**: Retries transient missing metadata on `[250ms, 500ms, 1000ms, 2000ms, 4000ms]` with `Bookings.List({ ScheduleType: 'Current', Limit: 1 })` fallback.
- **JIT Verification Probe**: Synchronous check at $T=0$ verifying room is empty and booking ID is unaltered before calling `checkOut()`.

### 5. Webex Workspace Integration Adapter
- Implement `WebexWorkspaceAdapter` wrapping the official `workspace-integrations` SDK.
- Support xStatus reads (`RoomAnalytics.RoomInUse`, `Bookings.Availability`, `Bookings.Current.Id`, `Peripherals.ConnectedDevice`, `Time.SystemTime`).
- Support xCommands (`UserInterface.Message.Prompt.*`, `Audio.Volume.*`, `Audio.Sound.*`, `Bookings.CheckIn`, `Bookings.CheckOut`, `Bookings.Get`, `Bookings.List`).
- Support xConfigs (`RoomAnalytics.*`, `Bookings.CheckIn.WindowDuration`, `Bookings.CheckIn.Enabled` with FIFO serialization queue).
- Support xEvents (`UserInterface.Message.Prompt.Response`, `UserInterface.Message.Prompt.Cleared`, `Bookings.CheckedIn`).
- Filter out non-controller peripherals (e.g. `RoomScheduler`).

### 6. Outbound Long-Polling Ingress Transport
- Implement `LongPollingTransport` using `integration.pollData()` from the Webex SDK.
- Connect to Webex cloud message queue via outbound HTTPS with zero inbound ports.
- Webhook transport is deferred to a future phase.

### 7. In-Memory Room Registry & Exemption Engine
- Manage room state machines in memory (`Map<string, RoomWorkflowCoordinator>`).
- Evaluate exemption rules: duration threshold, VIP organizer email list, and title keywords.
- Support per-room execution modes (`MONITOR_ONLY`, `DRY_RUN`, `LIVE`).

### 8. Lightweight "Google-Style" Admin & Configuration Dashboard
- Fastify-embedded `/admin` web interface.
- 1-click Emergency Kill Switch.
- Search bar to search rooms by name, room ID, organizer, or status.
- Real-time fleet status table showing lifecycle phase, presence, and countdown timer.
- Web form allowing administrators to view and update timeout durations, long meeting thresholds, VIP organizer exemptions, and per-room operational modes without code changes.

---

## Testing Decisions

### 1. Unit Testing with Mock Drivers
- Use Vitest with fake timers (`vi.useFakeTimers()`).
- Create `MockPresenceDriver`, `MockInteractionDriver`, `MockCalendarConnector`, and `MockDeviceConfigDriver`.
- Test scenarios:
  1. Standard No-Show Release (empty room $\to$ countdown $\to$ prompt display $\to$ timeout $\to$ JIT check $\to$ checkout).
  2. Prompt Response "Keep Booking" (cancels warning, resets countdown).
  3. Prompt Response "Check Out" (triggers confirmation prompt, confirms checkout).
  4. Audio Chime & Volume Override (verifies volume set to 70, sound played, volume restored after 4s, repeated every 60s).
  5. Dismissed Prompt Restoration (dismissal without selection causes immediate re-display).
  6. Occupancy Detection during countdown or warning (cancels release, preserves booking).
  7. Startup Quarantine (meeting active on boot enters quarantine, ignores empty room until checked in).
  8. Long Meeting Exemption (meetings > 120 minutes are blocked from autocancellation).
  9. VIP Organizer & Title Keyword Exemption (exempt meetings are blocked from autocancellation).
  10. Minimum Remaining Time Guard ($\le 12$ min skips release).
  11. Ad Hoc Booked from Device (suppresses automatic check-in).
  12. JIT Abort on Late Presence (room empty during countdown, becomes occupied at $T=0$; checkout blocked).
  13. Bounded Readiness Recovery (simulates missing booking ID on event, verifies 5-step recovery and List fallback).
  14. Dry-Run Suppression (simulates all steps, confirms no checkout command sent).

### 2. Integration Testing with Recorded Webex Payloads
- Test `LongPollingTransport` and event dispatching against serialized real-world Webex notification JSON payloads.

---

## Out of Scope for Sprint 1

1. **AWS Infrastructure & CloudWatch Deployment**: EC2 provisioning, Multi-AZ ASG setup, and SSM parameter injection are scheduled for Sprint 2.
2. **Inbound Webhook HTTP Server**: Deferred to a future release; initial implementation uses outbound long-polling.
3. **External Database Persistence**: PostgreSQL/Redis are out of scope (Sprint 1 runs 100% in memory).
4. **Automated Anomaly Tripwire**: Fleet-wide cancellation rate throttling across hundreds of rooms is scheduled for Sprint 2.

---

## Sprint 1 Work Items / Ticket Breakdown

The following vertical slices represent the implementation tickets for Sprint 1 (published in `.doc/sprints/sprint-1/tickets/`):

- **TICKET-01: Core Scaffolding & End-to-End Tracer Bullet** (`01-core-scaffolding-tracer-bullet.md`)
  - Initialize `service` folder with `package.json`, `tsconfig.json`, Vitest, and linter.
  - Implement strongly typed configuration loader reading `.env.local` and environment variables.
  - Define domain interfaces: `IRoomPresenceDriver`, `IRoomInteractionDriver`, `ICalendarConnector`, `IDeviceConfigDriver`, `IEventIngressTransport`.
  - Implement in-memory room registry and prove end-to-end idle-to-active monitoring tracer bullet.

- **TICKET-02: No-Show Release Workflow & Just-In-Time Verification Probe** (`02-no-show-release-jit-verification.md`)
  - Implement empty-room countdown timer and warning prompt triggering.
  - Implement 50ms booking sync coalescing timer.
  - Implement 5-step bounded readiness recovery schedule with `Bookings.List` fallback.
  - Implement minimum remaining meeting duration guard ($\le 12$ min skips release).
  - Implement synchronous Just-In-Time (JIT) pre-checkout verification probe.

- **TICKET-03: In-Room User Interaction (Audio Chimes, Prompts & Check Out)** (`03-in-room-user-interaction.md`)
  - Implement dual presentation (Touch Controller vs OSD) with surface role filtering (strictly ignoring `RoomScheduler`).
  - Implement prompt text variants (`INITIAL` vs `REPEATED`).
  - Implement audio alert chime (volume 70, hold 4s, restore to default, repeat every 60s).
  - Implement prompt restoration on accidental swipe/dismissal for remaining warning duration.
  - Implement "Keep Booking" and the two-step "Check Out" confirmation guard.

- **TICKET-04: Occupancy Interruption & Automatic Check-In** (`04-occupancy-interruption-auto-checkin.md`)
  - Implement occupancy cancellation during countdown and warning presentation.
  - Implement automatic check-in scheduling for occupied current sessions with tracking metadata.
  - Implement ad hoc "booked from device" check (`BookedFromDevice: 'True'` suppresses auto-checkin).

- **TICKET-05: Startup Quarantine, Exemption Engine & Midnight Health Check** (`05-startup-quarantine-long-meeting-guards.md`)
  - Implement Startup Check-In Quarantine (`AwaitingStartupCheckIn`) protecting in-flight meetings across restarts.
  - Implement Long-Meeting Exemption classification (>120 min).
  - Implement VIP Organizer and Title Keyword exemption checks (`EXEMPT_ORGANIZERS`, `EXEMPT_TITLE_KEYWORDS`).
  - Implement Codec-local timezone offset calculation for midnight health check delay (`CodecTimeUnavailable` guard).
  - Implement External Release observation (`[EXTERNAL_RELEASE_OBSERVED]`).

- **TICKET-06: Early Departure Release Policy** (`06-early-departure-release.md`)
  - Implement post-check-in vacancy detection, countdown, and warning sequence.
  - Implement configuration toggle and occupancy cancellation.

- **TICKET-07: Webex Workspace Integration Driver Adapter** (`07-webex-workspace-integration-adapter.md`)
  - Integrate `workspace-integrations` SDK.
  - Implement `WebexWorkspaceAdapter` fulfilling presence, interaction, calendar, and config driver contracts.
  - Implement native check-in window enforcement (`WindowDuration: 60`) and `Bookings.CheckIn.Enabled` FIFO serialization queue.
  - Implement audio volume and prompt display command mappings.

- **TICKET-08: Outbound Long-Polling Ingress Transport & Local Laptop Runner** (`08-long-polling-transport-laptop-runner.md`)
  - Implement `LongPollingTransport` for outbound Webex queue listening with zero inbound open ports.
  - Wire application entrypoint (`src/index.ts`) connecting transport, adapter, and room registry for single-command laptop development (`npm run dev`).

- **TICKET-09: Lightweight Admin Dashboard & Configuration UI** (`09-admin-dashboard-config-ui.md`)
  - Implement Fastify-embedded `/admin` web interface with clean, minimalist Google-style styling.
  - Implement 1-click Emergency Kill Switch.
  - Implement room search and live status fleet table.
  - Implement configuration & exemption editor panel allowing administrators to update timeouts, thresholds, VIP exemptions, and room modes without restarting.
