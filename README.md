# SAR Beepers

A dedicated, loud pager for SAR callouts. It's a cheap ESP32 box on the member's home Wi-Fi with a buzzer alarm, status and alert LEDs, a button and an arm/quiet switch. The central server forwards pages to it, tracks who received and acknowledged them, monitors device health, and pushes firmware updates.

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
| `deploy/` | Its app on the KCSARA VM (the [vm](../vm) repo) |
| `hardware/` | Carrier board for the XIAO ESP32C3 ([rev1](hardware/rev1/README.md)) |
| `docs/` | [protocol](docs/protocol.md), [hardware behaviour](docs/hardware.md), [metrics](docs/metrics.md) |

## How a member sets up a pager
1. Plug it in. The green LED is mostly on: it's in setup mode.
2. On a phone, join the `SAR-Pager-xxxx` Wi-Fi. The setup page opens; if it doesn't, browse to `http://192.168.4.1`.
3. Choose the home Wi-Fi, enter its password, and confirm the server URL. The pager joins the network, registers with the server, and shows a **pairing code** and link.
4. Rejoin home Wi-Fi, open the link, sign in, and pick which channels the pager should alarm for.
5. The green LED settles to a short blip every 5 s. Press the button: one chirp means all good.

Pairing happens on the server, never on the device. The pager only holds a random secret, so no member passwords live on it. Channel choices are made from any browser, and a replacement pager is just a re-pair.

## Design notes
- **Embedded broker.** For 20–100 devices, an in-process MQTT broker means one container and no broker credentials to keep in sync. Device auth checks the DB directly. Each device can only use its own `dev/<id>/…` topics.
- **MQTT over WebSocket on 443.** One port and one TLS certificate (the VM's Caddy and Let's Encrypt), and it gets through hotel/guest networks.
- **Delivery tracking.** Every page has per-device *sent / received / acknowledged* timestamps. Devices that were offline get unexpired pages replayed when they reconnect. Pages older than 10 min arrive silently (LED only), so nobody gets a 3 am alarm for yesterday's mission.
- **Silent failure is the enemy.** The dashboard lists paired pagers that are offline, and the pager itself chirps if it can't reach the server for 30 min.
- **OTA with rollback.** Uploaded images are validated (project name and version are read from the image). You can pin one device to a version to canary it, then make it the default. A bad image rolls itself back.
- **Postgres in production, PGlite in dev/tests.** With no `DATABASE_URL`, the server runs Postgres-in-WASM in-process, so there's nothing to install locally. It runs the same SQL and migrations.

## Development
Requires Node 22+.

```sh
npm install
cp server/.env.example server/.env.local   # then put your email in SITE_ADMINS
npm run dev                          # UI :4100 (Vite, proxies /api and /mqtt to the server on :4102), metrics :4101
npm test                             # server integration tests (PGlite)
TEST_DATABASE_URL=postgres://postgres:pw@localhost:5432/postgres npm test   # same, against real Postgres
```

Open http://localhost:4100 and sign in with your `SITE_ADMINS` email. In dev, `DEV_LOGIN=true` lets you type an email instead of going through Google (treated as managed by its address's domain, which must be one of `ALLOWED_DOMAINS`). Create a channel, then pair a device.

The UI is on :4100 and metrics on :4101 in production too. Dev ports and URLs come from `server/dev.env`; `server/.env` overrides them, and `server/.env.local` (gitignored, for your own settings) overrides both.

**Without hardware**, simulate a device with the helpers in `server/test/harness.ts`. They do the same register → MQTT → hello flow as the firmware.

**Schema changes:** edit `server/src/db/schema.ts`. Until the first release we don't keep migrations: delete `server/drizzle/`, run `npm run db:generate -w server` to regenerate `0000_init`, and update existing databases by hand (or delete `server/data/` in dev). Migrations run on startup.

