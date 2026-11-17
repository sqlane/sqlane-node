# Changesets

Each pull request that changes the published package adds a changeset: `pnpm changeset`. A changeset is a Markdown file
with the bump type (`patch`, `minor`, `major`) and the text of the release note.

The text of the changesets is the changelog and the GitHub release: write it for the users of the package.

- Start with what changed, from the user's point of view, in one sentence. Details follow.
- A breaking change is a `major` bump. Say what breaks and how to migrate, and add or extend the migration guide of
  that major version, `docs/migrations/<major>.md`.

Pull requests that do not change what the package publishes need no changeset: tests, CI, docs, dev dependencies, the
lockfile. CI checks it (`scripts/check_changeset.js`): `src/` without the tests, `types/`, `README.md`, `LICENSE`, and
`package.json` without `devDependencies` and `scripts`.

See [the release process](../docs/contributing/releasing.md).
