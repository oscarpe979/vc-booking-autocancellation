# 09: Lightweight Admin Dashboard & Configuration UI

**What to build:** An enterprise IT administrator can open a lightweight, server-rendered web dashboard (`GET /admin`) with a clean, Google-style interface to monitor the fleet in real time and easily configure autocancellation behaviors and exemptions. The dashboard provides an instant 1-click emergency kill switch, a search bar to filter rooms, a live status table showing room occupancy and countdown timers, and an interactive configuration panel to view and update settings—including meeting duration thresholds, VIP organizer email lists, title keyword exemptions, timeout durations, and per-room operational modes (Monitor Only, Dry Run, Live)—without modifying code or restarting the service.

**Blocked by:** 01: Core Scaffolding & End-to-End Tracer Bullet, 05: Startup Quarantine, Exemption Engine & Midnight Health Check

**Status:** ready-for-agent

- [ ] Embedded Fastify web route (GET /admin) renders a clean, minimalist Google-style HTML dashboard with sub-50ms page load times and zero client framework build dependencies
- [ ] Prominent 1-click Emergency Kill Switch toggle that instantly halts or resumes automated cancellations across the fleet in real time without restarting the process
- [ ] Real-time search bar that filters the room fleet by room name, room ID, organizer email, or lifecycle status
- [ ] Fleet table displays each room's current meeting subject, organizer, presence state (Occupied / Empty), workflow phase (Idle, Quarantined, CountdownScheduled, PromptVisible), and remaining countdown seconds
- [ ] Configuration and exemption panel allows administrators to view and update runtime parameters:
  - Empty-room timeout (EMPTY_ROOM_TIMEOUT_MS), warning duration (PRE_TIMEOUT_WARNING_MS), and grace period (POST_TIMEOUT_GRACE_PERIOD_MS)
  - Long-meeting exemption threshold (LONG_MEETING_EXEMPTION_THRESHOLD_MS)
  - VIP / organizer exemption list (EXEMPT_ORGANIZERS) and meeting title keyword exemptions (EXEMPT_TITLE_KEYWORDS)
  - Corporate SMTP relay settings: host (SMTP_HOST, e.g. outlook.suncorp.com.au), port (SMTP_PORT, e.g. 25), sender address (SMTP_FROM), TLS toggle (SMTP_SECURE), and global notifications toggle (NOTIFICATIONS_ENABLED)
  - Per-room operational mode toggles (MONITOR_ONLY, DRY_RUN, LIVE)
- [ ] Updates made via the configuration panel take effect immediately on active and future room lifecycles and outbound email dispatches
- [ ] Automated tests verify dashboard HTML rendering, emergency kill-switch state toggling, SMTP setting updates, and configuration update persistence in memory
