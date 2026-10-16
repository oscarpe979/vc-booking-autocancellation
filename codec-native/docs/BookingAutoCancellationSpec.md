# Booking Autocancellation Subsystem Specification

This is the implementation contract for [BookingAutoCancellation.js](../BookingAutoCancellation.js). It describes the behavior required for a Cisco RoomOS QuickJS macro that autocancels an active booking only when the room is confidently unused and every safety requirement is healthy.

The document is intentionally stricter than a best-effort autocancellation design. A booking must be preserved whenever the macro cannot prove that booking autocancellation is safe.

## 1. Purpose and Safety Invariant

The macro manages the current room booking. It may automatically check in an occupied active booking and may start a policy-specific empty-room autocancellation workflow. At the end of that workflow it may automatically check out the booking.

The macro must never delete a booking as a fallback for a failed check-in, failed check-out, failed status read, or failed configuration write.

The controlling invariant is:

```text
If every required condition is confirmed healthy:
    normal booking autocancellation may proceed.
Otherwise:
    preserve the booking and perform no automatic booking-changing action.
```

For this specification, a **booking-changing action** is any of the following:

- `xapi.Command.Bookings.CheckIn`
- `xapi.Command.Bookings.CheckOut`
- `xapi.Command.Bookings.Delete`
- In production, displaying the automatic room use check prompt as part of a release workflow

The macro itself must remain alive and subscribed to events when it is not ready. Not ready means that booking autocancellation is disabled for the current meeting, not that the macro process exits.

Dry run may execute internal countdown, simulated prompt, and simulated CheckIn branches for observability, but it must not issue booking commands, display or clear prompts, or play prompt audio. Those dry-run branches are simulation output, not booking-changing actions.

## 2. Terminology

### 2.1 Meeting and booking identity

- **Current booking ID**: The value returned by `xapi.Status.Bookings.Current.Id`. It identifies the meeting that commands may affect.
- **Booking lifecycle ID**: A monotonically increasing in-memory number owned by the macro. It changes when the current booking changes or ends. Every asynchronous operation captures the lifecycle ID at start and must ignore its result if it no longer matches.
- **Release workflow ID**: A monotonically increasing in-memory number for one countdown and room use check prompt attempt. Cancelling that attempt invalidates its ID, even when the booking lifecycle has not changed. Release-workflow work must ignore its result if its ID no longer matches.
- **Current meeting**: The booking represented by the latest validated current booking ID and availability state.
- **Long meeting**: A current booking whose verified scheduled duration, calculated as `Bookings.Get().Booking.Time.EndTime - StartTime`, is strictly greater than `CONFIG.LONG_MEETING_EXEMPTION_THRESHOLD_MS`.
- **Unclassifiable meeting**: A current booking whose `Bookings.Get({ Id })` response cannot be matched to the current booking ID, does not provide valid ordered start/end times, or whose parsed `EndTime` differs from the current `Availability.TimeStamp`.
- **Autocancellation status**: The identity-bound policy outcome for the current booking. It has exactly two values:
  - `Allowed`: the current booking is verified short and may use macro automatic CheckIn and release policies. Its `blockReason` is `null`.
  - `Blocked`: no automatic CheckIn, countdown, room use check prompt, or CheckOut is allowed for the current booking. Its `blockReason` identifies why. The dry-run simulation marker is an internal policy-evaluation aid and does not bypass a `Blocked` status.

- **Autocancellation block reason**: The concrete explanation paired with a `Blocked` status. The implementation uses `NoCurrentBooking`, `VerifyingMeetingLength`, `AwaitingStartupCheckIn`, `LongMeeting`, `InvalidLongMeetingExemptionConfiguration`, `RequiredConfigurationsUnavailable`, `RoomUseStatusUnavailable`, `CouldNotVerifyCurrentBooking`, `NativeCheckInSettingUnavailable`, `CodecTimeUnavailable`, and `CheckOutFailed`.

  The status/reason record is bound to the current booking ID and end timestamp. A booking action is allowed only when that record is still `Allowed` for the current lifecycle. A block reason never grants permission by itself.

When long-meeting classification fails, the macro emits one compact warning rather than logging each status read. It identifies whether the local snapshot was incomplete (`snapshot_incomplete`, with `lookup=not_attempted`), the `Bookings.Get` response was invalid (`booking_details_invalid`), or the lookup itself failed (`bookings_get_error`). The logged ID and timestamp values show the specific mismatch without maintaining a separate reason code for every predicate.

When a current booking is blocked because transient RoomOS information is missing, invalid, stale, or unavailable, the macro starts one bounded booking-readiness recovery sequence. Each attempt rebuilds the current environment and booking snapshot; when the current booking identity or schedule is incomplete, it uses `Bookings.Get({ Id })` for a known ID or `Bookings.List({ ScheduleType: 'Current' })` when the ID is missing, validates the returned identity and ordered future schedule, and revalidates freshness before policy evaluation. The configuration-owned recovery schedule is cancelled by a valid readiness result or lifecycle change, and never guesses missing data. Recovery never clears `AwaitingStartupCheckIn`, and deliberate blocks such as `LongMeeting` and `CheckOutFailed` do not schedule readiness recovery. Exhaustion preserves the booking and waits for a later RoomOS event or health check.

### 2.2 Availability states

`xapi.Status.Bookings.Availability.Status` has three supported values:

| Status | Meaning | Meaning of `TimeStamp` |
| --- | --- | --- |
| `Free` | There is no current booking and no relevant upcoming booking. | No current-booking meaning. Ignore it. |
| `FreeUntil` | The room is free now, and a later booking exists. | Start of the upcoming booking. |
| `BookedUntil` | A current booking is active. | End of the current booking. |

These meanings are not interchangeable. In particular, a `FreeUntil` timestamp must never be stored as `currentBookingEndTime`, used for a release timer, or used to check in a booking.

Unknown, empty, malformed, or failed availability status reads are unsafe. They must be represented as unknown, not converted to `Free`.

### 2.3 Presence states

`xapi.Status.RoomAnalytics.RoomInUse` is expected to return:

- `True`: the room is in use.
- `False`: the room is empty according to RoomOS sensor fusion.
- Anything else, including an empty value or a rejected read: unknown.

Unknown presence is not equivalent to empty. It must fail closed.

### 2.4 Readiness

- **Ready to manage the meeting**: Every required requirement for the current meeting has been validated successfully, the meeting identity is known, and no release-safety requirement has failed.
- **Not ready to manage the meeting**: At least one required requirement is unknown, invalid, unavailable, failed, stale, or belongs to an older booking lifecycle.

Environment readiness is evaluated per booking lifecycle. The autocancellation status reflects the combined decision from environment readiness, booking identity, long-meeting classification, startup provenance, and required native CheckIn state. Whenever a readiness failure suspends an active current booking, the status must become `Blocked` with the corresponding concrete reason; `Allowed` must not remain recorded while a readiness gate blocks autocancellation. CheckIn command outcomes are operational state, not release-safety requirements.

For a verified short meeting, native `Bookings.CheckIn.Enabled = True` makes RoomOS CheckIn available; the native setting alone does not automatically CheckIn a scheduled booking when presence is detected or a scheduled call is joined. The macro may separately schedule one automatic CheckIn attempt for an occupied current-session booking. In this deployment, ad hoc booking creation can CheckIn immediately, and a user can CheckIn manually. Both produce `xapi.Event.Bookings.CheckedIn`.

For a long or unclassifiable current meeting, production sets `Bookings.CheckIn.Enabled = False`. This disables native no-show release and blocks autocancellation: no macro CheckIn, empty-room countdown, room use check prompt, or CheckOut. Dry run establishes the same safety state at startup by setting `Bookings.CheckIn.Enabled = False` when the baseline has it enabled, then keeps native CheckIn disabled while suppressing booking commands and UI. Production restores native CheckIn only after RoomOS reports no current booking or verifies the next current booking is short. A failed production enable/disable operation keeps the affected booking blocked. A failed disable is retried on the next relevant recovery event before the blocked result is reused; a later booking retries independently.

Autocancellation status is the sole owner of native CheckIn policy for an active booking in production: `Allowed` requests `Bookings.CheckIn.Enabled = True`; `Blocked` with `VerifyingMeetingLength` makes no setting request; every other `Blocked` reason requests `False`. Dry run only establishes the startup safety state by writing `Bookings.CheckIn.Enabled = False` when necessary; it never enables native CheckIn for an observed booking. Native `Bookings.CheckIn.Enabled` writes must be serialized in request order. A newer enable or disable request must wait for an older in-flight write, so the older completion cannot overwrite the newer requested setting. A failed enable while transitioning to `Allowed` changes the status to `Blocked` with `NativeCheckInSettingUnavailable`; a failed disable keeps its existing block reason.

For an occupied current scheduled booking observed after startup, the macro schedules one automatic `xapi.Command.Bookings.CheckIn` attempt after `CONFIG.AUTOMATIC_CHECK_IN_DELAY_MS`. A matching `CheckedIn` event received during that grace period suppresses the command. The event's `Id` must match `xapi.Status.Bookings.Current.Id`; its `MeetingId` is retained only for diagnostics. In production, a successful command does not itself become RoomOS CheckIn confirmation; the authoritative confirmation is the matching `xapi.Event.Bookings.CheckedIn` event. In dry run, command execution is suppressed and the same validated attempt records a dry-run-only simulated confirmation for release-policy evaluation. That marker is not a RoomOS event, does not clear startup quarantine, and does not change native CheckIn configuration. For a current-session booking, a missing or failed production CheckIn does not by itself block the later release workflow; the booking remains eligible for No-Show Release if the room is confirmed empty. A booking already active when the macro starts remains in startup autocancellation quarantine until matching RoomOS CheckIn confirmation.

### 2.5 Release policies

