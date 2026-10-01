# 08: Outbound Long-Polling Ingress Transport & Local Laptop Runner

**What to build:** An engineer working on a corporate laptop can boot the entire service with a single command (`npm run dev`) and connect to the organization's Webex cloud queue via outbound long-polling. The service receives live telemetry and interaction events from physical test rooms without opening any inbound firewall ports or running third-party tunnels, routing events to the matching room actors and coordinating the full autocancellation lifecycle.

**Blocked by:** 03: In-Room User Interaction (Audio Chimes, Prompts & Check Out), 04: Occupancy Interruption & Automatic Check-In, 05: Startup Quarantine, Exemption Engine & Midnight Health Check, 06: Early Departure Release Policy, 07: Webex Workspace Integration Driver Adapter

**Status:** ready-for-agent

- [ ] Outbound long-polling transport establishes a persistent HTTPS listener to the Webex Workspace Integration cloud message queue
- [ ] Telemetry and interaction events arriving on the long-poll connection are dispatched to the corresponding room state machine actor in the room registry
- [ ] The CLI entrypoint initializes the configured transport, loads the Webex adapter, registers active rooms, and begins monitoring
- [ ] The service executes on a corporate development machine behind proxies and firewalls with zero inbound ports and zero local database requirements
- [ ] Graceful process termination cleanly closes the cloud queue listener and tears down active room timers
- [ ] Automated tests verify end-to-end event routing from incoming long-poll notifications through the room actor to outbound mock actions
