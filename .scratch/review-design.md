# Adversarial architecture review: Booking Auto Cancellation Service

**Scope.** I read ServiceMasterSpec (MS), ServiceHighLevelDesign (HLD), ServiceDomainDrivenDesign (DDD), ServiceLowLevelDesign (LLD), Sprint1Spec and the components diagram PDF. No files were edited. Line references are to the current working-tree files.

## Verdict summary

| # | Decision | Verdict | Severity of risk if unchanged |
|---|---|---|---|
| 1 | Single active instance + DynamoDB lease | **Keep**, but harden the lease | Medium |
| 2 | In-memory actor per room, rebuilt from device | **Keep**. Add a startup ramp | High (startup storm) |
| 3 | Long-polling vs webhooks | **Keep** long-polling | Low–Medium |
| 4 | Hexagonal ports/adapters | **Keep**, but reposition the claim (testability, not vendor agnosticism) | Low (board credibility) |
| 5 | DynamoDB for admin state | **Keep** | Low |
| 6 | Kill switch via store + SSM parameter | **Keep** | Low |
| 6b | Tripwire threshold (30 releases per 5 min) | **Change**. It will trip on a normal morning | **High** |
| 7 | SMTP via corporate relay | **Keep** for Phase 1. Add STARTTLS and alarms | Low–Medium |
| 8 | Dashboard on localhost + shared password | **Change** before any LIVE promotion in production | **High** (governance) |
| 9 | Node/TypeScript | **Keep** | Low |
| 10 | Tier 2 sweeper | **Keep but narrow**, and fix the doc conflation | Medium |
| 11 | Restart/failover quarantine | **Keep the semantics**. Add deploy windows, a startup ramp, and clearing of prompts left on screen | **High** if restarts happen during business hours |
| Compute | Fargate (A) or EC2 RHEL 9 + systemd ASG(1) (B) | **Change: pick B and drop A.** Don't present "either" to the board | Medium |

## Compute: containers vs VM (the user's question)

**What the docs say now.** Both options are offered as equals (MS D9 L149–151; HLD §8.2 L436–444; user story 39 L74). Presenting "either" to a Domain Architecture Board reads as an undecided design. Pick one and record the other as a rejected alternative in an ADR.

**Recommendation: Option B, a single EC2 instance in an ASG of size 1 across two AZs, supervised by systemd.** This is not just the user's preference. The workload profile favours it:

1. **Single stateful process with stable identity.** The lease holder ID is the EC2 instance ID, so a process restart re-acquires the lease immediately (LLD §8.5 L1029). A Fargate task gets a new identity on every deploy. It then waits about 30 s for the old lease to expire, which comes on top of the Fargate launch and image pull, typically 30–90 s. HLD §8.2 L440–441 says "instant container startup" and "restarts within seconds" in the same breath as the ~30 s lease wait. That is an overclaim.
2. **The localhost-only dashboard needs a shell-level tunnel.** On EC2, SSM Session Manager port forwarding to `127.0.0.1` is native and logged by IAM/CloudTrail. On Fargate it needs ECS Exec plus port forwarding: possible, but more moving parts.
3. **Restart timing must be controlled** (see §11). On EC2, deploys and patch reboots happen when you schedule them. Fargate can retire tasks for platform patching on AWS's timeline. That is configurable (`fargateTaskRetirementWaitPeriod`), but it is one more thing to govern.
4. **None of the container benefits apply.** There is no horizontal scaling, no bin-packing and no multi-service platform. It is one process with roughly 20 MB of state (MS D3 L108).

