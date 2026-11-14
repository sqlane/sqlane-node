#!/usr/bin/env python3
"""The CPU counters of processes, Linux: instructions retired and cycles (perf_event_open), CPU time (/proc).

Linux keeps no running total of a process's instructions, as macOS does, so this is a daemon: it watches /proc and
opens a counter on every thread as soon as it appears, so a process's counts run from its start, less at most one poll
(50 ms). Run it in a container of its own, where every process belongs to the benchmark. It needs CAP_PERFMON (or a
`kernel.perf_event_paranoid` of 1 or less) to count kernel instructions too; without it, it counts user space only and
says so on stderr.

Protocol: one JSON request per line on stdin, {"id": n, "processes": {"<label>": "<pid>[+]"}}, with '+' for the
process and its descendants (the processes of a PostgreSQL server). One JSON reply per line on stdout,
{"id": n, "result": {label: {"instructions": n, "cycles": n, "cpuSeconds": s, "byCommand": {...}}}}, as proc_usage.py
prints on macOS. A process that exited counts as zero.
"""
import ctypes
import json
import os
import platform
import resource
import struct
import sys
import threading
import time

SYSCALL = {'x86_64': 298, 'aarch64': 241}[platform.machine()]
LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.syscall.restype = ctypes.c_long
CLOCK_TICKS = os.sysconf('SC_CLK_TCK')
POLL_SECONDS = 0.05

PERF_TYPE_HARDWARE = 0
CONFIG = {'cycles': 0, 'instructions': 1}
FORMAT = 1 | 2  # PERF_FORMAT_TOTAL_TIME_ENABLED | PERF_FORMAT_TOTAL_TIME_RUNNING: scale a multiplexed counter
EXCLUDE_KERNEL = 1 << 5
EXCLUDE_HV = 1 << 6


class Attr(ctypes.Structure):
    """perf_event_attr up to read_format and the flags; the kernel accepts a size of 128 with the rest zero."""
    _fields_ = [
        ('type', ctypes.c_uint32), ('size', ctypes.c_uint32), ('config', ctypes.c_uint64),
        ('sample_period', ctypes.c_uint64), ('sample_type', ctypes.c_uint64), ('read_format', ctypes.c_uint64),
        ('flags', ctypes.c_uint64), ('rest', ctypes.c_uint8 * 80),
    ]


def close(fds):
    for fd in fds.values():
        if fd is not None:
            os.close(fd)


class Counters:
    def __init__(self):
        self.lock = threading.Lock()
        self.threads = {}  # tid: (pid, {event: fd})
        self.exited = {}  # pid: [{event: fd}] of its threads that exited
        self.flags = EXCLUDE_HV
        if self.open_counter(os.getpid(), 'instructions') is None:
            self.flags |= EXCLUDE_KERNEL
            if self.open_counter(os.getpid(), 'instructions') is None:
                sys.exit(f'perf_event_open failed: {os.strerror(ctypes.get_errno())}')
            print('proc_usage_linux: user-space instructions only (no CAP_PERFMON)', file=sys.stderr, flush=True)

    def open_counter(self, tid, event):
        attr = Attr(type=PERF_TYPE_HARDWARE, size=128, config=CONFIG[event], read_format=FORMAT, flags=self.flags)
        fd = LIBC.syscall(SYSCALL, ctypes.byref(attr), tid, -1, -1, 0)
        return fd if fd >= 0 else None

    def attach(self):
        """Opens counters on new threads. An exited thread's counters keep its final count while its process lives;
        a process that exited takes its counters with it, as on macOS."""
        with self.lock:
            live = {}  # tid: pid
            for name in os.listdir('/proc'):
                if not name.isdigit():
                    continue
                try:
                    for tid in os.listdir(f'/proc/{name}/task'):
                        live[int(tid)] = int(name)
                except OSError:
                    continue
            alive = set(live.values())
            for tid, (pid, fds) in list(self.threads.items()):
                if live.get(tid) != pid:
                    del self.threads[tid]
                    if pid in alive:
                        self.exited.setdefault(pid, []).append(fds)
                    else:
                        close(fds)
            for pid in [pid for pid in self.exited if pid not in alive]:
                for fds in self.exited.pop(pid):
                    close(fds)
            for tid, pid in live.items():
                if tid in self.threads:
                    continue
                fds = {event: self.open_counter(tid, event) for event in CONFIG}
                if None in fds.values():
                    close(fds)
                    continue
                self.threads[tid] = (pid, fds)

    def by_process(self):
        """pid: {event: count}, its threads summed, the exited ones too."""
        totals = {}
        with self.lock:
            pairs = [(pid, fds) for pid, fds in self.threads.values()]
            pairs += [(pid, fds) for pid, list_ in self.exited.items() for fds in list_]
            for pid, fds in pairs:
                entry = totals.setdefault(pid, dict.fromkeys(CONFIG, 0))
                for event, fd in fds.items():
                    value, enabled, running = struct.unpack('QQQ', os.read(fd, 24))
                    entry[event] += value * enabled // running if running else 0
        return totals

    def poll_forever(self):
        while True:
            try:
                self.attach()
            except Exception as error:  # noqa: BLE001 - keep counting; report and go on
                print(f'proc_usage_linux: {error!r}', file=sys.stderr, flush=True)
            time.sleep(POLL_SECONDS)


