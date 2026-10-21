# Firmware

ESP-IDF v5.5 app for the pager. Pins, behaviour and alarm hardware are in `../docs/hardware.md`.

## Build
You can use a local ESP-IDF install, or Docker (no install needed):

```sh
# from the firmware/ directory
docker run --rm -v "$PWD:/project" -w /project espressif/idf:v5.5.1 idf.py build
```

The output is `build/sar-notifier.bin`.

## Flash (first time, over USB)
Docker on Windows/macOS can't see USB serial ports, so flash from the host. Either use a local ESP-IDF (`idf.py -p COM5 flash monitor`), or use esptool:

```sh
pip install esptool
cd build
esptool --chip esp32c3 -p COM5 -b 460800 write-flash @flash_args
```

## Updates (OTA)
1. Bump `version.txt`. The server reads the version from the image and refuses duplicates.
2. Build, then upload `build/sar-notifier.bin` on the **Firmware** page.
3. Pin one pager to the new version from its device page and check that it comes back healthy.
4. Click **Make default** to roll it out to the rest.

If a new image can't reach the server within 5 minutes of booting, the pager rolls back automatically and reports `ota_rollback`.

## Developing against a local server
Run the server with `PUBLIC_URL=http://<your LAN IP>:8080`. In the pager's setup portal, enter `http://<your LAN IP>:8080` as the server. Plain HTTP and `ws://` work for development.

## Layout
| File | Purpose |
|---|---|
| `app_main.c` | Boot flow, event loop, page/alarm/ack logic, LED state |
| `portal.c`, `dns_server.c` | Setup access point and captive portal |
| `wifi.c` | Station / AP management, reconnect backoff |
| `server_api.c` | HTTPS registration |
| `link.c` | MQTT-over-WebSocket client: hello, heartbeat, message dispatch |
| `ota.c` | OTA download, confirm, rollback reporting |
| `ui.c` | LED patterns, button and switch debounce, alarm sequencer (LEDC) |
| `settings.c` | NVS: Wi-Fi/server settings and device identity |