**Costs of B that you must own in the design:**
- **OS patching.** Use SSM Patch Manager in an off-hours maintenance window.
- **Hardened AMI.** Use the Suncorp RHEL SOE if one exists. Otherwise Amazon Linux 2023 is simpler; choose based on what the security baseline requires.
- **Endpoint agents.** Prefer `t3.small` or `t3a.small` over `t4g` until the corporate EDR/vulnerability agents are confirmed on ARM (HLD L443 offers both). Use unlimited CPU credits.
- **A defined deploy mechanism.** The docs define none. Use an in-place deploy: a versioned tarball in S3, then an SSM Run Command that does stop → swap → start in the maintenance window. This keeps the instance ID, so the lease is re-acquired immediately. Use ASG instance refresh only for AMI changes.
- **Liveness.** The ASG EC2 health check only sees the instance, and `Restart=always` only catches crashes. A hung event loop or a silently stalled long poll goes undetected. Add a systemd `WatchdogSec` with `sd_notify` from the event loop, plus a CloudWatch alarm on a heartbeat metric and on "no long-poll response in N minutes".

**Rejected alternatives to list in the ADR:**
- **Lambda / Step Functions:** long-lived timers and long polling don't fit.
- **EKS:** heavy for one process.
- **Fargate:** viable but no benefit here, plus a lease-wait penalty on every deploy.

## The question the board will ask first: why centralise at all?

The macro is validated. The service exists to reproduce it with **six documented intentional differences** (LLD §5.14 L872–879), **five pending device tests** (MS D17 L223), and **fleet-wide quarantine on every restart**. None of these exist on the device. The MS problem statement gives three motivators (L9–11):

- **Per-device deployment (point 1)** can be automated through cloud xAPI.
- **Vendor lock-in (point 2)** is speculative. Phase 1 calendar access goes through RoomOS Bookings, and the ports are RoomOS-shaped (see §4).
- **Central controls (point 3)** are the genuine driver, together with email, VIP exemptions and the dashboard.

A credible alternative is a **hybrid: the macro on the device keeps the room-safety logic, and a thin central control plane handles modes, the kill switch, rollout, email and observability.** The CLAUDE.md decision of "no relay macro" rules it out today. It still needs to appear in the ADR with reasons, and the strongest case for the centralised service is fleet controls plus organizer email, not vendor agnosticism.

**My call:** keep the centralised service, but argue it on those grounds. Keep a tiny relay macro, which forwards `Bookings.CheckedIn`, as the documented fallback if DT1 is negative. It would close the one release-side gap (LLD §5.9 L813) and could shorten quarantine.

## 1. Single active instance + DynamoDB lease (keep, harden)

**Reasoning.** 800 rooms is a trivial load. Sharding adds partition ownership and rebalancing, and every rebalance triggers the same quarantine. A warm active/passive standby buys almost nothing. State is rebuilt from the device anyway, so a standby still quarantines everything on takeover; it only shortens the gap from minutes to about 30 s. A passive poller also probably cannot long-poll at the same time. Whether two pollers on one integration compete for messages is **unverified**, and an overlap would split events between instances (LLD §8.5 L1028 only guards commands).

**Defects:**
- **Lease-loss timing.** LLD §8.5 L1030 stops commands "if the lease cannot be renewed before it expires". Webex commands carry no fencing token. If the old holder is paused (GC, VM steal, network partition) past expiry, a new holder takes over, and the old one resumes and sends a CheckOut, you have split-brain. Fix: before every booking-changing command, check a **local monotonic deadline** of last successful renewal + TTL − safety margin (for example, stop at 20 s of a 30 s TTL). Don't rely on noticing a failed renewal. Also stop long-polling, not only commands.
- **Same holder ID on one host.** Two processes on the same host (a manual run, or a systemd overlap) would both "own" the lease. Add a PID/boot-ID suffix check, or a local lock file.

**Risk if unchanged:** Medium. It is rare, but it is the only path where two instances could both act on rooms.

## 2. In-memory actor per room, rebuilt from the device (keep, add a startup ramp)

**Reasoning.** This is correct. It mirrors the macro (LLD §8.1 L979), and persisting timers would resurrect stale workflows. Persisting a checkpoint would not remove quarantine either: check-ins that happen during the downtime are still invisible. The real lever is DT1 (see §11).

**Defect: startup and reconnect storm.** The actor start sequence (LLD §7.2 L938) for each DRY_RUN/LIVE room is:
- configuration `setMany`
- (DRY_RUN) an `Enabled` read and write
- presence read
- availability read
- `Bookings.Get`
- `Time.SystemTime`
- an `Enabled=False` write for every in-progress meeting (LLD §3.2 L428)

