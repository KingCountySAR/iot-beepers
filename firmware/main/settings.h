#pragma once

#include <stdbool.h>
#include "esp_err.h"

typedef struct {
    char ssid[33];
    char pass[65];
    char server_url[128];
} settings_t;

esp_err_t settings_init(void);

/** Load saved settings. Returns false if Wi-Fi has never been configured. */
bool settings_load(settings_t *out);
esp_err_t settings_save(const settings_t *s);

/** Forget Wi-Fi and server settings. The device identity is kept. */
esp_err_t settings_clear(void);

/** 12 lowercase hex chars from the Wi-Fi MAC. */
const char *settings_device_id(void);

/**
 * Random 64-hex-char secret, generated on first use and kept across factory resets
 * (only a full flash erase loses it). Call after Wi-Fi has started so the RNG is seeded
 * from RF noise.
 */
const char *settings_device_secret(void);

/** Persist small strings outside the user settings (e.g. last reported rollback). */
bool settings_get_str(const char *key, char *out, size_t len);
esp_err_t settings_set_str(const char *key, const char *value);
