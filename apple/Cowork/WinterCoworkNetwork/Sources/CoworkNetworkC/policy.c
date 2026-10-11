#include "cowork_network.h"
#include <arpa/inet.h>
#include <string.h>
#include <stdlib.h>
#include <net/if.h>

bool wc_network_parse_address(const char *text, uint16_t port, wc_network_address *out) {
    if (!text || !out) return false;
    memset(out, 0, sizeof(*out)); out->port = port;
    if (inet_pton(AF_INET, text, out->bytes) == 1) { out->family = 4; return true; }
    char copy[INET6_ADDRSTRLEN+IF_NAMESIZE+2];
    if(strlen(text)>=sizeof(copy)) return false; strcpy(copy,text);
    char *zone=strchr(copy,'%');
    if(zone) { *zone++=0; out->scope_id=if_nametoindex(zone); if(!out->scope_id) { char *end=NULL; unsigned long n=strtoul(zone,&end,10); if(!end || *end || n>UINT32_MAX || !n) return false; out->scope_id=(uint32_t)n; } }
    if (inet_pton(AF_INET6, copy, out->bytes) == 1) { out->family = 6; return true; }
    return false;
}
bool wc_network_policy_resolver(wc_network_policy *p,const char *text) {
    wc_network_address a; if(!p || !wc_network_parse_address(text,53,&a)) return false;
    if(a.family==4) p->resolver4=a; else p->resolver6=a; return true;
}
bool wc_network_policy_grant(wc_network_policy *p,const char *text,uint16_t port,uint8_t protocol,uint64_t expires) {
    if(!p || p->grant_count>=WC_NETWORK_MAX_GRANTS || (protocol!=6 && protocol!=17) || !port) return false;
    wc_network_address a; if(!wc_network_parse_address(text,port,&a)) return false;
    p->grants[p->grant_count++]=(wc_network_grant){.destination=a,.protocol=protocol,.expires_monotonic_ns=expires}; return true;
}
bool wc_network_policy_prefix(wc_network_policy *p,const char *text,uint8_t bits) {
    wc_network_address a; if(!p || p->host_network_count>=WC_NETWORK_MAX_PREFIXES || !wc_network_parse_address(text,0,&a) || bits>(a.family==4?32:128)) return false;
    p->host_networks[p->host_network_count++]=(wc_network_prefix){.address=a,.prefix_length=bits}; return true;
}
static wc_network_address canonical(wc_network_address address) {
    static const uint8_t mapped[12] = {0,0,0,0,0,0,0,0,0,0,255,255};
    if (address.family == 6 && memcmp(address.bytes, mapped, 12) == 0) {
        memmove(address.bytes, address.bytes + 12, 4); memset(address.bytes + 4, 0, 12); address.family = 4;
    }
    return address;
}
static bool same_ip(wc_network_address a, wc_network_address b) {
    a = canonical(a); b = canonical(b);
    return a.family == b.family && a.scope_id==b.scope_id && memcmp(a.bytes, b.bytes, a.family == 4 ? 4 : 16) == 0;
}
static bool prefix(const wc_network_address *address, const wc_network_prefix *network) {
    if (address->family != network->address.family || network->prefix_length > (address->family == 4 ? 32 : 128)) return false;
    unsigned whole = network->prefix_length / 8, rest = network->prefix_length % 8;
    if (whole && memcmp(address->bytes, network->address.bytes, whole)) return false;
    return !rest || ((address->bytes[whole] ^ network->address.bytes[whole]) & (0xff << (8 - rest))) == 0;
}
static bool public_unicast(wc_network_address address) {
    address = canonical(address);
    if (address.family == 4) {
        const uint8_t *b = address.bytes;
        return !(b[0] == 0 || b[0] == 10 || b[0] == 127 || b[0] >= 224 ||
            (b[0] == 100 && b[1] >= 64 && b[1] <= 127) || (b[0] == 169 && b[1] == 254) ||
            (b[0] == 172 && b[1] >= 16 && b[1] <= 31) || (b[0] == 192 && b[1] == 168) ||
            (b[0] == 192 && b[1] == 0 && (b[2] == 0 || b[2] == 2)) ||
            (b[0] == 192 && b[1] == 88 && b[2] == 99) || (b[0] == 198 && (b[1] == 18 || b[1] == 19)) ||
            (b[0] == 198 && b[1] == 51 && b[2] == 100) || (b[0] == 203 && b[1] == 0 && b[2] == 113));
    }
    if (address.family != 6 || (address.bytes[0] & 0xe0) != 0x20) return false;
    // Documentation and Teredo transition addresses are not ordinary public peers.
    return !(address.bytes[0] == 0x20 && address.bytes[1] == 0x01 &&
        ((address.bytes[2] == 0x0d && address.bytes[3] == 0xb8) ||
         (address.bytes[2] == 0 && address.bytes[3] == 0)));
}
static bool hard_invalid(wc_network_address address) {
    address = canonical(address);
    if (address.family == 4) return address.bytes[0] == 0 || address.bytes[0] >= 224;
    if (address.family != 6 || address.bytes[0] == 255) return true;
    uint8_t sum = 0; for (int i = 0; i < 16; i++) sum |= address.bytes[i]; return sum == 0;
}
bool wc_network_destination_allowed(const wc_network_policy *policy, const wc_network_address *destination, uint8_t protocol, bool configured_dns, uint64_t now_ns) {
    if (!policy || !destination || (protocol != 6 && protocol != 17) || destination->port == 0 || hard_invalid(*destination)) return false;
    const wc_network_address *resolver = destination->family == 4 ? &policy->resolver4 : &policy->resolver6;
    if (configured_dns && policy->public_internet && policy->system_dns_exception &&
        resolver->family && destination->port == 53 && resolver->port == 53 && same_ip(*destination, *resolver)) return true;
    for (size_t i = 0; i < policy->grant_count && i < WC_NETWORK_MAX_GRANTS; i++) {
        const wc_network_grant *grant = &policy->grants[i];
        if (grant->protocol == protocol && grant->destination.port == destination->port && same_ip(grant->destination, *destination) &&
            (!grant->expires_monotonic_ns || now_ns < grant->expires_monotonic_ns)) return true;
    }
    wc_network_address normalized = canonical(*destination);
    if (!policy->public_internet || !public_unicast(normalized)) return false;
    for (size_t i = 0; i < policy->host_network_count && i < WC_NETWORK_MAX_PREFIXES; i++) {
        if (prefix(&normalized, &policy->host_networks[i])) return false;
    }
    return true;
}
static uint16_t u16(const uint8_t *bytes) { return ((uint16_t)bytes[0] << 8) | bytes[1]; }
static bool virtual_dns(wc_network_address address) {
    static const uint8_t dns4[4] = {10,0,2,3}, dns6[16] = {0xfd,0,0,0x77,0,0,0,0,0,0,0,0,0,0,0,3};
    return address.port == 53 && ((address.family == 4 && !memcmp(address.bytes,dns4,4)) || (address.family == 6 && !memcmp(address.bytes,dns6,16)));
}
static bool dns_query(const uint8_t *bytes, size_t length, uint8_t protocol) {
    if (protocol == 6) return true; // Framed TCP DNS uses a fixed configured DNS service only.
    if (length < 12 || length > 4096 || bytes[2] & 0x80 || (bytes[2] & 0x78) || u16(bytes + 4) == 0 || u16(bytes + 4) > 16) return false;
    return true;
}
// Returns 1=admitted, 0=denied, -1=unsupported/malformed. Host socket checks still
// run after libslirp translation, so this ingress view is never sole enforcement.
int wc_network_classify_frame(const wc_network_policy *policy, const uint8_t *frame, size_t length, uint64_t now_ns) {
    static const uint8_t guest_mac[6] = {2,0x77,0x69,0,0,1};
    if (!policy || !frame || length < 14 || length > 1514 || memcmp(frame + 6, guest_mac, 6)) return -1;
    uint16_t ether = u16(frame + 12);
    if (ether == 0x806) {
        if (length < 42 || u16(frame+14)!=1 || u16(frame+16)!=0x800 || frame[18]!=6 || frame[19]!=4 || (u16(frame+20)!=1 && u16(frame+20)!=2)) return -1;
        return (!memcmp(frame+28,(uint8_t[]){10,0,2,15},4) || !memcmp(frame+28,(uint8_t[]){0,0,0,0},4)) &&
            (!memcmp(frame+38,(uint8_t[]){10,0,2,2},4) || !memcmp(frame+38,(uint8_t[]){10,0,2,3},4)) ? 1 : 0;
    }
    size_t header; uint8_t protocol; wc_network_address destination = {0};
    if (ether == 0x800) {
        if (length < 34 || frame[14] != 0x45 || u16(frame+16) < 20 || u16(frame+16) > length-14 || (u16(frame+20) & 0x3fff)) return -1;
        header=34; protocol=frame[23]; destination.family=4; memcpy(destination.bytes,frame+30,4);
        if (protocol == 17 && length >= 42 && !memcmp(frame+26,(uint8_t[]){0,0,0,0},4) &&
            !memcmp(frame+30,(uint8_t[]){255,255,255,255},4) && u16(frame+34)==68 && u16(frame+36)==67) return 1;
        if (memcmp(frame+26,(uint8_t[]){10,0,2,15},4)) return 0;
    } else if (ether == 0x86dd) {
        if (length < 54 || (frame[14] >> 4) != 6 || u16(frame+18) > length-54) return -1;
        header=54; protocol=frame[20]; destination.family=6; memcpy(destination.bytes,frame+38,16);
        if (protocol == 58 && length >= 62 && frame[21] == 255 && frame[55] == 0 && (frame[54]==133 || frame[54]==135 || frame[54]==136)) return 1;
        if (!((frame[22]==0xfd && frame[23]==0 && frame[24]==0 && frame[25]==0x77) || (frame[22]==0xfe && (frame[23]&0xc0)==0x80))) return 0;
    } else return -1;
    if ((protocol!=6 && protocol!=17) || length < header+(protocol==6?20:8)) return -1;
    destination.port=u16(frame+header+2);
    if (virtual_dns(destination)) {
        const wc_network_address *resolver = destination.family==4 ? &policy->resolver4 : &policy->resolver6;
        return resolver->family && dns_query(frame+header+(protocol==6?20:8),length-header-(protocol==6?20:8),protocol) &&
            wc_network_destination_allowed(policy,resolver,protocol,true,now_ns) ? 1 : 0;
    }
    // Gateway aliases are checked as their FINAL loopback tuple; only an
    // explicit exact host grant admits them. No other private virtual alias.
    if(destination.family==4 && !memcmp(destination.bytes,(uint8_t[]){10,0,2,2},4)) memcpy(destination.bytes,(uint8_t[]){127,0,0,1},4);
    if(destination.family==6 && !memcmp(destination.bytes,(uint8_t[]){0xfd,0,0,0x77,0,0,0,0,0,0,0,0,0,0,0,2},16)) { memset(destination.bytes,0,16); destination.bytes[15]=1; }
    return wc_network_destination_allowed(policy,&destination,protocol,false,now_ns) ? 1 : 0;
}
