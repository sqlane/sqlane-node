---
'@sqlane/core': patch
---

Fix: in a turn with both lanes with global limits and plain lanes, equal shares no longer go the same way every turn.
The plan and both claims break their ties from one pointer, and the pointer moves once per turn. Before, with
`localMaxConcurrency: 1`, a lane with global limits and a plain lane, both backlogged, did not alternate: one of them
starved.
