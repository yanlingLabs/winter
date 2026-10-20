// Bounded synthetic endpoint smoke; no VM or outbound connection.
#include "cowork_network.h"
#include <assert.h>
#include <stdio.h>
#include <sys/socket.h>
#include <unistd.h>
int main(void) {
    wc_network_policy policy = { .revision = 1, .synthetic_no_outbound = true };
    wc_network_address destination;
    assert(wc_network_parse_address("127.0.0.1", 443, &destination));
    assert(!wc_network_destination_allowed(&policy, &destination, 6, false, 1));
    wc_network_endpoint *endpoint = wc_network_create(&policy);
    assert(endpoint);
    int fd = wc_network_guest_fd(endpoint);
    assert(fd >= 0);
    unsigned char invalid[14] = {0};
    assert(send(fd, invalid, sizeof(invalid), 0) == sizeof(invalid));
    policy.revision = 2;
    assert(wc_network_replace_policy(endpoint, &policy, 1) == 0);
    assert(wc_network_replace_policy(endpoint, &policy, 1) != 0);
    wc_network_stats stats = {0};
    wc_network_read_stats(endpoint, &stats);
    assert(stats.revision == 2 && stats.outbound_attempts == 0);
    wc_network_destroy(endpoint);
    puts("{\"relocatedNetwork\":true,\"syntheticNoOutbound\":true,\"realVM\":false}");
    return 0;
}
