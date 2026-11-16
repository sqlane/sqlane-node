---
'@sqlane/core': patch
---

MySQL and MariaDB: a worker that handles more than 100 job names no longer runs a job twice. A turn that probed more
than 100 names could request a name twice, and the claim then locked and started its due jobs twice, in the same
process. The worker now requests each name once, the store ignores a repeated name, and a job given twice by one claim
runs once, with an `error` event.
