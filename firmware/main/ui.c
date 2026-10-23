#include "ui.h"

#include <ctype.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "sdkconfig.h"

static const char *TAG = "ui";

#define TICK_MS 10
#define DEBOUNCE_MS 30
#define SWITCH_DEBOUNCE_MS 100
#define HOLD_SETUP_MS 5000
#define HOLD_RESET_MS 15000

#define LEDC_MODE LEDC_LOW_SPEED_MODE
#define LEDC_TIMER LEDC_TIMER_0
#define LEDC_CH_A LEDC_CHANNEL_0
#define LEDC_CH_B LEDC_CHANNEL_1
#define LEDC_RES LEDC_TIMER_10_BIT
#define LEDC_HALF (1 << 9)

// ---- LED patterns: on during [start, end) windows within each period ---------------

typedef struct {
    uint16_t period;
    uint16_t win[3][2];
} led_pattern_t;

#define DARK {1000, {{0, 0}}}

/** Green = status, red = needs attention (the tall LED that's visible across a room). */
static const struct {
    led_pattern_t green, red;
} LED_PATTERNS[] = {
    [LED_OFF] = {DARK, DARK},
    [LED_SETUP] = {{2000, {{0, 1800}}}, DARK},
    [LED_CONNECTING] = {{250, {{0, 125}}}, DARK},
    [LED_TROUBLE] = {DARK, {3000, {{0, 150}}}},
    [LED_UNPAIRED] = {{2000, {{0, 100}, {250, 350}}}, DARK},
    [LED_OK] = {{5000, {{0, 60}}}, DARK},
    [LED_PAGE] = {DARK, {400, {{0, 200}}}},
    [LED_IDENTIFY] = {{200, {{0, 100}}}, {200, {{100, 200}}}},
    [LED_UPDATING] = {{1000, {{0, 50}, {200, 250}, {400, 450}}}, DARK},
};

// ---- Sounds: a list of beeps, optionally looped for a total duration ----------------

typedef struct {
    uint16_t on_ms;
    uint16_t off_ms;
    uint16_t freq_hz;  // 0 = CONFIG_NOTIFIER_ALARM_FREQ_HZ
} beep_t;

typedef struct {
    const beep_t *beeps;
    uint8_t count;
    uint32_t loop_for_ms;  // 0 = play once
} sound_def_t;

static const beep_t BEEPS_ALARM[] = {{150, 100, 0}, {150, 100, 0}, {150, 600, 0}};
static const beep_t BEEPS_SINGLE[] = {{120, 0, 0}};
static const beep_t BEEPS_CHIRP[] = {{60, 0, 0}};
static const beep_t BEEPS_DOUBLE[] = {{60, 100, 0}, {60, 0, 0}};
static const beep_t BEEPS_TINY[] = {{25, 0, 0}};

static const sound_def_t SOUNDS[] = {
    [SOUND_PAGE] = {BEEPS_ALARM, 3, CONFIG_NOTIFIER_ALARM_SECONDS * 1000},
    [SOUND_REMINDER] = {BEEPS_SINGLE, 1, 0},
    [SOUND_TEST] = {BEEPS_ALARM, 3, 3000},
    [SOUND_OK] = {BEEPS_CHIRP, 1, 0},
    [SOUND_ERROR] = {BEEPS_DOUBLE, 2, 0},
    [SOUND_TROUBLE] = {BEEPS_TINY, 1, 0},
};

// ---- Tunes from the server, in RTTTL ("name:d=4,o=6,b=120:8c,e,g.") --------------

#define TUNE_MAX_NOTES 64

static float note_hz(char letter, bool sharp, int octave)
{
    static const int8_t SEMITONES_FROM_A[] = {0, 2, -9, -7, -5, -4, -2};  // a b c d e f g
    int n = SEMITONES_FROM_A[letter - 'a'] + (sharp ? 1 : 0) + 12 * (octave - 4);
    return 440.0f * powf(2.0f, n / 12.0f);
}

