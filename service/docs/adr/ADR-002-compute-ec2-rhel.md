# ADR-002: Production Compute on EC2 RHEL 9 with systemd

- **Status:** Accepted (2026-10-17)
- **Deciders:** Service owner
- **Related:** [ServiceHighLevelDesign.md §8.2](../ServiceHighLevelDesign.md), [ServiceLowLevelDesign.md §8.5](../ServiceLowLevelDesign.md)

## Context

The service is one long-running Node.js process. It holds an in-memory actor and timers for each of about 800 rooms, keeps an outbound Webex long-poll open, and drives rooms only while it holds a single-instance DynamoDB lease. It has no inbound ports, and its admin dashboard binds to `127.0.0.1`.

Two properties shape the hosting choice:

- **Every restart quarantines the meetings in progress** until they end (startup quarantine, LLD §5.9). A restart never causes a wrong release, but every restart during business hours loses releases for the rest of those meetings. Control over *when* the process restarts therefore decides how much value the service delivers.
- **An outage fails closed.** While the service is down, no booking is released and native RoomOS behaviour continues. A single instance with automated recovery is enough; high availability buys little, because any takeover would quarantine every meeting anyway.

## Decision

Run the service as one `systemd`-supervised Node.js process on a single EC2 RHEL 9 instance, in an Auto Scaling Group fixed at one instance across two Availability Zones, provisioned by Terraform.

- **Image:** the Suncorp standard RHEL 9 image (or a hardened RHEL 9 image from EC2 Image Builder) with the corporate security agents, a current CloudWatch agent (journald input), and the SSM Agent. AWS RHEL images do not include the SSM Agent, so it is installed explicitly; with Image Builder it is installed in a build component (or `uninstallAfterBuild = false`) so it survives into the image. SELinux enforcing, IMDSv2 required, no key pair, no public IP. The image contains no application code. Size `t3.medium`, provisional until a load test with 800 actors and the security agents confirms it.
- **Release:** a versioned, checksummed tarball containing the compiled service, production dependencies, and a pinned Node.js LTS runtime, stored in a versioned S3 bucket. OS patching never changes the runtime.
- **Supervision:** `Restart=always`, a systemd watchdog, and systemd sandboxing, running as a dedicated non-login user. Node cannot write to the systemd notify socket itself, so the watchdog is pinged from an event-loop timer (a blocked loop misses it) through either the `sd-notify` native addon, built against RHEL 9 `libsystemd` and bundled in the release, or by spawning `systemd-notify` with `NotifyAccess=all`. The lease holder ID is the instance ID, so a crashed process re-acquires its own lease immediately.
- **Deploy:** in place through an SSM Automation runbook (verify, extract into `/opt/booking-autocancel/releases/<version>`, `restorecon -R` so SELinux labels are correct, preflight, switch symlink, restart, health check, automatic switch back on failure), keeping the instance and its lease.
- **Patching:** monthly image rebuild rolled out by instance refresh with `MinHealthyPercentage = 0` and `MaxHealthyPercentage = 100` (terminate, then launch), with the same values in the group's instance maintenance policy so health replacements never overlap either. SSM Patch Manager (`dnf`, `RebootIfNeeded`) installs urgent fixes in the window. Patching needs HTTPS egress to the RHEL repositories (Red Hat Update Infrastructure, or an internal Satellite), which depends on the licensing choice. The service releases its lease on shutdown.
- **Restart window:** planned deploys, patches, and refreshes run between 01:00 and 05:00 Sydney time.
- **Admin access:** SSM Session Manager port forwarding (`AWS-StartPortForwardingSession`) to the `127.0.0.1` dashboard; no inbound path and no SSH. CloudTrail records who opened each tunnel, but not what happens inside it, so dashboard actions rely on the application audit log.

## Alternatives Considered

| Option | Why not chosen |
| :--- | :--- |
| **AWS ECS Fargate (single task)** | Viable, and it removes OS patching. Not chosen because AWS retires Fargate tasks for platform patching: since December 2025 the retirement can be steered into a maintenance window with EC2 event windows, but only on a best-effort basis, and tasks can still be stopped outside it for host or hardware events, while every restart quarantines the fleet's meetings in progress; each replacement task has a new identity, so it waits for the old lease to expire; and reaching a localhost dashboard needs ECS Exec with a target that changes on every restart. **Documented fallback** if Suncorp platform standards require containers: the application code is the same, only packaging and the lease holder ID source change. |
| **Serverless (webhooks, Lambda, EventBridge Scheduler, state in DynamoDB)** | Webhooks need a public HTTPS endpoint, while long-polling needs none. Persisting per-room timers and generation guards as distributed state would rebuild the validated macro logic in a new form and contradicts the in-memory runtime design (LLD §8.1). |
| **On-premises RHEL VM** | Close to the SMTP relay, but against the AWS target platform, and the DynamoDB lease would depend on the Direct Connect path. |
| **Active/standby or sharded instances** | Any takeover still quarantines every meeting in progress, so a second instance adds cost and failure modes without adding releases. |

## Consequences

- **Positive:** restarts happen only when scheduled; a process crash recovers within seconds with the same lease; the admin access path is standard SSM; no container platform is introduced for one process; the host fits existing Suncorp RHEL operations.
- **Negative:** the team owns the OS image and its patching, which the architecture review estimates at roughly half a person-day a month more than Fargate once automated. A host or Availability Zone failure takes minutes to recover (automation halted, failing closed, until the replacement runs). Liveness needs the systemd watchdog and a heartbeat alarm, because the Auto Scaling Group only sees EC2 status checks unless the service reports custom health (`SetInstanceHealth`).

## Revisit If

- Suncorp's AWS platform standard mandates containers for new workloads, or has no hardened RHEL image and patching pipeline.
- Corporate security agents cannot run on the chosen instance type.
- The fleet grows enough that one process cannot serve it within the Webex rate limits.

## To Confirm with Suncorp Cloud Platform

- The standard RHEL 9 image, its patching pipeline, and the required agents.
- RHEL licensing: AWS pay-as-you-go RHEL images or existing subscriptions through Red Hat Cloud Access, and the matching package repository path (Red Hat Update Infrastructure or an internal Satellite).
- Shared VPC endpoints and the central egress path to Webex.
