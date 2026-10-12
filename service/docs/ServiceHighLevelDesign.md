# Booking Auto Cancellation External Service - High-Level Design (HLD)

## 1. Document Purpose and Scope

This document specifies the target architecture and high-level design for an external, vendor-agnostic meeting room booking autocancellation service.

The service transitions the existing single-codec RoomOS macro logic to a centralized, multi-room backend service capable of managing ~800 meeting spaces. The service enforces strict policy parity with the codec-native baseline while decoupling room occupancy detection, in-room user interaction, and calendar booking operations behind clean domain boundaries.

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

For the comprehensive visual Domain-Driven Design (DDD) architecture model detailing Aggregate Roots, Domain Policies, Safety Guards, and mutable configuration bindings, see [service/docs/ServiceDomainDrivenDesign.md](service/docs/ServiceDomainDrivenDesign.md).

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
|                     +------------------+------------------+------------------+                    |
|                     |                  |                  |                  |                    |
|                     v                  v                  v                  v                    |
|            IRoomPresenceDriver  IRoomInteraction  ICalendarDriver     INotificationDriver         |
|            (Occupancy)          (In-Room UI)      (Bookings/CheckIn)  (Email Notifications)       |
|                     |                  |                  |                  |                    |
+---------------------|------------------|------------------|------------------|--------------------+
                      |                  |                  |                  |
                      v                  v                  v                  v
