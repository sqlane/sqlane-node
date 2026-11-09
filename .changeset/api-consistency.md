---
'@sqlane/core': minor
---

Breaking: `wake()` takes no job name. It always checked all the names that the process handles, so a name had no effect.
JavaScript calls that still pass a name keep working; TypeScript reports them.

The `stalled` and `failed` events of stall recovery now have the attempt of the run that stalled, instead of `0`. The
`failed` event also has the time since that run started as `durationMs`.

`FailedJobPayload.error` now lists `code`: the string `code` of the thrown error, if it had one.

`close()` now logs a warning for every invalid option, including an unknown one, and uses its default. Before, an invalid
`deadline` or `mode` silently became the default. `close()` still never rejects because of its options.
