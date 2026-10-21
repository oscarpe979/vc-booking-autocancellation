# 06: Early Departure Release Policy

**What to build:** An enterprise meeting space vacated before its scheduled end time can be safely returned to the room pool. Early Departure is off by default (`earlyDepartureReleaseEnabled = false`). When it is enabled and a meeting with CheckIn confirmation becomes vacant, the service runs the standard countdown, warning, and JIT sequence and, on release, sends an Early Departure cancellation notice. CheckIn confirmation comes from the service's own successful CheckIn, an `AlreadyCheckedIn` result, `BookedFromDevice = True`, or, pending device test DT1, a `CheckedIn` read of the booking's CheckIn state (LLD §5.9); in `DRY_RUN`, the simulated check-in selects the policy.

**Blocked by:** 03: In-Room User Interaction (Audio Chimes, Prompts & Check Out), 04: Occupancy Interruption & Automatic Check-In

**Status:** ready-for-agent

- [ ] When Early Departure is enabled and a meeting with CheckIn confirmation (or, in `DRY_RUN`, a simulated check-in) becomes vacant, an Early Departure countdown starts, subject to the same countdown-start horizon as No-Show
- [ ] The Early Departure flow uses the standard warning prompt, the warning email gate (ticket 10), user interactions ("Keep Booking" / "Check Out"), and the Just-In-Time release validation (LLD §5.5) before release
- [ ] Upon successful Early Departure release, a cancellation notice email using the Early Departure template (explaining the room was vacated prior to scheduled end time) is dispatched to the organizer
- [ ] If Early Departure is disabled (the default), vacancy after CheckIn confirmation is logged and never initiates a release workflow
- [ ] If attendees return during the Early Departure countdown, the countdown is cancelled and the reservation preserved; if they return while the prompt is visible, the prompt is kept and the release aborts at expiry (ticket 04)
- [ ] Recording CheckIn confirmation again for the same booking (for example an `AlreadyCheckedIn` result after `BookedFromDevice`) does not restart or corrupt an active Early Departure workflow
- [ ] Automated tests verify the complete Early Departure lifecycle, each confirmation source, warning email dispatch, the Early Departure cancellation notice, the default-off toggle, and occupancy during countdown and during a visible prompt
