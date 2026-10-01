# Booking Auto Cancellation User Manual

## Purpose

Booking Auto Cancellation manages the RoomOS **current booking** for a room. It is designed to recover unused booked time without releasing a booking unless RoomOS, calendar state, and the macro's safeguards all agree that doing so is safe.

The macro can:

- Automatically check in a qualifying occupied booking.
- Warn occupants before an eligible empty booking is released.
- Automatically check out an eligible empty booking after the warning expires.
- Optionally monitor a checked-in meeting for early departure.

The macro never deletes calendar records. It uses `Bookings.CheckOut` for release and preserves the booking whenever it cannot confirm safety.

This manual is for room-service operators, support teams, macro deployers, and change approvers. It explains how to configure, deploy, observe, and operate the subsystem. For exact implementation rules, state transitions, and test obligations, use [BookingAutoCancellationSpec.md](BookingAutoCancellationSpec.md).

## What The Macro Does

| Room condition | Booking condition | Macro behavior |
| --- | --- | --- |
| Occupied | Current qualifying booking first observed after startup | Wait for the configured automatic-CheckIn delay, then check in once if the booking is still current and valid. |
| Empty | Current qualifying booking without CheckIn confirmation | Start the No-Show Release workflow. |
| Empty after confirmed CheckIn | Early Departure Release enabled | Start the Early Departure Release workflow. |
| Empty after confirmed CheckIn | Early Departure Release disabled | Preserve the booking; no release workflow runs. |
| Occupied during the pre-warning countdown | Qualifying current booking | Cancel release and schedule automatic CheckIn when appropriate. |
| Occupied during a visible production warning | Qualifying current booking | Keep the warning visible. Automatic release is prevented at expiry and the booking is preserved. |
| Any required state is unknown, stale, invalid, or unavailable | Any | Preserve the booking and suspend automatic actions. |

An active booking discovered when the macro starts is intentionally quarantined until RoomOS sends a matching `Bookings.CheckedIn` event. Restarting the macro must not turn an already-running meeting into a no-show candidate.

## Preconditions

Before production deployment, verify that the room and its RoomOS configuration can provide the following:

- Calendar booking availability, current booking ID, and availability timestamp.
- A valid codec local time including timezone offset through `Time.SystemTime`.
- `RoomAnalytics.RoomInUse` values of `True` and `False` for normal occupied and empty room states.
- Permission for the macro to configure RoomAnalytics settings and `Bookings.CheckIn` settings.
- A configured calendar integration that exposes active `BookedUntil` bookings.
- At least one actionable production warning surface when automatic CheckOut is required: a controller-mode TouchPanel Navigator or a supported interactive OSD. Informational OSD prompts alone do not authorize automatic CheckOut.

The macro writes the required RoomAnalytics settings and the RoomOS CheckIn window at startup. If any required configuration write is rejected, the macro fails closed and does not perform automatic booking actions.

## Configuration

Update `CONFIG` in [BookingAutoCancellation.js](BookingAutoCancellation.js) through the approved source-control and deployment process. Treat these values as room policy, not implementation constants.

| Setting | Operational purpose | Configuration rule |
| --- | --- | --- |
| `EMPTY_ROOM_TIMEOUT_MS` | Base duration of confirmed vacancy before release validation. | Must suit the room's intended no-show policy. |
| `PRE_TIMEOUT_WARNING_MS` | Portion of the base timeout reserved for the warning prompt. | Keep it no greater than `EMPTY_ROOM_TIMEOUT_MS`. |
| `POST_TIMEOUT_GRACE_PERIOD_MS` | Additional live-mode grace after the base timeout. | Production only; dry run omits it. |
| `LONG_MEETING_EXEMPTION_THRESHOLD_MS` | Exempts verified meetings longer than this duration. | Set to `0` to disable the exemption; otherwise use a finite non-negative value. |
| `NATIVE_CHECK_IN_WINDOW_MINUTES` | RoomOS native no-show window. | Must be positive and longer than the macro's effective release horizon. |
| `ULTRASOUND_SENSOR_ENABLED` | Includes ultrasound in RoomOS presence fusion. | Enable only after room-specific hardware validation. |
| `EARLY_DEPARTURE_RELEASE_ENABLED` | Enables release after a confirmed CheckIn followed by vacancy. | Enable only after the room's business policy approves early-departure release. |
| `AUTOMATIC_CHECK_IN_DELAY_MS` | Waits for a native or user CheckIn event before one macro CheckIn attempt. | Keep long enough to avoid racing normal CheckIn behavior. |
| `BOOKING_READINESS_RECOVERY_DELAYS_MS` | Bounds retries for transient readiness failures. | Use finite, non-negative delays; this is not continuous polling. |
| `BOOKING_SYNC_COALESCE_DELAY_MS` | Coalesces paired booking status and timestamp events. | Keep sufficient to absorb expected RoomOS event bursts. |
| `DRY_RUN_MODE` | Selects observation-only booking behavior. | Must be `true` for the initial deployment validation. |
| `DEBUG` | Enables routine diagnostic logs. | Keep enabled during rollout and incident investigation. |

