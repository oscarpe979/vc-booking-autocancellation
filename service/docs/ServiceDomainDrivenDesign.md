# Service Domain Driven Design

## 1. Overview

This document specifies the Domain-Driven Design (DDD) model and Hexagonal (Ports and Adapters) architecture for the external Booking Auto Cancellation service.

The service manages meeting room reservation lifecycles across ~800 meeting spaces, decoupling physical presence telemetry, in-room user interactions, calendar commands, and end-user email notifications behind clean architectural seams while enforcing strict fail-closed safety invariants.

---

## 2. Domain-Driven Design Architecture Diagram

```mermaid
flowchart LR
    %% STYLING
    classDef driving fill:#e1f5fe,stroke:#0288d1,stroke-width:1.5px,color:#01579b;
    classDef config fill:#e0f2f1,stroke:#00897b,stroke-width:1.5px,color:#004d40;
    classDef aggregate fill:#ede7f6,stroke:#4527a0,stroke-width:2px,color:#311b92;
    classDef domain fill:#fce4ec,stroke:#c2185b,stroke-width:1.5px,color:#880e4f;
    classDef port fill:#fff3e0,stroke:#e65100,stroke-width:1.5px,color:#bf360c;
    classDef adapter fill:#e8f5e9,stroke:#2e7d32,stroke-width:1.5px,color:#1b5e20;
    classDef external fill:#eceff1,stroke:#546e7a,stroke-width:1.5px,color:#263238;

    %% 1. DRIVING INGRESS (LEFT)
    subgraph DrivingLayer ["1. Ingress Layer"]
        direction TB
        IngressPoll["<b>Webex Event Poller</b><br/>Streams presence & calendar events"]:::driving
        IngressAdmin["<b>Admin Dashboard</b><br/>Web UI & emergency kill switch"]:::driving
    end

    %% 2. CORE DOMAIN (CENTER-LEFT)
    subgraph CoreDomain ["2. Core Domain"]
        direction TB
        
        FleetConfig["<b>Dynamic Configuration</b><br/>Timeouts, VIP exemptions & SMTP settings"]:::config

        FleetRoster["<b>Fleet Roster</b><br/>Room enrollment & modes<br/>Roster gate (DISABLED by default)"]:::config
        
        RoomActor["<b>Room Workflow Coordinator</b><br/><i>(Aggregate Root)</i><br/>Tracks room lifecycle & active timers"]:::aggregate

        RulesEngine["<b>Safety & Exemption Rules</b><br/>• VIP & long meeting protection<br/>• Touch screen controller required<br/>• Warning email delivery verified<br/>• Real-time vacancy probe at T=0"]:::domain
    end

    %% 3. DOMAIN PORTS (CENTER)
    subgraph PortsLayer ["3. Domain Ports"]
        direction TB
        P_Presence["<b>IRoomPresenceDriver</b><br/>Presence telemetry"]:::port
        P_Interaction["<b>IRoomInteractionDriver</b><br/>In-room UI prompts & chimes"]:::port
        P_Calendar["<b>ICalendarDriver</b><br/>CheckIn & CheckOut actions"]:::port
        P_Config["<b>IDeviceConfigDriver</b><br/>Room sensor settings"]:::port
        P_Notify["<b>INotificationDriver</b><br/>Warning & cancellation emails"]:::port
        P_Inventory["<b>IFleetInventoryDriver</b><br/>Control Hub device discovery (read-only)"]:::port
        P_Store["<b>IFleetConfigStore</b><br/>Roster, settings & audit log"]:::port
    end

    %% 4. ADAPTERS (CENTER-RIGHT)
    subgraph AdaptersLayer ["4. Infrastructure Adapters"]
        direction TB
        WebexAdapter["<b>Webex Workspace Adapter</b><br/>Cisco RoomOS device integration"]:::adapter
        SmtpAdapter["<b>SMTP Notification Adapter</b><br/>Corporate email relay integration"]:::adapter
        StoreAdapter["<b>DynamoDB Config Store Adapter</b><br/>JSON file adapter for local dev"]:::adapter
    end

    %% 5. EXTERNAL SYSTEMS (RIGHT)
    subgraph ExternalLayer ["5. Enterprise Systems"]
        direction TB
        Ext_Cisco["<b>Cisco Room Devices</b><br/>Codecs & touch controllers"]:::external
        Ext_Exchange["<b>Microsoft Exchange</b><br/>Room calendars"]:::external
        Ext_Smtp["<b>Corporate SMTP Relay</b><br/>outlook.suncorp.com.au:25"]:::external
        Ext_Users["<b>Meeting Organizers</b><br/>User inboxes"]:::external
        Ext_ControlHub["<b>Webex Control Hub</b><br/>Workspace & device inventory"]:::external
        Ext_Dynamo["<b>AWS DynamoDB</b><br/>Rooms, settings & audit tables"]:::external
    end

    %% CLEAN UNIDIRECTIONAL FLOWS (LEFT TO RIGHT)
    IngressPoll -->|"Room Events"| FleetRoster
    FleetRoster -->|"Enrolled rooms only"| RoomActor
    IngressAdmin -->|"Config Updates"| FleetConfig
    IngressAdmin -->|"Enroll / Mode Changes"| FleetRoster
    FleetConfig -->|"Applies Rules"| RoomActor
    RoomActor -->|"Enforces"| RulesEngine
    FleetRoster --> P_Inventory
    FleetRoster --> P_Store
    FleetConfig --> P_Store

    %% ACTOR DISPATCHES THROUGH DOMAIN PORTS
    RoomActor --> P_Presence
    RoomActor --> P_Interaction
    RoomActor --> P_Calendar
    RoomActor --> P_Config
    RoomActor --> P_Notify

    %% PORTS ROUTE TO ADAPTERS
    P_Presence --> WebexAdapter
    P_Interaction --> WebexAdapter
    P_Calendar --> WebexAdapter
    P_Config --> WebexAdapter
    P_Notify --> SmtpAdapter
    P_Inventory --> WebexAdapter
    P_Store --> StoreAdapter

    %% ADAPTERS CONNECT TO EXTERNAL SYSTEMS
    WebexAdapter -->|"xCommand / xConfig"| Ext_Cisco
    Ext_Cisco -->|"xStatus / xEvent"| WebexAdapter
    WebexAdapter --> Ext_Exchange
    WebexAdapter -->|"Device list (read-only)"| Ext_ControlHub
    SmtpAdapter --> Ext_Smtp
    Ext_Smtp --> Ext_Users
    StoreAdapter -->|"HTTPS via VPC endpoint"| Ext_Dynamo
```

