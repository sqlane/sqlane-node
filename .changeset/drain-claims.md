---
'@sqlane/core': patch
---

Drain a backlog over many job names much faster: 10,000 due jobs over 1000 names, 8 slots and empty handlers, from
18.6 s to 1.4 s on PostgreSQL, 258 s to about 5 s on MySQL and 175 s to 16 s on MariaDB, with 90 to 98% less CPU per
job.

- A claim requested every due job name and locked up to the free slots of each: with 1000 due names, thousands of rows
  to start a few jobs. It now requests at most 4 names per free slot, the next names at the next turn, and a full claim
  no longer reads the next due time of each name.
- The first completion write waits for one turn of the event loop: the jobs whose handlers finish in it, such as those
  whose I/O completes in the same poll, are completed in one write, and their slots free together for one claim. In a
  drain on MariaDB with handlers that hash and read a file: a third fewer commits per job and about 20% less time,
  which matters where a commit waits for the disk.