### Timing Model

Let $T$ be `EMPTY_ROOM_TIMEOUT_MS`, $W$ be `PRE_TIMEOUT_WARNING_MS`, and $G$ be `POST_TIMEOUT_GRACE_PERIOD_MS`.

In production:

- The warning begins after $T - W$ of confirmed vacancy.
- The warning remains eligible for $W + G$.
- Automatic CheckOut validation starts at $T + G$.
- The booking must have more than $T + G$ remaining before a release workflow can start.

In dry run, $G$ is omitted. The simulated warning begins at the same point and the simulated release decision begins at $T$.

## Production Prompt And User Actions

When a production room reaches the warning stage, the macro displays **Keep this booking?**.

- A controller-mode Navigator receives actionable `Keep Booking` and `Check Out` options.
- A supported interactive OSD can also be actionable.
- A normal room-codec OSD is informational and directs users to the touch controller.
- A Room Scheduler is never treated as an actionable controller.

### Keep Booking

`Keep Booking` clears the warning, preserves the booking, and rechecks RoomOS presence.

- If the room is still empty and the booking remains eligible, the macro starts a fresh countdown. A later warning uses the repeated wording.
- If the room is occupied, the macro follows the normal automatic-CheckIn policy.
- If presence cannot be revalidated, automatic actions remain suspended.

### Check Out

`Check Out` opens a confirmation prompt. The operator or occupant must select `Check out` again before the macro issues `Bookings.CheckOut`.

- Selecting `Cancel` is treated as keeping the booking.
- If the confirmation expires without a decision, no CheckOut is issued.
- For an empty room, the original warning is restored with a new full warning duration.
- For an occupied or unverified room, the booking is preserved and no warning is restored.

## Dry-Run Operation

Dry run is mandatory for initial rollout and should be used whenever timing, sensor, or policy configuration changes.

Dry run does **not** send `Bookings.CheckIn`, `Bookings.CheckOut`, or `Bookings.Delete`. It also does not display or clear the macro's prompts or play alert sounds.

Dry run is not non-invasive. It still:

- Configures the RoomAnalytics presence pipeline.
- Configures `Bookings.CheckIn.WindowDuration`.
- Reads `Bookings.CheckIn.Enabled` and sets it to `False` when necessary to suppress the native no-show path.
- Performs the same booking identity, presence, timing, and final release validation as production.
- Logs simulated CheckIn, prompt, and CheckOut intent.

Before starting dry run, record the existing native `Bookings.CheckIn.Enabled` state. The macro must leave an already-disabled value unchanged, disable an enabled value, and fail closed if it cannot enforce the disabled safety state.

## Deployment And Rollout Procedure

1. Review the proposed `CONFIG` values against the timing model and the room's business policy.
2. Confirm the preconditions, especially RoomAnalytics support, calendar state, codec timezone, and warning-surface availability.
3. Deploy with `DRY_RUN_MODE: true` using the approved RoomOS macro deployment process.
4. Observe a real or controlled current-session booking. Confirm that startup configuration, presence transitions, booking identity, and scheduled timing are logged.
5. Confirm dry-run markers show the expected booking ID and that no booking command or prompt/audio command is sent by the macro.
6. Test occupancy during the countdown, prompt routing, external release, booking rollover, and unknown-presence behavior.
7. Review the logs and outcomes with the service owner. Resolve any safety, sensor, calendar, or configuration failures before enabling production mode.
8. Change `DRY_RUN_MODE` to `false`, deploy through the approved change process, and perform one supervised empty-room release.
9. Confirm one `Bookings.CheckOut` is issued for the intended current booking ID and no `Bookings.Delete` command occurs.