---

## 3. Detailed Component Responsibilities

### 3.1 Driving Ingress Layer & Configuration Sources

- **`LongPollingTransport`**: Outbound HTTPS 443 persistent connection to Webex Cloud integration queues. Ingests occupancy telemetry (`RoomAnalytics.RoomInUse`), calendar availability (`Bookings.Availability`), booking details, and touch controller user interactions without requiring inbound firewall pinholes, public DNS, or reverse proxies.
- **`AdminDashboardController`**: Fastify-embedded `/admin` web interface providing a 1-click fleet Emergency Kill Switch, real-time room search, and live configuration updates for timeouts, VIP lists, and SMTP relay settings.
- **`ConfigSources`**: Secrets (Webex credentials) come from AWS SSM Parameter Store (`SecureString`) or `.env.local`. All admin-controlled state (the roster, room modes, the kill switch, timings, exemptions, and SMTP settings) is loaded from and persisted to the durable fleet configuration store (DynamoDB in AWS, a JSON file on a laptop), so dashboard changes survive restarts. The `AUTOCANCEL_KILL_SWITCH` parameter remains as an independent, second kill-switch source ([ServiceLowLevelDesign.md §8](ServiceLowLevelDesign.md)).

### 3.2 Dynamic Fleet Configuration Model

- **Timing Thresholds**: `EMPTY_ROOM_TIMEOUT_MS` (default 10m), `PRE_TIMEOUT_WARNING_MS` (default 5m), `POST_TIMEOUT_GRACE_PERIOD_MS` (default 2m), `AUTOMATIC_CHECK_IN_DELAY_MS` (3s), `BOOKING_SYNC_COALESCE_DELAY_MS` (50ms), and `BOOKING_READINESS_RECOVERY_DELAYS_MS` (`[250, 500, 1000, 2000, 4000]`).
- **Room Policy Parity Settings** (same meaning and defaults as the macro `CONFIG`): `EARLY_DEPARTURE_RELEASE_ENABLED` (default `false`), `NATIVE_CHECK_IN_WINDOW_MINUTES` (default 60; must exceed the effective release horizon), and `ULTRASOUND_SENSOR_ENABLED` (default `false`; writes `PeoplePresence.Input.Ultrasound` `On`/`Off`).
- **Exemption Rules**: `LONG_MEETING_EXEMPTION_THRESHOLD_MS` (120m), `EXEMPT_ORGANIZERS` (VIP email list), and `EXEMPT_TITLE_KEYWORDS` (e.g. "Board", "Executive", "Confidential").
- **SMTP & Notification Settings**: `NOTIFICATIONS_ENABLED` (boolean), `SMTP_HOST` (`outlook.suncorp.com.au`), `SMTP_PORT` (25), `SMTP_FROM`, and `SMTP_SECURE`.
- **Safety & Rollout Modes**: `AUTOCANCEL_KILL_SWITCH`, fleet anomaly spike threshold (>30 releases / 5 min), and per-room operational mode (`DISABLED`, `MONITOR_ONLY`, `DRY_RUN`, `LIVE`).

