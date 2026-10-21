# Domain Architecture Board review: Booking Auto Cancellation Service

**Docs reviewed:** ServiceMasterSpec.md (MS), ServiceHighLevelDesign.md (HLD), ServiceDomainDrivenDesign.md (DDD), ServiceLowLevelDesign.md (LLD) and .doc/sprints/sprint-1/Sprint1Spec.md (S1).

**Not reviewed:** `.doc/Autocancellation Components Diagram.pdf`. It could not be rendered because poppler isn't installed and Python isn't available.

**Overall verdict:** The room-level safety design is unusually strong, and a board would likely accept it. The JIT checklist (LLD §5.5), fail-closed gates, startup quarantine, roster gate (LLD §7.1) and the macro-parity table (LLD §5.14) all hold up. The gaps are almost all operational and governance gaps:

- No NFRs or SLOs.
- No threat model.
- No data classification.
- No ADRs or alternatives analysis.
- No runbooks or ownership model.
- No production admin access path.
- No egress or proxy design.
- No Webex rate-limit capacity model.

A few design-level issues also surfaced that a careful reviewer would catch (section B).

---

## A. Blockers (expect "not approved" until these are addressed)

| # | Item | Covered today? | What to add |
|---|---|---|---|
| A1 | **Alternatives considered / ADRs** | No ADRs in the repo. MS "Problem Statement" (MS:5-13) gives three reasons for leaving the macro but never weighs any alternative. | Write ADRs covering at least these four options: (a) push the validated macro fleet-wide through Control Hub, plus a thin central kill-switch/telemetry service; (b) native RoomOS check-in/no-show release only, which the device already does (LLD §9 row 3); (c) a commercial occupancy/room-booking product; (d) this central service. The board will notice that the service is **strictly less observant than the macro**: no `Bookings.CheckedIn` (LLD §9), no controller topology events (LLD §5.11), no boot-complete event (LLD §5.13), and one accepted release gap the macro doesn't have (LLD §5.14 last row). The ADR has to say why central control is still worth that. Add ADRs for the compute choice (see section D), DynamoDB, long-poll over webhook, single instance over active/passive, and unauthenticated SMTP relay. |
| A2 | **Non-functional requirements** | Partial. The only figures are a restart in under 2 s (MS:58, US23), lease takeover in about 30 s (LLD §8.5), and a memory estimate (LLD §7 "Memory Overhead"). There is no availability target, RTO/RPO or latency budget. | Add an NFR section with these targets. **Safety:** zero false releases, with a measurable proxy such as user complaints or Keep-Booking-after-release. **Availability of automation** (for example 99.5% in business hours); because the system fails closed, an outage means missed releases, not wrong ones, so say that explicitly. **RTO:** EC2 ASG replacement is realistically 3–10 min; Fargate is about 1–2 min plus up to 30 s waiting for the lease. **RPO:** config store PITR gives about 5 min, and runtime state is intentionally RPO=∞ because quarantine makes that safe. **Latency budget:** each cloud xAPI call takes about 1 s, and JIT (LLD §5.5) makes about 6–7 sequential reads, so release lands about 6–10 s after the deadline. Prompt display is wrapped in two topology reads. State the tolerance. |
| A3 | **Production admin access path and identity** | HLD §7.4 (HLD:414-420): the dashboard binds to `127.0.0.1` with a shared password, audit actor `admin`. "Remote access path in AWS ... deferred" (HLD:420). | As written, **nobody can reach enrollment, promotion or settings in production.** Define the interim path, for example SSM Session Manager port-forwarding on EC2, or ECS Exec (harder) on Fargate, and the IAM that gates it. That IAM identity then becomes the real attributable identity. A shared password with a non-attributable `admin` actor (LLD §2.2 `AuditRecord.actor`) on a system that cancels executives' bookings will probably be accepted for DRY_RUN only. Make **SSO + named identity + role separation for `→ LIVE` promotion** a gate before the first LIVE room. |
| A4 | **Threat model / security architecture** | None. Security content is scattered: SSM secrets (HLD:451), no inbound ports (HLD:446), audit table IAM (HLD:457, LLD §8.2), dashboard controls (HLD:414-419). | Write a STRIDE-style threat model. Key threats to cover: (1) stolen Webex integration credentials. `spark-admin:devices_write` can **change configuration on every device in the org, ignoring location limits** (HLD:370, LLD §9, `.doc/autocancellation-manifest-sample.json`), so the blast radius is the whole estate, not 800 rooms. (2) Dashboard misuse (A3, B6). (3) Email abuse through a dashboard-editable `SMTP_HOST` (B7). (4) Supply chain (the `workspace-integrations` SDK and npm dependencies). (5) A dev laptop holding prod credentials (B2). State that the roster gate is an in-app control only, so code integrity matters. |
| A5 | **Network egress design** | HLD §8.2 (HLD:446-450) lists outbound 443 to Webex, the DynamoDB gateway endpoint and SMTP over DX/TGW. It does not say how private subnets reach the internet. | Specify the egress path: NAT gateway, central egress VPC/TGW, or the corporate proxy (for example Zscaler), plus the FQDN allow-list for Webex (`*.wbx2.com` and others). **Verify the Webex SDK supports HTTP(S) proxy and TLS inspection**; long-poll through an inspecting proxy often breaks. List the interface endpoints needed: SSM, CloudWatch Logs, STS, KMS, and ECR if you use containers. Get Suncorp network team sign-off on TCP 25 over DX/TGW. |