That is roughly 5–7 cloud calls × 800 rooms, or about 4–5.6k calls fired together. The Webex rate limit is **unverified** (`.doc/webex-device-apis-developer-guide.md` L153). Bounded readiness recovery totals 7.75 s (LLD §5.3 L688), which is shorter than a plausible `Retry-After` backoff. On exhaustion, a room waits for "the next relevant room event or the midnight health check" (L693). A restart can therefore leave a large fraction of rooms silently blocked.

**Fix:**
- Put a fleet-wide token-bucket limiter in the Webex adapter.
- Bring actors up in waves at a configured rate.
- Don't count time spent queued behind a `429` against the recovery schedule.

**Risk if unchanged:** High. It fails closed, so it is not a safety issue, but it is a serious availability issue.

## 3. Long-polling vs Webex webhooks (keep)

**Reasoning.** Webhooks need a public HTTPS endpoint reachable from the Webex cloud: a public ALB or API Gateway, WAF, certificates, and HMAC verification that the SDK does not perform (`.doc/webex-workspace-integrations-overview.md` L152). Long-polling needs no inbound path (MS D2 L96–102). That is the right call for a private VPC at an APRA-regulated enterprise, and AWS ingress for a cloud callback would be a harder security review.

**Risks to close in the spike:**
1. Delivery semantics (ordering, loss on reconnect, behaviour with competing consumers) are unverified. The design already compensates with revalidation on reconnect (LLD §7.2 L939) and JIT re-reads.
2. Measure event volume and latency at 800 devices before LIVE.
3. The SDK has no stop method and no `429` retry (LLD §9 L1066–1067). Treat the SDK as thin. Be ready to replace it with direct REST calls, since the xAPI REST surface is small.

## 4. Hexagonal ports/adapters (keep, reposition)

**Reasoning.** The value is real. The ports are the test seam for the virtual-clock suite (MS Testing §2 L237–241), and that suite is what makes macro parity provable.

**What's wrong is the claim.** HLD §1 L17 and MS L10 and L27 sell a vendor-agnostic hardware abstraction layer ("future hardware swaps by authoring new driver modules"). The ports carry RoomOS semantics:
- `setNativeCheckInEnabled` / `Bookings.CheckIn.Enabled`, and the rule that CheckOut requires `Enabled=True` (LLD §5.6 L745)
- `TouchPanel`/`Role=Controller`/`RoomScheduler` filtering (HLD §4.2 L155)
- `SystemUnit.Uptime` / `BootEvent` (HLD §4.4 L187–188)
- `FeedbackId` prompt ownership

A Poly or Neat room would need a different calendar path (Graph) and a different safety model. A board will see through "swap the driver".

**Recommendation:**
- Position the architecture as "Webex isolation and deterministic testing; vendor substitution would need a new adapter *and* a policy review".
- Optionally collapse the five room ports into fewer, deeper ones. All five are implemented by one adapter (DDD L94–97).

**Risk:** Low technically; it matters for credibility with the board.

## 5. DynamoDB for admin state (keep)

**Reasoning:**
- About 800 roster items and a low write rate.
- Conditional writes give optimistic locking (LLD §8.4 L1018), and the same item can serve as the lease.
- PITR and deletion protection, reached through a VPC gateway endpoint with no internet path (LLD §8.2 L990).
- IAM can deny update/delete on the audit table.

**Alternatives:**
- **RDS/Aurora:** patching, connection management and cost for about 1 MB of data. Rejected.
- **SSM/AppConfig:** fine for settings, but no conditional writes for roster, audit and lease. Rejected.
- **Local file on EBS:** dies with ASG replacement. Rejected.

**Gaps:**
- Define an audit retention/TTL period and an export to the records system.
- Audit before/after values of `EXEMPT_ORGANIZERS` contain email addresses (PII). This contradicts the "no organizer data stored" statement at LLD L998.
- A store outage longer than the lease halts the fleet (L1030). That is fail-closed and acceptable, but alarm on it.

