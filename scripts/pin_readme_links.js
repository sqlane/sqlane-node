// The README on npm links to the docs of its own version. The README on main links to `main`, and npm shows the README
// of the published tarball: without this, the README of 7.0.0 on npm would send its readers to the docs of main.
// `prepack` points the links at the tag of the version (`v7.0.1`), or at the commit for a prerelease (a preview);
// `postpack` puts the README back. Usage: node scripts/pin_readme_links.js prepack | postpack
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';

const REPOSITORY = 'sqlane/sqlane-node';
const README = 'README.md';
/** The README as it is in git, during a pack. In `node_modules`: npm never packs it (it packs any `README*` file) */
const BACKUP_DIR = 'node_modules/.cache/sqlane';
const BACKUP = `${BACKUP_DIR}/README.md`;

/**
 * @param {string} version The version of the package.
 * @param {string} commit The commit that is packed.
 * @returns {string} The tag of a release (`v7.0.1`); the commit of a prerelease, which has no tag.
 */
export function refOf(version, commit) {
    return /^\d+\.\d+\.\d+$/u.test(version) ? `v${version}` : commit;
}

/**
 * @param {string} text The README.
 * @param {string} ref A tag or a commit.
 * @returns {string} The README whose links to the files of `main` point at the ref. The CI badge keeps `main`.
 */
export function pinLinks(text, ref) {
    return text
        .replaceAll(`github.com/${REPOSITORY}/blob/main/`, `github.com/${REPOSITORY}/blob/${ref}/`)
        .replaceAll(`github.com/${REPOSITORY}/tree/main/`, `github.com/${REPOSITORY}/tree/${ref}/`)
        .replaceAll(`raw.githubusercontent.com/${REPOSITORY}/main/`, `raw.githubusercontent.com/${REPOSITORY}/${ref}/`);
}

function restore() {
    if (existsSync(BACKUP)) {
        renameSync(BACKUP, README);
    }
}

function prepack() {
    // A pack that failed before its postpack: the README is the pinned one
    restore();

    const text = readFileSync(README, 'utf8');
    const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    mkdirSync(BACKUP_DIR, { recursive: true });
    writeFileSync(BACKUP, text);
    writeFileSync(README, pinLinks(text, refOf(version, commit)));
}

if (process.argv[1] === import.meta.filename) {
    const command = process.argv[2];

    if (command === 'prepack') {
        prepack();
    } else if (command === 'postpack') {
        restore();
    } else {
        throw new Error('usage: node scripts/pin_readme_links.js prepack | postpack');
    }
}
