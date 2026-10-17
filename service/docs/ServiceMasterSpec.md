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
2. Models every managed meeting room as an independent Finite State Machine actor in memory, enforcing policy parity with the codec-native baseline (No-Show Release, Early Departure Release, Automatic Check-In, and Long-Meeting Exemptions), except where a Webex platform limit forces a stricter, fail-closed rule or leaves one documented gap pending a device test (see Decision 17).
3. Protects ongoing meetings through a mandatory Startup Check-In Quarantine upon service restarts, mode promotions, and detected device reboots.
4. Enforces a synchronous Two-Tier Reconciler with a Just-In-Time (JIT) direct verification at the exact second of scheduled release to guarantee rooms are never released by mistake due to stale events or network latency.
5. Decouples hardware presence and interaction from calendar operations through standard driver interfaces, allowing Phase 1 to operate against Cisco Webex Workspace Integrations while allowing future hardware swaps to be performed simply by authoring new driver modules.
6. Provides fleet-wide operational safety controls including per-room modes (`DISABLED` by default, then `MONITOR_ONLY`, `DRY_RUN`, `LIVE`), an automated cancellation spike tripwire, and an instant emergency kill-switch.
7. Delivers direct end-user notifications via an enterprise corporate SMTP relay (`outlook.suncorp.com.au:25`), sending urgent cancellation warnings when in-room prompts appear and contextual cancellation receipts when rooms are released, with a strict fail-closed delivery guard protecting bookings if email delivery fails.
8. Deploys into AWS via Terraform as one `systemd`-supervised process on a single EC2 RHEL 9 instance (Auto Scaling Group of one across two Availability Zones), operating inside private VPC subnets with outbound HTTPS 443 and SMTP 25 egress.

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
12. As an enterprise IT collaboration administrator, I want a global emergency kill-switch, so that I can instantly halt all automation (countdowns, prompts, warning emails, automatic CheckIns, and cancellations) across the entire fleet if an upstream calendar outage occurs.
13. As an enterprise IT collaboration administrator, I want an automated anomaly tripwire that freezes releases if cancellations spike abnormally, so that widespread sensor or network glitches cannot mass-cancel the enterprise room estate.
14. As an enterprise IT collaboration administrator, I want to mark specific rooms as "Monitor Only", so that highly sensitive executive boardrooms are observed for utilization metrics without ever being touched by automation.
15. As an enterprise IT collaboration administrator, I want rooms placed into maintenance mode or going offline to immediately halt autocancellation, so that disconnected hardware never causes false cancellations.
16. As an enterprise IT collaboration administrator, I want the service to verify and report drift in baseline presence sensor configurations on devices, blocking automation for a drifted room, so that a broken occupancy telemetry pipeline never causes a release.
17. As an enterprise IT collaboration administrator, I want structured JSON audit logs in CloudWatch with correlation IDs, so that I can answer user inquiries about why a specific room was released.
18. As an enterprise IT collaboration administrator, I want meeting subjects, bodies, and attendee identities excluded from service logs, so that corporate privacy and confidentiality are strictly protected.
19. As a software engineer developing the service on a corporate laptop, I want to run the service locally without opening inbound firewall ports, so that I can develop and debug against real Webex devices without security exceptions or third-party tunnels.
20. As a software engineer developing the service, I want the service to run via outbound long-polling without inbound networking requirements, so that development on corporate laptops and private VMs requires zero firewall exceptions or public DNS.
21. As a software engineer, I want local development to need no external database (room runtime state in memory, admin state in a local JSON-file store), so that I can run the application with a single command.
22. As an AV operations engineer, I want to swap room hardware from Cisco codecs to an alternative vendor in the future, so that the organization can change hardware platforms without rewriting the booking autocancellation engine.
23. As a systems operations engineer, I want a crashed service process to restart within seconds on the same instance and re-acquire its own single-instance lease immediately, and planned restarts to happen only outside business hours, so that restarts quarantine as few meetings as possible.
24. As a systems operations engineer, I want any meeting underway during a service restart to be quarantined until that meeting ends, so that restarts never release ongoing meetings.
25. As a systems operations engineer, I want credentials injected from AWS Systems Manager Parameter Store at runtime, so that zero plain-text secrets are stored on server disks.
26. As an enterprise architect, I want the service to call CheckOut and never Delete, so that Microsoft Exchange and Webex Control Hub remain the authoritative calendar records.
27. As an enterprise architect, I want a synchronous Just-In-Time verification executed immediately prior to checkout, so that race conditions and delayed events never trigger an improper release.
28. As an in-room meeting participant, I want an audible alert chime played at 70% volume with automatic restoration when the warning appears, so that I notice the warning even if not looking at the touch panel.
29. As an in-room meeting participant who dismissed the prompt without making a choice, I want the prompt to be automatically restored for the remaining warning duration, so that accidental swipes do not lead to unintentional cancellation.
30. As an executive or VIP meeting organizer, I want meetings organized by designated VIPs or containing specific title keywords to be automatically exempt from autocancellation, so that mission-critical corporate meetings are never cancelled.
31. As an enterprise IT collaboration administrator, I want a lightweight web dashboard to view live room statuses, toggle the emergency kill switch, and update exemption rules and timeout parameters without modifying code or restarting the service.
32. As a meeting organizer with a short remaining meeting duration (e.g. 12 minutes or less), I want autocancellation skipped, so that meetings about to conclude naturally are preserved without nuisance warnings.
33. As an in-room meeting organizer who booked the room directly from the touch controller (ad hoc), I want automatic check-in suppressed and my booking treated as already checked in (never as a no-show), so that the service respects native on-device booking workflows.
34. As a meeting organizer away from the room, I want to receive an urgent cancellation warning email when the in-room countdown prompt is displayed, so that I am alerted to the impending cancellation and given the opportunity to occupy the room or confirm via the controller.
35. As a meeting organizer, I want the warning email to state the remaining time to the fixed release deadline (including any grace period) and the release time in the room's local clock time, so that the message accurately reflects how long I have.
36. As a meeting organizer, I want automatic cancellation blocked and my booking preserved if the warning email cannot be sent (while notifications are enabled), so that I am never subjected to an unannounced surprise room cancellation.
37. As a meeting organizer whose room was cancelled, I want to receive a cancellation notice email detailing the room name, scheduled time, and whether it was released due to a No-Show or an Early Departure, so that I have a clear record of why the space was freed.
38. As an enterprise IT collaboration administrator, I want to configure the corporate SMTP host, port, sender email, and notification enable/disable switch from the `/admin` dashboard, so that mail delivery settings can be updated at runtime without redeploying code.
39. As a cloud operations engineer, I want the AWS production environment fully codified in Terraform, running on an EC2 RHEL 9 instance in private subnets with no inbound access, so that infrastructure provisioning is repeatable, simple to manage, and secure.
40. As an enterprise IT collaboration administrator, I want workspaces newly added to Control Hub to be recorded as `DISABLED`, with all of their events discarded, so that no room is ever enrolled in autocancellation without my explicit decision.
41. As an enterprise IT collaboration administrator, I want to see which workspaces were discovered but not enrolled, and which managed devices went missing or were replaced, so that I know exactly what a fleet change means for the service.
42. As an enterprise IT collaboration administrator, I want room enrollment, modes, the kill switch, and all settings to survive service restarts, with an audit trail of who changed what, so that a restart never silently resumes automation or forgets a decision.
43. As an enterprise IT collaboration administrator, I want promotion to `LIVE` to show a readiness report and require my explicit confirmation, so that a room goes live only on my judgement.
44. As a meeting organizer, I want the warning email to tell me plainly that my room was detected as empty, when the reservation will be released, and that it is not released if someone is in the room at that time or keeps it using the touch controller in the room, so that I know what will happen without the email asking me to act on it.
45. As an in-room meeting participant, I want a booking preserved if the room device reboots during a countdown or visible warning, so that a warning wiped by the reboot can never lead to a release I was not shown.
46. As an enterprise IT collaboration administrator, I want the service to re-apply each enrolled room's required settings every night (spread over a short window), after recovery, and after a reconnect, exactly as the macro does at midnight, so that a setting changed on a device is corrected without manual work.

