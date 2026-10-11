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
    uint64_t active_sockets, policy_replacements, poll_turns;
} wc_network_stats;
// NET_RT_DUMP2 is read-only. Defaults are usable only when complete and
// unambiguous; index0 means absent/ambiguous for that family. Malformed input
// clears all usable fields. Prefixes include restricted public/VPN routes.
#define WC_HOST_ROUTE_MAX_BYTES 2097152u
#define WC_HOST_ROUTE_MAX_RECORDS 8192u
typedef struct {
    bool inventory_complete;
    uint32_t default_ipv4_ifindex, default_ipv6_ifindex;
    wc_network_prefix deny_prefixes[WC_NETWORK_MAX_PREFIXES];
    size_t deny_prefix_count;
    uint32_t record_count, ignored_generated_count;
} wc_host_route_snapshot;
bool wc_host_routes_parse(const uint8_t *bytes, size_t length, wc_host_route_snapshot *out);
bool wc_host_routes_read(wc_host_route_snapshot *out);

typedef struct wc_network_endpoint wc_network_endpoint;
// Addresses use family 4 or 6, bytes in network order and host-order port.
bool wc_network_parse_address(const char *text, uint16_t port, wc_network_address *out);
bool wc_network_policy_resolver(wc_network_policy *, const char *address);
bool wc_network_policy_grant(wc_network_policy *, const char *address, uint16_t port, uint8_t protocol, uint64_t expires_ns);
bool wc_network_policy_prefix(wc_network_policy *, const char *address, uint8_t prefix_length);
bool wc_network_destination_allowed(const wc_network_policy *, const wc_network_address *, uint8_t protocol, bool configured_dns, uint64_t now_ns);
bool wc_network_explicit_destination_allowed(const wc_network_policy *, const wc_network_address *, uint8_t protocol, bool configured_dns, uint64_t now_ns);
// Host-only primitive. A nonzero public interface must come from a complete route snapshot.
bool wc_network_bind_interface(int fd, uint8_t family, uint32_t ifindex);
bool wc_network_admit_routed_destination(const wc_network_policy *, const wc_host_route_snapshot *, const wc_network_address *, uint8_t protocol, bool configured_dns, uint64_t now_ns, uint32_t *ifindex);
int wc_network_classify_frame(const wc_network_policy *, const uint8_t *, size_t, uint64_t now_ns);
wc_network_endpoint *wc_network_create(const wc_network_policy *);
int wc_network_guest_fd(wc_network_endpoint *); // borrowed connected datagram socket
int wc_network_replace_policy(wc_network_endpoint *, const wc_network_policy *, uint64_t expected_revision);
void wc_network_read_stats(wc_network_endpoint *, wc_network_stats *);
// Caller excludes new API calls and concurrent FD/statistics borrows before
// destroy. An already admitted replace_policy is drained before memory is freed.
void wc_network_destroy(wc_network_endpoint *); // stops worker, closes only its sockets
#endif
