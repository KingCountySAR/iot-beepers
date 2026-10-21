#pragma once

#include <stdbool.h>

/** What the green status and red alert LEDs show. See docs/hardware.md for the table. */
typedef enum {
    LED_OFF,
    LED_SETUP,       // green mostly on, brief off every 2s: setup portal is up
    LED_CONNECTING,  // green fast blink: joining Wi-Fi / reaching server
    LED_TROUBLE,     // red blip every 3s: lost connection
    LED_UNPAIRED,    // green double blip every 2s: connected but not paired to a member
    LED_OK,          // green blip every 5s: connected and listening
    LED_PAGE,        // red flashing: unacknowledged page (press button)
    LED_IDENTIFY,    // green/red alternating: "which one is it?"
    LED_UPDATING,    // green triple blip: OTA in progress
} led_mode_t;

typedef enum {
    SOUND_PAGE,      // full alarm, CONFIG_NOTIFIER_ALARM_SECONDS long
    SOUND_REMINDER,  // single beep for a still-unacknowledged page
    SOUND_TEST,      // 3s of the alarm pattern
    SOUND_OK,        // single chirp
    SOUND_ERROR,     // double chirp
    SOUND_TROUBLE,   // tiny chirp: disconnected too long
} sound_t;

typedef enum {
    BUTTON_SHORT,       // < 5s
    BUTTON_HOLD_SETUP,  // held 5-15s: re-run Wi-Fi setup / get a new pairing code
    BUTTON_HOLD_RESET,  // held 15s+: forget Wi-Fi and server settings
} button_event_t;

typedef void (*ui_button_cb_t)(button_event_t ev);
typedef void (*ui_switch_cb_t)(bool armed);

/** Callbacks run on the UI task; keep them short (post to a queue). */
void ui_init(ui_button_cb_t on_button, ui_switch_cb_t on_switch);

void ui_set_led(led_mode_t mode);
void ui_play(sound_t sound);
void ui_stop_sound(void);
bool ui_sound_playing(void);

/** Alarm switch position (true = armed, false = quiet/LED only). */
bool ui_armed(void);
