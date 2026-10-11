#include "cowork_network.h"
#include <net/route.h>
#include <net/if_dl.h>
#include <netinet/in.h>
#include <sys/sysctl.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>

// Independent parser built from SDK definitions. Darwin routing sockaddr
// records align to FOUR bytes (including zero-length mask records), not host
// pointer size. Apple network_cmds netstat/route.c documents that ABI; no
// Apple/APSL implementation is copied here.
typedef struct { const uint8_t *bytes; size_t length; } route_address;
static size_t aligned4(size_t length) { return length ? (length + 3u) & ~(size_t)3u : 4u; }
static bool failure(wc_host_route_snapshot *out) { memset(out, 0, sizeof(*out)); return false; }
static bool address_valid(route_address value, bool mask) {
    // A radix mask is not a typed address: sa_family may itself contain mask
    // bits (including0xff). Its address-field offset comes from DST's family.
    if (mask) return value.length == 0 || value.length >= 2;
    if (value.length < 2) return false;
    unsigned family = value.bytes[1];
    if (family == AF_INET) return value.length >= sizeof(struct sockaddr_in);
    if (family == AF_INET6) return value.length >= sizeof(struct sockaddr_in6);
    if (family == AF_LINK) {
        size_t data = offsetof(struct sockaddr_dl, sdl_data);
        return value.length >= data && data + value.bytes[5] + value.bytes[6] + value.bytes[7] <= value.length;
    }
    return family == AF_UNSPEC;
}
static bool decode_destination(route_address sa, wc_network_address *out) {
    memset(out, 0, sizeof(*out));
    if (sa.length < 2) return false;
    if (sa.bytes[1] == AF_INET && sa.length >= sizeof(struct sockaddr_in)) {
        out->family = 4; memcpy(out->bytes, sa.bytes + offsetof(struct sockaddr_in, sin_addr), 4); return true;
    }
    if (sa.bytes[1] == AF_INET6 && sa.length >= sizeof(struct sockaddr_in6)) {
        out->family = 6; memcpy(out->bytes, sa.bytes + offsetof(struct sockaddr_in6, sin6_addr), 16);
        // IPv6 route address scope is part of the routing key, but deny
        // prefixes intentionally cover all scopes of that destination prefix.
        return true;
    }
    return false;
}
static bool decode_mask(route_address sa, uint8_t family, uint8_t *bits) {
    uint8_t mask[16] = {0}; size_t width = family == 4 ? 4 : 16;
    size_t offset = family == 4 ? offsetof(struct sockaddr_in, sin_addr) : offsetof(struct sockaddr_in6, sin6_addr);
    if (!address_valid(sa, true)) return false;
    if (sa.length > offset) { size_t count = sa.length - offset; if (count > width) count = width; memcpy(mask, sa.bytes + offset, count); }
    bool zero = false; *bits = 0;
    for (size_t i = 0; i < width; i++) for (int bit = 7; bit >= 0; bit--) {
        bool set = (mask[i] & (1u << bit)) != 0;
        if (set && zero) return false;
        if (set) (*bits)++; else zero = true;
    }
    return true;
}
static void normalize(wc_network_prefix *p) {
    static const uint8_t mapped[12] = {0,0,0,0,0,0,0,0,0,0,255,255};
    // Final policy canonicalizes mapped addresses to IPv4. Preserve route
    // denials across the same representation rather than leaving a family alias.
    if (p->address.family == 6 && p->prefix_length >= 96 && !memcmp(p->address.bytes, mapped, 12)) {
        memmove(p->address.bytes, p->address.bytes + 12, 4); memset(p->address.bytes + 4, 0, 12);
        p->address.family = 4; p->prefix_length -= 96;
    }
    size_t width = p->address.family == 4 ? 4 : 16;
    for (size_t i = 0; i < width; i++) {
        unsigned consumed = (unsigned)i * 8u;
        if (p->prefix_length <= consumed) p->address.bytes[i] = 0;
        else if (p->prefix_length < consumed + 8u) p->address.bytes[i] &= (uint8_t)(0xffu << (8u - (p->prefix_length - consumed)));
    }
}
static bool add_prefix(wc_host_route_snapshot *out, wc_network_prefix prefix) {
    normalize(&prefix);
    for (size_t i = 0; i < out->deny_prefix_count; i++) {
        wc_network_prefix *previous = &out->deny_prefixes[i];
        if (previous->address.family == prefix.address.family && previous->prefix_length == prefix.prefix_length &&
            !memcmp(previous->address.bytes, prefix.address.bytes, prefix.address.family == 4 ? 4 : 16)) return true;
    }
    if (out->deny_prefix_count >= WC_NETWORK_MAX_PREFIXES) return false;
    out->deny_prefixes[out->deny_prefix_count++] = prefix; return true;
}

