#pragma once

#include <stdbool.h>
#include <stdint.h>

/**
 * MQTT connection to the server. Protocol: docs/protocol.md (server/src/protocol.ts).
 * Callbacks run on the MQTT task; keep them short.
 */
typedef struct {
    void (*on_connected)(void);
    void (*on_disconnected)(void);
    void (*on_config)(bool claimed);
    void (*on_page)(int32_t id, bool alarm);
    void (*on_command)(const char *cmd);
    void (*on_ota)(const char *url, const char *version);
    /** Broker rejected our credentials (e.g. an admin reset the device): re-register. */
    void (*on_refused)(void);
} link_callbacks_t;

void link_start(const char *mqtt_url, const link_callbacks_t *cb);
bool link_connected(void);

/** Publish dev/{id}/status. `hello` is sent on every (re)connect; heartbeats are automatic. */
void link_send_status(bool hello);
void link_send_ack(int32_t page_id, bool acked);
void link_send_event(const char *type, const char *detail);
