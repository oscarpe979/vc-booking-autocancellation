# Pending items

Last updated: 2026-10-17. Details for the architecture items: `architecture-review.md` (synthesis), `review-board.md`, `review-design.md`, `review-hosting-options.json`.

## Blocked on the codec spike (`codec-tests.md`)

- [ ] **DT1 check-in state readable?** Decides between the read (LLD §5.9 check 12) and the documented residual gap (LLD §5.14 last row). Update LLD §2.2/§5.5/§5.9/§5.14/§6.2/§9, tickets 02/05/07/10, manifest.
- [ ] **DT2 already-checked-in error text** (SSH and cloud). Pin the adapter classifier constant (ticket 07).
- [ ] **DT3 controller prompt with no controller.**
- [ ] **DT4 uptime across reboot, BootEvent timing.**
- [ ] **DT5 Navigator reboot mid-prompt.**
- [ ] Add to the spike: long-poll delivery semantics with two consumers on one integration; does the Webex refresh token rotate?

## Decisions waiting on the user

- [ ] Confirm with the Suncorp platform team (OS decided: RHEL 9, user 2026-10-17): standard RHEL 9 server build and agents (SSM Agent is not in AWS RHEL images), RHEL licensing, that patch reboots can be scheduled outside business hours, and shared VPC endpoints / central egress to Webex.
- [ ] Load test one process with 800 actors plus the security agents to confirm the instance size.
- [ ] Tripwire threshold: relative to LIVE rooms with active bookings, sized from DRY_RUN data, instead of a fixed 30 per 5 min.
- [ ] Move SMTP connection settings (host, from, port, TLS) out of the dashboard into SSM/Terraform.

- [ ] **Confirm with the Dynatrace admin** (alerting design, LLD §7.3): is OneAgent installed on (or mandated for) the instance, in Infrastructure or Full-Stack mode, version 1.243+? Are the Extension Execution Controller and the local HTTP metric ingest API enabled (test on the host: `curl -X POST -H 'Content-Type: text/plain; charset=utf-8' --data 'test.probe gauge,1' http://localhost:14499/metrics/ingest`)? SaaS or Managed? Is `PROCESS_RESTART` still classified critical? How often is a process availability rule evaluated? Who owns the metric events, alerting profile and maintenance windows? Is OneAgent egress (tenant or ActiveGate) in the network design?
- [ ] Runbook: rebuild the server after an Availability Zone outage (no Auto Scaling Group, by decision 2026-10-19).

## Design changes recommended by the review (not yet applied)

- [ ] LLD §8.5 lease: acquire before SDK `connect()`; local fencing deadline before every booking-changing command; delete lease on SIGTERM; per-host `flock`.
- [ ] Fleet-wide Webex rate limiter (token bucket) and jittered waves on start, reconnect and lease re-acquire; 429 waits do not count against readiness recovery.
- [ ] Actor start in LIVE clears stale prompts and restores volume.
- [ ] Tier 2 sweeper: drop "and at codec-local midnight" (midnight belongs to the actor); define the orphaned-timer predicate; state which xConfig keys the service owns so Control Hub templates exclude them.
- [ ] Remove overclaims: "vendor-agnostic HAL", Fargate "instant startup", "immediately halt" (depends on the 15-min inventory sync).
- [ ] Data: fix "no organizer data stored" (audit of `EXEMPT_ORGANIZERS` holds emails); audit retention; log field allow-list.
- [ ] Guardrails (min/max, change reference) on safety-relevant settings.
- [ ] Regenerate the components diagram PDF from the DDD mermaid.

## Domain Architecture Board pack (`architecture-review.md` §3–§4)

- [ ] **Blockers:** ADR-001..009; NFR section (availability target, RTO/RPO, release latency budget, zero false releases); production admin access + identity; STRIDE threat model (stolen integration credentials = org-wide device write); network egress design (Webex allow-list, TCP 25 STARTTLS over DX/TGW).
- [ ] **Majors:** Webex call budget at 800 rooms + load test; per-environment integrations; failure-modes table (note native RoomOS no-show release keeps running while the service is down); data classification/privacy; SLOs/alarms/SIEM; runbooks and ownership; credential lifecycle; test strategy (lab E2E, soak, chaos, DRY_RUN exit criteria); CI/CD and deploy windows.
- [ ] **Minors:** DR statement; cost; lock-in statement; NTP assumption; Suncorp standards conformance; employee comms.
- [ ] Diagrams: C4 context, C4 container, deployment, no-show release sequence, restart/failover sequence.

## Deferred by decision

- [ ] **Alerting beyond the first release (user 2026-10-21: keep it tight; review later).** First release = `/healthz` core codes pushed to the local OneAgent; Dynatrace raises the alerts (LLD §7.3). Deferred:
  - An external probe of `/healthz` (Dynatrace synthetic monitor from a private ActiveGate) to catch the service reporting `ok` while broken. Needs `/healthz` on the private IP plus an inbound rule.
  - Extra codes: `WEBEX_EVENTS_SILENT` (connected but no events), `ROOMS_BLOCKED_BY_FAULT` (e.g. revoked Webex scopes block most rooms while healthz says ok), `DEVICE_COMMANDS_FAILING`, `INVENTORY_SYNC_STALE`, `ROOMS_NEED_ATTENTION`.
- [ ] **SSO (user: later, nothing raised yet).** Entra ID OIDC with app roles Viewer / Operator / LiveApprover and the audit actor = username. Code is ~3-5 days (MSAL Node, certificate credential); the slow part is the identity team (app registration, groups, conditional access), typically weeks. Recommended as a gate before the first production LIVE room. Until then: 127.0.0.1 dashboard + shared password, reached by SSM port forwarding.

- [ ] Tripwire rate detection (Sprint 2).
- [ ] `DynamoFleetConfigStore`, DynamoDB lease and Terraform tables (Sprint 2).
- [ ] Raise with Cisco: add `Bookings.CheckedIn` to the Workspace Integration supported subscriptions.
