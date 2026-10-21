#include "dns_server.h"

#include <string.h>
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"

static const char *TAG = "dns";

// Default address of the ESP-IDF soft AP.
static const uint8_t AP_ADDR[4] = {192, 168, 4, 1};

static void dns_task(void *arg)
{
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    struct sockaddr_in addr = {
        .sin_family = AF_INET,
        .sin_port = htons(53),
        .sin_addr.s_addr = htonl(INADDR_ANY),
    };
    if (sock < 0 || bind(sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        ESP_LOGE(TAG, "bind failed");
        vTaskDelete(NULL);
        return;
    }

    uint8_t buf[512];
    for (;;) {
        struct sockaddr_in from;
        socklen_t from_len = sizeof(from);
        int n = recvfrom(sock, buf, sizeof(buf) - 16, 0, (struct sockaddr *)&from, &from_len);
        if (n < 12) continue;

        // Only plain queries with one question.
        uint16_t qdcount = (buf[4] << 8) | buf[5];
        if ((buf[2] & 0x80) || qdcount != 1) continue;

        // Walk the QNAME to find the end of the question section.
        int p = 12;
        while (p < n && buf[p] != 0) p += buf[p] + 1;
        p += 5;  // zero byte + QTYPE + QCLASS
        if (p > n) continue;
        uint16_t qtype = (buf[p - 4] << 8) | buf[p - 3];

        buf[2] = 0x84;  // response, authoritative
        buf[3] = 0x00;  // no error
        buf[6] = 0;
        buf[7] = qtype == 1 ? 1 : 0;  // answer only A queries; others get an empty reply
        buf[8] = buf[9] = buf[10] = buf[11] = 0;
        int len = p;
        if (qtype == 1) {
            const uint8_t answer[] = {
                0xc0, 0x0c,              // pointer to the name in the question
                0x00, 0x01, 0x00, 0x01,  // type A, class IN
                0x00, 0x00, 0x00, 0x3c,  // TTL 60s
                0x00, 0x04,              // 4 bytes of address
                AP_ADDR[0], AP_ADDR[1], AP_ADDR[2], AP_ADDR[3],
            };
            memcpy(&buf[len], answer, sizeof(answer));
            len += sizeof(answer);
        }
        sendto(sock, buf, len, 0, (struct sockaddr *)&from, from_len);
    }
}

void dns_server_start(void)
{
    xTaskCreate(dns_task, "dns", 3072, NULL, 5, NULL);
}
