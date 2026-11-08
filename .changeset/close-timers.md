---
'@sqlane/core': patch
---

`close()` no longer keeps the process alive until its deadline: its timers end with it.