+----------------------------------------------------------------------------------------------------+
|                                        ADAPTER LAYER                                               |
|                                                                                                    |
|     +-----------------------------------------------------------------------------------------+    |
|     |                         Webex Workspace Integration Adapter                             |    |
|     |              (Implements Presence, Interaction, Calendar & Config Drivers)              |    |
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
|     |                      Future Adapters (Pluggable Hardware Modules)                       |    |
|     |     * Poly / Neat Presence Driver       * Microsoft Graph Direct Calendar Driver         |    |
|     +-----------------------------------------------------------------------------------------+    |
+----------------------------------------------------------------------------------------------------+
```

---

## 4. Domain Ports & Driver Abstractions

To achieve true hardware vendor and notification provider agnosticism, the domain boundary defines five distinct interfaces:

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
- `clearWarning(roomId: string, promptId: string): Promise<void>`: Dismisses prompts across controller and OSD targets.
- `restoreDismissedPrompt(roomId: string, prompt: WarningPromptRequest): Promise<void>`: Immediately re-displays prompt if dismissed without selection (via user swipe or `Prompt.Cleared`) for remaining warning duration.
- `playAudioAlert(roomId: string, alert: AudioAlertConfig): Promise<void>`: Overrides volume to 70 (`Audio.Volume.Set({ Level: 70 })`), plays `Announcement` sound (`Audio.Sound.Play({ Sound: 'Announcement' })`), holds for 4 seconds, restores default volume (`Audio.Volume.SetToDefault()`), and repeats every 60s while prompt is visible.
- `restoreAudioVolume(roomId: string): Promise<void>`: Restores volume to default upon prompt clear or dismissal.
- `onPromptResponse(handler: (event: PromptResponseEvent) => void): void`: Ingests user selections (`OptionId: '1'` or `'2'`).
- `onPromptCleared(handler: (event: PromptClearedEvent) => void): void`: Ingests prompt dismissal events.

### 4.3 Calendar Driver (`ICalendarDriver`)

Abstracts meeting reservation metadata and release execution:

- `getAvailability(roomId: string): Promise<RoomAvailabilitySnapshot>`: Returns `Free`, `FreeUntil`, or `BookedUntil` with timestamps.
- `getBookingDetails(roomId: string, bookingId: string): Promise<BookingDetails>`: Queries `Bookings.Get({ Id })` with fallback to `Bookings.List({ ScheduleType: 'Current', Limit: 1 })`. Includes `BookedFromDevice` flag, organizer email/name, meeting title, start/end timestamps.
- `checkIn(roomId: string, bookingId: string, trackingData?: string): Promise<void>`: Executes meeting check-in with `TrackingData: 'BookingAutoCancellation_Automatic'`.
- `checkOut(roomId: string, bookingId: string, reason: string): Promise<void>`: Executes meeting release (`Bookings.CheckOut({ Id })`).
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
- `sendCancellationNotice(payload: CancellationNoticePayload): Promise<NotificationResult>`: Dispatches a conclusive cancellation notice to the meeting organizer immediately following a successful calendar `checkOut()`.
  - **Differentiated Templates**: Contextual messaging explicitly distinguishing **No-Show Release** (room unoccupied after meeting start) from **Early Departure Release** (room vacated and left empty before scheduled end time).
- **Template Presentation**: Responsive multipart MIME (HTML with structured corporate branding, room name, scheduled meeting time, and clear bullet instructions) accompanied by an RFC-compliant plain-text fallback.
- **Enterprise SMTP Adapter**: Implemented by `SmtpNotificationAdapter` connecting to `outlook.suncorp.com.au:25` via unauthenticated direct relay (with configurable overrides for port, credentials, and TLS in the admin dashboard).
- **Simulation Safety**: In `DRY_RUN` and `MONITOR_ONLY` modes, physical SMTP delivery is suppressed; the adapter emits structured `[DRY RUN - WOULD_SEND_EMAIL]` audit logs.

---

## 5. End-to-End Workflow & Lifecycle State Model

The room workflow state machine models every active meeting through strict lifecycle phases:

```text
  +--------------+
  |     Idle     | <------------------------------------------+
  +-------+------+                                            |
          | Booking starts (BookedUntil)                      |
          v                                                   |
  +--------------+                                            |
  |  Quarantined | (If meeting was active at service startup) |
  +-------+------+                                            |
          | Verified RoomOS CheckedIn event arrives           |
          v                                                   |
  +--------------+                                            |
  | ActiveMeeting|                                            |
  +-------+------+                                            |
          | Room becomes Empty                                |
          v                                                   |
  +--------------+                                            |
  |  Countdown   | ---> Room becomes Occupied ----------------+
  |  Scheduled   |                                            |
  +-------+------+                                            |
          | Timer expires (e.g. 5 min remaining)              |
          v                                                   |
  +--------------+                                            |
  |PromptVisible | ---> User taps "Keep Booking" -------------+
  +-------+------+                                            |
          | User taps "Check Out"                             |
          | OR Timer reaches zero (Empty Room Timeout)        |
          v                                                   |
  +--------------+                                            |
  | JIT Validate | ---> Presence != Empty OR Booking Changed -+
  +-------+------+                                            |
          | Conclusively Verified Vacant & Safe               |
          v                                                   |
  +--------------+                                            |
  |   Released   | -------------------------------------------+
  +--------------+
