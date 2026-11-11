---
'@sqlane/core': patch
---

README: link the rebuilt comparison with other job queues. Its features are now checked by running each library
(`pnpm bench:compare`), and a new page compares the CPU cost, latency and idle cost of the queues that enqueue in
your transaction.
