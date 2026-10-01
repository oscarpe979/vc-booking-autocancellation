# 05: Startup Quarantine, Exemption Engine & Midnight Health Check

**What to build:** Enterprise meetings are protected against improper cancellation during service maintenance, system reboots, and prolonged or VIP sessions. When the service boots or restarts, any meeting already active is quarantined and prohibited from automatic release until fresh check-in proof arrives. Meetings longer than two hours, organized by designated VIPs/groups, matching exempt title keywords, or with unverified calendar data are classified as exempt and blocked from autocancellation. The service also calculates codec-local midnight delays for scheduled health reconciliation and observes external calendar cancellations.

**Blocked by:** 02: No-Show Release Workflow & Just-In-Time Verification Probe

**Status:** ready-for-agent

- [ ] On service initialization, any room with a meeting already active is placed into Startup Check-In Quarantine (AwaitingStartupCheckIn)
- [ ] A quarantined meeting is strictly blocked from automatic no-show countdowns, warning prompt displays, and checkout commands
- [ ] A quarantined meeting transitions to normal management only when a fresh, matching check-in event is authoritatively observed for that booking ID
- [ ] Any current booking whose verified scheduled duration exceeds the configured threshold (e.g. 120 minutes) is classified as LongMeeting and blocked from autocancellation
- [ ] Any current booking organized by an individual in the configured VIP/organizer exemption list or containing exempt title keywords is blocked from autocancellation
- [ ] Any current booking whose start/end times cannot be verified, or whose details do not match the active schedule, is classified as Unclassifiable and blocked from autocancellation
- [ ] The service parses codec-local timezone offsets from hardware to calculate the millisecond delay to local midnight; if invalid or unavailable, it flags CodecTimeUnavailable and suspends release
- [ ] If a room transitions to Free or FreeUntil externally before its scheduled end, the service emits an [EXTERNAL_RELEASE_OBSERVED] structured audit log
- [ ] Automated tests verify that startup quarantine holds an ongoing empty meeting safe, clears upon check-in, and that long, VIP, and unclassifiable meetings remain untouched
