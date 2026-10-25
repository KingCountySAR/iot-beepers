# Metrics

Admin metrics go to Prometheus and Grafana. The web UI keeps what members need: each pager's status, its event log, and who received and acknowledged each page.

## Scraping
The server serves `GET /metrics` on its own port, `METRICS_PORT` (default 4101; `0` turns it off). Caddy only proxies the main port, so metrics are never public. In `deploy/docker-compose.yml` the port is published on `METRICS_BIND` (default `127.0.0.1`); set that to the VM's private IP for a Prometheus elsewhere on the network. Set `METRICS_TOKEN` to require a bearer token as well.

```yaml
# prometheus.yml
scrape_configs:
  - job_name: sar-beepers
    authorization:
      credentials: <METRICS_TOKEN>   # omit if unset
    static_configs:
      - targets: ['10.0.0.4:4101']

rule_files:
  - sar-beepers.rules.yml           # deploy/prometheus/sar-beepers.rules.yml
```

## What's exported
Counters and histograms live in memory and reset when the server restarts, which `rate()` and `increase()` handle. Device gauges are read from the database on every scrape.

### Devices
Every per-device series has a `device` label (the 12-hex-digit id). Names live only on `sar_device_info`, so renaming a pager doesn't break its history. Join on `device` to show them:

```promql
sar_device_rssi_dbm * on(device) group_left(name, owner) sar_device_info
```

| Metric | Type | Notes |
|---|---|---|
| `sar_device_info{device,name,owner,fw_version,board}` | gauge | Always 1. `owner` is empty for unpaired devices |
| `sar_device_online{device}` | gauge | 1 while the pager has a live connection |
| `sar_device_armed{device}` | gauge | 0 when the switch is on quiet |
| `sar_device_rssi_dbm{device}` | gauge | Wi-Fi signal at the last status message |
| `sar_device_free_heap_bytes{device}` | gauge | |
| `sar_device_uptime_seconds{device}` | gauge | Drops to near 0 after a reboot |
| `sar_device_last_seen_timestamp_seconds{device}` | gauge | Use `time() - …` for "last seen" |
| `sar_firmware_default_info{board,version}` | gauge | Each board's rollout default; compare with `fw_version` |

### Pages
| Metric | Type | Notes |
|---|---|---|
| `sar_pages_total{channel,source}` | counter | `source` is `web` or `api` |
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
| `sar_ingest_requests_total{result}` | counter | `ok`, `unauthorized` or `unknown_channel` |
| `process_*`, `nodejs_*` | | Node's default metrics |

HTTP request metrics come from Caddy, whose `metrics` option exports them.

## Useful queries
| Panel | Query |
|---|---|
| Pagers online | `sum(sar_device_online * on(device) sar_device_info{owner!=""})` of `count(sar_device_info{owner!=""})` |
| Pagers on quiet | `count(sar_device_armed == 0)` |
| Firmware versions | `count by (board, fw_version) (sar_device_info)` |
| Pagers behind the rollout | `count(sar_device_info unless on(board, fw_version) label_replace(sar_firmware_default_info, "fw_version", "$1", "version", "(.*)"))` |
| Median time to reach a pager | `histogram_quantile(0.5, sum by (le) (rate(sar_page_receive_seconds_bucket[1d])))` |
| Weak signal | `sar_device_rssi_dbm < -80` |
| Reboots | `resets(sar_device_uptime_seconds[1d])` |

## Alerts
[`deploy/prometheus/sar-beepers.rules.yml`](../deploy/prometheus/sar-beepers.rules.yml) has a starting set: the server is down, a paired pager has been offline for 30 minutes, more than half of the paired pagers are offline, a firmware rollback, and repeated login failures.
