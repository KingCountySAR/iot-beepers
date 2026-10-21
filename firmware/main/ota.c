#include "ota.h"

#include <stdio.h>
#include <string.h>
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_https_ota.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "link.h"
#include "settings.h"
#include "ui.h"

static const char *TAG = "ota";

/** A new image gets this long to connect to the server before we roll back. */
#define CONFIRM_TIMEOUT_US (5LL * 60 * 1000 * 1000)

static esp_timer_handle_t s_rollback_timer;
static bool s_pending_verify;
static volatile bool s_running;
static char s_url[256];
static char s_version[32];
static char s_rollback_version[32];

static void rollback(void *arg)
{
    ESP_LOGE(TAG, "new image never reached the server; rolling back");
    esp_ota_mark_app_invalid_rollback_and_reboot();
}

void ota_boot_check(void)
{
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK && state == ESP_OTA_IMG_PENDING_VERIFY) {
        ESP_LOGW(TAG, "running unconfirmed image %s", esp_app_get_description()->version);
        s_pending_verify = true;
        const esp_timer_create_args_t args = {.callback = rollback, .name = "ota_rollback"};
        ESP_ERROR_CHECK(esp_timer_create(&args, &s_rollback_timer));
        esp_timer_start_once(s_rollback_timer, CONFIRM_TIMEOUT_US);
    }

    // Was a newer image rejected? Report each failed version once.
    const esp_partition_t *invalid = esp_ota_get_last_invalid_partition();
    esp_app_desc_t desc;
    if (invalid && esp_ota_get_partition_description(invalid, &desc) == ESP_OK) {
        char reported[32] = "";
        settings_get_str("rb_reported", reported, sizeof(reported));
        if (strcmp(reported, desc.version) != 0) {
            strlcpy(s_rollback_version, desc.version, sizeof(s_rollback_version));
        }
    }
}

void ota_confirm(void)
{
    if (!s_pending_verify) return;
    s_pending_verify = false;
    esp_timer_stop(s_rollback_timer);
    esp_ota_mark_app_valid_cancel_rollback();
    ESP_LOGI(TAG, "image %s confirmed", esp_app_get_description()->version);
    link_send_event("ota_ok", esp_app_get_description()->version);
}

const char *ota_take_rollback_report(void)
{
    if (!s_rollback_version[0]) return NULL;
    settings_set_str("rb_reported", s_rollback_version);
    static char out[32];
    strlcpy(out, s_rollback_version, sizeof(out));
    s_rollback_version[0] = '\0';
    return out;
}

static void ota_task(void *arg)
{
    ESP_LOGI(TAG, "updating to %s from %s", s_version, s_url);
    ui_set_led(LED_UPDATING);
    link_send_event("ota_start", s_version);

    esp_http_client_config_t http = {
        .url = s_url,
        .timeout_ms = 30000,
        .keep_alive_enable = true,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_https_ota_config_t cfg = {.http_config = &http};
    esp_https_ota_handle_t handle = NULL;
    char detail[96] = "";

    esp_err_t err = esp_https_ota_begin(&cfg, &handle);
    if (err != ESP_OK) {
        snprintf(detail, sizeof(detail), "begin: %s", esp_err_to_name(err));
        goto fail;
    }

    esp_app_desc_t desc;
    err = esp_https_ota_get_img_desc(handle, &desc);
    if (err == ESP_OK && strcmp(desc.version, s_version) != 0) {
        snprintf(detail, sizeof(detail), "image is %s, expected %s", desc.version, s_version);
        err = ESP_ERR_INVALID_VERSION;
    }
    if (err != ESP_OK) {
        if (!detail[0]) snprintf(detail, sizeof(detail), "desc: %s", esp_err_to_name(err));
        esp_https_ota_abort(handle);
        goto fail;
    }

    while ((err = esp_https_ota_perform(handle)) == ESP_ERR_HTTPS_OTA_IN_PROGRESS) {
    }
    if (err != ESP_OK || !esp_https_ota_is_complete_data_received(handle)) {
        snprintf(detail, sizeof(detail), "download: %s", esp_err_to_name(err));
        esp_https_ota_abort(handle);
        goto fail;
    }

    // Verifies the image (including its appended SHA-256) and sets it as the boot partition.
    err = esp_https_ota_finish(handle);
    if (err != ESP_OK) {
        snprintf(detail, sizeof(detail), "verify: %s", esp_err_to_name(err));
        goto fail;
    }

    ESP_LOGI(TAG, "update installed; rebooting");
    link_send_event("ota_installed", s_version);
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();

fail:
    ESP_LOGE(TAG, "update failed: %s", detail);
    link_send_event("ota_failed", detail);
    s_running = false;
    vTaskDelete(NULL);
}

bool ota_start(const char *url, const char *expected_version)
{
    if (s_running) return false;
    if (strcmp(expected_version, esp_app_get_description()->version) == 0) return false;
    s_running = true;
    strlcpy(s_url, url, sizeof(s_url));
    strlcpy(s_version, expected_version, sizeof(s_version));
    xTaskCreate(ota_task, "ota", 8192, NULL, 4, NULL);
    return true;
}

bool ota_in_progress(void)
{
    return s_running;
}
