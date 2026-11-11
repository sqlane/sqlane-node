#!/bin/bash
# The CPU cost per job of a baseline git ref and of the working tree, on PostgreSQL, MySQL and MariaDB that run on this
# host (macOS, Homebrew). See docs/cpu-cost.md. About 3 minutes with the defaults.
#
#   bench/cpu/measure.sh                         # main vs the working tree, all three databases
#   BASE=v2.0.0 DIALECTS=postgres bench/cpu/measure.sh
#   BASES="main v2.0.0" bench/cpu/measure.sh      # several baselines, each against the same database server
#
# Env:
#   BASE (git ref, default main), BASES (git refs, instead of BASE), DIALECTS
#   WARMUP and MEASURE (seconds, default 5 and 20), NAMES, HISTORY, RATE
#   COMPLETED   completed jobs over the names (default 0)
#   MUTEX_KEYS  with N > 0: one of N mutex keys per job
#   BLOCKED     with MUTEX_KEYS: due jobs over the names that wait for a held key
#   QUEUED      with MUTEX_KEYS: due jobs over the names on one free key
#   OUT (results directory), PG_BIN, MYSQL_BIN, MARIADB_BIN (the server binaries)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
BASES=${BASES:-${BASE:-main}}
DIALECTS=${DIALECTS:-postgres mysql mariadb}
WARMUP=${WARMUP:-5} MEASURE=${MEASURE:-20} NAMES=${NAMES:-1000} HISTORY=${HISTORY:-1000} RATE=${RATE:-20}
COMPLETED=${COMPLETED:-0} MUTEX_KEYS=${MUTEX_KEYS:-0} BLOCKED=${BLOCKED:-0} QUEUED=${QUEUED:-0}
PG_BIN=${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}
MYSQL_BIN=${MYSQL_BIN:-/opt/homebrew/opt/mysql@8.4/bin}
MARIADB_BIN=${MARIADB_BIN:-/opt/homebrew/opt/mariadb@11.8/bin}
TMP=$(mktemp -d)
OUT=${OUT:-$TMP/results}
mkdir -p "$OUT"
DB_PID=

cleanup() {
    [ -n "$DB_PID" ] && kill "$DB_PID" 2>/dev/null || true
    [ -f "$TMP/pg/postmaster.pid" ] && "$PG_BIN/pg_ctl" -D "$TMP/pg" -m immediate stop >/dev/null 2>&1 || true
    # Keeps the results only
    rm -rf "$TMP/pg" "$TMP/my" "$TMP/ma" "$TMP"/base-*
}
trap cleanup EXIT

# The baselines: their sources, with the drivers of this checkout. The variants: base-1, base-2... and current.
VARIANTS=
index=0
for base in $BASES; do
    index=$((index + 1))
    mkdir -p "$TMP/base-$index"
    git -C "$ROOT" archive "$base" src package.json | tar -x -C "$TMP/base-$index"
    ln -s "$ROOT/node_modules" "$TMP/base-$index/node_modules"
    VARIANTS="$VARIANTS base-$index"
done
VARIANTS="$VARIANTS current"

cat > "$TMP/init.sql" <<'SQL'
CREATE DATABASE IF NOT EXISTS bench;
CREATE USER IF NOT EXISTS 'bench'@'127.0.0.1';
GRANT ALL ON bench.* TO 'bench'@'127.0.0.1';
SQL

wait_for() {
    for _ in $(seq 1 120); do "$@" >/dev/null 2>&1 && return 0; sleep 0.5; done
    echo "The database did not start" >&2
    return 1
}