## Monitoring And Support

All macro messages have the `[BookingAutoCancellation]` prefix. The main operational signals are:

| Signal | Meaning | Operator action |
| --- | --- | --- |
| `[DRY RUN MODE ACTIVE]` | The macro is in observation mode. | Confirm this is intentional during rollout; no real booking command should follow. |
| `[DRY RUN - INTENT_TO_AUTOMATIC_CHECK_IN]` | A valid occupied booking would be checked in. | Verify booking identity and presence are expected. |
| `[DRY RUN - SIMULATED_CHECK_IN]` | Dry run recorded a local confirmation for policy evaluation. | This is not a RoomOS CheckIn event or a booking change. |
| `[DRY RUN - WOULD_DISPLAY_PROMPT]` | The simulated warning point was reached. | Verify it occurred at the expected configured time. |
| `[DRY RUN - WOULD_RELEASE]` | All dry-run release checks passed. | Compare the booking ID and timing with the expected booking. |
| `[EXTERNAL_RELEASE_OBSERVED]` | RoomOS reported a booking release not attributed to a pending macro CheckOut. | Confirm the calendar or external automation action; the macro sends no follow-up release. |
| `Booking autocancellation is suspended` | A required safety condition is not healthy. | Investigate the immediately preceding configuration, presence, availability, timestamp, timezone, or booking-identity error. |
| `Checkout failed or not permitted` | RoomOS rejected a macro CheckOut. | The current booking is preserved and automatic booking actions are blocked for that lifecycle. Investigate calendar and RoomOS authorization. |

Routine diagnostics use `console.debug` when `DEBUG` is enabled. Warnings and errors identify safety, configuration, or command failures. Checkout comparison records carry structured context including booking ID, source, mode, and outcome.

## Troubleshooting

| Symptom | Likely cause | Required response |
| --- | --- | --- |
| No countdown starts for an empty booking. | The booking is too close to its end, is long/unclassifiable, is in startup quarantine, or a required value is unavailable. | Inspect readiness logs and verify booking ID, future end time, presence, configuration health, and remaining time. |
| The macro does not release a booking after a visible warning. | No actionable surface was confirmed, occupancy was detected, the booking changed, or final validation failed. | Preserve the booking. Check controller/OSD availability, `RoomInUse`, and final validation logs. |
| Prompt appears on OSD but no action is possible. | The OSD is informational on this platform. | Use a controller-mode Navigator, or validate that the device is a supported interactive OSD. |
| Native CheckIn remains disabled. | The booking is long, unclassifiable, in startup quarantine, or the macro could not apply a required native setting. | Review the current booking policy and native-setting logs. Do not manually enable it until the active booking state is understood. |
| Dry run seems to change device behavior. | Dry run configures presence and disables native CheckIn as a safety baseline. | This is expected. Confirm it is operating under the approved rollout plan. |
| Booking commands are blocked after a failed CheckOut. | The macro marks the current lifecycle `CheckOutFailed`. | Resolve the RoomOS/calendar failure. A later booking lifecycle is evaluated independently. |
| Presence becomes unknown. | RoomAnalytics status is unavailable, malformed, or failed. | Confirm sensor support and RoomOS health. The macro must remain fail closed until a fresh valid presence read succeeds. |

## Operating Limits

- The macro manages only the current booking. It does not manage future bookings or calendar records directly.
- The macro depends on RoomOS `RoomInUse`; it does not implement its own sensor-fusion algorithm.
- The macro does not determine physical sensor accuracy. Hardware validation is required for head detection, ultrasound, privacy shutters, touch hardware, and room layout.
- The macro does not override independent calendar or third-party automation. It observes external releases through RoomOS availability changes.
- The macro does not infer a timezone when the codec cannot provide one.
- The macro stores workflow state in memory. A restart is intentionally conservative and triggers startup quarantine for an already-active booking.

## Related Documents

- [BookingAutoCancellationHighLevelDesign.md](BookingAutoCancellationHighLevelDesign.md): governance-oriented architecture, boundaries, risks, and workflow design.
- [BookingAutoCancellationSpec.md](BookingAutoCancellationSpec.md): detailed technical contract, edge cases, and test requirements.
- [test_BookingAutoCancellation.js](test_BookingAutoCancellation.js): executable behavior contract.
