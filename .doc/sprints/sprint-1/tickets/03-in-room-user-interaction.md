# 03: In-Room User Interaction (Audio Chimes, Prompts & Check Out)

**What to build:** An in-room meeting participant presented with an actionable warning on the touch controller can interact to preserve or immediately release their room. The warning includes dual presentation (actionable prompt on controller, informational guidance on room monitors), an audible chime at volume 70 with automatic volume restoration, dispatch of an urgent warning email to the organizer, and prompt text that switches from INITIAL to REPEATED if the room remains empty after a previous keep. If dismissed without selection, the prompt is restored for the remaining duration (without duplicate email spam). Selecting "Keep Booking" clears the warning prompt, cancels the pending cancellation, and resets the countdown. Selecting "Check Out" presents a confirmation prompt, and upon positive confirmation, dispatches an immediate checkout command to release the room ahead of schedule.

**Blocked by:** 02: No-Show Release Workflow & Just-In-Time Verification Probe

**Status:** ready-for-agent

- [ ] When the warning prompt appears, the service overrides volume to 70, plays the Announcement sound, holds for 4 seconds, restores volume to default, and repeats the alert every 60 seconds while the prompt is visible
- [ ] Concurrently with warning prompt display, dispatches `sendCancellationWarning` to the meeting organizer with dynamic remaining minutes and room-local clock time
- [ ] Warning presentation routes actionable buttons (Option.1: Keep Booking, Option.2: Check Out) to certified touch controllers and interactive displays (Desk Pro), while sending informational guidance to non-interactive room monitors (OSD)
- [ ] External room panels (RoomScheduler) are strictly excluded from receiving warning prompts
- [ ] The warning text dynamically uses INITIAL text on first display and switches to REPEATED text if the user previously kept the booking but the room remains vacant
- [ ] If the prompt is dismissed without making a selection (via swipe or UserInterface.Message.Prompt.Cleared), it is immediately restored on the touch controller for the remaining warning duration
- [ ] Single-warning guard: prompt restoration does not re-dispatch duplicate warning emails to the organizer
- [ ] When the warning prompt is visible on an actionable surface, a user response of "Keep Booking" clears the prompt and cancels the active release workflow
- [ ] After "Keep Booking" is received, a fresh countdown will only begin if the room subsequently remains continuously vacant
- [ ] A user response of "Check Out" on the warning prompt displays a distinct checkout confirmation prompt rather than releasing immediately
- [ ] Confirming checkout on the confirmation prompt issues an immediate checkout command to the calendar connector (manual user checkouts do not dispatch cancellation email receipts)
- [ ] Dismissing, ignoring, or canceling the confirmation prompt preserves the booking
- [ ] Stale prompt responses from older booking lifecycles or cancelled workflows are safely ignored
- [ ] Automated tests verify audio alerts, prompt restoration, warning email dispatch and deduplication, "Keep Booking", and the two-step "Check Out" interaction paths using mock drivers