# Default configs (no my.cnf), TCP only: Unix sockets in a long temporary path exceed the 104-byte limit of macOS.
# MariaDB gets the binary log of MySQL 8.4, as in the other benchmarks.
start_db() {
    case $1 in
        postgres)
            "$PG_BIN/initdb" -D "$TMP/pg" -U postgres --auth=trust >/dev/null
            "$PG_BIN/pg_ctl" -D "$TMP/pg" -l "$TMP/pg.log" -w start \
                -o "-p 55433 -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" >/dev/null
            DB_PID=$(head -1 "$TMP/pg/postmaster.pid")
            URL=postgresql://postgres@127.0.0.1:55433/postgres ;;
        mysql)
            "$MYSQL_BIN/mysqld" --no-defaults --initialize-insecure --datadir="$TMP/my" >/dev/null 2>&1
            (cd "$TMP" && exec "$MYSQL_BIN/mysqld" --no-defaults --datadir="$TMP/my" --port=53307 \
                --bind-address=127.0.0.1 --socket=my.sock --mysqlx=OFF --log-error="$TMP/my.err" \
                --init-file="$TMP/init.sql") &
            DB_PID=$!
            wait_for "$MYSQL_BIN/mysql" --no-defaults -h127.0.0.1 -P53307 -ubench -e 'SELECT 1'
            URL=mysql://bench@127.0.0.1:53307/bench ;;
        mariadb)
            "$MARIADB_BIN/mariadb-install-db" --no-defaults --datadir="$TMP/ma" --skip-test-db >/dev/null 2>&1
            (cd "$TMP" && exec "$MARIADB_BIN/mariadbd" --no-defaults --datadir="$TMP/ma" --port=53308 \
                --bind-address=127.0.0.1 --socket=ma.sock --log-error="$TMP/ma.err" --init-file="$TMP/init.sql" \
                --log-bin=binlog --sync-binlog=1 --binlog-format=ROW) &
            DB_PID=$!
            wait_for "$MARIADB_BIN/mariadb" --no-defaults -h127.0.0.1 -P53308 -ubench -e 'SELECT 1'
            URL=mysql://bench@127.0.0.1:53308/bench ;;
    esac
}

stop_db() {
    if [ "$1" = postgres ]; then
        "$PG_BIN/pg_ctl" -D "$TMP/pg" -m fast -w stop >/dev/null
    else
        kill -TERM "$DB_PID"
        wait "$DB_PID" 2>/dev/null || true
    fi
    DB_PID=
}

for dialect in $DIALECTS; do
    start_db "$dialect"

    for variant in $VARIANTS; do
        src=$ROOT
        [ "$variant" != current ] && src=$TMP/$variant
        run=$OUT/$dialect-$variant
        mkdir -p "$run"
        common=(--src "$src" --dialect "$dialect" --url "$URL" --names "$NAMES" --history "$HISTORY"
            --completed "$COMPLETED" --mutex-keys "$MUTEX_KEYS" --blocked "$BLOCKED" --queued "$QUEUED" --rate "$RATE" --warmup "$WARMUP" --measure "$MEASURE" --out "$run")
        node "$HERE/app.js" --role setup "${common[@]}" > "$run/setup.log" 2>&1
        node "$HERE/app.js" --role worker "${common[@]}" > "$run/worker.log" 2>&1 &
        worker=$!
        node "$HERE/app.js" --role producer "${common[@]}" > "$run/producer.log" 2>&1 &
        producer=$!
        sleep "$WARMUP"
        python3 "$HERE/proc_usage.py" "db=$DB_PID+" "worker=$worker" "producer=$producer" > "$run/before.json"
        sleep "$MEASURE"
        python3 "$HERE/proc_usage.py" "db=$DB_PID+" "worker=$worker" "producer=$producer" > "$run/after.json"
        wait "$worker" "$producer"
        echo "$dialect $variant done" >&2
    done

    stop_db "$dialect"
done

# Per job: the counters of each process over the window, divided by the jobs that the worker completed in it
python3 - "$OUT" "$BASES" "$DIALECTS" <<'PY'
import json, sys
out, bases, dialects = sys.argv[1], sys.argv[2].split(), sys.argv[3].split()
roles = ('worker', 'producer', 'db')
labels = {f'base-{index}': base for index, base in enumerate(bases, 1)} | {'current': 'working tree'}
print('Per job. Instructions and cycles in millions, CPU in ms; worker / producer / db = total.\n')
print('| Database | Variant | Jobs | Instructions | Cycles | CPU ms |')
print('| --- | --- | --- | --- | --- | --- |')
for dialect in dialects:
    for variant in labels:
        run = f'{out}/{dialect}-{variant}'
        before, after = (json.load(open(f'{run}/{name}.json')) for name in ('before', 'after'))
        worker = json.load(open(f'{run}/worker.json'))
        jobs = worker['completed']
        if worker.get('overlaps') or worker.get('wrongKeys'):
            print(f"| {dialect} | {variant} | MUTEX BREACH: {worker['overlaps']} overlaps, {worker['wrongKeys']} wrong keys |")
        cells = []
        for key, scale in (('instructions', 1e6), ('cycles', 1e6), ('cpuSeconds', 1e-3)):
            values = [(after[role][key] - before[role][key]) / jobs / scale for role in roles]
            cells.append(' / '.join(f'{value:.2f}' for value in values) + f' = **{sum(values):.2f}**')
        print(f"| {dialect} | {labels[variant]} | {jobs} | {' | '.join(cells)} |")
print(f'\nRaw numbers: {out}')
PY
