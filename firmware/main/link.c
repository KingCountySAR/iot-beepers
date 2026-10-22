#include "link.h"

#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "mqtt_client.h"
#include "sdkconfig.h"
#include "settings.h"
#include "ui.h"
#include "wifi.h"

static const char *TAG = "link";

#define HEARTBEAT_US (60LL * 1000 * 1000)

static esp_mqtt_client_handle_t s_client;
static link_callbacks_t s_cb;
static volatile bool s_connected;
static char s_topic_prefix[24];  // "dev/<id>/"
static esp_timer_handle_t s_heartbeat;

static const char *reset_reason_str(void)
{
    switch (esp_reset_reason()) {
    case ESP_RST_POWERON: return "power-on";
    case ESP_RST_SW: return "software";
    case ESP_RST_PANIC: return "panic";
    case ESP_RST_INT_WDT:
    case ESP_RST_TASK_WDT:
    case ESP_RST_WDT: return "watchdog";
    case ESP_RST_BROWNOUT: return "brownout";
    case ESP_RST_DEEPSLEEP: return "deep-sleep";
    case ESP_RST_EXT: return "external";
    default: return "other";
    }
}

static void publish_json(const char *kind, cJSON *json)
{
    if (!s_connected) {
        cJSON_Delete(json);
        return;
    }
    char topic[40];
    snprintf(topic, sizeof(topic), "%s%s", s_topic_prefix, kind);
    char *s = cJSON_PrintUnformatted(json);
    esp_mqtt_client_enqueue(s_client, topic, s, 0, 1, 0, true);
    cJSON_free(s);
    cJSON_Delete(json);
}

void link_send_status(bool hello)
{
    static bool first_hello = true;
    char ip[16];
    wifi_ip(ip, sizeof(ip));
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "type", hello ? "hello" : "heartbeat");
    cJSON_AddStringToObject(j, "fw", esp_app_get_description()->version);
    cJSON_AddBoolToObject(j, "armed", ui_armed());
    cJSON_AddNumberToObject(j, "rssi", wifi_rssi());
    cJSON_AddStringToObject(j, "ip", ip);
    cJSON_AddNumberToObject(j, "uptime", (double)(esp_timer_get_time() / 1000000));
    cJSON_AddNumberToObject(j, "heap", esp_get_free_heap_size());
    if (hello) {
        cJSON_AddStringToObject(j, "hw", CONFIG_NOTIFIER_BOARD);
        // Reset reason only means something on the first connection after boot.
        if (first_hello) cJSON_AddStringToObject(j, "reset", reset_reason_str());
        first_hello = false;
    }
    publish_json("status", j);
}

void link_send_ack(int32_t page_id, bool acked)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddNumberToObject(j, "page", page_id);
    cJSON_AddStringToObject(j, "state", acked ? "acked" : "received");
    publish_json("ack", j);
}

void link_send_event(const char *type, const char *detail)
{
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "type", type);
    cJSON_AddStringToObject(j, "detail", detail ? detail : "");
    publish_json("event", j);
}

static void heartbeat(void *arg)
{
    link_send_status(false);
}

static void handle_message(const char *kind, cJSON *json)
{
    if (strcmp(kind, "config") == 0) {
        if (s_cb.on_config) s_cb.on_config(cJSON_IsTrue(cJSON_GetObjectItem(json, "claimed")));
    } else if (strcmp(kind, "page") == 0) {
        cJSON *id = cJSON_GetObjectItem(json, "id");
        if (cJSON_IsNumber(id) && s_cb.on_page) {
            s_cb.on_page((int32_t)id->valuedouble, cJSON_IsTrue(cJSON_GetObjectItem(json, "alarm")));
        }
    } else if (strcmp(kind, "cmd") == 0) {
        cJSON *cmd = cJSON_GetObjectItem(json, "cmd");
        if (!cJSON_IsString(cmd)) return;
        if (strcmp(cmd->valuestring, "ota") == 0) {
            cJSON *url = cJSON_GetObjectItem(json, "url");
            cJSON *ver = cJSON_GetObjectItem(json, "version");
            if (cJSON_IsString(url) && cJSON_IsString(ver) && s_cb.on_ota) {
                s_cb.on_ota(url->valuestring, ver->valuestring);
            }
        } else if (s_cb.on_command) {
            s_cb.on_command(cmd->valuestring);
        }
    }
}

