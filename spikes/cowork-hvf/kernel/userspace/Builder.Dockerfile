# Local immutable base is inspected by the runner before BuildKit invocation.
# The resulting derived image is pinned and saved before offline compilation.
FROM winter-cowork-kernel-builder:20261011
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    pkg-config libdevmapper-dev libjson-c-dev libpopt-dev uuid-dev
