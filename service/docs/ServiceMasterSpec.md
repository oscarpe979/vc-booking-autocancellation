# Booking Auto Cancellation Service - Master Specification

## Problem Statement

Enterprise organizations face severe meeting room scarcity caused by "ghost bookings" and "no-shows"—calendar reservations where the room remains booked on Microsoft Exchange, but nobody physically occupies the space.

While a codec-native Cisco RoomOS macro previously solved this for individual video devices, operating on-device macros across 800 meeting spaces presents significant operational challenges:

1. Macro deployment, updates, and troubleshooting require pushing and maintaining scripts across hundreds of individual room codecs.
2. The logic is strictly coupled to Cisco's proprietary on-device xAPI environment, preventing the organization from managing non-Cisco meeting rooms (e.g., Poly, Neat, Logitech, or generic sensor-equipped spaces).
3. Centralized observability, fleet-wide safety controls, progressive rollout rings, and emergency global kill-switches cannot be coordinated from independent, isolated on-device macro scripts.

Enterprise IT collaboration teams need a centralized, vendor-agnostic external service that can manage the full booking autocancellation lifecycle across the entire fleet of ~800 rooms while preserving the strict fail-closed safety guarantees of the native macro.

---

## Solution

The solution is an external, modular Node.js/TypeScript backend service that connects to room hardware and calendar systems through a Hexagonal (Ports and Adapters) architecture.

The service:

1. Ingests occupancy telemetry, calendar availability, and in-room user interactions via an outbound long-polling Ingress Transport (zero inbound open ports, secure for private networks and local developer workstations), with webhook support deferred to a future phase.
2. Models every managed meeting room as an independent Finite State Machine actor in memory, enforcing 100% policy parity with the codec-native baseline (No-Show Release, Early Departure Release, Automatic Check-In, and Long-Meeting Exemptions).
3. Protects ongoing meetings through a mandatory Startup Check-In Quarantine upon service restarts.
4. Enforces a synchronous Two-Tier Reconciler with a Just-In-Time (JIT) direct verification probe at the exact second of scheduled release to guarantee rooms are never released by mistake due to stale events or network latency.
5. Decouples hardware presence and interaction from calendar operations through standard driver interfaces, allowing Phase 1 to operate against Cisco Webex Workspace Integrations while allowing future hardware swaps to be performed simply by authoring new driver modules.
6. Provides fleet-wide operational safety controls including staged rollout modes (`MONITOR_ONLY`, `DRY_RUN`, `LIVE`), an automated cancellation spike tripwire, and an instant emergency kill-switch.
7. Delivers direct end-user notifications via an enterprise corporate SMTP relay (`outlook.suncorp.com.au:25`), sending urgent cancellation warnings when in-room prompts appear and contextual cancellation receipts when rooms are released, with a strict fail-closed delivery guard protecting bookings if email delivery fails.
8. Deploys cleanly into AWS via Terraform with flexible compute support (either an AWS ECS Fargate containerized task or a dedicated EC2 RHEL 9 instance supervised by `systemd`), operating inside private VPC subnets with outbound HTTPS 443 and SMTP 25 egress.

---

## User Stories