def processes():
    """pid: (ppid, CPU seconds, kind)."""
    table = {}
    for name in os.listdir('/proc'):
        if not name.isdigit():
            continue
        try:
            with open(f'/proc/{name}/stat') as file:
                stat = file.read()
            with open(f'/proc/{name}/cmdline', 'rb') as file:
                command = file.read().split(b'\0')
        except OSError:
            continue
        # comm, field 2, may hold spaces: the fields after it start after its closing parenthesis
        fields = stat[stat.rindex(')') + 2:].split()
        table[int(name)] = (int(fields[1]), (int(fields[11]) + int(fields[12])) / CLOCK_TICKS,
                            command_kind([part.decode(errors='replace') for part in command if part]))
    return table


def command_kind(command):
    """postgres: backend for a client connection, else its title (autovacuum worker, checkpointer...)."""
    text = ' '.join(command)
    if text.startswith('postgres: '):
        title = text[len('postgres: '):]
        return 'backend' if '(' in title else title.split(' process')[0]
    return command[0].rsplit('/', 1)[-1] if command else '?'


def tree(root, table):
    found = {root}
    changed = True
    while changed:
        changed = False
        for pid, (ppid, *_) in table.items():
            if ppid in found and pid not in found:
                found.add(pid)
                changed = True
    return found


def snapshot(counters, specs):
    counters.attach()
    table = processes()
    counts = counters.by_process()
    result = {}
    for label, spec in specs.items():
        root = int(spec.rstrip('+'))
        pids = tree(root, table) if spec.endswith('+') else {root}
        pids = {pid for pid in pids if pid in table}
        by_command = {}
        for pid in pids:
            value = counts.get(pid, dict.fromkeys(CONFIG, 0))
            entry = by_command.setdefault(table[pid][2], [0, 0, 0.0])
            entry[0] += value['instructions']
            entry[1] += value['cycles']
            entry[2] += table[pid][1]
        result[label] = {
            'instructions': sum(entry[0] for entry in by_command.values()),
            'cycles': sum(entry[1] for entry in by_command.values()),
            'cpuSeconds': sum(table[pid][1] for pid in pids),
            'byCommand': by_command,
        }
    return result


def main():
    # A counter per event and thread: PostgreSQL servers with their backends, and Node.js threads, add up
    _, hard = resource.getrlimit(resource.RLIMIT_NOFILE)
    resource.setrlimit(resource.RLIMIT_NOFILE, (hard, hard))
    counters = Counters()
    counters.attach()
    threading.Thread(target=counters.poll_forever, daemon=True).start()
    print(json.dumps({'ready': True}), flush=True)
    for line in sys.stdin:
        request = json.loads(line)
        print(json.dumps({'id': request['id'], 'result': snapshot(counters, request['processes'])}), flush=True)


main()
