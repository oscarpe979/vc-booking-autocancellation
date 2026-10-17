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
  - **Production Target (AWS)**: Modular infrastructure provisioned via Terraform, designed to run with maximum operational simplicity in private VPC subnets with outbound connectivity to Webex (HTTPS 443) and corporate SMTP (`outlook.suncorp.com.au:25`). Runs as one `systemd`-supervised Node.js process on a single AWS EC2 RHEL 9 instance in a Min=1, Max=1 Auto Scaling Group across two Availability Zones (§8.2, ADR-002).

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
2. **Actionable Warning Surface Required**: In `LIVE` mode, an empty-room release cannot execute unless an actionable prompt (`Keep Booking` / `Check Out`) was successfully displayed to a physical in-room touch surface or certified interactive display and is still owned by it at the deadline. Controller ownership is proven by `Peripherals.ConnectedDevice` reads just before and just after the display, and release requires the same controller set at the deadline (LLD §5.11). (`DRY_RUN` displays nothing and skips this check.)
3. **Warning Email Precondition**: While `NOTIFICATIONS_ENABLED = true`, automatic room cancellation requires that a cancellation warning email was successfully dispatched to the meeting organizer for the current warning deadline. If dispatch fails after bounded retries, or the organizer email is missing, the prompt stays visible but automatic release is blocked for the rest of that booking lifecycle (zero surprise cancellations). With `NOTIFICATIONS_ENABLED = false`, no warning email is sent and this gate does not block release. See LLD §5.8.
4. **Fail-Closed on Startup / Restart**: Any meeting underway when a room actor is created (service start or restart, a reappearing device, promotion into `DRY_RUN`/`LIVE`, or a detected device reboot) is placed into an immediate **Startup Check-In Quarantine** (`AwaitingStartupCheckIn`). Because RoomOS does not deliver `Bookings.CheckedIn` to Workspace Integrations, no event can lift it: the quarantine lasts until the meeting ends, and the meeting is never auto-cancelled (LLD §5.9).
5. **Just-In-Time (JIT) Verification**: Immediately prior to issuing a release command at $T=0$, the service executes synchronous, real-time reads directly against the room hardware to guarantee the space is still vacant, the booking identity has not changed, the controller that showed the prompt is still connected, and the device has not rebooted during the workflow (LLD §5.5).

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
|     |   * Startup Quarantine Manager           * Two-Tier Reconciler (JIT Check & Drift)      |    |
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
|     |   * xStatus: Peripherals.ConnectedDevice (TouchPanel filter, read just in time, not     |    |
|     |     subscribable), SystemUnit.ProductPlatform, SystemUnit.Uptime, Time.SystemTime       |    |
|     |   * xCommand: UserInterface.Message.Prompt.*, Audio.Volume/Sound, Bookings.CheckIn/Out  |    |
|     |   * xConfig: Bookings.CheckIn.WindowDuration (default 60m), Bookings.CheckIn.Enabled,   |    |
|     |     RoomAnalytics presence baseline (PeoplePresenceDetector, RoomInUse, Ultrasound...)  |    |
|     |   * xEvent: UserInterface.Message.Prompt.Response/.Cleared, BootEvent (Bookings.        |    |
|     |     CheckedIn is not delivered to Workspace Integrations; see LLD §9)                   |    |
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
|     |     * Poly / Neat Presence Driver       * Microsoft Graph Direct Calendar Driver        |    |
|     +-----------------------------------------------------------------------------------------+    |
+----------------------------------------------------------------------------------------------------+
```

---

## 4. Domain Ports & Driver Abstractions

To achieve true hardware vendor and notification provider agnosticism, the domain boundary defines five room-facing outbound ports (§4.1–4.5), two fleet-level ports for Control Hub discovery and durable configuration (§4.6–4.7), and the driving ingress port `IEventIngressTransport` (§4.8). The exact signatures are in [ServiceLowLevelDesign.md §2.2](ServiceLowLevelDesign.md):

### 4.1 Presence Driver (`IRoomPresenceDriver`)

Abstracts physical occupancy detection:

- `getPresence(roomId: string): Promise<RoomPresenceState>`: Queries instantaneous presence (`Occupied`, `Empty`, or `Unknown`).
- `onPresenceChange(handler: (event: PresenceChangeEvent) => void): void`: Ingests asynchronous presence transitions (`RoomAnalytics.RoomInUse`).

### 4.2 In-Room Interaction Driver (`IRoomInteractionDriver`)

Abstracts user prompts, warnings, audio chimes, and touch responses:

- `readPromptSurfaces(roomId: string): Promise<PromptSurfaces>`: Reads the sorted IDs of connected touch controllers (`Peripherals.ConnectedDevice` with `Status: Connected`, `Type: TouchPanel`, `Role: Controller`), whether the device is a certified interactive display (`SystemUnit.ProductPlatform` = Desk Pro), and whether the inventory was readable (`false` on a failed read or `403`). Strictly filters out non-controller panels such as `RoomScheduler` Navigators. Never rejects. Controller topology cannot be subscribed to through a Workspace Integration, so it is read just in time at fixed workflow points only: just before and just after a display, on each 60s chime tick while a prompt is visible, and at JIT validation. There is no listener and no polling timer (LLD §5.11).
- `displayPrompt(roomId: string, prompt: PromptRequest, surfaces: PromptSurfaces): Promise<PromptDisplayResult>`: Displays either the warning or the confirmation prompt. A Navigator controller is assumed, so `Target=Controller` is always sent, plus the OSD per the platform rules. The result reports whether the controller command was accepted; the coordinator, not the driver, decides controller ownership from the reads around the display:
  - Warning: actionable buttons on the controller (`Option.1: Keep Booking`, `Option.2: Check Out`); informational OSD on the room monitor (actionable on Desk Pro). Text variant `INITIAL`, or `REPEATED` after a prior Keep Booking while the room remains vacant.
  - Confirmation: the two-step confirmation guard (`Cancel` / `Check out`) for the remaining deadline.
- `restoreDismissedPrompt(roomId: string, target: PromptTarget, prompt: PromptRequest): Promise<boolean>`: Re-displays only the dismissed target (`Controller` or `OSD`) for the remaining duration, without extending the deadline.
- `clearPrompts(roomId: string, kind: 'warning' | 'confirmation' | 'all'): Promise<void>`: Clears the given prompt kind on both targets. `'warning'` alone is used when entering the confirmation guard.
- `playAudioAlert(roomId: string): Promise<boolean>`: Plays one alert: volume 70 (`Audio.Volume.Set({ Level: 70 })`) and the `Announcement` sound (`Audio.Sound.Play`, Loop Off). Returns `false` on failure; sound is optional. The coordinator owns the 4-second hold before restoring volume and the 60s repeat while the prompt is visible.
- `restoreAudioVolume(roomId: string): Promise<void>`: Restores default volume (`Audio.Volume.SetToDefault()`).
- `onPromptResponse(handler: (event: PromptResponseEvent) => void): void`: Ingests user selections (`OptionId` normalized to `'1'` or `'2'`, plus the response `Origin`).
- `onPromptCleared(handler: (event: PromptClearedEvent) => void): void`: Ingests prompt dismissal events.

### 4.3 Calendar Driver (`ICalendarDriver`)

Abstracts meeting reservation metadata and release execution:

- `getAvailability(roomId: string): Promise<RoomAvailabilitySnapshot | null>`: Returns `Free`, `FreeUntil`, or `BookedUntil` with timestamps; `null` when the read fails (never mapped to `Free`).
- `getBookingDetails(roomId: string, bookingId: string): Promise<BookingDetails | null>`: Queries `Bookings.Get({ Id })`. Includes the `BookedFromDevice` flag, organizer email/name, meeting title, and start/end timestamps.
- `getCurrentBooking(roomId: string): Promise<BookingDetails | null>`: Queries `Bookings.List({ ScheduleType: 'Current', Limit: 1 })`; used only when the current booking ID is missing.
- `getCheckInState(roomId: string, bookingId: string): Promise<'CheckedIn' | 'NotCheckedIn' | null>`: **Pending device test DT1.** A read-only status read with no side effects, used before a No-Show countdown starts and as a JIT check before a No-Show CheckOut. It exists only if DT1 shows that `Bookings.Get`, `Bookings.List`, or an xStatus exposes a booking's CheckIn state; otherwise it is removed and the residual gap in LLD §5.9 applies.
- `checkIn(roomId: string, bookingId: string, trackingData: string): Promise<CheckInResult>`: Executes meeting check-in with `TrackingData: 'BookingAutoCancellation_Automatic'`. The result is `CheckedIn`, `AlreadyCheckedIn` (RoomOS reported that the booking is already checked in; the adapter matches the substring `already checked in`, with the exact text pending device test DT2), or `Failed`; the first two confirm CheckIn (LLD §5.9).
- `checkOut(roomId: string, bookingId: string, reason: CheckOutReason): Promise<void>`: Executes meeting release (`Bookings.CheckOut({ Id })`); rejects on failure. The reason is `NoShow`, `EarlyDeparture`, or `UserConfirmed`.
- There is no CheckIn event subscription: `Bookings.CheckedIn` is not delivered to Workspace Integrations (LLD §5.9, §9).

### 4.4 Device Configuration Driver (`IDeviceConfigDriver`)

Abstracts baseline configuration enforcement, native check-in policy, and device health reads:

- `enforceBaselinePresenceConfig(roomId: string, ultrasoundEnabled: boolean): Promise<boolean>`: Enforces `PeoplePresenceDetector: On`, `HeadDetector: On`, `PeopleCountOutOfCall: On`, `RoomInUse.InCall: Enabled`, `RoomInUse.LocalUsage: Enabled`, and `Ultrasound` per the fleet setting, batched with `xapi.config.setMany` where possible. Re-applied at actor start, midnight, readiness recovery, ingress reconnect, and lease re-acquire (§5.6, LLD §5.12).
- `getNativeCheckInEnabled(roomId: string): Promise<'True' | 'False' | null>` and `getNativeCheckInWindow(roomId: string): Promise<number | null>`: Read the native CheckIn baseline (`null` when unreadable). Used to record the room's baseline before the first write and for the `DRY_RUN` start check.
- `enforceNativeCheckInWindow(roomId: string, windowMinutes: number): Promise<boolean>`: Enforces `Bookings.CheckIn.WindowDuration` from the `nativeCheckInWindowMinutes` setting (RoomOS accepts only 5, 10, 15, 20, 30, or 60; default and maximum 60) so native RoomOS no-show release cannot race ahead of the service safety policy.
- `setNativeCheckInEnabled(roomId: string, enabled: boolean): Promise<boolean>`: Serialized per device through a FIFO queue with freshness checks. In `LIVE`, sets `False` for any blocked booking, `True` for an allowed booking, and `True` when the meeting ends (LLD §5.6). In `DRY_RUN` it is only ever set to `False`.
- `getCodecTime(roomId: string): Promise<string | null>`: Reads `Time.SystemTime` with its offset, for codec-local midnight scheduling.
- `getUptimeSeconds(roomId: string): Promise<number | null>`: Reads `SystemUnit.Uptime` (a status read) when a countdown starts, on each 60s chime tick, and at JIT validation, to detect a device reboot during a workflow (§5.7, LLD §5.13).
- `onBootEvent(handler: (event: DeviceBootEvent) => void): void`: Ingests `BootEvent` (`Restart`, `Shutdown`, `Upgrade`), which fires before the restart. It is only an early trigger to cancel a workflow, never a safety gate; RoomOS has no "booted" event.

### 4.5 Notification Driver (`INotificationDriver`)

Abstracts end-user email communications:

- `sendCancellationWarning(payload: CancellationWarningPayload): Promise<NotificationResult>`: Dispatches an urgent warning email to the meeting organizer when the in-room countdown prompt is triggered.
  - **Dynamic Time Calculation**: Never hardcodes minutes; states the real time remaining to the fixed warning deadline (`promptExpiresAt`, which includes the grace period in `LIVE`) and formats the impending release time in the codec's local clock timezone (LLD §6.1).
  - **Informational Only**: The email states that the room was detected as empty, when the reservation will be released, and that it is not released if someone is in the room at that time or if the booking is kept using the touch controller in the room before then. The email is informational only: it has no links or buttons and asks for no action in the email itself. It makes no claim about CheckIn, so it stays true in the residual gap where the service cannot see a manual panel check-in (pending device test DT1, LLD §5.9, §6.2).
  - **One Email per Deadline**: One warning email is sent per warning deadline. A new deadline (a fresh countdown after Keep Booking, or the unconfirmed-guard restore) sends a new email; re-displaying a dismissed prompt (`restoreDismissedPrompt`) keeps the deadline and never re-sends.
  - **Delivery Verification & Fail-Closed Gate** (when `NOTIFICATIONS_ENABLED = true`): If SMTP dispatch fails after bounded immediate retries, or the organizer email is missing, the service sets `warningEmailFailed` for the rest of the booking lifecycle. The prompt stays visible so occupants can still act, but automatic release is **blocked** at the deadline and no further countdown starts in that lifecycle (LLD §5.8).
- `sendCancellationNotice(payload: CancellationNoticePayload): Promise<NotificationResult>`: Dispatches a conclusive cancellation notice to the meeting organizer immediately following a successful automatic `checkOut()`. A user-confirmed CheckOut from the room controller sends no notice.
  - **Differentiated Templates**: Contextual messaging explicitly distinguishing **No-Show Release** (room unoccupied after meeting start) from **Early Departure Release** (room vacated and left empty before scheduled end time).
- **Template Presentation**: Responsive multipart MIME (HTML with structured corporate branding, room name, scheduled meeting time, and clear bullet instructions) accompanied by an RFC-compliant plain-text fallback.
- **Enterprise SMTP Adapter**: Implemented by `SmtpNotificationAdapter` connecting to `outlook.suncorp.com.au:25` via unauthenticated direct relay (with configurable overrides for host, port, sender, and TLS in the admin dashboard; no SMTP credentials are stored in fleet settings, and any secret stays in SSM).
- **Simulation Safety**: In `DRY_RUN` mode, physical SMTP delivery is suppressed and the adapter emits structured `[DRY RUN - WOULD_SEND_EMAIL]` audit logs, which satisfy the warning email gate. In `MONITOR_ONLY` mode, no warning or release workflow runs, so no email (real or simulated) is produced.

### 4.6 Fleet Inventory Driver (`IFleetInventoryDriver`)

- `listDevices(): Promise<InventoryDevice[]>`: Lists the workspaces and devices visible to the integration in Control Hub (device ID, workspace ID and name, product, connection status, booking capability). Read-only; it never issues device xAPI calls. It is used only for roster reconciliation (§7.1).

### 4.7 Fleet Configuration Store (`IFleetConfigStore`)

- Loads and conditionally writes the roster and fleet settings, and appends to the audit log. It is implemented by `DynamoFleetConfigStore` (AWS) and `JsonFileFleetConfigStore` (laptop). See §8.3.

### 4.8 Event Ingress Transport (`IEventIngressTransport`)

- `start()`, `stop()`, `onNotification(handler)`, and `onConnectivityChange(handler)`. The long-poll adapter starts polling through the SDK's `connect({ notifications: 'longpolling' })` and never calls the internal `pollData()`. The SDK cannot stop its poll loop, so `stop()` closes the roster gate. A reconnection after an outage makes every actor run a full revalidation before any new countdown starts (LLD §7.2, §9).

---

## 5. End-to-End Workflow & Lifecycle State Model

The room workflow state machine models every active meeting through strict lifecycle phases. The complete transition matrix is in [ServiceLowLevelDesign.md §3.2](ServiceLowLevelDesign.md).

```text
  +--------------+
  |     Idle     | <--------------------------------------------------+
  +-------+------+                                                    |
          | Booking starts (BookedUntil)                              |
          |                                                           |
          +--> Quarantined (meeting already active when actor created)|
          |      lasts until the meeting ends (Free / FreeUntil) -----+
          v                                                           |
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

  At any phase: Unknown presence, Free/FreeUntil, booking rollover, a failed
  health check, or an active kill switch / tripwire cancels the workflow and
  preserves the booking.

  The diagram shows LIVE. In DRY_RUN, PromptVisible is replaced by PromptPending:
  a simulated warning (nothing displayed, no audio, no email sent) lasting
  PRE_TIMEOUT_WARNING_MS without grace; JIT skips the actionable-surface check.
  MONITOR_ONLY actors only track presence and availability; DISABLED rooms have
  no actor.
