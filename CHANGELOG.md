# @sqlane/core

## 0.0.2

### Patch Changes

- [#7](https://github.com/sqlane/sqlane-node/pull/7) [`46010b7`](https://github.com/sqlane/sqlane-node/commit/46010b7d6471d2fba61774185d6de6562c0a0327) Thanks [@KlimPal](https://github.com/KlimPal)! - Add the public API as typed stubs: `createSqlane`, `defineJob`, `getMigrations`, the error classes, and the
  `@sqlane/core/mysql2` and `@sqlane/core/pg` adapters. The methods throw "not implemented" until the implementation lands.

## 0.0.1

### Patch Changes

- [#2](https://github.com/sqlane/sqlane-node/pull/2) [`bd16a88`](https://github.com/sqlane/sqlane-node/commit/bd16a889b6f8c5abe0e8e928adadd32f88af1cca) Thanks [@KlimPal](https://github.com/KlimPal)! - First release, published by the release workflow: it checks the release pipeline (changesets, trusted publishing with
  provenance, GitHub release). The package has no API yet; [the design](https://github.com/sqlane/sqlane-node/blob/main/docs/design.md)
  describes the planned v0.1.