The macro has two release policies that share the same countdown, prompt, final-validation, and CheckOut safety workflow:

- **No-Show Release**: The default policy. It applies to a current-session booking that has no matching RoomOS CheckIn confirmation or dry-run simulated CheckIn confirmation and the room is confirmed empty. A stable booking found during startup remains quarantined instead of entering this policy.
- **Early Departure Release**: An optional policy controlled by `CONFIG.EARLY_DEPARTURE_RELEASE_ENABLED`. It applies after a matching RoomOS CheckIn event or a successful dry-run automatic CheckIn simulation for the current booking and a later confirmed vacancy. When disabled, either confirmation cancels No-Show Release and starts no replacement release workflow.

Matching CheckIn is idempotent. A duplicate event for the current booking must not restart, extend, or otherwise alter an active Early Departure Release workflow. A matching confirmation supersedes an older asynchronous classification for the same booking: when that classification completes, it must use the current CheckIn-confirmation state and must not restore `AwaitingStartupCheckIn` or disable native CheckIn. A CheckIn event for another booking is retained only until booking reconciliation can compare its ID to the current booking.

### 2.6 Room use check prompt surfaces

- **Actionable room use check prompt surface**: A surface that can display `Keep Booking` and `Check Out` and is known to return `UserInterface.Message.Prompt.Response`. A room use check prompt may authorize automatic CheckOut only when at least one actionable surface successfully displayed the current lifecycle's prompt.
- **Controller room use check prompt surface**: At least one entry returned by `xapi.Status.Peripherals.ConnectedDevice.get()` with `Status = Connected`, `Type = TouchPanel`, and `Role = Controller`. The macro routes the actionable prompt using `Target: Controller`; it must not infer a controller from a model name.
- **Interactive OSD**: A built-in display verified to return a prompt response. `SystemUnit.ProductPlatform = Desk Pro` is currently the only supported interactive-OSD exception.
- **Informational OSD**: A room display notice directing occupants to the touch controller. It informs occupants but cannot authorize CheckOut. Normal room-codec OSDs use this form.
- **Room Scheduler**: A Navigator that is not a controller room use check prompt surface and must never receive the actionable controller prompt.

The `ConnectedDevice` status array is the controller source of truth and directly represents the `<Peripherals><ConnectedDevice>` XML. `RoomScheduler` entries are distinct from `TouchPanel` controllers even when both are Cisco Room Navigators. `xapi.Status.Peripherals.ConnectedDevice.on()` triggers an immediate inventory refresh; room use check prompt display and expiry also refresh the inventory. The macro compares connected controller identities and logs or refreshes prompt presentation only when that controller topology changes; telemetry updates such as Navigator room analytics must be ignored.

## 3. Sensor-Fusion Architecture

The macro relies on the RoomOS `RoomAnalytics.RoomInUse` result rather than implementing separate head-count and acoustic timers.

```text
  HeadDetector ───────────┐
  Ultrasound ─────────────┼──> RoomOS presence fusion ──> RoomInUse
  In-call activity ───────┤
  Local usage ────────────┘
```

The macro must request these configuration values at startup:

- `RoomAnalytics.PeoplePresenceDetector = On`
- `RoomAnalytics.PeoplePresence.Input.HeadDetector = On`
- `RoomAnalytics.PeoplePresence.Input.Ultrasound = On` when `CONFIG.ULTRASOUND_SENSOR_ENABLED` is `true`; otherwise `Off`
- `RoomAnalytics.PeopleCountOutOfCall = On`
- `RoomAnalytics.RoomInUse.InCall = Enabled`
- `RoomAnalytics.RoomInUse.LocalUsage = Enabled`
- `Bookings.CheckIn.WindowDuration = CONFIG.NATIVE_CHECK_IN_WINDOW_MINUTES`

In production and dry run, the macro writes the six RoomAnalytics presence settings and `Bookings.CheckIn.WindowDuration`. When `CONFIG.ULTRASOUND_SENSOR_ENABLED` is `false`, the macro explicitly writes `PeoplePresence.Input.Ultrasound = Off` and relies on the remaining RoomOS presence inputs, including head detection. A rejected, timed-out, or otherwise failed write makes the current meeting not ready. Dry run reads `Bookings.CheckIn.Enabled` and writes `False` when necessary to disable the native no-show path inherited from the baseline; an unreadable or rejected safety write makes dry run fail closed. This establishes the native CheckIn safety state while allowing the macro to activate the non-intrusive presence pipeline needed for observation. `CONFIG.NATIVE_CHECK_IN_WINDOW_MINUTES` must be a positive finite number of minutes. In production it must exceed `CONFIG.EMPTY_ROOM_TIMEOUT_MS + CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS`; in dry run it must exceed `CONFIG.EMPTY_ROOM_TIMEOUT_MS` because the post-timeout grace period is omitted. Otherwise native no-show release could race macro safety checks. A recovery validation must publish its configuration-health result only after confirming it still owns the current booking lifecycle and status-event version. The macro must log the setting name and error, preserve the booking, and wait for a later status-event reconciliation or the midnight health check.

The room use check prompt sound is optional. Failure to play it must be logged but must not by itself make the meeting not ready. In production, an actionable room use check prompt surface is a safety boundary: automatic CheckOut is blocked unless one has successfully displayed the prompt. A failed display must be logged accurately. The existing fixed prompt window remains available for an actionable controller that reconnects before expiry; expiry without an actionable surface preserves the booking. Dry run does not display or clear prompts and therefore does not require an actionable surface for its simulated release decision.

## 4. Configuration and Runtime Values

`CONFIG` owns deployment policy. Its current values are intentionally defined only in [BookingAutoCancellation.js](../BookingAutoCancellation.js); the values below describe the constraints and relationships that must remain true when a deployment changes them.

- `CONFIG.EMPTY_ROOM_TIMEOUT_MS` defines the base empty-room timeout before release validation.
- `CONFIG.PRE_TIMEOUT_WARNING_MS` defines the final portion of the base empty-room timeout reserved for the room use check prompt. Deployments should keep it no greater than `CONFIG.EMPTY_ROOM_TIMEOUT_MS` so the configured warning point is not before the countdown begins.
- `CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS` adds production-only time after the empty-room horizon before automatic CheckOut validation.
- `CONFIG.LONG_MEETING_EXEMPTION_THRESHOLD_MS` excludes meetings whose verified duration is strictly greater than the configured threshold. Set it to `0` to disable the exemption. A negative, non-finite, or otherwise invalid value suspends booking autocancellation.
- `CONFIG.NATIVE_CHECK_IN_WINDOW_MINUTES` is the RoomOS native no-show window. It must be positive, finite, and longer than the effective release horizon: `CONFIG.EMPTY_ROOM_TIMEOUT_MS + CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS` in production, or `CONFIG.EMPTY_ROOM_TIMEOUT_MS` in dry run.
- `CONFIG.AUTOMATIC_CHECK_IN_DELAY_MS` provides a grace period for a matching RoomOS CheckIn event before one automatic CheckIn attempt.
- `CONFIG.BOOKING_READINESS_RECOVERY_DELAYS_MS` defines the bounded readiness-recovery schedule. The macro uses only finite, non-negative delay entries and does not turn an invalid or exhausted schedule into an unbounded polling loop.
- `CONFIG.BOOKING_SYNC_COALESCE_DELAY_MS` debounces paired `Availability.Status` and `TimeStamp` events to prevent transient incomplete snapshots.
- `CONFIG.DRY_RUN_MODE` selects observation mode. In dry run, the macro writes `Bookings.CheckIn.Enabled = False` only when the baseline has it enabled, leaves an already-disabled value unchanged, and fails closed if the safety write cannot be completed.

The timing relationship is:

- Production displays the room use check prompt after `CONFIG.EMPTY_ROOM_TIMEOUT_MS - CONFIG.PRE_TIMEOUT_WARNING_MS`, keeps it eligible for `CONFIG.PRE_TIMEOUT_WARNING_MS + CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS`, and begins automatic CheckOut validation at `CONFIG.EMPTY_ROOM_TIMEOUT_MS + CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS`.
- Dry run uses the same warning point but omits `CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS`: its simulated warning window is `CONFIG.PRE_TIMEOUT_WARNING_MS` and its simulated release validation begins at `CONFIG.EMPTY_ROOM_TIMEOUT_MS`.

The production release eligibility condition is strict:

```text
timeRemaining > CONFIG.EMPTY_ROOM_TIMEOUT_MS + CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS
```

If the remaining time is exactly the release eligibility timeout, the macro must not start a countdown. The booking is allowed to expire through normal calendar behavior.

In dry run, the effective release eligibility threshold is `CONFIG.EMPTY_ROOM_TIMEOUT_MS` because `CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS` is not added. The comparison is still strict: `timeRemaining > CONFIG.EMPTY_ROOM_TIMEOUT_MS`.

## 5. Required Runtime State

The implementation may use different variable names, but it must represent these concepts explicitly:

- Current readiness and the reason it is not ready.
- Initialization/reconciliation state.
- Current booking lifecycle ID.
- Current booking ID.
- Validated availability status.
- Validated current booking end time.
- Validated upcoming booking start time.
- Validated presence state: occupied, empty, or unknown.
- Observed RoomOS CheckIn booking ID and whether automatic CheckIn was attempted.
- Dry-run simulated CheckIn booking ID, kept separate from the observed RoomOS CheckIn ID and cleared on lifecycle change or real CheckIn confirmation.
- Identity-bound autocancellation status, its block reason, desired native CheckIn setting, and whether that setting was applied.
- Whether one empty-room countdown is scheduled.
- Current release workflow ID.
- The fixed room use check prompt expiry time and whether controller and OSD prompts are visible and owned by the current booking lifecycle.
- The current booking's validated scheduled start time alongside its current availability end time. The start time is cleared when the booking or end time changes or schedule verification fails.
- Timer handles for the countdown and prompt expiry.
- Midnight health-check timer handle.

