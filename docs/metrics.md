# Metrics

Admin metrics go to Prometheus and Grafana. The web UI keeps what members need: each pager's status, its event log, and who received and acknowledged each page.

## Scraping
The server serves `GET /metrics` on its own port, `METRICS_PORT` (default 4101; `0` turns it off). Caddy only proxies the main port, so metrics are never public. On the KCSARA VM, Prometheus's `apps` job collects it over the `kcsara` network, from the `kcsara.metrics` label in `deploy/compose.yaml`, with the labels `job="apps"`, `app="beepers"` and `service="beepers"`. That job sends no token, so leave `METRICS_TOKEN` unset there. For a Prometheus of your own, set `METRICS_TOKEN` to require a bearer token:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: sar-beepers
    authorization:
      credentials: <METRICS_TOKEN>   # omit if unset
    static_configs:
      - targets: ['10.0.0.4:4101']

rule_files:
  - sar-beepers.rules.yml           # monitoring/sar-beepers.rules.yml
```

## What's exported
Counters and histograms live in memory and reset when the server restarts, which `rate()` and `increase()` handle. Device gauges are read from the database on every scrape.

### Devices
There's no series per pager: these count them, and the web UI shows each one (its status, its log, and who has it).
Labels have only a few values each, so the number of series stays the same however many pagers there are.

| Metric | Type | Notes |
|---|---|---|
| `sar_devices{board,fw_version,paired,online}` | gauge | How many devices. `paired` and `online` are `true` or `false`; `board` and `fw_version` are empty until a pager says |
| `sar_devices_offline_30m` | gauge | Paired pagers not heard from for over 30 minutes, when the pager itself starts chirping. The web UI's dashboard lists which |
| `sar_devices_quiet` | gauge | Paired pagers with the switch on quiet |
| `sar_devices_weak_signal` | gauge | Connected paired pagers with Wi-Fi below -80 dBm |
| `sar_devices_free_heap_min_bytes` | gauge | The lowest free heap of the connected pagers, for a leak in the firmware. NaN with none connected |
| `sar_firmware_default_info{board,version}` | gauge | Each board's rollout default; compare with `sar_devices`' `fw_version` |

### Pages
| Metric | Type | Notes |
|---|---|---|
| `sar_pages_total{channel,source}` | counter | `source` is `web`, `api` or `email` |
| `sar_page_messages_sent_total` | counter | Includes replays to pagers that reconnect |
| `sar_page_receipts_total{state}` | counter | First `received` and first `acked` per page and pager |
| `sar_page_receive_seconds` | histogram | Page created → pager received it. Includes time the pager was offline |
| `sar_page_ack_seconds` | histogram | Page created → member pressed the button |
| `sar_deliveries_unreceived` | gauge | Unexpired pages still waiting to reach a pager |

### Server
| Metric | Type | Notes |
|---|---|---|
| `sar_mqtt_connects_total`, `sar_mqtt_disconnects_total` | counter | A high rate means pagers are flapping |
| `sar_mqtt_auth_failures_total` | counter | |
| `sar_device_events_total{type}` | counter | `connect`, `ota_failed`, `ota_rollback`, etc. Unrecognised types from a device count as `other` |
| `sar_ingest_requests_total{result}` | counter | `POST /api/ingest/page` and `/api/ingest/email`: `ok`, `unauthorized`, `unknown_channel` or `empty` (an email with no subject or text) |
| `process_*`, `nodejs_*` | | Node's default metrics |

HTTP request metrics come from the VM's Caddy log (its Sites dashboard).

## Dashboard
[`monitoring/beepers.dashboard.json`](../monitoring/beepers.dashboard.json) is a Grafana dashboard: the pagers (paired,
connected, offline, on quiet, weak Wi-Fi, firmware versions), pages (how many, how fast they reach pagers and are
acknowledged, what's waiting), and the server (pager connections, firmware updates, rejected logins, the ingest API,
memory). Import it in Grafana (Dashboards → New → Import, then upload the file). Its queries use the KCSARA VM's data
source (uid `prometheus`) and `app="beepers"`, the apps job's label for this app.

One more query, for how far a firmware rollout has got:

```promql
sum(sar_devices{paired="true"} unless on(board, fw_version) label_replace(sar_firmware_default_info, "fw_version", "$1", "version", "(.*)"))
```

Every counter starts at 0 when the server starts, before anything has happened, so `increase()` counts the first page,
receipt or rollback after a restart (a series that first appeared at 1 would be missed).

## Alerts
[`monitoring/sar-beepers.rules.yml`](../monitoring/sar-beepers.rules.yml) has a starting set: the server is down, more than half of the paired pagers offline, a firmware rollback, and repeated login failures.

They're Prometheus rules, for the `sar-beepers` job above. The KCSARA VM alerts from Grafana instead (the vm repo's
`monitoring/grafana/provisioning/alerting/rules.yaml`), where these would go with `job="apps", app="beepers"` in place
of `job="sar-beepers"`; they aren't there yet.
