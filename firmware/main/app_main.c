/*
 * SAR Beepers pager firmware.
 *
 * Boot -> (no Wi-Fi settings, or button held 5s) -> setup portal (portal.c)
 *      -> join Wi-Fi -> register over HTTPS -> MQTT link -> wait for pages.
 *
 * Everything that changes state funnels through one event queue handled by the main
 * task; the UI, Wi-Fi and MQTT modules only post to it.
 */
#include <stdlib.h>
#include <string.h>
#include "esp_app_desc.h"
#include "esp_attr.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "link.h"
#include "ota.h"
#include "portal.h"
#include "sdkconfig.h"
#include "server_api.h"
#include "settings.h"
#include "ui.h"
#include "wifi.h"

static const char *TAG = "app";

// The server reads this marker from uploaded images to tell which board they are for.
static const char BOARD_TAG[] = "SAR_BOARD=" CONFIG_NOTIFIER_BOARD;

#define MAX_PENDING 8
#define RECENT_IDS 16
#define REMINDER_EVERY_MS (60 * 1000)
#define TROUBLE_EVERY_MS (10 * 60 * 1000)
#define IDENTIFY_MS (10 * 1000)
#define REGISTER_BACKOFF_MAX_MS (5 * 60 * 1000)

// Survives esp_restart() (but not power loss): "go to setup mode after this reboot".
#define BOOT_TO_SETUP_MAGIC 0x5e7a9b01
static RTC_NOINIT_ATTR uint32_t s_boot_to_setup;

typedef enum {
    EV_BUTTON,
    EV_SWITCH,
    EV_WIFI,
    EV_LINK_UP,
    EV_LINK_DOWN,
    EV_LINK_REFUSED,
    EV_CONFIG,
    EV_PAGE,
    EV_COMMAND,
} event_type_t;

typedef struct {
    event_type_t type;
    int32_t num;
    bool flag;
    char str[16];
    char *tune;  // heap copy of the server's RTTTL tune, or NULL; freed by the handler
} app_event_t;

static QueueHandle_t s_queue;

static struct {
    settings_t settings;
    bool registered;
    bool claimed;
    bool link_up;
    bool ever_connected;
    int64_t disconnected_since;
    int64_t next_register_at;
    int register_backoff_ms;

    int32_t pending[MAX_PENDING];
    int n_pending;
    int32_t recent[RECENT_IDS];
    int recent_next;

    int64_t alarm_started_at;
    int64_t reminders_until;
    int64_t last_reminder_at;
    int64_t last_trouble_at;
    int64_t identify_until;
} app;

static int64_t now_ms(void)
{
    return esp_timer_get_time() / 1000;
}

static void post(app_event_t ev)
{
    if (xQueueSend(s_queue, &ev, 0) != pdTRUE) free(ev.tune);
}

// ---- callbacks from other modules (run on their tasks) ----------------------------

static void cb_button(button_event_t e) { post((app_event_t){.type = EV_BUTTON, .num = e}); }
static void cb_switch(bool armed) { post((app_event_t){.type = EV_SWITCH, .flag = armed}); }
static void cb_wifi(bool up) { post((app_event_t){.type = EV_WIFI, .flag = up}); }
static void cb_link_up(void) { post((app_event_t){.type = EV_LINK_UP}); }
static void cb_link_down(void) { post((app_event_t){.type = EV_LINK_DOWN}); }
static void cb_link_refused(void) { post((app_event_t){.type = EV_LINK_REFUSED}); }
static void cb_config(bool claimed) { post((app_event_t){.type = EV_CONFIG, .flag = claimed}); }
static void cb_page(int32_t id, bool alarm, const char *tune)
{
    post((app_event_t){.type = EV_PAGE, .num = id, .flag = alarm, .tune = tune ? strdup(tune) : NULL});
}

static void cb_command(const char *cmd, const char *tune)
{
    app_event_t ev = {.type = EV_COMMAND, .tune = tune ? strdup(tune) : NULL};
    strlcpy(ev.str, cmd, sizeof(ev.str));
    post(ev);
}

