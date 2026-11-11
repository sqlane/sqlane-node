#!/usr/bin/env python3
"""The CPU counters of processes, macOS: instructions retired and cycles (proc_pid_rusage, RUSAGE_INFO_V4), CPU time
(ps). A process of your own needs no root.

Usage: proc_usage.py <label>=<pid>[+] ...   '+': with its descendants (the processes of a PostgreSQL server).
Prints {label: {"instructions": n, "cycles": n, "cpuSeconds": s, "byCommand": {...}}} as JSON: byCommand splits a
tree by process title (a PostgreSQL backend, autovacuum, the checkpointer...). A process that exited counts as zero.
"""
import ctypes
import json
import subprocess
import sys

LIBPROC = ctypes.CDLL('/usr/lib/libproc.dylib')
RUSAGE_INFO_V4 = 4


class RusageInfoV4(ctypes.Structure):
    # ri_uuid, then 36 uint64 fields; ri_instructions and ri_cycles are the 30th and 31st
    _fields_ = [('uuid', ctypes.c_uint8 * 16)] + [(f'field{i}', ctypes.c_uint64) for i in range(36)]


def counters(pid):
    info = RusageInfoV4()
    if LIBPROC.proc_pid_rusage(pid, RUSAGE_INFO_V4, ctypes.byref(info)) != 0:
        return 0, 0
    return info.field29, info.field30


def seconds(text):
    """ps time: [dd-][hh:]mm:ss.cc"""
    days, _, text = text.rpartition('-')
    total = 0.0
    for part in text.split(':'):
        total = total * 60 + float(part)
    return total + int(days or 0) * 86400


def processes():
    rows = subprocess.run(['ps', '-A', '-o', 'pid=,ppid=,time=,command='], capture_output=True, text=True,
                          check=True).stdout
    table = {}
    for row in rows.splitlines():
        pid, ppid, time, *command = row.split()
        table[int(pid)] = (int(ppid), seconds(time), command_kind(command))
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


def main():
    table = processes()
    result = {}
    for arg in sys.argv[1:]:
        label, spec = arg.split('=')
        root = int(spec.rstrip('+'))
        pids = tree(root, table) if spec.endswith('+') else {root}
        values = {pid: counters(pid) for pid in pids}
        by_command = {}
        for pid, (instructions, cycles) in values.items():
            entry = by_command.setdefault(table[pid][2] if pid in table else '?', [0, 0, 0.0])
            entry[0] += instructions
            entry[1] += cycles
            entry[2] += table[pid][1] if pid in table else 0
        result[label] = {
            'instructions': sum(value[0] for value in values.values()),
            'cycles': sum(value[1] for value in values.values()),
            'cpuSeconds': sum(table[pid][1] for pid in pids if pid in table),
            'byCommand': by_command,
        }
    print(json.dumps(result))


main()
