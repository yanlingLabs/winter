#include "cowork_network.h"
#include <string.h>

static bool same_prefix(const wc_network_prefix *a, const wc_network_prefix *b) {
    return a->address.family == b->address.family && a->prefix_length == b->prefix_length &&
        a->address.scope_id == b->address.scope_id && !memcmp(a->address.bytes, b->address.bytes, 16);
}
static wc_network_prefix normalized(wc_network_prefix p) {
    for (size_t bit = p.prefix_length; bit < 128; bit++) p.address.bytes[bit / 8] &= ~(1u << (7 - bit % 8));
    p.address.port = 0; return p;
}
static bool contains(const wc_network_prefix *p, const wc_network_address *a) {
    if (p->address.family != a->family) return false;
    wc_network_prefix candidate = normalized((wc_network_prefix){.address = *a, .prefix_length = p->prefix_length});
    wc_network_prefix network = normalized(*p);
    return !memcmp(candidate.address.bytes, network.address.bytes, 16);
}
static bool identity_prefix(const wc_network_policy *hosts, size_t at, uint32_t index, uint8_t family) {
    const wc_network_prefix *p = &hosts->host_networks[at];
    if (p->address.scope_id != index || p->address.family != family) return false;
    // Exact host addresses remain destination fences, but temporary addresses
    // inside an unchanged connected subnet are not a new network identity.
    if (p->prefix_length == (family == 4 ? 32 : 128))
        for (size_t i = 0; i < hosts->host_network_count; i++) {
            const wc_network_prefix *subnet = &hosts->host_networks[i];
            if (subnet->address.scope_id == index && subnet->prefix_length < p->prefix_length && contains(subnet, &p->address)) return false;
        }
    return true;
}
static bool identity_subset(const wc_network_policy *a, const wc_network_policy *b, uint32_t index, uint8_t family) {
    for (size_t i = 0; i < a->host_network_count; i++) if (identity_prefix(a, i, index, family)) {
        wc_network_prefix p = normalized(a->host_networks[i]); bool found = false;
        for (size_t j = 0; j < b->host_network_count; j++) if (identity_prefix(b, j, index, family)) {
            wc_network_prefix other = normalized(b->host_networks[j]);
            if (same_prefix(&p, &other)) { found = true; break; }
        }
        if (!found) return false;
    }
    return true;
}
uint64_t wc_network_inventory_identity(const wc_network_inventory *cache, uint32_t index, uint8_t family) {
    for (size_t i = 0; i < cache->identity_count; i++)
        if (cache->identities[i].ifindex == index && cache->identities[i].family == family) return cache->identities[i].generation;
    return 0;
}
static void update_identities(wc_network_inventory *cache, const wc_network_policy *hosts) {
    wc_network_interface_identity next[WC_NETWORK_MAX_PREFIXES]; size_t count = 0;
    for (size_t i = 0; i < hosts->host_network_count; i++) {
        uint32_t index = hosts->host_networks[i].address.scope_id; uint8_t family = hosts->host_networks[i].address.family;
        if (!index) continue; // Unscoped product fences cannot identify a host interface.
        bool found = false;
        for (size_t j = 0; j < count; j++) if (next[j].ifindex == index && next[j].family == family) { found = true; break; }
        if (found) continue;
        uint64_t generation = wc_network_inventory_identity(cache, index, family);
        if (cache->unsafe_hosts || !generation || !identity_subset(&cache->hosts, hosts, index, family) || !identity_subset(hosts, &cache->hosts, index, family)) generation = ++cache->identity_generation;
        next[count++] = (wc_network_interface_identity){.ifindex = index, .family = family, .generation = generation};
    }
    memcpy(cache->identities, next, count * sizeof(*next)); cache->identity_count = count;
}
static bool append(wc_network_policy *policy, const wc_network_prefix *prefix);
bool wc_network_inventory_due(const wc_network_inventory *cache, uint64_t now) {
    return !cache->attempted || now < cache->refreshed_ns || now - cache->refreshed_ns >= WC_NETWORK_INVENTORY_TTL_NS;
}
void wc_network_inventory_update(wc_network_inventory *cache, const wc_host_route_snapshot *routes, const wc_network_policy *hosts, uint64_t now) {
    cache->attempted = true; cache->refreshed_ns = now;
    bool hosts_valid = hosts && hosts->public_internet && hosts->host_network_count <= WC_NETWORK_MAX_PREFIXES;
    bool routes_valid = routes && routes->inventory_complete && routes->deny_prefix_count <= WC_NETWORK_MAX_PREFIXES;
    if (hosts_valid && routes_valid) {
        update_identities(cache, hosts);
        cache->hosts = *hosts; cache->routes = *routes; cache->has_good = true;
        memset(&cache->grace_hosts, 0, sizeof(cache->grace_hosts));
        cache->stale = cache->unsafe_hosts = false; cache->stale_since_ns = 0;
    } else {
        if (!cache->stale) cache->stale_since_ns = now;
        cache->stale = true;
        // Unknown host inventories are sticky fail-closed until a combined good
        // refresh. Known churn is scoped: preserve all previous denial fences
        // during route grace, add current ones, and advance only changed paths.
        if (!hosts_valid || !cache->has_good) cache->unsafe_hosts = true;
        else {
            for (size_t i = 0; i < cache->hosts.host_network_count; i++)
                if (!append(&cache->grace_hosts, &cache->hosts.host_networks[i])) cache->unsafe_hosts = true;
            update_identities(cache, hosts); cache->hosts = *hosts;
        }
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
    if (cache->stale) for (size_t i = 0; i < cache->grace_hosts.host_network_count; i++) if (!append(out, &cache->grace_hosts.host_networks[i])) return;
    for (size_t i = 0; i < cache->routes.deny_prefix_count; i++) if (!append(out, &cache->routes.deny_prefixes[i])) return;
}
bool wc_network_inventory_admit(const wc_network_inventory *cache, const wc_network_policy *effective, const wc_network_address *peer, uint8_t protocol, bool dns, uint64_t now, bool existing, uint32_t *ifindex) {
    if (!ifindex) return false;
    *ifindex = 0;
    // Current grants/DNS policy never inherit stale snapshot authority.
    if (wc_network_explicit_destination_allowed(effective, peer, protocol, dns, now)) return true;
    if (!cache->has_good || cache->unsafe_hosts) return false;
    if (cache->stale && (!existing || now < cache->stale_since_ns || now - cache->stale_since_ns >= WC_NETWORK_ROUTE_GRACE_NS)) return false;
    return wc_network_admit_routed_destination(effective, &cache->routes, peer, protocol, dns, now, ifindex) && wc_network_inventory_identity(cache, *ifindex, peer->family) != 0;
}

bool wc_network_inventory_matches(const wc_network_inventory *cache, const wc_network_policy *effective, const wc_network_address *peer, uint8_t protocol, bool dns, uint64_t now, uint32_t bound, uint64_t generation) {
    if (bound && (!generation || generation != wc_network_inventory_identity(cache, bound, peer->family))) return false;
    uint32_t current = 0;
    return wc_network_inventory_admit(cache, effective, peer, protocol, dns, now, bound != 0, &current) && current == bound;
}
