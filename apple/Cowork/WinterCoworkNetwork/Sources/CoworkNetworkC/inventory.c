#include "cowork_network.h"
#include <string.h>

static bool same_prefix(const wc_network_prefix *a, const wc_network_prefix *b) {
    return a->address.family == b->address.family && a->prefix_length == b->prefix_length &&
        a->address.scope_id == b->address.scope_id && !memcmp(a->address.bytes, b->address.bytes, 16);
}
static bool same_hosts(const wc_network_policy *a, const wc_network_policy *b) {
    if (a->host_network_count != b->host_network_count) return false;
    // getifaddrs ordering is not identity. Compare an unordered bounded set.
    bool matched[WC_NETWORK_MAX_PREFIXES] = {false};
    for (size_t i = 0; i < a->host_network_count; i++) {
        bool found = false;
        for (size_t j = 0; j < b->host_network_count; j++) if (!matched[j] && same_prefix(&a->host_networks[i], &b->host_networks[j])) { matched[j] = found = true; break; }
        if (!found) return false;
    }
    return true;
}
bool wc_network_inventory_due(const wc_network_inventory *cache, uint64_t now) {
    return !cache->attempted || now < cache->refreshed_ns || now - cache->refreshed_ns >= WC_NETWORK_INVENTORY_TTL_NS;
}
void wc_network_inventory_update(wc_network_inventory *cache, const wc_host_route_snapshot *routes, const wc_network_policy *hosts, uint64_t now) {
    cache->attempted = true; cache->refreshed_ns = now;
    bool hosts_valid = hosts && hosts->public_internet && hosts->host_network_count <= WC_NETWORK_MAX_PREFIXES;
    bool routes_valid = routes && routes->inventory_complete && routes->deny_prefix_count <= WC_NETWORK_MAX_PREFIXES;
    if (hosts_valid && routes_valid) {
        if (!cache->has_good || !same_hosts(&cache->hosts, hosts)) cache->host_generation++;
        cache->hosts = *hosts; cache->routes = *routes; cache->has_good = true;
        cache->stale = cache->unsafe_hosts = false; cache->stale_since_ns = 0;
    } else {
        if (!cache->stale) cache->stale_since_ns = now;
        cache->stale = true;
        // No route-only grace through a host/LAN identity change or an unknown
        // host identity. Sticky until a complete combined snapshot succeeds.
        if (!hosts_valid || !cache->has_good || !same_hosts(&cache->hosts, hosts)) cache->unsafe_hosts = true;
    }
}
static bool append(wc_network_policy *policy, const wc_network_prefix *prefix) {
    for (size_t i = 0; i < policy->host_network_count; i++) if (same_prefix(&policy->host_networks[i], prefix)) return true;
    if (policy->host_network_count == WC_NETWORK_MAX_PREFIXES) { policy->public_internet = false; return false; }
    policy->host_networks[policy->host_network_count++] = *prefix; return true;
}
void wc_network_inventory_effective(const wc_network_inventory *cache, const wc_network_policy *policy, wc_network_policy *out) {
    *out = *policy;
    if (!cache->has_good || cache->unsafe_hosts) return;
    for (size_t i = 0; i < cache->hosts.host_network_count; i++) if (!append(out, &cache->hosts.host_networks[i])) return;
    for (size_t i = 0; i < cache->routes.deny_prefix_count; i++) if (!append(out, &cache->routes.deny_prefixes[i])) return;
}
bool wc_network_inventory_admit(const wc_network_inventory *cache, const wc_network_policy *effective, const wc_network_address *peer, uint8_t protocol, bool dns, uint64_t now, bool existing, uint32_t *ifindex) {
    if (!ifindex) return false;
    *ifindex = 0;
    // Current grants/DNS policy never inherit stale snapshot authority.
    if (wc_network_explicit_destination_allowed(effective, peer, protocol, dns, now)) return true;
    if (!cache->has_good || cache->unsafe_hosts) return false;
    if (cache->stale && (!existing || now < cache->stale_since_ns || now - cache->stale_since_ns >= WC_NETWORK_ROUTE_GRACE_NS)) return false;
    return wc_network_admit_routed_destination(effective, &cache->routes, peer, protocol, dns, now, ifindex);
}

bool wc_network_inventory_matches(const wc_network_inventory *cache, const wc_network_policy *effective, const wc_network_address *peer, uint8_t protocol, bool dns, uint64_t now, uint32_t bound, uint64_t generation) {
    if (bound && generation != cache->host_generation) return false;
    uint32_t current = 0;
    return wc_network_inventory_admit(cache, effective, peer, protocol, dns, now, bound != 0, &current) && current == bound;
}
