---
'@sqlane/core': patch
---

`defineJob()` checks its options and throws a `ConfigError` for a bad name, an unknown option, or a bad
`maxAttempts`, `maxStalls`, `backoff`, `retention`, `timeout`, `mutexKeys` or `failureJob`.
