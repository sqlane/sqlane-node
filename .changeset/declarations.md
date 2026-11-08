---
'@sqlane/core': patch
---

TypeScript declarations: the package ships `types/*.d.ts`, generated from its JSDoc, with a `types` condition for `.`,
`./mysql2` and `./pg`. A strict TypeScript project no longer needs `allowJs`. The `pg` adapter types come from
`@types/pg`.
