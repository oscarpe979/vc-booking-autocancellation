> Generated 2026-10-17 by the architecture review workflow. Working notes, not a reviewed document. Estimates are marked as such.

# Booking Auto Cancellation Service: hosting and architecture recommendation for the Domain Architecture Board

**Sources checked.** I checked every claim below against the working-tree docs:
- `service/docs/ServiceHighLevelDesign.md` (HLD)
- `service/docs/ServiceLowLevelDesign.md` (LLD)
- `service/docs/ServiceMasterSpec.md` (MS)
- `.doc/sprints/sprint-1/Sprint1Spec.md` (S1)
- `.scratch/pending.md`

I did not render `.doc/Autocancellation Components Diagram.pdf` myself. The finding below that it is out of date comes from the design critique and has not been verified.

---

## 1. Hosting recommendation

### 1.1 Decision

**Recommendation: one EC2 instance, with no containers, in an Auto Scaling Group fixed at one instance across two Availability Zones. `systemd` supervises the Node process. The instance runs Suncorp's standard AWS server image (Amazon Linux 2023 if no image is mandated). Fargate is the documented fallback, not a co-equal option.**

### 1.2 Weights

| Criterion | Weight | Why this weight |
|---|---|---|
| Safety and correctness | 25 | This is the governing rule. In practice hosting barely changes it: every option fails closed. It mainly penalises designs that rebuild the validated macro logic in new distributed form. |
| Availability and restart control | 20 | Each restart puts every in-progress meeting fleet-wide into quarantine until it ends (MS story 24 L59; LLD §5.9, §8.1 L979). Who decides *when* the process restarts directly decides how much value the service delivers. |
| Security and compliance | 15 | Suncorp is APRA-regulated (CPS 234). The board will look hardest at inbound exposure, identity and secrets. |
| Operational simplicity | 15 | Patching, deploys and drift. |
| Team skill fit | 10 | The team has validated skill in a single-process event loop, and the user prefers not to use containers. |
| Dashboard access path | 10 | This is currently a deferred blocker (HLD §7.4 L420). |
| Cost | 5 | Every viable option costs under AUD 100/month before networking, so cost does not separate them. |

### 1.3 Scores (1 to 5, weighted to 100)

| Option | Safety | Availability / restart control | Security | Ops | Team | Dashboard | Cost | **Score** |
|---|---|---|---|---|---|---|---|---|
| **B: EC2 + systemd, ASG(1)** | 5 | 4 | 4 | 3 | 4 | 5 | 4 | **84** |
| A: ECS Fargate, single task | 5 | 3 | 4 | 4 | 2 | 3 | 4 | 75 |
| C: On-prem VMware RHEL VM | 4 | 3 | 4 | 2 | 3 | 5 | 2 | 68 |
| D: Serverless (webhooks, Lambda, Scheduler) | 3 | 4 | 2 | 2 | 2 | 2 | 3 | 54 |

- **Fargate safety.** I raised Fargate's safety score from the analyst's 4 to 5. Hosting cannot cause a wrong release; a restart only loses releases.
- **Sensitivity check.** Raise Ops to 25 and drop Team skill to 0. EC2 still scores 82 against Fargate's 79. The ranking holds unless one of the conditions in §1.4 changes the inputs.
- **Serverless (D) is rejected on the merits:**
  - Webhooks need a public HTTPS endpoint, while long-polling needs none (HLD §3; S1 L26, L247).
  - The SDK's long poll cannot be stopped (LLD §9 L1066).
  - It contradicts the deliberate in-memory runtime design: "persisting timers would resurrect stale workflows" (LLD §8.1 L979).
  - The macro's sub-second coalescing and recovery timings would have to be rebuilt (LLD §5.2–§5.3).
- **On-prem (C) is rejected.** It goes against the AWS target cloud. The hybrid variant also puts the 30 s lease on the Direct Connect path.

### 1.4 Conditions that would change the decision

These go into the ADR and must be confirmed with Suncorp Cloud Platform before the board meets:

1. **Fargate wins** if Suncorp's AWS platform standard mandates ECS for new workloads, or has no hardened EC2 image and patching pipeline.
2. **Re-assess both** if the corporate EDR or vulnerability agents cannot run on the chosen instance type.

The application code is identical either way. Only the lease holder-ID source and the packaging change.

### 1.5 Containers: is your dislike a real problem here?

**A container is not a technical problem for this workload.** Fargate would run the same Node process. The safety model survives disposable tasks, because nothing local has to survive and a restart quarantines meetings by design.

**The real reasons EC2 wins:**

1. **You control when restarts happen.**
   - On EC2, deploys and patch reboots happen only when we schedule them.
   - On Fargate, AWS retires tasks for platform patching. The `fargateTaskRetirementWaitPeriod` setting can delay this up to 14 days, and AWS can override it for critical fixes.
   - Because every restart quarantines the fleet, a restart during business hours costs real releases. The critique estimates roughly 70–100 ghost bookings not reclaimed by a restart at 10:05; that is an estimate.
2. **Stable identity for the lease.**
   - The lease holder ID is designed as "the EC2 instance ID under systemd" (LLD §8.5 L1029).
   - A crash restart takes the lease back immediately, which is what MS story 23 promises: "restart cleanly in under two seconds on a Linux VM" (MS L58).
   - On Fargate every replacement is a new identity. It pays a 30–90 s cold start and then up to 30 s waiting for the old lease.
3. **The localhost dashboard needs a tunnel.**
   - On EC2, SSM port forwarding to `127.0.0.1` works out of the box.
   - Fargate needs ECS Exec, the SSM agent inside the task, and a target ID that changes on every restart.
4. **Enterprise fit.** A hardened standard VM with no inbound access and no SSH usually gets through review faster than introducing ECR, image scanning and runtime security for a single process.

**What EC2 costs you compared with Fargate (said plainly):**

| Work | EC2 (recommended) | Fargate |
|---|---|---|
| Host OS / kernel patching | **Yours.** Monthly image rebuild and instance refresh, Patch Manager for urgent CVEs, and a reboot within a maintenance window. | AWS's job, but it forces retirements. |
| Node runtime and npm dependency patching | Yours (bundled Node in the release) | Yours (rebuilt base image). **Same work.** |
| Agents (EDR, vulnerability scanner, CloudWatch) and their compliance evidence | Yours, using the standard Suncorp server image | Mostly none. A sidecar or GuardDuty if security mandates it. |
| Liveness | You build a watchdog plus a heartbeat alarm, because the ASG only sees EC2 status checks. | An ECS health check (you still need the heartbeat alarm). |
| Recovery from host or AZ loss | About 5–10 min (status check, launch, boot, install) | About 1–2 min |
| Steady-state effort once automated | About 0.5–1 person-day/month | About 0.25–0.5 person-day/month |

Net, EC2 costs roughly half a person-day a month more, plus owning the server image. In exchange we control the restart schedule, get instant crash recovery with the same identity, and get a simpler admin access path. For a service whose main operational risk is restarts during business hours, that trade is worth it.

### 1.6 Implementation blueprint (Option B)

**Platform and sizing.**
- ap-southeast-2 (Sydney), in a Suncorp landing-zone workload account.
- Instance: `t3.small` (x86), unlimited CPU credits.
  - x86 avoids any ARM question about Suncorp's EDR agents.
  - `t4g` saves only about AUD 6/month.
- Image: Suncorp's standard server image. If none is mandated, use Amazon Linux 2023: it has no licence fee, includes the SSM agent, and supports kernel live patching.
  - If RHEL 9 is mandated, use Red Hat Cloud Access to bring Suncorp's own subscriptions.

**Release artifact.**
- CI runs `npm ci`, the tests (including `node codec-native/test_BookingAutoCancellation.js`), `tsc`, then `npm ci --omit=dev`.
- It packages `booking-autocancel-<semver>+<sha>-linux-x64.tar.gz` containing `dist/`, production `node_modules`, and a **pinned Node 22 LTS binary**. Shipping Node in the tarball means OS patching never changes the runtime.
- CI also produces SHA256SUMS, a CycloneDX SBOM, and a KMS or AWS Signer signature.
- Releases go to a versioned S3 bucket that only CI can write to.