```

### 5.1 No-Show Release Policy

1. Meeting starts, room remains vacant, no check-in recorded.
2. **Booking Sync Coalescing**: Buffers rapid bursts of `BookedUntil` and `TimeStamp` events for 50ms before reading booking details to ensure an atomic snapshot.
3. **Bounded Readiness Recovery**: If transient metadata is missing (`Bookings.Current.Id` null or `Bookings.Get` error), retries on `[250ms, 500ms, 1000ms, 2000ms, 4000ms]` with `Bookings.List({ ScheduleType: 'Current', Limit: 1 })` fallback.
4. **Minimum Remaining Time Guard**: Verifies `timeRemaining = endTime - now`. If `timeRemaining <= EMPTY_ROOM_TIMEOUT_MS + POST_TIMEOUT_GRACE_PERIOD_MS` (e.g. $\le 12$ minutes), autocancellation is skipped and logged.
5. At `EMPTY_ROOM_TIMEOUT_MS - PRE_TIMEOUT_WARNING_MS` (e.g. at remaining warning window determined dynamically by `PRE_TIMEOUT_WARNING_MS`), the service checks for an actionable surface (`hasActionableSurface`).
6. If valid:
   - The service issues `displayWarning` with initial text and starts the 60s audio chime loop. Controller displays `Keep this booking?`.
   - The service dispatches `sendCancellationWarning` via `INotificationDriver` to the meeting organizer's email. Warning email delivery is tracked; if delivery fails after immediate retries, the service fails closed and marks the booking protected from release.
7. If untouched and room remains vacant until timeout + grace period:
   - The JIT Probe verifies vacancy and unchanged booking identity.
   - The service issues `checkOut`.
   - Upon confirmed checkout, the service dispatches `sendCancellationNotice` (No-Show template) to the organizer.

### 5.2 Early Departure Release Policy

1. Meeting started and was checked in (either manually, via ad hoc booking, or auto-checkin).
2. Attendees leave early. Presence changes to `Empty`.
3. If `EARLY_DEPARTURE_RELEASE_ENABLED` is true, the service initiates the empty-room countdown:
   - At `EMPTY_ROOM_TIMEOUT_MS - PRE_TIMEOUT_WARNING_MS`, displays in-room warning and dispatches `sendCancellationWarning` to the organizer.
   - If vacated until timeout + grace period, executes JIT Probe, issues `checkOut`, and dispatches `sendCancellationNotice` (Early Departure template).

### 5.3 Long Meeting & Group/VIP Exemption Policy

1. **Long-Meeting Exemption**: Current bookings exceeding `LONG_MEETING_EXEMPTION_THRESHOLD_MS` (default 120 minutes) or unclassifiable bookings are classified as `Long` or `Unclassifiable`. Autocancellation is strictly `Blocked`.
2. **VIP & Group Exemption**: Meetings organized by individuals in `EXEMPT_ORGANIZERS` (e.g. executive assistants, C-suite) or matching configured department/title tags are classified as `Exempt` and blocked from release.
3. **Native Check-In Toggling**: For any exempt meeting, `setNativeCheckInEnabled(roomId, false)` is issued to disable native RoomOS no-show cancellation. When the meeting ends, `setNativeCheckInEnabled(roomId, true)` restores the baseline.

### 5.4 Ad Hoc "Booked from Device" Guard

If `response.Booking.BookedFromDevice === 'True'`, automatic check-in is suppressed because occupants created the meeting directly on the room touch panel; the service awaits the native RoomOS check-in event.

### 5.5 External Release Observation

When a room transitions to `Free` or `FreeUntil` before its scheduled end time, the service checks whether the release was triggered by its own pending checkout. If not, it emits a structured `[EXTERNAL_RELEASE_OBSERVED]` audit log capturing booking ID, start time, end time, and released status.

### 5.6 Codec-Local Timezone Midnight Health Scheduling

The service parses each codec's local ISO timezone offset (e.g. `+02:00`), calculates the exact millisecond delay until local midnight on that physical codec, and schedules a midnight health check. If timezone offset is unavailable or invalid, the service flags `CodecTimeUnavailable` and suspends automatic release.

---

## 6. Two-Tier Reconciler Architecture

To prevent drift between external service memory and physical room states, the system implements a two-tier reconciliation engine:

### Tier 1: Just-In-Time (JIT) Synchronous Verification Probe

- **Execution Point**: Executed synchronously at the exact moment before a release command is dispatched ($T=0$).
- **Direct Hardware Verification**: Calls `getPresence(roomId)` and `getAvailability(roomId)` directly.
- **Fail-Closed Gate**: If the room is `Occupied`, `Unknown`, the booking ID changed, or the call fails/times out, the release is aborted immediately and logged as `ReleaseAbortedPreserved`.

### Tier 2: Background Drift & Health Sweeper

- **Cadence**: Executes periodically (configurable, e.g. every 15 minutes) and at codec-local midnight.
- **Functions**:
  1. Detects orphaned room timers where expected events were lost.
  2. Queries Control Hub device connection status to flag offline or maintenance rooms.
  3. Re-verifies baseline presence sensor configurations (`RoomAnalytics.PeoplePresenceDetector: On`).

---

## 7. Multi-Room Fleet, Operational Safety & Configuration Dashboard

### 7.1 Room Lifecycle & Maintenance Mode

- The service periodically synchronizes device inventory against Webex Control Hub.
- Rooms marked `disconnected` or undergoing maintenance are flagged as `Offline`.
- Any active countdown or warning for an offline room is immediately halted. Automation fails closed.

### 7.2 Progressive Rollout Roster

Each room record maintains an execution mode:

- `MONITOR_ONLY`: Observes and logs telemetry; executes no prompts, emails, or booking commands.
- `DRY_RUN`: Simulates countdowns, logs `[DRY RUN - WOULD_DISPLAY_PROMPT]`, `[DRY RUN - WOULD_SEND_EMAIL]`, and `[DRY RUN - WOULD_RELEASE]`; suppresses external commands and live emails.
- `LIVE`: Full autonomous operation.

### 7.3 Automated Anomaly Tripwire & Emergency Kill Switch

- **Automated Anomaly Tripwire**: If the fleet-wide cancellation rate exceeds a safety threshold (e.g., >30 cancellations across the fleet within any 5-minute sliding window), the service automatically trips into emergency fail-closed mode and halts all releases.
- **Instant Kill Switch**: An environment / SSM parameter (`AUTOCANCEL_KILL_SWITCH=true`) evaluated by the engine that stops all cancellation commands instantly without restarting the service.

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
  - Per-room mode toggles (`MONITOR_ONLY` / `DRY_RUN` / `LIVE`)

---

## 8. Deployment & Execution Architecture

### 8.1 Local Developer Workflow (Laptop)

- Engineer runs `npm run dev`.
- Service loads `.env.local` with `NOTIFICATION_MODE=longpolling`.
- Outbound HTTPS long-polling handles Webex device events with zero inbound ports.
- `MockNotificationDriver` captures warning and cancellation emails, formatting rich previews to the terminal console and recording them in memory for test verification.

### 8.2 Production Infrastructure on AWS (Terraform-Provisioned)

To keep cloud operations as simple, maintainable, and reliable as possible, the AWS infrastructure is fully codified via Terraform. The architecture is intentionally compute-agnostic, supporting either a containerized service or a dedicated VM depending on organizational hosting standards:

- **Compute Option A (Containerized - AWS ECS Fargate)**:
  - Runs as a single active task (Min=1, Max=1) managed by an ECS Service.
  - Zero OS maintenance, zero AMI patching, instant container startup.
  - Automatically restarts failed tasks within seconds.
- **Compute Option B (Virtual Machine - AWS EC2 RHEL 9)**:
  - Single instance (`t4g.small` or `t3.small`) managed by an Auto Scaling Group (Min=1, Max=1, Desired=1) across two Availability Zones.
  - Process supervised natively by Linux `systemd` (`booking-autocancel.service`) with `Restart=always`.
- **Common Network & Security Architecture**:
  - **VPC Subnets**: Deployed strictly inside private subnets (zero public IP, zero inbound security group rules).
  - **Outbound Egress**:
    - Outbound HTTPS (TCP 443) to Webex Cloud APIs for long-polling telemetry.
    - Outbound SMTP (TCP 25) routed across the enterprise network / Direct Connect / Transit Gateway to `outlook.suncorp.com.au`.
  - **Zero Plaintext Secrets**: Webex credentials and secrets injected from AWS SSM Parameter Store (`SecureString`) at startup via IAM role / instance profile.
  - **Observability**: CloudWatch Logs integration with structured JSON audit streams, CloudWatch Metric Filters for cancellation counts, and alarms on tripwire triggers.