There must be at most one active empty-room countdown for a booking lifecycle and at most one room use check prompt expiry timer. Refreshing presentation because panel capability changes must not reset or extend that timer.

## 6. Startup Sequence and Initialization Race

The macro must remain subscribed to RoomOS events throughout startup. It must not ignore events merely because initial reads are still pending.

The required startup sequence is:

1. Establish event subscriptions once.
2. Set all required configurations and record success or failure for each one.
3. Read the current prompt-surface platform and connected controller inventory.
4. Read the current presence state.
5. Read the current availability status.
6. Read the current booking ID and availability timestamp according to the status (`BookedUntil` reads both; `FreeUntil` reads only the upcoming start timestamp).
7. Reconcile all values as one current snapshot.
8. Determine environment readiness and autocancellation status for the current booking lifecycle.
9. If `BookedUntil` was already active during startup and no matching CheckIn has been observed, set status to `Blocked` with `AwaitingStartupCheckIn`.
10. Only after status becomes `Allowed`, start the appropriate automatic CheckIn or release-policy countdown decision.
11. Schedule the next local-midnight health check.

Events may arrive while steps 2-7 are awaiting promises. Each event must update an event marker. A later startup read must not overwrite a newer event-derived value. When an event wins, initialization must complete readiness validation, final reconciliation, and local-midnight scheduling from current RoomOS status rather than returning early. Before making a booking-changing decision, the macro must perform a final reconciliation or otherwise prove that the snapshot is still current.

Safe startup outcomes:

- Stable active booking (`BookedUntil`) observed during startup: enter startup autocancellation quarantine. Do not start No-Show Release, Early Departure Release, automatic CheckIn, prompt display, CheckOut, or Delete because the macro cannot know whether the booking was already checked in before restart.
- `Blocked / AwaitingStartupCheckIn` sets `Bookings.CheckIn.Enabled = False` in production while the CheckIn state is unknown. Dry run keeps native CheckIn disabled after its startup safety write. A failed production write preserves the booking and retains the same blocked status and reason.
- A matching `xapi.Event.Bookings.CheckedIn` event transitions `Blocked / AwaitingStartupCheckIn` to `Allowed / null` and restores native `Bookings.CheckIn.Enabled = True` in production. A dry-run simulated CheckIn never clears startup quarantine because it does not prove CheckIn provenance. If the booking is empty, No-Show Release remains cancelled; Early Departure Release starts only when `CONFIG.EARLY_DEPARTURE_RELEASE_ENABLED = true`. If the booking is occupied, no release countdown starts.
- A booking first observed after startup is a current-session booking. Once its state is validated, an occupied booking may schedule delayed automatic CheckIn and an empty booking may start No-Show Release.
- No current booking (`Free` or `FreeUntil`): clear this macro's timers and prompt. Do not CheckOut or Delete.
- Unknown or failed required value: remain alive but not ready. Do not start a countdown, display a prompt, or send a booking-changing command.

## 7. Meeting Lifecycle

### 7.1 New current booking

When the validated current booking ID changes, including during recovery, the macro must:

1. Start a new booking lifecycle ID.
2. Cancel timers and clear any prompt owned by the previous booking lifecycle.
3. Reset per-meeting automatic-CheckIn state, except a pending native `CheckedIn` event whose `Id` exactly matches the newly validated booking ID.
4. Validate the new booking ID, availability state, timestamp, presence, configuration health, and command/display prerequisites.
5. When long-meeting exemption is enabled, call `Bookings.Get({ Id: currentBookingId })`, match its `Booking.Id`, validate ordered start/end times, and require parsed `Booking.Time.EndTime` to exactly match the parsed current availability timestamp.
6. In production, for a verified long or unclassifiable booking, set native CheckIn to `False` and perform no booking autocancellation. For a verified short booking, set native CheckIn to `True` before normal booking autocancellation. In dry run, ensure native CheckIn is `False` from the startup baseline and never enable it for observation.
7. If the booking was already active during macro startup and has not been confirmed by a matching CheckIn event, keep it in startup autocancellation quarantine rather than starting a release or CheckIn workflow.
8. Proceed only when the current booking's autocancellation status is `Allowed`.

### 7.2 Occupied active booking

For `BookedUntil` plus `RoomInUse = True`:

- For a current-session booking observed after startup, schedule macro automatic CheckIn after `CONFIG.AUTOMATIC_CHECK_IN_DELAY_MS` only when the current booking has a valid future end timestamp.
- Do not schedule automatic CheckIn for a stable active booking discovered during startup until a matching CheckIn event clears startup quarantine.
- A matching `CheckedIn` event cancels automatic CheckIn. An event received before current-booking reconciliation must be retained until its `Id` can be compared to the current booking ID.
- A missing, stale, malformed, or failed current end timestamp blocks automatic CheckIn and cancels any pending automatic CheckIn timer.
- At execution, revalidate the lifecycle, current booking ID, active availability, valid future current end timestamp, occupancy, and readiness before sending one command.
- In dry run, a validated automatic CheckIn records a simulated confirmation instead of sending the command; this confirmation is used only to select the later release policy.
- Repeated events must not create repeated automatic CheckIn commands.
- A failed production automatic CheckIn must not create another attempt in the same lifecycle. It does not by itself block CheckOut, Delete protection, countdown scheduling, or room use check prompt display for a current-session booking. In dry run, a validated automatic CheckIn attempt records a simulated confirmation; this is not a failed command and affects only later release-policy selection.

### 7.3 Empty active booking

For `BookedUntil` plus `RoomInUse = False`:

- The current booking ID and a valid future current-booking end timestamp are required.
- The macro must cancel its pending automatic CheckIn when the room becomes empty.
- The macro may start one No-Show Release countdown only for a current-session booking with no RoomOS or dry-run CheckIn confirmation, when all requirements needed for safe eventual CheckOut are healthy and `timeRemaining > getRequiredRemainingTimeForReleaseMs()`. In production this is `CONFIG.EMPTY_ROOM_TIMEOUT_MS + CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS`; in dry run it is `CONFIG.EMPTY_ROOM_TIMEOUT_MS`.
- A stable active booking discovered during startup remains `Blocked / AwaitingStartupCheckIn` and receives no release countdown until a matching CheckIn event is observed.
- After a matching RoomOS CheckIn event or successful dry-run automatic CheckIn simulation, No-Show Release is cancelled. If `CONFIG.EARLY_DEPARTURE_RELEASE_ENABLED = true`, a fresh Early Departure Release countdown may start when the room is empty and the same timing and readiness conditions hold. If the flag is `false`, no replacement countdown starts.
- Missing, stale, malformed, or failed timestamp data blocks the countdown. There is no fallback countdown.
- If the booking has no more than the effective release horizon from `getRequiredRemainingTimeForReleaseMs()` remaining, no countdown or prompt is started.
- When the long-meeting exemption is enabled, a fresh booking-details lookup must verify that the meeting is short before a countdown begins. A long, unclassifiable, stale, mismatched, or failed lookup preserves the booking. Production disables native CheckIn for the current meeting; dry run keeps native CheckIn disabled.
- If a current booking's end time changes while its countdown or room use check prompt is active, and fresh long-meeting classification determines that the booking is long or unclassifiable, the macro must preserve the booking, disable native CheckIn in production, clear both prompt surfaces in production, cancel the countdown and prompt-expiry timer, invalidate the release workflow, and log that booking autocancellation is suspended. In dry run, the macro performs the same internal cancellation without issuing prompt-surface or booking commands. A stale prompt-expiry callback must not run release validation afterward.

### 7.4 Policy transitions and occupancy

- A matching RoomOS CheckIn event or successful dry-run automatic CheckIn simulation cancels No-Show Release in both countdown and prompt phases, invalidates stale callbacks, and selects Early Departure Release only when enabled.
- A matching CheckIn while the room is occupied does not start Early Departure Release. Vacancy must be observed afterward before its countdown can start.
- `RoomInUse = True` is phase-specific. During a pre-prompt countdown or dry-run `PromptPending` state, it cancels the release policy and invalidates its callback. During a visible production room use check prompt, it preserves the prompt and its expiry callback so occupants can read and action it; expiry with confirmed occupancy preserves the booking and then follows normal automatic CheckIn policy. The cancellation or deferral log includes the booking ID through the policy workflow log and the presence transition.
- Duplicate matching CheckIn events are informational state confirmations only. They must not restart or extend timers.

### 7.5 Free and future-booking states

For `Free` or `FreeUntil`:

- Clear this macro's countdown and room use check prompt.
- In production, restore `Bookings.CheckIn.Enabled = True`; a failure keeps autocancellation blocked until a later lifecycle can retry. Dry run leaves the native setting unchanged.
- Clear current-booking end state.
- Preserve upcoming-booking start state only for observability and future reconciliation.
- Never send CheckOut or Delete because of these states. Automatic CheckIn is allowed only by the occupied-booking rules.

## 8. Empty-Room Autocancellation Workflow

The workflow has these phases:

1. **Allowed**: Current meeting has `Allowed / null` autocancellation status, is active, empty, identified, and has sufficient time remaining.
2. **Countdown scheduled**: One timer is scheduled for `CONFIG.EMPTY_ROOM_TIMEOUT_MS - CONFIG.PRE_TIMEOUT_WARNING_MS`.
3. **Prompt phase**: In production, the macro enters `PromptVisible`, fixes an expiry for the configured production warning duration, presents the prompt on every currently suitable surface, sounds an alert and arms the configured periodic alert sound, and may refresh presentation when controller availability changes. Dry run enters `PromptPending`, suppresses the prompt, and uses the configured dry-run warning duration.
4. **Release decision**: The prompt expires without user acknowledgement; the macro revalidates before any CheckOut.
5. **Checked out**: CheckOut succeeds (either via automatic empty-room release upon expiry or immediately upon user confirmation of `Check Out`), or the workflow ends because the booking is no longer current.

