---
'@sqlane/core': patch
---

Docs: the README's performance table and the performance comparison are measured again with sqlane 10.1.1, where they
showed 7.0.0: 3.3 M instructions per job (was 3.1 M), 2,700 jobs per second for one worker (was 2,810), the same 3.0
statements per job and 4 / 5 ms from enqueue to start. The throughput and the schedules are now the medians of 3 runs.
