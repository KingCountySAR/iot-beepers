# Rev 1 carrier board: schematic and BOM (for review)

A small 2-layer board that carries a **Seeed XIAO ESP32C3** and adds the alarm, two LEDs, a button and the arm/quiet switch. JLCPCB assembles all the surface-mount parts. You hand-solder the XIAO (14 joints) and the 10 mm LED (2 joints).

Status: **schematic for review.** There's no KiCad project or layout yet; those come once the alarm sample is picked and the circuit below is agreed.

## Power
Power comes from USB-C on the XIAO, from a phone charger. The board takes `5V` (VBUS) and `3V3` from the XIAO's pins and needs no regulator of its own. The XIAO's battery pads are left unused for now.

## Schematic

```
                         XIAO ESP32C3 (U1)
                     ┌────────────────────────┐
                     │ D0  GPIO2   (strap) nc │
       ALARM_GATE ◄──┤ D1  GPIO3              │
       BUTTON     ───┤ D2  GPIO4              │
       SWITCH     ───┤ D3  GPIO5              │
                     │ D4  GPIO6  SDA      nc │  ← kept free for a future I²C screen
                     │ D5  GPIO7  SCL      nc │
       LED_GREEN  ◄──┤ D6  GPIO21             │
                     │ D7  GPIO20          nc │
                     │ D8  GPIO8   (strap) nc │
                     │ D9  GPIO9   (strap) nc │  ← on-board BOOT button, also works as the button
       LED_RED    ◄──┤ D10 GPIO10             │
             +5V  ◄──┤ 5V                     │
                     │ 3V3                 nc │
             GND  ───┤ GND                    │
                     └────────────────────────┘

Alarm (low-side switch). A MOSFET rather than driving from the GPIO: the transducer
wants ~5 Vp-p and up to ~100 mA, more than a pin should supply.

     +5V ──┬──────────── R1 ──────┬────────┐
           │         10 Ω 1206    │        │
          C1 10µF                BZ1+      D1 1N4148W
           │                      │ BZ1    │ (cathode to BZ1+)
          GND                    BZ1-      │
                                  ├────────┘
                                  │ D
       ALARM_GATE ── R2 ──┬──── G Q1 AO3400A
                    100 Ω │       │ S
                         R3 100k  │
                          │       │
                         GND     GND

     R3 holds the gate low while the ESP32 is in reset or booting, so the alarm
     can't sound during power-up or a firmware update.
     R1 sets the volume. Tune it on the chosen part; use 0 Ω for 5 V-rated parts.

LEDs (driven straight from the GPIO pins)

     LED_GREEN ── R4 100 Ω ──►|── GND     LED2 green 0805, status (~5 mA)
     LED_RED   ── R5 100 Ω ──►|── GND     LED1 red 10 mm diffused, alert (~13 mA)

Inputs (internal pull-ups enabled in firmware)

     BUTTON ── SW1 ── GND                 tactile; the 3D-printed case has the large cap
     SWITCH ── SW2 common
               SW2 pos A ── GND           = quiet
               SW2 pos B ── nc            = armed (pulled up)
```

### Alarm part choice (one footprint, chosen after testing samples)
The circuit is the same for every candidate; only the BZ1 footprint and R1's value change.

| Candidate | R1 | Firmware `Alarm drive` | Assembly |
|---|---|---|---|
| Huaneng **MLT-8530** (LCSC C94599), SMD magnetic, 2.7 kHz, rated 3.6 Vp-p | ~10 Ω (tune) | Square wave, 2700 Hz | JLCPCB (default for rev 1) |
| PUI **AT-1224-TWT-5V-2-R**, through-hole magnetic, 2.4 kHz, 5 V | 0 Ω | Square wave, 2400 Hz | Hand-solder, 2 joints |
| PUI **AI-1223-TWT-5V-R**, through-hole active buzzer, 2.3 kHz, 5 V | 0 Ω | On/off | Hand-solder, 2 joints; D1 not needed but harmless |

