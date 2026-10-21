# Workspace Integrations Node.js SDK Specification

> Official SDK: `workspace-integrations` (`https://github.com/cisco-ce/workspace-integrations-nodejs`)

## 1. Installation

```bash
npm install --save workspace-integrations
```

## 2. Core SDK Interfaces & Architecture

### Connection & Lifecycle
```typescript
import { connect, IntegrationConfig, Integration } from 'workspace-integrations';

const config: IntegrationConfig = {
  clientId: process.env.WEBEX_CLIENT_ID,
  clientSecret: process.env.WEBEX_CLIENT_SECRET,
  activationCode: {
    oauthUrl: process.env.WEBEX_OAUTH_URL,
    refreshToken: process.env.WEBEX_REFRESH_TOKEN,
    webexapisBaseUrl: 'https://webexapis.com/v1',
    appUrl: process.env.WEBEX_APP_URL,
  },
  notifications: 'longpolling', // 'webhook' | 'longpolling' | 'none'; this project uses 'longpolling'
  logLevel: 'info',
};

const integration: Integration = await connect(config);
// With 'longpolling', connect() starts the poll loop itself. There is no public
// pollData() to call and no method to stop polling; poll errors are logged and
// retried every 5 s. Shutdown = close the roster gate and exit (see LLD §7.2, §9).
```

- `activationCode` must be the **decoded** activation JWT as an object (`oauthUrl`, `refreshToken`, `webexapisBaseUrl`, `appUrl`). The SDK does not decode it; passing the raw JWT string fails `validateConfig` with "Please decode it and provide the required attributes as a JSON object".
- The activation code is valid for 24 hours after activation. The SDK refreshes the access token 15 minutes before the `expires_in` reported by the token response.

Webhook variant (deferred; not used by this project):
```typescript
const webhookConfig: IntegrationConfig = {
  ...config,
  notifications: 'webhook',
  webhook: {
    targetUrl: 'https://autocancel-service.enterprise.com/api/v1/webex/notifications',
    type: 'hmac_signature', // 'hmac_signature' | 'basic_authentication' | 'none'
    secret: process.env.WEBEX_WEBHOOK_SECRET,
  },
};
```
The SDK registers the webhook with this type but does not verify incoming signatures.

### Reading Status & Listening to Notifications
```typescript
// Query current status for a device
const roomInUse = await integration.xapi.status.get(deviceId, 'RoomAnalytics.RoomInUse');

// Subscribe to status changes (triggered via webhook/longpolling)
integration.xapi.status.on('RoomAnalytics.RoomInUse', (deviceId, path, value, notification) => {
  console.log(`Device ${deviceId} occupancy changed to: ${value}`);
});

// Subscribe to events (e.g. Prompt Response)
integration.xapi.event.on('UserInterface.Message.Prompt.Response', (deviceId, path, event, notification) => {
  // OptionId is an integer in the xAPI schema; normalise before comparing.
  const optionId = String(event.OptionId);
  console.log(`Device ${deviceId} prompt response: FeedbackId=${event.FeedbackId}, OptionId=${optionId}, Origin=${event.Origin}`);
});
```

- Callbacks: `status.on` → `(deviceId, path, value, notification)`; `event.on` → `(deviceId, path, event, notification)`.
- Path matching is a case-insensitive **substring** match (spaces are treated as dots; `*` is not a wildcard). Subscribing to `'Bookings.Availability'` also fires for `Bookings.Availability.Status` and `.TimeStamp`; a short pattern can match more paths than intended, so check `path` inside the callback.
- Only paths on the supported subscriptions list ever arrive (`https://xapi-a.wbx2.com/xapi/api/apps/supportedSubscriptions`). `Bookings.CheckedIn` and `Peripherals.ConnectedDevice` topology never do; read them with `status.get`.

### Sending xCommands
```typescript
// Display actionable warning prompt
await integration.xapi.command(deviceId, 'UserInterface.Message.Prompt.Display', {
  Title: 'Keep this booking?',
  Text: "Room use hasn't been detected recently...",
  FeedbackId: 'auto_release_warning_controller',
  'Option.1': 'Keep Booking',
  'Option.2': 'Check Out',
  Duration: 300,
});

// Perform Booking CheckIn (always identity-bound, as in the macro)
await integration.xapi.command(deviceId, 'Bookings.CheckIn', {
  Id: bookingId,
  TrackingData: 'BookingAutoCancellation_Automatic',
});

// Perform Booking CheckOut (Release room; never Bookings.Delete)
await integration.xapi.command(deviceId, 'Bookings.CheckOut', { Id: bookingId });
```

### Reading and Writing Configurations
```typescript
// Requires spark-admin:devices_read + spark-admin:devices_write; not listed in xapiAccess
const enabled = await integration.xapi.config.get(deviceId, 'Bookings.CheckIn.Enabled');
await integration.xapi.config.set(deviceId, 'Bookings.CheckIn.Enabled', 'False');
await integration.xapi.config.setMany(deviceId, {
  'RoomAnalytics.PeoplePresenceDetector': 'On',
  'RoomAnalytics.PeoplePresence.Input.HeadDetector': 'On',
});
```

### Listing Devices
```typescript
// Query devices registered in organization
const devices = await integration.devices.getDevices();
// Filter by workspace, product type, or connectionStatus.
// connectionStatus is 'connected' | 'disconnected' | 'connected_with_issues' | string;
// 'connected_with_issues' is still reachable, so treat it as connected.
const isConnected = (s: string) => s === 'connected' || s === 'connected_with_issues';
const connectedCodecs = devices.filter(d => isConnected(d.connectionStatus));
```

### Errors and Rate Limits
- On HTTP `429` the SDK throws an `Error` whose JSON message includes `retryAfter` (from the `Retry-After` header). It does **not** retry. The caller must back off (this project: per-device command queue honoring `Retry-After` with jitter; see LLD §9).
- Location-limited activation: commands and status reads for devices outside the permitted locations return `403 Forbidden`; device listing and configuration writes still work org-wide.
