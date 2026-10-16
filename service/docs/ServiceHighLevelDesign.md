# Booking Auto Cancellation External Service - High-Level Design (HLD)

## 1. Document Purpose and Scope

This document specifies the target architecture and high-level design for an external, vendor-agnostic meeting room booking autocancellation service.

The service transitions the existing single-codec RoomOS macro logic to a centralized, multi-room backend service capable of managing ~800 meeting spaces. The service enforces strict policy parity with the codec-native baseline while decoupling room occupancy detection, in-room user interaction, and calendar booking operations behind clean domain boundaries.

The validated macro and its [specification](../../codec-native/docs/BookingAutoCancellationSpec.md) are the behavioral authority for every room-level decision. Where this document disagrees with them, the codec-native specification governs. Service-only capabilities (email notifications, VIP/keyword exemptions, rollout modes, kill switch, tripwire, dashboard) may only add reasons to preserve a booking.

### Initial Deployment Scope

- **Managed Fleet**: Approximately 800 corporate meeting rooms.
- **Calendar Provider**: Microsoft Exchange (connected through Cisco Webex Control Hub Hybrid Calendar / Room Booking services for Phase 1).
- **Device Ecosystem**: Cisco RoomOS codecs (Room Kit, Room Bar, Board, Desk Pro) accessed via the Webex Workspace Integration framework.
- **Notification Channel**: Corporate Email Notifications via Enterprise SMTP Relay (`outlook.suncorp.com.au:25`) dispatched to meeting organizers for warning alerts and cancellation confirmations.
- **Hardware Agnosticism**: Standardized Hardware Abstraction Layer (HAL) allowing future replacement or augmentation of codecs with alternative hardware vendors (e.g., Poly, Neat, Logitech) or third-party occupancy sensors.
- **Runtime Environment**:
  - **Local Development**: Node.js / TypeScript running locally on engineer workstations via outbound long-polling (zero inbound firewall pinholes, zero ngrok/tunneling required) with mock email logging.
  - **Production Target (AWS)**: Modular infrastructure provisioned via Terraform, designed to run with maximum operational simplicity in private VPC subnets with outbound connectivity to Webex (HTTPS 443) and corporate SMTP (`outlook.suncorp.com.au:25`). Supports either a containerized task (AWS ECS Fargate) or a hardened single-instance VM (AWS EC2 RHEL 9 with `systemd` supervisor under a Min=1, Max=1 Auto Scaling Group).

---

## 2. Business Context & Controlling Safety Invariant

Unused reserved rooms reduce collaborative capacity. However, false cancellations disrupt ongoing business meetings, executive reviews, and client presentations.

The external service inherits the strict, fail-closed safety invariant established in the codec-native solution:

```text
Prove current booking identity, room vacancy, hardware health, and release safety.
Only when every condition is conclusively verified may an automatic booking action proceed.
Otherwise: preserve the booking and take no action.
```

### Core Invariants

1. **Never Delete**: The service requests `CheckOut`; it never invokes destructive calendar deletion commands.
2. **Actionable Warning Surface Required**: In production, an empty-room release cannot execute unless an actionable prompt (`Keep Booking` / `Check Out`) was successfully displayed to a physical in-room touch surface or certified interactive display.
3. **Mandatory Warning Email Precondition**: Automatic room cancellation requires that a cancellation warning email was successfully dispatched to the meeting organizer when the in-room warning prompt was shown. If email dispatch fails after bounded retries, the service fails closed and preserves the booking (zero surprise cancellations).
4. **Fail-Closed on Startup / Restart**: Any meeting underway when the service starts or restarts is placed into an immediate **Startup Check-In Quarantine** (`AwaitingStartupCheckIn`). It will never be auto-cancelled unless fresh occupancy and check-in confirmation are observed.
5. **Just-In-Time (JIT) Verification Probe**: Immediately prior to issuing a release command at $T=0$, the service executes a synchronous, real-time read directly against the room hardware to guarantee the space is still vacant and the booking identity has not changed.

---

## 3. System Architecture & Hexagonal Seams

The service is structured according to Hexagonal Architecture (Ports and Adapters). Core booking autocancellation workflow logic has zero coupling to Cisco xAPI, Webex SDKs, or cloud network protocols.

For the comprehensive visual Domain-Driven Design (DDD) architecture model detailing Aggregate Roots, Domain Policies, Safety Guards, and mutable configuration bindings, see [ServiceDomainDrivenDesign.md](ServiceDomainDrivenDesign.md).

