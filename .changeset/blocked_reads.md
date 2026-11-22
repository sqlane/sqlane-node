---
'@sqlane/core': patch
---

On MySQL and MariaDB, the reads of the jobs blocked on a key no longer grow with the number of blocked jobs. On MySQL
8.4, the unblock of a concurrency key and the search of candidates with global rate limits sorted every job blocked on
the key to find the oldest one, at each claim and completion; and the recovery sweep read every blocked job, on MySQL
and MariaDB, to list the blocked keys. Each now reads a few index entries: about 4,000 → under 50 with 2,000 jobs
blocked on a key.