/** Parses an RTTTL tune into beeps. Returns the note count, or 0 if it isn't valid. */
static int parse_rtttl(const char *s, beep_t *out, int max)
{
    const char *p = strchr(s, ':');  // skip the name
    if (!p) return 0;
    p++;
    int def_dur = 4, def_oct = 6, bpm = 63;
    while (*p && *p != ':') {
        while (*p == ' ' || *p == ',') p++;
        char key = tolower((unsigned char)*p);
        if (!key || key == ':' || p[1] != '=') return 0;
        int v = atoi(p + 2);
        if (key == 'd') def_dur = v;
        else if (key == 'o') def_oct = v;
        else if (key == 'b') bpm = v;
        p += 2;
        while (isdigit((unsigned char)*p)) p++;
    }
    if (*p != ':' || def_dur <= 0 || bpm <= 0 || bpm > 900) return 0;
    p++;

    int n = 0;
    while (*p && n < max) {
        while (*p == ' ' || *p == ',') p++;
        if (!*p) break;
        int dur = def_dur;
        if (isdigit((unsigned char)*p)) dur = strtol(p, (char **)&p, 10);
        char letter = tolower((unsigned char)*p++);
        if (dur <= 0 || !((letter >= 'a' && letter <= 'g') || letter == 'p')) return 0;
        bool sharp = *p == '#';
        if (sharp) p++;
        bool dotted = false;
        if (*p == '.') dotted = true, p++;
        int oct = def_oct;
        if (isdigit((unsigned char)*p)) oct = *p++ - '0';
        if (*p == '.') dotted = true, p++;  // both "c.6" and "c6." are seen in the wild
        if (*p && *p != ',' && *p != ' ') return 0;

        int ms = 240000 / (bpm * dur);  // a whole note is 4 beats
        if (dotted) ms += ms / 2;
        if (ms > 5000) ms = 5000;
        if (letter == 'p') {
            out[n++] = (beep_t){0, ms, 0};
        } else {
            // A short gap after each note so repeated notes stay distinct.
            int gap = ms / 8 < TICK_MS ? TICK_MS : ms / 8;
            out[n++] = (beep_t){ms - gap, gap, (uint16_t)note_hz(letter, sharp, oct)};
        }
    }
    return n;
}

static ui_button_cb_t s_on_button;
static ui_switch_cb_t s_on_switch;

static volatile led_mode_t s_led_mode = LED_CONNECTING;
static volatile bool s_armed = true;

// Sound state is only touched by the UI task; requests come in via these.
static volatile int s_sound_request = -1;
static volatile bool s_stop_request;
static volatile bool s_playing;
// A tune to play in place of the requested sound's beeps; handed over under s_tune_lock.
static portMUX_TYPE s_tune_lock = portMUX_INITIALIZER_UNLOCKED;
static beep_t s_tune_request[TUNE_MAX_NOTES];
static int s_tune_request_len;

static void set_tone(uint16_t freq_hz)
{
#if CONFIG_NOTIFIER_ALARM_DRIVE_PWM
    static uint16_t current = CONFIG_NOTIFIER_ALARM_FREQ_HZ;
    if (freq_hz == 0) freq_hz = CONFIG_NOTIFIER_ALARM_FREQ_HZ;
    if (freq_hz != current && ledc_set_freq(LEDC_MODE, LEDC_TIMER, freq_hz) == ESP_OK) current = freq_hz;
#endif
}

#ifdef CONFIG_NOTIFIER_ALARM_ACTIVE_LOW
#define ALARM_LEVEL(on) (!(on))
#define ALARM_INVERT 1
#else
#define ALARM_LEVEL(on) (on)
#define ALARM_INVERT 0
#endif

static void alarm_output(bool on)
{
#if CONFIG_NOTIFIER_ALARM_DRIVE_PWM
    if (on) {
        ledc_set_duty_with_hpoint(LEDC_MODE, LEDC_CH_A, LEDC_HALF, 0);
        ledc_update_duty(LEDC_MODE, LEDC_CH_A);
        if (CONFIG_NOTIFIER_ALARM_GPIO_B >= 0) {
            // Same duty shifted half a period: the complementary leg of the bridge.
            ledc_set_duty_with_hpoint(LEDC_MODE, LEDC_CH_B, LEDC_HALF, LEDC_HALF);
            ledc_update_duty(LEDC_MODE, LEDC_CH_B);
        }
    } else {
        ledc_stop(LEDC_MODE, LEDC_CH_A, 0);
        if (CONFIG_NOTIFIER_ALARM_GPIO_B >= 0) ledc_stop(LEDC_MODE, LEDC_CH_B, 0);
    }
#else
    gpio_set_level(CONFIG_NOTIFIER_ALARM_GPIO, ALARM_LEVEL(on));
#endif
}

#ifdef CONFIG_NOTIFIER_LED_ACTIVE_LOW
#define LED_LEVEL(on) (!(on))
#else
#define LED_LEVEL(on) (on)
#endif

static void led_output(bool green, bool red)
{
    if (CONFIG_NOTIFIER_STATUS_LED_GPIO >= 0) gpio_set_level(CONFIG_NOTIFIER_STATUS_LED_GPIO, LED_LEVEL(green));
    if (CONFIG_NOTIFIER_ALERT_LED_GPIO >= 0) gpio_set_level(CONFIG_NOTIFIER_ALERT_LED_GPIO, LED_LEVEL(red));
}