1. As an employee looking for a meeting room, I want unoccupied ghost bookings to be automatically released, so that I can find an available room when I need to collaborate.
2. As a meeting organizer whose meeting was delayed by 3 minutes, I want a grace period before my room is cancelled, so that I do not lose my reservation while walking to the room.
3. As a meeting attendee arriving in a reserved room, I want my physical presence to automatically check in my meeting, so that I do not have to manually interact with a touchscreen.
4. As an in-room meeting participant, I want a clear, visible warning prompt on the touch controller before any cancellation occurs, so that I have an actionable opportunity to keep the reservation.
5. As an in-room meeting participant, I want to tap "Keep Booking" on the touch screen, so that the warning prompt dismisses immediately and preserves my meeting reservation.
6. As an in-room meeting participant ending a meeting early, I want to tap "Check Out" on the touch controller, so that the room is immediately freed for colleagues without waiting for an automatic timer.
7. As an in-room meeting participant who tapped "Check Out", I want a confirmation step before actual release, so that an accidental tap does not immediately release my meeting.
8. As a meeting organizer of an executive all-day strategy session, I want meetings longer than two hours to be automatically exempt from autocancellation, so that prolonged breaks or presentation setups do not cause accidental room release.
9. As a meeting organizer with an unclassifiable or malformed calendar reservation, I want the system to preserve my booking, so that data inconsistencies never result in false cancellations.
10. As an enterprise IT collaboration administrator, I want to manage autocancellation for 800 rooms from a central service, so that I do not need to deploy or maintain macro scripts on 800 physical endpoints.
11. As an enterprise IT collaboration administrator, I want to run the service in dry-run mode for a subset of rooms, so that I can observe simulated warnings and releases before enabling live room checkouts.
12. As an enterprise IT collaboration administrator, I want a global emergency kill-switch, so that I can instantly halt all automated cancellations across the entire fleet if an upstream calendar outage occurs.
13. As an enterprise IT collaboration administrator, I want an automated anomaly tripwire that freezes releases if cancellations spike abnormally, so that widespread sensor or network glitches cannot mass-cancel the enterprise room estate.
14. As an enterprise IT collaboration administrator, I want to mark specific rooms as "Monitor Only", so that highly sensitive executive boardrooms are observed for utilization metrics without ever being touched by automation.
15. As an enterprise IT collaboration administrator, I want rooms placed into maintenance mode or going offline to immediately halt autocancellation, so that disconnected hardware never causes false cancellations.
16. As an enterprise IT collaboration administrator, I want the service to verify and repair baseline presence sensor configurations on devices, so that the occupancy telemetry pipeline remains functional.
17. As an enterprise IT collaboration administrator, I want structured JSON audit logs in CloudWatch with correlation IDs, so that I can answer user inquiries about why a specific room was released.
18. As an enterprise IT collaboration administrator, I want meeting subjects, bodies, and attendee identities excluded from service logs, so that corporate privacy and confidentiality are strictly protected.
19. As a software engineer developing the service on a corporate laptop, I want to run the service locally without opening inbound firewall ports, so that I can develop and debug against real Webex devices without security exceptions or third-party tunnels.
20. As a software engineer developing the service, I want the service to run via outbound long-polling without inbound networking requirements, so that development on corporate laptops and private VMs requires zero firewall exceptions or public DNS.
21. As a software engineer, I want the service state to run entirely in memory with zero database dependencies for local development, so that I can run the application with a single command.
22. As an AV operations engineer, I want to swap room hardware from Cisco codecs to an alternative vendor in the future, so that the organization can change hardware platforms without rewriting the booking autocancellation engine.
23. As a systems operations engineer, I want the service to restart cleanly in under two seconds on a Linux VM, so that OS security patching causes minimal operational disruption.
24. As a systems operations engineer, I want any meeting underway during a service restart to be quarantined until fresh check-in is verified, so that restarts never release ongoing meetings.
25. As a systems operations engineer, I want credentials injected from AWS Systems Manager Parameter Store at runtime, so that zero plain-text secrets are stored on server disks.
26. As an enterprise architect, I want the service to call CheckOut and never Delete, so that Microsoft Exchange and Webex Control Hub remain the authoritative calendar records.
27. As an enterprise architect, I want a synchronous Just-In-Time verification probe executed immediately prior to checkout, so that race conditions and delayed events never trigger an improper release.
28. As an in-room meeting participant, I want an audible alert chime played at 70% volume with automatic restoration when the warning appears, so that I notice the warning even if not looking at the touch panel.
29. As an in-room meeting participant who dismissed the prompt without making a choice, I want the prompt to be automatically restored for the remaining warning duration, so that accidental swipes do not lead to unintentional cancellation.
30. As an executive or VIP meeting organizer, I want meetings organized by designated VIPs or containing specific title keywords to be automatically exempt from autocancellation, so that mission-critical corporate meetings are never cancelled.
31. As an enterprise IT collaboration administrator, I want a lightweight web dashboard to view live room statuses, toggle the emergency kill switch, and update exemption rules and timeout parameters without modifying code or restarting the service.
32. As a meeting organizer with a short remaining meeting duration (e.g. 12 minutes or less), I want autocancellation skipped, so that meetings about to conclude naturally are preserved without nuisance warnings.
33. As an in-room meeting organizer who booked the room directly from the touch controller (ad hoc), I want automatic check-in suppressed, so that the service respects native on-device booking workflows.
34. As a meeting organizer away from the room, I want to receive an urgent cancellation warning email when the in-room countdown prompt is displayed, so that I am alerted to the impending cancellation and given the opportunity to occupy the room or confirm via the controller.
35. As a meeting organizer, I want the warning email to state the exact remaining countdown time dynamically based on the configured warning window and the room's local clock time, so that the message accurately reflects my remaining grace period.
36. As a meeting organizer, I want the cancellation to be aborted and my booking preserved if the warning email cannot be sent, so that I am never subjected to an unannounced surprise room cancellation.
37. As a meeting organizer whose room was cancelled, I want to receive a cancellation notice email detailing the room name, scheduled time, and whether it was released due to a No-Show or an Early Departure, so that I have a clear record of why the space was freed.
38. As an enterprise IT collaboration administrator, I want to configure the corporate SMTP host, port, sender email, and notification enable/disable switch from the `/admin` dashboard, so that mail delivery settings can be updated at runtime without redeploying code.
39. As a cloud operations engineer, I want the AWS production environment fully codified in Terraform with support for either an AWS ECS Fargate container or an EC2 RHEL 9 instance in private subnets, so that infrastructure provisioning is repeatable, simple to manage, and secure.

