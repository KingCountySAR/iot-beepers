idf_component_register(
    SRCS
        "app_main.c"
        "settings.c"
        "ui.c"
        "wifi.c"
        "portal.c"
        "dns_server.c"
        "server_api.c"
        "link.c"
        "ota.c"
    INCLUDE_DIRS "."
    PRIV_REQUIRES
        nvs_flash esp_wifi esp_netif esp_event esp_http_client esp_http_server
        esp_https_ota esp_driver_gpio esp_driver_ledc app_update mqtt json
        mbedtls esp_timer esp_partition
)
