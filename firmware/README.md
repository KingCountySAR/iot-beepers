# Firmware

ESP-IDF v5.5 app for the pager. Pins, behaviour and alarm hardware are in `../docs/hardware.md`.

## Boards
Each build is for one board, set by `CONFIG_NOTIFIER_BOARD`. The pins are compiled in, so the image embeds the board ID and the server only sends a pager updates built for its own board.

| Board ID | Hardware | Chip | Config | Build dir |
|---|---|---|---|---|
| `xiao-c3` | Seeed XIAO ESP32C3 on the rev 1 board | esp32c3 | `sdkconfig.defaults` | `build/` |
| `xiao-c3-proto` | XIAO ESP32C3 on a breadboard with a low-trigger buzzer module on D1. Rev 1 pins, alarm active low | esp32c3 | `sdkconfig.defaults` + `sdkconfig.defaults.xiao-proto` | `build-xiao-proto/` |
| `devkit-v1` | ESP32 DevKit V1, for breadboard prototyping | esp32 | `sdkconfig.defaults` + `sdkconfig.defaults.devkit` | `build-devkit/` |

## Build
Docker is all you need (in Git Bash on Windows too):

```sh
./build.sh xiao-c3       # or xiao-c3-proto, devkit-v1
```

That builds in `espressif/idf:v5.5.1` and writes **`dist/sar-notifier-<board>-<version>.bin`**, a merged image containing the bootloader, partition table and app. Upload it on the server's **Firmware** page; it serves both OTA updates and the browser flasher.

With a local ESP-IDF instead, the same build is `idf.py build` for the XIAO, or for the DevKit:

```sh
idf.py -B build-devkit -DIDF_TARGET=esp32 -DSDKCONFIG=build-devkit/sdkconfig \
  "-DSDKCONFIG_DEFAULTS=sdkconfig.defaults;sdkconfig.defaults.devkit" build
```

If a build complains about a missing `CONFIG_NOTIFIER_…` option after a Kconfig change, delete that build directory's `sdkconfig` and rebuild.

## Flash (first time, over USB)
After the first flash, updates arrive over Wi-Fi (below).

### From the server: Flash page
Once an admin has uploaded a build, anyone logged in can open **Flash** in the web UI, pick the board, click **Connect and flash**, and choose the board's USB port. It uses Web Serial, so it needs Chrome or Edge on a computer, and the site over `https://` or `http://localhost`. On a plain-HTTP LAN address the browser hides Web Serial.

It writes the bootloader, partition table, boot selector and app, but not the settings partition (NVS), so reflashing a pager keeps its Wi-Fi settings and identity. Tick **Erase everything first** only for boards that have run other firmware. It checks the connected chip against the board you picked, reads back an MD5 of every part to verify the write, retries once at 115200 baud if the fast transfer fails, and tells you the new pager's ID and setup network when it's done.

### Without Python: standalone esptool
Espressif publishes esptool as a single executable. Download `esptool-vX.Y.Z-windows-amd64.zip` (or the macOS/Linux build) from [esptool releases](https://github.com/espressif/esptool/releases) and unzip it anywhere. Find the port in Device Manager → Ports on Windows (e.g. `COM3`), or as `/dev/cu.usbmodem*` / `/dev/cu.usbserial*` on macOS. Then, from the board's build directory:

```sh
cd build            # or build-devkit
path/to/esptool.exe --chip esp32c3 -p COM3 -b 460800 write-flash @flash_args   # --chip esp32 for the DevKit
```

`flash_args` lists the bootloader, partition table and app with their offsets. On a board that has run other firmware, add `--erase-all` after `write-flash` for a clean start. Docker on Windows/macOS can't see USB serial ports, which is why flashing runs on the host.

Don't flash the merged `dist/` image at `0x0` onto a paired pager (with esptool or Espressif's own web flasher): it covers the settings partition too, so it wipes the pager's identity.

### With Python or ESP-IDF
`pip install esptool` gives the same `esptool` command as above. A local ESP-IDF install can do it all in one step: `idf.py -p COM3 flash monitor`.

### Don't erase a paired pager
A full erase (`--erase-all`, `erase-flash`, or **Erase everything first**) wipes the pager's secret. It comes back with the same ID and a new secret, and the server refuses it until an admin clicks **Reset** on its device page. Plain `write-flash`, the Flash page without erase, and OTA updates keep the identity.

### Reading the log
Logs are at 115200 baud on the same port. Without Python, use PuTTY (Serial, the COM port, 115200), the Arduino IDE's Serial Monitor, or the console on [Espressif's web flasher](https://espressif.github.io/esptool-js/). Close it before flashing again; only one program can hold the port.

## Prototyping on an ESP32 DevKit V1
The `devkit-v1` board is a classic ESP32 DevKit V1 (ESP32-WROOM-32). Its USB port goes to a USB-serial chip (CP2102 or CH340, which may need a driver), and logs come out of that port too.

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
2. Run `./build.sh <board>` for each board in use, and upload each `dist/` image on the **Firmware** page.
3. Pin one pager to the new version from its device page and check that it comes back healthy.
4. Click **Make default** to roll it out to the rest of that board's pagers. Each board has its own default.

If a new image can't reach the server within 5 minutes of booting, the pager rolls back automatically and reports `ota_rollback`.

## Developing against a local server
Set `PUBLIC_URL=http://<your LAN IP>:4100` in `server/.env.local` and run `npm run dev`. In the pager's setup portal, enter `http://<your LAN IP>:4100` as the server (Vite proxies `/api` and `/mqtt` to the server). Plain HTTP and `ws://` work for development. Use the Flash page from `http://localhost:4100` on the dev machine itself, since browsers only allow Web Serial on localhost or HTTPS.

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