static void cb_ota(const char *url, const char *version)
{
    if (ota_start(url, version)) ESP_LOGI(TAG, "OTA to %s started", version);
}

// ---- event handling -------------------------------------------------------------------

static bool seen_recently(int32_t id)
{
    for (int i = 0; i < RECENT_IDS; i++) {
        if (app.recent[i] == id) return true;
    }
    return false;
}

static void handle_page(int32_t id, bool alarm, const char *tune)
{
    // Always confirm receipt, even for duplicates, so the server stops replaying it.
    link_send_ack(id, false);
    if (seen_recently(id)) return;
    app.recent[app.recent_next] = id;
    app.recent_next = (app.recent_next + 1) % RECENT_IDS;

    if (app.n_pending < MAX_PENDING) app.pending[app.n_pending++] = id;
    ESP_LOGI(TAG, "page %ld (alarm=%d armed=%d)", (long)id, alarm, ui_armed());

    if (alarm) {
        app.alarm_started_at = now_ms();
        app.last_reminder_at = app.alarm_started_at;
        app.reminders_until = app.alarm_started_at + CONFIG_NOTIFIER_ALARM_SECONDS * 1000LL +
                              CONFIG_NOTIFIER_REMINDER_MINUTES * 60 * 1000LL;
        if (ui_armed()) ui_play_tune(SOUND_PAGE, tune);
    }
}

static void acknowledge_pages(void)
{
    for (int i = 0; i < app.n_pending; i++) link_send_ack(app.pending[i], true);
    app.n_pending = 0;
    app.reminders_until = 0;
    ui_stop_sound();
}

static void reboot_to_setup(void)
{
    s_boot_to_setup = BOOT_TO_SETUP_MAGIC;
    esp_restart();
}

static void handle_button(button_event_t e)
{
    switch (e) {
    case BUTTON_SHORT:
        if (app.n_pending > 0) {
            acknowledge_pages();
            ui_play(SOUND_OK);
        } else if (ui_sound_playing()) {
            ui_stop_sound();
        } else {
            // "Are you working?" - one chirp if fully connected, two if not.
            ui_play(app.link_up && app.claimed ? SOUND_OK : SOUND_ERROR);
        }
        break;
    case BUTTON_HOLD_SETUP:
        ESP_LOGI(TAG, "button hold: setup mode");
        reboot_to_setup();
        break;
    case BUTTON_HOLD_RESET:
        ESP_LOGW(TAG, "button hold: factory reset");
        settings_clear();
        reboot_to_setup();
        break;
    }
}

static void handle_command(const char *cmd, const char *tune)
{
    if (strcmp(cmd, "test") == 0) {
        ui_play_tune(SOUND_TEST, tune);  // deliberately ignores the quiet switch: it's a test
    } else if (strcmp(cmd, "identify") == 0) {
        app.identify_until = now_ms() + IDENTIFY_MS;
    } else if (strcmp(cmd, "reboot") == 0) {
        esp_restart();
    }
}

static void handle_event(const app_event_t *ev)
{
    switch (ev->type) {
    case EV_BUTTON:
        handle_button((button_event_t)ev->num);
        break;
    case EV_SWITCH:
        if (!ev->flag && ui_sound_playing()) ui_stop_sound();
        link_send_status(false);  // let the dashboard show quiet mode right away
        break;
    case EV_WIFI:
        if (ev->flag && !app.registered) app.next_register_at = 0;
        break;
    case EV_LINK_UP:
        app.link_up = true;
        app.ever_connected = true;
        ota_confirm();
        const char *rolled_back = ota_take_rollback_report();
        if (rolled_back) link_send_event("ota_rollback", rolled_back);
        break;
    case EV_LINK_DOWN:
        if (app.link_up) app.disconnected_since = now_ms();
        app.link_up = false;
        break;
    case EV_LINK_REFUSED:
        app.registered = false;
        app.next_register_at = now_ms() + 2000;
        break;
    case EV_CONFIG:
        app.claimed = ev->flag;
        break;
    case EV_PAGE:
        handle_page(ev->num, ev->flag, ev->tune);
        break;
    case EV_COMMAND:
        handle_command(ev->str, ev->tune);
        break;
    }
    free(ev->tune);
}

