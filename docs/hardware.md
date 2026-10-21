# Hardware

## Target board
The default target is an **ESP32-C3** board; the defaults assume the common "ESP32-C3 SuperMini" (about $3). Any ESP32-C3 or S3 dev board works: run `idf.py set-target esp32s3` and set the pins under `idf.py menuconfig → SAR Notifier → Pins`.

The defaults work on a bare dev board with nothing attached:

| Function | Default GPIO | Notes |
|---|---|---|
| Status LED | 8 (active low) | SuperMini on-board LED |
| Button | 9 (active low, internal pull-up) | The BOOT button. It is a strapping pin, so holding it *during reset* enters the ROM bootloader |
| Arm/quiet switch | 4 (internal pull-up) | Open = armed, closed to GND = quiet. Unconnected = always armed |
| Alarm | 5 | PWM square wave, or on/off (see below) |
| Alarm B | -1 (unused) | Complementary output for bridge drive |

The C3's strapping pins are GPIO 2, 8 and 9. Don't put anything on the daughter board that pulls them low at power-up.

## Behaviour

### LED
| Pattern | Meaning |
|---|---|
| Mostly on, brief off every 2 s | Setup mode: join the `SAR-Pager-xxxx` Wi-Fi network |
| Fast blink (4/s) | Connecting (first time since boot) |
| 1 s on / 1 s off | Lost connection to the server |
| Double blip every 2 s | Connected but not paired to a member |
| Short blip every 5 s | Connected and listening ✅ |
| Rapid flash | Unacknowledged page: press the button |
| Triple blip | Firmware update in progress |
| Very rapid flash for 10 s | "Identify", sent from the web UI |

### Button
| Press | Action |
|---|---|
| Short | Acknowledge pages and silence the alarm. With no pages waiting, it chirps once if everything is OK and twice if not connected or not paired |
| Hold 5 s (LED goes solid), release | Setup mode: change Wi-Fi, or get a new pairing code |
| Hold 15 s (LED flickers), release | Forget the Wi-Fi and server settings, then setup mode. The device identity is kept |

### Sounds
- **Page**: triple beeps for `CONFIG_NOTIFIER_ALARM_SECONDS` (60 s), then one beep a minute for `CONFIG_NOTIFIER_REMINDER_MINUTES` (10) until acknowledged.
- **Quiet switch**: pages flash the LED but don't sound. Server-sent *test* commands sound regardless, since they're deliberate.
- **Trouble chirp**: while armed, if the pager hasn't reached the server for `CONFIG_NOTIFIER_TROUBLE_CHIRP_MINUTES` (30), it gives a tiny chirp every 10 min, like a smoke detector's low-battery chirp. Set it to 0 to disable.

## Making it loud
"Loud enough to wake you" is the main hardware risk, so prototype the alarm before laying out the board. dB figures vary a lot with the part and enclosure, so measure with a meter or phone app at 1 m.

1. **Bare piezo transducer driven from a GPIO at 3.3 V**: quiet, roughly 70–80 dB. Fine for bench testing only.
2. **Bare piezo through a piezo driver IC**, e.g. Diodes **PAM8904**, a charge-pump piezo driver with up to ~18 Vpp from 3.3 V. Feed the LEDC output into its input and pick a transducer with resonance at `CONFIG_NOTIFIER_ALARM_FREQ_HZ` (usually 2.7–4 kHz; output drops sharply off resonance). This is a good small, cheap option for a custom PCB.
3. **Bare piezo through an H-bridge**: set `ALARM_GPIO_B`. The firmware drives both legs in antiphase, which doubles the swing (+6 dB). Combine with a higher bridge supply for more.
4. **Self-oscillating 12 V piezo siren module**, the 95–110 dB kind sold for alarm panels. Pick `Alarm drive → On/off`, switch it with a logic-level N-MOSFET (e.g. AO3400) on the low side, and power it from a small 5→12 V boost converter (e.g. MT3608). This is the loudest and simplest option, but bulkier and it draws more current.

## Daughter board sketch
- Headers for the dev board (so a dead ESP32 is a $3 swap)
- Alarm circuit (option 2 or 4 above)
- A tactile button large enough to find in the dark, to GND
- An SPDT slide switch, arm/quiet, to GND
- A status LED that can be seen across a bedroom; brightness should be dimmable later via PWM
- Optional: a second (red) LED for "trouble" so you don't have to read blink patterns
- Powered by USB-C 5 V from a phone charger

**Power outages.** A pager ran on batteries, but this needs mains power, Wi-Fi and the ISP all working. Members with a UPS on their router could also run the pager off a USB power bank with pass-through charging. A LiPo plus charger IC on the board is possible, but adds cost and safety work. Decide before rev 1.

## Before production
- **Signed images.** Enable `CONFIG_SECURE_SIGNED_APPS_NO_SECURE_BOOT` with your own signing key, so a compromised server can't push arbitrary firmware. Keep the key off the server.
- **Flash encryption / secure boot.** Optional. Without them, someone with physical access can read the device secret, but that only lets them impersonate that one pager.
- Set `CONFIG_NOTIFIER_DEFAULT_SERVER_URL` to the real server so members don't have to type it.