typedef struct { uint32_t index; bool ambiguous; } default_interface;
static void candidate(default_interface *value, uint32_t index) {
    if (value->index && value->index != index) value->ambiguous = true;
    if (!value->index) value->index = index;
}
static uint32_t usable(default_interface value) { return value.ambiguous ? 0 : value.index; }

bool wc_host_routes_parse(const uint8_t *bytes, size_t length, wc_host_route_snapshot *out) {
    if (!out) return false;
    memset(out, 0, sizeof(*out));
    if ((!bytes && length) || length > WC_HOST_ROUTE_MAX_BYTES) return false;
    const unsigned known_flags = RTF_UP | RTF_GATEWAY | RTF_HOST | RTF_REJECT | RTF_DYNAMIC | RTF_MODIFIED | RTF_DONE |
        RTF_DELCLONE | RTF_CLONING | RTF_XRESOLVE | RTF_LLINFO | RTF_STATIC | RTF_BLACKHOLE | RTF_NOIFREF |
        RTF_PROTO1 | RTF_PROTO2 | RTF_PROTO3 | RTF_PRCLONING | RTF_WASCLONED | RTF_PINNED | RTF_LOCAL |
        RTF_BROADCAST | RTF_MULTICAST | RTF_IFSCOPE | RTF_CONDEMNED | RTF_IFREF | RTF_PROXY | RTF_ROUTER | RTF_DEAD | RTF_GLOBAL;
    default_interface defaults[2] = {{0}}, halves[2][2] = {{{0}}};
    size_t cursor = 0;
    while (cursor < length) {
        if (out->record_count >= WC_HOST_ROUTE_MAX_RECORDS || length - cursor < sizeof(struct rt_msghdr2)) return failure(out);
        struct rt_msghdr2 header; memcpy(&header, bytes + cursor, sizeof(header));
        size_t record_length = header.rtm_msglen;
        if (record_length < sizeof(header) || record_length > length - cursor || (record_length & 3u) ||
            header.rtm_version != RTM_VERSION || header.rtm_type != RTM_GET2 || header.rtm_reserved != 0 ||
            ((unsigned)header.rtm_flags & ~known_flags) ||
            ((unsigned)header.rtm_addrs & ~((1u << RTAX_MAX) - 1u)) || !(header.rtm_addrs & RTA_DST)) return failure(out);
        route_address addresses[RTAX_MAX] = {{0}};
        size_t offset = sizeof(header);
        for (int i = 0; i < RTAX_MAX; i++) if ((unsigned)header.rtm_addrs & (1u << i)) {
            if (record_length - offset < 2) return failure(out);
            size_t declared = bytes[cursor + offset]; size_t stride = aligned4(declared);
            if (stride > record_length - offset) return failure(out);
            addresses[i] = (route_address){bytes + cursor + offset, declared};
            if (!address_valid(addresses[i], i == RTAX_NETMASK || i == RTAX_GENMASK)) return failure(out);
            offset += stride;
        }
        if (offset != record_length) return failure(out);
        wc_network_prefix prefix = {0};
        if (!decode_destination(addresses[RTAX_DST], &prefix.address)) return failure(out);
        uint8_t mask_bits = 0;
        if (header.rtm_addrs & RTA_NETMASK) {
            if (!decode_mask(addresses[RTAX_NETMASK], prefix.address.family, &mask_bits)) return failure(out);
        } else if (!(header.rtm_flags & RTF_HOST)) {
            uint8_t sum = 0; for (size_t i = 0; i < (prefix.address.family == 4 ? 4u : 16u); i++) sum |= prefix.address.bytes[i];
            if (sum) return failure(out); // Unknown non-host route without a mask.
        }
        prefix.prefix_length = header.rtm_flags & RTF_HOST ? (prefix.address.family == 4 ? 32 : 128) : mask_bits;
        out->record_count++;
        bool restricted = (header.rtm_flags & (RTF_REJECT | RTF_BLACKHOLE | RTF_LOCAL)) != 0;
        bool generated = (header.rtm_flags & RTF_HOST) && (header.rtm_flags & (RTF_WASCLONED | RTF_LLINFO)) &&
            !(header.rtm_flags & RTF_STATIC) && !restricted;
        if (generated) out->ignored_generated_count++;
        else if (prefix.prefix_length == 0 && !restricted) {
            if ((header.rtm_flags & RTF_UP) && !(header.rtm_flags & (RTF_IFSCOPE | RTF_CONDEMNED | RTF_DEAD)) && header.rtm_index)
                candidate(&defaults[prefix.address.family == 4 ? 0 : 1], header.rtm_index);
        } else if (prefix.prefix_length == 1 && !restricted && (header.rtm_flags & RTF_UP) &&
                   !(header.rtm_flags & (RTF_IFSCOPE | RTF_CONDEMNED | RTF_DEAD)) && header.rtm_index) {
            // Full-tunnel VPNs commonly install two /1 routes instead of /0.
            // Defer these fences until both halves identify the same interface.
            candidate(&halves[prefix.address.family == 4 ? 0 : 1][prefix.address.bytes[0] >> 7], header.rtm_index);
        } else if (!add_prefix(out, prefix)) return failure(out);
        cursor += record_length;
    }
    for (int family = 0; family < 2; family++) {
        uint32_t low = usable(halves[family][0]), high = usable(halves[family][1]);
        uint32_t index = low && low == high ? low : usable(defaults[family]);
        if (family == 0) out->default_ipv4_ifindex = index; else out->default_ipv6_ifindex = index;
        if (!(low && low == high)) for (int half = 0; half < 2; half++) if (halves[family][half].index) {
            wc_network_prefix fence = {.address.family = family == 0 ? 4 : 6, .prefix_length = 1};
            fence.address.bytes[0] = half ? 128 : 0;
            if (!add_prefix(out, fence)) return failure(out);
        }
    }
    out->inventory_complete = true; return true;
}

