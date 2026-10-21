# ADR-002: Production Compute on EC2 RHEL 9 with systemd

- **Status:** Accepted (2026-10-17)
- **Deciders:** Service owner
- **Related:** [ServiceHighLevelDesign.md §8.2](../ServiceHighLevelDesign.md), [ServiceLowLevelDesign.md §7.3, §8.5](../ServiceLowLevelDesign.md)

## Context

The service is one long-running Node.js process. It holds an in-memory actor and timers for each of about 800 rooms, keeps an outbound Webex long-poll open, and drives rooms only while it holds a single-instance DynamoDB lease. It has no inbound ports, and its admin dashboard binds to `127.0.0.1`.

Two properties shape the hosting choice:

- **Every restart quarantines the meetings in progress** until they end (startup quarantine, LLD §5.9). A restart never causes a wrong release, but every restart during business hours loses releases for the rest of those meetings. Control over *when* the process restarts therefore decides how much value the service delivers.
- **An outage fails closed.** While the service is down, no booking is released and native RoomOS behaviour continues. A single instance with automated recovery is enough; high availability buys little, because any takeover would quarantine every meeting anyway.

## Decision

Run the service as one `systemd`-supervised Node.js process on a single EC2 RHEL 9 instance in a private subnet, provisioned by Terraform. There is no Auto Scaling Group.

- **Server:** the Suncorp standard RHEL 9 server build with the corporate agents, the CloudWatch agent, and the SSM Agent (AWS RHEL images do not include it, so the build must). SELinux enforcing, IMDSv2 required, no key pair, no public IP. Size `t3.medium`, provisional until a load test with 800 actors and the corporate agents confirms it.
- **Release:** a versioned, checksummed tarball containing the compiled service, production dependencies, and a pinned Node.js LTS runtime, stored in a versioned S3 bucket. OS patching never changes the runtime.
- **Supervision:** `Restart=always` (`RestartSec=5`, `StartLimitIntervalSec=0` so systemd never gives up), a systemd watchdog (`WatchdogSec=30`, pinged every 10 seconds), and systemd sandboxing, running as a dedicated non-login user. Node cannot write to the systemd notify socket itself, so the watchdog is pinged from an event-loop timer (a blocked loop misses it) through either the `sd-notify` native addon, built against RHEL 9 `libsystemd` and bundled in the release, or by spawning `systemd-notify` with `NotifyAccess=all`. The lease holder ID is the instance ID, so a crashed process re-acquires its own lease immediately.
- **Releases:** a new release is installed on the same server and the service restarted; the server is not rebuilt, so the instance ID and the lease are kept. The previous release stays on the server for rollback. The deployment tooling follows the platform team's standard (Sprint 2).
- **Operations:** OS patching and server operations are owned by the Suncorp platform (Wintel) team under its standard server process. The service only requires that planned restarts (patch reboots and releases) happen outside business hours, because each restart quarantines the meetings in progress. The service releases its lease on shutdown.
- **Health and recovery:** systemd restarts a crashed process and its watchdog restarts a hung one. EC2 automatic recovery restarts the instance on healthy hardware after a hardware failure, keeping its instance ID. The service pushes its `/healthz` snapshot to the local Dynatrace OneAgent, and Dynatrace raises the run team's alerts, including restarts and the server going silent (LLD §7.3).
- **Admin access:** SSM Session Manager port forwarding (`AWS-StartPortForwardingSession`) to the `127.0.0.1` dashboard; no inbound path and no SSH. CloudTrail records who opened each tunnel, but not what happens inside it, so dashboard actions rely on the application audit log.

## Alternatives Considered

| Option | Why not chosen |
| :--- | :--- |
| **AWS ECS Fargate (containers)** | Rejected. AWS restarts Fargate tasks for its own platform maintenance (schedulable only on a best-effort basis), and every restart quarantines the fleet's meetings in progress; each replacement task has a new identity, so it waits for the old lease to expire; reaching a localhost dashboard needs ECS Exec with a target that changes on every restart; and it adds a container platform for a single process. |
| **Serverless (webhooks, Lambda, EventBridge Scheduler, state in DynamoDB)** | Webhooks need a public HTTPS endpoint, while long-polling needs none. Persisting per-room timers and generation guards as distributed state would rebuild the validated macro logic in a new form and contradicts the in-memory runtime design (LLD §8.1). |
| **On-premises RHEL VM** | Close to the SMTP relay, but against the AWS target platform, and the DynamoDB lease would depend on the Direct Connect path. |
| **Auto Scaling Group of one across two Availability Zones** | Rejected for simplicity. It would replace the server automatically after an Availability Zone outage, but the outcome during any outage is the same (fail closed: bookings are kept), a replacement has a new identity and waits for the old lease, and a single long-lived server is simpler for the platform team to operate. |
| **Active/standby or sharded instances** | Any takeover still quarantines every meeting in progress, so a second instance adds cost and failure modes without adding releases. |

## Consequences

- **Positive:** restarts happen only when scheduled; a process crash recovers within seconds with the same lease; the admin access path is standard SSM; no container platform is introduced for one process; the server is operated by the existing Suncorp platform team under its standard process.
- **Negative:** the service depends on the platform team scheduling patch reboots outside business hours. An Availability Zone outage stops automation (bookings are kept) until the zone returns or the server is rebuilt by runbook. A hardware failure is covered by EC2 automatic recovery.

## Revisit If

- Corporate security agents cannot run on the chosen instance type.
- The fleet grows enough that one process cannot serve it within the Webex rate limits.

## To Confirm with Suncorp Cloud Platform

- The standard RHEL 9 server build and its agents, and RHEL licensing.
- That patch reboots can be scheduled outside business hours.
- Shared VPC endpoints and the central egress path to Webex.
