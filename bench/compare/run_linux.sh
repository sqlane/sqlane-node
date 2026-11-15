#!/usr/bin/env bash
# The published run of the comparison: the checks, the jobs and the schedules, in the container of linux.dockerfile,
# with a delay of 0.5 ms each way on the container's loopback (netem): a round trip between a client and its database
# costs about 1 ms, as over a network. tc needs root in the container and PostgreSQL refuses root, so the container
# starts as root, adds the delay, and runs the comparison as the image's `bench` user (uid 1000), with CAP_PERFMON for
# the counters (bench/cpu/proc_usage_linux.py).
#
#   podman build -f bench/compare/linux.dockerfile -t sqlane-bench:linux bench/compare
#   bench/compare/run_linux.sh
#
# ENGINE: podman (default, rootless) or docker (rootful: no user namespace). DELAY: the one-way delay (default 0.5ms).
set -euo pipefail

repo="$(cd "$(dirname "$0")/../.." && pwd)"
engine="${ENGINE:-$(command -v podman >/dev/null && echo podman || echo docker)}"
delay="${DELAY:-0.5ms}"
userns=()

if [ "$engine" = podman ]; then
    # The repository's owner is uid 1000 in the container: bench
    userns=("--userns=keep-id:uid=1000,gid=1000")
fi

started=$(date +%s)

# The inner commands expand in the container
# shellcheck disable=SC2016
"$engine" run --rm --user 0 --cap-add NET_ADMIN --cap-add PERFMON "${userns[@]}" --shm-size=2g \
    --ulimit nofile=65536:65536 -e CI=1 -e DELAY="$delay" -v "$repo":/work sqlane-bench:linux bash -c '
    set -euo pipefail
    tc qdisc add dev lo root netem delay "$DELAY" limit 100000
    tc qdisc show dev lo
    exec setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=+perfmon --ambient-caps=+perfmon \
        env HOME=/home/bench USER=bench bash -c "
            set -euo pipefail
            pnpm install --frozen-lockfile
            pnpm bench:compare --parallel 8
            pnpm bench:compare --only cron --parallel 9
        "'

echo "run_linux.sh: $(($(date +%s) - started)) s"