static bool led_pattern_on(const led_pattern_t *p, int64_t now_ms)
{
    uint32_t t = now_ms % p->period;
    for (int i = 0; i < 3; i++) {
        if (t >= p->win[i][0] && t < p->win[i][1]) return true;
    }
    return false;
}

// Optional pins are -1 when absent.
static uint64_t pin_bit(int gpio) { return gpio >= 0 ? 1ULL << gpio : 0; }

static void init_outputs(void)
{
    uint64_t leds = pin_bit(CONFIG_NOTIFIER_STATUS_LED_GPIO) | pin_bit(CONFIG_NOTIFIER_ALERT_LED_GPIO);
    if (leds) {
        gpio_config_t led = {.pin_bit_mask = leds, .mode = GPIO_MODE_OUTPUT};
        ESP_ERROR_CHECK(gpio_config(&led));
    }
    led_output(false, false);

#if CONFIG_NOTIFIER_ALARM_DRIVE_PWM
    ledc_timer_config_t timer = {
        .speed_mode = LEDC_MODE,
        .timer_num = LEDC_TIMER,
        .duty_resolution = LEDC_RES,
        .freq_hz = CONFIG_NOTIFIER_ALARM_FREQ_HZ,
        .clk_cfg = LEDC_AUTO_CLK,
    };
    ESP_ERROR_CHECK(ledc_timer_config(&timer));
    ledc_channel_config_t ch = {
        .gpio_num = CONFIG_NOTIFIER_ALARM_GPIO,
        .speed_mode = LEDC_MODE,
        .channel = LEDC_CH_A,
        .timer_sel = LEDC_TIMER,
        .duty = 0,
        .hpoint = 0,
        .flags.output_invert = ALARM_INVERT,  // so ledc_stop's idle level 0 drives the pin high
    };
    ESP_ERROR_CHECK(ledc_channel_config(&ch));
    if (CONFIG_NOTIFIER_ALARM_GPIO_B >= 0) {
        ch.gpio_num = CONFIG_NOTIFIER_ALARM_GPIO_B;
        ch.channel = LEDC_CH_B;
        ch.hpoint = LEDC_HALF;
        ESP_ERROR_CHECK(ledc_channel_config(&ch));
    }
#else
    gpio_config_t alarm = {
        .pin_bit_mask = 1ULL << CONFIG_NOTIFIER_ALARM_GPIO,
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&alarm));
#endif
    alarm_output(false);
}

static void init_inputs(void)
{
    uint64_t mask = pin_bit(CONFIG_NOTIFIER_BUTTON_GPIO) | pin_bit(CONFIG_NOTIFIER_BUTTON_ALT_GPIO) |
                    pin_bit(CONFIG_NOTIFIER_SWITCH_GPIO);
    gpio_config_t in = {
        .pin_bit_mask = mask,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&in));
    if (CONFIG_NOTIFIER_SWITCH_GPIO >= 0) {
        s_armed = gpio_get_level(CONFIG_NOTIFIER_SWITCH_GPIO) == 1;
    }
}