// ---- periodic work --------------------------------------------------------------------

static void try_register(void)
{
    register_result_t reg;
    if (server_register(app.settings.server_url, &reg) == ESP_OK && reg.mqtt_url[0]) {
        app.registered = true;
        app.claimed = reg.claimed;
        app.register_backoff_ms = 0;
        static bool link_started;
        if (!link_started) {
            link_callbacks_t cb = {
                .on_connected = cb_link_up,
                .on_disconnected = cb_link_down,
                .on_config = cb_config,
                .on_page = cb_page,
                .on_command = cb_command,
                .on_ota = cb_ota,
                .on_refused = cb_link_refused,
            };
            link_start(reg.mqtt_url, &cb);
            link_started = true;
        }
        return;
    }
    // Server unreachable or refusing us: back off 5s, 10s, 20s ... 5 min.
    app.register_backoff_ms = app.register_backoff_ms ? app.register_backoff_ms * 2 : 5000;
    if (app.register_backoff_ms > REGISTER_BACKOFF_MAX_MS) app.register_backoff_ms = REGISTER_BACKOFF_MAX_MS;
    app.next_register_at = now_ms() + app.register_backoff_ms;
}

static void tick(void)
{
    int64_t now = now_ms();

    if (wifi_connected() && !app.registered && now >= app.next_register_at) try_register();

    // Reminder beeps for an unacknowledged page once the main alarm has finished.
    if (app.n_pending > 0 && ui_armed() && !ui_sound_playing() && now < app.reminders_until &&
        now - app.last_reminder_at >= REMINDER_EVERY_MS) {
        app.last_reminder_at = now;
        ui_play(SOUND_REMINDER);
    }

    // Trouble chirp: we've been unable to reach the server for too long.
    if (CONFIG_NOTIFIER_TROUBLE_CHIRP_MINUTES > 0 && !app.link_up && ui_armed() &&
        now - app.disconnected_since >= CONFIG_NOTIFIER_TROUBLE_CHIRP_MINUTES * 60 * 1000LL &&
        now - app.last_trouble_at >= TROUBLE_EVERY_MS && !ui_sound_playing()) {
        app.last_trouble_at = now;
        ui_play(SOUND_TROUBLE);
    }

    led_mode_t led;
    if (ota_in_progress()) led = LED_UPDATING;
    else if (now < app.identify_until) led = LED_IDENTIFY;
    else if (app.n_pending > 0) led = LED_PAGE;
    else if (!app.link_up) led = app.ever_connected ? LED_TROUBLE : LED_CONNECTING;
    else if (!app.claimed) led = LED_UNPAIRED;
    else led = LED_OK;
    ui_set_led(led);
}

void app_main(void)
{
    ESP_LOGI(TAG, "SAR Beepers %s for %s", esp_app_get_description()->version, BOARD_TAG + strlen("SAR_BOARD="));
    s_queue = xQueueCreate(16, sizeof(app_event_t));

    ESP_ERROR_CHECK(settings_init());
    ui_init(cb_button, cb_switch);
    ota_boot_check();
    ESP_LOGI(TAG, "device id %s", settings_device_id());

    bool configured = settings_load(&app.settings);
    bool want_setup = s_boot_to_setup == BOOT_TO_SETUP_MAGIC;
    s_boot_to_setup = 0;

    wifi_init(cb_wifi);
    if (!configured || want_setup) {
        portal_run();  // never returns
    }

    wifi_start_sta(app.settings.ssid, app.settings.pass);
    settings_device_secret();

    app.disconnected_since = now_ms();
    for (;;) {
        app_event_t ev;
        while (xQueueReceive(s_queue, &ev, pdMS_TO_TICKS(100)) == pdTRUE) {
            handle_event(&ev);
        }
        tick();
    }
}