## B. Major

| # | Item | Covered today? | What to add |
|---|---|---|---|
| B1 | **Capacity and Webex rate limits at 800 rooms** | Partial. 429 handling and per-device queue (LLD §9 row "SDK does not retry 429"); midnight jitter (LLD §5.12). The rate limit itself is "unverified" (`.doc/webex-device-apis-developer-guide.md:153`). | Build a call-budget model. Per room: actor start is about 5–10 calls (config writes, presence, availability, Get, time). A countdown is about 4–6 calls. Each visible-prompt minute is about 4 calls (audio ×2–3, topology, uptime). JIT is about 7. **Thundering herd:** actor start, ingress reconnect and lease re-acquire re-apply config and revalidate **every actor at once with no jitter** (LLD §7.2, §8.5 "Lease loss", §5.12). That is about 5–8k calls in a burst, exactly when the platform is recovering. Add jittered fleet-wide revalidation. Model the 9:00 / 9:30 meeting-start peaks. Load-test against a 800-room simulator. Get the Webex/Cisco account team's rate-limit numbers in writing. |
| B2 | **Environment separation / long-poll consumer exclusivity** | No. The lease guards *commands* only (LLD §8.5). The SDK poll loop can't be stopped (LLD §9). | If two processes poll with the same integration credentials (a zombie instance during ASG replacement, or an engineer's laptop running with prod creds, which S1 §1 makes easy through `.env.local`), events may be split between them, and the active instance silently misses some. Specify: separate Webex orgs or integrations for dev, test and prod; prod credentials never leave SSM; and whether Webex long-poll queues are per-consumer or shared (a device test). A standby must not poll before it holds the lease. |
| B3 | **Failure modes and blast radius statement** | Many local failure semantics are covered (LLD §8.5, §5.8, §5.12 "Failure", JIT). There is no single failure-mode table. | Add an FMEA table covering: Webex cloud outage, long-poll stall, DynamoDB outage, lease loss, SMTP outage, AZ loss, a bad deploy, bad settings, clock skew, and the codec firmware changing xAPI. For each give detection, effect and recovery. Two effects the board will ask about: (1) **while the service is down or the kill switch is active, LIVE rooms keep `Bookings.CheckIn.Enabled=True` with a 60-min native window** (LLD §5.6, §5.8 "No native CheckIn write"), so **RoomOS native no-show release keeps running**. The kill switch stops the service, not native releases. State this, and decide whether a "native-off" emergency action is needed. (2) Every restart or deploy quarantines all in-progress meetings (HLD:41), so deploys and patching in business hours cost a meeting-slot of savings fleet-wide. |
| B4 | **Tripwire sizing** | HLD §7.3: more than 30 per 5 min (HLD:390). | At 800 rooms, the 9:00 no-show wave releases at about 9:12 (horizon 12 min, LLD §5.10). It can plausibly exceed 30 within 5 minutes on a legitimate Monday, which halts the whole fleet until an admin resets it (HLD:393). Derive the threshold from DRY_RUN data (for example, the 99th-percentile `WOULD_RELEASE` rate per 5 min × safety factor), consider a rate relative to booked rooms, and add alerting and an on-call owner for trips. |
| B5 | **Data classification and privacy** | Contradictory. MS US18 (MS:53) excludes subjects and attendees from logs, and LLD §8.2 (LLD:998) says no organizer data is stored. But `EXEMPT_ORGANIZERS` (VIP **email addresses**) and `EXEMPT_TITLE_KEYWORDS` live in DynamoDB settings, and audit `before/after` is untyped `unknown` (LLD §2.2 `AuditRecord`), so those values land in the audit table permanently. The dashboard **shows meeting subject and organizer and searches by organizer email** (HLD:400-401). Emails carry the meeting title (LLD §6.2, MS:195), sent over unauthenticated port 25 with `SMTP_SECURE=false` by default (S1 §1). | Classify the data: organizer identity is personal information under the Privacy Act/APPs, and meeting titles can be Confidential. Define a log-field allow-list and redaction (no titles; hashed or omitted organizer in logs). Fix the LLD:998 statement. Decide whether titles in email and on the dashboard are acceptable. Require STARTTLS to the relay. State the AWS region for data residency (the docs never name one; assume `ap-southeast-2`). Set **retention** for CloudWatch Logs and for the append-only audit table (currently unbounded; add TTL or an archive). Get a privacy impact assessment if Suncorp's process requires one. |
| B6 | **Safety-relevant settings guardrails** | LLD §5.10 validates only `positive`, `warning ≤ timeout`, and native window > horizon. | Add **minimum and maximum bounds**. Today a shared-password admin could set `EMPTY_ROOM_TIMEOUT_MS=60000` fleet-wide, or set `NOTIFICATIONS_ENABLED=false`, which removes the email gate (HLD:40). Settings changes are effectively production changes with no CAB, second approver or staged rollout (they apply fleet-wide immediately, LLD §8.4). Require two-person approval, or a change ticket reference, for safety-relevant settings. |
| B7 | **SMTP trust** | HLD §4.5 (HLD:202), MS Decision 14. | A dashboard-editable `SMTP_HOST`/`SMTP_FROM` lets anyone with the shared password redirect organizer emails, which carry titles, to an arbitrary host. Pin the host in IaC or SSM rather than the dashboard, or restrict it to an allow-list. Confirm relay acceptance, SPF/DKIM for the sender, and a messaging review. An "[Action Required]" email from a no-reply address looks like phishing, so coordinate with security awareness. Also note that "delivered" means relay `250` accepted, not inbox delivery (HLD:198); state that this is the gate's semantics. |
| B8 | **Observability and SLOs** | Thin. HLD:452 has logs, a metric filter for cancellations and a tripwire alarm. MS:155 mentions FireLens/agent. US17 mentions correlation IDs (MS:52), but no schema exists. | Define SLIs and alarms for: process heartbeat (**a dead fail-closed service is silent**, so you need an absence-of-heartbeat alarm), long-poll connected, lease held, store reachable, kill switch/tripwire state, 429 rate, warning-email failure rate, JIT aborts by reason, quarantine count, rooms `Blocked` by reason, and `EXTERNAL_RELEASE_OBSERVED` rate. Specify a structured log schema with correlation ID per booking lifecycle. Add a health endpoint for ECS/ALB-less health checks. Decide SIEM forwarding (CloudWatch → Splunk/Sentinel, per Suncorp standard) for audit and security events. |
| B9 | **Runbooks, ownership and support model** | None. | Name the service owner, on-call team and hours. Runbooks needed: kill switch via SSM (the only control that works without the dashboard, LLD §8.5), tripwire reset, store outage, lease stuck, Webex credential rotation, re-activation within 24 h (LLD §9 last row), `CleanupIncomplete` rooms (LLD §5.7), `DeviceMismatch` after an RMA, and a "my booking was cancelled" investigation for the service desk (L1/L2 flow, using the audit and correlation ID). Also define an escalation path to Cisco TAC and the Webex account team. |
| B10 | **Credential lifecycle** | Partial. SSM SecureString (HLD:451). S1 §1 lists client ID/secret/refresh token. | Cover: who rotates the client secret, whether the SDK's refreshed token must be written back to SSM (and the IAM for that), revocation and break-glass, the 24 h activation window (LLD §9), and alerting on token-refresh failure. |
| B11 | **Testing strategy beyond unit tests** | Unit tests with mocks plus recorded payloads (MS "Testing Decisions"; S1 Testing 1–2); device tests DT1–DT5 (MS:223). | Add: a lab of real codecs (Navigator, Desk Pro, Board) for E2E; a load and soak test with simulated 800-room event volume; chaos tests (lease loss, store outage, long-poll stall, 429 storms); DRY_RUN pilot exit criteria per site; and a parity test harness that replays macro test scenarios against the service, which would make the "100% parity" claim checkable. |
| B12 | **Change management and rollout** | Room-level rollout is well covered (HLD §7.1–7.2, LLD §5.7, §8.6). Software delivery is not. | Add CI/CD, artifact signing, versioning, deploy windows (outside business hours because of B3 quarantine), rollback, an IaC pipeline and Terraform state backend, and a pilot-site plan with go/no-go criteria for each wave of LIVE rooms. |