Presence behavior is deliberately phase-specific:

- Before the room use check prompt is displayed, `RoomInUse = True` cancels the countdown and schedules automatic CheckIn for the already-active booking, even when no new availability event arrives.
- During a visible production room use check prompt, `RoomInUse = True` retains the prompt on screen so the user can read and action it; it does NOT dismiss the prompt and defers automatic CheckIn until `Keep Booking` is chosen or the prompt expires with occupancy. If the prompt expires with `RoomInUse = True`, release validation aborts with `room_not_confirmed_empty`, clears the prompt, preserves the booking, and schedules automatic CheckIn. In dry-run `PromptPending`, the same occupancy transition cancels the simulated warning and schedules automatic CheckIn.
- An unknown `RoomInUse` event at any phase immediately makes presence unsupported, cancels automatic CheckIn and the release workflow, and blocks CheckOut until a later full presence revalidation succeeds.
- A `Free`/`FreeUntil` status, booking lifecycle change, or failed health check cancels the workflow in every phase.

At production room use check prompt expiry, the macro must revalidate at least:

- Current booking lifecycle ID and booking ID.
- Not in an unconfirmed Check Out confirmation guard (`isAwaitingCheckOutConfirmation = false`).
- `BookedUntil` status.
- Valid current booking end timestamp.
- `RoomInUse = False`; an occupied or unknown room cancels the workflow and preserves the booking.
- Readiness independent of RoomOS CheckIn observation or the automatic CheckIn result.
- That an actionable room use check prompt surface successfully displayed the prompt before expiry.
- When the long-meeting exemption is enabled, a fresh `Bookings.Get({ Id })` result that still matches the current booking and proves it remains short. A lookup failure, ID/end-time mismatch, invalid times, or newly long duration blocks CheckOut.
- Dry-run mode uses the same booking and readiness validation but intentionally does not require an actionable displayed prompt, because no prompt is displayed in that mode.
- That the expiry work still owns the current release workflow.

If validation fails, preserve the booking and send no CheckOut or Delete.

An expired unconfirmed Check Out confirmation guard is a distinct fail-closed outcome. The macro must preserve the booking, then re-read `RoomInUse` for the current booking lifecycle. If the fresh result is `False` and the booking remains eligible for release, it must immediately restore the original `Keep this booking?` warning with a full new production prompt duration. It must not restart the pre-warning empty-room countdown. If the fresh result is `True`, unknown, failed, stale, or no longer eligible, it must preserve the booking without restoring the warning; occupied revalidation follows the normal automatic CheckIn policy.

## 9. Room Use Check Prompt, Audio, and Interaction Guard

The macro uses consistent option ordering and separate prompt identities for each target:

- **Option 1**: `Keep Booking` (safe action across all prompts).
- **Option 2**: `Check Out` (initiates confirmation guard).
- Initial prompt:
  - `Target: Controller` / Interactive OSD: `auto_release_warning_controller`, Title: `Keep this booking?`, Text: `Room use hasn't been detected recently.<br>If the room is in use, select Keep Booking. Otherwise, it will be released automatically.`, Option 1: `Keep Booking`, Option 2: `Check Out`.
  - Informational `Target: OSD`: `auto_release_warning_osd`, Title: `Keep this booking?`, Text: `Room use hasn't been detected recently.<br>Please confirm on the touch controller to keep this booking.`.
- Repeated prompt (after previous `Keep Booking` in current booking lifecycle):
  - `Target: Controller` / Interactive OSD: `auto_release_warning_controller`, Title: `Keep this booking?`, Text: `Room use is still not detected.<br>If the room is in use, select Keep Booking. Otherwise, it will be released automatically.`, Option 1: `Keep Booking`, Option 2: `Check Out`.
  - Informational `Target: OSD`: `auto_release_warning_osd`, Title: `Keep this booking?`, Text: `Room use is still not detected.<br>Please confirm on the touch controller to keep this booking.`.
- Check Out Confirmation Guard (when `Check Out` is tapped):
  - `Target: Controller` / Interactive OSD: `auto_release_confirm_controller`, Title: `Check out`, Text: `Are you sure you want to check out? This will end your booking reservation and remove the meeting.`, Option 1: `Cancel`, Option 2: `Check out`.
  - Informational `Target: OSD`: `auto_release_confirm_osd`, Title: `Check out`, Text: `Are you sure you want to check out? This will end your booking reservation and remove the meeting.`.
  - The transition clears only the outgoing warning prompt IDs before presenting confirmation; it must not clear either confirmation prompt ID.
  - Confirmation guard preserves the active warning expiry deadline and does not extend it.
  - If `Check Out` is confirmed (Option 2), immediate `Bookings.CheckOut` is issued.
  - If `Cancel` is chosen (Option 1), the prompt clears, release is cancelled, and `hasUserSelectedKeepBooking` is recorded.
  - If the prompt timer expires while in the confirmation guard without confirmation, CheckOut is blocked and the booking is preserved. The macro revalidates `RoomInUse`: fresh `False` restores the original warning immediately with a full new prompt duration; fresh `True`, unknown, failed, stale, or ineligible state leaves the workflow idle without restoring a warning.

At production room use check prompt display, the macro fixes and arms one expiry deadline for the configured production warning duration before any asynchronous prompt display work begins. For every initial or recurring alert, it applies the configured prompt-audio volume, plays the configured alert sound, holds that volume for the configured hold period, then restores the default volume. Cancelling the release workflow before that hold expires must restore the default volume immediately. It arms the configured recurring alert timer while the prompt is visible. It sends an actionable prompt to controller-mode Navigators and an OSD prompt. A Desk Pro OSD is actionable; a normal room-codec OSD is informational and directs users to the touch controller. A Room Scheduler receives neither the controller target nor actionable buttons by virtue of being a scheduler. Dry run does not display, clear, or sound prompts and instead arms its configured simulated warning window.

- Prompt display success: mark the individual target as owned by the current booking lifecycle and release workflow. The first actionable display permits a later release validation.
- Prompt display failure: log the failed target and do not report it as displayed. Keep the original prompt deadline so an actionable controller that reconnects before expiry can be shown the remaining time.
- Controller availability change during a room use check prompt: use the connected peripheral inventory to clear an unavailable controller prompt, refresh a newly available controller prompt with the remaining duration, and never restart or extend the prompt deadline.
- Controller inventory read failure: treat controller availability and controller prompt ownership as unknown, clear cached controller authorization, and block controller-based CheckOut authorization. A verified interactive OSD may remain independently actionable.
- Delayed prompt display completion: if controller availability changed or the release workflow was cancelled while `Prompt.Display` was in flight, do not re-own the prompt; clear the late display. If that clear also removes a newer prompt on the same target, re-display the current prompt with its remaining duration. When the workflow remains active, retain the original deadline.
- Dismissed actionable prompt: a matching controller or interactive-OSD `UserInterface.Message.Prompt.Cleared` event restores that target only while the active workflow still owns it and no option selection is being processed. A valid response or macro cleanup invalidates ownership first, so its following `Cleared` event cannot restore the old prompt. The restored prompt uses the remaining duration and retains the other target, expiry timer, and release workflow.
- Prompt expiry with no actionable display: clear internal prompt ownership, preserve the booking, and send no CheckOut or Delete.
- Prompt sound failure: log the failure and continue because sound is optional.
- `Keep Booking` response: accept it only while its matching actionable prompt is visible and owned by the current room use check prompt lifecycle. An accepted response clears both prompts, cancels timers, clears the recurring alert sound interval, invalidates the current release workflow, and records `hasUserSelectedKeepBooking = true`. It then reads `RoomInUse` again. If the current booking is still eligible and RoomOS confirms `False`, the macro starts a fresh policy-selected countdown so a later warning uses the repeated prompt text. If RoomOS confirms `True`, automatic CheckIn is scheduled. An unknown, failed, or stale revalidation suspends autocancellation and preserves the booking.
- Stale or unmatched prompt response: log that it was ignored and leave the current countdown or prompt workflow unchanged.
- Prompt-clear failure: log the failure; internal ownership must still be cleared so stale state cannot authorize a release.

The macro must not claim that a suppressed or failed prompt was successfully displayed.

## 10. CheckIn, CheckOut, and Delete Rules

### CheckIn

For verified short meetings, `Bookings.CheckIn.Enabled = True` allows hybrid-calendar CheckOut and the macro is the primary automatic CheckIn mechanism. For long or unclassifiable meetings, it is deliberately `False` to disable native no-show release; those meetings receive no macro booking actions or prompts.

- A `CheckedIn` event with `Id` matching the current booking records external/user/ad hoc RoomOS CheckIn and cancels the scheduled macro command.
- If the event arrives before the current booking ID is reconciled, its `Id` is retained and compared during reconciliation.
- For ad-hoc meetings booked directly on the device (`BookedFromDevice: "True"`), RoomOS/Webex natively checks in the booking as soon as cloud provisioning completes; the macro does not issue a redundant manual `Bookings.CheckIn` command.
- For scheduled meetings (`BookedFromDevice: "False"`), when the configured automatic-CheckIn grace period expires without a matching event, the macro may make one command only after re-reading and confirming `BookedUntil`, the same booking ID, a valid future current end timestamp, confirmed occupancy, and healthy required configuration.
- The automatic command carries `TrackingData: BookingAutoCancellation_Automatic` and is never retried within the lifecycle.
- In dry run, command execution is suppressed. After the same validation, the macro logs `[DRY RUN - INTENT_TO_AUTOMATIC_CHECK_IN]` and `[DRY RUN - SIMULATED_CHECK_IN]`, then uses the simulated confirmation only for release-policy evaluation.
- The exact RoomOS response `Cannot check in booking that is already checked in.` is a normal duplicate race: log it at informational level as an already-checked-in no-op. Do not retry it and do not affect booking release.
- Other CheckIn failures, including `Booking not found`, remain error-level diagnostics. For a current-session booking, a missing RoomOS event or any failed CheckIn never blocks later booking release. A booking discovered as already active during startup remains in startup autocancellation quarantine until matching CheckIn confirmation.