```text
+----------------------------------------------------------------------------------------------------+
|                                      INGRESS TRANSPORT LAYER                                       |
|                                                                                                    |
|    +------------------------------------------------------------------------------------------+    |
|    |                                   LongPollingTransport                                   |    |
|    |      (Persistent Outbound HTTPS 443 - Dev Laptops & Private Enterprise VMs)              |    |
|    |      * WebhookTransport is deferred to a future phase                                    |    |
|    +---------------------------------------------+--------------------------------------------+    |
+--------------------------------------------------|-------------------------------------------------+
                                                   |
                                                   v
+----------------------------------------------------------------------------------------------------+
|                                    EVENT DISPATCHER & INGRESS SEAM                                 |
|                                     (IEventIngressTransport)                                       |
+--------------------------------------------------+-------------------------------------------------+
                                                   |
                                                   v
+----------------------------------------------------------------------------------------------------+
|                                         FLEET ROSTER GATE                                          |
|           Discards every event from DISABLED, unrostered, missing or mismatched devices            |
|           Roster & settings from IFleetConfigStore; inventory from IFleetInventoryDriver           |
+----------------------------------------------------------------------------------------------------+
                                                   |
                                                   v
+----------------------------------------------------------------------------------------------------+
|                                      CORE DOMAIN ENGINE                                            |
|                                                                                                    |
|     +-----------------------------------------------------------------------------------------+    |
|     |                               Room Workflow Coordinator                                 |    |
|     |                           (Per-Room State Machine Actors)                               |    |
|     |                                                                                         |    |
|     |   * Startup Quarantine Manager           * Two-Tier Reconciler (JIT Probe & Drift)      |    |
|     |   * Bounded Readiness Recovery (5-step)  * Booking Sync Coalescing (50ms guard)         |    |
|     |   * No-Show & Early Departure Policies   * Long-Meeting & VIP/Group Exemption Engine    |    |
|     |   * Minimum Remaining Time Guard         * Native CheckIn Serialization Queue           |    |
|     |   * Automated Anomaly Tripwire           * Emergency Kill Switch & Config Dashboard     |    |
|     +-----------------------------------------------------------------------------------------+    |
|                                                |                                                   |
|                                                v                                                   |
|                                     DOMAIN PORTS (SEAMS)                                           |
|                     +------------------+------------------+------------------+                     |
|                     |                  |                  |                  |                     |
|                     v                  v                  v                  v                     |
|            IRoomPresenceDriver  IRoomInteraction  ICalendarDriver     INotificationDriver          |
|            (Occupancy)          (In-Room UI)      (Bookings/CheckIn)  (Email Notifications)        |
|            + IDeviceConfigDriver, IFleetInventoryDriver (read-only), IFleetConfigStore (durable)   |
|                     |                  |                  |                  |                     |
+---------------------|------------------|------------------|------------------|---------------------+
                      |                  |                  |                  |
                      v                  v                  v                  v
+----------------------------------------------------------------------------------------------------+
|                                        ADAPTER LAYER                                               |
|                                                                                                    |
|     +-----------------------------------------------------------------------------------------+    |
|     |                         Webex Workspace Integration Adapter                             |    |
|     |        (Implements Presence, Interaction, Calendar, Config & Inventory Drivers)         |    |
|     |   * xStatus: RoomAnalytics.RoomInUse, Bookings.Availability, Bookings.Current.Id        |    |
|     |   * xStatus: Peripherals.ConnectedDevice (TouchPanel filter), Time.SystemTime           |    |
|     |   * xCommand: UserInterface.Message.Prompt.*, Audio.Volume/Sound, Bookings.CheckIn/Out  |    |
|     |   * xConfig: Bookings.CheckIn.WindowDuration (60m), Bookings.CheckIn.Enabled toggle     |    |
|     |   * xEvent: UserInterface.Message.Prompt.Response/.Cleared, Bookings.CheckedIn          |    |
|     +-----------------------------------------------------------------------------------------+    |
|                                                                                                    |
|     +-----------------------------------------------------------------------------------------+    |
|     |                             Notification Adapters                                       |    |
|     |   * SmtpNotificationAdapter: Outbound SMTP over port 25 (outlook.suncorp.com.au:25)     |    |
|     |   * MockNotificationDriver: Local dev/testing console logger & EML preview capture      |    |
|     +-----------------------------------------------------------------------------------------+    |
|                                                                                                    |
|     +-----------------------------------------------------------------------------------------+    |
|     |                          Fleet Configuration Store Adapters                             |    |
|     |   * DynamoFleetConfigStore: rooms, settings & append-only audit tables (VPC endpoint)   |    |
|     |   * JsonFileFleetConfigStore: local laptop file under service/.local/ (gitignored)      |    |
|     +-----------------------------------------------------------------------------------------+    |
|                                                                                                    |
|     +-----------------------------------------------------------------------------------------+    |
|     |                      Future Adapters (Pluggable Hardware Modules)                       |    |
|     |     * Poly / Neat Presence Driver       * Microsoft Graph Direct Calendar Driver         |    |
|     +-----------------------------------------------------------------------------------------+    |
+----------------------------------------------------------------------------------------------------+
```

---

## 4. Domain Ports & Driver Abstractions

To achieve true hardware vendor and notification provider agnosticism, the domain boundary defines five room-facing interfaces (§4.1–4.5), plus two fleet-level interfaces for Control Hub discovery and durable configuration (§4.6–4.7):

### 4.1 Presence Driver (`IRoomPresenceDriver`)

Abstracts physical occupancy detection:

