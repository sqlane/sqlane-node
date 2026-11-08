---
'@sqlane/core': patch
---

Complete the finished jobs of a process in batches: one transaction for the jobs that finish during the previous
write. 2–3× the jobs per second for short jobs.