### CheckOut

Automatic CheckOut is allowed only after room use check prompt expiry and a fresh validation confirms that the current meeting is still safe to release. A user-confirmed Check Out may issue CheckOut immediately after re-reading the current booking snapshot. A valid current booking ID is mandatory.

If CheckOut rejects or fails:

- Log the failure.
- Preserve the booking.
- Do not call `Bookings.Delete`.
- Disable automatic booking actions for the remainder of that booking lifecycle. `CheckOutFailed` does not schedule readiness recovery; a later booking lifecycle is evaluated independently.
- If the command completes after its lifecycle, release workflow, or booking ID changed, log the stale failure and do not modify the newer booking's autocancellation state or prompts.

In dry run, log `[DRY RUN - WOULD_RELEASE]` with the booking ID and reason, but do not send CheckOut. Do not mark CheckOut as successful.

### Delete

This macro must never call `xapi.Command.Bookings.Delete` as part of automatic release. The booking service remains the authority for calendar state.

## 11. Recovery and Midnight Health Check

There is no unbounded polling loop or delayed retry loop for failed commands. The one bounded exception is current-booking readiness recovery when a transient blocker is recorded; its number of full xAPI reconciliation attempts is bounded by the configured recovery schedule and it is cancelled by a valid readiness result or lifecycle change.

Recovery is attempted by:

- Every relevant RoomOS status event that requires readiness recovery, using a full fresh validation before making a decision.
- One additional health check at local midnight on the codec.

For an unchanged current booking, recovery reuses a cached `Allowed / null` or `Blocked / LongMeeting` result. Fresh readiness recovery reassesses transient blocked results, rebuilding booking identity and schedule through `Bookings.Get({ Id })` or `Bookings.List({ ScheduleType: 'Current' })` when required. Final CheckOut validation still performs its own fresh `Bookings.Get` validation.

The midnight check must use the codec's local timezone obtained from `xapi.Status.Time.SystemTime`. The implementation must not guess a timezone. If local timezone information is unavailable, the meeting is not ready and the health check must not be scheduled using an assumed offset.

Midnight behavior:

- Successful validation preserves an active valid countdown or prompt when its booking lifecycle is unchanged.
- If recovery identifies a different current booking ID, it must apply the new-current-booking lifecycle rules before storing that ID. The old countdown and prompt are cancelled; the successful recovery then evaluates the new lifecycle normally.
- If recovery identifies `Free` or `FreeUntil` while a booking lifecycle or release workflow is active, it must invalidate that lifecycle and cancel the prior workflow before accepting a later booking.
- Failed validation cancels the countdown and prompt, preserves the booking, and marks the meeting not ready.
- A successful recovery may start a new workflow only after full validation; it must not duplicate existing timers.
- A valid presence event after failed startup readiness must perform a full fresh validation, including rebuilding the current booking snapshot from RoomOS when local availability or booking identity is unknown, then schedule the midnight health check.
- The status event that successfully restores readiness must immediately reconcile the recovered booking workflow, even when its presence value matches the recovered presence state.
- Recovery must capture its booking lifecycle and status-event version before its first awaited read, and discard the entire recovered snapshot if either changes before it commits state.
- Failed configuration, presence, availability, timestamp, or display requirements are reconsidered on the next relevant status event or next midnight, not through hidden polling. For a current-session production booking, a missing `CheckedIn` event or failed automatic CheckIn remains observable for the lifecycle and does not itself block No-Show Release. In dry run, a validated automatic CheckIn attempt creates a local simulated confirmation and therefore selects the confirmed-booking policy path. A booking discovered as already active during startup remains in startup autocancellation quarantine until matching RoomOS CheckIn confirmation.

## 12. Dry-Run Mode

Dry run uses the same configuration setup, status, identity validation, automatic CheckIn timing, and expiry validation as production. It is not permission to skip health checks. For an occupied booking, automatic CheckIn command execution is deliberately suppressed; after the same validation that would precede the production command, the macro records a local simulated CheckIn confirmation so later release-policy evaluation follows the expected successful-CheckIn path. This marker is not a RoomOS event, does not clear startup quarantine, and does not enable native CheckIn configuration. When the room later becomes empty, Early Departure Release is selected when enabled; when disabled, the confirmed booking has no release policy. Dry run intentionally omits the production post-timeout grace period so its simulated release decision occurs at the configured empty-room horizon. Dry run is observation-only for booking behavior after establishing the native safety baseline: it may configure the non-intrusive presence pipeline and CheckIn window, disable `Bookings.CheckIn.Enabled` when necessary, but it must not enable native CheckIn, display or clear prompts, play sounds, or send CheckIn, CheckOut, or Delete. Native RoomOS no-show behavior is disabled by the dry-run startup safety write; independent third-party automation remains outside the macro's control.

When `CONFIG.DRY_RUN_MODE = true`:

- At startup, the macro emits a warning-level `[DRY RUN MODE ACTIVE] RoomAnalytics configured; native Bookings.CheckIn.Enabled disabled; NO macro booking commands or UI.` banner.
- Automatic CheckIn, CheckOut, and Delete are suppressed.
- Required RoomAnalytics and `Bookings.CheckIn.WindowDuration` configuration is written and reported. `Bookings.CheckIn.Enabled` is read and set to `False` when necessary; an unreadable or failed safety write makes dry run fail closed.
- Native RoomOS no-show behavior is disabled by dry-run startup. Any independent third-party automation can still affect end users.
- The macro logs automatic CheckIn, warning-prompt display, and release intent. It does not mark a suppressed command as sent or a RoomOS event as observed; it may record a separate simulated CheckIn marker solely for release-policy evaluation. Automatic CheckIn messages use the debug channel; simulated CheckOut intent remains in the log channel for comparison with external checkout records.
- Countdown scheduling is allowed when the current meeting is otherwise ready.
- The room use check prompt is never displayed, and its sound is never played. When the warning point is reached, the macro logs `[DRY RUN - WOULD_DISPLAY_PROMPT] Booking ID {id} would display the room use check prompt now.` and starts the fixed dry-run expiry timer using `CONFIG.PRE_TIMEOUT_WARNING_MS`; production uses `CONFIG.PRE_TIMEOUT_WARNING_MS + CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS`.
- The simulated warning point still starts a prompt-duration expiry timer of `CONFIG.PRE_TIMEOUT_WARNING_MS`, without the production grace period. It completes normal booking validation and logs `[DRY RUN - WOULD_RELEASE]`. The intentionally absent actionable `Stay` surface is not required for dry-run validation and must not suppress that dry-run log.
- A third-party Exchange checkout is observed as a `Free` or `FreeUntil` availability transition. If it ends a known current booking before its scheduled end and does not match a pending live macro CheckOut for that booking lifecycle, the macro logs `[EXTERNAL_RELEASE_OBSERVED]`, reconciles the transition, cancels its timers, preserves the external lifecycle change in logs, and sends no macro CheckOut or Delete command. In dry run, reconciliation also does not clear any prompt that may have been displayed by another system.

## 13. Event Ordering and Asynchronous Safety

Status and timestamp events may arrive in either order. The implementation must handle both sequences:

- `BookedUntil` before the current end timestamp.
- Current end timestamp before `BookedUntil`.

Until both the status and a valid future timestamp agree that a current booking is active, no countdown may start.

When status is `FreeUntil`, the timestamp is an upcoming start and must never be reused as a current end. When status changes to `BookedUntil`, any older timestamp must be rejected until a valid current end is received.

Every awaited booking snapshot read must be associated with both the booking lifecycle ID and the status-event version captured before its first xAPI read. Countdown, room use check prompt, and expiry work must also be associated with the release workflow ID. A stale completion must not:

- Start a timer.
- Display or re-own a prompt.
- Send CheckIn or CheckOut.
- Mark a requirement healthy.
- Restore readiness for a different meeting.

## 14. Logging and Observability

All macro logging is routed through the private Section 14 logger. Domain code does not call `console.*` directly. The logger separates severity from event type and owns channel routing, safe structured-field formatting, and the `CONFIG.DEBUG` gate. Every emitted message retains the `[BookingAutoCancellation]` prefix.

Channel policy:

- `console.log` is the checkout comparison channel. It contains only macro checkout events and externally observed checkout events.
- `console.debug` is the routine diagnostic channel. Informational events not explicitly allowlisted for the checkout comparison channel default here, and output is suppressed when `CONFIG.DEBUG = false`.
- `console.warn` remains the warning channel.
- `console.error` remains the error channel.

The current informational checkout allowlist is:

- `checkout`: macro dry-run intent (`source=macro mode=dry_run outcome=would_issue`), live macro success (`source=macro mode=live outcome=issued`), and live macro failure (`source=macro mode=live outcome=failed` on the error channel).
- `external_checkout_observed`: a `Free` or `FreeUntil` transition that ends a known booking before its scheduled end (`source=external mode=live outcome=observed`).

The runtime identity is defined in `MACRO_INFO` and currently uses `NAME = BookingAutoCancellation` and `VERSION = 0.1.4`. Startup emits the macro name, version, and mode through the startup diagnostic channel. Git tags and deployment manifests are separate release metadata and are intentionally not part of this runtime versioning contract.

