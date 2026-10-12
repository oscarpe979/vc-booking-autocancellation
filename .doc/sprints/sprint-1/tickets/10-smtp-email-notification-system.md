# 10: Corporate SMTP Email Notification Engine & Template System

**What to build:** An outbound email notification engine decoupling message delivery behind a Hexagonal `INotificationDriver` domain port. The adapter layer implements `SmtpNotificationAdapter` connecting to corporate internal smart hosts (default: `outlook.suncorp.com.au:25` as an unauthenticated direct relay) and `MockNotificationDriver` for zero-dependency local laptop development with rich terminal logging and in-memory capture. When the in-room countdown prompt displays, the service dispatches an urgent warning email to the meeting organizer, dynamically calculating remaining countdown minutes from `PRE_TIMEOUT_WARNING_MS` and displaying the scheduled release time in the codec-local clock timezone. The service enforces a strict fail-closed safety invariant: if the warning email cannot be verified sent after immediate retries, the cancellation is aborted and the booking is preserved. A single-warning invariant ensures prompt dismissals and re-displays (`restoreDismissedPrompt`) never trigger duplicate emails. Upon successful room release, the service dispatches a differentiated cancellation receipt explicitly distinguishing No-Show Release from Early Departure Release. In dry-run and monitor-only modes, real emails are suppressed and structured `[DRY RUN - WOULD_SEND_EMAIL]` logs are emitted. SMTP configuration (`SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM`, `SMTP_SECURE`, `NOTIFICATIONS_ENABLED`) is manageable at runtime from the `/admin` dashboard.

**Blocked by:** 01: Core Scaffolding & End-to-End Tracer Bullet

**Status:** ready-for-agent

- [ ] `INotificationDriver` domain port interface defined with `sendCancellationWarning(payload)` and `sendCancellationNotice(payload)` methods
- [ ] `SmtpNotificationAdapter` implemented using standard Node.js nodemailer/SMTP transport connecting to `outlook.suncorp.com.au:25` by default with unauthenticated direct relay support
- [ ] `MockNotificationDriver` implemented for local laptop development, logging formatted email previews to console and storing sent messages in memory for test assertions
- [ ] Dynamic duration calculation in warning email derived from `PRE_TIMEOUT_WARNING_MS` (never hardcoded 5 minutes) and formatted with the room's codec-local clock timezone
- [ ] Fail-closed safety precondition: if `sendCancellationWarning` fails after immediate bounded retries, the room workflow aborts the release sequence and preserves the booking
- [ ] Single-warning-per-booking guard: subsequent prompt restorations or repeated in-room warnings within the same booking lifecycle do not dispatch duplicate warning emails
- [ ] Differentiated cancellation receipts: dispatches context-specific cancellation receipts to the organizer distinguishing No-Show Release (unoccupied after meeting start) from Early Departure Release (vacated before scheduled end time)
- [ ] Responsive multipart MIME email templates (HTML with corporate layout, meeting subject, room name, and clear action guidance, plus synchronized plain-text fallback)
- [ ] Dry-run and monitor-only safety: physical SMTP delivery is suppressed for rooms in `DRY_RUN` or `MONITOR_ONLY` mode, emitting structured `[DRY RUN - WOULD_SEND_EMAIL]` logs
- [ ] Dynamic configuration support: SMTP host, port, sender email, TLS toggle, and global notifications toggle exposed for runtime inspection and modification via the `/admin` dashboard without restarting the service
- [ ] Automated tests verify warning email dispatch, dynamic duration calculation, single warning deduplication, fail-closed release abort on SMTP failure, differentiated cancellation receipts, and dry-run suppression using virtualized clocks and mock notification drivers
