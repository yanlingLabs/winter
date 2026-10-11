# Vendored provenance and security patch

Upstream libslirp v4.9.5, commit390848f47391f412451b2d259d8527fabb51e5e3,
from https://gitlab.freedesktop.org/slirp/libslirp.git. LICENSE, COPYRIGHT and all
source copyright headers are retained. Sources are upstream src/; generated
libslirp-version.h is derived from upstream Meson version4.9.5. Public include
forwards to the one vendored libslirp.h declaration, with no mirrored ABI.

Local changes (must be independently reviewed on every upgrade):

- libslirp.h: append fail-closed Winter policy callback slots. Upstream public
  SlirpCb has no outbound authorization callback.
- socket.c: DNS translation uses only explicit resolver callback; final
  translated TCP/UDP sockaddr must pass destination callback. Read paths require
  current connected peer; UDP receive requires exact admitted source peer.
  Gateway translation excludes broadcast and all other IPv6 virtual-prefix
  addresses. No implicit get_dns6_addr fallback remains in outbound translation.
- slirp.c: actual TCP payload send requires current connected-peer callback.
- tcp_subr.c / udp.c: outbound socket allocation requires capacity callback.
- ip_icmp.c / ip6_icmp.c: host raw/ping socket send helpers return EPERM before
  socket creation. Ingress also rejects Internet ICMP; guest-local NDP remains.
- Two existing trailing-whitespace lines in libslirp.h and socket.c are trimmed.

Audited outbound host syscall sites: tcp_fconnect->sotranslate_out->connect;
sosendto->sotranslate_out->sendto; slirp_send->send; TCP connecting-state zero-byte
send is a connect-status check, not a payload bypass. ICMP raw/ping send helpers
are disabled and fallback paths cannot pass protocol admission. misc.c host
spawn/Unix services and host-forward/listen APIs are never configured or exposed
by the endpoint; enable_emu=false and TFTP/bootfile paths are null. util.c contains
platform wrappers, not alternative guest-authorized services. This audit applies
to this fixed wrapper/configuration only, not every arbitrary upstream API.

SwiftPM C target disables Clang modules for upstream's BSD network struct names;
otherwise SDK struct modules conflict with slirp's independent structs. This
changes compilation, not the public header API.
