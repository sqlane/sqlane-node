# The Linux image of the comparison (run.mjs): Node.js, pnpm, and the database servers that the harness starts itself.
# The repository is mounted at /work at run time; nothing of it is copied here.
#
#   docker build -f bench/compare/linux.dockerfile -t sqlane-bench:linux bench/compare
#
# PG_BIN, MYSQL_BIN, MARIADB_BIN and REDIS_BIN name the directories of the server binaries. The versions follow the
# macOS runs (Homebrew): PostgreSQL 17.11, MySQL 8.4.13, MariaDB 11.8.9, Redis 8.10.3.
ARG DEBIAN_IMAGE=debian:trixie-slim

# MySQL and MariaDB: the vendors' generic Linux tarballs, unpacked and trimmed in a stage of their own
FROM ${DEBIAN_IMAGE} AS tarballs

ARG MYSQL_VERSION=8.4.13
ARG MYSQL_SHA256=5dfbb764f731df40ef9e4f5d69aed32bdac8ba1af20bd96b7d40a942d83d4ed2
ARG MARIADB_VERSION=11.8.9
ARG MARIADB_SHA256=32f8871a2aa38b36aa418b7f4abc6fc0c6ef1ba5a45798cacb2afa52c8a6113b
ARG DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl xz-utils binutils file \
    && rm -rf /var/lib/apt/lists/*

# MySQL (the minimal tarball), without its headers, man pages, and the dictionaries of the MeCab full-text parser
RUN curl -fsSLo /tmp/mysql.tar.xz \
        "https://cdn.mysql.com/Downloads/MySQL-8.4/mysql-${MYSQL_VERSION}-linux-glibc2.28-x86_64-minimal.tar.xz" \
    && echo "${MYSQL_SHA256}  /tmp/mysql.tar.xz" | sha256sum -c - \
    && install -d /opt/mysql \
    && tar -xJf /tmp/mysql.tar.xz -C /opt/mysql --strip-components=1 --no-same-owner \
        --exclude='*/include' --exclude='*/man' --exclude='*/lib/mecab' --exclude='*/lib/pkgconfig' --exclude='*.a' \
    && rm /tmp/mysql.tar.xz

# MariaDB (the bintar), without its test suite, headers, man pages, and the storage engines that no queue uses
# (RocksDB, DuckDB, Mroonga). mariadb-install-db lives in scripts/; a link in bin/ keeps one directory for the harness.
RUN curl -fsSLo /tmp/mariadb.tar.gz \
        "https://archive.mariadb.org/mariadb-${MARIADB_VERSION}/bintar-linux-systemd-x86_64/mariadb-${MARIADB_VERSION}-linux-systemd-x86_64.tar.gz" \
    && echo "${MARIADB_SHA256}  /tmp/mariadb.tar.gz" | sha256sum -c - \
    && install -d /opt/mariadb \
    && tar -xzf /tmp/mariadb.tar.gz -C /opt/mariadb --strip-components=1 --no-same-owner \
        --exclude='*/mariadb-test' --exclude='*/mysql-test' --exclude='*/sql-bench' --exclude='*/include' \
        --exclude='*/man' --exclude='*/lib/pkgconfig' --exclude='*.a' \
        --exclude='*/ha_rocksdb.so' --exclude='*/ha_duckdb.so' --exclude='*/ha_mroonga.so' \
    && rm /tmp/mariadb.tar.gz \
    && if [ ! -e /opt/mariadb/bin/mariadb-install-db ]; then \
        ln -s ../scripts/mariadb-install-db /opt/mariadb/bin/mariadb-install-db; fi

# Debug sections only: the machine code stays the same, and the symbol tables stay for profilers
RUN find /opt/mysql /opt/mariadb -type f -exec file {} + | grep -E ': +ELF .*(executable|shared object)' | cut -d: -f1 \
        | xargs strip --strip-debug

FROM ${DEBIAN_IMAGE}

