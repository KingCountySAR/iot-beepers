#pragma once

/**
 * Setup mode. Brings up an open "SAR-Pager-XXXX" access point with a captive portal
 * where the member picks their home Wi-Fi and the server URL. The device then joins,
 * registers with the server and shows the pairing code/link. Never returns: the device
 * reboots into normal mode when the member taps Finish (or after a timeout).
 */
void portal_run(void);