- `getPresence(roomId: string): Promise<RoomPresenceState>`: Queries instantaneous presence (`Occupied`, `Empty`, or `Unknown`).
- `onPresenceChange(handler: (event: PresenceChangeEvent) => void): void`: Ingests asynchronous presence transitions (`RoomAnalytics.RoomInUse`).

### 4.2 In-Room Interaction Driver (`IRoomInteractionDriver`)

Abstracts user prompts, warnings, audio chimes, and touch responses:

- `hasActionableSurface(roomId: string): Promise<boolean>`: Discovers touch panels (`Status.Peripherals.ConnectedDevice` with `Status: Connected`, `Type: TouchPanel`, `Role: Controller`) and certified interactive displays (`SystemUnit.ProductPlatform = 'Desk Pro'`). Strictly filters out non-controller panels such as `RoomScheduler` Navigators.
- `displayWarning(roomId: string, prompt: WarningPromptRequest): Promise<PromptDisplayResult>`: Shows dual presentation:
  - Controller prompt: actionable buttons (`Option.1: Keep Booking`, `Option.2: Check Out`).
  - Informational OSD (room monitor): prompts occupants to confirm on touch controller (or actionable buttons on Desk Pro).
  - Dynamic text variants: `INITIAL` text vs `REPEATED` text (when user previously tapped Keep Booking but room remains vacant).
- `displayConfirmation(roomId: string, prompt: ConfirmationPromptRequest): Promise<PromptDisplayResult>`: Displays two-step confirmation guard (`Cancel` / `Check out`).
- `clearWarning(roomId: string): Promise<void>`: Dismisses the warning and confirmation prompts across controller and OSD targets.
- `restoreDismissedPrompt(roomId: string, prompt: WarningPromptRequest): Promise<void>`: Immediately re-displays only the dismissed target (via user swipe or `Prompt.Cleared`) for the remaining warning duration, without extending the deadline.
- `playAudioAlert(roomId: string): Promise<void>`: Overrides volume to 70 (`Audio.Volume.Set({ Level: 70 })`), plays `Announcement` sound (`Audio.Sound.Play({ Sound: 'Announcement' })`), holds for 4 seconds, restores default volume (`Audio.Volume.SetToDefault()`), and repeats every 60s while prompt is visible.
- `restoreAudioVolume(roomId: string): Promise<void>`: Restores volume to default upon prompt clear or dismissal.
- `onPromptResponse(handler: (event: PromptResponseEvent) => void): void`: Ingests user selections (`OptionId: '1'` or `'2'`).
- `onPromptCleared(handler: (event: PromptClearedEvent) => void): void`: Ingests prompt dismissal events.

### 4.3 Calendar Driver (`ICalendarDriver`)

Abstracts meeting reservation metadata and release execution:

- `getAvailability(roomId: string): Promise<RoomAvailabilitySnapshot>`: Returns `Free`, `FreeUntil`, or `BookedUntil` with timestamps.
- `getBookingDetails(roomId: string, bookingId: string): Promise<BookingDetails>`: Queries `Bookings.Get({ Id })` with fallback to `Bookings.List({ ScheduleType: 'Current', Limit: 1 })`. Includes `BookedFromDevice` flag, organizer email/name, meeting title, start/end timestamps.
- `checkIn(roomId: string, bookingId: string, trackingData?: string): Promise<void>`: Executes meeting check-in with `TrackingData: 'BookingAutoCancellation_Automatic'`.
- `checkOut(roomId: string, bookingId: string, reason: CheckOutReason): Promise<void>`: Executes meeting release (`Bookings.CheckOut({ Id })`). The reason is `NoShow`, `EarlyDeparture`, or `UserConfirmed`.
- `onCheckedIn(handler: (event: CheckedInEvent) => void): void`: Ingests meeting check-in events (`Event.Bookings.CheckedIn`).

### 4.4 Device Configuration Driver (`IDeviceConfigDriver`)

Abstracts baseline configuration enforcement and native check-in policy:

- `enforceBaselinePresenceConfig(roomId: string): Promise<boolean>`: Enforces `PeoplePresenceDetector: On`, `HeadDetector: On`, `PeopleCountOutOfCall: On`, `RoomInUse.InCall: Enabled`, `RoomInUse.LocalUsage: Enabled`, and `Ultrasound`.
- `enforceNativeCheckInWindow(roomId: string, windowMinutes: number): Promise<boolean>`: Enforces `Bookings.CheckIn.WindowDuration: 60` to prevent native RoomOS no-show release from racing ahead of service safety policy.
- `setNativeCheckInEnabled(roomId: string, enabled: boolean): Promise<boolean>`: Serializes writes through FIFO queue with freshness checks: sets `False` for long/unclassifiable meetings, sets `True` for allowed short meetings, restores `True` when meeting ends / room is free.

### 4.5 Notification Driver (`INotificationDriver`)

Abstracts end-user email communications:

