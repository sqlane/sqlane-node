---
'@sqlane/core': minor
---

An adapter can tell when the transaction of an enqueue commits (`afterCommit`): the processes wake at once after the
commit, and still re-probe after it. With `mysql2Adapter` and `pgAdapter`, an enqueue on a pool wakes at once. The
hint of an enqueue in a transaction of an ORM adapter is sent after the commit.
