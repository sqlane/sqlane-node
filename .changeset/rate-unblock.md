---
'@sqlane/core': patch
---

The unblock of a rate key reads as many blocked jobs as its quota lets start, not up to 501: with a large backlog on a
key, it takes about 1 ms instead of tens of milliseconds.
