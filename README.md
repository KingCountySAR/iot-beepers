# SAR Notifier

A dedicated, loud pager for SAR callouts. It's a cheap ESP32 box on the member's home Wi-Fi with a piezo alarm, an LED, a button and an arm/quiet switch. The central server forwards pages to it, tracks who received and acknowledged them, monitors device health, and pushes firmware updates.

```
 callout source ──POST /api/ingest/page──┐
 web UI "Send page" ─────────────────────┤
                                         ▼
                ┌───────────────────────────────────────┐
                │ server (Node, Hono)                   │
                │  • REST API + React web UI            │      wss://host/mqtt
                │  • embedded MQTT broker (aedes) ──────┼──────────────────────► pagers
                │  • Postgres (Drizzle)                 │◄── status/ack/events ──
                │  • firmware store + OTA rollout       │
                └───────────────────────────────────────┘
```

| Dir | What |
|---|---|
| `server/` | Hono API, embedded MQTT broker, Drizzle/Postgres. Tests in `server/test` |
| `web/` | Vite + React admin and member UI |
| `firmware/` | ESP-IDF app ([firmware/README.md](firmware/README.md)) |
| `deploy/` | Docker Compose + Caddy for a single VM |
| `docs/` | [protocol](docs/protocol.md), [hardware](docs/hardware.md) |

## How a member sets up a pager
1. Plug it in. The LED is mostly on: it's in setup mode.
2. On a phone, join the `SAR-Pager-xxxx` Wi-Fi. The setup page opens; if it doesn't, browse to `http://192.168.4.1`.
3. Choose the home Wi-Fi, enter its password, and confirm the server URL. The pager joins the network, registers with the server, and shows a **pairing code** and link.
4. Rejoin home Wi-Fi, open the link, log in, and pick which channels the pager should alarm for.
5. The LED settles to a short blip every 5 s. Press the button: one chirp means all good.

Pairing happens on the server, never on the device. The pager only holds a random secret, so no member passwords live on it. Channel choices are made from any browser, and a replacement pager is just a re-pair.

## Design notes
- **Embedded broker.** For 20–100 devices, an in-process MQTT broker means one container and no broker credentials to keep in sync. Device auth checks the DB directly. Each device can only use its own `dev/<id>/…` topics.
- **MQTT over WebSocket on 443.** One port and one TLS certificate (Caddy/Let's Encrypt), and it gets through hotel/guest networks.
- **Delivery tracking.** Every page has per-device *sent / received / acknowledged* timestamps. Devices that were offline get unexpired pages replayed when they reconnect. Pages older than 10 min arrive silently (LED only), so nobody gets a 3 am alarm for yesterday's mission.
- **Silent failure is the enemy.** The dashboard lists paired pagers that are offline, and the pager itself chirps if it can't reach the server for 30 min.
- **OTA with rollback.** Uploaded images are validated (project name and version are read from the image). You can pin one device to a version to canary it, then make it the default. A bad image rolls itself back.
- **Postgres in production, PGlite in dev/tests.** With no `DATABASE_URL`, the server runs Postgres-in-WASM in-process, so there's nothing to install locally. It runs the same SQL and migrations.

## Development
Requires Node 22+.

```sh
npm install
cp server/.env.example server/.env   # sets the dev admin password
npm run dev                          # server :8080 + Vite :5173 (proxies /api and /mqtt)
npm test                             # server integration tests (PGlite)
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm test   # same, against real Postgres
```

Log in at http://localhost:5173 as `admin` with the password from `.env`. Create a channel, then pair a device.

**Without hardware**, simulate a device with the helpers in `server/test/harness.ts`. They do the same register → MQTT → hello flow as the firmware.

**Schema changes:** edit `server/src/db/schema.ts`, then run `npm run db:generate -w server`. Migrations run on startup.

Send a page from another system:

```sh
curl -X POST https://host/api/ingest/page \
  -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"callout","title":"Callout","body":"Lost hiker near Mt Si trailhead."}'
```

## Deploy (Azure VM + Docker)
```sh
cp deploy/.env.example deploy/.env   # set DOMAIN, passwords, INGEST_TOKEN
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d --build
```

Open ports 80 and 443 on the VM's network security group. To use Azure Database for PostgreSQL instead, set `DATABASE_URL` and remove the `db` service.

## Not done yet
- **Ingest from email/SMS.** The plumbing is `POST /api/ingest/page`. Add an inbound-email webhook (Postmark/Mailgun/SES) or a Twilio number that calls it.
- **Notify members when their pager goes offline**, by email/SMS. The dashboard already lists offline paired pagers.
- **Real auth.** Accounts are local username/password for now. Swap in the team's SSO (OIDC) in `server/src/auth.ts`.
- Rate limiting on `/api/device/register` and `/api/auth/login`.
- Signed firmware images (see docs/hardware.md).
- A custom PCB: see docs/hardware.md for the daughter-board sketch and the alarm drive options.
