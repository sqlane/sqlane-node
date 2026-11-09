---
'@sqlane/core': minor
---

Sequelize with CLS: `enqueue(sequelize, …)` inside a CLS transaction joins it, as the queries of Sequelize do. Before,
it ran in a transaction of its own: the job committed even when the app's transaction rolled back.