---

## Implementation Decisions

### 1. Hexagonal Modular Architecture

The service is structured into four decoupled layers:

- **Ingress Layer**: Ingests device telemetry and events. Encapsulated behind an ingress interface that abstracts the transport protocol (`IEventIngressTransport`).
- **Core Domain Layer**: Contains the room actor workflow coordinator, state machines, safety guards, classification logic, and reconcilers. Contains zero dependencies on external transport or vendor SDKs.
- **Port Layer**: Defines outbound contracts for hardware presence telemetry (`IRoomPresenceDriver`), in-room user prompt interactions (`IRoomInteractionDriver`), calendar reservation commands (`ICalendarDriver`), device configuration baselines (`IDeviceConfigDriver`), and end-user email communications (`INotificationDriver`).
- **Adapter Layer**: Implements the port contracts for specific platforms (Phase 1: Cisco Webex Workspace Integration for hardware/calendar, and Corporate SMTP relay for email notifications).

### 2. Outbound Long-Polling Ingress Transport

To accommodate corporate development laptop security constraints alongside private cloud hosting:

- Ingress uses persistent outbound HTTPS long-polling to the Webex Cloud message queue.
- Requires zero inbound network ports, zero public IP, and zero TLS certificate management.
- Inbound webhook support is deferred to a future phase.

### 3. In-Memory Finite State Machine (FSM) Actors

- Each room is managed by an isolated, in-memory Finite State Machine actor.
- State transitions strictly mirror the validated codec-native macro logic: `Idle`, `Quarantined`, `ActiveMeeting`, `CountdownScheduled`, `PromptVisible`, `ValidatingJIT`, and `Released`.
- Memory footprint across 800 room actors is under 20 MB RAM, eliminating the need for an external Redis/database cluster.

### 4. Startup Quarantine Guard (`AwaitingStartupCheckIn`)

- When the service initializes or restarts, it fetches the list of active bookings across the fleet.
- Any room with a meeting already in progress is placed into `Quarantined` state.
- Quarantined meetings are blocked from automatic no-show release, countdowns, warning prompts, and checkouts.
- Quarantine can only be cleared when a fresh, matching check-in event is authoritatively observed from the room.

### 5. Two-Tier Reconciler Engine

- **Tier 1 (Just-In-Time Verification Probe)**: Executed synchronously at $T=0$ immediately before any checkout command is issued. Queries the physical room presence and calendar availability in real time. If the room is occupied, status is unknown, or the booking changed, checkout is aborted and the booking is preserved.
- **Tier 2 (Background Drift & Health Sweeper)**: Runs periodically (e.g. every 15 minutes) and at codec-local midnight to identify orphaned room timers, detect devices that went offline, and re-verify presence sensor configurations.

### 6. Actionable Surface Authorization Guard

- Automatic release is strictly blocked unless the room possesses a verified, actionable interactive surface capable of capturing user prompt responses (e.g. Touch 10, Room Navigator, or Desk Pro interactive display).
- Rooms equipped with informational-only displays or lacking connected touch controllers are classified as non-actionable; automatic checkout is inhibited.
- `RoomScheduler` Navigators (outside room panels) are strictly filtered out and never receive warning prompts.

### 7. Long-Meeting & Group/VIP Exemption Engine

- **Duration Threshold**: Meetings with a verified duration strictly greater than 120 minutes (configurable via `LONG_MEETING_EXEMPTION_THRESHOLD_MS`) are classified as `Long` and blocked from autocancellation.
- **VIP Organizers & Groups**: Configurable list of organizer email addresses (`EXEMPT_ORGANIZERS`) and meeting title keywords (`EXEMPT_TITLE_KEYWORDS`) that automatically block autocancellation.
- **Unclassifiable Meetings**: Malformed or unverified meeting details default to `Blocked` with reason `UnclassifiableMeeting`.

### 8. Progressive Rollout & Safety Controls

