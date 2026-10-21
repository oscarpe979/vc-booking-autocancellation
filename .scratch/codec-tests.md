# Codec device spike

Run on one codec with booking enabled and `Bookings.CheckIn.Enabled = True`. SSH, then `xPreferences OutputMode JSON`. Save every output verbatim.

## DT1: Can a booking's check-in state be read? (decides item 2)

1. Create a calendar booking starting in a few minutes. Keep the room empty so RoomOS does not check it in natively.
2. Capture before check-in:
   - `xCommand Bookings List Days: 1 DayOffset: 0`
   - `xCommand Bookings Get Id: "<bookingId>"`
   - `xStatus Bookings`
3. `xFeedback Register /Event/Bookings` to watch events.
4. Tap Check In on the Navigator (scheduler panel outside the door if available). Expect a `CheckedIn` event.
5. Run step 2 again and diff. Any changed field is the signal.
6. Repeat with the other check-in paths: native people-count check-in (stay in the room a minute), `xCommand Bookings CheckIn Id: "<bookingId>"`, and an ad hoc booking made on the Navigator.
7. Through the cloud (the service's path; token with `spark:xapi_commands`, `spark:xapi_statuses`):
   - `POST https://webexapis.com/v1/xapi/command/Bookings.Get` with `{"deviceId": "<deviceId>", "arguments": {"Id": "<bookingId>"}}`
   - `GET https://webexapis.com/v1/xapi/status?deviceId=<deviceId>&name=Bookings.*`

Outcome:
- Field exists: the service reads it when an empty room would start a No-Show countdown and as a JIT check before No-Show CheckOut (LLD §5.9). Update LLD §5.5, §5.9, §9, tickets 02/05/07, manifest.
- No field: accept the documented residual gap (LLD §5.9); the warning email stays informational (LLD §6.2).

## DT2: "Already checked in" error text

Run `xCommand Bookings CheckIn Id: "<bookingId>"` twice on the same booking, over SSH and through the cloud. Paste the exact second-call error from both. The adapter classifies `AlreadyCheckedIn` from it (ticket 07).

## DT3: Controller prompt with no controller

With no Navigator in controller mode: `xCommand UserInterface Message Prompt Display Target: Controller Text: "test" Duration: 30`. Record whether it errors or succeeds, and whether the `UserInterface.Message.Prompt.Display` event fires.

## DT4: Reboot detection

`xStatus SystemUnit Uptime`, then `xCommand SystemUnit Boot`, then `xStatus SystemUnit Uptime` again once it is back. Through the cloud, note when the subscribable `BootEvent` arrives relative to the reboot.

## DT5: Navigator reboot mid-prompt

Display a Controller prompt, reboot or unplug the Navigator, and record whether `UserInterface.Message.Prompt.Cleared` fires and what `Peripherals.ConnectedDevice` reports during and after.