```

### 5.1 No-Show Release Policy

1. Meeting starts, room remains vacant, no check-in recorded.
2. **Booking Sync Coalescing**: Buffers rapid bursts of `BookedUntil` and `TimeStamp` events for 50ms before reading booking details to ensure an atomic snapshot.
3. **Bounded Readiness Recovery**: If transient metadata is missing or unavailable, each attempt on `[250ms, 500ms, 1000ms, 2000ms, 4000ms]` rebuilds the full snapshot. It uses `Bookings.Get({ Id })` when the booking ID is known and `Bookings.List({ ScheduleType: 'Current', Limit: 1 })` when it is missing. Exhaustion preserves the booking until the next room event or midnight health check (LLD §5.3).
4. **Minimum Remaining Time Guard**: Verifies `timeRemaining = endTime - now`. A countdown starts only if `timeRemaining > EMPTY_ROOM_TIMEOUT_MS + POST_TIMEOUT_GRACE_PERIOD_MS` (`LIVE`, e.g. strictly more than 12 minutes) or `> EMPTY_ROOM_TIMEOUT_MS` (`DRY_RUN`). Otherwise autocancellation is skipped and logged.
5. **Countdown Start Reads**: The service reads `SystemUnit.Uptime` as the workflow's reboot baseline; an unreadable uptime starts no countdown. *Pending device test DT1:* if the booking's CheckIn state is readable, a `CheckedIn` state records CheckIn confirmation and starts no No-Show countdown, prompt, or email, exactly like the macro; an unreadable state starts no countdown (LLD §5.9).
6. At `EMPTY_ROOM_TIMEOUT_MS - PRE_TIMEOUT_WARNING_MS`, the service fixes one warning deadline (`PRE_TIMEOUT_WARNING_MS + POST_TIMEOUT_GRACE_PERIOD_MS`) and presents the prompt.
7. Prompt phase:
   - The service reads the controller set, issues `displayPrompt` with the warning (initial text) to the controller and OSD, reads the controller set again once the display resolves, and starts the 60s audio chime loop. The controller displays `Keep this booking?`.
   - Controller ownership is granted only if both reads found at least one connected controller; the set is captured for the deadline check. If no actionable surface owns the prompt, the service logs it and keeps the deadline; expiry without an actionable surface preserves the booking. A controller that connects later is not given ownership (LLD §5.11).
   - The service dispatches `sendCancellationWarning` via `INotificationDriver` to the meeting organizer's email for this deadline. If delivery fails after bounded immediate retries, or the organizer email is missing, `warningEmailFailed` is set: the prompt stays visible, automatic release is blocked at the deadline, and no further countdown starts in this lifecycle. With `NOTIFICATIONS_ENABLED = false` this step is skipped and does not block release (LLD §5.8).
8. If untouched and the room remains vacant until timeout + grace period:
   - The JIT validation runs the full release checklist (LLD §5.5): vacancy, actionable prompt ownership with the same controller set as at display, unchanged booking identity, fresh reclassification, the service-only gates (kill switch, tripwire, warning email gate, room mode), no device reboot since the countdown started, and, pending DT1, a `NotCheckedIn` CheckIn state.
   - The service issues `checkOut`.
   - Upon confirmed checkout, the service dispatches `sendCancellationNotice` (No-Show template) to the organizer.

### 5.2 Early Departure Release Policy

1. Meeting started, and CheckIn was confirmed. Because `Bookings.CheckedIn` is not delivered to Workspace Integrations, confirmation is the service's own successful CheckIn command, a CheckIn response that the booking is already checked in, `BookedFromDevice = True`, or, pending device test DT1, a read CheckIn state of `CheckedIn` (LLD §5.9). In `DRY_RUN`, a validated simulated automatic CheckIn counts for policy selection only.
2. Attendees leave early. Presence changes to `Empty`.
3. If `EARLY_DEPARTURE_RELEASE_ENABLED` is true (default `false`), the service initiates the empty-room countdown. When it is false, post-CheckIn vacancy is logged and starts no release workflow:
   - At `EMPTY_ROOM_TIMEOUT_MS - PRE_TIMEOUT_WARNING_MS`, displays in-room warning and dispatches `sendCancellationWarning` to the organizer.
   - If vacated until timeout + grace period, runs JIT validation, issues `checkOut`, and dispatches `sendCancellationNotice` (Early Departure template).

### 5.3 Long Meeting & Group/VIP Exemption Policy

1. **Long-Meeting Exemption**: Current bookings exceeding `LONG_MEETING_EXEMPTION_THRESHOLD_MS` (default 120 minutes) or unclassifiable bookings are classified as `Long` or `Unclassifiable`. Autocancellation is strictly `Blocked`.
2. **VIP & Group Exemption**: Meetings organized by individuals in `EXEMPT_ORGANIZERS` (e.g. executive assistants, C-suite) or matching configured department/title tags are classified as `Exempt` and blocked from release.
3. **Native Check-In Toggling** (`LIVE` only): For any exempt, unclassifiable, quarantined, or otherwise blocked meeting, `setNativeCheckInEnabled(roomId, false)` is issued to disable native RoomOS no-show cancellation. While meeting length is still being verified, no write is made. When the meeting ends, `setNativeCheckInEnabled(roomId, true)` re-enables native CheckIn for the next booking (LLD §5.6). This is the service's operating value, not the room's recorded baseline: the baseline (`Bookings.CheckIn.Enabled` and `WindowDuration`) is restored only when the room is demoted out of `DRY_RUN`/`LIVE` (LLD §5.7). In `DRY_RUN`, native CheckIn is kept `False`; in `MONITOR_ONLY`, nothing is written.

### 5.4 Ad Hoc "Booked from Device" Guard

If `response.Booking.BookedFromDevice === 'True'`, occupants created the meeting directly on the room touch panel and RoomOS checks it in natively on creation. The service records CheckIn as confirmed without sending a command, so automatic check-in is suppressed and the booking never enters No-Show (vacancy follows the Early Departure policy, if enabled). The service always reads booking details, so the flag is always known; the macro skips `Bookings.Get` when the long-meeting threshold is `0` and learns the CheckIn from the native event instead (LLD §5.14).

### 5.5 External Release Observation

When a room transitions to `Free` or `FreeUntil` before its scheduled end time, the service checks whether the release was triggered by its own pending checkout. If not, it emits a structured `[EXTERNAL_RELEASE_OBSERVED]` audit log capturing booking ID, start time, end time, and released status.

### 5.6 Codec-Local Timezone Midnight Health Check and Configuration Re-Apply

The service parses each codec's local ISO timezone offset (e.g. `+02:00`), calculates the exact millisecond delay until local midnight on that physical codec, and schedules a midnight health check. If timezone offset is unavailable or invalid, the service flags `CodecTimeUnavailable` and suspends automatic release.

Like the macro's midnight check (`reconcileAutocancellationReadiness()`), the health check **re-applies** the room's settings before it re-verifies them (LLD §5.12). The same re-apply runs at actor start, on every bounded readiness recovery attempt, after an ingress reconnect, and after the instance lease is re-acquired:

- **Writes by mode.** `DRY_RUN` and `LIVE`: the presence baseline (`PeoplePresenceDetector`, `HeadDetector`, `PeopleCountOutOfCall`, `Ultrasound` per setting, `RoomInUse.InCall`, `RoomInUse.LocalUsage`) and `Bookings.CheckIn.WindowDuration`, batched with `xapi.config.setMany` where possible. `DRY_RUN` then enforces `Bookings.CheckIn.Enabled = False`; `LIVE` re-runs the native CheckIn policy for the current status and never writes `Enabled` blindly. `MONITOR_ONLY` and `DISABLED`: no writes.
- **Fleet gates.** While the kill switch or tripwire is active, the presence and window writes still run (they never change a booking); native CheckIn writes are forbidden.
- **Jitter.** Each room runs at codec-local midnight plus a per-room random delay within a bounded window (up to 15 minutes), so ~800 rooms do not hit Webex rate limits together.
- **Failure.** A failed write or verification blocks the current booking with the matching transient reason, cancels any workflow, preserves the booking, and hands over to readiness recovery.

### 5.7 Presence, Prompt, and User-Interaction Rules (Macro Parity)

- **Occupancy before the prompt** cancels the countdown and schedules one automatic CheckIn.
- **Occupancy while the prompt is visible** retains the prompt so occupants can act. Automatic CheckIn is deferred. Expiry with confirmed occupancy aborts release (`room_not_confirmed_empty`), clears the prompt, preserves the booking, and schedules automatic CheckIn.
- **Unknown presence** at any phase cancels the workflow and blocks release until a full presence revalidation succeeds.
- **Keep Booking** (or `Cancel` on the confirmation) clears both prompts, stops the chime, and re-reads presence. `Empty` starts a fresh countdown whose later warning uses `REPEATED` text. `Occupied` schedules automatic CheckIn. `Unknown` suspends autocancellation.
- **Check Out** opens a confirmation guard on the remaining deadline. Confirming issues an immediate `checkOut(..., 'UserConfirmed')` after re-reading the booking snapshot, with no cancellation notice. If the deadline expires unconfirmed, release is aborted; a re-read `Empty` restores the original warning with a full new deadline, and any other result preserves the booking.
- **Dismissal without a selection** restores only the dismissed target, for the remaining time. The deadline is never extended and no duplicate warning email is sent.
- **Stale or unmatched prompt responses** are logged and ignored.
- **Controller topology** cannot be subscribed to, so the service reads it just in time instead of reacting to change events as the macro does (LLD §5.11). A Navigator controller is assumed and the prompt is always sent to it. Ownership needs a controller on the reads just before and just after the display. On each 60s chime tick the service re-reads the topology: a changed controller set or a failed read drops ownership, and a present controller is re-shown the prompt for the remaining time only; the deadline never moves. At the deadline, release is blocked unless the read succeeds and shows exactly the controller set captured at display. A matching `Prompt.Response` proves user intent but never authorizes an automatic release. There is no listener and no separate polling timer.
- **Automatic CheckIn** is attempted at most once per lifecycle, carries `TrackingData: BookingAutoCancellation_Automatic`, and revalidates booking, end time, and occupancy before sending. It is suppressed when CheckIn is already confirmed. Confirmation comes only from the service's own successful CheckIn, an "already checked in" response (logged as informational; this is how the service learns of a RoomOS native check-in), `BookedFromDevice`, or, pending device test DT1, a read CheckIn state (LLD §5.9). A failed automatic CheckIn never blocks a later No-Show release.
- **Manual panel check-in in an empty room** (only if DT1 shows the CheckIn state is not readable): the service cannot see it, so it runs the countdown, prompt, and warning email, and releases if nobody answers. This is the one accepted case where the service can release a booking the macro would keep; the in-room prompt and the warning email mitigate it (LLD §5.9, §5.14).
- **Device reboot during a workflow** is detected from `SystemUnit.Uptime`, read when a countdown starts, on each chime tick, and at JIT validation. An uptime lower than the baseline or less than the workflow's age aborts with `device_rebooted_during_workflow`: the workflow is cancelled, prompts are cleared, the booking is preserved, and the actor restarts with startup semantics (in-progress meeting quarantined until it ends) and a full configuration re-apply. `BootEvent` fires before a restart and is used only as an early trigger, never as the safety gate (LLD §5.13).
- **CheckOut failure** records `Blocked / CheckOutFailed` for the rest of the lifecycle. The service never falls back to `Delete`.
- **Kill switch and tripwire** (service-only) stop all automation: active workflows are cancelled and prompts cleared, and no countdown, prompt, warning email, automatic CheckIn, or CheckOut (including a user-confirmed Check Out) is started (§7.3).

---

## 6. Two-Tier Reconciler Architecture

To prevent drift between external service memory and physical room states, the system implements a two-tier reconciliation engine:

### Tier 1: Just-In-Time (JIT) Synchronous Verification

- **Execution Point**: Executed synchronously at the exact moment before a release command is dispatched ($T=0$).
- **Direct Hardware Verification**: Calls `getPresence(roomId)`, `getAvailability(roomId)`, `getBookingDetails(roomId, bookingId)`, and `getUptimeSeconds(roomId)` directly. In `LIVE` mode it also calls `readPromptSurfaces(roomId)` and requires that the controller set captured at display is still connected, or that an interactive OSD owns the prompt. *Pending device test DT1*, a No-Show release also requires `getCheckInState()` to report `NotCheckedIn`. The full ordered checklist is in LLD §5.5.
- **Fail-Closed Gate**: If the room is `Occupied` or `Unknown`, no actionable surface owns the prompt, the controller read fails, returns `403`, shows no controller, or shows a different controller set, the booking ID or end time changed, the booking reclassifies as long or unclassifiable, the device rebooted or its uptime is unreadable, or any call fails or times out, the release is aborted immediately and logged as `ReleaseAbortedPreserved`.

### Tier 2: Background Drift & Health Sweeper

- **Cadence**: Executes periodically (configurable, e.g. every 15 minutes) and at codec-local midnight.
- **Detect and block only.** The sweeper can flag a room, block or cancel its workflow, and demote it; it never restores readiness, starts a workflow, or writes configuration. Recovery happens only through the event-driven readiness recovery (LLD §5.3) and the midnight health check, both of which re-apply the room mode's configuration (§5.6).
- **Functions**:
  1. Detects orphaned room timers where expected events were lost, and cancels them (booking preserved).
  2. Queries Control Hub device connection status and inventory to flag offline, missing, or replaced devices (§7.1, LLD §8.3).
  3. Verifies the baseline presence sensor configuration (`RoomAnalytics.PeoplePresenceDetector: On`, etc.) and reports drift: a drifted room is blocked with `RequiredConfigurationsUnavailable`, not repaired by the sweeper.

---

## 7. Multi-Room Fleet, Operational Safety & Configuration Dashboard

### 7.1 Room Lifecycle, Enrollment & Maintenance Mode

**Nothing is enrolled automatically.** The Fleet Roster, persisted in the durable store (§8.3), is the sole authority on which rooms the service manages:

- The service synchronizes device inventory against Webex Control Hub at startup and every 15 minutes, through the read-only `IFleetInventoryDriver`.
- **A newly discovered workspace is recorded as `DISABLED`.** It has no room actor, and every event from it is discarded at the roster gate. The service sends it no command and no configuration write. If 10 workspaces are added to Control Hub tomorrow, the only effect is 10 new `DISABLED` roster entries, an audit record each, and a "10 discovered, not enrolled" notice on the dashboard.
- **Only an administrator promotes a room:** `DISABLED → MONITOR_ONLY → DRY_RUN → LIVE` (or `DISABLED → DRY_RUN`). `LIVE` is reachable only from `DRY_RUN`, after a readiness report and an explicit, audited confirmation. How long a room stays in `DRY_RUN` is the administrator's judgement. An administrator may demote `LIVE → DRY_RUN`, or any mode to `MONITOR_ONLY` or `DISABLED`. Promotion into `DRY_RUN`/`LIVE` and the `LIVE → DRY_RUN` demotion quarantine any meeting in progress.
- **The system may only demote, and only to `DISABLED`.** A replaced device (a different device ID in the workspace) is demoted to `DISABLED` and flagged `DeviceMismatch`. A workspace with several booking-capable devices is flagged `AmbiguousWorkspace` until an admin selects one. A managed device that disappears is flagged `Missing`.
- Rooms marked `disconnected` or undergoing maintenance are flagged as `Offline`. Any active countdown or warning for an offline room is immediately halted. Automation fails closed.
- **Recommended second safeguard: location-limited activation.** Activate the Workspace Integration only for the Control Hub locations in scope, rather than org-wide. Per the official [workspace-integrations SDK documentation](https://github.com/cisco-ce/workspace-integrations-nodejs), when an integration "has been allowed for only certain locations", xCommands and xStatus calls to devices outside those locations fail with `403 Forbidden`. **The limit is partial:** the integration can still list every device in the org and *change device configurations* org-wide (configuration access comes from the `spark-admin:devices_write` admin scope). Location scoping therefore backs up the roster gate for commands and status, but the roster gate remains the only control over configuration writes. Because discovery lists the whole org, out-of-scope devices also appear as `DISABLED` roster entries; that is harmless, and the dashboard groups them by location.
- Full rules: [ServiceLowLevelDesign.md §5.7, §7.1 and §8](ServiceLowLevelDesign.md).

### 7.2 Progressive Rollout Roster

Each room record maintains an execution mode:

- `DISABLED` (default for every discovered room): no actor, no reads, no writes, no metrics. All events are discarded. Demoting a managed room to `DISABLED` first performs the mode-exit clean-up (cancel the workflow, clear prompts, restore the room's recorded native CheckIn baseline).

- `MONITOR_ONLY`: A **hands-off mode with no automatic exit** for sensitive rooms (e.g. executive boardrooms) that must never be touched by automation but should still appear in utilization reporting. It is an optional step: a room may stay here indefinitely, and only an administrator moves it on to `DRY_RUN`. `DRY_RUN` is the rehearsal mode. The service is strictly read-only for these rooms:
  - **No writes of any kind:** no prompts, audio, CheckIn, CheckOut, emails, or device configuration writes (presence baseline, `Bookings.CheckIn.WindowDuration`, `Bookings.CheckIn.Enabled`).
  - **The room's own baseline stays in force.** If native RoomOS CheckIn/no-show release is enabled on the device, it keeps operating as it does today. The service observes such releases and logs them as `[EXTERNAL_RELEASE_OBSERVED]`.
  - **No release workflow, real or simulated.** The service records utilization telemetry only: occupied/empty time against booked time, would-be no-shows, and external releases.
  - **Missing telemetry is reported, not repaired.** If presence telemetry is unavailable (for example, sensors not configured), the dashboard flags the room as `PresenceTelemetryUnavailable` instead of writing configuration. Enabling sensors on such a room is a deliberate admin action outside this mode.
  - Mode transitions into and out of `MONITOR_ONLY` follow [ServiceLowLevelDesign.md §5.7](ServiceLowLevelDesign.md).
- `DRY_RUN`: Matches the macro's dry run. It writes the presence baseline and `Bookings.CheckIn.WindowDuration`, and sets `Bookings.CheckIn.Enabled = False` when the baseline has it enabled (failing closed if it cannot). It never enables native CheckIn. Booking validation is the same as `LIVE`, but the post-timeout grace period is omitted: the release horizon is `EMPTY_ROOM_TIMEOUT_MS` and the simulated warning lasts `PRE_TIMEOUT_WARNING_MS`. No actionable surface is required. It logs `[DRY RUN - INTENT_TO_AUTOMATIC_CHECK_IN]`, `[DRY RUN - SIMULATED_CHECK_IN]`, `[DRY RUN - WOULD_DISPLAY_PROMPT]`, `[DRY RUN - WOULD_SEND_EMAIL]`, and `[DRY RUN - WOULD_RELEASE]`. It suppresses prompts, audio, booking commands, and live emails; the `[DRY RUN - WOULD_SEND_EMAIL]` entry satisfies the warning email gate. While the simulated warning runs, the room is in the `PromptPending` phase. A simulated CheckIn selects the release policy but never clears startup quarantine. Occupancy during the simulated warning cancels it and schedules the (simulated) automatic CheckIn. Simulated releases do not count toward the tripwire.
- `LIVE`: Full autonomous operation.

### 7.3 Automated Anomaly Tripwire & Emergency Kill Switch

- **Automated Anomaly Tripwire**: If the fleet-wide cancellation rate exceeds a safety threshold (e.g., >30 cancellations across the fleet within any 5-minute sliding window), the service automatically trips into emergency fail-closed mode. Only real `LIVE` CheckOuts count; `DRY_RUN` simulated releases do not.
- **Instant Kill Switch**: Stops all automation without restarting the service. It is active if *either* the persisted store value (toggled from the dashboard) *or* the `AUTOCANCEL_KILL_SWITCH` environment/SSM parameter is true, so it survives restarts and remains usable when the store or dashboard is unavailable. The service re-reads the SSM parameter every 30 seconds, so operators can halt the fleet within 30 seconds even without the dashboard. Activating it always applies immediately, even if persisting fails; deactivating it requires a successful persist.
- **Effect of either stop** (LLD §5.8): every active countdown, simulated warning, and visible prompt is cancelled and the prompts cleared (bookings preserved); no new countdown, prompt, warning email, or automatic CheckIn starts; every CheckOut is blocked, including a user-confirmed Check Out. No native CheckIn write is made on activation, on deactivation, or while either stop is active, including the midnight and recovery re-apply (they are fleet gates, not booking statuses), which avoids a fleet-wide configuration write storm. Presence baseline and CheckIn window writes still run, because they never change a booking. After deactivation, rooms resume on their next relevant event or midnight health check.
- **Tripwire persistence**: A tripped tripwire is persisted and stays tripped across restarts until an administrator resets it.

### 7.4 Configurable Exemption Engine & Lightweight "Google-Style" Dashboard

The service embeds a lightweight, server-rendered administration and configuration dashboard (`GET /admin`) designed with a clean, Google-style interface (white background, fast tabular results, zero heavy frontend frameworks):

- **Instant Emergency Kill Switch**: Prominent 1-click toggle to pause/resume all automation across the fleet (§7.3).
- **Search Bar**: Instant filtering by room name, room ID, organizer email, or lifecycle status.
- **Fleet Table**: Displays active rooms, current booking subject/organizer, presence state (`Occupied`/`Empty`), workflow phase (`Idle`, `Quarantined`, `ActiveMeeting`, `CountdownScheduled`, `PromptPending`, `PromptVisible`, `ValidatingJIT`, `Released`), and remaining countdown seconds.
- **Configuration & Exemption Panel**: Web UI form allowing administrators to view and update without code changes:
  - `EMPTY_ROOM_TIMEOUT_MS`, `PRE_TIMEOUT_WARNING_MS`, `POST_TIMEOUT_GRACE_PERIOD_MS`
  - `LONG_MEETING_EXEMPTION_THRESHOLD_MS`, `EARLY_DEPARTURE_RELEASE_ENABLED`
  - Native CheckIn window (`nativeCheckInWindowMinutes`: 5, 10, 15, 20, 30, or 60; default 60), ultrasound sensor toggle, automatic CheckIn delay, booking sync coalesce delay, and readiness recovery delays
  - Every value is validated before it is saved (LLD §5.10) and applies only to workflows started after the change.
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
  - In AWS, admins reach the dashboard through SSM Session Manager port forwarding to the instance (§8.2); there is no inbound path.
  - Per-user identity (corporate SSO) and role separation (for example, who may promote to `LIVE`) are deferred to a later phase.

---

## 8. Deployment & Execution Architecture

### 8.1 Local Developer Workflow (Laptop)

- Engineer runs `npm run dev`.
- Service loads `.env.local` with `NOTIFICATION_MODE=longpolling`.
- Outbound HTTPS long-polling handles Webex device events with zero inbound ports.
- `MockNotificationDriver` captures warning and cancellation emails, formatting rich previews to the terminal console and recording them in memory for test verification.
- `JsonFileFleetConfigStore` persists the roster, settings, and audit log to a gitignored file under `service/.local/`, so local runs need no database. A fresh file manages no rooms until an engineer enrolls a test room.

### 8.2 Production Compute on AWS: EC2 RHEL 9 + systemd (Terraform-Provisioned)

The service runs as one `systemd`-supervised Node.js process on one EC2 RHEL 9 instance, and all AWS infrastructure is codified in Terraform. This is a single instance with automated recovery, not high availability. That is acceptable because every outage fails closed: no booking is released while the service is down, and native RoomOS behaviour continues. The decision and the alternatives considered are recorded in [ADR-002](adr/ADR-002-compute-ec2-rhel.md).

- **Instance**:
  - One RHEL 9 instance (`t3.medium`, x86_64, provisional until a load test with 800 actors and the security agents confirms the size) in an Auto Scaling Group with Min=1, Max=1, Desired=1, across two private subnets in different Availability Zones.
  - Built from the Suncorp standard RHEL 9 server build, with the SSM Agent and CloudWatch agent alongside the corporate agents. SELinux stays enforcing.
  - IMDSv2 only, no key pair, no public IP, encrypted root volume.
  - RHEL licensing is either AWS pay-as-you-go RHEL images or Suncorp's existing subscriptions through Red Hat Cloud Access (to be confirmed with Suncorp Cloud Platform).
- **Process**:
  - `booking-autocancel.service` runs as a dedicated non-login user with `Restart=always`, a systemd watchdog so a hung event loop is restarted (pinged from an event-loop timer through a small notify helper, ADR-002), and systemd sandboxing (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`).
  - A crashed process is back within seconds and re-acquires its own lease immediately, because the lease holder ID is the instance ID (LLD §8.5).