---

## Implementation Decisions

### 1. Hexagonal Modular Architecture

The service is structured into four decoupled layers:

- **Ingress Layer**: Ingests device telemetry and events. Encapsulated behind an ingress interface that abstracts the transport protocol (`IEventIngressTransport`).
- **Core Domain Layer**: Contains the room actor workflow coordinator, state machines, safety guards, classification logic, and reconcilers. Contains zero dependencies on external transport or vendor SDKs.
- **Port Layer**: Defines outbound contracts for hardware presence telemetry (`IRoomPresenceDriver`), in-room user prompt interactions (`IRoomInteractionDriver`), calendar reservation commands (`ICalendarDriver`), device configuration baselines (`IDeviceConfigDriver`), end-user email communications (`INotificationDriver`), read-only Control Hub discovery (`IFleetInventoryDriver`), and durable fleet configuration (`IFleetConfigStore`).
- **Adapter Layer**: Implements the port contracts for specific platforms (Phase 1: Cisco Webex Workspace Integration for hardware, calendar, and inventory; Corporate SMTP relay for email notifications; DynamoDB for the fleet configuration store, with a JSON-file adapter for local development).

### 2. Outbound Long-Polling Ingress Transport

To accommodate corporate development laptop security constraints alongside private cloud hosting:

- Ingress uses persistent outbound HTTPS long-polling to the Webex Cloud message queue.
- Requires zero inbound network ports, zero public IP, and zero TLS certificate management.
- Inbound webhook support is deferred to a future phase.

### 3. In-Memory Finite State Machine (FSM) Actors

- Each room is managed by an isolated, in-memory Finite State Machine actor.
- Phases: `Idle`, `Quarantined`, `ActiveMeeting`, `CountdownScheduled`, `PromptPending` (`DRY_RUN` only), `PromptVisible` (`LIVE` only), `ValidatingJIT`, and `Released`. `CountdownScheduled`, `PromptPending`, and `PromptVisible` correspond to the macro's release workflow phases; the others are service-level groupings. The goal is behavioural parity with the validated codec-native macro, not a one-to-one copy of its state names (transition matrix: [ServiceLowLevelDesign.md §3.2](ServiceLowLevelDesign.md)).
- Memory footprint across 800 room actors is under 20 MB RAM. Room runtime state (phases, timers, prompt ownership) is never persisted, matching the macro; a restart is made safe by startup quarantine. Only admin-controlled state is durable (see Decision 15).

