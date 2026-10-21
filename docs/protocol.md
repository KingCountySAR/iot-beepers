# Device ↔ server protocol

The source of truth is `server/src/protocol.ts`. Firmware side: `firmware/main/link.c`.

## 1. Registration (HTTPS)

`POST {server}/api/device/register`, called during setup and on every boot.

```json
{ "id": "a1b2c3d4e5f6", "secret": "<64 hex chars>", "fw": "0.1.0", "hw": "devkit" }
```

- `id`: the Wi-Fi MAC as lowercase hex.
- `secret`: 32 random bytes generated on first boot and kept in NVS (namespace `ident`). A factory reset (holding the button 15s) keeps it; only a full flash erase loses it. The server stores only its SHA-256.

The response for an unclaimed device:

```json
{ "claimed": false, "mqttUrl": "wss://host/mqtt", "claimCode": "K7QP3M", "claimUrl": "https://host/pair?code=K7QP3M" }
```

For a claimed device: `{ "claimed": true, "mqttUrl": "...", "owner": "Pat Doe", "name": "Bedside" }`.

How the server treats the device:
- An unknown id gets a new device record (trust on first use).
- A known id with the matching secret is accepted. If it's unclaimed, it gets a fresh claim code when the old one is near expiry. Codes last 30 minutes.
- A known id with a different secret is accepted only while the device is unclaimed. A claimed device gets **409** until an admin uses "Reset identity" in the UI, which makes the server accept the next secret it sees.

## 2. MQTT over WebSocket

- URL: `wss://{host}/mqtt` (in dev, `ws://`). MQTT 3.1.1.
- Credentials: client id = username = device id; password = the secret.
- Keepalive is 30 s, so the server marks a device offline within about 45 s of the link dying.

A device may only subscribe to `dev/{id}/#` and may only publish to its own `status`, `ack` and `event` topics. Anything else disconnects it.

### Device → server

| Topic | Payload | When |
|---|---|---|
| `dev/{id}/status` | `{"type":"hello","fw":"0.1.0","hw":"devkit","reset":"power-on","armed":true,"rssi":-61,"ip":"192.168.1.50","uptime":12,"heap":151000}` | After each (re)connect, once subscribed |
| `dev/{id}/status` | same shape with `"type":"heartbeat"`, no `hw` or `reset` | Every 60 s, and right away when the switch moves |
| `dev/{id}/ack` | `{"page":42,"state":"received"}` | When a page arrives (duplicates included) |
| `dev/{id}/ack` | `{"page":42,"state":"acked"}` | When the member presses the button |
| `dev/{id}/event` | `{"type":"ota_failed","detail":"download: ESP_ERR_HTTP_CONNECT"}` | OTA progress, rollbacks |

### Server → device (QoS 1)

| Topic | Payload |
|---|---|
| `dev/{id}/config` | `{"claimed":true,"name":"Bedside","channels":["callout","training"]}` |
| `dev/{id}/page` | `{"id":42,"ch":"callout","title":"Callout","body":"Lost hiker…","alarm":true,"ts":1761030000}` |
| `dev/{id}/cmd` | `{"cmd":"test"}`, `{"cmd":"identify"}`, `{"cmd":"reboot"}` |
| `dev/{id}/cmd` | `{"cmd":"ota","version":"0.2.0","url":"https://host/api/device/firmware/0.2.0","sha256":"…","size":1178304}` |

### What the server does on `hello`
1. Sends `config`.
2. Re-sends every unexpired page this device hasn't confirmed receiving. Pages last 2 h by default; `PAGE_TTL_MIN` changes that.
3. Sends an OTA command if the device's target version differs from what it's running. It won't repeat this more than once per `OTA_RETRY_MIN`.

### Alarm vs. silent delivery
The server sets `alarm` when the page is younger than `ALARM_WINDOW_MIN` (default 10 min). If a pager reconnects in the morning, overnight pages flash the LED but don't sound. The device keeps a list of the last 16 page ids, so a replayed page never alarms twice.

## 3. OTA

The device downloads `url` with `esp_https_ota` and checks two things:
- The image's embedded version must equal `version`.
- The image's own appended SHA-256 must verify. ESP-IDF does this check in `esp_https_ota_finish`.

`sha256` in the command is the hash of the whole `.bin`. The device doesn't check it; it's there for the admin's audit trail. After rebooting, the new image is *pending verify*. It must connect to the server within 5 minutes or the bootloader rolls back to the previous image. The device then reports `ota_rollback` once.

Firmware downloads are unauthenticated, because images contain no secrets. To guarantee the images are authentic as well as intact, enable signed app images in ESP-IDF; see `docs/hardware.md` § "Before production".