- **Per-Room Mode**: Each room configuration specifies `MONITOR_ONLY`, `DRY_RUN`, or `LIVE`.
- **Dry-Run Emulation**: Executes full countdown, classification, and prompt tracking, but suppresses physical prompt displays, live email dispatches, and checkout commands, emitting structured simulation logs (`[DRY RUN - WOULD_SEND_EMAIL]`, `[DRY RUN - WOULD_RELEASE]`).
- **Anomaly Tripwire**: Tracks global cancellations across a sliding 5-minute window; automatically trips into safe hold if cancellations exceed 30 within that window.
- **Emergency Kill Switch**: Evaluates a dynamic flag (`AUTOCANCEL_KILL_SWITCH`) that halts all booking-changing actions instantly.

### 9. Target Production Infrastructure on AWS (Terraform-Provisioned)

- Designed for maximum operational simplicity and reliability in AWS, fully codified in Terraform with support for flexible compute:
  - **Option A (Containerized - AWS ECS Fargate)**: Single task definition running in private subnets, managed by an ECS Service (Desired=1), with zero OS patching or host maintenance.
  - **Option B (Virtual Machine - AWS EC2 RHEL 9)**: Single instance (`t4g.small` or `t3.small`) managed by an Auto Scaling Group (Min=1, Max=1, Desired=1) across two Availability Zones, supervised natively by Linux `systemd` (`Restart=always`).
- **Private Subnets & Egress**: Runs strictly inside private VPC subnets with outbound HTTPS 443 egress to Webex Cloud and outbound TCP 25 egress routed to `outlook.suncorp.com.au` via corporate network connections.
- **Zero Plaintext Credentials**: Credentials and tokens fetched at startup from AWS SSM Parameter Store (`SecureString`) via IAM roles.
- **Observability**: AWS CloudWatch Agent / FireLens streaming structured JSON logs to CloudWatch Log Groups with metric alarms.

### 10. In-Room Audio Chimes, Dual Presentation & Dismissed Prompt Restoration

- When the warning prompt appears, the service overrides volume to 70%, plays the `Announcement` sound, holds for 4 seconds, restores volume to default, and repeats every 60 seconds.
- Displays actionable prompt on touch controllers and informational text on room monitors (OSD).
- Uses `INITIAL` text for the first warning and `REPEATED` text if a user previously kept the booking but the room remains empty.
- Automatically re-displays the prompt if dismissed without selection (via user swipe or `Prompt.Cleared`) for the remaining warning duration.

### 11. Native Check-In Window Enforcement & Serialized Toggling

- Enforces `Bookings.CheckIn.WindowDuration: 60` to ensure RoomOS native no-show timers never race ahead of the service.
- Actively serializes writes to `Bookings.CheckIn.Enabled` through a FIFO promise queue: sets `False` for long/exempt meetings to protect them from native RoomOS release, and restores `True` when the meeting ends or room is free.

### 12. Bounded Readiness Recovery & Booking Sync Coalescing

- Implements a 50ms coalescing guard (`BOOKING_SYNC_COALESCE_DELAY_MS`) to buffer rapid bursts of `BookedUntil` and `TimeStamp` events.
- Executes bounded readiness recovery on delays of `[250ms, 500ms, 1000ms, 2000ms, 4000ms]` with `Bookings.List({ ScheduleType: 'Current', Limit: 1 })` fallback if transient room metadata is unavailable.
- Skips autocancellation if remaining meeting duration is $\le 12$ minutes (`EMPTY_ROOM_TIMEOUT_MS + POST_TIMEOUT_GRACE_PERIOD_MS`).

### 13. Lightweight "Google-Style" Admin & Configuration Dashboard