Checkout records include a stable `event=CHECKOUT` field, the runtime `version`, `source`, `mode`, `outcome`, booking ID, and, when the meeting schedule has been verified, `meetingStart` and `meetingEnd` timestamps. The start is taken from `currentBookingStartTime` while it belongs to the current booking and end-time state; the end comes from the authoritative previous availability value. When the start has been invalidated, it is emitted as missing. Existing searchable markers such as `[DRY RUN - WOULD_RELEASE]` and `[EXTERNAL_RELEASE_OBSERVED]` remain unchanged. Human-readable messages are preserved while routine lifecycle details move to debug.

Readiness changes, availability and presence transitions, countdown and prompt activity, CheckIn activity, configuration status, stale-state diagnostics, and midnight validation remain observable through debug, warning, or error channels according to severity. A known `RoomInUse = True` or `False` value whose readiness is still being reconciled is a normal debug-level paused state and must not be logged as device capability failure. An unknown or unavailable `RoomInUse` state remains a warning until presence can be revalidated. Expected startup quarantine (`Blocked / AwaitingStartupCheckIn`) is also a normal debug-level paused state and is reported as `remains paused`, not as a warning. Warning and error channels are reserved for actual readiness, safety, command, or configuration failures. No booking state transition, timer, xAPI command, or interpretation of `Free`/`FreeUntil` changes as part of this logging policy.

Dry-run release intent must use a stable searchable marker such as:

```text
[BookingAutoCancellation] [DRY RUN - WOULD_RELEASE] Booking ID {id} would be checked out now due to inactivity.
```

Dry-run automatic CheckIn simulation must use stable searchable markers such as:

```text
[BookingAutoCancellation] [DRY RUN - INTENT_TO_AUTOMATIC_CHECK_IN] Booking ID {id} would be checked in because the room is occupied.
[BookingAutoCancellation] [DRY RUN - SIMULATED_CHECK_IN] Booking ID {id} is treated as checked in for release-policy simulation.
```

Structured fields use a fixed event allowlist and safe deterministic formatting. Error values are reduced to their message; arbitrary objects and raw xAPI responses are not serialized. Logging must not expose credentials or imply that a suppressed command succeeded.

## 15. Reliability Guarantees

The implementation is acceptable only if all of these remain true:

1. Any unknown required state fails closed.
2. No failed configuration write is silently treated as healthy.
3. No missing timestamp starts a countdown.
4. A `FreeUntil` timestamp never becomes a current booking end.
5. A missing booking ID blocks automatic booking-changing actions.
6. Empty rooms cancel any pending automatic CheckIn and are never CheckIn-tested.
7. A matching RoomOS `CheckedIn` event cancels automatic CheckIn; otherwise macro automatic CheckIn is attempted at most once per booking lifecycle.
8. Production CheckOut is never attempted after failed readiness, stale booking lifecycle, or room use check prompt expiry without an actionable displayed `Stay` surface. Dry-run release validation intentionally omits the actionable-surface requirement because no prompt is displayed. Missing RoomOS CheckIn observation or a failed production automatic CheckIn does not by itself prevent CheckOut for a current-session booking; a dry-run simulated confirmation affects only policy selection.
9. Delete is never used as a fallback.
10. Repeated events cannot create duplicate timers or command storms.
11. A stale asynchronous operation cannot affect a newer meeting.
12. The macro remains subscribed and can recover after a failed requirement.
13. The booking is preserved whenever safe release cannot be proven.
14. A delayed or stale prompt response cannot cancel a countdown or room use check prompt that it does not own.

## 16. Edge-Case and Outcome Matrix

| ID | Scenario | Required outcome |
| ---: | --- | --- |
| 01 | Occupied active booking at startup | Enter startup autocancellation quarantine; do not schedule automatic CheckIn or start a release countdown until a matching RoomOS `CheckedIn` event is observed. |
| 02 | Empty active booking at startup | Enter startup autocancellation quarantine; do not start No-Show Release until matching RoomOS `CheckedIn` confirmation clears the quarantine. |
| 03 | `Free` at startup | Clear this macro's workflow; send no command. |
| 04 | `FreeUntil` at startup | Clear this macro's workflow; treat timestamp only as upcoming start. |
| 05 | Unknown startup presence | Remain not ready; no automatic CheckIn, CheckOut, Delete, countdown, or prompt. |
| 06 | Presence query rejects | Same fail-closed behavior as unknown presence. |
| 07 | Availability query rejects | Do not convert failure to `Free`; remain not ready. |
| 08 | Timestamp query rejects or returns stale data | Do not start countdown; preserve booking. |
| 09 | Required configuration write rejects | Not ready; no automatic booking-changing action. |
| 10 | Event arrives during startup reads | Newer event state wins; stale startup read cannot overwrite it; readiness, workflow reconciliation, and midnight health scheduling still complete. |
| 11 | Timestamp arrives before `BookedUntil` | Do not use it until status confirms the current booking. |
| 12 | `BookedUntil` arrives before timestamp | Keep the booking blocked, perform bounded booking-readiness recovery through RoomOS status reads and identity-bound booking details, and start no automatic CheckIn or release workflow until all required current-booking data is validated. |
| 13 | Repeated empty status/timestamp events | Exactly one countdown and no command storm. |
| 14 | Room becomes occupied before the room use check prompt | Cancel countdown; schedule the one delayed macro automatic CheckIn if ready, including an arrival after the booking has already started. |
| 15 | Room becomes occupied after the room use check prompt | Retain prompt on screen so user can read/action it; defer automatic CheckIn until `Keep Booking` or occupied expiry; at expiry preserve booking and schedule automatic CheckIn. |
| 15A | `RoomInUse` becomes unknown during countdown or room use check prompt | Cancel booking autocancellation; preserve booking and block CheckOut until full presence revalidation succeeds. |
| 16 | User selects `Keep Booking` | Clear prompt and timers; preserve booking; set `hasUserSelectedKeepBooking = true`; if occupied, schedule automatic CheckIn. |
| 17 | All room use check prompt displays reject | Keep the fixed room use check prompt window for a reconnecting controller; at expiry preserve the booking and send no CheckOut or Delete. |
| 18 | Room use check prompt sound rejects | Log the failure; continue because sound is optional. |
| 19 | Booking becomes `Free` during countdown or room use check prompt | Clear workflow; send no CheckOut or Delete. |
| 20 | Booking becomes `FreeUntil` during countdown or room use check prompt | Clear workflow; do not use upcoming timestamp for release. |
| 21 | Booking ID is missing | Block automatic CheckIn, CheckOut, Delete, countdown, and prompt. |
| 22 | Booking ID changes at rollover | Start a new booking lifecycle, cancel old timers including automatic CheckIn, invalidate old work, validate the new booking, and schedule automatic CheckIn only if occupied and ready. |
| 23 | Occupied sequential rollover | Do not CheckOut the prior booking; schedule automatic CheckIn for the new booking unless a matching RoomOS event suppresses it. |
| 24 | Empty room has exactly the effective release horizon remaining | No countdown or prompt; let normal booking expiry handle it. The effective horizon is `CONFIG.EMPTY_ROOM_TIMEOUT_MS + CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS` in production and `CONFIG.EMPTY_ROOM_TIMEOUT_MS` in dry run. |
| 25 | Empty room has less than the effective release horizon remaining | Same as ID 24. |
| 26 | Automatic CheckIn rejects | Log failure and do not retry during the lifecycle; the known already-checked-in response is informational, while other errors remain diagnostic; countdown, prompt, and CheckOut remain governed by independent release checks. |
| 27 | CheckOut rejects | Preserve booking; log failure; never call Delete; block automatic booking actions for the remainder of the current booking lifecycle. |
| 28 | Dry-run automatic CheckIn/CheckOut | Suppress automatic CheckIn and CheckOut commands; after validated automatic CheckIn preconditions, record a simulated CheckIn and follow the corresponding release-policy path without sending booking commands. |
| 29 | Dry-run prompt disabled | Do not display prompt or claim it displayed; never CheckOut. |
| 30 | Midnight validation succeeds | Preserve valid current workflow without duplicating timers. |
| 31 | Midnight validation fails | Cancel workflow, preserve booking, and wait for event-driven recovery. |
| 32 | Codec timezone unavailable | Do not guess; do not schedule an assumed midnight check; remain not ready. |
| 33 | Stale async read resolves after rollover | Ignore result and leave the new booking lifecycle unchanged. |
| 34 | Manual early checkout/cancellation | `Free` or `FreeUntil` clears local workflow; no automatic checkout loop. |
| 35 | Call ends while RoomOS still reports occupants | If `RoomInUse` remains `True`, preserve booking. The macro does not make an independent inference from call state. |
| 36 | Touch/local usage wakes an empty room | `RoomInUse = True` cancels the pre-prompt countdown and schedules automatic CheckIn for a current-session booking when readiness is healthy; dry run records the simulated confirmation only after that validation completes. |
| 37 | Privacy shutter or sensor-input change | Act only on the resulting RoomOS `RoomInUse` value; unknown or unavailable presence remains fail closed. |
| 38 | Short false occupancy such as a cleaner | A confirmed occupied event may schedule one automatic CheckIn; later vacancy cancels a pending command and starts the applicable release policy only after readiness validation. Dry run treats a validated automatic CheckIn as a simulated confirmation. |
| 39 | Desk Pro room use check prompt | Display actionable OSD `Keep Booking` and `Check Out`; response clears or initiates confirmation. |
| 40 | Normal room codec with a controller Navigator | Display an informational OSD prompt and an actionable `Target: Controller` prompt. |
| 41 | Room Scheduler present without a controller Navigator | Do not send actionable prompt to the scheduler; expiry without another actionable surface preserves the booking. |
| 42 | Controller disconnects or reconnects during the room use check prompt | Refresh connected peripherals, clear the unavailable controller prompt, and show a reconnecting controller only remaining time without changing the fixed expiry. |
| 43 | Controller disconnects after its prompt is displayed | Clear the controller prompt, preserve the original expiry, and block CheckOut unless another actionable surface is available at expiry. |
| 44 | Dry run reaches expiry without native controls or warning UI | Display no prompt, send no CheckOut, and log the simulated prompt and release intents after normal booking and readiness validation; no actionable prompt surface is required. |
| 45 | Delayed prompt response arrives while no matching room use check prompt is visible | Ignore the response and leave the current countdown or room use check prompt workflow unchanged. |
| 45A | User closes an actionable room use check prompt without a selection | Re-display only the dismissed controller or interactive-OSD prompt for the remaining duration; do not extend its expiry or open a new release workflow. |
| 46 | Controller prompt display completes after Controller mode is lost | Clear the late prompt, do not re-own it, and keep the room use check prompt available for a later reconnect. |
| 47 | Valid `Keep Booking` response arrives while expiry validation is awaiting an xAPI result | Invalidate the release workflow; expiry must stop and send no CheckOut. |
| 48 | Recovery identifies a new current booking while an old room use check prompt is visible | Start a new lifecycle, clear the old prompt and expiry timer, then evaluate the recovered booking normally. |
| 49 | Prompt display completes after its release workflow is cancelled | Clear the late prompt and do not restore its ownership. If a newer prompt uses the same target, re-display the newer prompt. |
| 50 | Current booking is extended while a room use check prompt is visible | Reclassify the booking; if it becomes long or unclassifiable, preserve it, disable native CheckIn, clear both prompts, cancel the expiry timer, invalidate the release workflow, log suspended booking autocancellation, and ignore the stale expiry callback. |
| 51 | Matching RoomOS CheckIn or successful dry-run simulated CheckIn with Early Departure disabled | Cancel No-Show Release and start no replacement release workflow. |
| 52 | Matching RoomOS CheckIn or successful dry-run simulated CheckIn with Early Departure enabled | Cancel No-Show Release; start Early Departure Release only when the room is confirmed empty. |
| 53 | Occupied booking is confirmed checked in | Do not start Early Departure Release until a later vacancy event; a dry-run simulated confirmation follows the same policy selection once the room becomes empty. |
| 54 | Duplicate matching CheckIn events | Treat them as idempotent confirmations; do not restart or extend the active policy timer. |
| 55 | Stable active booking discovered after restart | Set autocancellation to `Blocked / AwaitingStartupCheckIn`; in production disable native CheckIn, preserve the booking until matching CheckIn confirmation, and retain the same blocked status if the native disable fails. |
| 56 | Occupancy during Early Departure countdown or prompt | Retain prompt; if expiry occurs while occupied, abort release and preserve booking. |
| 57 | Failed production startup native CheckIn disable | Keep startup quarantine asserted, block release, and retry the disable on a later readiness event. |
| 58 | Status event during final startup codec-time read | Revalidate current RoomOS state before scheduling the midnight check or any automatic booking action. |
| 59 | User taps `Check Out` on room use check prompt | Display confirmation guard prompt (`Check out`). If confirmed, issue `Bookings.CheckOut`. If `Cancel` is selected, cancel release and preserve booking. |
| 60 | Prompt timer expires while in unconfirmed Check Out guard | Abort release (`unconfirmed_user_checkout_guard`), clear prompt, and preserve booking. |

