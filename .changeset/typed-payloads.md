---
'@sqlane/core': minor
---

Typed payloads, optional: `defineJob<{ reportId: string }>(…)` (or the JSDoc type `JobDefinition<{ reportId: string }>`)
declares the payload of a job. `enqueue` and `enqueueMany` then check the payload against it, and the handler's
`payload` and the argument of `mutexKeys` have its type. A definition without one, and a job by name, work as before:
any JSON payload, `any` in the handler. `JobOptions`, `JobDefinition`, `Handler` and `HandlerContext` take the payload
as an optional type parameter.
