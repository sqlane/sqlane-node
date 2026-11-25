# Guide for writing user-facing API docs

Applies to `docs/api.md`. Every agent or human who edits it follows these rules.

**Reader:** an app developer who uses `@sqlane/core`. They know JavaScript, TypeScript and SQL. They do not know how
sqlane works inside, and they do not need to.

## Rules

1. **Contract only.** Document what a caller can see and rely on: signatures, options, defaults, return values,
   errors, events, guarantees and limits. Test for each detail: if sqlane changed it in a patch release, would a
   user's code or expectations break? If not, it is internal: put it in [`design.md`](../design.md) and link it. This
   covers queries, locks, indexes, driver error codes, storage formats and cost formulas.
2. **Current version only.** Describe the API as it is today. Assume the user runs the latest version with every
   migration applied. History, renames, upgrade steps and migration requirements go in `docs/migrations/<major>.md`
   and `CHANGELOG.md`.
3. **Self-explaining terms.** Prefer words that explain themselves: "the time at which a job may start", not "due
   time". When a term needs a definition, give it where the term first appears. The Glossary of `api.md` holds only
   sqlane's own words that no plain phrase replaces, such as lane. Keep it as short as possible. Use each
   term with one meaning, the same way every time.
4. **Fixed section template.** Each method's section has these parts, in this order, and skips the empty ones:
   one-sentence summary → signature → parameters table → return value → errors → notes → example.
5. **One-sentence table cells.** Put longer explanations in the notes under the table.
6. **Short, direct sentences.** One idea per sentence, at most about 25 words. Use active voice and the present
   tense, and make the actor the subject: "`enqueue` rejects with `PayloadTooLargeError` when …".
7. **Verified against the code.** Check every option, default, field, error and event name against `src/` and
   `types/sqlane.d.ts`, not against older doc text. Every example uses the current API exactly and would pass a
   typecheck.
8. **Stable links.** Code and other docs link to headings in `api.md` (from `README.md`, `types/sqlane.d.ts`,
   `src/` and `docs/`). After you rename or remove a heading, run `grep -rn "api.md#" --exclude-dir=node_modules .`
   and update every link that broke.

## General terms

| Term            | Meaning                                      |
| --------------- | -------------------------------------------- |
| sqlane          | The library                                  |
| sqlane instance | The object that `createSqlane` returns.      |
| sqlane runner   | The object that `createRunner` returns.      |
| user            | The reader: the developer who calls the API. |
