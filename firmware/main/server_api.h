#pragma once

#include <stdbool.h>
#include "esp_err.h"

typedef struct {
    bool claimed;
    char mqtt_url[160];
    char claim_code[8];
    char claim_url[200];
    char owner[64];
    /** Human-readable reason when the call fails. */
    char error[128];
} register_result_t;

/**
 * POST {server}/api/device/register. Creates the device on first contact, returns the
 * MQTT URL, and while unclaimed a pairing code + URL to show the member.
 */
esp_err_t server_register(const char *server_url, register_result_t *out);
