---
'@sqlane/core': minor
---

Fair groups: one group with a big backlog no longer starves the other groups of its lane. A migration,
`0011_fair_groups` (tagged 10.1.0), adds the column of the group and the index of its claim; 10.1 runs on the 10.0
schema without it.