ARG NODE_VERSION=26.13.0
ARG NODE_SHA256=d28a96af6c38596f6d9d97c0ee531c13d238d757742387d1928de822d959e997
ARG PNPM_VERSION=12.18.0
ARG PG_MAJOR=17
ARG PG_VERSION=17.11-1.pgdg13+2
ARG REDIS_VERSION=6:8.10.3-1rl1~trixie1
ARG DEBIAN_FRONTEND=noninteractive
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Base tools, the runtime libraries of the MySQL and MariaDB tarballs (and of Node.js: libatomic), and the apt
# repositories of PGDG and Redis
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl gnupg git procps tar xz-utils python3 libcap2-bin \
        libaio1t64 libnuma1 libncurses6 libtinfo6 libsystemd0 liburing2 libssl3t64 zlib1g libatomic1 \
    && ln -s /usr/lib/x86_64-linux-gnu/libaio.so.1t64 /usr/lib/x86_64-linux-gnu/libaio.so.1 \
    && install -d /usr/share/keyrings \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
        | gpg --dearmor -o /usr/share/keyrings/pgdg.gpg \
    && echo 'deb [signed-by=/usr/share/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt trixie-pgdg main' \
        > /etc/apt/sources.list.d/pgdg.list \
    && curl -fsSL https://packages.redis.io/gpg | gpg --dearmor -o /usr/share/keyrings/redis.gpg \
    && echo 'deb [signed-by=/usr/share/keyrings/redis.gpg] https://packages.redis.io/deb trixie main' \
        > /etc/apt/sources.list.d/redis.list \
    && rm -rf /var/lib/apt/lists/*

# PostgreSQL (with contrib: pg_stat_statements) and Redis, from their own repositories. The packaging must not create
# a cluster or start a server.
RUN apt-get update \
    && install -d /etc/postgresql-common/createcluster.d \
    && echo 'create_main_cluster = false' > /etc/postgresql-common/createcluster.d/no_main.conf \
    && printf '#!/bin/sh\nexit 101\n' > /usr/sbin/policy-rc.d && chmod +x /usr/sbin/policy-rc.d \
    && apt-get install -y --no-install-recommends \
        "postgresql-${PG_MAJOR}=${PG_VERSION}" "postgresql-client-${PG_MAJOR}=${PG_VERSION}" \
        "redis-server=${REDIS_VERSION}" "redis-tools=${REDIS_VERSION}" \
    && rm -f /usr/sbin/policy-rc.d \
    && rm -rf /var/lib/apt/lists/*

# Node.js (the official tarball, checked against SHASUMS256.txt) and pnpm
RUN curl -fsSLo /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner \
        --exclude='*/CHANGELOG.md' --exclude='*/README.md' --exclude='*/LICENSE' --exclude='*/include' \
    && rm /tmp/node.tar.xz \
    && npm install -g "pnpm@${PNPM_VERSION}" \
    && npm cache clean --force \
    && rm -rf /root/.npm

COPY --from=tarballs /opt/mysql /opt/mysql
COPY --from=tarballs /opt/mariadb /opt/mariadb

# mariadbd's compiled-in basedir is /usr/local/mysql (MySQL's mysqld finds its own); the link spares --basedir
RUN ln -s /opt/mariadb /usr/local/mysql

# A copy of python3 that may read the hardware counters of other processes (perf_event_open)
RUN cp "$(readlink -f /usr/bin/python3)" /usr/local/bin/python3-perf \
    && setcap cap_perfmon,cap_sys_ptrace+ep /usr/local/bin/python3-perf

# Fails the build on a missing shared library of a server binary
RUN for binary in /usr/lib/postgresql/${PG_MAJOR}/bin/postgres /opt/mysql/bin/mysqld \
        /opt/mariadb/bin/mariadbd /usr/bin/redis-server; do \
        if ldd "$binary" | grep 'not found'; then echo "missing libraries: $binary"; exit 1; fi; \
    done

# PostgreSQL refuses to run as root
RUN useradd --create-home --uid 1000 --user-group --shell /bin/bash bench \
    && install -d -o bench -g bench /work

ENV PG_BIN=/usr/lib/postgresql/${PG_MAJOR}/bin \
    MYSQL_BIN=/opt/mysql/bin \
    MARIADB_BIN=/opt/mariadb/bin \
    REDIS_BIN=/usr/bin

WORKDIR /work
USER bench