- `sendCancellationWarning(payload: CancellationWarningPayload): Promise<NotificationResult>`: Dispatches an urgent warning email to the meeting organizer when the in-room countdown prompt is triggered.
  - **Dynamic Time Calculation**: Never hardcodes minutes; calculates the remaining warning duration directly from `PRE_TIMEOUT_WARNING_MS` (e.g. 5m, 3m) and formats the impending release time in the codec's local clock timezone.
  - **Single Warning Invariant**: Tracked per booking lifecycle; re-displaying a dismissed prompt (`restoreDismissedPrompt`) never re-sends or spams duplicate warning emails.
  - **Delivery Verification & Fail-Closed Gate**: Warning email delivery is tracked. If SMTP dispatch fails (after bounded immediate retries), the service records the delivery failure, fails closed, and **aborts the cancellation** to prevent surprise releases.
- `sendCancellationNotice(payload: CancellationNoticePayload): Promise<NotificationResult>`: Dispatches a conclusive cancellation notice to the meeting organizer immediately following a successful automatic `checkOut()`. A user-confirmed CheckOut from the room controller sends no notice.
  - **Differentiated Templates**: Contextual messaging explicitly distinguishing **No-Show Release** (room unoccupied after meeting start) from **Early Departure Release** (room vacated and left empty before scheduled end time).
- **Template Presentation**: Responsive multipart MIME (HTML with structured corporate branding, room name, scheduled meeting time, and clear bullet instructions) accompanied by an RFC-compliant plain-text fallback.
- **Enterprise SMTP Adapter**: Implemented by `SmtpNotificationAdapter` connecting to `outlook.suncorp.com.au:25` via unauthenticated direct relay (with configurable overrides for port, credentials, and TLS in the admin dashboard).
- **Simulation Safety**: In `DRY_RUN` mode, physical SMTP delivery is suppressed and the adapter emits structured `[DRY RUN - WOULD_SEND_EMAIL]` audit logs. In `MONITOR_ONLY` mode, no warning or release workflow runs, so no email (real or simulated) is produced.

### 4.6 Fleet Inventory Driver (`IFleetInventoryDriver`)

- `listDevices(): Promise<InventoryDevice[]>`: Lists the workspaces and devices visible to the integration in Control Hub (device ID, workspace ID and name, product, connection status, booking capability). Read-only; it never issues device xAPI calls. It is used only for roster reconciliation (§7.1).

### 4.7 Fleet Configuration Store (`IFleetConfigStore`)

- Loads and conditionally writes the roster and fleet settings, and appends to the audit log. It is implemented by `DynamoFleetConfigStore` (AWS) and `JsonFileFleetConfigStore` (laptop). See §8.3.

---

## 5. End-to-End Workflow & Lifecycle State Model

The room workflow state machine models every active meeting through strict lifecycle phases. The complete transition matrix is in [ServiceLowLevelDesign.md §3.2](ServiceLowLevelDesign.md).

```text
  +--------------+
  |     Idle     | <--------------------------------------------------+
  +-------+------+                                                    |
          | Booking starts (BookedUntil)                              |
          |                                                           |
          +--> Quarantined (meeting already active at service start)  |
          |      | only a matching RoomOS CheckedIn event releases it |
          v      v                                                    |
  +--------------+                                                    |
  | ActiveMeeting| <-- Keep Booking / Cancel (presence re-read) ------+
  +-------+------+                                                    |
          | Room becomes Empty (No-Show, or Early Departure           |
          | after CheckIn when enabled) and time remaining > horizon  |
          v                                                           |
  +--------------+                                                    |
  |  Countdown   | ---> Room becomes Occupied: cancel, auto CheckIn --+
  |  Scheduled   |                                                    |
  +-------+------+                                                    |
          | EMPTY_ROOM_TIMEOUT - PRE_TIMEOUT_WARNING elapses          |
          v                                                           |
  +--------------+  Occupied: prompt RETAINED for user action         |
  |PromptVisible |  Dismissed: prompt RESTORED (deadline unchanged)   |
  |              |  Check Out: confirmation guard -> Confirm releases |
  +-------+------+    immediately (UserConfirmed, no notice email)    |
          | Fixed deadline reached (warning + grace)                  |
          v                                                           |
  +--------------+                                                    |
  | JIT Validate | ---> Any check fails: preserve booking ------------+
  +-------+------+                                                    |
          | Every check passes (LLD §5.5)                             |
          v                                                           |
  +--------------+                                                    |
  |   Released   | ---> Free / FreeUntil -----------------------------+
  +--------------+

  At any phase: Unknown presence, Free/FreeUntil, booking rollover, or a failed
  health check cancels the workflow and preserves the booking.
```

### 5.1 No-Show Release Policy

