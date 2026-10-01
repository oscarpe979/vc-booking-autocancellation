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
- Case-insensitive.

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
```json
{
  "deviceId": "Y2lzY29zcGFyazovL3VybjpURUFNOnVzLWVhc3QtMl9hL0RFVklDRS8yMzc1NTEzZS1hMzEyLTQyY2ItOGY5Zi02MGFlZDAwNWYyYTY=",
  "arguments": { ... },
  "result": {
    "Instance": 1
  }
}
```

---

## 3. Querying xStatus

### Endpoint
```http
GET https://webexapis.com/v1/xapi/status?deviceId={deviceId}&name={statusKey}
```

### Example Status Keys
- `RoomAnalytics.RoomInUse`: Returns `'True'` or `'False'`.
- `Bookings.Availability.Status`: Returns `'Free'`, `'FreeUntil'`, or `'BookedUntil'`.
- `Bookings.Availability.TimeStamp`: Returns UTC ISO string of deadline.
- `Bookings.Current.Id`: Returns active booking ID.
- `Peripherals.ConnectedDevice`: Returns array of connected peripherals and controllers.

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

## 4. Webhook Notification Payloads

Webhooks delivered to the service target URL are JSON payloads representing status changes or event triggers.

### Status Notification Example (`RoomAnalytics.RoomInUse`)
```json
{
  "version": "1.0.0",
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
  }
}
```

### Event Notification Example (`UserInterface.Message.Prompt.Response`)
```json
{
  "version": "1.0.0",
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
        "OptionId": "1"
      }
    }
  ]
}
```

---

## 5. Rate Limits and 429 Handling

Webex APIs enforce token-bucket rate limits per client application and per organization.
- **HTTP 429 Too Many Requests**: Returned when threshold is exceeded.
- **Header `Retry-After`**: Specifies seconds to wait before retrying.
- **Mitigation**:
  1. Priority queues (e.g. BullMQ) for outbound commands.
  2. Jittered exponential backoff honoring `Retry-After`.
  3. Coalescing bursts of status queries into single batched lookups where possible.
