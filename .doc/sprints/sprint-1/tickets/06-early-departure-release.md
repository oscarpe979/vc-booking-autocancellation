# 06: Early Departure Release Policy

**What to build:** An enterprise meeting space vacated before its scheduled end time can be safely returned to the room pool. If a meeting was confirmed checked in and all attendees subsequently leave the room, the service detects the vacancy and initiates the early-departure countdown and warning sequence. If the room remains empty throughout the countdown and warning, warning email is sent, JIT vacancy is confirmed, and the remaining time is released with an early-departure cancellation notice dispatched to the organizer.

**Blocked by:** 03: In-Room User Interaction (Audio Chimes, Prompts & Check Out), 04: Occupancy Interruption & Automatic Check-In

**Status:** ready-for-agent

- [ ] When the early-departure feature is enabled and a previously checked-in meeting becomes vacant, an early-departure release countdown starts
- [ ] The early-departure flow utilizes the standard warning prompt, warning email dispatch, user interactions ("Keep Booking" / "Check Out"), and Just-In-Time verification probe before release
- [ ] Upon successful early-departure calendar release, a cancellation notice email using the Early Departure template (explaining the room was vacated prior to scheduled end time) is dispatched to the organizer
- [ ] If early departure is disabled in configuration, post-check-in vacancy is observed and logged but never initiates a release workflow
- [ ] If attendees return to the room during early-departure countdown or prompt presentation, the workflow cancels and preserves the reservation
- [ ] Duplicate check-in events do not restart or corrupt an active early-departure workflow
- [ ] Automated tests verify the complete early-departure lifecycle, warning email dispatch, Early Departure cancellation receipt, configuration toggle behavior, and occupancy cancellation