## C. Minor

| # | Item | Covered today? | What to add |
|---|---|---|---|
| C1 | DR / region failure | None. | A single region is fine. State that region loss means automation is off (fail closed) and native RoomOS behaviour continues, the target to rebuild in a second region (Terraform + DynamoDB PITR/backup), and whether that is acceptable. A recommended RTO for region loss is days. |
| C2 | Cost | None. | Estimate monthly cost. Compute is about US$10–60 (Fargate 0.25–0.5 vCPU, or t4g.small plus the RHEL licence premium). NAT or egress is often the largest line (about US$35–70+ for NAT). Add interface endpoints, DynamoDB on-demand (pennies), and CloudWatch Logs ingestion (watch chime-tick log volume). |
| C3 | Vendor lock-in | Implicit. Hexagonal ports (HLD §3–4, MS Decision 1); "future adapters" (HLD:132-134). | Be honest about it: the safety logic is Webex-shaped (JIT reads, prompt semantics, native CheckIn ownership). A Poly or Neat driver is a new safety analysis, not "simply authoring new driver modules" (MS:27). DynamoDB is behind `IFleetConfigStore`, so lock-in there is low. |
| C4 | Clock and time assumptions | Codec timezone covered (LLD §5.12, §6.1). | State the NTP requirement on the host, how the service clock is compared with codec and booking timestamps, and the tolerated skew. |
| C5 | Enterprise standards conformance | Not stated. | Cover: landing zone and account placement, tagging, mandated agents (EDR, vuln scanner) on EC2 SOE or ECR scanning for containers, Terraform module standards, and Suncorp logging/SIEM standard. |
| C6 | Accessibility and comms | Prompt/email text only (LLD §6.2). | Plan employee comms before LIVE, an accessible email template, and the wording of the chime/prompt. |
| C7 | Documentation hygiene | MS:23-30 and HLD:20 still read "either Fargate or EC2". | A board expects one decided target (with an ADR). Two production options makes the design read as unfinished. |

