#include "cowork_network.h"
#include <libslirp.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <poll.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_SOCKETS 256
#define MAX_POLLS (MAX_SOCKETS + 2)
#define MAX_UDP_PEERS 16
typedef struct { wc_network_address address; bool dns; uint64_t sent_ns; uint32_t bound_ifindex; uint64_t host_generation; } udp_peer;
typedef struct { int fd; wc_network_address peer; int protocol; bool dns; uint32_t bound_ifindex; uint64_t host_generation; udp_peer udp[MAX_UDP_PEERS]; size_t udp_count; } flow;
typedef struct { SlirpTimerId id; void *opaque; int64_t expires_ms; bool used; } timer;
struct wc_network_endpoint {
    pthread_t thread; pthread_mutex_t lock; pthread_cond_t changed;
    int guest_fd, engine_fd, control[2]; bool stopped, replacing, replacement_done, replacement_inflight;
    wc_network_policy policy, replacement, effective_policy;
    wc_network_inventory inventory;
    bool inventory_fixture;
    wc_network_stats stats;
    Slirp *slirp;
    flow flows[MAX_SOCKETS]; size_t flow_count;
    struct pollfd polls[MAX_POLLS]; size_t poll_count;
    timer timers[4];
};
static uint64_t now_ns(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC,&t); return (uint64_t)t.tv_sec*1000000000+(uint64_t)t.tv_nsec; }
static void wake(wc_network_endpoint *ctx) { uint8_t b=1; (void)write(ctx->control[1],&b,1); }
static bool address_from_sockaddr(const struct sockaddr *sa, wc_network_address *out) {
    memset(out,0,sizeof(*out));
    if (sa->sa_family==AF_INET) { const struct sockaddr_in *v=(const void *)sa; out->family=4; memcpy(out->bytes,&v->sin_addr,4); out->port=ntohs(v->sin_port); return true; }
    if (sa->sa_family==AF_INET6) { const struct sockaddr_in6 *v=(const void *)sa; out->family=6; memcpy(out->bytes,&v->sin6_addr,16); out->port=ntohs(v->sin6_port); out->scope_id=v->sin6_scope_id; return true; }
    return false;
}
static bool address_equal(const wc_network_address *a,const wc_network_address *b) { return a->family==b->family && a->port==b->port && a->scope_id==b->scope_id && !memcmp(a->bytes,b->bytes,a->family==4?4:16); }
static void stat_add(wc_network_endpoint *ctx,uint64_t *value) { pthread_mutex_lock(&ctx->lock); (*value)++; pthread_mutex_unlock(&ctx->lock); }
static flow *find_flow(wc_network_endpoint *ctx,int fd) { for(size_t i=0;i<ctx->flow_count;i++) if(ctx->flows[i].fd==fd) return &ctx->flows[i]; return NULL; }
static void host_snapshot(wc_network_policy *policy) {
    // Fresh final-destination checks include host addresses and connected LAN
    // prefixes even when those addresses are globally routable.
    struct ifaddrs *all=NULL;
    if(getifaddrs(&all)!=0) { policy->public_internet=false; return; }
    for(struct ifaddrs *i=all;i && policy->host_network_count<WC_NETWORK_MAX_PREFIXES;i=i->ifa_next) {
        if(!i->ifa_addr) continue;
        wc_network_address a,mask;
        if(!address_from_sockaddr(i->ifa_addr,&a)) continue;
        uint32_t identity=if_nametoindex(i->ifa_name);
        if(!identity) {policy->public_internet=false;continue;}
        // Prefix matching deliberately ignores scope; the cache uses this field
        // to detect an address/LAN moving between interfaces as an identity change.
        a.scope_id=identity;
        policy->host_networks[policy->host_network_count++]=(wc_network_prefix){.address=a,.prefix_length=a.family==4?32:128};
        if(policy->host_network_count==WC_NETWORK_MAX_PREFIXES) break;
        if(!i->ifa_netmask || !address_from_sockaddr(i->ifa_netmask,&mask) || mask.family!=a.family) { policy->public_internet=false; continue; }
        wc_network_prefix p={.address=a,.prefix_length=0}; bool zero=false,invalid=false;
        for(int b=0;b<(a.family==4?4:16);b++) for(int bit=7;bit>=0;bit--) { bool one=mask.bytes[b]&(1<<bit); if(one && zero) invalid=true; else if(one) p.prefix_length++; else zero=true; }
        if(invalid || !p.prefix_length) policy->public_internet=false;
        else policy->host_networks[policy->host_network_count++]=p;
        if(policy->host_network_count==WC_NETWORK_MAX_PREFIXES) break;
        if((i->ifa_flags&IFF_POINTOPOINT) && i->ifa_dstaddr && address_from_sockaddr(i->ifa_dstaddr,&a)) {
            a.scope_id=identity;
            policy->host_networks[policy->host_network_count++]=(wc_network_prefix){.address=a,.prefix_length=a.family==4?32:128};
        }
    }
    freeifaddrs(all);
    // Overflow is conservative rather than silently omitting a host/LAN fence.
    if(policy->host_network_count==WC_NETWORK_MAX_PREFIXES) policy->public_internet=false;
}
bool wc_network_bind_interface(int fd,uint8_t family,uint32_t ifindex) {
    if(family==4)return setsockopt(fd,IPPROTO_IP,IP_BOUND_IF,&ifindex,sizeof(ifindex))==0;
    if(family==6)return setsockopt(fd,IPPROTO_IPV6,IPV6_BOUND_IF,&ifindex,sizeof(ifindex))==0;
    return false;
}
static bool admission_interface(wc_network_endpoint *ctx,const wc_network_address *peer,int protocol,bool dns,uint32_t *interface) {
    return wc_network_inventory_admit(&ctx->inventory,&ctx->effective_policy,peer,(uint8_t)protocol,dns,now_ns(),false,interface);
}
static bool current_matches(wc_network_endpoint *ctx,const wc_network_address *peer,int protocol,bool dns,uint32_t bound,uint64_t generation) {
    return wc_network_inventory_matches(&ctx->inventory,&ctx->effective_policy,peer,(uint8_t)protocol,dns,now_ns(),bound,generation);
}
static bool destination(int fd,int protocol,const struct sockaddr *sa,size_t length,bool dns,void *opaque) {
    (void)length; wc_network_endpoint *ctx=opaque; wc_network_address peer;uint32_t interface=0;
    flow *f=find_flow(ctx,fd);
    if(!f || !address_from_sockaddr(sa,&peer)) {stat_add(ctx,&ctx->stats.denied);return false;}
    bool admitted=admission_interface(ctx,&peer,protocol,dns,&interface);
    if(!admitted && protocol==17) for(size_t i=0;i<f->udp_count;i++) {
        // A stale inventory can retain a previously admitted UDP tuple, never
        // add another peer to the shared socket during the grace period.
        if(address_equal(&f->udp[i].address,&peer) && current_matches(ctx,&peer,protocol,dns,f->udp[i].bound_ifindex,f->udp[i].host_generation)) {
            interface=f->udp[i].bound_ifindex;admitted=true;break;
        }
    }
    if(!admitted) {stat_add(ctx,&ctx->stats.denied);return false;}
    stat_add(ctx,&ctx->stats.outbound_attempts);
    // One upstream UDP socket has one kernel interface binding. Preserve existing peers;
    // a cross-interface tuple must use a distinct guest socket instead of silently rebinding.
    if(protocol==17 && f->udp_count && f->udp[0].bound_ifindex!=interface) {stat_add(ctx,&ctx->stats.denied);return false;}
    if(!wc_network_bind_interface(fd,peer.family,interface)) {stat_add(ctx,&ctx->stats.denied);return false;}
    if(ctx->policy.synthetic_no_outbound) {
        // The fixture reaches the same final translated-tuple check and real
        // kernel interface binding, but cannot reach connect/sendto.
        uint32_t actual=0; socklen_t size=sizeof(actual);
        int level=peer.family==4?IPPROTO_IP:IPPROTO_IPV6, option=peer.family==4?IP_BOUND_IF:IPV6_BOUND_IF;
        if(getsockopt(fd,level,option,&actual,&size)==0 && actual==interface) {
            pthread_mutex_lock(&ctx->lock);ctx->stats.synthetic_bound_sockets++;ctx->stats.synthetic_bound_ifindex=actual;pthread_mutex_unlock(&ctx->lock);
        }
        return false;
    }
    if(protocol==17) {
        size_t at=0;for(;at<f->udp_count;at++) if(address_equal(&f->udp[at].address,&peer)) break;
        if(at==MAX_UDP_PEERS) { stat_add(ctx,&ctx->stats.denied); return false; }
        f->udp[at]=(udp_peer){.address=peer,.dns=dns,.sent_ns=now_ns(),.bound_ifindex=interface,.host_generation=ctx->inventory.host_generation};if(at==f->udp_count) f->udp_count++;
    }
    f->peer=peer; f->protocol=protocol; f->dns=dns; f->bound_ifindex=interface;f->host_generation=ctx->inventory.host_generation;return true;
}
static bool inbound(int fd,int protocol,const struct sockaddr *sa,size_t length,void *opaque) {
    (void)length; wc_network_endpoint *ctx=opaque; wc_network_address peer; flow *f=find_flow(ctx,fd);
    bool allowed=false;
    if(f && address_from_sockaddr(sa,&peer) && protocol==f->protocol) {
        if(protocol==17) {
            for(size_t i=0;i<f->udp_count;i++) if(address_equal(&peer,&f->udp[i].address) && current_matches(ctx,&peer,protocol,f->udp[i].dns,f->udp[i].bound_ifindex,f->udp[i].host_generation)) { allowed=true;break; }
        } else allowed=address_equal(&peer,&f->peer) && current_matches(ctx,&peer,protocol,f->dns,f->bound_ifindex,f->host_generation);
    }
    if(!allowed) stat_add(ctx,&ctx->stats.inbound_peer_denied); return allowed;
}
static bool peer_current(int fd,void *opaque) {
    wc_network_endpoint *ctx=opaque; flow *f=find_flow(ctx,fd); if(!f || !f->peer.family) return false;
    // This is our immutable admitted connected tuple. getpeername may fail after RST,
    // which must reach upstream recv/close handling instead of turning into a poll spin.
    return current_matches(ctx,&f->peer,f->protocol,f->dns,f->bound_ifindex,f->host_generation);
}
static bool capacity(void *opaque) { return ((wc_network_endpoint *)opaque)->flow_count<MAX_SOCKETS; }
static bool dns(int family,struct sockaddr *sa,size_t length,void *opaque) {
    wc_network_endpoint *ctx=opaque; const wc_network_address *resolver=family==AF_INET?&ctx->policy.resolver4:&ctx->policy.resolver6;
    if(!resolver->family || resolver->port!=53 || !ctx->policy.system_dns_exception) return false;
    if(family==AF_INET && length>=sizeof(struct sockaddr_in)) { struct sockaddr_in *v=(void *)sa; memset(v,0,sizeof(*v)); v->sin_len=sizeof(*v); v->sin_family=AF_INET; v->sin_port=htons(53); memcpy(&v->sin_addr,resolver->bytes,4); return true; }
    if(family==AF_INET6 && length>=sizeof(struct sockaddr_in6)) { struct sockaddr_in6 *v=(void *)sa; memset(v,0,sizeof(*v)); v->sin6_len=sizeof(*v); v->sin6_family=AF_INET6; v->sin6_port=htons(53); v->sin6_scope_id=resolver->scope_id; memcpy(&v->sin6_addr,resolver->bytes,16); return true; }
    return false;
}
static slirp_ssize_t send_packet(const void *bytes,size_t length,void *opaque) {
    wc_network_endpoint *ctx=opaque;
    if(length>1514 || send(ctx->engine_fd,bytes,length,0)!=(ssize_t)length) { stat_add(ctx,&ctx->stats.dropped); return (slirp_ssize_t)length; }
    stat_add(ctx,&ctx->stats.packets_out); return (slirp_ssize_t)length;
}
static void guest_error(const char *text,void *opaque) { (void)text; stat_add(opaque,&((wc_network_endpoint *)opaque)->stats.unsupported); }
static int64_t clock_ns(void *opaque) { (void)opaque; return (int64_t)now_ns(); }
static void *timer_new(SlirpTimerId id,void *cb_opaque,void *opaque) { wc_network_endpoint *ctx=opaque; for(int i=0;i<4;i++) if(!ctx->timers[i].used) { ctx->timers[i]=(timer){.id=id,.opaque=cb_opaque,.expires_ms=-1,.used=true}; return &ctx->timers[i]; } return NULL; }
static void timer_free(void *value,void *opaque) { (void)opaque; if(value) ((timer *)value)->used=false; }
static void timer_mod(void *value,int64_t expires,void *opaque) { (void)opaque; if(value) ((timer *)value)->expires_ms=expires; }
static void notify(void *opaque) { wake(opaque); }
static void register_socket(slirp_os_socket fd,void *opaque) {
    wc_network_endpoint *ctx=opaque;
    if(ctx->flow_count>=MAX_SOCKETS) return;
    ctx->flows[ctx->flow_count++]=(flow){.fd=fd};
    int enabled=1; setsockopt(fd,SOL_SOCKET,SO_NOSIGPIPE,&enabled,sizeof(enabled));
    pthread_mutex_lock(&ctx->lock); ctx->stats.active_sockets=ctx->flow_count; pthread_mutex_unlock(&ctx->lock);
}
static void unregister_socket(slirp_os_socket fd,void *opaque) {
    wc_network_endpoint *ctx=opaque;
    for(size_t i=0;i<ctx->flow_count;i++) if(ctx->flows[i].fd==fd) { ctx->flows[i]=ctx->flows[--ctx->flow_count]; break; }
    pthread_mutex_lock(&ctx->lock); ctx->stats.active_sockets=ctx->flow_count; pthread_mutex_unlock(&ctx->lock);
}
static const SlirpCb callbacks={.send_packet=send_packet,.guest_error=guest_error,.clock_get_ns=clock_ns,.timer_free=timer_free,.timer_mod=timer_mod,.notify=notify,.timer_new_opaque=timer_new,.register_poll_socket=register_socket,.unregister_poll_socket=unregister_socket,.winter_destination=destination,.winter_inbound_peer=inbound,.winter_dns=dns,.winter_peer_current=peer_current,.winter_socket_capacity=capacity};
static Slirp *new_stack(wc_network_endpoint *ctx) {
    SlirpConfig cfg={.version=6,.in_enabled=true,.in6_enabled=true,.vprefix_len=64,.if_mtu=1500,.if_mru=1500,.disable_host_loopback=false,.enable_emu=false};
    inet_pton(AF_INET,"10.0.2.0",&cfg.vnetwork); inet_pton(AF_INET,"255.255.255.0",&cfg.vnetmask); inet_pton(AF_INET,"10.0.2.2",&cfg.vhost);
    inet_pton(AF_INET,"10.0.2.15",&cfg.vdhcp_start); inet_pton(AF_INET,"10.0.2.3",&cfg.vnameserver);
    inet_pton(AF_INET6,"fd00:77::",&cfg.vprefix_addr6); inet_pton(AF_INET6,"fd00:77::2",&cfg.vhost6); inet_pton(AF_INET6,"fd00:77::3",&cfg.vnameserver6);
    cfg.disable_dns=!ctx->policy.resolver4.family && !ctx->policy.resolver6.family;
    return slirp_new(&cfg,&callbacks,ctx);
}
static int add_poll(slirp_os_socket fd,int events,void *opaque) {
    wc_network_endpoint *ctx=opaque; if(ctx->poll_count>=MAX_POLLS) return -1;
    short flags=0; if(events&SLIRP_POLL_IN) flags|=POLLIN; if(events&SLIRP_POLL_OUT) flags|=POLLOUT; if(events&SLIRP_POLL_PRI) flags|=POLLPRI;
    size_t index=ctx->poll_count++; ctx->polls[index]=(struct pollfd){.fd=fd,.events=flags}; return (int)index;
}
static int revents(int index,void *opaque) {
    wc_network_endpoint *ctx=opaque; if(index<0 || (size_t)index>=ctx->poll_count) return SLIRP_POLL_ERR;
    short value=ctx->polls[index].revents; int result=0;
    if(value&POLLIN) result|=SLIRP_POLL_IN; if(value&POLLOUT) result|=SLIRP_POLL_OUT; if(value&POLLPRI) result|=SLIRP_POLL_PRI; if(value&POLLERR) result|=SLIRP_POLL_ERR; if(value&POLLHUP) result|=SLIRP_POLL_HUP; return result;
}
static void reset_stack(wc_network_endpoint *ctx) {
    if(ctx->slirp) slirp_cleanup(ctx->slirp);
    ctx->flow_count=0; memset(ctx->timers,0,sizeof(ctx->timers)); ctx->slirp=new_stack(ctx);
}
static void *worker(void *opaque) {
    wc_network_endpoint *ctx=opaque;
    uint64_t token_time=now_ns(); double tokens=64;
    for(;;) {
        pthread_mutex_lock(&ctx->lock); bool stop=ctx->stopped,replace=ctx->replacing;
        if(replace) { ctx->policy=ctx->replacement; ctx->replacing=false; }
        pthread_mutex_unlock(&ctx->lock);
        if(stop) break;
        uint64_t inventory_time=now_ns();
        if(!ctx->inventory_fixture && wc_network_inventory_due(&ctx->inventory,inventory_time)) {
            wc_network_policy hosts={.public_internet=true};host_snapshot(&hosts);
            wc_host_route_snapshot routes;wc_host_routes_read(&routes);
            wc_network_inventory_update(&ctx->inventory,&routes,&hosts,inventory_time);
            stat_add(ctx,&ctx->stats.inventory_refreshes);
        }
        wc_network_inventory_effective(&ctx->inventory,&ctx->policy,&ctx->effective_policy);
        stat_add(ctx,&ctx->stats.poll_turns);
        if(replace) {
            reset_stack(ctx); pthread_mutex_lock(&ctx->lock); ctx->stats.revision=ctx->policy.revision; ctx->stats.policy_replacements++; if(!ctx->slirp) ctx->stopped=true; ctx->replacement_done=true; pthread_cond_broadcast(&ctx->changed); pthread_mutex_unlock(&ctx->lock);
        }
        if(!ctx->slirp) break;
        // Prune only affected tuples. An expired grant must not reset unrelated connections.
        for(size_t i=0;i<ctx->flow_count;) {
            flow *f=&ctx->flows[i];bool expired=false;
            if(f->protocol==17 && f->peer.family) {
                for(size_t n=0;n<f->udp_count;) {
                    if(now_ns()-f->udp[n].sent_ns>120ULL*1000000000 || !current_matches(ctx,&f->udp[n].address,17,f->udp[n].dns,f->udp[n].bound_ifindex,f->udp[n].host_generation)) f->udp[n]=f->udp[--f->udp_count];
                    else n++;
                }
                expired=f->udp_count==0;
            } else expired=f->peer.family && !current_matches(ctx,&f->peer,f->protocol,f->dns,f->bound_ifindex,f->host_generation);
            if(expired) { int fd=f->fd;slirp_winter_close_socket(ctx->slirp,fd);if(i<ctx->flow_count && ctx->flows[i].fd==fd)i++; }
            else i++;
        }
        if(!ctx->slirp) break;
        uint32_t timeout=100; ctx->poll_count=2; ctx->polls[0]=(struct pollfd){.fd=ctx->engine_fd,.events=POLLIN}; ctx->polls[1]=(struct pollfd){.fd=ctx->control[0],.events=POLLIN};
        slirp_pollfds_fill_socket(ctx->slirp,&timeout,add_poll,ctx);
        uint64_t ms=now_ns()/1000000;
        for(int i=0;i<4;i++) if(ctx->timers[i].used && ctx->timers[i].expires_ms>=0) { uint64_t expiry=(uint64_t)ctx->timers[i].expires_ms; if(expiry<=ms) timeout=0; else if(expiry-ms<timeout) timeout=(uint32_t)(expiry-ms); }
        int ready=poll(ctx->polls,ctx->poll_count,(int)timeout);
        if(ctx->polls[1].revents&POLLIN) { uint8_t b[64]; while(read(ctx->control[0],b,sizeof(b))>0){} continue; }
        if(ctx->polls[0].revents&POLLIN) for(int budget=0;budget<64;budget++) {
            uint8_t frame[1515]; ssize_t length=recv(ctx->engine_fd,frame,sizeof(frame),0); if(length<0) break;
            stat_add(ctx,&ctx->stats.packets_in);
            uint64_t tick=now_ns(); tokens += (double)(tick-token_time)*1024.0/1000000000.0; if(tokens>64) tokens=64; token_time=tick;
            if(tokens<1) {stat_add(ctx,&ctx->stats.dropped); continue;} tokens-=1;
            int admitted=wc_network_classify_frame(&ctx->effective_policy,frame,(size_t)length,now_ns());
            if(admitted==1) slirp_input(ctx->slirp,frame,(int)length); else stat_add(ctx,admitted==0?&ctx->stats.denied:&ctx->stats.unsupported);
        }
        slirp_pollfds_poll(ctx->slirp,ready<0,revents,ctx);
        ms=now_ns()/1000000; for(int i=0;i<4;i++) if(ctx->timers[i].used && ctx->timers[i].expires_ms>=0 && (uint64_t)ctx->timers[i].expires_ms<=ms) { ctx->timers[i].expires_ms=-1; slirp_handle_timer(ctx->slirp,ctx->timers[i].id,ctx->timers[i].opaque); }
    }
    if(ctx->slirp) { slirp_cleanup(ctx->slirp); ctx->slirp=NULL; }
    pthread_mutex_lock(&ctx->lock); ctx->stopped=true; ctx->replacement_done=true; pthread_cond_broadcast(&ctx->changed); pthread_mutex_unlock(&ctx->lock); return NULL;
}
static wc_network_endpoint *create(const wc_network_policy *policy,const wc_host_route_snapshot *fixture) {
    if(!policy || policy->grant_count>WC_NETWORK_MAX_GRANTS || policy->host_network_count>WC_NETWORK_MAX_PREFIXES) return NULL;
    wc_network_endpoint *ctx=calloc(1,sizeof(*ctx)); if(!ctx) return NULL; ctx->guest_fd=ctx->engine_fd=ctx->control[0]=ctx->control[1]=-1;
    pthread_mutex_init(&ctx->lock,NULL); pthread_cond_init(&ctx->changed,NULL); ctx->policy=*policy; ctx->stats.revision=policy->revision;
    if(fixture) {
        if(!policy->synthetic_no_outbound) goto failed;
        wc_network_policy hosts={.public_internet=true};
        wc_network_inventory_update(&ctx->inventory,fixture,&hosts,now_ns());ctx->inventory_fixture=true;
    }
    int pair[2]; if(socketpair(AF_UNIX,SOCK_DGRAM,0,pair)!=0) goto failed; ctx->guest_fd=pair[0]; ctx->engine_fd=pair[1];
    if(pipe(ctx->control)!=0) goto failed;
    int snd=128*1024,rcv=512*1024,no_sigpipe=1;
    for(int i=0;i<2;i++) { fcntl(pair[i],F_SETFL,O_NONBLOCK); fcntl(pair[i],F_SETFD,FD_CLOEXEC); if(setsockopt(pair[i],SOL_SOCKET,SO_SNDBUF,&snd,sizeof(snd)) || setsockopt(pair[i],SOL_SOCKET,SO_RCVBUF,&rcv,sizeof(rcv)) || setsockopt(pair[i],SOL_SOCKET,SO_NOSIGPIPE,&no_sigpipe,sizeof(no_sigpipe))) goto failed; }
    for(int i=0;i<2;i++) { fcntl(ctx->control[i],F_SETFL,O_NONBLOCK); fcntl(ctx->control[i],F_SETFD,FD_CLOEXEC); }
    ctx->slirp=new_stack(ctx); if(!ctx->slirp || pthread_create(&ctx->thread,NULL,worker,ctx)!=0) goto failed;
    return ctx;
failed:
    if(ctx->slirp) slirp_cleanup(ctx->slirp); if(ctx->guest_fd>=0) close(ctx->guest_fd); if(ctx->engine_fd>=0) close(ctx->engine_fd); if(ctx->control[0]>=0) close(ctx->control[0]); if(ctx->control[1]>=0) close(ctx->control[1]); pthread_mutex_destroy(&ctx->lock); pthread_cond_destroy(&ctx->changed); free(ctx); return NULL;
}
wc_network_endpoint *wc_network_create(const wc_network_policy *policy) {return create(policy,NULL);}
wc_network_endpoint *wc_network_create_inventory_fixture(const wc_network_policy *policy,const wc_host_route_snapshot *routes) {
    if(!routes || !policy || !policy->synthetic_no_outbound)return NULL;
    return create(policy,routes);
}
int wc_network_guest_fd(wc_network_endpoint *ctx) { return ctx?ctx->guest_fd:-1; }
int wc_network_replace_policy(wc_network_endpoint *ctx,const wc_network_policy *policy,uint64_t expected) {
    if(!ctx || !policy || (ctx->inventory_fixture && !policy->synthetic_no_outbound) || policy->grant_count>WC_NETWORK_MAX_GRANTS || policy->host_network_count>WC_NETWORK_MAX_PREFIXES) return EINVAL;
    pthread_mutex_lock(&ctx->lock);
    if(ctx->stopped || ctx->replacement_inflight || ctx->stats.revision!=expected || policy->revision<=expected) { pthread_mutex_unlock(&ctx->lock); return EBUSY; }
    ctx->replacement=*policy; ctx->replacing=true; ctx->replacement_inflight=true; ctx->replacement_done=false; wake(ctx);
    while(!ctx->replacement_done && !ctx->stopped) pthread_cond_wait(&ctx->changed,&ctx->lock);
    bool stopped=ctx->stopped; ctx->replacement_inflight=false; pthread_cond_broadcast(&ctx->changed); pthread_mutex_unlock(&ctx->lock); return stopped?ECANCELED:0;
}
void wc_network_read_stats(wc_network_endpoint *ctx,wc_network_stats *out) { if(!ctx || !out) return; pthread_mutex_lock(&ctx->lock); *out=ctx->stats; pthread_mutex_unlock(&ctx->lock); }
void wc_network_destroy(wc_network_endpoint *ctx) { if(!ctx) return; pthread_mutex_lock(&ctx->lock); ctx->stopped=true; wake(ctx); pthread_cond_broadcast(&ctx->changed); while(ctx->replacement_inflight)pthread_cond_wait(&ctx->changed,&ctx->lock); pthread_mutex_unlock(&ctx->lock); pthread_join(ctx->thread,NULL); close(ctx->guest_fd); close(ctx->engine_fd); close(ctx->control[0]); close(ctx->control[1]); pthread_mutex_destroy(&ctx->lock); pthread_cond_destroy(&ctx->changed); free(ctx); }
