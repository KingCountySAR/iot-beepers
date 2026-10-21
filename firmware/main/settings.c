#include "settings.h"

#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

static const char *TAG = "settings";

// User-facing settings live in "cfg" (wiped by factory reset); identity lives in "ident".
#define NS_CFG "cfg"
#define NS_IDENT "ident"

static char s_device_id[13];
static char s_secret[65];

esp_err_t settings_init(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_LOGW(TAG, "NVS partition unreadable, erasing");
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err != ESP_OK) return err;

    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    snprintf(s_device_id, sizeof(s_device_id), "%02x%02x%02x%02x%02x%02x",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    return ESP_OK;
}

static void get_str(nvs_handle_t h, const char *key, char *out, size_t len, const char *def)
{
    size_t n = len;
    if (nvs_get_str(h, key, out, &n) != ESP_OK) {
        strlcpy(out, def, len);
    }
}

bool settings_load(settings_t *out)
{
    memset(out, 0, sizeof(*out));
    strlcpy(out->server_url, CONFIG_NOTIFIER_DEFAULT_SERVER_URL, sizeof(out->server_url));

    nvs_handle_t h;
    if (nvs_open(NS_CFG, NVS_READONLY, &h) != ESP_OK) return false;
    get_str(h, "ssid", out->ssid, sizeof(out->ssid), "");
    get_str(h, "pass", out->pass, sizeof(out->pass), "");
    get_str(h, "server", out->server_url, sizeof(out->server_url), CONFIG_NOTIFIER_DEFAULT_SERVER_URL);
    nvs_close(h);
    return out->ssid[0] != '\0';
}

esp_err_t settings_save(const settings_t *s)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS_CFG, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_str(h, "ssid", s->ssid);
    if (err == ESP_OK) err = nvs_set_str(h, "pass", s->pass);
    if (err == ESP_OK) err = nvs_set_str(h, "server", s->server_url);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

esp_err_t settings_clear(void)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS_CFG, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_erase_all(h);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}

const char *settings_device_id(void)
{
    return s_device_id;
}

const char *settings_device_secret(void)
{
    if (s_secret[0]) return s_secret;

    nvs_handle_t h;
    ESP_ERROR_CHECK(nvs_open(NS_IDENT, NVS_READWRITE, &h));
    size_t n = sizeof(s_secret);
    if (nvs_get_str(h, "secret", s_secret, &n) != ESP_OK || strlen(s_secret) != 64) {
        uint8_t raw[32];
        esp_fill_random(raw, sizeof(raw));
        for (int i = 0; i < 32; i++) {
            snprintf(&s_secret[i * 2], 3, "%02x", raw[i]);
        }
        ESP_ERROR_CHECK(nvs_set_str(h, "secret", s_secret));
        ESP_ERROR_CHECK(nvs_commit(h));
        ESP_LOGI(TAG, "generated device secret");
    }
    nvs_close(h);
    return s_secret;
}

bool settings_get_str(const char *key, char *out, size_t len)
{
    nvs_handle_t h;
    if (nvs_open(NS_IDENT, NVS_READONLY, &h) != ESP_OK) return false;
    size_t n = len;
    bool ok = nvs_get_str(h, key, out, &n) == ESP_OK;
    nvs_close(h);
    return ok;
}

esp_err_t settings_set_str(const char *key, const char *value)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open(NS_IDENT, NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_str(h, key, value);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    return err;
}