**Pages by email:** mail to `<channel slug>@beepers.kingcountysar.org` pages that channel, through the KCSARA VM's
mail service (the vm repo's [mail/README.md](../vm/mail/README.md)), which checks SPF and DKIM and POSTs it to
`/api/ingest/email` with `INGEST_TOKEN`. The subject is the page's title and the text its body, without a signature
after "-- ". An unknown channel bounces. To set it up: a route in the VM's `config/mail.env`, with `INGEST_TOKEN` and
who may send, and an MX record for `beepers.kingcountysar.org` pointing at the mail host:

```
ROUTE_BEEPERS=beepers.kingcountysar.org http://beepers:4100/api/ingest/email
ROUTE_BEEPERS_TOKEN=<INGEST_TOKEN>
ROUTE_BEEPERS_SENDERS=<who may page: addresses, or @domain>
```

Send a page from another system:

```sh
curl -X POST https://host/api/ingest/page \
  -H "Authorization: Bearer $INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"callout","title":"Callout","body":"Lost hiker near Mt Si trailhead."}'
```

## Deploy
It runs on the KCSARA VM as the app `beepers`, at https://beepers.kingcountysar.org, deployed by the [vm](../vm) repo
(see "Apps" in its README). The VM's Caddy gives it its certificate and proxies the site, `/mqtt` included, and it uses
the VM's shared Postgres, cedar and Hydra over the `kcsara` network. `deploy/compose.yaml` runs the build on
`node:22-alpine`: `npm run build` makes one bundle, `server/dist/beepers.mjs`, which `deploy/app.json` sends with the
migrations (`server/drizzle`) and the web UI (`web/dist`). Firmware images are in the database.

The first time, from the vm repo:

1. `node deploy.mjs database beepers`: its database and user, in `apps/beepers/config/database.env` on the VM.
2. A Hydra client for cedar: `node hydra.mjs create oauth2-client --name beepers --grant-type client_credentials --scope members.read --format json`.
3. On the VM, `apps/beepers/config/app.env` from [deploy/app.env.example](deploy/app.env.example): `PUBLIC_URL`, the
   admins and domains, the Google client (below), the Hydra client, and `INGEST_TOKEN`.
4. DNS for `beepers.kingcountysar.org` pointed at the VM (or a test name in `HOSTS=`, in `apps/beepers/config/compose.env`,
   with `PUBLIC_URL` to match).

Then, and for each deploy: `npm run build` here, and `node deploy.mjs app ../beepers` from the vm repo.
`node deploy.mjs logs beepers` shows its log. Pagers reconnect by themselves after a deploy.

The VM's Prometheus collects its metrics (the `kcsara.metrics` label; see [docs/metrics.md](docs/metrics.md)), and its
health checks ask for `/healthz`.

**Running the build in Docker** on a dev machine, as on the VM: with `docker compose up` running in ../vm, make its
database once (`docker compose exec postgres createdb -U postgres beepers` there), then `npm run build` and
`npm run docker -- up -d` here (`npm run docker -- down` stops it). It's on http://localhost:4100, with the settings from
`server/dev.env`, `.env` and `.env.local`, then `server/.env.docker.local` for what differs in Docker. See
[deploy/compose.local.yaml](deploy/compose.local.yaml).

**Sign-in** is Google only, with Google's sign-in button (no redirects), as in rad-portal: anyone whose account is managed by one of the Workspace domains in `ALLOWED_DOMAINS` can sign in, and admins are the emails in `SITE_ADMINS` (changes take effect on restart). **Which channels** a member can join comes from their groups in the member database, mapped to channels on the **Access** page, plus any direct grants an admin adds there. A daily sync drops subscriptions people no longer qualify for. See [docs/members.md](docs/members.md). To create the OAuth client:
1. In [Google Cloud Console](https://console.cloud.google.com/), pick or create a project. Under **Google Auth Platform → Branding**, set the app name and support email.
2. Under **Audience**, choose **External** (members use their own Google accounts) and **publish** the app. It only asks for name and email, so Google doesn't need to review it. Left in testing mode, only listed test users can sign in.
3. Under **Clients**, create a **Web application** client with the **Authorized JavaScript origins** `https://beepers.kingcountysar.org` (`PUBLIC_URL`) and, for dev, `http://localhost:4100`. It needs no redirect URIs. Put its client ID in `GOOGLE_CLIENT_ID`; there's no secret to keep.

Google only allows plain-HTTP origins on localhost, so in dev sign in at http://localhost:4100, not `http://10.1.1.142:4100`.

**Firmware:** run `firmware/build.sh <board>` and upload the `dist/` image on the **Firmware** page. Members can then flash new pagers from the **Flash** page in Chrome or Edge, and updates roll out over Wi-Fi per board. See [firmware/README.md](firmware/README.md).

## Not done yet
- **Ingest from SMS.** The plumbing is `POST /api/ingest/page`: a Twilio number could call it.
- **Notify members when their pager goes offline**, by email/SMS. The dashboard already lists offline paired pagers.
- Rate limiting on `/api/device/register`.
- Signed firmware images (see docs/hardware.md).
- A custom PCB: see docs/hardware.md for the daughter-board sketch and the alarm drive options.
