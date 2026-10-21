#include "portal.h"

#include <ctype.h>
#include <stdio.h>
#include <string.h>
#include "cJSON.h"
#include "dns_server.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_system.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "server_api.h"
#include "settings.h"
#include "ui.h"
#include "wifi.h"

static const char *TAG = "portal";

#define PORTAL_TIMEOUT_MS (15 * 60 * 1000)

typedef enum { ST_IDLE, ST_JOINING, ST_REGISTERING, ST_DONE, ST_ERROR } portal_state_t;

static SemaphoreHandle_t s_lock;
static portal_state_t s_state = ST_IDLE;
static char s_message[200];
static settings_t s_pending;
static register_result_t s_reg;

static const char PAGE_HTML[] =
    "<!doctype html><html><head><meta charset=utf-8>"
    "<meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>SAR Pager setup</title><style>"
    "body{font-family:system-ui,sans-serif;max-width:420px;margin:0 auto;padding:16px;background:#fff;color:#1c2430}"
    "h1{color:#d94f1e;font-size:1.4rem}label{display:block;margin:12px 0 4px}"
    "input,select{width:100%;padding:10px;font-size:1rem;box-sizing:border-box;border:1px solid #ccc;border-radius:6px}"
    "button{margin-top:16px;width:100%;padding:12px;font-size:1rem;background:#d94f1e;color:#fff;border:0;border-radius:6px}"
    ".code{font:700 2.2rem ui-monospace,monospace;letter-spacing:.3em;text-align:center;margin:12px 0}"
    ".err{color:#b3261e}.muted{color:#6a7482;font-size:.9rem}a{color:#d94f1e;word-break:break-all}"
    "</style></head><body><h1>SAR Pager setup</h1>"
    "<p class=muted>Device <b id=dev></b></p>"
    "<form id=f><label>Home Wi-Fi network</label><input id=ssid name=ssid list=nets required autocomplete=off>"
    "<datalist id=nets></datalist>"
    "<label>Wi-Fi password</label><input id=pass name=pass type=password placeholder='(unchanged if blank)'>"
    "<label>Server</label><input id=server name=server type=url required>"
    "<button>Connect</button></form>"
    "<div id=out></div>"
    "<script>"
    "const $=i=>document.getElementById(i);"
    "fetch('/info').then(r=>r.json()).then(i=>{$('dev').textContent=i.id;$('ssid').value=i.ssid;$('server').value=i.server});"
    "fetch('/scan').then(r=>r.json()).then(l=>{for(const n of l){const o=document.createElement('option');"
    "o.value=n.ssid;o.label=n.ssid+' ('+n.rssi+' dBm)';$('nets').appendChild(o)}});"
    "$('f').onsubmit=async e=>{e.preventDefault();$('out').innerHTML='<p>Connecting…</p>';"
    "await fetch('/save',{method:'POST',body:new URLSearchParams(new FormData($('f')))});poll()};"
    "async function poll(){const s=await (await fetch('/status')).json();"
    "if(s.state==='joining'||s.state==='registering'){$('out').innerHTML='<p>'+s.message+'</p>';return setTimeout(poll,1000)}"
    "if(s.state==='error'){$('out').innerHTML='<p class=err>'+s.message+'</p>';return}"
    "if(s.state==='done'){$('f').style.display='none';"
    "$('out').innerHTML=s.claimed?'<p>Connected! This pager is paired to <b>'+s.owner+'</b>.</p>':"
    "'<p>Connected! Now pair this pager to your account. Your pairing code is:</p><div class=code>'+s.code+'</div>'"
    "+'<p>Reconnect your phone to your normal Wi-Fi, then open:</p><p><a href=\"'+s.url+'\">'+s.url+'</a></p>'"
    "+'<p class=muted>The code is good for 30 minutes. You can pair after tapping Finish.</p>';"
    "$('out').innerHTML+='<button onclick=\"fetch(\\'/finish\\',{method:\\'POST\\'});this.outerHTML=\\'<p>Restarting… the green light blips every few seconds once it is listening.</p>\\'\">Finish</button>'}}"
    "</script></body></html>";

static void set_state(portal_state_t st, const char *msg)
{
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_state = st;
    strlcpy(s_message, msg, sizeof(s_message));
    xSemaphoreGive(s_lock);
}