### 4. Startup Quarantine Guard (`AwaitingStartupCheckIn`)

- Whenever a room actor is created (service start or restart, store load, a `Missing` device reappearing, or promotion into `DRY_RUN`/`LIVE`), it reads the room's current booking. A `LIVE → DRY_RUN` demotion, and an actor restart after a detected device reboot (Decision 17), quarantine an in-progress meeting the same way.
- Any meeting already in progress at that moment is placed into the `Quarantined` state (`Blocked / AwaitingStartupCheckIn`).
- Quarantined meetings are blocked from automatic CheckIn, no-show release, countdowns, warning prompts, and checkouts.
- The quarantine lasts until the meeting ends (`Free`/`FreeUntil` or a booking ID change). No event lifts it: RoomOS does not deliver `Bookings.CheckedIn` to Workspace Integrations, so this is stricter than the macro (see Decision 17 and [ServiceLowLevelDesign.md §5.9](ServiceLowLevelDesign.md)).

### 5. Two-Tier Reconciler Engine

- **Tier 1 (Just-In-Time Verification)**: Executed synchronously at $T=0$ immediately before any automatic checkout command is issued. It queries physical room presence, calendar availability, fresh booking details, and `SystemUnit.Uptime` in real time, and (in `LIVE`) re-reads the controllers to verify that the controller set captured at display still owns the prompt. Pending device test DT1, a No-Show release also requires a read CheckIn state of `NotCheckedIn`. If the room is occupied, status is unknown, no actionable surface owns the prompt, the controller read fails or shows a different set, the booking changed, the booking reclassifies as long or unclassifiable, the device rebooted, or a service-only gate (kill switch, tripwire, warning email) is closed, checkout is aborted and the booking is preserved. Full checklist: [ServiceLowLevelDesign.md §5.5](ServiceLowLevelDesign.md).
- **Tier 2 (Background Drift & Health Sweeper)**: Runs periodically (e.g. every 15 minutes) and at codec-local midnight. It **detects and blocks only**: it identifies orphaned room timers, detects devices that went offline, missing, or were replaced, and verifies presence sensor configurations, flagging, blocking, cancelling, or demoting as needed (configuration drift → `RequiredConfigurationsUnavailable`). It never restores readiness, starts a workflow, or writes configuration.

### 6. Actionable Surface Authorization Guard

- In `LIVE`, automatic release is strictly blocked unless a verified, actionable interactive surface capable of capturing user prompt responses (e.g. Touch 10, Room Navigator, or Desk Pro interactive display) displayed the prompt and still owns it at the deadline. `DRY_RUN` displays nothing and skips this check.
- Controller topology cannot be subscribed to through a Workspace Integration, so it is read just in time; there is no listener and no polling timer. A Navigator controller is assumed and the prompt is always sent to it. Ownership is granted only if reads just before and just after the display both find a connected controller. On each 60-second chime tick the service re-reads it: a changed controller set or a failed read drops ownership, and a present controller is re-shown the prompt for the remaining time only. At JIT validation, release requires a successful read showing the controller set captured at display ([ServiceLowLevelDesign.md §5.11](ServiceLowLevelDesign.md)).
- A matching `Prompt.Response` proves user intent (Keep Booking, Check Out) but never authorizes an automatic release. A controller that connects mid-prompt in a room that had none at display is not given the prompt, so the booking is kept.
- Rooms equipped with informational-only displays or lacking connected touch controllers are classified as non-actionable; automatic checkout is inhibited.
- `RoomScheduler` Navigators (outside room panels) are strictly filtered out and never receive warning prompts.

### 7. Long-Meeting & Group/VIP Exemption Engine

- **Duration Threshold**: Meetings with a verified duration strictly greater than 120 minutes (configurable via `LONG_MEETING_EXEMPTION_THRESHOLD_MS`) are classified as `Long` and blocked from autocancellation.
- **VIP Organizers & Groups**: Configurable list of organizer email addresses (`EXEMPT_ORGANIZERS`) and meeting title keywords (`EXEMPT_TITLE_KEYWORDS`) that automatically block autocancellation.
- **Unclassifiable Meetings**: Malformed or unverified meeting details default to `Blocked` with reason `CouldNotVerifyCurrentBooking` (the codec-native reason for an unclassifiable meeting).

### 8. Progressive Rollout & Safety Controls

