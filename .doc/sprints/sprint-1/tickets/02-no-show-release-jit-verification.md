# 02: No-Show Release Workflow & Just-In-Time Verification Probe

**What to build:** An unoccupied room with an active, eligible scheduled booking automatically initiates a no-show release countdown. Rapid availability events are coalesced with a 50ms buffer, and missing metadata triggers a 5-step bounded recovery sequence. If the remaining meeting duration is too short (e.g. <= 12 minutes), autocancellation is safely skipped. At the pre-timeout warning threshold (governed dynamically by configuration, e.g. `PRE_TIMEOUT_WARNING_MS`), an actionable warning is triggered and a warning email is dispatched to the meeting organizer. When the countdown reaches zero plus the grace period, the service executes a synchronous, real-time Just-In-Time (JIT) check against room hardware. If confirmed vacant, the booking identity verified, and the warning email prerequisite satisfied, a checkout request is dispatched to release the room and a cancellation notice is sent to the organizer. If presence is occupied, uncertain, or warning email delivery failed, the release is aborted and the booking is preserved.

**Blocked by:** 01: Core Scaffolding & End-to-End Tracer Bullet

**Status:** ready-for-agent

- [ ] Rapid bursts of availability status and timestamp events are coalesced with a 50ms timer before fetching booking details
- [ ] If transient booking metadata is missing or unavailable, a 5-step bounded readiness recovery schedule ([250ms, 500ms, 1000ms, 2000ms, 4000ms]) executes with a fallback to Bookings.List({ ScheduleType: 'Current' })
- [ ] Autocancellation is safely skipped if the remaining meeting duration is less than or equal to the empty-room timeout plus grace period (<= 12 minutes)
- [ ] When a room is confirmed empty at the start of an eligible booking, a no-show countdown timer starts
- [ ] At the configured warning threshold prior to release, the service requests an actionable warning prompt through the interaction driver and initiates warning email dispatch to the organizer
- [ ] At the expiration of the empty-room timeout and grace period, the service executes a synchronous Just-In-Time probe querying instantaneous presence and availability
- [ ] Fail-closed safety check: if the warning email failed to send to the organizer after bounded retries, the checkout command is aborted and the booking preserved
- [ ] If the Just-In-Time probe confirms the room is still empty and the booking ID matches the active lifecycle, a checkout command is sent to the calendar driver
- [ ] Upon successful calendar release, a cancellation notice email (No-Show template) is dispatched to the meeting organizer via the notification driver
- [ ] If the Just-In-Time probe detects occupancy, an unknown presence state, or an altered booking identity, the checkout command is suppressed and the booking is preserved
- [ ] In dry-run mode, the full countdown, warning, email simulation, and verification sequence executes and emits structured simulation evidence without sending an actual checkout command to the calendar driver or live email to the organizer
- [ ] Automated tests verify the complete no-show release lifecycle, minimum duration guard, bounded readiness recovery, warning email gating, and Just-In-Time safety aborts using virtualized clocks