static void on_mqtt_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    esp_mqtt_event_handle_t ev = data;
    switch ((esp_mqtt_event_id_t)id) {
    case MQTT_EVENT_CONNECTED: {
        ESP_LOGI(TAG, "connected");
        s_connected = true;
        char sub[32];
        snprintf(sub, sizeof(sub), "%s#", s_topic_prefix);
        esp_mqtt_client_subscribe(s_client, sub, 1);
        break;
    }
    case MQTT_EVENT_SUBSCRIBED:
        // Only say hello once subscribed, so the server's replies (config, missed pages) land.
        link_send_status(true);
        esp_timer_stop(s_heartbeat);
        esp_timer_start_periodic(s_heartbeat, HEARTBEAT_US);
        if (s_cb.on_connected) s_cb.on_connected();
        break;
    case MQTT_EVENT_DISCONNECTED:
        if (s_connected) ESP_LOGW(TAG, "disconnected");
        s_connected = false;
        esp_timer_stop(s_heartbeat);
        if (s_cb.on_disconnected) s_cb.on_disconnected();
        break;
    case MQTT_EVENT_DATA: {
        if (ev->current_data_offset != 0 || ev->data_len != ev->total_data_len) {
            ESP_LOGW(TAG, "dropping fragmented message (%d bytes)", ev->total_data_len);
            break;
        }
        size_t plen = strlen(s_topic_prefix);
        if (ev->topic_len <= plen || strncmp(ev->topic, s_topic_prefix, plen) != 0) break;
        char kind[16];
        int klen = ev->topic_len - plen;
        if (klen >= sizeof(kind)) break;
        memcpy(kind, ev->topic + plen, klen);
        kind[klen] = '\0';
        cJSON *json = cJSON_ParseWithLength(ev->data, ev->data_len);
        if (json) {
            handle_message(kind, json);
            cJSON_Delete(json);
        }
        break;
    }
    case MQTT_EVENT_ERROR:
        if (ev->error_handle->error_type == MQTT_ERROR_TYPE_CONNECTION_REFUSED) {
            ESP_LOGE(TAG, "connection refused (code %d)", ev->error_handle->connect_return_code);
            if (s_cb.on_refused) s_cb.on_refused();
        }
        break;
    default:
        break;
    }
}

void link_start(const char *mqtt_url, const link_callbacks_t *cb)
{
    s_cb = *cb;
    snprintf(s_topic_prefix, sizeof(s_topic_prefix), "dev/%s/", settings_device_id());

    const esp_timer_create_args_t hb = {.callback = heartbeat, .name = "heartbeat"};
    ESP_ERROR_CHECK(esp_timer_create(&hb, &s_heartbeat));

    esp_mqtt_client_config_t cfg = {
        .broker.address.uri = mqtt_url,
        .broker.verification.crt_bundle_attach = esp_crt_bundle_attach,
        .credentials.client_id = settings_device_id(),
        .credentials.username = settings_device_id(),
        .credentials.authentication.password = settings_device_secret(),
        // Short keepalive so both ends notice a dead link within ~45s.
        .session.keepalive = 30,
        .session.disable_clean_session = false,
        .network.reconnect_timeout_ms = 5000,
        .network.timeout_ms = 10000,
        .buffer.size = 2048,
        .buffer.out_size = 1024,
    };
    s_client = esp_mqtt_client_init(&cfg);
    esp_mqtt_client_register_event(s_client, ESP_EVENT_ANY_ID, on_mqtt_event, NULL);
    ESP_ERROR_CHECK(esp_mqtt_client_start(s_client));
}

bool link_connected(void)
{
    return s_connected;
}
