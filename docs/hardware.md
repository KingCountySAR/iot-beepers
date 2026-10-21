# Hardware

## Target board
The target is a **Seeed XIAO ESP32C3** on the rev 1 carrier board. The schematic and BOM are in [`hardware/rev1`](../hardware/rev1/README.md). For breadboard prototyping there's an ESP32 DevKit V1 profile; see [`firmware/README.md`](../firmware/README.md#prototyping-on-an-esp32-devkit-v1). Other ESP32-C3/S3 boards work too: set the pins under `idf.py menuconfig → SAR Notifier → Pins` (and run `idf.py set-target esp32s3` for an S3).

| Function | XIAO pin | GPIO | Notes |
|---|---|---|---|
| Alarm | D1 | 3 | Gate of the low-side MOSFET; square wave or on/off |
| Button | D2 | 4 | Active low, internal pull-up |
| Button (alternate) | BOOT | 9 | The XIAO's own BOOT button does the same thing, so a bare board is usable. Holding it *during reset* enters the ROM bootloader |
| Arm/quiet switch | D3 | 5 | Open = armed, closed to GND = quiet. Unconnected = always armed |
| Green status LED | D6 | 21 | |
| Red alert LED | D10 | 10 | The tall one, visible across a room |

The XIAO has no user LED of its own; a bare board just has no lights. The C3's strapping pins are GPIO 2, 8 and 9, so the carrier board leaves them alone.

## Behaviour

### LEDs
Green shows status; red means something needs your attention.

| Pattern | Meaning |
|---|---|
| Green mostly on, brief off every 2 s | Setup mode: join the `SAR-Pager-xxxx` Wi-Fi network |
| Green fast blink (4/s) | Connecting (first time since boot) |
| Green double blip every 2 s | Connected but not paired to a member |
| Green short blip every 5 s | Connected and listening ✅ |
| Green triple blip | Firmware update in progress |
| **Red flashing** | Unacknowledged page: press the button |
| Red blip every 3 s | Lost connection to the server |
| Green/red alternating for 10 s | "Identify", sent from the web UI |

### Button
| Press | Action |
|---|---|
| Short | Acknowledge pages and silence the alarm. With no pages waiting, it chirps once if everything is OK and twice if not connected or not paired |
| Hold 5 s (green goes solid), release | Setup mode: change Wi-Fi, or get a new pairing code |
| Hold 15 s (red flickers), release | Forget the Wi-Fi and server settings, then setup mode. The device identity is kept |

### Sounds
- **Page**: triple beeps for `CONFIG_NOTIFIER_ALARM_SECONDS` (60 s), then one beep a minute for `CONFIG_NOTIFIER_REMINDER_MINUTES` (10) until acknowledged.
- **Quiet switch**: pages flash the LED but don't sound. Server-sent *test* commands sound regardless, since they're deliberate.
- **Trouble chirp**: while armed, if the pager hasn't reached the server for `CONFIG_NOTIFIER_TROUBLE_CHIRP_MINUTES` (30), it gives a tiny chirp every 10 min, like a smoke detector's low-battery chirp. Set it to 0 to disable.

## Alarm
The target is pager loud, not smoke-alarm loud. Pagers ran off a single 1.5 V cell, so 5 V from USB is plenty: no boost converter or siren module is needed. All of these switch from the USB 5 V rail through a small NPN transistor or logic-level N-MOSFET (e.g. AO3400) on the low side, gated by the alarm GPIO.

1. **5 V active buzzer** (a 12 mm piezo or magnetic "self-drive" buzzer). Pick `Alarm drive → On/off`. This is the simplest option, and loud enough at a bedside. Its pitch is fixed by the part.
2. **5 V passive magnetic transducer** (around 2.7 kHz). Pick `Square wave`, set `CONFIG_NOTIFIER_ALARM_FREQ_HZ` to its resonant frequency, and put a flyback diode across the coil. The firmware controls the pitch, which leaves room for distinct tones later (e.g. callout vs. test).
3. **Passive piezo with an inductor across it**. This is the classic pager trick: the inductor's flyback swings the piezo well above the supply voltage. It's cheap and loud for its size. Also drive it with `Square wave` at the piezo's resonant frequency.

A passive part driven straight off a 3.3 V GPIO with no transistor is only good for bench testing. Pick parts by listening to a few at a bedside. If a part turns out too loud, it can be turned down later by reducing the PWM duty cycle; `ui.c` currently uses a fixed 50%.

`ALARM_GPIO_B` (antiphase bridge drive) is still supported, but none of the options above need it.

## Carrier board
See [`hardware/rev1`](../hardware/rev1/README.md) for the schematic, BOM and layout notes.

**Power outages.** A pager ran on batteries, but this needs mains power, Wi-Fi and the ISP all working. The XIAO ESP32C3 has a LiPo charger and battery pads built in, so battery backup is mostly a matter of case space and a protected cell. Rev 1 leaves the pads unused. Until then, a USB power bank with pass-through charging works for members who have a UPS on their router.

## Before production
- **Signed images.** Enable `CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT` with your own signing key, so a compromised server can't push arbitrary firmware. Keep the key off the server.
- **Flash encryption / secure boot.** Optional. Without them, someone with physical access can read the device secret, but that only lets them impersonate that one pager.
- Set `CONFIG_NOTIFIER_DEFAULT_SERVER_URL` to the real server so members don't have to type it.
