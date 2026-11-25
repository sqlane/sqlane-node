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
3. **One term, one meaning.** The Glossary section of `api.md` defines the project's terms. Use them exactly, and the
   same term every time. A new concept gets a glossary entry before it appears elsewhere in `api.md`. A word with
   several meanings, such as "key", "slot" or "cursor", always carries its qualifier: "dedupe key", "schedule slot",
   "page cursor".
4. **Fixed section template.** Each method's section has these parts, in this order, and skips the empty ones:
   one-sentence summary → signature → parameters table → return value → errors → notes → example.
5. **One-sentence table cells.** Put longer explanations in the notes under the table.
6. **Short, direct sentences.** One idea per sentence, at most about 25 words. Use active voice and the present
   tense, and make the actor the subject: "`enqueue` rejects with `PayloadTooLargeError` when …".
7. **Compound nouns and possessives.** Write "the migrations table" and "the lane's handler", not "the table of the
   migrations" or "the handler of the lane".
8. **Each fact in one place.** Other sections link to it instead of repeating it. The Errors section defines each
   error class; a method's errors list says only which classes it throws, and when.
9. **Verified against the code.** Check every option, default, field, error and event name against `src/` and
   `types/sqlane.d.ts`, not against older doc text. Every example uses the current API exactly and would pass a
   typecheck.
10. **Stable links.** Code and other docs link to headings in `api.md` (from `README.md`, `types/sqlane.d.ts`,
    `src/` and `docs/`). After you rename or remove a heading, run `grep -rn "api.md#" --exclude-dir=node_modules .`
    and update every link that broke.
11. **Fixed phrase for a union that may grow:** "New values may appear in a minor version; handle unknown ones."

## General terms

| Term     | Meaning                                                                               |
| -------- | ------------------------------------------------------------------------------------- |
| sqlane   | The library, in plain text.                                                           |
| `sqlane` | The object that `createSqlane` returns, in code font. Not "the sqlane" or "instance". |
| `runner` | The object that `createRunner` returns, in code font.                                 |
| user     | The reader: the developer who calls the API. Not their app's end users.               |

## Before you finish

- Run `grep -nwE "key|keys|slot|slots|cursor|instance" docs/api.md`. Every hit is a glossary term, a code identifier,
  or qualified as the `api.md` glossary says.
- Every section you touched follows rules 1–11.
