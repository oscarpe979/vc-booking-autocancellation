# 04: Occupancy Interruption & Automatic Check-In

**What to build:** A meeting attendee walking into a reserved room is protected from accidental release and automatically checked in. Physical occupancy detected during an active countdown or while a warning prompt is displayed immediately halts the cancellation workflow, clears pending prompts, and preserves the reservation. For eligible scheduled meetings, sustained occupancy triggers an automatic check-in request with tracking metadata after a brief grace period, unless an authoritative check-in event was already observed or the booking was created directly on the room device (ad hoc).

**Blocked by:** 02: No-Show Release Workflow & Just-In-Time Verification Probe

**Status:** ready-for-agent

- [ ] Detecting room occupancy during an active countdown immediately aborts the release timer and resets the room to an active occupied state
- [ ] Detecting room occupancy while a warning prompt is displayed on screen keeps the meeting preserved, allowing occupants to interact or letting the prompt expire safely without triggering checkout
- [ ] For an occupied, eligible scheduled booking, the service schedules an automatic check-in command with tracking data after a configured delay (e.g. 3 seconds)
- [ ] If the booking was created directly from the room touch device (BookedFromDevice is True), automatic check-in is suppressed to allow native device check-in workflows
- [ ] If an authoritative check-in event is received from the room or user before the delay elapses, the automatic check-in command is suppressed
- [ ] Only one automatic check-in attempt is made per booking lifecycle
- [ ] Automated tests verify occupancy interruption during countdown, occupancy interruption during warning display, ad hoc booking suppression, and automatic check-in command scheduling
