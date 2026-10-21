#include "wifi.h"

#include <stdio.h>
#include <string.h>
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/timers.h"

static const char *TAG = "wifi";

#define BIT_GOT_IP BIT0
#define BIT_FAILED BIT1

static EventGroupHandle_t s_events;
static esp_netif_t *s_sta_netif;
static wifi_state_cb_t s_on_change;
static bool s_auto_reconnect;
static bool s_connected;
static int s_retry;
static TimerHandle_t s_retry_timer;

static void retry_connect(TimerHandle_t t)
{
    esp_wifi_connect();
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (s_auto_reconnect) esp_wifi_connect();
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *e = data;
        ESP_LOGW(TAG, "disconnected (reason %d)", e->reason);
        bool was = s_connected;
        s_connected = false;
        xEventGroupSetBits(s_events, BIT_FAILED);
        if (was && s_on_change) s_on_change(false);
        if (s_auto_reconnect) {
            // Back off 1s, 2s, 4s ... up to 60s so a dead AP doesn't spin the radio.
            int delay_s = 1 << (s_retry < 6 ? s_retry : 6);
            if (delay_s > 60) delay_s = 60;
            s_retry++;
            xTimerChangePeriod(s_retry_timer, pdMS_TO_TICKS(delay_s * 1000), 0);
            xTimerStart(s_retry_timer, 0);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *e = data;
        ESP_LOGI(TAG, "got ip " IPSTR, IP2STR(&e->ip_info.ip));
        s_retry = 0;
        s_connected = true;
        xEventGroupClearBits(s_events, BIT_FAILED);
        xEventGroupSetBits(s_events, BIT_GOT_IP);
        if (s_on_change) s_on_change(true);
    }
}

void wifi_init(wifi_state_cb_t on_change)
{
    s_on_change = on_change;
    s_events = xEventGroupCreate();
    s_retry_timer = xTimerCreate("wifi_retry", pdMS_TO_TICKS(1000), pdFALSE, NULL, retry_connect);

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_sta_netif = esp_netif_create_default_wifi_sta();
    esp_netif_create_default_wifi_ap();

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));  // we keep creds in our own NVS namespace
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL));
}

static void set_sta_config(const char *ssid, const char *pass)
{
    wifi_config_t cfg = {0};
    strlcpy((char *)cfg.sta.ssid, ssid, sizeof(cfg.sta.ssid));
    strlcpy((char *)cfg.sta.password, pass, sizeof(cfg.sta.password));
    cfg.sta.threshold.authmode = pass[0] ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN;
    cfg.sta.pmf_cfg.capable = true;
    cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    cfg.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
}

void wifi_start_sta(const char *ssid, const char *pass)
{
    s_auto_reconnect = true;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    set_sta_config(ssid, pass);
    // Modem sleep keeps the radio associated (so pages arrive instantly) at lower power.
    esp_wifi_set_ps(WIFI_PS_MIN_MODEM);
    ESP_ERROR_CHECK(esp_wifi_start());
}

void wifi_start_setup_ap(const char *ap_ssid)
{
    s_auto_reconnect = false;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA));
    wifi_config_t ap = {0};
    strlcpy((char *)ap.ap.ssid, ap_ssid, sizeof(ap.ap.ssid));
    ap.ap.ssid_len = strlen(ap_ssid);
    ap.ap.channel = 1;
    ap.ap.max_connection = 2;
    ap.ap.authmode = WIFI_AUTH_OPEN;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &ap));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_LOGI(TAG, "setup AP \"%s\" up", ap_ssid);
}

bool wifi_try_join(const char *ssid, const char *pass, int timeout_ms)
{
    esp_wifi_disconnect();
    xEventGroupClearBits(s_events, BIT_GOT_IP | BIT_FAILED);
    set_sta_config(ssid, pass);
    esp_wifi_connect();
    EventBits_t bits = xEventGroupWaitBits(s_events, BIT_GOT_IP | BIT_FAILED, pdFALSE, pdFALSE,
                                           pdMS_TO_TICKS(timeout_ms));
    return bits & BIT_GOT_IP;
}

int wifi_scan(wifi_ap_record_t *out, int max)
{
    wifi_scan_config_t scan = {.show_hidden = false};
    if (esp_wifi_scan_start(&scan, true) != ESP_OK) return 0;
    uint16_t n = max;
    esp_wifi_scan_get_ap_records(&n, out);
    return n;
}

bool wifi_connected(void)
{
    return s_connected;
}

int wifi_rssi(void)
{
    int rssi = 0;
    if (s_connected) esp_wifi_sta_get_rssi(&rssi);
    return rssi;
}

void wifi_ip(char *out, size_t len)
{
    esp_netif_ip_info_t info = {0};
    esp_netif_get_ip_info(s_sta_netif, &info);
    snprintf(out, len, IPSTR, IP2STR(&info.ip));
}
