# Webex Device APIs Developer Reference Guide

> Source: Webex for Developers (`https://developer.webex.com/docs/api/guides/device-developers-guide`)

## 1. REST Endpoints Overview

| Operation | Method | URI Pattern | Description |
| :--- | :--- | :--- | :--- |
| **List Devices** | `GET` | `/v1/devices?max=999&start=0` | Discover and monitor devices in org |
| **Get Device** | `GET` | `/v1/devices/{deviceId}` | Retrieve specific device connection/details |
| **Execute Command** | `POST` | `/v1/xapi/command/{commandKey}` | Invoke xCommand on a specific device |
| **Query Status** | `GET` | `/v1/xapi/status?deviceId={id}&name={key}` | Query current xStatus value |
| **Read Configurations**| `GET` | `/v1/deviceConfigurations?deviceId={id}&key={key}` | Read device configuration tree |
| **Update Configurations**| `PATCH`| `/v1/deviceConfigurations?deviceId={id}` | Modify device configuration via JSON Patch |

---

## 2. Invoking xCommands

### Endpoint
```http
POST https://webexapis.com/v1/xapi/command/{commandKey}
```
- Path segments in `{commandKey}` are period-separated (e.g. `UserInterface.Message.Prompt.Display`, `Bookings.CheckIn`, `Bookings.CheckOut`).
- Case sensitivity is unverified; always use the exact casing from the xAPI schema.

### Headers
```http
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: application/json
```

### Request Body Format
```json
{
  "deviceId": "Y2lzY29zcGFyazovL3VybjpURUFNOnVzLWVhc3QtMl9hL0RFVklDRS8yMzc1NTEzZS1hMzEyLTQyY2ItOGY5Zi02MGFlZDAwNWYyYTY=",
  "arguments": {
    "Title": "Keep this booking?",
    "Text": "Room use hasn't been detected recently...",
    "FeedbackId": "auto_release_warning_controller",
    "Option.1": "Keep Booking",
    "Option.2": "Check Out",
    "Duration": 300
  }
}
```

### Response Format
The response echoes `deviceId` and `arguments` and carries the command output under `result`. The shape of `result` depends on the command and is **unverified** here; do not rely on specific fields (an earlier `{"Instance": 1}` example was not confirmed).

---

## 3. Querying xStatus

### Endpoint
```http
GET https://webexapis.com/v1/xapi/status?deviceId={deviceId}&name={statusKey}
```

### Example Status Keys
- `RoomAnalytics.RoomInUse`: Returns `'True'` or `'False'`.
- `Bookings.Availability.Status`: Returns `'Free'`, `'FreeUntil'`, or `'BookedUntil'`.
- `Bookings.Availability.TimeStamp`: Returns UTC ISO string of deadline; empty when `Status` is `Free`.
- `Bookings.Current.Id`: Returns active booking ID.
- `Peripherals.ConnectedDevice`: Returns array of connected peripherals and controllers. Topology (`Type`, `Status`, `Role`) is readable but not subscribable, so it must be polled.

### Response Format
```json
{
  "deviceId": "Y2lzY29zcGFyazovL3VybjpURUFNOnVzLWVhc3QtMl9hL0RFVklDRS8yMzc1NTEzZS1hMzEyLTQyY2ItOGY5Zi02MGFlZDAwNWYyYTY=",
  "result": {
    "RoomAnalytics": {
      "RoomInUse": "False"
    }
  }
}
```

---

## 3a. Updating Configurations

Exact request the SDK sends for `xapi.config.set/setMany` (from `src/http.ts`):
```http
PATCH https://webexapis.com/v1/deviceConfigurations/?deviceId={deviceId}
Authorization: Bearer <access_token>
Content-Type: application/json-patch+json
```
```json
[
  { "op": "replace", "path": "Bookings.CheckIn.Enabled/sources/configured/value", "value": "False" }
]
```
Each configuration becomes one `replace` operation whose `path` is `<Key>/sources/configured/value`.

---

## 4. Notification Payloads (Long Polling and Webhooks)

Notifications (delivered through long polling in this project; webhooks are deferred) are JSON payloads representing status changes or event triggers. Only paths on the supported subscriptions list (`https://xapi-a.wbx2.com/xapi/api/apps/supportedSubscriptions`) are delivered; `Bookings.CheckedIn` is not.

- Status notifications carry `isFullSync`. A full state sync arrives roughly every 60 minutes even when nothing changed (`isFullSync: true`).
- Each entry in an events notification has its own `timestamp`.
- The SDK also defines a `healthCheck` notification type.

### Status Notification Example (`RoomAnalytics.RoomInUse`)
```json
{
  "type": "status",
  "appId": "C12ba...",
  "orgId": "4590eb6a...",
  "workspaceId": "Y2lzY29zcGFyazov...",
  "deviceId": "Y2lzY29zcGFyazovL3VybjpURUFNOnVzLWVhc3QtMl9hL0RFVklDRS8yMzc1...",
  "timestamp": "2026-09-15T08:30:00.000Z",
  "changes": {
    "updated": {
      "RoomAnalytics.RoomInUse": "False"
    },
    "removed": []
  },
  "isFullSync": false
}
```

### Event Notification Example (`UserInterface.Message.Prompt.Response`)
```json
{
  "type": "events",
  "appId": "C12ba...",
  "orgId": "4590eb6a...",
  "workspaceId": "Y2lzY29zcGFyazov...",
  "deviceId": "Y2lzY29zcGFyazovL3VybjpURUFNOnVzLWVhc3QtMl9hL0RFVklDRS8yMzc1...",
  "timestamp": "2026-09-15T08:32:15.120Z",
  "events": [
    {
      "key": "UserInterface.Message.Prompt.Response",
      "value": {
        "FeedbackId": "auto_release_warning_controller",
        "OptionId": 1
      },
      "timestamp": "2026-09-15T08:32:15.120Z"
    }
  ]
}
```
`OptionId` is an integer in the xAPI schema; normalise it with `String()` before comparing.

---

## 5. Rate Limits and 429 Handling

Webex APIs enforce rate limits (the exact algorithm and scope are unverified).
- **HTTP 429 Too Many Requests**: Returned when threshold is exceeded. The Node.js SDK throws with `retryAfter` and does not retry.
- **Header `Retry-After`**: Specifies seconds to wait before retrying.
- **Mitigation**:
  1. Per-device in-memory command queue honoring `Retry-After`.
  2. Jittered exponential backoff honoring `Retry-After`.
  3. Coalescing bursts of status queries into single batched lookups where possible.