## 17. Regression Test Requirements

The primary automated suite is [test_BookingAutoCancellation.js](../test_BookingAutoCancellation.js). It runs the macro in a Node.js VM with mocked xAPI calls and fake timers. It validates macro behavior, not physical sensor accuracy.

The production macro starts automatically unless `AUTO_RELEASE_BOOKING_TEST_MODE` is defined. The VM defines that flag, then calls `init()` explicitly. This keeps the production startup path intact without rewriting the macro's final `init()` call.

The suite covers these availability and timer regressions:

- `FreeUntil` timestamp is never used as current end or CheckIn evidence.
- A timestamp received before `BookedUntil` is rejected until a valid current end arrives.
- Repeated status/timestamp updates leave exactly one active countdown.
- `Free` and `FreeUntil` clear timers and prompts without CheckOut or Delete.
- Exact timeout remaining does not start a release workflow.
- Checkout failure never falls back to Delete.

The suite also covers these lifecycle and safety cases:

1. Startup event during initialization is not overwritten by a stale read and still completes readiness, workflow reconciliation, and midnight health scheduling.
2. Unknown and failed startup presence remain not ready.
3. Failed availability status is not converted to `Free`.
4. Failed or stale timestamp blocks countdown.
5. Every required configuration failure blocks all booking autocancellation.
6. An occupied current-session booking observed after startup schedules macro automatic CheckIn after readiness; an occupied booking discovered during startup remains `Blocked / AwaitingStartupCheckIn`.
7. A matching `CheckedIn` event cancels automatic CheckIn; otherwise the timer triggers exactly one revalidated automatic CheckIn.
8. An empty current-session booking observed after startup starts No-Show Release and cancels any pending automatic CheckIn; an empty booking discovered during startup remains `Blocked / AwaitingStartupCheckIn`.
9. Missing booking ID blocks all booking-changing actions.
10. Failed room use check prompt display preserves the booking at expiry and does not falsely mark a prompt as displayed.
11. Optional sound failure does not disable release, and every production alert applies the configured `AUDIO_ALERT` volume through its configured hold period before restoring `Audio.Volume.SetToDefault`.
12. Repeated events do not create duplicate automatic CheckIn commands or timers.
13. Booking ID change invalidates stale asynchronous reads and commands.
14. Sequential rollover checks in the new occupied meeting without checking out the new meeting.
15. A successful midnight health check preserves an active workflow without duplication.
16. A failed midnight health check cancels countdown and prompt.
17. Local timezone is used for midnight scheduling; unavailable timezone fails closed.
18. Dry-run suppresses automatic CheckIn, CheckOut, and Delete while logging intent; a validated automatic CheckIn may create a dry-run-only confirmation marker for release-policy simulation.
19. Dry run suppresses macro prompt/audio UI and booking commands while enforcing the configured presence pipeline, native CheckIn window, and native CheckIn disable safety baseline.
20. CheckOut is revalidated at room use check prompt expiry and is blocked after a booking lifecycle or status change.
21. A stale room use check prompt expiry timer cannot release a newer meeting.
22. Recovery on a later status event can restore readiness and start exactly one valid workflow after a recoverable configuration, presence, availability, timestamp, or display failure; it cannot create a second automatic CheckIn attempt for the current booking lifecycle.
23. A booking-ID rollover during a visible room use check prompt clears the prior prompt and room use check prompt expiry timer.
24. Desk Pro OSD `Keep Booking` cancels the room use check prompt workflow without a controller Navigator.
25. A Room Scheduler does not receive an actionable room use check prompt.
26. A controller reconnecting during a room use check prompt receives the remaining duration without replacing or extending the room use check prompt expiry timer.
27. Dry-run mode logs simulated prompt and release intent without an actionable room use check prompt surface.
28. Dry-run mode reaches its simulated release decision at `CONFIG.EMPTY_ROOM_TIMEOUT_MS` without adding `CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS`.
29. A dry-run simulated CheckIn marker is cleared on booking rollover and is superseded by a matching real RoomOS `CheckedIn` event.
30. An external `FreeUntil` transition logs `[EXTERNAL_RELEASE_OBSERVED]`, cancels the macro workflow, keeps native CheckIn disabled in dry run, and sends no macro CheckOut.
31. Controller loss after the room use check prompt display blocks CheckOut at the unchanged expiry unless another actionable surface is available.
32. A stale `Keep Booking` response cannot cancel a current countdown or room use check prompt it does not own.
33. `Cannot check in booking that is already checked in.` logs as informational, sends no retry, and does not block later booking release.
34. A non-duplicate CheckIn failure such as `Booking not found` remains an error-level diagnostic.
35. A delayed controller-prompt completion after a mode change cannot restore controller room use check prompt ownership.
36. A connected `TouchPanel` controller is detected from the `ConnectedDevice` status array even when a `RoomScheduler` is also connected.
37. A `ConnectedDevice` status update refreshes controller availability, clears its prompt, and preserves the original expiry timer.
38. A `ConnectedDevice` update that changes only unrelated peripheral telemetry does not re-log, clear, or re-display the controller room use check prompt.
39. A valid `Keep Booking` response received while expiry validation awaits an xAPI result invalidates that release workflow and prevents CheckOut.
40. Recovery finding a different current booking ID clears the prior room use check prompt workflow and prevents its queued expiry from affecting the recovered booking.
41. A prompt display completing after its release workflow is cancelled clears its target and does not restore stale ownership; if the target belongs to a newer prompt, that prompt is re-displayed.
42. An unknown `RoomInUse` event during a visible room use check prompt cancels the workflow and prevents its queued expiry from sending CheckOut.
43. Closing an actionable controller or interactive-OSD room use check prompt without selecting an option restores only that target without extending the current expiry timer.
44. An occupied booking without a valid current end timestamp schedules no automatic CheckIn; a pending automatic CheckIn revalidates that timestamp before command execution.
45. A valid `RoomInUse` event after a failed startup presence read rebuilds the unchanged current booking from RoomOS, restores readiness, and schedules midnight recovery without waiting for another booking event.
46. Recovery observing `Free` or `FreeUntil` during a visible room use check prompt invalidates that workflow so its queued expiry cannot affect a later booking.
47. An unreadable controller inventory at room use check prompt expiry invalidates cached controller prompt ownership and blocks controller-based CheckOut authorization.
48. A pending prompt display cannot delay or extend the fixed room use check prompt expiry timer.
49. A recovery started by an older `RoomInUse = False` event cannot overwrite a newer `RoomInUse = True` event or schedule a release countdown.
50. A status or timestamp event during a pending booking snapshot prevents that stale snapshot from sending CheckIn or CheckOut.
51. A stale CheckOut failure cannot disable booking autocancellation or cancel timers for a newer booking lifecycle.
52. A stale successful configuration validation cannot overwrite a newer configuration failure or restore booking autocancellation.
53. A valid empty-room presence event that restores readiness starts the normal release countdown even when the recovered presence value is unchanged.
54. A verified long current booking disables native CheckIn and receives no macro CheckIn, countdown, prompt, or CheckOut.
55. Failed, invalid, mismatched, or stale booking details disable native CheckIn and preserve the booking.
56. A final booking-details lookup before CheckOut blocks release when the meeting becomes long or cannot be revalidated.
57. End of a long meeting restores native CheckIn; every new booking independently retries long-meeting classification.
58. Extending a short booking while its room use check prompt is visible clears the prompt and expiry workflow when fresh long-meeting classification becomes long or unclassifiable, and logs the booking-autocancellation suspension.
59. A failed production startup native CheckIn disable retains `Blocked / AwaitingStartupCheckIn`, blocks release, and retries on a later readiness event.
60. A status event during the final startup codec-time read prevents stale startup state from scheduling automatic CheckIn, a release workflow, or a midnight health check before current-state recovery completes.
61. A pre-existing short booking enters `Blocked / AwaitingStartupCheckIn` without a transient native CheckIn enable before the required disable write.
62. Vacancy while autocancellation is `Blocked / VerifyingMeetingLength` cannot start a release countdown; a later long or unclassifiable result preserves the booking.
63. A newer native CheckIn enable or disable request waits for an older in-flight request, and the newer requested setting remains applied after both complete.
64. `Allowed / null` requests native CheckIn enabled; `Blocked / VerifyingMeetingLength` makes no native-setting request; other blocked reasons request native CheckIn disabled; only `Allowed / null` permits automatic CheckIn or release.
65. A changed current-booking end time clears `currentBookingStartTime`; if revalidation fails before an external release, the record must not reuse the prior meeting start.

