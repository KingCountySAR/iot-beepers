#include "server_api.h"

#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "sdkconfig.h"
#include "settings.h"

static const char *TAG = "server_api";

static void copy_json_str(cJSON *obj, const char *key, char *out, size_t len)
{
    cJSON *v = cJSON_GetObjectItem(obj, key);
    if (cJSON_IsString(v)) strlcpy(out, v->valuestring, len);
}

esp_err_t server_register(const char *server_url, register_result_t *out)
{
    memset(out, 0, sizeof(*out));

    char url[200];
    snprintf(url, sizeof(url), "%s/api/device/register", server_url);

    cJSON *req = cJSON_CreateObject();
    cJSON_AddStringToObject(req, "id", settings_device_id());
    cJSON_AddStringToObject(req, "secret", settings_device_secret());
    cJSON_AddStringToObject(req, "fw", esp_app_get_description()->version);
    cJSON_AddStringToObject(req, "hw", CONFIG_NOTIFIER_BOARD);
    char *body = cJSON_PrintUnformatted(req);
    cJSON_Delete(req);

    esp_http_client_config_t cfg = {
        .url = url,
        .method = HTTP_METHOD_POST,
        .timeout_ms = 10000,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&cfg);
    esp_http_client_set_header(client, "Content-Type", "application/json");

    esp_err_t err = esp_http_client_open(client, strlen(body));
    if (err != ESP_OK) {
        snprintf(out->error, sizeof(out->error), "Can't reach server (%s)", esp_err_to_name(err));
        goto done;
    }
    esp_http_client_write(client, body, strlen(body));
    esp_http_client_fetch_headers(client);
    int status = esp_http_client_get_status_code(client);

    char resp[768];
    int n = esp_http_client_read_response(client, resp, sizeof(resp) - 1);
    resp[n > 0 ? n : 0] = '\0';

    cJSON *json = cJSON_Parse(resp);
    if (status != 200 || !json) {
        if (json) copy_json_str(json, "error", out->error, sizeof(out->error));
        if (!out->error[0]) snprintf(out->error, sizeof(out->error), "Server returned HTTP %d", status);
        err = ESP_FAIL;
    } else {
        out->claimed = cJSON_IsTrue(cJSON_GetObjectItem(json, "claimed"));
        copy_json_str(json, "mqttUrl", out->mqtt_url, sizeof(out->mqtt_url));
        copy_json_str(json, "claimCode", out->claim_code, sizeof(out->claim_code));
        copy_json_str(json, "claimUrl", out->claim_url, sizeof(out->claim_url));
        copy_json_str(json, "owner", out->owner, sizeof(out->owner));
        ESP_LOGI(TAG, "registered: claimed=%d code=%s", out->claimed, out->claim_code);
    }
    cJSON_Delete(json);

done:
    if (err != ESP_OK) ESP_LOGW(TAG, "register failed: %s", out->error);
    esp_http_client_cleanup(client);
    cJSON_free(body);
    return err;
}
