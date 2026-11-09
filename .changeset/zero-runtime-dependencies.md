---
"@sqlane/core": major
---

Remove all runtime npm dependencies by internalizing monotonic ULID generation and duration parsing.

Duration strings now require explicit lowercase short units in descending order (`w`, `d`, `h`, `m`, `s`, `ms`), each at most once. Spaces may separate components: `1h 1m 1s` and `1d1h1ms` are valid. Full names (`2 days`), reversed or repeated units (`1ms 1d`, `1s 2s`), inferred units, clock notation, signs, exponents and extraneous text are rejected. Replace full names with short units and reorder components before upgrading. Numeric safe integer milliseconds and fractional string quantities remain supported.

Generated job IDs and internal tokens retain the 26-character ULID format; no database migration is required.
