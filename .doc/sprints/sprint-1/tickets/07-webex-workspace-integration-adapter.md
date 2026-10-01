# 07: Webex Workspace Integration Driver Adapter

**What to build:** An engineer can bind the domain engine to real Cisco collaboration devices using Webex Workspace Integrations. The adapter fulfills the Hexagonal contracts (IRoomPresenceDriver, IRoomInteractionDriver, ICalendarConnector, and IDeviceConfigDriver) via the official Webex SDK, translating xStatus queries, xCommands, xConfigs, and xEvents to and from domain representations, enforcing device baseline configurations, and serializing native check-in toggles.

**Blocked by:** 01: Core Scaffolding & End-to-End Tracer Bullet

**Status:** ready-for-agent

- [ ] Webex integration initializes and manages machine account access tokens using OAuth credentials and activation tokens
- [ ] Presence queries and change notifications map accurately to and from RoomAnalytics.RoomInUse
- [ ] Calendar availability queries map to and from Bookings.Availability.Status and Bookings.Current.Id
- [ ] Check-in and check-out requests map to xCommand Bookings.CheckIn and xCommand Bookings.CheckOut
- [ ] Warning and confirmation prompts map to xCommand UserInterface.Message.Prompt.Display and xCommand UserInterface.Message.Prompt.Clear
- [ ] Audio alert chimes and volume restoration map to xCommand Audio.Volume.Set, Audio.Sound.Play, and Audio.Volume.SetToDefault
- [ ] User prompt responses (UserInterface.Message.Prompt.Response) and check-in events (Bookings.CheckedIn) are parsed and dispatched to domain handlers
- [ ] Actionable surface checks inspect Peripherals.ConnectedDevice and SystemUnit.ProductPlatform to authorize prompts only on supported touch controllers or interactive displays, strictly filtering out external room panels (RoomScheduler)
- [ ] Baseline presence configuration enforcement sets RoomAnalytics presence, ultrasound, and head detection settings
- [ ] Enforces Bookings.CheckIn.WindowDuration: 60 to prevent native room no-show timers from racing ahead of service release
- [ ] Implements a FIFO serialization queue for writing Bookings.CheckIn.Enabled (setting False for exempt/long meetings and restoring True when the meeting ends or room is free)
- [ ] Automated integration tests verify message mapping and command serialization against sample Webex payload fixtures
