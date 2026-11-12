---
'@sqlane/core': patch
---

README: the performance chart and the comparison table include Boring Node Queue and Izi Queue, and the chart BullMQ
and Sidequest too. The other queues that enqueue in your transaction use about 1.7–6.2× as many CPU instructions per job
as sqlane on PostgreSQL. Two exceptions: BullMQ on Redis uses 1.3×, but enqueues outside your transaction; on MySQL,
Izi Queue uses about a third fewer than sqlane. pg-boss's 1000 idle queues take about 4% of a core, not a quarter.
