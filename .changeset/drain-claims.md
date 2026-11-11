---
'@sqlane/core': patch
---

Drain a backlog over many job names about 10 times faster, with about 90% less CPU. A claim requested every due job
name and locked up to the free slots of each: with 1000 due names, thousands of rows to start a few jobs. It now
requests at most 4 names per free slot, the next names at the next turn, and a full claim no longer reads the next due
time of each name.
