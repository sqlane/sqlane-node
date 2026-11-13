# Migrating from 4.x to 5.0

sqlane 5.0 shares the free slots of a process between job names by weight, and replaces lanes with concurrency
groups. There is no schema change, so no database migration.

| 4.x                                                                                               | 5.0                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createSqlane({ concurrency: 10 })`                                                               | `createSqlane({ maxConcurrency: 10 })`                                                                                                                                          |
| `createSqlane({ lanes: { heavy: { concurrency: 2 } } })` and `handle(x, fn, { lane: 'heavy' })`   | `const heavy = defineConcurrencyGroup({ name: 'heavy', maxConcurrency: 2 })` and `handle(x, fn, { concurrencyGroup: heavy })`                                                   |
| `handle(x, fn, { concurrency: 1 })`                                                               | `handle(x, fn, { maxConcurrency: 1 })`                                                                                                                                          |
| `lane` and `concurrency` could not be combined                                                    | `concurrencyGroup` and `maxConcurrency` combine                                                                                                                                 |
| A handler `concurrency` or a lane above the process `concurrency` was capped silently             | **A `ConfigError` at `start()` and `drain()`** that names the handler or group and both numbers. Lower the cap, or raise the instance's `maxConcurrency`                        |
| `Sqlane<C, L>`, `SqlaneOptions<C, L>`, `HandleOptions<L>`, `LaneOptions`, `createSqlane<C, L>(…)` | `Sqlane<C>`, `SqlaneOptions<C>`, `HandleOptions`, `createSqlane<C>(…)`; `LaneOptions` is gone                                                                                   |
| The internal store typedefs `DueRequest.lane`, `ClaimDueParams.laneFree` and `processMax`         | Removed, for code that imported them from `types/store`                                                                                                                         |
| Across names, the oldest due job started first                                                    | Free slots are shared by `fairShareWeight` (default 1: equal shares). FIFO within a name and per mutex key is kept. A name woken by the release of a key is no longer preferred |
| `drain()` errors began with `drain:`                                                              | They begin with `drain():`, as `start():` does                                                                                                                                  |

The old options throw a `ConfigError` that names the new one, so a missed change fails at startup:

- `createSqlane: "concurrency" is now "maxConcurrency" (5.0)`;
- `createSqlane: "lanes" was removed in 5.0: define groups with defineConcurrencyGroup() and pass them to handle() as
  "concurrencyGroup"`;
- `handle("x"): "concurrency" is now "maxConcurrency" (5.0)`;
- `handle("x"): "lane" was removed in 5.0: use "concurrencyGroup"`.

## An example

4.x:

```js
const sqlane = createSqlane({ adapter, concurrency: 10, lanes: { heavy: { concurrency: 2 } } });

sqlane.handle(transcode, work, { lane: 'heavy' });
sqlane.handle(render, work, { lane: 'heavy' });
sqlane.handle(sendEmail, send, { concurrency: 4 });
```

5.0:

```js
import { createSqlane, defineConcurrencyGroup } from '@sqlane/core';

export const heavy = defineConcurrencyGroup({ name: 'heavy', maxConcurrency: 2 }); // at module level, like defineJob

const sqlane = createSqlane({ adapter, maxConcurrency: 10 });

sqlane.handle(transcode, work, { concurrencyGroup: heavy });
sqlane.handle(render, work, { concurrencyGroup: heavy });
sqlane.handle(sendEmail, send, { maxConcurrency: 4, fairShareWeight: 3 }); // optional: 3 times the share of a name of weight 1
```

## What changes at runtime

- **The order across names.** With several job names due at once, 4.x started the oldest due job first. 5.0 gives a
  free slot to the name with the lowest `running / fairShareWeight`, so a name with a big backlog no longer takes every
  slot. Within a name, jobs still start in FIFO order. See [How free slots are shared](api.md#how-free-slots-are-shared).
- **The odd remainder.** When the share of a name is not a whole number of slots, the extra slot goes by ties, which
  favors names with long jobs. The error stays below one slot.
- **Mutex keys.** The FIFO per key is the same. A name woken by the release of a key competes by its share.
- **Performance.** A claim makes the same statements as in 4.x: one claim statement (PostgreSQL) or transaction
  (MySQL, MariaDB) per turn, and the same 4 names per free slot.
