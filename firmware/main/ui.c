#include "ui.h"

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

static const led_pattern_t LED_PATTERNS[] = {
    [LED_OFF] = {1000, {{0, 0}}},
    [LED_SETUP] = {2000, {{0, 1800}}},
    [LED_CONNECTING] = {250, {{0, 125}}},
    [LED_TROUBLE] = {2000, {{0, 1000}}},
    [LED_UNPAIRED] = {2000, {{0, 100}, {250, 350}}},
    [LED_OK] = {5000, {{0, 60}}},
    [LED_PAGE] = {200, {{0, 100}}},
    [LED_IDENTIFY] = {100, {{0, 50}}},
    [LED_UPDATING] = {1000, {{0, 50}, {200, 250}, {400, 450}}},
};

// ---- Sounds: a list of beeps, optionally looped for a total duration ----------------

typedef struct {
    uint16_t on_ms;
    uint16_t off_ms;
} beep_t;

typedef struct {
    const beep_t *beeps;
    uint8_t count;
    uint32_t loop_for_ms;  // 0 = play once
} sound_def_t;

static const beep_t BEEPS_ALARM[] = {{150, 100}, {150, 100}, {150, 600}};
static const beep_t BEEPS_SINGLE[] = {{120, 0}};
static const beep_t BEEPS_CHIRP[] = {{60, 0}};
static const beep_t BEEPS_DOUBLE[] = {{60, 100}, {60, 0}};
static const beep_t BEEPS_TINY[] = {{25, 0}};

static const sound_def_t SOUNDS[] = {
    [SOUND_PAGE] = {BEEPS_ALARM, 3, CONFIG_NOTIFIER_ALARM_SECONDS * 1000},
    [SOUND_REMINDER] = {BEEPS_SINGLE, 1, 0},
    [SOUND_TEST] = {BEEPS_ALARM, 3, 3000},
    [SOUND_OK] = {BEEPS_CHIRP, 1, 0},
    [SOUND_ERROR] = {BEEPS_DOUBLE, 2, 0},
    [SOUND_TROUBLE] = {BEEPS_TINY, 1, 0},
};

static ui_button_cb_t s_on_button;
static ui_switch_cb_t s_on_switch;

static volatile led_mode_t s_led_mode = LED_CONNECTING;
static volatile bool s_armed = true;

// Sound state is only touched by the UI task; requests come in via these.
static volatile int s_sound_request = -1;
static volatile bool s_stop_request;
static volatile bool s_playing;

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
    gpio_set_level(CONFIG_NOTIFIER_ALARM_GPIO, on);
#endif
}

static void led_output(bool on)
{
    gpio_set_level(CONFIG_NOTIFIER_LED_GPIO, CONFIG_NOTIFIER_LED_ACTIVE_LOW ? !on : on);
}

static bool led_pattern_on(led_mode_t mode, int64_t now_ms)
{
    const led_pattern_t *p = &LED_PATTERNS[mode];
    uint32_t t = now_ms % p->period;
    for (int i = 0; i < 3; i++) {
        if (t >= p->win[i][0] && t < p->win[i][1]) return true;
    }
    return false;
}

static void init_outputs(void)
{
    gpio_config_t led = {
        .pin_bit_mask = 1ULL << CONFIG_NOTIFIER_LED_GPIO,
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_ERROR_CHECK(gpio_config(&led));
    led_output(false);

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
    uint64_t mask = 1ULL << CONFIG_NOTIFIER_BUTTON_GPIO;
    if (CONFIG_NOTIFIER_SWITCH_GPIO >= 0) mask |= 1ULL << CONFIG_NOTIFIER_SWITCH_GPIO;
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
    int64_t snd_started = 0, step_started = 0;
    int step = 0;
    bool step_on = false;

    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        vTaskDelayUntil(&wake, pdMS_TO_TICKS(TICK_MS));
        int64_t now = esp_timer_get_time() / 1000;

        // --- button: debounce, measure hold, report on release
        bool btn_raw = gpio_get_level(CONFIG_NOTIFIER_BUTTON_GPIO) == 0;
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
        bool sound_on = snd && step_on;
        static bool sound_was_on;
        if (sound_on != sound_was_on) {
            alarm_output(sound_on);
            sound_was_on = sound_on;
        }
        s_playing = snd != NULL;

        // --- LED, with hold feedback overriding the normal pattern
        bool led;
        int64_t held = btn_down ? now - btn_down_at : 0;
        if (held >= HOLD_RESET_MS) {
            led = led_pattern_on(LED_IDENTIFY, now);
        } else if (held >= HOLD_SETUP_MS) {
            led = true;
        } else {
            led = led_pattern_on(s_led_mode, now);
        }
        led_output(led);
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
    s_sound_request = sound;
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