static void ui_task(void *arg)
{
    // Button
    bool btn_raw_prev = false, btn_down = false;
    int64_t btn_changed = 0, btn_down_at = 0;
    // Switch
    bool sw_raw_prev = s_armed;
    int64_t sw_changed = 0;
    // Sound sequencer
    const sound_def_t *snd = NULL;
    static beep_t tune[TUNE_MAX_NOTES];
    static sound_def_t tune_def = {.beeps = tune};
    int64_t snd_started = 0, step_started = 0;
    int step = 0;
    bool step_on = false;

    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(TICK_MS));
        int64_t now = esp_timer_get_time() / 1000;

        // --- button: debounce, measure hold, report on release
        bool btn_raw = gpio_get_level(CONFIG_NOTIFIER_BUTTON_GPIO) == 0 ||
                       (CONFIG_NOTIFIER_BUTTON_ALT_GPIO >= 0 && gpio_get_level(CONFIG_NOTIFIER_BUTTON_ALT_GPIO) == 0);
        if (btn_raw != btn_raw_prev) {
            btn_raw_prev = btn_raw;
            btn_changed = now;
        }
        if (btn_raw != btn_down && now - btn_changed >= DEBOUNCE_MS) {
            btn_down = btn_raw;
            if (btn_down) {
                btn_down_at = now;
            } else {
                int64_t held = now - btn_down_at;
                button_event_t ev = held >= HOLD_RESET_MS   ? BUTTON_HOLD_RESET
                                    : held >= HOLD_SETUP_MS ? BUTTON_HOLD_SETUP
                                                            : BUTTON_SHORT;
                if (s_on_button) s_on_button(ev);
            }
        }

        // --- switch
        if (CONFIG_NOTIFIER_SWITCH_GPIO >= 0) {
            bool sw_raw = gpio_get_level(CONFIG_NOTIFIER_SWITCH_GPIO) == 1;
            if (sw_raw != sw_raw_prev) {
                sw_raw_prev = sw_raw;
                sw_changed = now;
            }
            if (sw_raw != s_armed && now - sw_changed >= SWITCH_DEBOUNCE_MS) {
                s_armed = sw_raw;
                ESP_LOGI(TAG, "switch: %s", s_armed ? "armed" : "quiet");
                if (s_on_switch) s_on_switch(s_armed);
            }
        }

        // --- sound sequencer
        if (s_stop_request) {
            s_stop_request = false;
            snd = NULL;
        }
        int req = s_sound_request;
        if (req >= 0) {
            s_sound_request = -1;
            snd = &SOUNDS[req];
            taskENTER_CRITICAL(&s_tune_lock);
            if (s_tune_request_len) {
                memcpy(tune, s_tune_request, s_tune_request_len * sizeof(beep_t));
                tune_def.count = s_tune_request_len;
                // A page's tune repeats for the whole alarm; a test plays it once.
                tune_def.loop_for_ms = req == SOUND_TEST ? 0 : snd->loop_for_ms;
                snd = &tune_def;
                s_tune_request_len = 0;
            }
            taskEXIT_CRITICAL(&s_tune_lock);
            snd_started = step_started = now;
            step = 0;
            step_on = true;
        }
        if (snd) {
            const beep_t *b = &snd->beeps[step];
            int64_t in_step = now - step_started;
            if (step_on && in_step >= b->on_ms) {
                step_on = false;
            }
            if (!step_on && in_step >= b->on_ms + b->off_ms) {
                step++;
                step_started = now;
                step_on = true;
                if (step >= snd->count) {
                    step = 0;
                    if (now - snd_started >= snd->loop_for_ms) snd = NULL;
                }
            }
        }
        bool sound_on = snd && step_on && snd->beeps[step].on_ms > 0;
        if (sound_on) set_tone(snd->beeps[step].freq_hz);
        static bool sound_was_on;
        if (sound_on != sound_was_on) {
            alarm_output(sound_on);
            sound_was_on = sound_on;
        }
        s_playing = snd != NULL;

        // --- LEDs, with hold feedback overriding the normal pattern:
        // 5s = green solid (release for setup), 15s = red flicker (release to reset).
        int64_t held = btn_down ? now - btn_down_at : 0;
        if (held >= HOLD_RESET_MS) {
            led_output(false, led_pattern_on(&LED_PATTERNS[LED_IDENTIFY].green, now));
        } else if (held >= HOLD_SETUP_MS) {
            led_output(true, false);
        } else {
            led_output(led_pattern_on(&LED_PATTERNS[s_led_mode].green, now),
                       led_pattern_on(&LED_PATTERNS[s_led_mode].red, now));
        }
    }
}

void ui_init(ui_button_cb_t on_button, ui_switch_cb_t on_switch)
{
    s_on_button = on_button;
    s_on_switch = on_switch;
    init_outputs();
    init_inputs();
    xTaskCreate(ui_task, "ui", 3072, NULL, 10, NULL);
}

void ui_set_led(led_mode_t mode)
{
    s_led_mode = mode;
}

void ui_play(sound_t sound)
{
    taskENTER_CRITICAL(&s_tune_lock);
    s_tune_request_len = 0;
    s_sound_request = sound;
    taskEXIT_CRITICAL(&s_tune_lock);
}

void ui_play_tune(sound_t sound, const char *rtttl)
{
    beep_t notes[TUNE_MAX_NOTES];
    int n = rtttl ? parse_rtttl(rtttl, notes, TUNE_MAX_NOTES) : 0;
    if (rtttl && !n) ESP_LOGW(TAG, "ignoring tune that isn't valid RTTTL: %.40s", rtttl);
    taskENTER_CRITICAL(&s_tune_lock);
    memcpy(s_tune_request, notes, n * sizeof(beep_t));
    s_tune_request_len = n;
    s_sound_request = sound;
    taskEXIT_CRITICAL(&s_tune_lock);
}

void ui_stop_sound(void)
{
    s_sound_request = -1;
    s_stop_request = true;
}

bool ui_sound_playing(void)
{
    return s_playing || s_sound_request >= 0;
}

bool ui_armed(void)
{
    return s_armed;
}
