# Webex Workspace Integrations - Overview and Architectural Reference

> Source: Webex for Developers (`https://developer.webex.com/create/docs/workspace-integrations`)

## 1. Executive Summary

Workspace Integrations provide a cloud-based framework for external services to interact with Cisco collaboration devices, sensors, and workspaces. Unlike on-device macros (which execute locally in QuickJS on each device), Workspace Integrations execute externally as centralized services while interacting with device xAPIs over Webex Cloud APIs.

### Key Characteristics
- **Centralized Deployment**: No code or macros need to be provisioned onto individual room devices.
- **Service Identity**: Operates under a machine account created in the customer organization rather than on behalf of an individual user.
- **Granular xAPI Access Rules**: Strict security manifest specifies exact xCommands, xStatuses, and xEvents permitted.
- **Delivery Mechanisms**: Supports both Webhooks (cloud-to-service push) and Long Polling (service-to-cloud pull).
- **Location & Scope Isolation**: Can be activated tenant-wide or scoped to specific locations/floors.

---

## 2. Comparison: Workspace Integrations vs. Codec-Native Macros vs. Standard OAuth Integrations

| Dimension | Codec-Native Macro | Standard Webex OAuth Integration | Workspace Integration |
| :--- | :--- | :--- | :--- |
| **Execution Environment** | On-device QuickJS engine | External server | External server |
| **Identity & Auth** | Local device admin credentials | User OAuth 2.0 (acting on user's behalf) | Machine account (tenant-scoped service) |
| **Provisioning Overhead** | High (deploy script to 800 devices) | None (web authorization) | Single activation in Control Hub |
| **xAPI Permission Model** | All or nothing (device admin rights) | Coarse OAuth scopes (`spark:devices_read`) | Granular per-node xAPI manifest |
| **Latency** | Local bus sub-millisecond | Variable WAN latency | Webex Cloud mediated WAN latency (~50-200ms) |
| **Multi-Room Aggregation** | Impossible (runs isolated per room) | Possible | Built-in (aggregates telemetry for 800+ rooms) |

---

## 3. Architecture & Topology

```
+---------------------------------------------------------------------------------+
|                                 Cisco Webex Cloud                               |
|                                                                                 |
|   +-------------------+    +--------------------+    +----------------------+   |
|   | Cisco Room Device |    | Cisco Room Device  |    |  Cisco Room Device   |   |
|   | (RoomOS / Codec)  |    | (RoomOS / Codec)   |    |  (RoomOS / Codec)    |   |
|   +---------+---------+    +---------+----------+    +----------+-----------+   |
|             ^                        ^                          ^               |
|             | Webex Edge / Cloud     |                          |               |
|             v                        v                          v               |
|   +-------------------------------------------------------------------------+   |
|   |                       Webex xAPI Broker & Event Router                  |   |
|   +-------------------------------------------------------------------------+   |
+--------------------------------------|------------------------------------------+
                                       |
                   Webhook POST / Long Polling HTTP GET
                   (xStatus changes & xEvent triggers)
                                       |
                                       v
+---------------------------------------------------------------------------------+
|                     External Autocancellation Service Engine                    |
|                                                                                 |
|   +-----------------------+   +-----------------------+   +-----------------+   |
|   | Ingress / Webhook API |-->| Outbound Rate Limiter |-->| Room FSM Actors |   |
|   +-----------------------+   +-----------------------+   +-----------------+   |
|                                                                                 |
|   +-------------------------------------------------------------------------+   |
|   |               State Store (Redis) & Hardware Abstraction Layer          |   |
|   +-------------------------------------------------------------------------+   |
+---------------------------------------------------------------------------------+
```

---

## 4. Manifest Specification

A workspace integration requires an explicit `manifest.json` uploaded to Control Hub. The manifest specifies:
1. General metadata (`displayName`, `description`, `vendor`, `email`).
2. High-level API Scopes (`spark-admin:devices_read`, `spark:xapi_commands`, `spark:xapi_statuses`, etc.).
3. Granular `xapiAccess`:
   - `commands`: exact commands the service can call.
   - `status`: exact statuses the service can read and receive change notifications for.
   - `events`: exact device events the service can subscribe to.

### Manifest for Booking Autocancellation
```json
{
  "manifestVersion": 1,
  "displayName": "Enterprise Booking Autocancellation Service",
  "vendor": "Enterprise IT",
  "email": "collab-admin@enterprise.com",
  "description": "Centralized, vendor-agnostic booking autocancellation and occupancy release manager.",
  "availability": "org_private",
  "apiAccess": [
    { "scope": "spark-admin:devices_read", "access": "required", "role": "id_readonly_admin" },
    { "scope": "spark-admin:workspaces_read", "access": "required", "role": "id_readonly_admin" },
    { "scope": "spark:xapi_statuses", "access": "required" },
    { "scope": "spark:xapi_commands", "access": "required" }
  ],
  "xapiAccess": {
    "status": [
      { "path": "RoomAnalytics.RoomInUse", "access": "required" },
      { "path": "Bookings.Availability", "access": "required" },
      { "path": "Bookings.Current.Id", "access": "required" },
      { "path": "Peripherals.ConnectedDevice", "access": "required" },
      { "path": "SystemUnit.ProductPlatform", "access": "required" },
      { "path": "Time.SystemTime", "access": "required" }
    ],
    "commands": [
      { "path": "UserInterface.Message.Prompt.Display", "access": "required" },
      { "path": "UserInterface.Message.Prompt.Clear", "access": "required" },
      { "path": "Bookings.CheckIn", "access": "required" },
      { "path": "Bookings.CheckOut", "access": "required" },
      { "path": "Bookings.Get", "access": "required" },
      { "path": "Bookings.List", "access": "required" }
    ],
    "events": [
      { "path": "UserInterface.Message.Prompt.Response", "access": "required" },
      { "path": "UserInterface.Message.Prompt.Cleared", "access": "required" },
      { "path": "Bookings.CheckedIn", "access": "required" }
    ]
  },
  "provisioning": {
    "type": "manual"
  }
}
```

---

## 5. Security & Authentication Flow

1. **Registration**: Admin uploads `manifest.json` under *Control Hub > Workspaces > Integrations*.
2. **Credentials Issued**: Webex generates `clientId` and `clientSecret`.
3. **Activation**: Admin clicks *Activate* (selecting target locations/org-wide). Webex issues a signed Activation JWT (`activationCode`).
4. **JWT Verification**: Service decodes the JWT to extract:
   - `oauthUrl`: Token endpoint (`https://webexapis.com/v1/access_token`).
   - `refreshToken`: Permanent refresh token for the machine account.
   - `appUrl`: Endpoint for pinging/initializing integration details.
   - `webexapisBaseUrl`: REST API root (`https://webexapis.com/v1`).
5. **Token Exchange**: Service exchanges `refreshToken` + `clientId` + `clientSecret` for short-lived `access_token` (valid 1 hour).
6. **Automatic Refresh**: SDK/Service refreshes token 15 minutes before expiration.
7. **Webhook Security**: Webhooks delivered from Webex Cloud contain an HMAC SHA-256 signature in the headers using a configured shared secret.
