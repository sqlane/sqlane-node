---
'@sqlane/core': patch
---

Internal: the runner is split into modules (the dispatcher, the job runs, the unblocks of keys, the leases, the
maintenance and the local limits). No change of behaviour or API.