- **Per-Room Mode**: Each room roster entry specifies `DISABLED` (the default for every discovered room), `MONITOR_ONLY`, `DRY_RUN`, or `LIVE`. Only an administrator promotes a room: `DISABLED → MONITOR_ONLY → DRY_RUN → LIVE`, or `DISABLED → DRY_RUN`. `LIVE` is reachable only from `DRY_RUN`; the time spent in `DRY_RUN` is the administrator's judgement.
- **Disabled Rooms**: A `DISABLED` room has no actor. Every event from it is discarded and nothing is ever sent to it.
- **Monitor-Only Emulation**: A strictly read-only mode for sensitive rooms, with no automatic exit: a room may stay in it indefinitely, and it is an optional step on the promotion path. It sends no commands, emails, or device configuration writes, and runs no release workflow (real or simulated). It records utilization telemetry only, and leaves the room's native RoomOS baseline untouched. It is distinct from `DRY_RUN`, which is the rollout rehearsal that does configure the device.
- **Mode Transitions**: Demotion is `LIVE → DRY_RUN`, or any mode to `MONITOR_ONLY` or `DISABLED`; the system itself may only demote to `DISABLED`. Promotion into `DRY_RUN` or `LIVE`, and the `LIVE → DRY_RUN` demotion, quarantine any meeting already in progress, exactly as at service startup. Moving a room down to `MONITOR_ONLY` or `DISABLED` cancels any active workflow, clears the service's prompts, and restores the room's `Bookings.CheckIn.Enabled` and `Bookings.CheckIn.WindowDuration` to the baseline recorded before the service first changed them (the RoomAnalytics presence settings are left as written). After that, the room is read-only (`MONITOR_ONLY`) or ignored (`DISABLED`). Full rules: [ServiceLowLevelDesign.md §5.7](ServiceLowLevelDesign.md).
- **Dry-Run Emulation**: Matches the macro's dry run. It writes the presence baseline and CheckIn window, and keeps native CheckIn `False` (writing `False` when the device has it enabled, failing closed if it cannot); it never enables native CheckIn. It runs full classification and countdowns with the release horizon and warning without the post-timeout grace period. It suppresses CheckIn, prompts, audio, live emails, and checkout commands, logging `[DRY RUN - INTENT_TO_AUTOMATIC_CHECK_IN]`, `[DRY RUN - SIMULATED_CHECK_IN]`, `[DRY RUN - WOULD_DISPLAY_PROMPT]`, `[DRY RUN - WOULD_SEND_EMAIL]`, and `[DRY RUN - WOULD_RELEASE]`. The simulated warning is the `PromptPending` phase; the `WOULD_SEND_EMAIL` entry satisfies the warning email gate. A simulated CheckIn selects the release policy only and never clears quarantine. No actionable surface is required.
- **Anomaly Tripwire**: Tracks global `LIVE` cancellations across a sliding 5-minute window (`DRY_RUN` simulated releases do not count); automatically trips into safe hold if cancellations exceed 30 within that window.
- **Emergency Kill Switch**: Stops all automation instantly. It is active if either the persisted dashboard value or the `AUTOCANCEL_KILL_SWITCH` SSM/environment parameter is true; the service re-reads the SSM parameter every 30 seconds, so it can halt the fleet without the dashboard or a restart. It survives restarts; activation never waits on persistence, while deactivation requires it. A tripped tripwire is likewise persisted until an administrator resets it.
- **Effect of the kill switch or tripwire**: active workflows are cancelled and prompts cleared (bookings preserved); no new countdown, prompt, warning email, or automatic CheckIn starts; every CheckOut is blocked, including a user-confirmed Check Out. No native CheckIn write is made on activation, on deactivation, or while a gate is active (including the midnight and recovery re-apply), because they are fleet gates, not booking statuses. Presence baseline and CheckIn window writes still run ([ServiceLowLevelDesign.md §5.8](ServiceLowLevelDesign.md)).

### 9. Target Production Infrastructure on AWS (Terraform-Provisioned)

- **Compute: EC2 RHEL 9 + `systemd`** ([ADR-002](adr/ADR-002-compute-ec2-rhel.md)): one `t3.medium` instance (provisional until load-tested) in an Auto Scaling Group (Min=1, Max=1, Desired=1) across two Availability Zones, built from the Suncorp standard RHEL 9 server build, with the Node.js process supervised by `systemd` (`Restart=always`, watchdog). Releases are versioned packages with a pinned Node.js runtime, installed on the same server. OS patching is owned by the Suncorp platform (Wintel) team; the service requires only that planned restarts happen outside business hours.
- **Private Subnets & Egress**: Runs strictly inside private VPC subnets with outbound HTTPS 443 egress to Webex Cloud and outbound TCP 25 egress routed to `outlook.suncorp.com.au` via corporate network connections.
- **Zero Plaintext Credentials**: Credentials and tokens fetched at startup from AWS SSM Parameter Store (`SecureString`) via IAM roles.
- **Fleet Configuration Store**: Three on-demand DynamoDB tables (rooms, settings, append-only audit), with point-in-time recovery and deletion protection, reached through a VPC gateway endpoint. A DynamoDB lease ensures a single active service instance.
- **Observability**: the CloudWatch agent forwards structured JSON logs from journald to CloudWatch Log Groups, with metric alarms.
- **Admin Access**: no inbound path and no SSH; admins reach the localhost dashboard through SSM Session Manager port forwarding.

### 10. In-Room Audio Chimes, Dual Presentation & Dismissed Prompt Restoration