I couldn't get the MLT-8530 datasheet itself. Huaneng's sibling MLT-8540 lists a 16 ± 3 Ω coil and ≤95 mA on a 5 Vp-p, 50% square wave. That's the basis for running the MLT-8530 from 5 V through ~10 Ω. Confirm on the sample by measuring the current, and by ear.

## BOM
"Basic" means a JLCPCB basic part (no per-order feeder fee). Where the listing didn't say, the status is marked unconfirmed; JLCPCB's BOM upload will show it.

| Ref | Qty | Part | Package | LCSC / source | JLCPCB | Notes |
|---|---|---|---|---|---|---|
| U1 | 1 | Seeed XIAO ESP32C3 | Module, castellated | Amazon (you have them) | Hand-solder | Footprint has castellated pads **and** 2.54 mm holes, so pin headers also fit |
| Q1 | 1 | AO3400A N-MOSFET, 30 V 5.7 A, Vgs(th) 1.45 V | SOT-23 | C20917 | Basic | Fully on at 3.3 V gate drive |
| D1 | 1 | 1N4148W | SOD-123 | C81598 | Unconfirmed (common basic part) | Flyback for the coil |
| BZ1 | 1 | MLT-8530 (see table above) | SMD 8.5×8.5 mm | C94599 | Extended | |
| R1 | 1 | 10 Ω 1%, 250 mW | 1206 | C17903 | Unconfirmed | Volume; 0 Ω for 5 V parts |
| R2 | 1 | 100 Ω 1% | 0603 | C22775 | Unconfirmed | Gate series resistor |
| R3 | 1 | 100 kΩ 1% | 0603 | C25803 | Unconfirmed | Gate pull-down |
| R4, R5 | 2 | 100 Ω 1% | 0603 | C22775 | Unconfirmed | LED current |
| C1 | 1 | 10 µF 25 V X5R | 0805 | C15850 | Unconfirmed | Local reservoir for alarm pulses |
| LED2 | 1 | Green LED, KT-0805G, 430 mcd @ 5 mA | 0805 | C2297 | Unconfirmed | Status; bright, so PWM dimming may be worth adding |
| LED1 | 1 | Red LED, 10 mm, diffused, wide angle (~300 mcd, 50–60°) | Through-hole, 2.54 mm | Digi-Key/Amazon | Hand-solder | Stands up through the lid, visible across a room |
| SW1 | 1 | Tactile switch, TS-1187A-B-A-B, 5.1×5.1 mm | SMD | C318884 | Basic | The case's printed button presses it |
| SW2 | 1 | Slide switch SPDT, SHOU HAN MSK12C02 | SMD | C431540 | Extended | Knob pokes through a slot in the case |
| H1–H2 | 2 | M2.5 mounting holes | | | | For 3D-printed case standoffs |

Extended parts: BZ1 and SW2, a small per-order setup fee each.

## Layout notes (for the next step)
- **Board size:** about 45 × 30 mm. The XIAO sits on one end with its USB-C flush with the board edge so the cable reaches through the case wall.
- **Antenna:** the XIAO ESP32C3 uses the **external FPC antenna** on its u.FL connector. The case needs a spot to stick it to an inside wall, away from BZ1's magnet and coil.
- **Alarm layout:** keep BZ1, Q1, D1, R1 and C1 together on the opposite end from the XIAO, with a short loop to ground.
- **Height:** LED1 is mounted tall (leads left long, or on a printed spacer) so it sits flush with or proud of the lid. LED2 shows through a small hole or a printed light pipe.
- SW1 is under a printed button cap and SW2 is at the board edge.
- **3D-printed case:** a two-part shell with standoffs for H1/H2. The lid has holes for LED1, LED2 and the button, plus a slot for SW2. The wall has an opening for USB-C, and the sound port sits over BZ1. Once the board outline exists I can generate the case in OpenSCAD.

## Firmware
The defaults in `firmware/main/Kconfig.projbuild` match this pin map: alarm GPIO3, button GPIO4 plus BOOT (GPIO9), switch GPIO5, green LED GPIO21, red LED GPIO10. The default is square-wave drive at 2700 Hz. Logs go over the XIAO's USB-C (USB-Serial-JTAG), which leaves GPIO20/21 free.