/** Decode application/x-www-form-urlencoded in place. */
static void url_decode(char *s)
{
    char *o = s;
    for (; *s; s++) {
        if (*s == '+') {
            *o++ = ' ';
        } else if (*s == '%' && isxdigit((unsigned char)s[1]) && isxdigit((unsigned char)s[2])) {
            char hex[3] = {s[1], s[2], 0};
            *o++ = (char)strtol(hex, NULL, 16);
            s += 2;
        } else {
            *o++ = *s;
        }
    }
    *o = '\0';
}

static bool form_field(const char *body, const char *key, char *out, size_t len)
{
    char raw[200];
    if (httpd_query_key_value(body, key, raw, sizeof(raw)) != ESP_OK) return false;
    url_decode(raw);
    strlcpy(out, raw, len);
    return true;
}

static void connect_task(void *arg)
{
    set_state(ST_JOINING, "Joining Wi-Fi…");
    ui_set_led(LED_CONNECTING);
    if (!wifi_try_join(s_pending.ssid, s_pending.pass, 20000)) {
        set_state(ST_ERROR, "Couldn't join that Wi-Fi network. Check the name and password.");
        ui_set_led(LED_SETUP);
        ui_play(SOUND_ERROR);
        vTaskDelete(NULL);
        return;
    }
    settings_save(&s_pending);

    set_state(ST_REGISTERING, "Wi-Fi OK. Contacting server…");
    register_result_t reg;
    if (server_register(s_pending.server_url, &reg) != ESP_OK) {
        char msg[200];
        snprintf(msg, sizeof(msg), "Wi-Fi works, but the server said: %s", reg.error);
        set_state(ST_ERROR, msg);
        ui_set_led(LED_SETUP);
        ui_play(SOUND_ERROR);
        vTaskDelete(NULL);
        return;
    }
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_reg = reg;
    xSemaphoreGive(s_lock);
    set_state(ST_DONE, "");
    ui_set_led(reg.claimed ? LED_OK : LED_UNPAIRED);
    ui_play(SOUND_OK);
    vTaskDelete(NULL);
}

static esp_err_t send_json(httpd_req_t *req, cJSON *json)
{
    char *s = cJSON_PrintUnformatted(json);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_sendstr(req, s);
    cJSON_free(s);
    cJSON_Delete(json);
    return ESP_OK;
}

static esp_err_t h_root(httpd_req_t *req)
{
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, PAGE_HTML, sizeof(PAGE_HTML) - 1);
}

static esp_err_t h_info(httpd_req_t *req)
{
    settings_t cur;
    settings_load(&cur);
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "id", settings_device_id());
    cJSON_AddStringToObject(j, "ssid", cur.ssid);
    cJSON_AddStringToObject(j, "server", cur.server_url);
    return send_json(req, j);
}

static esp_err_t h_scan(httpd_req_t *req)
{
    static wifi_ap_record_t recs[20];
    int n = wifi_scan(recs, 20);
    cJSON *arr = cJSON_CreateArray();
    for (int i = 0; i < n; i++) {
        if (!recs[i].ssid[0]) continue;
        cJSON *o = cJSON_CreateObject();
        cJSON_AddStringToObject(o, "ssid", (const char *)recs[i].ssid);
        cJSON_AddNumberToObject(o, "rssi", recs[i].rssi);
        cJSON_AddItemToArray(arr, o);
    }
    return send_json(req, arr);
}