- When the warning prompt appears, the service plays one alert (volume 70%, `Announcement` sound) through `IRoomInteractionDriver.playAudioAlert`. The coordinator owns the 4-second hold before restoring default volume and the 60-second repeat while the prompt is visible. Sound failure is logged and ignored.
- Displays actionable prompt on touch controllers and informational text on room monitors (OSD).
- Uses `INITIAL` text for the first warning and `REPEATED` text if a user previously kept the booking but the room remains empty.
- Automatically re-displays only the dismissed target if a prompt is dismissed without selection (via user swipe or `Prompt.Cleared`), for the remaining warning duration, without extending the deadline. The chime loop continues and no new warning email is sent.
- Occupancy detected while the prompt is visible keeps the prompt on screen so occupants can act. Release is still blocked at expiry if the room is occupied.
- "Check Out" opens a confirmation guard; a confirmed checkout is issued immediately with reason `UserConfirmed`, only while the fleet gates are clear. The service marks its pending CheckOut before sending the command (so the release is not logged as external) and sends no cancellation notice. "Keep Booking" and confirmation "Cancel" re-read presence and may start a fresh countdown only if the room is still empty.

### 11. Native Check-In Window Enforcement & Serialized Toggling

- Enforces `Bookings.CheckIn.WindowDuration` from the `nativeCheckInWindowMinutes` fleet setting (RoomOS accepts only 5, 10, 15, 20, 30, or 60 minutes; 60 is the default and maximum) so that RoomOS native no-show timers never race ahead of the service. The setting must exceed the `LIVE` release horizon.
- In `LIVE` only, actively serializes writes to `Bookings.CheckIn.Enabled` per device through a FIFO promise queue: `True` for an allowed booking, `False` for every other blocked booking (long, exempt, unclassifiable, quarantined) to protect it from native RoomOS release, no write while the meeting length is being verified, and `True` when the meeting ends or the room is free. `DRY_RUN` keeps it `False`; `MONITOR_ONLY` writes nothing. Ownership rules: [ServiceLowLevelDesign.md §5.6](ServiceLowLevelDesign.md).
- **Configuration re-apply.** Like the macro's midnight check, the service re-applies the mode's settings before re-verifying them: at actor start, at codec-local midnight (plus a per-room random delay of up to 15 minutes, so ~800 rooms do not hit Webex rate limits together), on every readiness recovery attempt, after an ingress reconnect, and after the lease is re-acquired. `DRY_RUN` and `LIVE` write the presence baseline and CheckIn window (batched with `setMany` where possible); `DRY_RUN` then enforces `Enabled = False`, and `LIVE` re-runs the native CheckIn policy for the current status, never a blind `Enabled` write. `MONITOR_ONLY` and `DISABLED` get no writes ([ServiceLowLevelDesign.md §5.12](ServiceLowLevelDesign.md)).

### 12. Bounded Readiness Recovery & Booking Sync Coalescing

- Implements a 50ms coalescing guard (`BOOKING_SYNC_COALESCE_DELAY_MS`) to buffer rapid bursts of `BookedUntil` and `TimeStamp` events.
- Executes bounded readiness recovery on delays of `[250ms, 500ms, 1000ms, 2000ms, 4000ms]` when transient room metadata is unavailable. Each attempt rebuilds the full snapshot using `Bookings.Get({ Id })` for a known ID or `Bookings.List({ ScheduleType: 'Current', Limit: 1 })` when the ID is missing. Exhaustion preserves the booking.
- Minimum remaining time is a countdown-start check: a countdown starts only if the remaining meeting duration is strictly greater than the release horizon (`EMPTY_ROOM_TIMEOUT_MS + POST_TIMEOUT_GRACE_PERIOD_MS`, e.g. 12 minutes, in `LIVE`; `DRY_RUN` omits the grace period, matching the macro). Otherwise autocancellation is skipped and logged. It is not re-checked at release time.

### 13. Lightweight "Google-Style" Admin & Configuration Dashboard

