# Releasing

1. Each pull request that changes a package (its `src/`, `package.json`, `README.md`, `LICENSE`) adds a changeset:
   `pnpm changeset`. Its text is the release note. The packages are in one fixed group: they release together, with
   one version.
2. A merge to `main` creates or updates the pull request `chore(release): version packages`, as the GitHub App of the
   repository: CI runs on it (a pull request of `GITHUB_TOKEN` starts no workflows).
3. To release: review and merge that pull request.
4. Run the `Release` workflow: `gh workflow run release.yml --ref main` (or Actions → Release → Run workflow).
5. Approve the `npm` deployment in the run. npm shows the version a few minutes later.

Pre-releases: `pnpm changeset pre enter next` (versions `x.y.z-next.N`, npm tag `next`), `pnpm changeset pre exit`.

Test a build in an app without publishing: `pnpm pack` in `packages/<name>`, then
`pnpm add /path/to/sqlane-<name>-<version>.tgz`.

A new package: publish a placeholder version by hand once (`0.0.0-stage`, `npm publish --tag stage`), then add the
trusted publisher on npmjs.com (repository `sqlane/sqlane-node`, workflow `release.yml`, environment `npm`), and add the
package to the `fixed` group of `.changeset/config.json`.

## The GitHub App of the Version Packages pull request

Set up once, by an owner of the organization:

1. Organization settings → Developer settings → GitHub Apps → New GitHub App: name `sqlane-release`, no webhook
   (uncheck Active), repository permissions **Contents: Read and write** and **Pull requests: Read and write**, nothing
   else; only on this account.
2. In the App: note its **Client ID**, generate a **private key** (a `.pem` file).
3. Install the App on the organization, for the repository `sqlane/sqlane-node` only.
4. Repository settings → Environments → New environment `release-pr`: deployment branches **Selected branches**, `main`
   only. Add the variable `RELEASE_APP_CLIENT_ID` (the Client ID) and the secret `RELEASE_APP_PRIVATE_KEY` (the whole
   `.pem` file). Then delete the `.pem` file.

The `version` job of `release.yml` mints a token of the App for one job: it expires after an hour at most.