## D. On containers vs VM

The workload profile is a single long-running stateful process with in-memory timers, outbound long-poll, no inbound traffic, a localhost dashboard, a lease-based singleton and about 20 MB of state.

That profile fits a plain VM well, and nothing in it needs a container orchestrator. **Lambda / Step Functions are a poor fit**: long-poll can't be stopped (LLD §9), there are per-room timers at 60 s granularity, and JIT needs in-memory generations. Record that in the ADR, because the board will ask.

**EC2 RHEL 9 + systemd, ASG(1) across two AZs (HLD Option B), is a defensible choice. I'd support it if Suncorp has an RHEL SOE/golden AMI pipeline.**

- **Pros:**
  - The dashboard access path (SSM port-forward) is simpler than with ECS Exec.
  - The stable host identity gives instant lease re-acquire on process restart (LLD §8.5).
  - It fits enterprise agent/SOE tooling.
  - Debugging is easy.
- **Cons the board will raise:**
  - You own OS patching. Each patch reboot restarts the service and quarantines in-flight meetings (B3), so schedule patching out of hours.
  - Slower AZ-failure recovery: a new instance must boot and install (pre-bake the app into the AMI or use a deterministic user-data install).
  - Config drift (use immutable AMI plus ASG instance refresh, not in-place SSH changes).
- **Implementation shape:**
  - A Packer-built AMI from the SOE, containing Node LTS and the app artifact, read-only.
  - systemd unit with `Restart=always` plus hardening (`DynamicUser`/dedicated user, `ProtectSystem=strict`, `NoNewPrivileges`, `MemoryMax`).
  - Instance profile with least-privilege IAM.
  - CloudWatch agent for logs and metrics.
  - SSM Session Manager only (no SSH, no key pairs).
  - Deploy with ASG instance refresh at `MinHealthy=0` in a maintenance window, with the DynamoDB lease as the double-run guard.
  - IMDSv2 enforced.
  - Optionally fix the ASG to one AZ subnet pair plus a launch-template-pinned ENI for egress allow-listing.

**Fargate (Option A)** removes OS patching and has the better image-scanning story. But it adds a container build and registry, ECS Exec for dashboard access, and the 30 s lease wait on every replacement (HLD:441). It buys little for one long-lived task. Choose it only if Suncorp's platform standard prefers containers.

Whichever you choose, **pick one, record the ADR, and remove the other option from MS Decision 9 and HLD §8.2.** Also call out that **neither option is highly available.** Both are "single instance with automated recovery," which is acceptable *because* the system fails closed (B3). Say this explicitly instead of letting "two Availability Zones" (HLD:443) imply HA.

## E. Things the board will likely praise (keep them prominent)

- The safety invariant and its enforcement: never `Delete` (HLD:38), the ordered JIT checklist with reasons (LLD §5.5), and the intentional-difference table (LLD §5.14).
- Default-`DISABLED` enrollment, an admin-only promotion path, and the system only ever demoting (HLD §7.1, LLD §8.3).
- An independent SSM kill switch polled every 30 s that survives store or dashboard outage (LLD §8.5).
- Explicit Webex platform-constraint analysis with pending device tests (LLD §9, MS Decision 17).
- An append-only audit table with no update or delete IAM (LLD §8.2).