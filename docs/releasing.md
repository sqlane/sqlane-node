# Releasing

Releases use [Changesets](https://changesets.dev) and the `Release` workflow (`.github/workflows/release.yml`).
npm gets the package by trusted publishing (no npm token), with provenance.

## 1. Changesets in pull requests

A pull request that changes the published files (`src/`, `package.json`, `README.md`, `LICENSE`) adds a changeset:

```sh
pnpm changeset
```

The text of the changesets becomes `CHANGELOG.md` and the GitHub release: write it for the users of the package. See
[`.changeset/README.md`](../.changeset/README.md). The `Changeset` job of CI fails without one. A pull request that
changes these files but needs no release adds an empty changeset: `pnpm changeset --empty`.

## 2. The Version Packages pull request

After a merge to `main` with changesets, the `Release` workflow creates or updates the pull request
`chore(release): version packages`. It bumps the version, writes `CHANGELOG.md` and deletes the changesets.

- Review it like code: the changelog text is the release note. Edit it in the pull request if needed.
- CI does not start by itself on this pull request (GitHub does not run workflows for pull requests created by
  `GITHUB_TOKEN`). The publish job runs the tests again.
- Merge it when you want to release.

## 3. Publish

GitHub → Actions → `Release` → **Run workflow** on `main`. The workflow:

1. checks that there is something to publish (the Version Packages pull request is merged),
2. runs the tests and publint, packs the package,
3. waits for the approval of the `npm` environment,
4. publishes to npm, creates the git tag and the GitHub release with the changelog of the version.

## Pre-releases (alpha, beta, rc)

```sh
pnpm changeset pre enter next   # in a pull request; then versions are x.y.z-next.N
pnpm changeset pre exit         # in a pull request, before the stable release
```

In pre mode, the release flow is the same. npm publishes the versions under the dist-tag `next`:
`npm i @sqlane/core` keeps the stable version, testers use `npm i @sqlane/core@next`.

Everything published on npm is public and permanent: a version number cannot be reused, also after an unpublish.

## Test a build in an app, without publishing

```sh
pnpm pack                                   # in this repository: sqlane-core-<version>.tgz
pnpm add /path/to/sqlane-core-<version>.tgz # in the app
```

This installs exactly the files that npm would publish.

## One-time setup

- **GitHub** → Settings → Actions → General: enable "Allow GitHub Actions to create and approve pull requests".
- **GitHub** → Settings → Environments → `npm`: required reviewers (the maintainers), deployment branch `main` only.
- **npm** → `@sqlane/core` → Settings → Trusted publishing → GitHub Actions: organization `sqlane`, repository
  `sqlane-node`, workflow `release.yml`, environment `npm`. Then Publishing access: "Require two-factor
  authentication and disallow tokens".
