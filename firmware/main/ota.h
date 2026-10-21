#pragma once

#include <stdbool.h>

/**
 * Call early in boot. If this image is fresh from an OTA and not yet confirmed, starts a
 * timer that rolls back to the previous image unless ota_confirm() is called in time.
 */
void ota_boot_check(void);

/** The new image reached the server: keep it. Safe to call on every connect. */
void ota_confirm(void);

/** If a previous OTA was rolled back, the version that failed (once per failure), else NULL. */
const char *ota_take_rollback_report(void);

/** Download and install in the background, then reboot. Returns false if one is running. */
bool ota_start(const char *url, const char *expected_version);
bool ota_in_progress(void);