### 3.2a Fleet Roster (Enrollment Authority)

- Owns the answer to "which rooms does this service manage, and how". Every workspace discovered in Control Hub gets a roster entry in `DISABLED` mode. A `DISABLED` room has no actor, and all of its events are discarded at the roster gate.
- Only an administrator can promote a room: `DISABLED → MONITOR_ONLY → DRY_RUN → LIVE` (or `DISABLED → DRY_RUN`). `LIVE` is reachable only from `DRY_RUN`, after a readiness report and an explicit, audited confirmation. The system may only demote a room, for example to `DISABLED` when its managed device is replaced.
- Binds each workspace to exactly one managed device. A replaced or ambiguous device is never touched until an admin re-enrolls it.
- Enforces the roster gate on both ingress events and outbound device commands.
- Details: [ServiceLowLevelDesign.md §5.7, §7.1 and §8](ServiceLowLevelDesign.md).

### 3.3 Aggregate Root: RoomActor (`RoomWorkflowCoordinator`)

- Manages an isolated in-memory Finite State Machine for each physical room across 7 lifecycle phases: `Idle`, `Quarantined`, `ActiveMeeting`, `CountdownScheduled`, `PromptVisible`, `ValidatingJIT`, and `Released`.
- **Generational Identity Counters**: Increments `bookingLifecycleId` on every meeting transition and `releaseWorkflowId` on every release attempt to cleanly reject stale, out-of-order asynchronous events.
- **Workflow State**: Tracks `warningEmailSent` status, `promptRestorationCount`, and manages active timers (countdown, grace period, and 60-second recurring audio chime loop).

### 3.4 Domain Policies (Business Logic)