**Server image.** Built by EC2 Image Builder:
- OS hardened to CIS, plus the SSM, CloudWatch, Inspector and EDR agents.
- chrony using the Amazon Time Sync Service.
- The corporate CA bundle.
- A `bac` system user with no login shell, and the directories `/opt/booking-autocancel/{releases,current}`.
- **No application code in the image.** It is rebuilt monthly, and immediately for a critical CVE.

**Infrastructure as code: Terraform**, with remote state in S3 using DynamoDB locking, in the Suncorp module standard. It defines:
- **Launch template:** IMDSv2 required with hop limit 1, no key pair, no public IP, 20 GiB encrypted gp3 volume.
- **Auto Scaling Group:** min/max/desired 1, two private subnets in different AZs, EC2 health checks, a termination lifecycle hook (60 s) so the shutdown sequence (SIGTERM handling) can finish, and instance refresh with `MinHealthyPercentage=0` so old and new instances never overlap.
- **Security group:** no inbound rules. Outbound:
  - 443 to the Webex domains through the central egress;
  - 443 to the interface endpoints;
  - 25 (STARTTLS) to the relay addresses only.
- **Endpoints:** a DynamoDB gateway endpoint; S3 gateway endpoint; interface endpoints for SSM, ssmmessages, ec2messages, logs, monitoring, KMS and STS. Use the landing-zone shared endpoints if they exist.
- **Subnets:** two dedicated /28 subnets, so the SMTP relay can allow-list the subnet range rather than an instance IP.
- **DynamoDB:** three tables per LLD §8.2.
- Plus CloudWatch alarms, an SNS topic, and the IAM roles and policies described below.

**Boot sequence (user data).**
1. Read `/bac/<env>/release/current-version` from SSM.
2. Fetch and verify the tarball against SHA256SUMS.
3. Unpack it under `releases/` and point the `current` link at it.
4. Run `systemctl enable --now booking-autocancel`.

A replacement instance therefore always runs the approved release.