## 6. Kill switch: store OR SSM parameter (keep)

**Reasoning.** OR-ing two independent sources is correct break-glass design. Activation never waits on persistence; deactivation does (LLD §8.5 L1025–1026). "Never read since startup counts as active" fails closed. A 30 s poll is well inside SSM's throughput limits. No native CheckIn writes on toggle avoids a write storm (LLD §5.8 L785).

**Gaps:**
- The dashboard must show *which* source is active. Otherwise "deactivate" appears not to work while the SSM parameter is still true.
- Write a runbook for who holds IAM rights to the parameter.

## 6b. Tripwire threshold (change: high risk)

A fixed threshold of more than 30 LIVE releases in a sliding 5-minute window (MS D8 L143; HLD §7.3 L390) **will false-trip at fleet scale**:
- Meetings start on the hour, and the LIVE release horizon is about 12 min (MS D12 L176). Legitimate No-Show releases therefore cluster at roughly :12–:14.
- **Estimate** (assumptions, not measured): 800 rooms, about 50% with a meeting starting at 10:00, 20–30% no-show → **80–120 releases in about 2 minutes**.
- Even with 240 rooms LIVE, that is 25–35 releases, which is borderline.

A tripped tripwire persists until an admin resets it (HLD §7.3 L393). The first busy morning at full rollout stops the fleet.

**Fix:**
- Make the threshold relative: releases as a fraction of LIVE rooms with an active booking in the window, or a deviation from a baseline learned from DRY_RUN `WOULD_RELEASE` counts.
- Size the threshold from DRY_RUN evidence before promotion.
- Add a secondary signal, such as a spike in `Unknown` presence or in JIT aborts by reason, which indicates sensor failure better than release count does.

## 7. SMTP via the corporate relay vs Graph/SES (keep for Phase 1)

**Reasoning:**
- It is the corporate standard path to internal mailboxes, needs no app registration, and keeps mail inside the network.
- **Graph `sendMail`** needs an Entra app with the application `Mail.Send` permission, which is tenant-wide unless scoped with an application access policy. That is a heavier security review.
- **SES** sends from outside, needs SPF/DKIM changes for `suncorp.com.au`, and risks external-mail filtering.

**Gaps:**
1. Port 25 is unauthenticated and plaintext (MS D14 L189). Require STARTTLS, even opportunistic, across Direct Connect. Get the relay to allowlist only the service subnet.
2. The "delivered" gate (LLD §5.8 L793) really means **relay accepted (250)**, not inbox delivery. State that explicitly to the board.
3. A relay outage silently stops all releases (fail-closed, correct). Alarm on the `warningEmailFailed` rate.
4. A single Direct Connect / Transit Gateway path is a dependency to document.

## 8. Dashboard on localhost + shared password (change before LIVE in production)

**Reasoning.** It is fine for Sprint 1 on a laptop. In production, a shared password with audit actor `admin` (HLD §7.4 L414–420) means there is no individual accountability for the highest-impact actions:
- promotion to LIVE
- kill-switch deactivation
- tripwire reset
- exemption edits

For an APRA-regulated entity this will likely fail CPS 234 / internal access-control review. "Remote access path in AWS deferred" (L420) is not deferrable either: it is the only way to enroll or promote rooms.

**Recommended target, at minimal cost:**
1. Keep the `127.0.0.1` bind.
2. Reach it through SSM Session Manager port forwarding, with an IAM identity federated from corporate SSO.
3. Add an **app-level OIDC login against Entra ID** (localhost redirect URIs are allowed), with groups mapped to roles: viewer, operator, LIVE approver.

This gives per-user audit without an ALB or any inbound path. An internal ALB with OIDC is the heavier alternative.

**Risk if unchanged:** High for board approval.

## 9. Node/TypeScript (keep)

**Reasoning:**
- The only official Workspace Integration SDK is Node.
- The macro is JavaScript, which makes the port reviewable line by line against `codec-native/BookingAutoCancellation.js`.
- The event loop and timers match the actor model.
- 800 actors is negligible load.

