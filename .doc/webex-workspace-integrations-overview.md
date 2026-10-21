# Webex Workspace Integrations - Overview and Architectural Reference

> Source: Webex for Developers (`https://developer.webex.com/create/docs/workspace-integrations`)

## 1. Executive Summary

Workspace Integrations provide a cloud-based framework for external services to interact with Cisco collaboration devices, sensors, and workspaces. Unlike on-device macros (which execute locally in QuickJS on each device), Workspace Integrations execute externally as centralized services while interacting with device xAPIs over Webex Cloud APIs.

### Key Characteristics
- **Centralized Deployment**: No code or macros need to be provisioned onto individual room devices.
- **Service Identity**: Operates under a machine account created in the customer organization rather than on behalf of an individual user.
- **Granular xAPI Access Rules**: Strict security manifest specifies exact xCommands, xStatuses, and xEvents permitted.
- **Delivery Mechanisms**: Supports both Webhooks (cloud-to-service push) and Long Polling (service-to-cloud pull). This project uses long polling; webhooks are deferred.
- **Limited Subscriptions**: Not every xStatus or xEvent can be subscribed to. Only entries on the live supported list (`https://xapi-a.wbx2.com/xapi/api/apps/supportedSubscriptions`) produce notifications. Notably, the `Bookings.CheckedIn` event is **not** subscribable, and `Peripherals.ConnectedDevice` topology (`Type`, `Status`, `Role`) is **not** subscribable (only `Peripherals.ConnectedDevice[*].RoomAnalytics.*` sensor values are). Those must be read on demand with `status.get` (see LLD §5.9 and §5.11).
- **Location & Scope Isolation**: Can be activated tenant-wide or for specific locations. Per the SDK README, a location-limited integration gets `403 Forbidden` on commands and status reads for devices outside the permitted locations, but can still list all org devices and change device configurations org-wide.

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
|   |          In-Memory Room Registry & Hardware Abstraction Layer           |   |
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
4. Device configurations (xConfig) are **not** listed under `xapiAccess`. Reading and writing them (RoomAnalytics presence baseline, `Bookings.CheckIn.WindowDuration`, `Bookings.CheckIn.Enabled`) requires the `spark-admin:devices_read` and `spark-admin:devices_write` scopes, and uses `integration.xapi.config.get/set/setMany` in the Node.js SDK.

### Manifest for Booking Autocancellation

Notes:
- `id` is the manifest's UUID (the official editor generates it for a new manifest); the value below is a placeholder.
- `manifestVersion` is the manifest's own revision number, not a schema version. Increase it each time the manifest is re-uploaded to Control Hub (the editor increments it on every export).
- `Bookings.Availability.*` is the subscribable form of the availability status. `Peripherals.ConnectedDevice[*].*` grants `status.get` reads of controller topology; topology changes still produce no notifications.
- `access: "optional"` is valid in the manifest format (the editor's "Required" checkbox toggles between `required` and `optional`). The `Bookings.Start`, `Bookings.End`, and `Bookings.Deleted` events are informational only and never drive safety decisions (see LLD §9).

```json
{
  "id": "00000000-0000-4000-8000-000000000000",
  "manifestVersion": 2,
  "displayName": "Enterprise Booking Autocancellation Service",
  "vendor": "Enterprise Collaboration Engineering",
  "email": "collab-admin@enterprise.com",
  "description": "Centralized, vendor-agnostic booking autocancellation and occupancy release service for meeting rooms.",
  "availability": "org_private",
  "apiAccess": [
    {
      "scope": "spark-admin:devices_read",
      "access": "required",
      "role": "id_readonly_admin"
    },
    {
      "scope": "spark-admin:devices_write",
      "access": "required"
    },
    {
      "scope": "spark-admin:workspaces_read",
      "access": "required",
      "role": "id_readonly_admin"
    },
    {
      "scope": "spark:xapi_statuses",
      "access": "required"
    },
    {
      "scope": "spark:xapi_commands",
      "access": "required"
    }
  ],
  "xapiAccess": {
    "status": [
      {
        "path": "RoomAnalytics.RoomInUse",
        "access": "required"
      },
      {
        "path": "Bookings.Availability.*",
        "access": "required"
      },
      {
        "path": "Bookings.Current.Id",
        "access": "required"
      },
      {
        "path": "Peripherals.ConnectedDevice[*].*",
        "access": "required"
      },
      {
        "path": "SystemUnit.ProductPlatform",
        "access": "required"
      },
      {
        "path": "SystemUnit.Uptime",
        "access": "required"
      },
      {
        "path": "Time.SystemTime",
        "access": "required"
      }
    ],
    "commands": [
      {
        "path": "UserInterface.Message.Prompt.Display",
        "access": "required"
      },
      {
        "path": "UserInterface.Message.Prompt.Clear",
        "access": "required"
      },
      {
        "path": "Bookings.CheckIn",
        "access": "required"
      },
      {
        "path": "Bookings.CheckOut",
        "access": "required"
      },
      {
        "path": "Bookings.Get",
        "access": "required"
      },
      {
        "path": "Bookings.List",
        "access": "required"
      },
      {
        "path": "Audio.Volume.Set",
        "access": "required"
      },
      {
        "path": "Audio.Volume.SetToDefault",
        "access": "required"
      },
      {
        "path": "Audio.Sound.Play",
        "access": "required"
      }
    ],
    "events": [
      {
        "path": "UserInterface.Message.Prompt.Response",
        "access": "required"
      },
      {
        "path": "UserInterface.Message.Prompt.Cleared",
        "access": "required"
      },
      {
        "path": "BootEvent",
        "access": "optional"
      },
      {
        "path": "Bookings.Start",
        "access": "optional"
      },
      {
        "path": "Bookings.End",
        "access": "optional"
      },
      {
        "path": "Bookings.Deleted",
        "access": "optional"
      }
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
3. **Activation**: Admin clicks *Activate* (selecting target locations/org-wide). Webex issues a signed Activation JWT (`activationCode`). The activation code is valid for only 24 hours, so the service must connect within 24 hours of activation.
4. **JWT Decoding**: Service decodes the JWT (the SDK does not decode it; `connect()` takes the decoded object) to extract:
   - `oauthUrl`: Token endpoint (`https://webexapis.com/v1/access_token`).
   - `refreshToken`: Refresh token for the machine account.
   - `appUrl`: Endpoint for pinging/initializing integration details.
   - `webexapisBaseUrl`: REST API root (`https://webexapis.com/v1`).
5. **Token Exchange**: Service exchanges `refreshToken` + `clientId` + `clientSecret` (`grant_type: refresh_token`) for a short-lived `access_token`. Its lifetime comes from the token response (`expires_in`); do not assume a fixed value.
6. **Automatic Refresh**: The SDK refreshes the access token 15 minutes before it expires.
7. **Webhook Security** (webhooks deferred; not used by this project): the SDK accepts webhook `type` values `hmac_signature`, `basic_authentication`, or `none` when registering a webhook, but it does not verify incoming signatures. Signature header format and algorithm are unverified.
