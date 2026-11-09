// The changeset check of CI: a pull request that changes what the package publishes adds a changeset. What it
// publishes: `src/` without the tests, `types/`, `README.md`, `LICENSE`, and `package.json` without `devDependencies`
// and `scripts`. So an update of dev dependencies, of the lockfile, of tests or of tooling needs none.
// Usage: node scripts/check_changeset.js <base ref>, e.g. origin/main.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';

/**
 * @param {...string} args
 * @returns {string}
 */
function git(...args) {
    return execFileSync('git', args, { encoding: 'utf8' });
}

/**
 * @param {string} path
 * @param {string} ref
 * @returns {Record<string, unknown> | null} The manifest at the ref, without `devDependencies` and `scripts`; null:
 *     none there.
 */
function publishedManifest(path, ref) {
    let text;

    try {
        text = ref ? git('show', `${ref}:${path}`) : readFileSync(path, 'utf8');
    } catch {
        return null;
    }

    const { devDependencies: _devDependencies, scripts: _scripts, ...manifest } = JSON.parse(text);

    return manifest;
}

/**
 * @param {string} file A path in the repository.
 * @returns {boolean} The file is in the package on npm.
 */
function isPublishedFile(file) {
    return (file.startsWith('src/') && !file.endsWith('.test.js')) || file.startsWith('types/')
        || file === 'README.md' || file === 'LICENSE';
}

/**
 * @param {string} text The text of a changeset.
 * @returns {string[]} The packages that it releases (its front matter).
 */
function packagesOf(text) {
    const frontMatter = /^---\n([\s\S]*?)\n---/u.exec(text)?.[1] ?? '';

    return [...frontMatter.matchAll(/^\s*["']?([^"':\s]+)["']?\s*:/gmu)].map(match => match[1]);
}

const base = process.argv[2];

if (!base) {
    throw new Error('Usage: node scripts/check_changeset.js <base ref>');
}

const mergeBase = git('merge-base', base, 'HEAD').trim();
const changed = git('diff', '--name-only', mergeBase, 'HEAD').split('\n').filter(Boolean);
const released = new Set(
    changed
        .filter(file => /^\.changeset\/[^/]+\.md$/u.test(file) && file !== '.changeset/README.md')
        .flatMap((file) => {
            try {
                return packagesOf(readFileSync(file, 'utf8'));
            } catch {
                return []; // deleted
            }
        }),
);
const manifest = publishedManifest('package.json', '');
const reasons = changed.filter(isPublishedFile);

if (changed.includes('package.json') && !isDeepStrictEqual(manifest, publishedManifest('package.json', mergeBase))) {
    reasons.push('package.json (not only devDependencies or scripts)');
}

const missing = reasons.length > 0 && manifest && !released.has(String(manifest.name))
    ? [`${manifest.name}: ${reasons.join(', ')}`]
    : [];

if (missing.length > 0) {
    process.stderr.write(`A change of published files without a changeset (pnpm changeset):\n${
        missing.map(line => `  ${line}\n`).join('')
    }`);
    process.exitCode = 1;
} else {
    process.stdout.write('Changesets: ok\n');
}