Tests must assert observable behavior: commands sent and their IDs, command counts, timer ownership, prompt display/clear calls, readiness-related blocking, and stale-operation suppression. A test that merely executes a function without asserting the previously unsafe behavior is insufficient.

Run the current suite from the repository root with:

```text
node codec-native/test_BookingAutoCancellation.js
```

## 18. End-to-End Codec Checklist

Run the first pass with `CONFIG.DRY_RUN_MODE: true`. Use a room where an unintended CheckOut is acceptable only after the dry-run results have been reviewed.

### Before Testing

- [ ] Confirm the codec can read `xapi.Status.Time.SystemTime` and its value includes a valid timezone offset.
- [ ] Confirm startup logs show the RoomAnalytics presence settings and CheckIn window duration as configured. In dry run, confirm `Bookings.CheckIn.Enabled` is observed and disabled when necessary.
- [ ] Confirm startup logs `Midnight health check scheduled`.
- [ ] Confirm `RoomInUse` changes between `True` and `False` when the room is occupied and empty.
- [ ] Confirm the room calendar is connected and exposes `FreeUntil`, `BookedUntil`, booking ID, and timestamp status values.
- [ ] Confirm `CONFIG.DRY_RUN_MODE` is `true`.
- [ ] Confirm startup logs `[DRY RUN MODE ACTIVE] RoomAnalytics configured; native Bookings.CheckIn.Enabled disabled; NO macro booking commands or UI.`.
- [ ] Before dry-run startup, record the baseline `Bookings.CheckIn.Enabled` value; confirm dry run disables it when enabled, leaves it unchanged when already `False`, and fails closed if the safety write is rejected.

### Empty-Room Release

- [ ] Create a current-session active booking whose remaining time exceeds the dry-run release horizon (`CONFIG.EMPTY_ROOM_TIMEOUT_MS`) but whose scheduled duration does not exceed `CONFIG.LONG_MEETING_EXEMPTION_THRESHOLD_MS`, so the macro can manage it.
- [ ] For a current-session dry-run flow, let the macro observe the active booking while the room is occupied, allow automatic CheckIn validation to run, then make the room empty. Test startup quarantine separately with a booking already active when the macro starts.
- [ ] Confirm `BookedUntil`, a future booking end timestamp, and a current booking ID are logged.
- [ ] Confirm one `No-Show Release started` log appears before simulated CheckIn, or no replacement workflow after simulated CheckIn when `CONFIG.EARLY_DEPARTURE_RELEASE_ENABLED` is `false`; with it `true`, confirm `Early Departure Release started` after the room becomes empty.
- [ ] Confirm the macro logs `[DRY RUN - WOULD_DISPLAY_PROMPT]` after `CONFIG.EMPTY_ROOM_TIMEOUT_MS - CONFIG.PRE_TIMEOUT_WARNING_MS`; no room use check prompt or sound is displayed.
- [ ] Confirm the dry-run release intent occurs only after `CONFIG.EMPTY_ROOM_TIMEOUT_MS` (without `CONFIG.POST_TIMEOUT_GRACE_PERIOD_MS`).
- [ ] Confirm the dry-run log contains `[DRY RUN - WOULD_RELEASE]` and the correct booking ID.
- [ ] Confirm no real CheckOut occurs while dry run is enabled.

### Room Use Check Prompt Routing

- [ ] In production only, verify controller/OSD prompt routing, reconnect behavior, `Keep Booking` and `Check Out` confirmation guard handling. In dry run, confirm no prompt is displayed or cleared, regardless of controller topology.

### Keep-Booking Paths

- [ ] During the countdown, enter the room or use the local touch panel.
- [ ] Confirm the countdown is cancelled and no room use check prompt appears.
- [ ] In production, when the room use check prompt is visible, select `Keep Booking` and confirm the prompt clears, the periodic alert sound stops, and the expiry timer is cancelled. In dry run, confirm no prompt exists to select.
- [ ] With no room use check prompt visible, submit or reproduce a delayed response for any feedback ID. Confirm the current countdown or room use check prompt remains unchanged and the macro logs that the response was ignored.
- [ ] Cancel the active booking from the calendar during a countdown or visible room use check prompt in production; confirm the prompt and timers clear. In dry run, confirm only internal timers/state are cancelled and no prompt-clear command is sent.

### CheckIn and Rollover

- [ ] Start an active booking while the room is occupied.
- [ ] Confirm the macro logs automatic CheckIn for the current booking after `CONFIG.AUTOMATIC_CHECK_IN_DELAY_MS`, or in dry run logs `[DRY RUN - INTENT_TO_AUTOMATIC_CHECK_IN]` followed by `[DRY RUN - SIMULATED_CHECK_IN]` and sends no CheckIn command.
- [ ] Create an ad hoc booking or manually check in during the grace period. Confirm `CheckIn confirmed: booking {id}` is logged and the macro command is suppressed.
- [ ] Reproduce `Cannot check in booking that is already checked in.`. Confirm it logs as informational and does not retry.
- [ ] Test two back-to-back bookings while the room remains occupied.
- [ ] Confirm the new booking does not receive a CheckOut and independently schedules one automatic CheckIn unless a matching RoomOS event suppresses it.
- [ ] Test a booking-ID rollover while the prior room use check prompt is visible.
- [ ] In production, confirm the old room use check prompt clears. In dry run, confirm the old expiry is cancelled internally without a prompt-clear command, and neither booking is released by the stale expiry.

### Fail-Closed Checks

- [ ] Test with an unavailable or invalid `SystemTime` value.
- [ ] Confirm booking autocancellation is suspended and no countdown starts.
- [ ] Test with a missing booking ID, stale booking end timestamp, or unknown `RoomInUse` value.
- [ ] Confirm no CheckIn intent, release countdown, prompt, or CheckOut occurs.
- [ ] Test one required configuration failure.
- [ ] Confirm booking autocancellation is suspended and the booking is preserved.
- [ ] With `CONFIG.DRY_RUN_MODE: true` and native CheckIn already `False`, confirm RoomAnalytics and CheckIn window settings are configured, `Bookings.CheckIn.Enabled` is only read, no warning prompt or sound is shown or cleared, the warning point logs `[DRY RUN - WOULD_DISPLAY_PROMPT]`, and expiry logs `[DRY RUN - WOULD_RELEASE]` without sending CheckOut.
- [ ] While the third-party solution checks out a booking in Exchange before the macro deadline, confirm the macro logs `[EXTERNAL_RELEASE_OBSERVED]`, then logs `Booking availability status updated: FreeUntil` or `Free`, cancels its timers, and sends no CheckOut or Delete command.

### Production Enablement

- [ ] Review dry-run logs for the correct booking IDs and expected timing.
- [ ] Repeat the empty-room, `Keep Booking`, cancellation, and rollover tests successfully.
- [ ] Set `CONFIG.DRY_RUN_MODE: false` only after the dry-run checks pass.
- [ ] Run one supervised empty-room release and confirm exactly one `Bookings.CheckOut` for the current booking ID.
- [ ] Confirm the room returns to `Free` or `FreeUntil` and no `Bookings.Delete` command is issued.

## 19. Non-Goals and Hardware Verification Limits

The VM suite cannot prove the physical accuracy of ultrasound, head detection, privacy shutters, touch hardware, or RoomOS's internal sensor-fusion algorithm. Those require codec/hardware acceptance testing.

The macro does not replace the calendar service, delete calendar records automatically, or infer a timezone when RoomOS cannot provide one. It also does not use hidden polling to compensate for failed reads or commands.

## 20. Change and Deployment Gate

Changes must map unambiguously to this document and its automated coverage. Any behavior that permits a booking-changing action while a required value is unknown or failed is a specification violation and must be corrected before deployment.