- **Release artifact**:
  - CI builds a versioned, checksummed tarball containing the compiled service, production `node_modules`, and a pinned Node.js LTS runtime, and stores it in a versioned S3 bucket. Bundling Node means OS patching never changes the runtime.
- **Releases**: a new release is installed on the same server and the service restarted; the server is not rebuilt. The instance ID is unchanged, so the service re-acquires its lease immediately. The previous release stays on the server for rollback. The deployment tooling follows the platform team's standard and is settled in Sprint 2.
- **Operations**: OS patching and server operations are owned by the Suncorp platform (Wintel) team under its standard server process. The service only requires that planned restarts (patch reboots and releases) happen outside business hours, because each restart quarantines the meetings in progress (§2). On shutdown the service releases its lease, so it never has to wait for it to expire.
- **Recovery**: a process crash recovers within seconds on the same instance. A host or Availability Zone failure is recovered by the Auto Scaling Group launching a replacement in the other zone, which takes minutes; automation is halted (fail closed) until it is running.
- **Admin access**: there is no inbound path and no SSH. Admins reach the `127.0.0.1`-bound dashboard through SSM Session Manager port forwarding, authorized by their AWS IAM Identity Center role. CloudTrail records who opened the tunnel but not what happens inside it, so dashboard actions rely on the application audit log (§7.4).
- **Common Network & Security Architecture**:
  - **VPC Subnets**: Deployed strictly inside private subnets (zero public IP, zero inbound security group rules).
  - **Outbound Egress**:
    - Outbound HTTPS (TCP 443) to Webex Cloud APIs for long-polling telemetry and Control Hub inventory.
    - DynamoDB and S3 (release artifacts) through VPC gateway endpoints, and SSM and CloudWatch through interface endpoints or the landing zone's shared endpoints (no internet path).
    - Outbound SMTP (TCP 25) routed across the enterprise network / Direct Connect / Transit Gateway to `outlook.suncorp.com.au`.
  - **Zero Plaintext Secrets**: Webex credentials and secrets injected from AWS SSM Parameter Store (`SecureString`) at startup via IAM role / instance profile.
  - **Observability**: the CloudWatch agent forwards the service's structured JSON logs from journald to CloudWatch Logs, with metric filters for cancellation counts and alarms on tripwire triggers and a missing heartbeat.

### 8.3 Fleet Configuration Store (DynamoDB)

- Three on-demand tables: rooms (roster), settings (global settings and the single-instance lease), and an append-only audit table. All have point-in-time recovery, deletion protection, and encryption at rest, and are provisioned by Terraform.
- The tables are reached from the private subnets through a **DynamoDB VPC gateway endpoint**, so no internet egress is needed. The service IAM role is scoped to these three tables, and has no update or delete permission on the audit table.
- Room runtime state stays in memory; only admin-controlled state is durable. If the store is unreachable at startup, the service manages nothing until it loads.
- A DynamoDB lease item ensures only one service instance drives rooms at a time (for example, if a replacement instance starts while the old one is still running). The holder ID is a stable host identity, so a process restart on the same host re-acquires its lease immediately; losing the lease stops every device command.
- Details: [ServiceLowLevelDesign.md §8](ServiceLowLevelDesign.md).