static esp_err_t h_save(httpd_req_t *req)
{
    char body[512];
    int len = req->content_len < sizeof(body) - 1 ? req->content_len : sizeof(body) - 1;
    int got = 0;
    while (got < len) {
        int r = httpd_req_recv(req, body + got, len - got);
        if (r <= 0) return ESP_FAIL;
        got += r;
    }
    body[got] = '\0';

    settings_t cur;
    settings_load(&cur);
    settings_t next = cur;
    form_field(body, "ssid", next.ssid, sizeof(next.ssid));
    char pass[65] = "";
    form_field(body, "pass", pass, sizeof(pass));
    // Blank password keeps the saved one when re-running setup on the same network.
    if (pass[0] || strcmp(next.ssid, cur.ssid) != 0) strlcpy(next.pass, pass, sizeof(next.pass));
    form_field(body, "server", next.server_url, sizeof(next.server_url));
    size_t sl = strlen(next.server_url);
    while (sl > 0 && next.server_url[sl - 1] == '/') next.server_url[--sl] = '\0';

    xSemaphoreTake(s_lock, portMAX_DELAY);
    bool busy = s_state == ST_JOINING || s_state == ST_REGISTERING;
    if (!busy) {
        s_pending = next;
        s_state = ST_JOINING;
        strlcpy(s_message, "Joining Wi-Fi…", sizeof(s_message));
    }
    xSemaphoreGive(s_lock);
    if (!busy) xTaskCreate(connect_task, "portal_conn", 6144, NULL, 5, NULL);
    httpd_resp_sendstr(req, "ok");
    return ESP_OK;
}

static esp_err_t h_status(httpd_req_t *req)
{
    static const char *names[] = {"idle", "joining", "registering", "done", "error"};
    cJSON *j = cJSON_CreateObject();
    xSemaphoreTake(s_lock, portMAX_DELAY);
    cJSON_AddStringToObject(j, "state", names[s_state]);
    cJSON_AddStringToObject(j, "message", s_message);
    if (s_state == ST_DONE) {
        cJSON_AddBoolToObject(j, "claimed", s_reg.claimed);
        cJSON_AddStringToObject(j, "code", s_reg.claim_code);
        cJSON_AddStringToObject(j, "url", s_reg.claim_url);
        cJSON_AddStringToObject(j, "owner", s_reg.owner);
    }
    xSemaphoreGive(s_lock);
    return send_json(req, j);
}

static void restart_task(void *arg)
{
    vTaskDelay(pdMS_TO_TICKS(1000));
    esp_restart();
}

static esp_err_t h_finish(httpd_req_t *req)
{
    httpd_resp_sendstr(req, "ok");
    xTaskCreate(restart_task, "restart", 2048, NULL, 5, NULL);
    return ESP_OK;
}

/** Anything else (phone OS captive-portal probes, typed URLs) goes to the setup page. */
static esp_err_t h_redirect(httpd_req_t *req, httpd_err_code_t err)
{
    httpd_resp_set_status(req, "302 Found");
    httpd_resp_set_hdr(req, "Location", "http://192.168.4.1/");
    httpd_resp_send(req, NULL, 0);
    return ESP_OK;
}

void portal_run(void)
{
    s_lock = xSemaphoreCreateMutex();
    ui_set_led(LED_SETUP);

    char ap_ssid[32];
    snprintf(ap_ssid, sizeof(ap_ssid), "SAR-Pager-%s", settings_device_id() + 8);
    wifi_start_setup_ap(ap_ssid);
    settings_device_secret();  // generate now that the radio (RNG entropy) is on
    dns_server_start();

    httpd_handle_t server;
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.stack_size = 6144;
    cfg.lru_purge_enable = true;
    ESP_ERROR_CHECK(httpd_start(&server, &cfg));
    const httpd_uri_t routes[] = {
        {.uri = "/", .method = HTTP_GET, .handler = h_root},
        {.uri = "/info", .method = HTTP_GET, .handler = h_info},
        {.uri = "/scan", .method = HTTP_GET, .handler = h_scan},
        {.uri = "/save", .method = HTTP_POST, .handler = h_save},
        {.uri = "/status", .method = HTTP_GET, .handler = h_status},
        {.uri = "/finish", .method = HTTP_POST, .handler = h_finish},
    };
    for (int i = 0; i < sizeof(routes) / sizeof(routes[0]); i++) {
        httpd_register_uri_handler(server, &routes[i]);
    }
    httpd_register_err_handler(server, HTTPD_404_NOT_FOUND, h_redirect);
    ESP_LOGI(TAG, "portal running; join \"%s\"", ap_ssid);

    // Don't sit in setup mode forever (e.g. after a power blip mid-setup): reboot into
    // normal mode, which will come back here if there are still no Wi-Fi settings.
    vTaskDelay(pdMS_TO_TICKS(PORTAL_TIMEOUT_MS));
    ESP_LOGW(TAG, "portal timed out");
    esp_restart();
}