**systemd unit.**
- `User=bac`
- `Restart=always`, `RestartSec=2`
- `Type=notify` with `WatchdogSec=30`; the event loop sends `sd_notify` keepalives, so a hung loop is killed and restarted.
- `TimeoutStopSec=30`
- `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, empty `CapabilityBoundingSet`
- `MemoryMax=1G`
- Output goes to journald, and the CloudWatch agent (or Fluent Bit) forwards it.
- The process also takes an `flock` on `/run/booking-autocancel/lock`. Two processes on one host would otherwise share the same holder ID, so this single-process-per-host guard closes that gap.

**Lease and failover.** This changes LLD §8.5:
- **Acquire the lease before `connect()`.** The SDK starts long-polling inside `connect()` and has no stop method (LLD §9 L1066), while §8.5 today only gates the roster. Without this change, a standby or zombie process could consume events meant for the active instance.
- **Holder ID** is the instance ID (unchanged).
- **Fencing:** before every booking-changing command, check a local monotonic deadline: time of last successful renewal + 30 s − 10 s margin. Stop when it passes, rather than waiting to notice a failed renewal.
- **On SIGTERM:**
  1. close the roster gate;
  2. cancel timers;
  3. conditionally delete the lease where holder = me;
  4. exit.
- **Recovery times:**
  - Process crash: about 2 s, lease taken back immediately.
  - Host or AZ loss: about 5–10 min, waiting at most 30 s for the lease.

**Deploy (application releases).**
- An SSM Automation document `BAC-Deploy(version)`:
  1. fetch and verify the release;
  2. run `main.js --preflight` (validates config, SSM, DynamoDB and the Webex token);
  3. switch the `current` link;
  4. run `systemctl restart`;
  5. wait up to 180 s for `/healthz` on 127.0.0.1 to report the lease held, long-poll connected, and roster loaded;
  6. on success, update the SSM `current-version` parameter; on failure, switch the link back automatically.
- The deploy is in place, so it keeps the instance ID and the lease is taken back immediately.
- **Window:** 01:00–05:00 Sydney time, which covers Perth (22:00–02:00). Each release carries a Change Advisory Board (CAB) change record.

**Rollback.**
- Run `BAC-Deploy` again with the previous version. The last 5 releases stay on disk.
- DynamoDB schema changes must stay backward compatible for one release.

**Patching.**
- Monthly: new image, Terraform updates the launch template, then instance refresh in the window. The SIGTERM hook releases the lease, so the replacement does not wait.
- Urgent fixes between cycles: Patch Manager installs security updates in place, in the window. It reboots only when the OS says a reboot is needed.
- Inspector scans OS packages and the npm lockfile.

**Secrets.**
- SSM `SecureString` parameters under `/bac/<env>/`, encrypted with a customer-managed KMS key:
  - Webex client ID, client secret and refresh token
  - `ADMIN_DASHBOARD_PASSWORD`
  - `AUTOCANCEL_KILL_SWITCH`
- Instance profile (least privilege):
  - `ssm:GetParameter` on `/bac/<env>/*` and `kms:Decrypt` on that key;
  - DynamoDB on the three tables, with Put and Query only on the audit table (LLD §8.2);
  - `s3:GetObject` on the release prefix;
  - logs and metrics.
- Add `ssm:PutParameter` on the refresh-token parameter **only if** the Webex refresh token turns out to rotate. That is still open; see Board gap B10.
- **SMTP connection settings (host, from, port, TLS) move from the dashboard to SSM/Terraform.** Today they are editable in the dashboard (HLD §7.4 L410), which would let anyone with the shared password redirect organizer email.

**Observability.**
- Structured JSON logs carrying a per-lifecycle correlation ID, and no meeting subjects (MS story 18).
- Metrics emitted through CloudWatch Embedded Metric Format:
  - a heartbeat every 60 s
  - `lease_held`, `longpoll_connected`, `seconds_since_last_event`
  - `checkout_total`, `release_aborted_total{reason}`, `events_discarded_total{reason}`
  - `quarantined_rooms`, `blocked_rooms{reason}`
  - `warning_email_failed_total`, `webex_429_total`
  - `kill_switch_active{source}`, `tripwire_tripped`
- Alarms to the on-call team:
  - heartbeat missing for 3 min, with missing data treated as breaching. A dead service that fails closed is otherwise silent.
  - lease not held for 2 min
  - long-poll disconnected for 5 min
  - tripwire tripped
  - kill switch active longer than N hours
  - SMTP failures
  - systemd restart count rising
  - EC2 status check failed
  - ASG launch or terminate
- Audit and security events are forwarded to the Suncorp SIEM.

**Admin access (fills the "deferred" item in HLD §7.4 L420).**
- The dashboard binds to `127.0.0.1:8443`.
- Admins use an IAM Identity Center permission set `BAC-DashboardAdmin`, allowed only `ssm:StartSession` with the `AWS-StartPortForwardingSession` document, to instances tagged `app=bac`, on port 8443.
- A helper script `bac-dashboard` looks up the current instance ID from the ASG.
- CloudTrail plus SSM session logs record which named person opened each tunnel.
- Shell access is limited to a separate break-glass role with recorded sessions.
- **Before the first production LIVE promotion:** add an Entra ID OIDC login in the app (localhost redirect URIs are allowed), with roles viewer / operator / LIVE-approver. Audit records then carry the named user, not `admin`.

**Disaster recovery.**
- **Within the region:** the ASG replaces the instance in the other AZ. RTO about 10 min. RPO for admin state is 0 (DynamoDB is multi-AZ, with PITR). Runtime state is not recoverable by design; quarantine makes that safe.
- **Region loss:** automation stops (fail closed) and native RoomOS behaviour continues. Rebuild in ap-southeast-4 (Melbourne) by running Terraform with region as a parameter, restoring the tables from AWS Backup copies, and copying the parameters by runbook. The same Webex integration works from there. RTO: one business day. Rehearse yearly.
- Never rely on DynamoDB global tables for the lease: they do not give cross-region mutual exclusion.

**Environments.**

| | dev | test | prod |
|---|---|---|---|
| Runs on | Laptop: `npm run dev` with `JsonFileFleetConfigStore` (HLD §8.1) | AWS, same Terraform, `t3.micro` | AWS |
| Webex org / integration | Lab org, separate integration | Lab codecs (Navigator, Desk Pro, Board), separate integration | Prod org, prod integration |
| Rooms | Lab only | Lab only | Promotion path per LLD §5.7 |

- **Every environment has its own Webex integration.** Production credentials never leave production SSM. This prevents a second long-poll consumer on the production integration; see Board gap B2.

**What HLD §8.2 should say instead of two options.**

> **8.2 Production Compute: EC2 + systemd (ADR-002).** The service runs as a single `systemd`-supervised Node process on one EC2 instance in an Auto Scaling Group (min/max/desired 1) spanning two private subnets in different AZs, built from the Suncorp standard server image. This is *single instance with automated recovery*, not high availability; it is acceptable because every outage fails closed (no release) and native RoomOS behaviour continues. Application releases deploy in place via SSM (`BAC-Deploy`) so the instance ID, and therefore the lease, is retained; OS image updates use instance refresh with `MinHealthyPercentage=0`. All restarts are scheduled 01:00–05:00 Sydney time, because every restart quarantines in-progress meetings. ECS Fargate was evaluated and is the documented fallback if Suncorp platform standards mandate containers (ADR-002 §Alternatives); the application is host-agnostic apart from the lease holder ID source.

The same edit is needed in HLD §1 L20, MS item 8 (L30), MS story 39 (L74), MS §9 (L147–151), and HLD §8.3 L458. Fix MS story 23 (L58) to read "process restart" rather than suggesting patching is disruption-free.

---

## 2. Architecture soundness

| # | Decision | Verdict | Rationale |
|---|---|---|---|
| 1 | Single active instance with a DynamoDB lease | **Keep, harden** | 800 rooms is trivial load, and sharding or a warm standby would still quarantine everything on takeover. The lease needs to be acquired before `connect()`, a fencing deadline, release on SIGTERM, and a per-host lock (LLD §8.5 L1028–1030, §9 L1066). |
| 2 | In-memory actor per room, rebuilt from the device | **Keep, add a ramp** | It mirrors the macro (LLD §8.1 L979). But start, reconnect and lease re-acquire re-apply config to every actor at once with no jitter (LLD §7.2 L939, §5.12 L846, §8.5 L1030): roughly 4–6k calls against an unverified rate limit. |
| 3 | Long-polling, not webhooks | **Keep** | No inbound path (S1 L26, L247). This is the right posture for APRA. Delivery semantics and behaviour with competing consumers are unverified, so add them to the spike. |
| 4 | Hexagonal ports and adapters | **Keep, reword the claim** | The real value is deterministic testing and isolating Webex. The ports carry RoomOS meaning (native check-in ownership, controller topology, uptime). Drop "vendor-agnostic HAL / swap the driver" (HLD L17; MS L27). |
| 5 | DynamoDB for admin state | **Keep** | Conditional writes, PITR, append-only audit enforced by IAM, gateway endpoint (LLD §8.2). Add audit retention and fix the PII statement (L998). |
| 6 | Kill switch from store OR SSM, polled every 30 s | **Keep** | Correct break-glass design that fails closed (LLD §8.5 L1025–1026). The dashboard must show which source is active. |
| 6b | Tripwire: more than 30 releases per 5 min | **Change** | A fixed number false-trips at fleet scale: roughly 80–120 legitimate releases cluster around :12 past the hour (estimate). It then halts the fleet until an admin resets it (HLD §7.3 L390–393). Make it relative to LIVE rooms with active bookings, sized from DRY_RUN `WOULD_RELEASE` data. |
| 7 | SMTP through the corporate relay on port 25 | **Keep, harden** | The corporate-standard internal path; Graph `Mail.Send` and SES are heavier reviews. Require STARTTLS, allow-list the relay, pin the host in SSM rather than the dashboard, and state that "delivered" means the relay accepted the message (LLD §5.8 L793). |
| 8 | Localhost dashboard with a shared password | **Change before production LIVE** | It has no production access path, and no per-person attribution for promotion, kill switch or tripwire actions (HLD §7.4 L414–420). Use SSM port forwarding now; Entra OIDC with roles is a gate before the first production LIVE room. |
| 9 | Node/TypeScript | **Keep** | The only official SDK, and line-by-line reviewable against the JS macro. Pin the LTS version, and keep a fallback to direct REST calls (the SDK has no stop method and no 429 retry, LLD §9). |
| 10 | Tier 2 sweeper | **Keep, narrow** | Remove "and at codec-local midnight" (HLD §6 L350; MS L120): the midnight check belongs to the actor and writes config. Define the "orphaned timer" predicate (HLD L353) precisely. Add a statement that the service owns certain configuration keys (xConfig) and that Control Hub templates must exclude them. |
| 11 | Restart quarantine | **Keep the behaviour, control the timing** | Correct and safe. Add a deploy/patch window policy, a startup ramp, and clearing of stale prompts plus volume restore on actor start in LIVE. Make DT1 a formal decision gate. |
| 12 | Centralise rather than run the macro fleet-wide | **Keep, justify** | The service is less observant than the macro (no `Bookings.CheckedIn`, no topology events, LLD §9). Justify it on fleet controls, organizer email and governance, not on vendor independence. The user has ruled out a relay macro; if DT1 is negative the documented gap (LLD §5.9) stands. |

**Recommended changes:**
1. HLD §8.2, MS §9, story 39: a single compute target (EC2), with ADR-002.
2. LLD §8.5: lease acquired before `connect()`, fencing deadline, delete on SIGTERM, per-host lock.
3. LLD §7.2 / §5.12 / §8.5: a fleet-wide token-bucket limiter in the Webex adapter, plus jittered waves on start, reconnect and lease re-acquire. Time spent waiting on a 429 must not count against the readiness recovery schedule (LLD §5.3).
4. MS D8 and HLD §7.3: a relative, data-derived tripwire threshold, with alerting and an owner.
5. HLD §7.4: SMTP connection settings out of the dashboard; minimum and maximum bounds plus a change-ticket reference or second approver for safety-relevant settings (`EMPTY_ROOM_TIMEOUT_MS`, `NOTIFICATIONS_ENABLED`).
6. Actor start in LIVE: clear stale prompts and restore volume.
7. Tier 2 / midnight wording fix; key-ownership statement against Control Hub templates.
8. Remove the Fargate overclaims ("instant container startup", HLD L440–441). Reword "immediately halt" (MS story 15), which really depends on the 15-minute inventory sync (LLD §8.3).
9. Data: fix the "no organizer data stored" statement (LLD L998), since audit before/after values of `EXEMPT_ORGANIZERS` contain email addresses. Add audit retention and a log field allow-list.
10. Regenerate the components diagram from the DDD mermaid, which is the maintained version per CLAUDE.md.

---

## 3. Board gaps (prioritised)

| Pri | Gap | Where it belongs |
|---|---|---|
| **Blocker** | Alternatives and decision records: centralised service vs macro fleet-wide plus thin control plane vs native RoomOS only vs a commercial product; compute (EC2 vs Fargate / Lambda / EKS / on-prem); DynamoDB; long-poll vs webhook; single instance; SMTP relay | New ADR-001 to ADR-007 |
| **Blocker** | Non-functional requirements: zero false releases (proxy: Keep Booking after release, complaints); automation availability target (for example 99.5% in business hours, explicitly "outage = missed release, not wrong release"); RTO/RPO; release latency budget (about 6–10 s after the deadline, from sequential ~1 s xAPI calls) | New HLD §9 "Non-functional requirements" |
| **Blocker** | Production admin access path and identity; SSO and LIVE-approver role as the go-live gate | HLD §7.4 rewrite, ADR-008, threat model |
| **Blocker** | Threat model (STRIDE). Biggest item: stolen integration credentials. `spark-admin:devices_write` can change configuration on every device in the org, outside location limits (LLD §9), so the blast radius is the whole estate. Also: dashboard misuse, SMTP redirection, supply chain, a dev laptop with prod credentials | New threat model doc |
| **Blocker** | Network egress design: NAT vs central egress vs proxy; Webex domain allow-list; no TLS inspection of long-polls; interface endpoints; TCP 25 over Direct Connect / Transit Gateway with STARTTLS, signed off by the network team | HLD §8.2 network subsection |
| **Major** | Webex call-budget and rate-limit model at 800 rooms, startup ramp, load test with an 800-room simulator; Cisco limits in writing | HLD §9 NFR, LLD §9, test strategy |
| **Major** | Long-poll consumer exclusivity and environment separation (separate integrations per environment; device test for competing consumers) | ADR-004, LLD §8.5, runbook |
| **Major** | Failure-modes table: Webex outage, long-poll stall, store outage, lease loss, SMTP outage, AZ loss, bad deploy, bad settings, clock skew, firmware xAPI change. **Also state that while the service is down or the kill switch is on, LIVE rooms in `Allowed` keep `Enabled=True` with a 60-min native window, so native RoomOS no-show release still runs** (LLD §5.6, §5.8). | New HLD section "Failure modes" |
| **Major** | Tripwire sizing derived from DRY_RUN data | HLD §7.3, MS D8 |
| **Major** | Data classification and privacy: organizer identity is personal information; titles may be Confidential; titles go into emails over port 25; state the region; retention; privacy impact assessment if required | New "Data and privacy" section, LLD §8.2 |
| **Major** | Guardrails on safety-relevant settings; SMTP settings pinned out of the dashboard | LLD §5.10, HLD §7.4 |
| **Major** | Observability: service level indicators and objectives, heartbeat, log schema, SIEM forwarding | HLD §8 Observability subsection |
| **Major** | Runbooks and ownership: service owner, on-call, kill switch through SSM, tripwire reset, store outage, stuck lease, credential rotation and 24 h reactivation, `CleanupIncomplete`, `DeviceMismatch` after a device replacement (RMA), "my booking was cancelled" investigation, escalation to Cisco TAC | New runbook pack |
| **Major** | Credential lifecycle (does the refresh token rotate? write-back IAM, revocation, alert on refresh failure) | ADR, LLD §9, runbook |
| **Major** | Testing beyond unit tests: codec lab end-to-end, soak/load, chaos (lease, store, stall, 429), DRY_RUN pilot exit criteria, a parity harness that replays the macro tests | New test strategy section |
| **Major** | Software delivery: CI/CD, signing, deploy windows, rollback, Terraform state, go/no-go for each LIVE wave | HLD §8 and runbook |
| **Minor** | DR statement (region loss means automation off; rebuild RTO one business day) | HLD §8 DR subsection |
| **Minor** | Cost (about AUD 45–90/month in a standard landing zone; about AUD 250–330/month with dedicated NAT and endpoints) | HLD §8 or appendix |
| **Minor** | Honest lock-in statement (the safety logic is shaped by Webex) | HLD §1, ADR-001 |
| **Minor** | Clock and NTP assumption, tolerated skew | HLD §9 NFR |
| **Minor** | Conformance with Suncorp standards (landing zone, tagging, agents, Terraform modules) | HLD §8 |
| **Minor** | Employee comms, accessible email template, prompt wording | Rollout plan |
| **Minor** | Doc hygiene: "either Fargate or EC2" (MS L30, L74, L147–151; HLD L20), Tier 2 vs midnight, the "immediately" overclaim, regenerate the PDF diagram | MS, HLD |

---

## 4. Proposed board pack outline

1. **Executive summary** (1 page): the problem, the safety rule ("never release unless provably safe; `CheckOut` only, never `Delete`"), the decision requested, headline risks and mitigations.
2. **Business context and the alternatives considered** (ADR-001): macro fleet-wide plus control plane, native-only, commercial product, central service. Why central control is worth being less observant than the macro.
3. **Diagram: C4 Level 1, system context.** Room users, organizers, admins; the service; Webex cloud and Control Hub; RoomOS codecs; Exchange through Hybrid Calendar; the Suncorp SMTP relay; AWS.
4. **Diagram: C4 Level 2, containers.** The Node service (ingress transport, room registry and actors, JIT validator, fleet gates, dashboard), DynamoDB tables, SSM parameters, CloudWatch, the relay.
5. **Diagram: deployment.** VPC, two private subnets and AZs, ASG(1) EC2, gateway and interface endpoints, central egress to Webex, Transit Gateway / Direct Connect to the relay, the SSM port-forward admin path. Zero inbound rules are shown explicitly.
6. **Diagram: no-show release sequence** (LIVE, based on LLD §4.1): booking start, empty, countdown, warning email (relay accepts), prompt to the controller, chime ticks, the 12-step JIT checklist, CheckOut, cancellation email. Mark each fail-closed exit.
7. **Diagram: restart and failover sequence:** SIGTERM releases the lease, the new process acquires the lease, then `connect()`, the jittered actor ramp, quarantine of in-progress meetings.
8. **Safety model:** JIT checklist (LLD §5.5), fleet gates, roster gate and promotion path (DISABLED → DRY_RUN → LIVE, system only demotes), native CheckIn ownership, intentional differences from the macro (LLD §5.14), pending device tests DT1–DT5.
9. **Non-functional requirements and capacity:** service level objectives, RTO/RPO, latency budget, Webex call budget, the fleet scaled from 800 to 2,000 rooms.
10. **Failure modes table:** detection, effect, recovery and owner for each failure.
11. **Security:** threat model summary, IAM, secrets, admin identity roadmap, data classification and privacy.
12. **Operations:** deploy and patch windows, release and rollback, observability and alarms, runbook index, ownership and on-call, DR.
13. **Rollout plan:** pilot site, DRY_RUN exit criteria, LIVE waves with go/no-go, comms.
14. **Cost:** monthly estimate and the assumptions behind it.
15. **Decision record index:**
    - ADR-001 Centralised service vs macro plus control plane
    - ADR-002 Compute: EC2 + systemd (Fargate as fallback; Lambda, EKS and on-prem rejected)
    - ADR-003 DynamoDB admin store, in-memory runtime state
    - ADR-004 Long-poll ingress, one consumer per integration, per-environment integrations
    - ADR-005 Single active instance, DynamoDB lease with fencing
    - ADR-006 SMTP relay with STARTTLS; warning email as a release gate
    - ADR-007 Kill switch and relative tripwire
    - ADR-008 Admin access: SSM port forward now, Entra OIDC with roles before production LIVE
    - ADR-009 Startup quarantine until meeting end, and CheckIn visibility (DT1 decision gate; no relay macro)
16. **Open items and the asks of the board:** DT1–DT5 results, Webex rate limits, competing-consumer behaviour, refresh-token rotation, Suncorp platform confirmation (server image and agents), network sign-off for TCP 25.

**Pending items.** These should go into `.scratch/pending.md`, which already exists and already lists "Hosting decision" and "Board pack":
- every Blocker and Major row in §3
- the 10 recommended changes in §2
- confirming the two conditions in §1.4 with Suncorp Cloud Platform

Key files:
- `C:\Users\oscar\Downloads\OneDrive_2_10-15-2026\booking-autocancellation\booking-autocancellation\service\docs\ServiceHighLevelDesign.md`
- `C:\Users\oscar\Downloads\OneDrive_2_10-15-2026\booking-autocancellation\booking-autocancellation\service\docs\ServiceLowLevelDesign.md`
- `C:\Users\oscar\Downloads\OneDrive_2_10-15-2026\booking-autocancellation\booking-autocancellation\service\docs\ServiceMasterSpec.md`
- `C:\Users\oscar\Downloads\OneDrive_2_10-15-2026\booking-autocancellation\booking-autocancellation\.scratch\pending.md`