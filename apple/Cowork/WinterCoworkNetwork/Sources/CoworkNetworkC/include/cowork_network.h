#ifndef WINTER_COWORK_NETWORK_H
#define WINTER_COWORK_NETWORK_H
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>
#include <sys/socket.h>
#define WC_NETWORK_MAX_GRANTS 64
#define WC_NETWORK_MAX_PREFIXES 128
typedef struct { uint8_t family; uint8_t bytes[16]; uint16_t port; uint32_t scope_id; } wc_network_address;
typedef struct { wc_network_address address; uint8_t prefix_length; } wc_network_prefix;
typedef struct { wc_network_address destination; uint8_t protocol; uint64_t expires_monotonic_ns; } wc_network_grant;
typedef struct {
    uint64_t revision;
    bool public_internet;
    bool synthetic_no_outbound;
    bool system_dns_exception;
    wc_network_address resolver4, resolver6;
    wc_network_grant grants[WC_NETWORK_MAX_GRANTS]; size_t grant_count;
    wc_network_prefix host_networks[WC_NETWORK_MAX_PREFIXES]; size_t host_network_count;
} wc_network_policy;
typedef struct {
    uint64_t revision, packets_in, packets_out, denied, unsupported, dropped, outbound_attempts, inbound_peer_denied;
    uint64_t active_sockets, policy_replacements;
} wc_network_stats;
typedef struct wc_network_endpoint wc_network_endpoint;
// Addresses use family 4 or 6, bytes in network order and host-order port.
bool wc_network_parse_address(const char *text, uint16_t port, wc_network_address *out);
bool wc_network_policy_resolver(wc_network_policy *, const char *address);
bool wc_network_policy_grant(wc_network_policy *, const char *address, uint16_t port, uint8_t protocol, uint64_t expires_ns);
bool wc_network_policy_prefix(wc_network_policy *, const char *address, uint8_t prefix_length);
bool wc_network_destination_allowed(const wc_network_policy *, const wc_network_address *, uint8_t protocol, bool configured_dns, uint64_t now_ns);
int wc_network_classify_frame(const wc_network_policy *, const uint8_t *, size_t, uint64_t now_ns);
wc_network_endpoint *wc_network_create(const wc_network_policy *);
int wc_network_guest_fd(wc_network_endpoint *); // borrowed connected datagram socket
int wc_network_replace_policy(wc_network_endpoint *, const wc_network_policy *, uint64_t expected_revision);
void wc_network_read_stats(wc_network_endpoint *, wc_network_stats *);
void wc_network_destroy(wc_network_endpoint *); // stops worker, closes only its sockets
#endif