1. Meeting starts, room remains vacant, no check-in recorded.
2. **Booking Sync Coalescing**: Buffers rapid bursts of `BookedUntil` and `TimeStamp` events for 50ms before reading booking details to ensure an atomic snapshot.
3. **Bounded Readiness Recovery**: If transient metadata is missing or unavailable, each attempt on `[250ms, 500ms, 1000ms, 2000ms, 4000ms]` rebuilds the full snapshot. It uses `Bookings.Get({ Id })` when the booking ID is known and `Bookings.List({ ScheduleType: 'Current', Limit: 1 })` when it is missing. Exhaustion preserves the booking until the next room event or midnight health check (LLD §5.3).
4. **Minimum Remaining Time Guard**: Verifies `timeRemaining = endTime - now`. A countdown starts only if `timeRemaining > EMPTY_ROOM_TIMEOUT_MS + POST_TIMEOUT_GRACE_PERIOD_MS` (`LIVE`, e.g. strictly more than 12 minutes) or `> EMPTY_ROOM_TIMEOUT_MS` (`DRY_RUN`). Otherwise autocancellation is skipped and logged.
5. At `EMPTY_ROOM_TIMEOUT_MS - PRE_TIMEOUT_WARNING_MS`, the service fixes one warning deadline (`PRE_TIMEOUT_WARNING_MS + POST_TIMEOUT_GRACE_PERIOD_MS`) and presents the prompt on every currently suitable surface.
6. Prompt phase:
   - The service issues `displayWarning` with initial text and starts the 60s audio chime loop. The controller displays `Keep this booking?`.
   - If no actionable surface accepts the prompt, the service logs it and keeps the deadline so a reconnecting controller receives the remaining time. Expiry without an actionable surface preserves the booking.
   - The service dispatches `sendCancellationWarning` via `INotificationDriver` to the meeting organizer's email. Warning email delivery is tracked; if delivery fails after immediate retries, the service fails closed and marks the booking protected from release.
7. If untouched and the room remains vacant until timeout + grace period:
   - The JIT Probe runs the full release validation checklist (LLD §5.5): vacancy, actionable prompt ownership, unchanged booking identity, and fresh reclassification.
   - The service issues `checkOut`.
   - Upon confirmed checkout, the service dispatches `sendCancellationNotice` (No-Show template) to the organizer.

### 5.2 Early Departure Release Policy