- Fastify-embedded administrative web interface (`GET /admin`) with clean, minimalist Google-style styling.
- Prominent 1-click Emergency Kill Switch.
- Search box for filtering rooms by name, ID, organizer, or status.
- Real-time fleet status table showing lifecycle phase, presence, and countdown timer.
- Web form allowing administrators to view and update timeout durations, long meeting thresholds, VIP organizer exemptions, per-room operational modes, and SMTP relay settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_SECURE`, `NOTIFICATIONS_ENABLED`) without code changes.

### 14. Corporate SMTP Email Notification Engine

- **Decoupled Outbound Port**: Encapsulated behind `INotificationDriver` and implemented via `SmtpNotificationAdapter` connecting to `outlook.suncorp.com.au:25` as an unauthenticated direct relay (standard for corporate internal smart hosts).
- **Mandatory Warning Email Precondition (Fail-Closed)**: When the in-room countdown warning prompt is displayed, an urgent warning email is dispatched to the meeting organizer. The service requires successful delivery verification; if SMTP dispatch fails after immediate retries, the cancellation workflow is aborted and the booking is preserved to prevent unannounced releases.
- **Dynamic Timing & Local Clock Presentation**: The warning email dynamically calculates the remaining warning duration directly from `PRE_TIMEOUT_WARNING_MS` (never hardcoded 5 minutes) and displays the release time in the codec's local clock timezone.
- **Single Warning Invariant**: Tracked per booking lifecycle; prompt dismissals and re-displays (`restoreDismissedPrompt`) do not send duplicate warning emails.
- **Differentiated Cancellation Receipts**: Upon successful calendar release, dispatches a conclusive receipt explicitly distinguishing **No-Show Release** from **Early Departure Release**.
- **Template Architecture**: Multipart MIME (HTML + RFC-compliant plain text) with corporate styling, meeting title, room location, and clear action guidance.
- **Local Development**: Emulated via `MockNotificationDriver` with formatted terminal logging and in-memory capture for test assertions.

---

## Testing Decisions

### 1. Behavior-Only Testing Philosophy

- Tests must verify external domain behavior, state transitions, and safety invariant enforcement.
- Tests must never test internal implementation details, private variables, or specific loop constructs.
- A test is considered valid only if it asserts that unsafe cancellations are blocked and valid cancellations proceed under exact, verified conditions.

### 2. Testing Seams

- **Primary Domain Seam**: The domain engine will be tested by driving it through its input events (presence changes, calendar updates, prompt responses) and asserting on calls made to mock implementations of `IRoomPresenceDriver`, `IRoomInteractionDriver`, `ICalendarDriver`, and `INotificationDriver`.
- **Ingress Seam**: Ingress transports will be tested by delivering synthetic Webex JSON notification payloads and verifying correct dispatch to the domain engine.
- **Time Virtualization**: All timers and countdowns will be tested using virtualized/mock clocks to verify warning windows and empty-room timeouts deterministically in milliseconds without real-world delays.

### 3. Core Test Scenarios

- **No-Show Release Lifecycle**: Empty room triggers countdown, warning prompt displays, warning email dispatches to organizer, room remains empty, JIT probe confirms vacancy, checkout is issued, cancellation email dispatches.
- **User Keep Booking**: Warning prompt displays; user selects "Keep Booking"; prompt dismisses; meeting is preserved; countdown resets safely; no duplicate warning email sent on subsequent prompt restoration.
- **User Early Checkout**: User selects "Check Out"; confirmation prompt displays; user confirms; checkout is executed immediately.
- **Occupancy Interruption**: Room becomes occupied during countdown; countdown cancels; meeting preserved.
- **Startup Quarantine**: Service starts with active meeting; room is empty; no countdown or release occurs; meeting remains quarantined until fresh check-in.
- **Long Meeting Exemption**: 3-hour meeting begins; room is empty; autocancellation is blocked; no prompt, email, or checkout occurs.
- **JIT Verification Abort**: Room is empty throughout countdown, but person enters at $T=0$ before checkout; JIT probe detects presence; checkout command is suppressed; booking preserved.
- **Notification Failure Fail-Closed**: Warning prompt displays, but mock notification driver throws delivery failure; cancellation is aborted; booking is preserved.
- **Tripwire Activation**: Simulated burst of 31 cancellations within 5 minutes causes engine to freeze subsequent releases.

---

## Out of Scope

1. **Creating, Modifying, or Deleting Calendar Bookings**: The service only issues `CheckIn` and `CheckOut`; it never creates new bookings or invokes `Delete`.
2. **Direct Microsoft Exchange / Graph API Integration in Phase 1**: Exchange connectivity is delegated to Webex Control Hub Hybrid Calendar services in the initial release.
3. **Custom On-Device UI Extensions**: The service utilizes native Webex modal prompts (`UserInterface.Message.Prompt.Display`); custom in-room XML UI extensions or web panels are out of scope.
4. **Attendee / Chat Spam**: Notifying all meeting attendees or sending Microsoft Teams / Webex chat messages is excluded to protect confidentiality and prevent notification fatigue. Emails are strictly targeted to the meeting organizer.
5. **Physical Sensor Calibration**: Sensor tuning and hardware ultrasound thresholds remain the responsibility of device engineering.

---

## Further Notes

- The service maintains complete behavioral parity with the proven implementation in the codec-native macro.
- The architecture is designed so that Sprint 1 can be developed, tested, and validated 100% on a local engineer laptop using outbound long-polling, while being fully production-ready for AWS deployment in subsequent sprints.
