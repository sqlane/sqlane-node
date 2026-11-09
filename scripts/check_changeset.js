// The changeset check of CI: a pull request that changes what a package publishes adds a changeset for it. What it
// publishes: `src/` without the tests, `README.md`, `LICENSE`, and `package.json` without `devDependencies`. So an
// update of dev dependencies, of the lockfile or of tests needs none.
// Usage: node scripts/check_changeset.js <base ref>, e.g. origin/main.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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
 * @returns {Record<string, unknown> | null} The manifest at the ref, without `devDependencies`; null: none there.
 */
function publishedManifest(path, ref) {
    let text;

    try {
        text = ref ? git('show', `${ref}:${path}`) : readFileSync(path, 'utf8');
    } catch {
        return null;
    }

    const { devDependencies: _devDependencies, ...manifest } = JSON.parse(text);

    return manifest;
}

/**
 * @param {string} file A path in the package.
 * @returns {boolean} The file is in the package on npm.
 */
function isPublishedFile(file) {
    return (file.startsWith('src/') && !file.endsWith('.test.js')) || file === 'README.md' || file === 'LICENSE';
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
const missing = [];

for (const dir of readdirSync('packages')) {
    const manifestPath = `packages/${dir}/package.json`;
    const manifest = publishedManifest(manifestPath, '');

    if (!manifest || manifest.private) {
        continue;
    }

    const files = changed.filter(file => file.startsWith(`packages/${dir}/`)).map(file => file.slice(dir.length + 10));
    const reasons = files.filter(isPublishedFile);

    if (files.includes('package.json') && !isDeepStrictEqual(manifest, publishedManifest(manifestPath, mergeBase))) {
        reasons.push('package.json (not only devDependencies)');
    }

    if (reasons.length > 0 && !released.has(String(manifest.name))) {
        missing.push(`${manifest.name}: ${reasons.join(', ')}`);
    }
}

if (missing.length > 0) {
    process.stderr.write(`A change of published files without a changeset (pnpm changeset):\n${
        missing.map(line => `  ${line}\n`).join('')
    }`);
    process.exitCode = 1;
} else {
    process.stdout.write('Changesets: ok\n');
}