1. Meeting started, and CheckIn was confirmed by a matching RoomOS `Bookings.CheckedIn` event (manual, ad hoc, or the service's automatic CheckIn). A successful CheckIn command alone is not confirmation. In `DRY_RUN`, a validated simulated automatic CheckIn counts for policy selection only.
2. Attendees leave early. Presence changes to `Empty`.
3. If `EARLY_DEPARTURE_RELEASE_ENABLED` is true (default `false`), the service initiates the empty-room countdown. When it is false, post-CheckIn vacancy is logged and starts no release workflow:
   - At `EMPTY_ROOM_TIMEOUT_MS - PRE_TIMEOUT_WARNING_MS`, displays in-room warning and dispatches `sendCancellationWarning` to the organizer.
   - If vacated until timeout + grace period, executes JIT Probe, issues `checkOut`, and dispatches `sendCancellationNotice` (Early Departure template).

### 5.3 Long Meeting & Group/VIP Exemption Policy

1. **Long-Meeting Exemption**: Current bookings exceeding `LONG_MEETING_EXEMPTION_THRESHOLD_MS` (default 120 minutes) or unclassifiable bookings are classified as `Long` or `Unclassifiable`. Autocancellation is strictly `Blocked`.
2. **VIP & Group Exemption**: Meetings organized by individuals in `EXEMPT_ORGANIZERS` (e.g. executive assistants, C-suite) or matching configured department/title tags are classified as `Exempt` and blocked from release.
3. **Native Check-In Toggling**: For any exempt, unclassifiable, quarantined, or otherwise blocked meeting, `setNativeCheckInEnabled(roomId, false)` is issued to disable native RoomOS no-show cancellation. While meeting length is still being verified, no write is made. When the meeting ends, `setNativeCheckInEnabled(roomId, true)` restores the baseline (LLD §5.6).

### 5.4 Ad Hoc "Booked from Device" Guard

If `response.Booking.BookedFromDevice === 'True'`, automatic check-in is suppressed because occupants created the meeting directly on the room touch panel; the service awaits the native RoomOS check-in event.

### 5.5 External Release Observation

When a room transitions to `Free` or `FreeUntil` before its scheduled end time, the service checks whether the release was triggered by its own pending checkout. If not, it emits a structured `[EXTERNAL_RELEASE_OBSERVED]` audit log capturing booking ID, start time, end time, and released status.

### 5.6 Codec-Local Timezone Midnight Health Scheduling

The service parses each codec's local ISO timezone offset (e.g. `+02:00`), calculates the exact millisecond delay until local midnight on that physical codec, and schedules a midnight health check. If timezone offset is unavailable or invalid, the service flags `CodecTimeUnavailable` and suspends automatic release.

### 5.7 Presence, Prompt, and User-Interaction Rules (Macro Parity)

- **Occupancy before the prompt** cancels the countdown and schedules one automatic CheckIn.
- **Occupancy while the prompt is visible** retains the prompt so occupants can act. Automatic CheckIn is deferred. Expiry with confirmed occupancy aborts release (`room_not_confirmed_empty`), clears the prompt, preserves the booking, and schedules automatic CheckIn.
- **Unknown presence** at any phase cancels the workflow and blocks release until a full presence revalidation succeeds.
- **Keep Booking** (or `Cancel` on the confirmation) clears both prompts, stops the chime, and re-reads presence. `Empty` starts a fresh countdown whose later warning uses `REPEATED` text. `Occupied` schedules automatic CheckIn. `Unknown` suspends autocancellation.
- **Check Out** opens a confirmation guard on the remaining deadline. Confirming issues an immediate `checkOut(..., 'UserConfirmed')` after re-reading the booking snapshot, with no cancellation notice. If the deadline expires unconfirmed, release is aborted; a re-read `Empty` restores the original warning with a full new deadline, and any other result preserves the booking.
- **Dismissal without a selection** restores only the dismissed target, for the remaining time. The deadline is never extended and no duplicate warning email is sent.
- **Stale or unmatched prompt responses** are logged and ignored.
- **Controller topology changes** during a prompt clear an unavailable controller prompt and show a reconnecting controller the remaining time, without changing the deadline.
- **Automatic CheckIn** is attempted at most once per lifecycle, carries `TrackingData: BookingAutoCancellation_Automatic`, and revalidates booking, end time, and occupancy before sending. It is suppressed by a matching `CheckedIn` event or `BookedFromDevice`. `Cannot check in booking that is already checked in.` is logged as informational. A failed automatic CheckIn never blocks a later No-Show release.
- **CheckOut failure** records `Blocked / CheckOutFailed` for the rest of the lifecycle. The service never falls back to `Delete`.

---

## 6. Two-Tier Reconciler Architecture

To prevent drift between external service memory and physical room states, the system implements a two-tier reconciliation engine:

### Tier 1: Just-In-Time (JIT) Synchronous Verification Probe

- **Execution Point**: Executed synchronously at the exact moment before a release command is dispatched ($T=0$).
- **Direct Hardware Verification**: Calls `getPresence(roomId)`, `getAvailability(roomId)`, and `getBookingDetails(roomId, bookingId)` directly. In `LIVE` mode it also re-verifies that an actionable surface still owns the displayed prompt. The full ordered checklist is in LLD §5.5.
- **Fail-Closed Gate**: If the room is `Occupied` or `Unknown`, no actionable surface owns the prompt, the booking ID or end time changed, the booking reclassifies as long or unclassifiable, or any call fails or times out, the release is aborted immediately and logged as `ReleaseAbortedPreserved`.

### Tier 2: Background Drift & Health Sweeper

- **Cadence**: Executes periodically (configurable, e.g. every 15 minutes) and at codec-local midnight.
- **Functions**:
  1. Detects orphaned room timers where expected events were lost.
  2. Queries Control Hub device connection status to flag offline or maintenance rooms.
  3. Re-verifies baseline presence sensor configurations (`RoomAnalytics.PeoplePresenceDetector: On`).

---

## 7. Multi-Room Fleet, Operational Safety & Configuration Dashboard

### 7.1 Room Lifecycle, Enrollment & Maintenance Mode

**Nothing is enrolled automatically.** The Fleet Roster, persisted in the durable store (§8.3), is the sole authority on which rooms the service manages:

- The service synchronizes device inventory against Webex Control Hub at startup and every 15 minutes, through the read-only `IFleetInventoryDriver`.
- **A newly discovered workspace is recorded as `DISABLED`.** It has no room actor, and every event from it is discarded at the roster gate. The service sends it no command and no configuration write. If 10 workspaces are added to Control Hub tomorrow, the only effect is 10 new `DISABLED` roster entries, an audit record each, and a "10 discovered, not enrolled" notice on the dashboard.
- **Only an administrator promotes a room:** `DISABLED → MONITOR_ONLY → DRY_RUN → LIVE` (or `DISABLED → DRY_RUN`). `LIVE` is reachable only from `DRY_RUN`, after a readiness report and an explicit, audited confirmation. How long a room stays in `DRY_RUN` is the administrator's judgement.
- **The system may only demote.** A replaced device (a different device ID in the workspace) is demoted to `DISABLED` and flagged `DeviceMismatch`. A workspace with several booking-capable devices is flagged `AmbiguousWorkspace` until an admin selects one. A managed device that disappears is flagged `Missing`.
- Rooms marked `disconnected` or undergoing maintenance are flagged as `Offline`. Any active countdown or warning for an offline room is immediately halted. Automation fails closed.
- **Recommended second safeguard: location-limited activation.** Activate the Workspace Integration only for the Control Hub locations in scope, rather than org-wide. Per the official [workspace-integrations SDK documentation](https://github.com/cisco-ce/workspace-integrations-nodejs), when an integration "has been allowed for only certain locations", xCommands and xStatus calls to devices outside those locations fail with `403 Forbidden`. **The limit is partial:** the integration can still list every device in the org and *change device configurations* org-wide (configuration access comes from the `spark-admin:devices_write` admin scope). Location scoping therefore backs up the roster gate for commands and status, but the roster gate remains the only control over configuration writes. Because discovery lists the whole org, out-of-scope devices also appear as `DISABLED` roster entries; that is harmless, and the dashboard groups them by location.
- Full rules: [ServiceLowLevelDesign.md §5.7, §7.1 and §8](ServiceLowLevelDesign.md).

### 7.2 Progressive Rollout Roster

Each room record maintains an execution mode:

- `DISABLED` (default for every discovered room): no actor, no reads, no writes, no metrics. All events are discarded. Demoting a managed room to `DISABLED` first performs the mode-exit clean-up (cancel the workflow, clear prompts, restore the room's recorded native CheckIn baseline).

- `MONITOR_ONLY`: A **permanent hands-off mode** for sensitive rooms (e.g. executive boardrooms) that must never be touched by automation but should still appear in utilization reporting. It is not a rollout stage; `DRY_RUN` is the rehearsal mode. The service is strictly read-only for these rooms:
  - **No writes of any kind:** no prompts, audio, CheckIn, CheckOut, emails, or device configuration writes (presence baseline, `Bookings.CheckIn.WindowDuration`, `Bookings.CheckIn.Enabled`).
  - **The room's own baseline stays in force.** If native RoomOS CheckIn/no-show release is enabled on the device, it keeps operating as it does today. The service observes such releases and logs them as `[EXTERNAL_RELEASE_OBSERVED]`.
  - **No release workflow, real or simulated.** The service records utilization telemetry only: occupied/empty time against booked time, would-be no-shows, and external releases.
  - **Missing telemetry is reported, not repaired.** If presence telemetry is unavailable (for example, sensors not configured), the dashboard flags the room as `PresenceTelemetryUnavailable` instead of writing configuration. Enabling sensors on such a room is a deliberate admin action outside this mode.
  - Mode transitions into and out of `MONITOR_ONLY` follow [ServiceLowLevelDesign.md §5.7](ServiceLowLevelDesign.md).
- `DRY_RUN`: Matches the macro's dry run. It writes the presence baseline and `Bookings.CheckIn.WindowDuration`, and sets `Bookings.CheckIn.Enabled = False` when the baseline has it enabled (failing closed if it cannot). It never enables native CheckIn. Booking validation is the same as `LIVE`, but the post-timeout grace period is omitted: the release horizon is `EMPTY_ROOM_TIMEOUT_MS` and the simulated warning lasts `PRE_TIMEOUT_WARNING_MS`. No actionable surface is required. It logs `[DRY RUN - INTENT_TO_AUTOMATIC_CHECK_IN]`, `[DRY RUN - SIMULATED_CHECK_IN]`, `[DRY RUN - WOULD_DISPLAY_PROMPT]`, `[DRY RUN - WOULD_SEND_EMAIL]`, and `[DRY RUN - WOULD_RELEASE]`. It suppresses prompts, audio, booking commands, and live emails. A simulated CheckIn selects the release policy but never clears startup quarantine. Occupancy during the simulated warning cancels it and schedules the (simulated) automatic CheckIn.
- `LIVE`: Full autonomous operation.

### 7.3 Automated Anomaly Tripwire & Emergency Kill Switch

- **Automated Anomaly Tripwire**: If the fleet-wide cancellation rate exceeds a safety threshold (e.g., >30 cancellations across the fleet within any 5-minute sliding window), the service automatically trips into emergency fail-closed mode and halts all releases.
- **Instant Kill Switch**: Stops all cancellation commands instantly, without restarting the service. It is active if *either* the persisted store value (toggled from the dashboard) *or* the `AUTOCANCEL_KILL_SWITCH` environment/SSM parameter is true, so it survives restarts and remains usable when the store or dashboard is unavailable. Activating it always applies immediately, even if persisting fails; deactivating it requires a successful persist.
- **Tripwire persistence**: A tripped tripwire is persisted and stays tripped across restarts until an administrator resets it.

### 7.4 Configurable Exemption Engine & Lightweight "Google-Style" Dashboard

The service embeds a lightweight, server-rendered administration and configuration dashboard (`GET /admin`) designed with a clean, Google-style interface (white background, fast tabular results, zero heavy frontend frameworks):

- **Instant Emergency Kill Switch**: Prominent 1-click toggle to pause/resume all automated cancellations across the fleet.
- **Search Bar**: Instant filtering by room name, room ID, organizer email, or lifecycle status.
- **Fleet Table**: Displays active rooms, current booking subject/organizer, presence state (`Occupied`/`Empty`), workflow phase (`Idle`, `CountdownScheduled`, `PromptVisible`, `Quarantined`), and remaining countdown seconds.
- **Configuration & Exemption Panel**: Web UI form allowing administrators to view and update without code changes:
  - `EMPTY_ROOM_TIMEOUT_MS`, `PRE_TIMEOUT_WARNING_MS`, `POST_TIMEOUT_GRACE_PERIOD_MS`
  - `LONG_MEETING_EXEMPTION_THRESHOLD_MS`
  - `EXEMPT_ORGANIZERS` (comma-separated list of VIP emails)
  - `EXEMPT_TITLE_KEYWORDS` (e.g., "Board Review", "Confidential", "Executive")
  - `NOTIFICATIONS_ENABLED` (global toggle for email notifications)
  - `SMTP_HOST` (e.g. `outlook.suncorp.com.au`), `SMTP_PORT` (e.g. 25), `SMTP_FROM` (e.g. `no-reply-roombookings@suncorp.com.au`), `SMTP_SECURE`
  - Per-room mode changes (`DISABLED` / `MONITOR_ONLY` / `DRY_RUN` / `LIVE`), restricted to the promotion path in §7.1. `DRY_RUN → LIVE` shows the readiness report and requires explicit confirmation.
- **Enrollment View**: Lists **Discovered (not enrolled)** rooms and rooms flagged `Missing`, `DeviceMismatch`, `AmbiguousWorkspace`, `CleanupIncomplete`, or `PresenceTelemetryUnavailable`. For an ambiguous workspace, the admin selects the managed device here.
- **Persistence & Audit**: Every dashboard change is persisted to the fleet configuration store before it takes effect, survives restarts, and is recorded in the append-only audit log (who, when, before, after).
- **Access Control (interim)**:
  - The dashboard binds to `127.0.0.1` only and is never exposed on a network interface.
  - Access requires a single shared admin password supplied through `ADMIN_DASHBOARD_PASSWORD` (an SSM `SecureString` in AWS, `.env.local` on a laptop). The password is compared in constant time and failed logins are rate-limited.
  - Successful logins get an HTTP-only, `SameSite=Strict` session cookie, and every state-changing request requires a CSRF token.
  - If no password is configured, the dashboard refuses to start rather than running open.
  - Because the identity is shared, audit records use the actor `admin`.
  - Per-user identity (corporate SSO), role separation (for example, who may promote to `LIVE`), and the remote access path in AWS are deferred to a later phase.

---

## 8. Deployment & Execution Architecture

### 8.1 Local Developer Workflow (Laptop)

- Engineer runs `npm run dev`.
- Service loads `.env.local` with `NOTIFICATION_MODE=longpolling`.
- Outbound HTTPS long-polling handles Webex device events with zero inbound ports.
- `MockNotificationDriver` captures warning and cancellation emails, formatting rich previews to the terminal console and recording them in memory for test verification.
- `JsonFileFleetConfigStore` persists the roster, settings, and audit log to a gitignored file under `service/.local/`, so local runs need no database. A fresh file manages no rooms until an engineer enrolls a test room.

### 8.2 Production Infrastructure on AWS (Terraform-Provisioned)

To keep cloud operations as simple, maintainable, and reliable as possible, the AWS infrastructure is fully codified via Terraform. The architecture is intentionally compute-agnostic, supporting either a containerized service or a dedicated VM depending on organizational hosting standards:

- **Compute Option A (Containerized - AWS ECS Fargate)**:
  - Runs as a single active task (Min=1, Max=1) managed by an ECS Service, deployed with `minimumHealthyPercent = 0` and `maximumPercent = 100` so two tasks never overlap (the DynamoDB lease is the second guard).
  - Zero OS maintenance, zero AMI patching, instant container startup.
  - Automatically restarts failed tasks within seconds.
- **Compute Option B (Virtual Machine - AWS EC2 RHEL 9)**:
  - Single instance (`t4g.small` or `t3.small`) managed by an Auto Scaling Group (Min=1, Max=1, Desired=1) across two Availability Zones.
  - Process supervised natively by Linux `systemd` (`booking-autocancel.service`) with `Restart=always`.
- **Common Network & Security Architecture**:
  - **VPC Subnets**: Deployed strictly inside private subnets (zero public IP, zero inbound security group rules).
  - **Outbound Egress**:
    - Outbound HTTPS (TCP 443) to Webex Cloud APIs for long-polling telemetry and Control Hub inventory.
    - DynamoDB through the VPC gateway endpoint (no internet path).
    - Outbound SMTP (TCP 25) routed across the enterprise network / Direct Connect / Transit Gateway to `outlook.suncorp.com.au`.
  - **Zero Plaintext Secrets**: Webex credentials and secrets injected from AWS SSM Parameter Store (`SecureString`) at startup via IAM role / instance profile.
  - **Observability**: CloudWatch Logs integration with structured JSON audit streams, CloudWatch Metric Filters for cancellation counts, and alarms on tripwire triggers.

### 8.3 Fleet Configuration Store (DynamoDB)

- Three on-demand tables: rooms (roster), settings (global settings and the single-instance lease), and an append-only audit table. All have point-in-time recovery, deletion protection, and encryption at rest, and are provisioned by Terraform.
- The tables are reached from the private subnets through a **DynamoDB VPC gateway endpoint**, so no internet egress is needed. The service IAM role is scoped to these three tables, and has no update or delete permission on the audit table.
- Room runtime state stays in memory; only admin-controlled state is durable. If the store is unreachable at startup, the service manages nothing until it loads.
- A DynamoDB lease item ensures only one service instance drives rooms at a time (for example, during an ECS deployment overlap).
- Details: [ServiceLowLevelDesign.md §8](ServiceLowLevelDesign.md).