- **`MeetingExemptionPolicy`**: Classifies meetings longer than `LONG_MEETING_EXEMPTION_THRESHOLD_MS` or matching `EXEMPT_ORGANIZERS` / `EXEMPT_TITLE_KEYWORDS` as exempt. Serializes commands to set `Bookings.CheckIn.Enabled: False` via a FIFO queue to protect exempt meetings from native RoomOS auto-release.
- **`StartupQuarantinePolicy`**: Quarantines meetings underway when the service initializes or restarts (`AwaitingStartupCheckIn`). Strictly prevents auto-cancellation until fresh in-room occupancy and check-in confirmation are observed.
- **`WarningNotificationPolicy`**: Calculates remaining countdown minutes dynamically from `PRE_TIMEOUT_WARNING_MS` (never hardcoded), formats the release time in the codec's local clock timezone, and enforces a single-warning invariant per booking lifecycle.
- **`FleetAnomalyTripwire`**: Monitors fleet-wide cancellation frequency; automatically trips into safe hold if cancellations exceed 30 within any sliding 5-minute window.

### 3.5 Safety Invariant Guards (Mandatory Fail-Closed Gates)

All four gates must evaluate to **Clear** before any automatic room release command may proceed. A user-confirmed Check Out bypasses the vacancy and email gates (as in the macro) but still requires a fresh booking snapshot with an unchanged booking ID:

1. **`ActionableSurfaceGuard`**: Discovers touch panels (`TouchPanel`, `Role: Controller`) and certified interactive displays (`Desk Pro`). Strictly filters out outside `RoomScheduler` panels. Aborts release if the room lacks an interactive controller.
2. **`MandatoryEmailProofGuard`**: Verifies that the cancellation warning email was successfully dispatched via SMTP. If delivery fails after retries, the service **fails closed and preserves the booking**.
3. **`MinimumRemainingTimeGuard`**: Skips autocancellation if `timeRemaining <= EMPTY_ROOM_TIMEOUT_MS + POST_TIMEOUT_GRACE_PERIOD_MS` ($\le 12$ minutes), allowing concluding meetings to end naturally.
4. **`SynchronousJitProbeGuard`**: Directly queries physical presence, booking availability, and fresh booking details at $T=0$, and re-verifies actionable prompt ownership. If the space is occupied, sensor state is unknown, the booking changed or reclassifies as long or unclassifiable, or no actionable surface owns the prompt, the release is aborted and the booking preserved (checklist in [ServiceLowLevelDesign.md §5.5](ServiceLowLevelDesign.md)).

### 3.6 Outbound Domain Ports (Hexagonal Seams)

- **`IRoomPresenceDriver`**: Queries instantaneous occupancy and streams presence transitions.
- **`IRoomInteractionDriver`**: Manages controller prompt buttons, OSD guidance, volume overrides (70%), audio chimes, and prompt restoration.
- **`ICalendarDriver`**: Queries booking availability and executes `checkIn` and `checkOut`.
- **`IDeviceConfigDriver`**: Enforces baseline presence configurations and serializes native check-in toggles.
- **`INotificationDriver`**: Dispatches warning alerts and differentiated cancellation receipts (No-Show vs Early Departure).
- **`IFleetInventoryDriver`**: Lists workspaces and devices visible in Control Hub. Read-only; never issues device xAPI calls.
- **`IFleetConfigStore`**: Durably loads and conditionally writes the roster and fleet settings, and appends to the audit log.

### 3.7 Driven Infrastructure Adapters

- **`WebexWorkspaceAdapter`**: Implements the presence, interaction, calendar, config, and inventory driver contracts against Cisco RoomOS endpoints and Control Hub via the Webex SDK. It refuses commands to devices the roster gate does not allow.
- **`SmtpNotificationAdapter`**: Connects to `outlook.suncorp.com.au:25` as an unauthenticated direct relay to deliver responsive multipart HTML and plain-text emails to meeting organizers.
- **`DynamoFleetConfigStore`**: Implements `IFleetConfigStore` against three DynamoDB tables (rooms, settings, append-only audit) using conditional writes. `JsonFileFleetConfigStore` implements the same port on a laptop.
