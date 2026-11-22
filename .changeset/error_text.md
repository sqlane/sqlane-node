---
'@sqlane/core': patch
---

A job whose error has a NUL character or a lone surrogate in its name, message, stack or code is failed or retried as
any other: the write of its error was refused by the database (a NUL by PostgreSQL, a lone surrogate by all of them),
and the job hung until its lease ran out. Each such character is now stored as U+FFFD, in `lastError` and in the
payload of the failure job. The cut of a long stack no longer splits a surrogate pair.
