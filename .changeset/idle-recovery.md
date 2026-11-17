---
'@sqlane/core': patch
---

The stall recovery, about every 30 s, starts with one read of its work: the stale jobs, and whether there are ended
lingers, orphan slots, blocked jobs or expired rate rows. Only the parts with work run, so an idle recovery is one
statement instead of 9 (PostgreSQL) or 11 (MySQL, MariaDB), with their two transactions.