**Risks:**
- SDK maturity: no stop method, no `429` handling (LLD §9).
- Pin a Node LTS version, and own a REST fallback.

Java or C# would match enterprise standards but have no SDK, and would add translation risk against the validated JS.

## 10. Tier 2 sweeper (keep, narrow, fix the docs)

**Conflation.** MS D5 L120 and HLD §6 L350 give Tier 2 the cadence "every 15 minutes **and at codec-local midnight**", and say it "never writes configuration". The midnight health check *does* write configuration (HLD §5.6 L313–315; LLD §5.12 L846). The midnight check is an actor function, not the sweeper. Remove "and at codec-local midnight" from the Tier 2 definitions.

**"Detect and block only" is effectively "detect and immediately repair".** A sweeper block of `RequiredConfigurationsUnavailable` is a transient reason that starts readiness recovery. Recovery re-applies configuration on its first attempt (LLD §5.3 L688–690). State that honestly.

**Risk: a fight with Control Hub configuration templates.** If an admin template sets, say, `Ultrasound=On` and the service enforces `Off` (DDD §3.2 L126), the two will flip-flop every 15 minutes. You need an ownership statement for these xConfig keys, and an exclusion from Control Hub templates.

**Vagueness.** "Orphaned room timers where expected events were lost" (HLD §6 L353) is undefined. Define the exact predicate (for example, a countdown with `BookedUntil` end in the past) or drop it.

**Cost.** 800 configuration reads every 15 min is about 0.9 calls/s, which shares the unverified rate budget with §2.

## 11. Restart/failover behaviour (keep the semantics, control the timing)

**What happens.** Every DRY_RUN/LIVE meeting in progress at restart is quarantined until it ends. Nothing lifts the quarantine early (MS D4 L110–115; LLD §5.9 L809). In LIVE, native check-in is also set to `False` for those meetings (LLD §5.6 L742).

**Impact of a deploy at 10:00** (estimates; assumptions stated):
- With about 60% of 800 rooms booked at 10:00, roughly **480 meetings (60% of the fleet)** go into quarantine.
- The *lost value* is narrower. An eligible empty meeting that started more than about 12 minutes before the restart would already have been released. So the loss is concentrated in meetings that **started within the last release horizon**, plus Early Departure, which is off by default (HLD §5.2 L291).
- **Restart at 10:05:** most of the roughly 340 meetings that started at 10:00 lose No-Show protection. At a 20–30% no-show rate, that is about **70–100 ghost bookings not reclaimed** for that slot. Native RoomOS no-show is also disabled for them.
- **Restart at 10:20:** the loss is close to zero.
- The window is bounded at 120 min per room, because longer meetings are exempt anyway (MS D7 L132).

**Is it acceptable?**
- **On safety: yes.** It only ever preserves bookings.
- **On frequency: only if restarts are rare and scheduled.** The docs define no deploy or patch window anywhere. User story 23 (L58) treats a 2 s restart as harmless; that is true of the process, but not of the fleet.

**Required changes:**
1. **Deploy and patch window policy.** Run outside business hours across Australian time zones. Perth (UTC+8) to Sydney daylight time (UTC+11) is a 3 h spread, so a window like 20:00–06:00 AEDT works. Set the Fargate retirement wait if Option A survives.
2. **A startup ramp** (see §2).
3. **Clear stale prompts on actor start in LIVE.** A prompt from the old process stays on the controller for its full Duration. A user who taps **Check Out** on it gets the response ignored as unmatched (LLD §3.2 L453), so they believe they released the room when they did not. Also restore volume if a restart lands in the 4 s hold.
4. **Make DT1 a formal decision gate.** If the check-in state is readable, a later revision could lift quarantine on a verified `CheckedIn`, as MS L285 already notes. Starting a fresh countdown for a quarantined meeting read as `NotCheckedIn` would be a release-side deviation from the macro. Per CLAUDE.md, that must be flagged to the user, not adopted silently.

