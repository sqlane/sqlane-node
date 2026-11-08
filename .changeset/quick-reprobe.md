---
'@sqlane/core': patch
---

Start a job within milliseconds of its commit under steady traffic too. An enqueue made while the re-probes of an
earlier one were running waited for their late steps (up to 1 s); now each enqueue restarts the re-probes. A
PostgreSQL NOTIFY now wakes the workers at once, with no re-probe.
