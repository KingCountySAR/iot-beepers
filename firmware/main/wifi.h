#pragma once

#include <stdbool.h>
#include <stddef.h>
#include "esp_wifi_types.h"

typedef void (*wifi_state_cb_t)(bool connected);

void wifi_init(wifi_state_cb_t on_change);

/** Normal operation: join the saved network and keep reconnecting forever. */
void wifi_start_sta(const char *ssid, const char *pass);

/** Setup mode: open access point (plus station, for testing credentials). */
void wifi_start_setup_ap(const char *ap_ssid);

/** Setup mode: try credentials, blocking until we get an IP or give up. */
bool wifi_try_join(const char *ssid, const char *pass, int timeout_ms);

/** Blocking scan; returns number of records written. */
int wifi_scan(wifi_ap_record_t *out, int max);

bool wifi_connected(void);
int wifi_rssi(void);
void wifi_ip(char *out, size_t len);