**Related inconsistency.** The kill switch withholds native writes to avoid "a fleet-wide configuration write storm" (HLD §7.3 L392; LLD §5.8 L785). Yet **ingress reconnect and lease re-acquire make every actor re-apply its configuration at once** (LLD §7.2 L939, §8.5 L1030, §5.12 L846), with no jitter. A long-poll blip therefore causes exactly that storm. Apply the midnight jitter or the startup ramp here too.

## Internal consistency findings

1. **The components diagram PDF is stale against the DDD mermaid, which CLAUDE.md names as its maintained text version:**
   - It has no Fleet Roster or roster gate, no `IFleetInventoryDriver`, no `IFleetConfigStore`, no DynamoDB, no SSM, no lease.
   - The Admin Dashboard updates only Dynamic Config, while DDD L78–79 also has it changing the roster.
   - The "Webex Event Poller" has no connection to Webex.
   - The Hybrid Calendar arrow runs Workspaces → Exchange, while DDD L106–107 has Exchange → Control Hub → devices.

   Regenerate it before the board.
2. **Tier 2 vs the midnight check:** see §10 (MS L120, HLD L350 vs HLD L313, LLD L846).
3. **The write-storm rationale contradicts the reconnect/lease re-apply:** see §11.
4. **Fargate overclaims:** "instant startup" and "restarts within seconds" vs the 30 s lease wait (HLD §8.2 L440–441).
5. **The "zero OS maintenance" vs "patching" trade-off is never stated.** The HLD lists the benefit for A (L440) but not the operating burden of B. The board needs both sides.
6. **Detection latency:** "Immediately halt" for maintenance or offline rooms (MS user story 15 L50; HLD §7.1 L369) actually relies on the 15-minute inventory sync (LLD §8.3 L1002). It is safe because JIT re-reads fail closed, but "immediately" is inaccurate.
7. **Vendor-agnostic hardware abstraction (HLD L17) vs RoomOS-specific port contracts:** see §4.
8. **PII:** "no organizer data stored" (LLD L998) vs audit before/after values of `EXEMPT_ORGANIZERS` (LLD §8.1 L982).
9. **The tripwire (MS L143, HLD L390) has no sizing rationale** against fleet-scale baseline release volume (see §6b).
10. **Pending-items folder:** Sprint1Spec L234 references `.scratch/codec-tests.md`, and `.scratch/` already exists with `README.md`, `codec-tests.md` and `pending.md`. Use it for these items.

## Pending items for `.scratch/pending.md`

- [ ] **ADR: compute.** Choose EC2 RHEL 9 + systemd ASG(1); reject Fargate, EKS and Lambda with reasons.
- [ ] **ADR: centralised service vs the macro + control-plane hybrid.** Keep a relay macro as the fallback if DT1 is negative.
- [ ] **Deploy and patch window policy.** Off-hours across AU time zones. In-place SSM Run Command deploy.
- [ ] **Fleet-wide token-bucket limiter and startup/reconnect ramp.** Recovery must not exhaust while waiting on `429`s.
- [ ] **Measure Webex rate limits and long-poll semantics** (competing consumers, ordering, latency) at 800 devices.
- [ ] **Lease hardening.** A local monotonic safe deadline before every booking command; stop polling on lease loss; single-process guard per host.
- [ ] **Redesign the tripwire threshold.** Relative or baseline-derived, sized from DRY_RUN data.
- [ ] **Production dashboard access.** SSM port forwarding plus Entra OIDC with roles. Treat it as a blocker for the first production LIVE promotion.
- [ ] **SMTP.** STARTTLS, a relay allowlist, alarms on `warningEmailFailed`, and the "accepted by relay" wording.
- [ ] **Liveness.** systemd watchdog, heartbeat metric, long-poll stall alarm.
- [ ] **Clear stale prompts and restore volume on actor start (LIVE).**
- [ ] **xConfig key ownership vs Control Hub configuration templates.**
- [ ] **Audit retention/TTL; PII in audit records.**
- [ ] **Docs:** regenerate the components diagram; fix the Tier 2/midnight conflation; remove Fargate overclaims; reword the HAL claim; reword "immediately halt".