FROM ubuntu@sha256:08571ca13e00ca07a2a84eab83a959b4242e22cceb16486a11bef1428c9e93a7
# Base has no CA bundle; bootstrap only this exact package through signed APT.
# Snapshot then prevents dependency selection changing on rerun.
RUN rm /etc/apt/apt.conf.d/docker-clean \
    && apt-get update -o APT::Update::Error-Mode=any \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates=20240203 \
    && sed -i 's|http://ports.ubuntu.com/ubuntu-ports/|https://snapshot.ubuntu.com/ubuntu/20261011T000000Z/|g' /etc/apt/sources.list.d/ubuntu.sources \
    && apt-get update -o APT::Update::Error-Mode=any \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
       make bison flex bc perl openssl gawk sed findutils dwarves \
       python3 gpgv xz-utils libc6-dev libssl-dev libelf-dev \
       libstdc++6 libxml2 libzstd1 zlib1g \
    && mkdir /receipt \
    && dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n' > /receipt/packages.tsv
# Clang's native host utilities use the GNU linker and GCC runtime startup
# objects, even though the arm64 kernel target itself uses ld.lld.
RUN DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends binutils libgcc-13-dev \
    && dpkg-query -W -f='${binary:Package}\t${Version}\t${Architecture}\t${source:Package}\t${source:Version}\n' > /receipt/packages.tsv
# Build invocation supplies only this fixture's inputs/output, drops all caps,
# sets no-new-privileges, closes network, and uses a non-root uid.
