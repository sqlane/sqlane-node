# Changesets

Each pull request that changes the published package adds a changeset: `pnpm changeset`. A changeset is a Markdown file
with the bump type (`patch`, `minor`, `major`) and the text of the release note.

The text of the changesets is the changelog and the GitHub release: write it for the users of the package.

- What changed, from the user's point of view, in one or two sentences.
- For a breaking change: what breaks and how to migrate.
- Until 1.0, a breaking change is a `minor` bump.

Pull requests that do not change what the package publishes need no changeset: tests, CI, docs, dev dependencies, the
lockfile. CI checks it (`scripts/check_changeset.js`): `src/` without the tests, `README.md`, `LICENSE`, and
`package.json` without `devDependencies`.

See [the release process](../docs/releasing.md).
