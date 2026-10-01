# Booking Auto Cancellation External Service - High-Level Design (HLD)

## 1. Document Purpose and Scope

This document specifies the target architecture and high-level design for an external, vendor-agnostic meeting room booking autocancellation service. 

The service transitions the existing single-codec RoomOS macro logic to a centralized, multi-room backend service capable of managing ~800 meeting spaces. The service enforces strict policy parity with the codec-native baseline while decoupling room occupancy detection, in-room user interaction, and calendar booking operations behind clean domain boundaries.

### Initial Deployment Scope
- **Managed Fleet**: Approximately 800 corporate meeting rooms.
- **Calendar Provider**: Microsoft Exchange (connected through Cisco Webex Control Hub Hybrid Calendar / Room Booking services for Phase 1).
- **Device Ecosystem**: Cisco RoomOS codecs (Room Kit, Room Bar, Board, Desk Pro) accessed via the Webex Workspace Integration framework.
- **Hardware Agnosticism**: Standardized Hardware Abstraction Layer (HAL) allowing future replacement or augmentation of codecs with alternative hardware vendors (e.g., Poly, Neat, Logitech) or third-party occupancy sensors.
- **Runtime Environment**:
  - **Local Development**: Node.js / TypeScript running locally on engineer workstations via outbound long-polling (zero inbound firewall pinholes, zero ngrok/tunneling required).
  - **Production Target**: Red Hat Enterprise Linux (RHEL 9) single-instance / Multi-AZ Auto Scaling Group (Min=1, Max=1) on AWS EC2, managed via native `systemd` and monitored via AWS CloudWatch.

---

## 2. Business Context & Controlling Safety Invariant

Unused reserved rooms reduce collaborative capacity. However, false cancellations disrupt ongoing business meetings, executive reviews, and client presentations. 

The external service inherits the strict, fail-closed safety invariant established in the codec-native solution:

```text
Prove current booking identity, room vacancy, hardware health, and release safety.
Only when every condition is conclusively verified may an automatic booking action proceed.
Otherwise: preserve the booking and take no action.
```

### Core Invariants:
1. **Never Delete**: The service requests `CheckOut`; it never invokes destructive calendar deletion commands.
2. **Actionable Warning Surface Required**: In production, an empty-room release cannot execute unless an actionable prompt (`Keep Booking` / `Check Out`) was successfully displayed to a physical in-room touch surface or certified interactive display.
3. **Fail-Closed on Startup / Restart**: Any meeting underway when the service starts or restarts is placed into an immediate **Startup Check-In Quarantine** (`AwaitingStartupCheckIn`). It will never be auto-cancelled unless fresh occupancy and check-in confirmation are observed.
4. **Just-In-Time (JIT) Verification Probe**: Immediately prior to issuing a release command at $T=0$, the service executes a synchronous, real-time read directly against the room hardware to guarantee the space is still vacant and the booking identity has not changed.

---

## 3. System Architecture & Hexagonal Seams

The service is structured according to Hexagonal Architecture (Ports and Adapters). Core booking autocancellation workflow logic has zero coupling to Cisco xAPI, Webex SDKs, or cloud network protocols.

```
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
|                     +--------------------------+--------------------------+                        |
|                     |                          |                          |                        |
|                     v                          v                          v                        |
|            IRoomPresenceDriver        IRoomInteractionDriver      ICalendarConnector               |
|            (Occupancy Telemetry)      (In-Room UI & Audio)        (Bookings/CheckIn/Out)           |
|                     |                          |                          |                        |
+---------------------|--------------------------|--------------------------|------------------------+
                      |                          |                          |
                      v                          v                          v
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
|     |                      Future Adapters (Pluggable Hardware Modules)                       |    |
|     |     * Poly / Neat Presence Driver       * Microsoft Graph Direct Calendar Connector      |    |
|     +-----------------------------------------------------------------------------------------+    |
+----------------------------------------------------------------------------------------------------+
```

---

## 4. Domain Ports & Driver Abstractions

To achieve true hardware vendor agnosticism, the domain boundary defines four distinct interfaces:

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

### 4.3 Calendar Connector (`ICalendarConnector`)
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

---

## 5. End-to-End Workflow & Lifecycle State Model

The room workflow state machine models every active meeting through strict lifecycle phases:

```
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
5. At `EMPTY_ROOM_TIMEOUT_MS - PRE_TIMEOUT_WARNING_MS` (e.g. at 5 minutes into a 10-minute timeout), the service checks for an actionable surface (`hasActionableSurface`).
6. If valid, the service issues `displayWarning` with initial text and starts the 60s audio chime loop. Controller displays `Keep this booking?`.
7. If untouched and room remains vacant until timeout + grace period, the JIT Probe verifies vacancy and issues `checkOut`.

### 5.2 Early Departure Release Policy
1. Meeting started and was checked in (either manually, via ad hoc booking, or auto-checkin).
2. Attendees leave early. Presence changes to `Empty`.
3. If `EARLY_DEPARTURE_RELEASE_ENABLED` is true, the service initiates the empty-room countdown and warning prompt sequence.

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
- `MONITOR_ONLY`: Observes and logs telemetry; executes no prompts or booking commands.
- `DRY_RUN`: Simulates countdowns and logs `[DRY RUN - WOULD_DISPLAY_PROMPT]` and `[DRY RUN - WOULD_RELEASE]`; suppresses booking commands.
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
  - Per-room mode toggles (`MONITOR_ONLY` / `DRY_RUN` / `LIVE`)

---

## 8. Deployment & Execution Architecture

### 8.1 Local Developer Workflow (Laptop)
- Engineer runs `npm run dev`.
- Service loads `.env.local` with `NOTIFICATION_MODE=longpolling`.
- Service initiates an outbound HTTPS connection to the Webex cloud integration message queue.
- Events from test rooms are delivered directly to the laptop. Zero inbound firewall configuration, zero ngrok tunnels.

### 8.2 Production Infrastructure (AWS EC2 RHEL 9)
- **Host**: Single EC2 instance (`t4g.small` or `t3.small`) inside a private VPC subnet.
- **High Availability**: Managed by an AWS Auto Scaling Group (Min=1, Max=1, Desired=1) spanning two Availability Zones. If the host or AZ fails, ASG launches a replacement instance in the healthy AZ within 2–3 minutes.
- **Process Supervisor**: Linux `systemd` (`booking-autocancel.service`) with `Restart=always` and memory limits.
- **Configuration & Secrets**: Injected from AWS SSM Parameter Store (`SecureString`) at startup via IAM instance profile. Zero plaintext credentials on disk.
- **Observability**: AWS CloudWatch Agent forwards structured JSON logs from `journald` to CloudWatch Logs with metric alarms configured for failed checkouts and tripwire events.
