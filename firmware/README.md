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


## Prototyping on an ESP32 DevKit V1
`sdkconfig.defaults.devkit` targets a classic ESP32 DevKit V1 (ESP32-WROOM-32). It builds into its own directory, with its own `sdkconfig`, so it doesn't disturb the XIAO build:

```sh
docker run --rm -v "$PWD:/project" -w /project espressif/idf:v5.5.1 \
  idf.py -B build-devkit -DIDF_TARGET=esp32 -DSDKCONFIG=build-devkit/sdkconfig \
  "-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.devkit" build

cd build-devkit
esptool --chip esp32 -p COM5 -b 460800 write-flash @flash_args
```

(In Git Bash on Windows, put `MSYS_NO_PATHCONV=1` in front of `docker run`.) The board's USB port goes to a USB-serial chip (CP2102 or CH340, which may need a driver), and logs come out of that port too.

| Function | GPIO | Notes |
|---|---|---|
| Alarm | 25 | Until a buzzer arrives, an LED with a ~330 Ω resistor to GND shows the beep pattern. It's PWM at 2.7 kHz, so it glows at about half brightness |
| Button | 0 | The on-board BOOT button |
| Arm/quiet switch | 27 | Jumper to GND = quiet |
| Status LED | 2 | The on-board blue LED stands in for green |
| Alert LED | 4 | Red LED with a ~330 Ω resistor to GND |

Avoid GPIO 6–11 (flash), 1 and 3 (console), and 34–39 (inputs only, no pull-ups).

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
