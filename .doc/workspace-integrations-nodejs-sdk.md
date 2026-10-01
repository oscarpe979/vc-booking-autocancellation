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
  notifications: 'webhook', // 'webhook' | 'longpolling' | 'none'
  webhook: {
    targetUrl: 'https://autocancel-service.enterprise.com/api/v1/webex/notifications',
    type: 'hmac_signature',
    secret: process.env.WEBEX_WEBHOOK_SECRET,
  },
  logLevel: 'info',
};

const integration: Integration = await connect(config);
```

### Reading Status & Listening to Notifications
```typescript
// Query current status for a device
const roomInUse = await integration.xapi.status.get(deviceId, 'RoomAnalytics.RoomInUse');

// Subscribe to status changes (triggered via webhook/longpolling)
integration.xapi.status.on('RoomAnalytics.RoomInUse', (deviceId, path, value) => {
  console.log(`Device ${deviceId} occupancy changed to: ${value}`);
});

// Subscribe to events (e.g. Prompt Response)
integration.xapi.event.on('UserInterface.Message.Prompt.Response', (deviceId, path, event) => {
  console.log(`Device ${deviceId} prompt response: FeedbackId=${event.FeedbackId}, OptionId=${event.OptionId}`);
});
```

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

// Perform Booking CheckIn
await integration.xapi.command(deviceId, 'Bookings.CheckIn');

// Perform Booking CheckOut (Release room)
await integration.xapi.command(deviceId, 'Bookings.CheckOut');
```

### Listing Devices
```typescript
// Query devices registered in organization
const devices = await integration.devices.getDevices();
// Filter by workspace, product type, or connectionStatus:
const connectedCodecs = devices.filter(d => d.connectionStatus === 'connected');
```
