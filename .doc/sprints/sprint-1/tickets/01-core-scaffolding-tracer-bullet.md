# 01: Core Scaffolding & End-to-End Tracer Bullet

**What to build:** An engineer can boot a minimal local Node.js/TypeScript service that loads configuration, initializes an in-memory room registry, registers a test room, transitions the room from idle to actively tracking an eligible scheduled meeting, and cleanly shuts down. This establishes the project's foundation and proves the Hexagonal architecture with a passing end-to-end tracer bullet test.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] TypeScript service environment compiles cleanly and executes unit tests via a single test command
- [ ] Service configuration loads strongly typed settings from local environment variables, with defaults for empty-room timeouts, warning durations, grace periods, execution modes, and corporate SMTP parameters (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_SECURE`, `NOTIFICATIONS_ENABLED`)
- [ ] Hexagonal driver interfaces exist for presence detection, user interaction, calendar operations, device configuration enforcement, and email notifications (`INotificationDriver`)
- [ ] An in-memory room registry instantiates and manages the lifecycle of room actors
- [ ] An end-to-end test passes demonstrating a room actor initializing in an idle state, receiving an active booking event, transitioning to active monitoring, and tearing down cleanly without errors
