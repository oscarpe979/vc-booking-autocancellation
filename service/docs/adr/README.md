# Architecture Decision Records

Each record captures one significant decision: its context, the alternatives considered, and the consequences. Records are numbered in the order they were planned; a planned record has no file yet.

| ADR | Decision | Status |
| :--- | :--- | :--- |
| ADR-001 | Centralised service instead of the macro deployed fleet-wide | Planned |
| [ADR-002](ADR-002-compute-ec2-rhel.md) | Production compute: EC2 RHEL 9 + systemd | Accepted |
| ADR-003 | DynamoDB for admin state; room runtime state in memory | Planned |
| ADR-004 | Long-poll ingress, one consumer per integration, separate integrations per environment | Planned |
| ADR-005 | Single active instance with a DynamoDB lease | Planned |
| ADR-006 | Corporate SMTP relay; warning email as a release gate | Planned |
| ADR-007 | Kill switch and tripwire | Planned |
| ADR-008 | Admin access: SSM port forwarding, then Entra ID SSO with roles | Planned |
| ADR-009 | Startup quarantine until meeting end; CheckIn visibility without `Bookings.CheckedIn` | Planned |