// A local route snapshot cannot identify this host's public address behind
// upstream NAT or proxy hairpinning. Known external-address/egress policy is
// still required; default-interface pinning does not solve that residual.
bool wc_host_routes_read(wc_host_route_snapshot *out) {
    if (!out) return false;
    memset(out, 0, sizeof(*out));
    const int mib[] = {CTL_NET, PF_ROUTE, 0, AF_UNSPEC, NET_RT_DUMP2, 0};
    for (int attempt = 0; attempt < 3; attempt++) {
        size_t needed = 0;
        if (sysctl((int *)mib, 6, NULL, &needed, NULL, 0) != 0 || needed > WC_HOST_ROUTE_MAX_BYTES) return failure(out);
        if (needed == 0) return wc_host_routes_parse(NULL, 0, out);
        size_t capacity = needed + needed / 2;
        if (capacity > WC_HOST_ROUTE_MAX_BYTES) capacity = WC_HOST_ROUTE_MAX_BYTES;
        uint8_t *bytes = malloc(capacity); if (!bytes) return failure(out);
        size_t actual = capacity; int result = sysctl((int *)mib, 6, bytes, &actual, NULL, 0); int error = errno;
        if (result == 0 && actual <= capacity) { bool parsed = wc_host_routes_parse(bytes, actual, out); free(bytes); return parsed; }
        free(bytes);
        if (error != ENOMEM) return failure(out);
    }
    return failure(out);
}