- Fastify-embedded administrative web interface (`GET /admin`) with clean, minimalist Google-style styling.
- **Interim access control:** the dashboard binds to `127.0.0.1` only and is protected by a single shared admin password (`ADMIN_DASHBOARD_PASSWORD`), with session cookies, CSRF protection, and login rate limiting. It refuses to start without a password. Per-user SSO and roles are deferred.
- Prominent 1-click Emergency Kill Switch.
- Search box for filtering rooms by name, ID, organizer, or status.
- Real-time fleet status table showing lifecycle phase, presence, and countdown timer.
- Web form allowing administrators to view and update timeout durations, the native CheckIn window, long meeting thresholds, VIP organizer exemptions, per-room operational modes, and SMTP relay settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_SECURE`, `NOTIFICATIONS_ENABLED`; no SMTP credentials, which stay in SSM) without code changes. Every value is validated before it is saved, and timing changes apply only to workflows started afterwards ([ServiceLowLevelDesign.md §5.10](ServiceLowLevelDesign.md)).

### 14. Corporate SMTP Email Notification Engine

- **Decoupled Outbound Port**: Encapsulated behind `INotificationDriver` and implemented via `SmtpNotificationAdapter` connecting to `outlook.suncorp.com.au:25` as an unauthenticated direct relay (standard for corporate internal smart hosts).
- **Warning Email Precondition (Fail-Closed)**: While `NOTIFICATIONS_ENABLED = true`, an urgent warning email is dispatched to the meeting organizer for each warning deadline, and automatic release requires that it was delivered. If SMTP dispatch fails after bounded immediate retries, or the organizer email is missing, `warningEmailFailed` is set for the rest of the booking lifecycle: the prompt stays visible so occupants can still act, automatic release is blocked at the deadline, no further countdown starts in that lifecycle, and the flag is never cleared automatically. In `DRY_RUN`, the `[DRY RUN - WOULD_SEND_EMAIL]` entry satisfies the gate. With `NOTIFICATIONS_ENABLED = false`, no warning email is sent and the gate does not block release ([ServiceLowLevelDesign.md §5.8](ServiceLowLevelDesign.md)).
- **Dynamic Timing & Local Clock Presentation**: The warning email states the real time remaining to the fixed warning deadline (`promptExpiresAt`, which includes the post-timeout grace period in `LIVE`; never a hardcoded 5 minutes) and displays the release time in the codec's local clock timezone.
- **Informational Only**: The warning states that the room was detected as empty, when the reservation will be released, and that it is not released if someone is in the room at that time or if the booking is kept using the touch controller in the room before then. The email is informational only: it has no links or buttons and asks for no action in the email itself. It makes no claim about CheckIn, so it stays true in the residual gap where the service cannot see a manual panel check-in (Decision 17, [ServiceLowLevelDesign.md §6.2](ServiceLowLevelDesign.md)).
- **One Email per Deadline**: A new deadline (a fresh countdown after Keep Booking, or the unconfirmed-guard restore) sends a new email; prompt dismissals and re-displays (`restoreDismissedPrompt`) keep the deadline and never send a duplicate.
- **Differentiated Cancellation Receipts**: Upon successful automatic calendar release, dispatches a conclusive receipt explicitly distinguishing **No-Show Release** from **Early Departure Release**. A user-confirmed checkout from the room controller sends no receipt.
- **Template Architecture**: Multipart MIME (HTML + RFC-compliant plain text) with corporate styling, meeting title, room location, and plain informational wording (no links or buttons).
- **Local Development**: Emulated via `MockNotificationDriver` with formatted terminal logging and in-memory capture for test assertions.

### 15. Durable Fleet Configuration Store (DynamoDB)

- Admin-controlled state (the roster, room modes, the kill switch, the tripped tripwire, timings, exemptions, and SMTP settings) and an append-only audit log are persisted behind the `IFleetConfigStore` port. They are implemented by `DynamoFleetConfigStore` in AWS and `JsonFileFleetConfigStore` on a laptop, so local development still needs no database.
- Every change is a conditional (versioned) write that is persisted before it takes effect, and is audited with who, when, before, and after.
- **Fail closed:** if the store cannot be read at startup, the service manages no room until it loads, and it never falls back to defaults. During a runtime outage, the service keeps the last-known-good state and rejects dashboard writes, except kill-switch activation.
- A DynamoDB lease guarantees that only one service instance drives rooms at a time. Its holder ID is a stable host identity, so a quick process restart re-acquires it immediately, while a replacement instance may wait about 30 seconds for the old lease to expire unless the old process released it on shutdown. Losing the lease stops every device command and configuration write.
- Delivery: Sprint 1 uses the JSON-file adapter; the DynamoDB adapter and its Terraform follow in Sprint 2.
- Details: [ServiceLowLevelDesign.md §8](ServiceLowLevelDesign.md).

### 16. Fleet Roster & Room Enrollment

- The roster is the sole authority on which rooms are managed. **Nothing is enrolled automatically.** The Control Hub inventory sync (startup plus every 15 minutes, read-only) records each new workspace as `DISABLED` and audits it. Adding 10 workspaces to Control Hub therefore produces 10 `DISABLED` roster entries and a dashboard notice, and nothing else.
- A roster gate discards events from `DISABLED`, unrostered, missing, or mismatched devices. The Webex adapter also refuses commands to them.
- Each workspace is bound to exactly one managed device. A replaced device is demoted to `DISABLED` (`DeviceMismatch`); a workspace with several booking-capable devices waits for an admin to choose one (`AmbiguousWorkspace`). The system may demote a room but never promotes one.
- `DRY_RUN → LIVE` shows a readiness report (a controller present on a fresh read, `RoomScheduler` excluded, or a Desk Pro interactive OSD; readable `SystemUnit.Uptime`; presence telemetry; codec timezone; configuration writes; dry-run evidence) and requires an explicit, audited confirmation.
- Recommended second safeguard: activate the Workspace Integration only for the Control Hub locations in scope. Commands and status reads to devices in other locations then fail with `403`. Configuration writes and the device list remain org-wide, so the roster gate stays the primary control.

### 17. Webex Platform Constraints

Some macro behaviours cannot be reproduced through a Workspace Integration. Where that happens, the service applies a stricter, fail-closed rule, with one documented gap that depends on device test DT1. The full list is in [ServiceLowLevelDesign.md §9](ServiceLowLevelDesign.md), and every intentional difference from the macro is tabled in [ServiceLowLevelDesign.md §5.14](ServiceLowLevelDesign.md); the ones that change behaviour are:

- **`Bookings.CheckedIn` is not delivered.** There is no relay macro on the device and no CheckIn command sent only to discover state. CheckIn is confirmed by the service's own successful automatic CheckIn, a CheckIn error saying the booking is already checked in (matched by substring; exact text pending device test DT2; this is how the service learns of a RoomOS native check-in), or `BookedFromDevice = True` (always read, unlike the macro). Treating "already checked in" as confirmation is stricter than the macro, which still starts No-Show afterwards. A `DRY_RUN` simulated CheckIn is used for policy selection only. Startup quarantine lasts until the meeting ends or the booking ID changes; nothing lifts it early ([ServiceLowLevelDesign.md §5.9](ServiceLowLevelDesign.md)).
- **CheckIn state read (pending device test DT1).** If `Bookings.Get`, `Bookings.List`, or an xStatus exposes a booking's CheckIn state, the service reads it, with no side effects, when an empty room would start a No-Show countdown (checked in means no countdown, prompt, or email, exactly like the macro) and as a JIT check before a No-Show CheckOut. If DT1 is negative, one gap remains: someone checks in on a panel (for example, a scheduler Navigator outside the door) and the room stays empty for the whole timeout; the service runs the countdown, prompt, and warning email, and releases if nobody answers. This is the one case where the service can release a booking the macro would keep; the in-room prompt and the informational warning email (Decision 14) mitigate it.
- **Controller topology is not subscribable.** `Peripherals.ConnectedDevice` is read just in time (before and after display, on each 60-second chime tick, and at JIT validation), with no listener and no polling timer (Decision 6).
- **No "booted" event.** `BootEvent` fires before a restart. The service detects a reboot from `SystemUnit.Uptime`, read when a countdown starts, on each chime tick, and at JIT validation: an uptime lower than the baseline or less than the workflow's age aborts with `device_rebooted_during_workflow`, preserves the booking, and restarts the actor with startup semantics. `BootEvent` is only an early trigger to cancel the workflow ([ServiceLowLevelDesign.md §5.13](ServiceLowLevelDesign.md)).
- **Pending device tests.** DT1 (CheckIn state readable), DT2 (exact already-checked-in error), DT3 (`Prompt.Display Target=Controller` with no controller), DT4 (uptime across a reboot and `BootEvent` timing), and DT5 (`Prompt.Cleared` and `ConnectedDevice` when a Navigator reboots mid-prompt) are part of the Sprint 1 ticket 05 spike. Until they report, any unexpected result fails closed.
- **Long polling.** It starts automatically from `connect({ notifications: 'longpolling' })`; the service never calls the internal `pollData()`, and because the SDK cannot stop polling, shutdown closes the roster gate and exits. The SDK does not retry HTTP `429`, so the adapter backs off honouring `Retry-After`.
- **Location-limited activation** returns `403` for commands and status reads outside the permitted locations, but the device list and configuration writes stay org-wide.

---

## Testing Decisions

### 1. Behavior-Only Testing Philosophy

- Tests must verify external domain behavior, state transitions, and safety invariant enforcement.
- Tests must never test internal implementation details, private variables, or specific loop constructs.
- A test is considered valid only if it asserts that unsafe cancellations are blocked and valid cancellations proceed under exact, verified conditions.

### 2. Testing Seams

- **Primary Domain Seam**: The domain engine will be tested by driving it through its input events (presence changes, calendar updates, prompt responses) and asserting on calls made to mock implementations of every port: `IRoomPresenceDriver`, `IRoomInteractionDriver`, `ICalendarDriver`, `IDeviceConfigDriver`, `INotificationDriver`, `IFleetInventoryDriver`, and `IFleetConfigStore`.
- **Ingress Seam**: Ingress transports will be tested by delivering synthetic Webex JSON notification payloads and verifying correct dispatch to the domain engine.
- **Time Virtualization**: All timers and countdowns will be tested using virtualized/mock clocks to verify warning windows and empty-room timeouts deterministically in milliseconds without real-world delays.

### 3. Core Test Scenarios

- **No-Show Release Lifecycle**: Empty room triggers countdown, warning prompt displays, warning email dispatches to organizer, room remains empty, JIT validation confirms vacancy, the same controller set, and no reboot, checkout is issued, cancellation email dispatches.
- **User Keep Booking**: Warning prompt displays; user selects "Keep Booking"; prompt dismisses; meeting is preserved; countdown resets safely; a later warning has a new deadline and sends one new email; a dismissal restore sends none.
- **User Early Checkout**: User selects "Check Out"; confirmation prompt displays; user confirms; checkout is executed immediately with reason `UserConfirmed` and no cancellation receipt.
- **Occupancy Interruption**: Room becomes occupied during countdown; countdown cancels; automatic CheckIn is scheduled; meeting preserved.
- **Occupancy During Visible Prompt**: Room becomes occupied while the prompt is visible; the prompt stays visible; at expiry the release aborts and the booking is preserved.
- **Startup Quarantine**: Service starts with active meeting; room is empty; no automatic CheckIn, countdown, or release occurs; the meeting remains quarantined until the meeting ends.
- **Long Meeting Exemption**: 3-hour meeting begins; room is empty; autocancellation is blocked; no prompt, email, or checkout occurs.
- **JIT Verification Abort**: Room is empty throughout countdown, but person enters at $T=0$ before checkout; JIT validation detects presence; checkout command is suppressed; booking preserved.
- **Email Failure Keeps Prompt and Blocks Release**: Warning prompt displays, but the mock notification driver reports a delivery failure (or the organizer email is missing); the prompt stays visible; at the deadline the release is blocked and the booking preserved; no further countdown starts in that lifecycle. With `NOTIFICATIONS_ENABLED = false`, the same flow releases normally.
- **DRY_RUN PromptPending Occupancy**: In `DRY_RUN`, the simulated warning (`PromptPending`) is running when the room becomes occupied; the simulated warning is cancelled and a simulated automatic CheckIn is scheduled; no device command or email is sent.
- **Tripwire Activation**: Simulated burst of 31 `LIVE` cancellations within 5 minutes causes engine to freeze subsequent releases; `DRY_RUN` simulated releases do not count.
- **Kill Switch Cancels Active Workflow**: Activating the kill switch while a prompt is visible cancels the workflow and clears the prompt, preserves the booking, blocks a user-confirmed Check Out, and makes no native CheckIn write.
- **New Workspace Discovery**: The inventory returns new workspaces; each becomes a `DISABLED` roster entry; their events are discarded; no command or configuration write reaches them.
- **Device Replacement**: The managed device ID changes in a workspace; the room is demoted to `DISABLED` with `DeviceMismatch`; the new device is never touched.
- **Store Unavailable at Startup**: No actor is registered, every event is discarded, and no device is touched until the store loads.
- **Kill Switch Survives Restart**: Activate the kill switch, restart the service; it is still active and no release occurs.
- **Mode Promotion Quarantine**: Promoting a room with a meeting in progress to `DRY_RUN` or `LIVE` quarantines that meeting.
- **Controller Ownership Around Display**: With a controller on both the pre- and post-display reads, the prompt is owned and release proceeds; with no controller on either read, the prompt is still sent to the controller but not owned, and the booking is preserved at expiry, including when a controller connects mid-prompt.
- **Controller Set Changes Mid-Prompt**: On a chime tick the controller set differs from the one captured at display; ownership is dropped, the prompt is re-displayed with the remaining duration only, the deadline does not move, and the release is blocked at JIT validation. A failed or `403` controller read at JIT validation also blocks release.
- **Already Checked In**: The automatic CheckIn returns the "already checked in" error; CheckIn is confirmed and a later vacancy starts no No-Show countdown (Early Departure only if enabled).
- **Device Reboot During Workflow**: `SystemUnit.Uptime` read on a chime tick or at JIT validation is lower than the baseline or less than the workflow's age; the workflow aborts with `device_rebooted_during_workflow`, prompts clear, the booking is preserved, and the in-progress meeting is quarantined until it ends. An unreadable uptime at countdown start starts no countdown. A `BootEvent` cancels the workflow early but never on its own permits a release.
- **Midnight Re-Apply by Mode**: At the jittered midnight check, `DRY_RUN` and `LIVE` rooms receive the presence baseline and CheckIn window writes before re-verification; `DRY_RUN` enforces `Enabled = False`; `LIVE` re-runs the native CheckIn policy; `MONITOR_ONLY` receives no write. With the kill switch active, the presence and window writes run and no native CheckIn write is made.
- **CheckIn State Read (pending DT1)**: If DT1 is positive, a `CheckedIn` state at countdown start starts no countdown, prompt, or email, and a `CheckedIn` or unreadable state at JIT validation blocks the No-Show release. If DT1 is negative, the documented residual gap applies (LLD §5.9).

---

## Out of Scope

1. **Creating, Modifying, or Deleting Calendar Bookings**: The service only issues `CheckIn` and `CheckOut`; it never creates new bookings or invokes `Delete`.
2. **Direct Microsoft Exchange / Graph API Integration in Phase 1**: Exchange connectivity is delegated to Webex Control Hub Hybrid Calendar services in the initial release.
3. **Custom On-Device UI Extensions**: The service utilizes native Webex modal prompts (`UserInterface.Message.Prompt.Display`); custom in-room XML UI extensions or web panels are out of scope.
4. **Attendee / Chat Spam**: Notifying all meeting attendees or sending Microsoft Teams / Webex chat messages is excluded to protect confidentiality and prevent notification fatigue. Emails are strictly targeted to the meeting organizer.
5. **Physical Sensor Calibration**: Sensor tuning and hardware ultrasound thresholds remain the responsibility of device engineering.

---

## Further Notes

- The service maintains behavioral parity with the proven implementation in the codec-native macro, except where a Webex platform limit forces a stricter, fail-closed rule, and except for the one documented manual check-in gap that remains if device test DT1 is negative (Decision 17). The macro and its [specification](../../codec-native/docs/BookingAutoCancellationSpec.md) are the authority for every room-level behavior. Where a service document disagrees, the codec-native specification governs and the service document must be corrected. Service-only capabilities may only add reasons to preserve a booking.
- The architecture is designed so that Sprint 1 can be developed, tested, and validated 100% on a local engineer laptop using outbound long-polling, while being fully production-ready for AWS deployment in subsequent sprints.
- **Open item (codec test):** verify on a real codec whether `Bookings.Get` or `Bookings.List` expose a booking's CheckIn state, and whether the cloud `Bookings.CheckIn` command returns the same `already checked in` error text. The result may allow a later revision to lift startup quarantine on a verified CheckIn ([ServiceLowLevelDesign.md §5.9](ServiceLowLevelDesign.md)).
