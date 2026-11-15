#!/usr/bin/env bash
# The published runs on Linux, in the container of bench/compare/linux.dockerfile (the repository mounted at /work):
#
#   compare            The comparison (bench/compare): the checks, the jobs and the schedules, with a delay of 0.5 ms
#                      each way on the container's loopback (netem): a round trip between a client and its database
#                      costs about 1 ms, as over a network.
#   ab [<args>…]       The A/B regression run (`pnpm bench <args>`, bench/regression/ab.mjs), without a delay: it
#                      measures instructions and statements, not latencies. The published numbers:
#                      `bench/run_linux.sh ab --ref . --save bench/regression/results.json`.
#
# tc needs root in the container and PostgreSQL refuses root, so the container starts as root, adds the delay (if
# any), and runs the command as the image's `bench` user (uid 1000), with CAP_PERFMON for the counters
# (bench/cpu/proc_usage_linux.py).
#
#   podman build -f bench/compare/linux.dockerfile -t sqlane-bench:linux bench/compare
#   bench/run_linux.sh compare
#
# ENGINE: podman (default, rootless) or docker (rootful: no user namespace). DELAY: the one-way delay (default 0.5ms
# for compare, none for ab; `none`: no netem).
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
engine="${ENGINE:-$(command -v podman >/dev/null && echo podman || echo docker)}"
mode="${1:-}"
userns=()

case "$mode" in
    compare)
        delay="${DELAY:-0.5ms}"
        commands='pnpm bench:compare --parallel 8
            pnpm bench:compare --only cron --parallel 9'
        ;;
    ab)
        shift
        delay="${DELAY:-none}"
        commands="pnpm bench"

        if [ $# -gt 0 ]; then
            commands+="$(printf ' %q' "$@")"
        fi
        ;;
    *)
        echo "usage: $0 compare | ab [<args of pnpm bench>…]" >&2
        exit 64
        ;;
esac

if [ "$engine" = podman ]; then
    # The repository's owner is uid 1000 in the container: bench
    userns=("--userns=keep-id:uid=1000,gid=1000")
fi

started=$(date +%s)

# The inner commands expand in the container
# shellcheck disable=SC2016
"$engine" run --rm --user 0 --cap-add NET_ADMIN --cap-add PERFMON "${userns[@]}" --shm-size=2g \
    --ulimit nofile=65536:65536 -e CI=1 -e DELAY="$delay" -e COMMANDS="$commands" -v "$repo":/work \
    sqlane-bench:linux bash -c '
    set -euo pipefail
    if [ "$DELAY" != none ]; then
        tc qdisc add dev lo root netem delay "$DELAY" limit 100000
    fi
    tc qdisc show dev lo
    exec setpriv --reuid=1000 --regid=1000 --init-groups --inh-caps=+perfmon --ambient-caps=+perfmon \
        env HOME=/home/bench USER=bench bash -c "
            set -euo pipefail
            pnpm install --frozen-lockfile
            $COMMANDS
        "'

echo "run_linux.sh $mode: $(($(date +%s) - started)) s"
