# @sqlane/adapter-knex

## 0.2.0

### Minor Changes

- [#32](https://github.com/sqlane/sqlane-node/pull/32) [`746ecac`](https://github.com/sqlane/sqlane-node/commit/746ecaceb73fef34f2f80aef4072d0469524e3bc) - New package: the knex adapter. `enqueue` takes a knex instance (a transaction of its own) or a knex transaction, also
  a nested one. The workers wake at once after the commit of the outermost transaction. knex 3, with `mysql2` or `pg`.

### Patch Changes

- Updated dependencies [[`746ecac`](https://github.com/sqlane/sqlane-node/commit/746ecaceb73fef34f2f80aef4072d0469524e3bc)]:
    - @sqlane/core@0.2.0
