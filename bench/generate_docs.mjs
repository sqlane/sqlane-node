// The generated parts of docs/performance_vs_other_libs.md and README.md: the charts (a light and a dark SVG each, in
// docs/images, which the documents show with <picture>) and the blocks between `<!-- generated:NAME -->` and
// `<!-- /generated:NAME -->`. The prose around the blocks is written by hand. Run: pnpm bench:generate-docs
//
// Inputs: bench/compare/results.json (the comparison, bench/compare/run.mjs), bench/regression/results.json
// (statements and instructions per operation of sqlane's hot paths, `pnpm bench:regression --save`; optional) and
// bench/compare/linux.dockerfile (the server versions).
// It writes a file only when its content changes: a second run changes nothing.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { SCENARIOS } from './regression/scenarios.mjs';

/** @typedef {Record<string, any>} Row A row of `perf` in bench/compare/results.json */

const ROOT = join(import.meta.dirname, '..');
const IMAGES = join(ROOT, 'docs/images');
/** The charts as the documents link them: GitHub serves the README's images from main too */
const RAW = 'https://raw.githubusercontent.com/sqlane/sqlane-node/main/docs/images';
const PERF_DOC = join(ROOT, 'docs/performance_vs_other_libs.md');
const README = join(ROOT, 'README.md');
/** The width of a Markdown line, as the hand-written prose: oxfmt keeps it (proseWrap: preserve) */
const WIDTH = 120;

/** The columns of the backends table */
const DIALECTS = /** @type {const} */ ([
    { dialect: 'postgres', name: 'PostgreSQL' },
    { dialect: 'mysql', name: 'MySQL' },
    { dialect: 'mariadb', name: 'MariaDB' },
]);

const compare = readJson(join(ROOT, 'bench/compare/results.json'));
const regression = readRegression(join(ROOT, 'bench/regression/results.json'));
const container = readDockerfile(join(ROOT, 'bench/compare/linux.dockerfile'));

/**
 * @param {string} file
 * @returns {any}
 */
function readJson(file) {
    return JSON.parse(readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------------------------------------------------
// Inputs

/**
 * @typedef {object} Container The versions of the image of the published runs
 * @property {string} debian
 * @property {string} postgresMajor
 * @property {string} postgres
 * @property {string} redis
 */

/**
 * @param {string} file
 * @returns {Container} from its `ARG NAME=value` lines
 */
function readDockerfile(file) {
    /** @type {Record<string, string>} */
    const args = {};

    for (const match of readFileSync(file, 'utf8').matchAll(/^ARG (\w+)=(\S+)/gmu)) {
        args[match[1]] = match[2];
    }

    /**
     * @param {string} name
     * @returns {string}
     */
    const arg = (name) => {
        if (!args[name]) {
            throw new Error(`${relative(ROOT, file)}: no ARG ${name}`);
        }

        return args[name];
    };
    /** @type {Record<string, string>} Debian's code names */
    const debian = { bookworm: '12', trixie: '13', forky: '14' };
    const codename = arg('DEBIAN_IMAGE').replace(/^debian:/u, '').replace(/-slim$/u, '');

    return {
        debian: debian[codename] ?? codename,
        postgresMajor: arg('PG_MAJOR'),
        // 17.11-1.pgdg13+2 → 17.11; 6:8.10.3-1rl1~trixie1 → 8.10.3
        postgres: arg('PG_VERSION').replace(/-.*/u, ''),
        redis: arg('REDIS_VERSION').replace(/^\d+:/u, '').replace(/-.*/u, ''),
    };
}

/**
 * @typedef {object} Regression The instructions per operation of sqlane's hot paths, from
 *     `pnpm bench:regression --save`
 * @property {string | undefined} date
 * @property {string | undefined} machine
 * @property {string[]} servers The versions of the database servers, when the file has them: "PostgreSQL 17.11"…
 * @property {boolean | undefined} kernelCounted
 * @property {Map<string, number>} instructions per `<scenario>/<dialect>`
 * @property {Map<string, number>} statements per `<scenario>/<dialect>`: of the same run, so the two go together
 */

/**
 * The reader of bench/regression/results.json, apart from the rest so that it follows the format of `--save` easily.
 * It takes either shape:
 * - `--save`'s: `{ scenarios: { <scenario>: { databases: { <db>: { instructionsPerOp } } } } }`, `<db>` such as
 *   `postgres` or `postgres-17`, a database with `error` left out; also without the `databases` level;
 * - ab.mjs's raw results: `{ comparisons: [{ scenario, dialect, instructions: { current } }] }`, the working tree.
 * Also `date`; `kernelCounted`; the machine: `machine` (a string, or `{ cpu, cores, memoryGiB, kernel }`), or `cpu`
 * and `cores` at the top; and the servers: `servers` or `versions`, `{ <db>: <SELECT version()> }`.
 * @param {string} file
 * @returns {Regression | null} null when the file doesn't exist
 */
function readRegression(file) {
    if (!existsSync(file)) {
        return null;
    }

    const data = readJson(file);
    /** @type {Map<string, number>} */
    const instructions = new Map();
    /** @type {Map<string, number>} */
    const statements = new Map();
    /**
     * @param {string} scenario
     * @param {string} db
     * @param {any} entry
     */
    const add = (scenario, db, entry) => {
        const dialect = dialectOf(db);
        const value = instructionsOf(entry);

        if (dialect && value !== undefined && !entry?.error) {
            instructions.set(`${scenario}/${dialect}`, value);

            if (typeof entry?.statementsPerOp === 'number') {
                statements.set(`${scenario}/${dialect}`, entry.statementsPerOp);
            }
        }
    };

    for (const entry of Array.isArray(data.comparisons) ? data.comparisons : []) {
        add(entry.scenario, entry.dialect, entry);
    }

    for (const [scenario, value] of Object.entries(data.scenarios ?? {})) {
        const byDb = /** @type {Record<string, any>} */ (value?.databases ?? value ?? {});

        for (const [db, entry] of Object.entries(byDb)) {
            add(scenario, db, entry);
        }
    }

    const machine = typeof data.machine === 'string' ? data.machine : machineName(data.machine ?? data);
    // `SELECT version()`: "PostgreSQL 17.11 on x86_64-pc-linux-gnu, …", "8.4.13", "11.8.9-MariaDB"
    const servers = Object.entries(data.servers ?? data.versions ?? {}).flatMap(([db, version]) => {
        const dialect = dialectOf(db);
        const name = DIALECTS.find(entry => entry.dialect === dialect)?.name;
        const number = /\d+\.\d+(?:\.\d+)?/u.exec(String(version ?? ''))?.[0];

        return name && number ? [`${name} ${number}`] : [];
    });

    return { date: data.date, machine, servers, kernelCounted: data.kernelCounted, instructions, statements };
}

/**
 * @param {any} entry
 * @returns {number | undefined} its instructions per operation
 */
function instructionsOf(entry) {
    if (typeof entry === 'number') {
        return entry;
    }

    const value = entry?.instructionsPerOp ?? entry?.instructions;

    if (typeof value === 'number') {
        return value;
    }

    return typeof value?.current === 'number' ? value.current : undefined;
}

/**
 * @param {string} db `postgres`, `postgres-18`, `mysql-8.4`, `mariadb`…
 * @returns {'postgres' | 'mysql' | 'mariadb' | undefined}
 */
function dialectOf(db) {
    const name = String(db).toLowerCase();

    if (name.startsWith('postgres') || name.startsWith('pg')) {
        return 'postgres';
    }

    if (name.startsWith('mysql')) {
        return 'mysql';
    }

    return name.startsWith('mariadb') ? 'mariadb' : undefined;
}

/**
 * @param {any} machine `{ cpu, cores, memoryGiB?, kernel? }`
 * @returns {string | undefined} "AMD Ryzen 5 3600 (6 cores, 12 threads)", with the memory and Linux when given
 */
function machineName(machine) {
    if (!machine?.cpu) {
        return undefined;
    }

    // "AMD Ryzen 5 3600 6-Core Processor": the threads are the CPUs that Node.js sees
    const cores = /(\d+)-Core/u.exec(machine.cpu)?.[1];
    const model = String(machine.cpu).replace(/\s+\d+-Core Processor$/u, '').replace(/\s+Processor$/u, '').trim();
    const threads = machine.cores ? `${machine.cores} threads` : '';
    const parts = [model];

    if (cores || threads) {
        parts[0] += ` (${[cores && `${cores} cores`, threads].filter(Boolean).join(', ')})`;
    }

    if (machine.memoryGiB) {
        // The memory that the system reports is a little below the installed size
        const installed = 2 ** Math.round(Math.log2(machine.memoryGiB));

        parts.push(`${Math.abs(installed - machine.memoryGiB) / installed < 0.05 ? installed : machine.memoryGiB} GB`);
    }

    if (machine.kernel && machine.platform === 'linux') {
        parts.push(`Linux ${String(machine.kernel).split('.').slice(0, 2).join('.')}`);
    }

    return parts.join(', ');
}

// ---------------------------------------------------------------------------------------------------------------------
// The lanes of the comparison

/**
 * @typedef {object} Lane
 * @property {string} id The library, as results.json names it.
 * @property {'postgres' | 'redis'} dialect
 * @property {string} label In the charts: `*` marks an enqueue after the COMMIT.
 * @property {string} name In the prose and the alt texts.
 * @property {boolean} after It enqueues after the COMMIT, not in the caller's transaction.
 */

/**
 * @type {{ id: string, name: string, versionName?: string, laneName?: string, label?: string }[]} One row per
 *     library, on PostgreSQL, in this order. laneName and label: its lane's, when the name alone would read as Redis.
 */
const LIBS = [
    { id: 'sqlane', name: 'sqlane' },
    { id: 'graphile-worker', name: 'Graphile Worker' },
    { id: 'river', name: 'River', versionName: 'River for JavaScript' },
    { id: 'pg-boss', name: 'pg-boss' },
    { id: 'izi-queue', name: 'Izi Queue' },
    { id: 'boring-node-queue', name: 'Boring Node Queue' },
    { id: 'bullmq', name: 'BullMQ', laneName: 'BullMQ on PostgreSQL', label: 'BullMQ (PostgreSQL)' },
    { id: 'sidequest', name: 'Sidequest' },
];

/**
 * @typedef {object} Polling A library whose only wake is a poll: its latency is its poll's.
 * @property {string} poll
 * @property {{ version: string, text: string }} [newer] A later version that wakes otherwise: said while the run has
 *     `version`.
 */

/** @type {Record<string, Polling>} See their adapters in bench/compare/libs */
const POLLING = {
    sidequest: { poll: 'every 100 ms' },
};

/**
 * Why a library's database works hard while idle, where the run's setup explains it (see its adapter).
 * @type {Record<string, (names: number) => string>}
 */
const IDLE_CAUSES = {
    'pg-boss': names => `gives each of the ${names} job names a queue of its own, with its own \`work()\` poll, where `
        + 'the others poll their job names together',
    'izi-queue': () => 'polls every 100 ms, set for throughput (default 1 s)',
};

/**
 * Why a library runs few jobs per second with a backlog, where its setting explains it (see its adapter).
 * @type {Record<string, string>}
 */
const THROUGHPUT_CAUSES = {
    'izi-queue': 'fetches at most its free slots per poll, every 100 ms',
};

/** The note of the charts with a `*` lane */
const AFTER_NOTE = '*: enqueue after the COMMIT, not in the caller\'s transaction.';

/**
 * @param {string} id
 * @returns {string} its version in the run
 */
function versionOf(id) {
    const check = compare.checks.find((/** @type {any} */ entry) => entry.library === id);

    if (!check) {
        throw new Error(`bench/compare/results.json: no version of ${id} in checks`);
    }

    return check.version;
}

/**
 * @param {Row} row
 * @returns {'postgres' | 'redis' | string}
 */
const rowDialect = row => row.dialect ?? 'postgres';

/**
 * @param {string} id
 * @returns {boolean} the library enqueues after the COMMIT (`transactional: false` in its rows)
 */
const enqueuesAfter = id => compare.perf.some((/** @type {Row} */ row) => (
    row.library === id && row.transactional === false
));

/** @type {Lane[]} The libraries on PostgreSQL, then BullMQ on Redis where the run has it */
const LANES = [
    ...LIBS.map(({ id, name, laneName, label }) => {
        const after = enqueuesAfter(id);

        return {
            id,
            dialect: /** @type {const} */ ('postgres'),
            label: `${label ?? name}${after ? '*' : ''}`,
            name: laneName ?? name,
            after,
        };
    }),
    ...compare.perf.some((/** @type {Row} */ row) => row.library === 'bullmq' && row.dialect === 'redis')
        ? [{
                id: 'bullmq',
                dialect: /** @type {const} */ ('redis'),
                label: `BullMQ (Redis)${enqueuesAfter('bullmq') ? '*' : ''}`,
                name: 'BullMQ on Redis',
                after: enqueuesAfter('bullmq'),
            }]
        : [],
];

/**
 * @typedef {{ timing?: boolean, processes?: number, names?: number }} RunOptions timing: the run of phase B, one
 *     library at a time; processes: the workers of a schedule run; names: the job names, 1000 by default
 */

/**
 * @param {Lane} lane
 * @param {string} workload
 * @param {RunOptions} [options]
 * @returns {Row | undefined} the lane's run of the workload: with `names` job names, or `processes` workers for
 *     schedules
 */
function runOf(lane, workload, { timing = false, processes, names = 1000 } = {}) {
    return compare.perf.find((/** @type {Row} */ row) => row.library === lane.id && row.workload === workload
        && rowDialect(row) === lane.dialect && Boolean(row.timing) === timing
        && (processes === undefined ? row.names === names : row.processes === processes));
}

/**
 * @param {Lane} lane
 * @param {Row | undefined} row
 * @param {string} workload
 * @returns {Row} the row; a PostgreSQL lane must have it
 */
function required(lane, row, workload) {
    if (!row) {
        throw new Error(`bench/compare/results.json: no ${workload} run of ${lane.id} on ${lane.dialect}`);
    }

    return row;
}

// ---------------------------------------------------------------------------------------------------------------------
// Numbers

/**
 * @param {number[]} values
 * @returns {number} their sum
 */
function sum(values) {
    let total = 0;

    for (const value of values) {
        total += value;
    }

    return total;
}

/**
 * @param {number} n millions
 * @returns {string} 1 decimal, 2 below 0.1, none from 100
 */
function fixed(n) {
    if (n >= 100) {
        return n.toFixed(0);
    }

    return n.toFixed(n < 0.1 ? 2 : 1);
}

/**
 * @param {number} n
 * @returns {string} 2 decimals below 10, 1 below 100, none above
 */
function precise(n) {
    if (n >= 100) {
        return n.toFixed(0);
    }

    return n.toFixed(n < 10 ? 2 : 1);
}

/**
 * @param {number} ratio
 * @returns {string} 1 decimal below 10, then 2 significant digits: 2.8, 27, 8,500
 */
function times(ratio) {
    if (ratio < 10) {
        return ratio.toFixed(1);
    }

    return Number(ratio.toPrecision(2)).toLocaleString('en-US');
}

/**
 * @param {number} n jobs per second
 * @returns {string} 3 significant digits from 100, with a comma: 66, 613, 12,400
 */
function rate(n) {
    return n < 100 ? n.toFixed(0) : Number(n.toPrecision(3)).toLocaleString('en-US');
}

/**
 * @param {string[]} values sorted
 * @param {string} [unit]
 * @returns {string} "a–b unit", or "a unit" when they are the same
 */
function range(values, unit = '') {
    const [first, last] = [values[0], values.at(-1)];

    return `${first === last ? first : `${first}–${last}`}${unit}`;
}

/**
 * @param {string} noun
 * @returns {string} "a" or "an", by its first letter
 */
const article = noun => (/^[aeiou]/iu.test(noun) ? 'an' : 'a');

/**
 * @param {number[]} values
 * @returns {number[]} sorted, ascending
 */
const ascending = values => values.toSorted((a, b) => a - b);

/**
 * @param {string} iso
 * @returns {string} "14 November 2026", in UTC
 */
function day(iso) {
    const options = /** @type {const} */ ({ day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

    return new Date(iso).toLocaleDateString('en-GB', options);
}

// ---------------------------------------------------------------------------------------------------------------------
// Charts

/**
 * @typedef {object} Bar
 * @property {Lane} lane
 * @property {number[]} parts The stacked segments; none: a row with a note instead of a bar (another unit).
 * @property {string} value The text after the bar.
 * @property {string} alt The value in the alt text.
 */

/**
 * @typedef {object} Chart
 * @property {string} name The files: `<name>_light.svg`, `<name>_dark.svg`.
 * @property {string} title
 * @property {string} subtitle
 * @property {string[]} [legend] The series of the stacked parts.
 * @property {string} unit Of the axis.
 * @property {string} alt The start of the alt text, before the values.
 * @property {Bar[]} bars
 * @property {string} [note] The note of a `*` lane, AFTER_NOTE by default.
 */

// Colors for GitHub's light (#ffffff) and dark (#0d1117) pages; the series pass the palette checks on both.
const THEMES = {
    light: {
        page: '#ffffff',
        text: '#1f2328',
        muted: '#59636e',
        grid: '#e1e0d9',
        axis: '#c3c2b7',
        series: ['#2a78d6', '#eb6834', '#1baf7a'],
    },
    dark: {
        page: '#0d1117',
        text: '#f0f6fc',
        muted: '#9198a1',
        grid: '#262c36',
        axis: '#3d444d',
        series: ['#3987e5', '#d95926', '#199e70'],
    },
};

/** The palette index of each series, so a series has one color in every chart */
const SERIES = { Worker: 0, Workers: 0, Producer: 1, Database: 2 };

/** The width of the plot and its texts; the page adds PAD around it */
const W = 720;
/** The margin inside the page's background, which every SVG has: a viewer may ignore <picture> (npm shows the light) */
const PAD = 16;
/** The width of a character of 14 px text, on average: room for the labels, and the values after the bars */
const CHAR_W = 7.8;
/** Room for the longest label, "BullMQ (PostgreSQL)*" */
const LABEL_W = 166;
const X0 = LABEL_W + 8;
const ROW = 36;
const BAR = 18;
const SVG_NS = 'http://www.w3.org/2000/svg';
const FONT = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;

/**
 * @param {string} text
 * @returns {string} for XML and HTML text and attributes: `&`, `<`, `>` and `"` escaped
 */
function escape(text) {
    return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * @param {number} max
 * @returns {number[]} round axis ticks from 0 to at least max
 */
function ticks(max) {
    const raw = max / 4;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= raw) ?? 10 * mag;
    const out = [];

    for (let v = 0; v < max + step; v += step) {
        out.push(Math.round(v * 1000) / 1000);
    }

    return out;
}

/**
 * @param {number[]} values the totals of the bars
 * @returns {number} the end of the axis: past the largest, unless it dwarfs the others; its bar then stops at the edge
 */
function axisMax(values) {
    const [first, second] = ascending(values).toReversed();

    return second !== undefined && first > 4 * second ? second * 1.15 : first;
}

/**
 * A bar from x to x + w, square at its start, with a rounded end when `round` is set.
 * @param {{ x: number, y: number, w: number, color: string, round: boolean }} bar
 * @returns {string} an SVG element
 */
function barShape({ x, y, w, color, round }) {
    const width = Math.max(w, 2);
    const r = round ? Math.min(4, width / 2) : 0;

    if (r === 0) {
        return `<rect x="${x}" y="${y}" width="${width.toFixed(1)}" height="${BAR}" fill="${color}"/>`;
    }

    const e = x + width;
    const s = (e - r).toFixed(1);
    const arc = `A${r},${r} 0 0 1`;
    const d = `M${x},${y}H${s}${arc} ${e.toFixed(1)},${y + r}V${y + BAR - r}${arc} ${s},${y + BAR}H${x}Z`;

    return `<path d="${d}" fill="${color}"/>`;
}

/**
 * @param {Chart} chart
 * @param {keyof typeof THEMES} theme
 * @returns {string} the SVG document
 */
function svg({ title, subtitle, legend, bars, unit, note: afterNote = AFTER_NOTE }, theme) {
    const c = THEMES[theme];
    /**
     * @param {number} part
     * @returns {string} The color of the part's series.
     */
    const color = part => c.series[legend ? SERIES[/** @type {keyof typeof SERIES} */ (legend[part])] : 0];
    const drawn = bars.filter(bar => bar.parts.length);
    const tk = ticks(axisMax(drawn.map(bar => sum(bar.parts))));
    const end = /** @type {number} */ (tk.at(-1));
    // The plot ends where the longest value after a bar, and the unit after the last tick, still fit
    const room = Math.max(...drawn.map(bar => bar.value.length * CHAR_W), 22 + (unit.length * 6.5));
    const x1 = W - Math.ceil(room) - 12;
    const scale = (/** @type {number} */ v) => ((x1 - X0) * Math.min(v, end)) / end;
    const top = legend ? 90 : 68;
    const plotH = bars.length * ROW;
    const note = bars.some(bar => bar.lane.after) ? afterNote : '';
    const H = top + plotH + (note ? 52 : 30);
    const [pageW, pageH] = [W + (2 * PAD), H + (2 * PAD)];
    const out = [
        `<svg xmlns="${SVG_NS}" width="${pageW}" height="${pageH}" viewBox="0 0 ${pageW} ${pageH}" ${FONT} role="img" `
        + `aria-label="${escape(title)}">`,
        `<title>${escape(title)}</title>`,
        `<rect width="${pageW}" height="${pageH}" rx="6" fill="${c.page}"/>`,
        `<g transform="translate(${PAD} ${PAD})">`,
        `<text x="0" y="22" font-size="18" font-weight="600" fill="${c.text}">${escape(title)}</text>`,
        `<text x="0" y="46" font-size="14" fill="${c.muted}">${escape(subtitle)}</text>`,
    ];
    let lx = 0;

    for (const [i, name] of (legend ?? []).entries()) {
        out.push(
            `<rect x="${lx}" y="61" width="11" height="11" rx="2" fill="${color(i)}"/>`,
            `<text x="${lx + 16}" y="71" font-size="13" fill="${c.muted}">${escape(name)}</text>`,
        );
        lx += 16 + (name.length * 7.5) + 18;
    }

    for (const t of tk) {
        const x = (X0 + scale(t)).toFixed(1);

        out.push(
            `<line x1="${x}" y1="${top - 4}" x2="${x}" y2="${top + plotH}" stroke="${t === 0 ? c.axis : c.grid}"/>`,
            `<text x="${x}" y="${top + plotH + 19}" font-size="12" fill="${c.muted}" text-anchor="middle">`
            + `${t.toLocaleString('en-US')}</text>`,
        );
    }

    out.push(`<text x="${x1 + 22}" y="${top + plotH + 19}" font-size="12" fill="${c.muted}">${escape(unit)}</text>`);

    if (note) {
        out.push(`<text x="0" y="${top + plotH + 44}" font-size="13" fill="${c.muted}">${escape(note)}</text>`);
    }

    for (const [i, bar] of bars.entries()) {
        const y = top + (i * ROW) + ((ROW - BAR) / 2);
        const bold = bar.lane.id === 'sqlane' ? ' font-weight="600"' : '';
        const label = `x="${LABEL_W}" y="${y + 14}" font-size="14" fill="${c.text}" text-anchor="end"${bold}`;

        out.push(`<text ${label}>${escape(bar.lane.label)}</text>`);

        let x = X0;

        for (const [j, v] of bar.parts.entries()) {
            const last = j === bar.parts.length - 1;
            const w = scale(v);
            const cut = v > end;

            // A 2px gap between stacked segments
            out.push(barShape({ x, y, w: last ? w : Math.max(w - 2, 1), color: color(j), round: last && !cut }));
            x += w;

            // A bar cut at the end of the axis: two slashes in the page color mark the break
            if (cut) {
                for (const dx of [16, 9]) {
                    const at = `M${(x - dx).toFixed(1)},${y + BAR + 2}l6,${-(BAR + 4)}`;

                    out.push(`<path d="${at}" stroke="${c.page}" stroke-width="2.5"/>`);
                }
            }
        }

        // A row without a bar: its value is a note, in another unit
        const ink = bar.parts.length ? c.text : c.muted;
        const vx = (bar.parts.length ? Math.max(x, X0 + 2) + 6 : X0).toFixed(1);

        out.push(`<text x="${vx}" y="${y + 14}" font-size="14" fill="${ink}"${bold}>${escape(bar.value)}</text>`);
    }

    out.push('</g>', '</svg>');

    return `${out.join('\n')}\n`;
}

/**
 * @param {Chart} chart
 * @returns {string} its alt text, escaped for an HTML attribute
 */
function altText({ alt, bars }) {
    const values = bars.map(bar => `${bar.lane.name} ${bar.alt}${bar.lane.after ? ' (after the commit)' : ''}`);

    return escape(`${alt}: ${values.join(', ')}`);
}

/**
 * @param {Chart} chart
 * @returns {string} the <picture> of the chart, light and dark
 */
function picture(chart) {
    return [
        '<picture>',
        `  <source media="(prefers-color-scheme: dark)" srcset="${RAW}/${chart.name}_dark.svg">`,
        `  <img alt="${altText(chart)}" src="${RAW}/${chart.name}_light.svg">`,
        '</picture>',
    ].join('\n');
}

const pg = `PostgreSQL ${container.postgresMajor}`;

/**
 * @param {any} machine a part of `machines`
 * @returns {string} "1 ms round trip", or "no network delay" without netem
 */
function roundTrip(machine) {
    return machine?.latency ? `${machine.latency.roundTripMs} ms round trip` : 'no network delay';
}

const jobsTrip = roundTrip(compare.machines.perf);
const cronTrip = roundTrip(compare.machines.cron);
const throughputTrip = roundTrip(compare.machines.throughput);
const mega = (/** @type {number} */ n) => n / 1e6;

/**
 * @param {string} workload
 * @param {(lane: Lane, row: Row) => Omit<Bar, 'lane'>} bar
 * @param {RunOptions} [options]
 * @returns {Bar[]} a bar per lane: every library on PostgreSQL, BullMQ on Redis when the run has it
 */
function barsOf(workload, bar, options) {
    return LANES.flatMap((lane) => {
        const row = runOf(lane, workload, options);

        if (lane.dialect !== 'postgres' && !row) {
            return [];
        }

        return [{ lane, ...bar(lane, required(lane, row, workload)) }];
    });
}

/** @type {Chart} */
const cpuChart = {
    name: 'perf_cpu_per_job',
    title: 'CPU instructions per job, steady load',
    subtitle: `${pg}, ${jobsTrip}, 20 jobs/s over 1000 job names.`,
    legend: ['Worker', 'Producer', 'Database'],
    unit: 'M instr.',
    alt: `CPU instructions per job at steady load on PostgreSQL with a ${jobsTrip}`,
    bars: barsOf('steady', (_, row) => {
        const parts = [row.worker, row.producer, row.db].map(p => mega(p.instructions) / row.completed);

        return { parts, value: `${fixed(sum(parts))} M`, alt: `${fixed(sum(parts))} M` };
    }),
};

/** @type {Chart} */
const statementsChart = {
    name: 'perf_statements',
    title: 'SQL statements per job, steady load',
    subtitle: `${pg}, each statement a ${jobsTrip}; without the business INSERT.`,
    unit: 'statements',
    alt: `SQL statements per job at steady load on PostgreSQL, each statement a ${jobsTrip}, without the business `
        + 'INSERT',
    bars: barsOf('steady', (lane, row) => {
        // Redis commands aren't statements: no bar on the same axis, the number as a note. Nor round trips: most run
        // inside its Lua scripts, whose calls are the EVALSHAs
        if (lane.dialect === 'redis') {
            const commands = Math.round(row.redisCommands / row.completed);
            const evalsha = row.redisByCommand?.evalsha;
            const scripts = evalsha ? `${Math.round(evalsha / row.completed)} Lua script calls` : 'Lua scripts';

            return {
                parts: [],
                value: `${commands} Redis commands, most inside ${scripts}: another unit`,
                alt: `${commands} Redis commands, most inside ${scripts}${evalsha ? ' (EVALSHA)' : ''}`,
            };
        }

        const statements = row.queueStatements / row.completed;

        return { parts: [statements], value: statements.toFixed(1), alt: statements.toFixed(1) };
    }),
};

/** @type {Chart} */
const idleChart = {
    name: 'perf_idle',
    title: 'Database instructions per second, idle',
    subtitle: `${pg}, 1000 job names, no jobs.`,
    unit: 'M/s',
    alt: 'Database instructions per second while idle with 1000 job names on PostgreSQL',
    bars: barsOf('idle', (_, row) => {
        const perSecond = mega(row.db.instructions) / row.seconds;

        return { parts: [perSecond], value: `${fixed(perSecond)} M/s`, alt: `${fixed(perSecond)} M/s` };
    }),
};

/** @type {Chart} */
const latencyChart = {
    name: 'perf_latency',
    title: 'From enqueue to handler start, median',
    subtitle: `${pg}, ${jobsTrip}, steady load, one library at a time.`,
    unit: 'ms',
    alt: `Time from enqueue to handler start on PostgreSQL with a ${jobsTrip}, one library at a time, p50 and p99`,
    bars: barsOf('steady', (_, row) => ({
        parts: [row.latencyP50Ms],
        value: `${row.latencyP50Ms} ms · p99 ${row.latencyP99Ms} ms`,
        alt: `${row.latencyP50Ms} ms, p99 ${row.latencyP99Ms} ms`,
    }), { timing: true }),
};

/** @type {Chart} */
const cronChart = {
    name: 'perf_cron',
    title: 'CPU instructions per fired schedule slot, 3 workers',
    subtitle: `${pg}, ${cronTrip}, 1000 schedules due every minute.`,
    legend: ['Workers', 'Database'],
    unit: 'M instr.',
    alt: 'CPU instructions per fired slot of 1000 schedules due every minute, 3 worker processes, on PostgreSQL '
        + `with a ${cronTrip}`,
    bars: barsOf('cron-fire', (_, row) => {
        // The CPU window holds one slot of each schedule per minute
        const slots = (row.schedules * row.seconds) / 60;
        const parts = [row.worker, row.db].map(p => mega(p.instructions) / slots);

        return { parts, value: `${fixed(sum(parts))} M`, alt: `${fixed(sum(parts))} M` };
    }, { processes: 3 }),
};

/** The throughput's rows, when the results have them (`--only throughput`, or a default run) */
const throughputRows = compare.perf.filter((/** @type {Row} */ row) => row.workload === 'throughput');
/** The backlog of the throughput runs: the same in each */
const backlogs = [...new Set(throughputRows.map((/** @type {Row} */ row) => row.backlog))];

if (backlogs.length > 1) {
    throw new Error(`bench/compare/results.json: throughput runs with backlogs of ${backlogs.join(', ')} jobs: run `
        + 'them again with one');
}

const [backlog] = backlogs;

/** @type {Chart | null} Higher is better */
const throughputChart = throughputRows.length
    ? {
            name: 'perf_throughput',
            title: 'Jobs per second, one worker',
            subtitle: `${pg}, ${throughputTrip}, a backlog of ${backlog.toLocaleString('en-US')} jobs of one name, `
                + '8 slots.',
            unit: 'jobs/s',
            alt: 'Jobs per second of one worker with 8 slots, empty handlers, a backlog of '
                + `${backlog.toLocaleString('en-US')} jobs of one name, on PostgreSQL, ${throughputTrip}`,
            bars: barsOf('throughput', (_, row) => ({
                parts: [row.jobsPerSecond],
                // The backlog ran out before the end of the window: at least this many
                value: `${row.drained ? '≥ ' : ''}${rate(row.jobsPerSecond)} jobs/s`,
                alt: `${row.drained ? 'at least ' : ''}${rate(row.jobsPerSecond)}`,
            }), { names: 1 }),
        }
    : null;

/**
 * @param {number} n milliseconds
 * @returns {string} 1 decimal below 10, none from 10
 */
const ms = n => n.toFixed(n < 10 ? 1 : 0);

/** The rows of phase B have the time of each enqueue call (perf.mjs notes it): sqlane's at least */
const enqueueMeasured = typeof runOf(LANES[0], 'steady', { timing: true })?.enqueueP50Ms === 'number';

/** @type {Chart | null} The time that an enqueue call takes: in the caller's transaction, or after it (`*`) */
const enqueueChart = enqueueMeasured
    ? {
            name: 'perf_enqueue',
            title: 'Time an enqueue adds to your transaction, median',
            subtitle: `${pg}, ${jobsTrip}, steady load, one library at a time.`,
            unit: 'ms',
            alt: `Time of one enqueue call in the caller's transaction on PostgreSQL with a ${jobsTrip}, one library at `
                + 'a time, p50 and p99',
            note: '*: enqueue after the COMMIT, on its own connection: this time is not inside the caller\'s '
                + 'transaction.',
            bars: barsOf('steady', (_, row) => (typeof row.enqueueP50Ms === 'number'
                ? {
                        parts: [row.enqueueP50Ms],
                        value: `${ms(row.enqueueP50Ms)} ms · p99 ${ms(row.enqueueP99Ms)} ms`,
                        alt: `${ms(row.enqueueP50Ms)} ms, p99 ${ms(row.enqueueP99Ms)} ms`,
                    }
                : { parts: [], value: 'not measured', alt: 'not measured' }), { timing: true }),
        }
    : null;

const CHARTS = [
    cpuChart, statementsChart, idleChart, latencyChart, cronChart, ...throughputChart ? [throughputChart] : [],
    ...enqueueChart ? [enqueueChart] : [],
];

// ---------------------------------------------------------------------------------------------------------------------
// Markdown

/**
 * @param {string} text
 * @param {string} [first] The prefix of the first line, such as `- `; the others get as many spaces.
 * @returns {string} the text wrapped at WIDTH. A line never starts with a word that Markdown would read as a list
 *     item, a heading or a quote, nor with a unit, which stays with its number, nor with the number of a p50 or p99.
 */
function wrap(text, first = '') {
    const indent = ' '.repeat(first.length);
    /** @type {string[]} The words; a word that can't start a line is joined to the one before it */
    const words = [];

    for (const word of text.split(' ')) {
        if (words.length && (/^(?:[-+*>#]|\d+[.)]|(?:M|ms|s|GB|M\/s)[.,;:)]?)$/u.test(word)
            || /(?:^|\()p\d\d$/u.test(/** @type {string} */ (words.at(-1))))) {
            words[words.length - 1] += ` ${word}`;
        } else {
            words.push(word);
        }
    }

    const lines = [];
    let line = first + words[0];

    for (const word of words.slice(1)) {
        if (line.length + 1 + word.length > WIDTH) {
            lines.push(line);
            line = indent + word;
        } else {
            line += ` ${word}`;
        }
    }

    lines.push(line);

    return lines.join('\n');
}

/**
 * @param {string[][]} rows the header first
 * @returns {string} a Markdown table, aligned as oxfmt aligns it
 */
function table(rows) {
    const widths = rows[0].map((_, column) => Math.max(3, ...rows.map(row => row[column].length)));
    /**
     * @param {string[]} row
     * @returns {string}
     */
    const line = row => `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(' | ')} |`;

    return [line(rows[0]), line(widths.map(width => '-'.repeat(width))), ...rows.slice(1).map(line)].join('\n');
}

/**
 * @param {Chart} chart
 * @returns {Map<string, Bar>} its bars, by `<library>/<dialect>`
 */
const barsBy = chart => new Map(chart.bars.map(bar => [`${bar.lane.id}/${bar.lane.dialect}`, bar]));

/**
 * @param {Chart} chart
 * @returns {{ sqlane: number, others: number[], redis: number | undefined }} the totals: sqlane's, the other
 *     libraries' on PostgreSQL, and BullMQ's on Redis
 */
function totals(chart) {
    const bars = barsBy(chart);
    const total = (/** @type {string} */ key) => {
        const bar = bars.get(key);

        return bar?.parts.length ? sum(bar.parts) : undefined;
    };

    return {
        sqlane: /** @type {number} */ (total('sqlane/postgres')),
        others: chart.bars
            .filter(bar => bar.lane.dialect === 'postgres' && bar.lane.id !== 'sqlane')
            .map(bar => sum(bar.parts)),
        redis: total('bullmq/redis'),
    };
}

/**
 * @returns {string} the sentence under the CPU chart
 */
function cpuText() {
    const { sqlane, others, redis } = totals(cpuChart);
    const ratios = ascending(others).map(value => times(value / sqlane));
    let text = `On PostgreSQL, the other libraries use ${range(ratios)}× as many instructions per job as sqlane `
        + `(${fixed(sqlane)} M).`;

    if (redis !== undefined) {
        text += ` BullMQ on Redis uses ${fixed(redis)} M (${times(redis / sqlane)}×), after the commit.`;
    }

    return text;
}

/**
 * @returns {string} the sentence under the statements chart
 */
function statementsText() {
    const { sqlane, others } = totals(statementsChart);
    const redis = barsBy(statementsChart).get('bullmq/redis');
    let text = `sqlane runs ${sqlane.toFixed(1)} statements per job, the others `
        + `${range(ascending(others).map(value => value.toFixed(1)))}`;

    if (redis) {
        text += `; BullMQ on Redis, per job: ${redis.alt}`;
    }

    return `${text}.`;
}

/**
 * @returns {string} the sentence under the idle chart
 */
function idleText() {
    const { sqlane, others, redis } = totals(idleChart);
    const above = ascending(others.filter(value => value >= sqlane));
    // Those whose database works less than sqlane's: named, not given as a ratio below 1×
    const below = idleChart.bars
        .filter(({ lane, parts }) => lane.dialect === 'postgres' && lane.id !== 'sqlane' && sum(parts) < sqlane)
        .map(({ lane, parts }) => `${lane.name} (${fixed(sum(parts))} M)`);
    let text = `sqlane's database uses ${fixed(sqlane)} M instructions per second; the other libraries' `
        + `${range(above.map(fixed), ' M')} (${range(above.map(value => times(value / sqlane)))}×)`;

    text += below.length ? `, except ${and(below)}, which ${below.length > 1 ? 'use' : 'uses'} less.` : '.';

    if (redis !== undefined) {
        text += ` BullMQ on Redis: ${fixed(redis)} M.`;
    }

    const causes = idleChart.bars.flatMap(({ lane, parts }) => {
        const cause = lane.dialect === 'postgres' ? IDLE_CAUSES[lane.id] : undefined;
        const row = /** @type {Row} */ (runOf(lane, 'idle'));

        return cause ? [`${lane.name} (${fixed(sum(parts))} M) ${cause(row.names)}`] : [];
    });

    if (causes.length) {
        text += ` ${causes.join('; ')}.`;
    }

    return text;
}

/**
 * @param {string[]} names
 * @returns {string} "a", "a and b", "a, b and c"
 */
function and(names) {
    return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/**
 * @returns {string} the sentences under the latency chart: each library against sqlane, then those that only poll
 */
function latencyText() {
    const rows = latencyChart.bars.map(bar => ({
        lane: bar.lane,
        row: /** @type {Row} */ (runOf(bar.lane, 'steady', { timing: true })),
    }));
    const sqlane = /** @type {Row} */ (rows.find(({ lane }) => lane.id === 'sqlane')?.row);
    const others = rows.filter(({ lane }) => lane.id !== 'sqlane');
    const woken = others.filter(({ lane }) => !POLLING[lane.id]);
    const polling = others.filter(({ lane }) => POLLING[lane.id]);
    /** @type {Map<string, { names: string[], p50: number, p99: number }>} Those with the same times, fastest first */
    const groups = new Map();

    for (const { lane, row } of woken.toSorted((a, b) => (
        a.row.latencyP50Ms - b.row.latencyP50Ms || a.row.latencyP99Ms - b.row.latencyP99Ms
    ))) {
        const [p50, p99] = [row.latencyP50Ms, row.latencyP99Ms];
        const group = groups.get(`${p50}/${p99}`) ?? { names: /** @type {string[]} */ ([]), p50, p99 };

        group.names.push(lane.name);
        groups.set(`${p50}/${p99}`, group);
    }

    const against = [...groups.values()].map(({ names, p50, p99 }) => {
        const many = names.length > 1;
        const gap = p50 - sqlane.latencyP50Ms;

        if (gap === 0) {
            return `${and(names)} tie${many ? '' : 's'} (p99 ${p99} ms)`;
        }

        const verb = `${many ? 'are' : 'is'} ${Math.abs(gap)} ms ${gap < 0 ? 'faster' : 'slower'} (${p50} ms`;

        // A tail far above the median: the number that matters
        return p99 >= 10 * p50
            ? `${and(names)} ${verb}), but ${many ? 'their' : 'its'} p99 is ${p99} ms`
            : `${and(names)} ${verb}, p99 ${p99} ms)`;
    });
    let text = `sqlane: p50 ${sqlane.latencyP50Ms} ms, p99 ${sqlane.latencyP99Ms} ms. Against it at p50: `
        + `${against.join('; ')}.`;

    if (polling.length) {
        const names = polling.map(({ lane }) => {
            const { newer } = POLLING[lane.id];

            return newer?.version === versionOf(lane.id) ? `${lane.name} ${newer.version}` : lane.name;
        });
        const polls = polling.map(({ lane, row }) => {
            const { poll, newer } = POLLING[lane.id];
            const later = newer?.version === versionOf(lane.id) ? `; ${newer.text}` : '';

            return `${poll} (p50 ${row.latencyP50Ms} ms, p99 ${row.latencyP99Ms} ms${later})`;
        });

        text += polling.length === 1
            ? ` ${names[0]} only polls, ${polls[0]}.`
            : ` ${and(names)} only poll: ${polling.map(({ lane }, index) => `${lane.name} ${polls[index]}`).join('; ')}.`;
    }

    return text;
}

/**
 * @returns {string} the sentence under the schedules chart
 */
function schedulesText() {
    const { sqlane, others, redis } = totals(cronChart);
    const ratios = ascending(others).map(value => times(value / sqlane));
    let text = `With 3 workers, the other libraries use ${range(ratios)}× as many instructions per fired slot as `
        + `sqlane (${fixed(sqlane)} M)`;

    if (redis !== undefined) {
        text += `; BullMQ on Redis uses ${fixed(redis)} M (${times(redis / sqlane)}×)`;
    }

    return `${text}.`;
}

/**
 * The sentences under the throughput chart, where more is better: sqlane's rate, the libraries that run more (sqlane
 * not the fastest, said plainly), about as many (within 5%) and fewer, then the lanes whose backlog ran out.
 * @param {Chart} chart
 * @returns {string}
 */
function throughputText(chart) {
    const rows = chart.bars.map(({ lane }) => ({
        lane,
        row: /** @type {Row} */ (runOf(lane, 'throughput', { names: 1 })),
    }));
    const sqlaneRow = /** @type {Row} */ (rows.find(({ lane }) => lane.id === 'sqlane')?.row);
    const sqlane = sqlaneRow.jobsPerSecond;
    const others = rows.filter(({ lane }) => lane.id !== 'sqlane')
        .map(({ lane, row }) => ({ lane, row, ratio: row.jobsPerSecond / sqlane }))
        .toSorted((a, b) => b.ratio - a.ratio);
    const faster = others.filter(({ ratio }) => ratio > 1.05);
    const same = others.filter(({ ratio }) => ratio >= 0.95 && ratio <= 1.05);
    const slower = others.filter(({ ratio }) => ratio < 0.95);
    const sentences = [`sqlane runs ${rate(sqlane)} jobs per second.`];

    if (faster.length) {
        const list = faster.map(({ lane, row, ratio }, index) => (
            index
                ? `${lane.name} ${rate(row.jobsPerSecond)} (${times(ratio)}×)`
                : `${lane.name} runs ${rate(row.jobsPerSecond)} (${times(ratio)}× as many)`
        ));

        sentences.push(`It is not the fastest: ${and(list)}.`);
    } else if (!same.length) {
        sentences.push('No other library runs more.');
    }

    if (same.length) {
        const list = same.map(({ lane, row }) => `${lane.name} (${rate(row.jobsPerSecond)})`);

        sentences.push(`${and(list)} ${same.length > 1 ? 'run' : 'runs'} about as many, within 5%`
            + `${faster.length ? '' : '; no other library runs more'}.`);
    }

    if (slower.length) {
        const list = slower.map(({ lane, row }) => `${lane.name} ${rate(row.jobsPerSecond)}`);
        const ratios = ascending(slower.map(({ ratio }) => 1 / ratio)).map(times);

        sentences.push(`The others run fewer: ${and(list)}, so sqlane runs ${range(ratios)}× as many.`);
    }

    const causes = slower.flatMap(({ lane }) => (
        lane.dialect === 'postgres' && THROUGHPUT_CAUSES[lane.id] ? [`${lane.name} ${THROUGHPUT_CAUSES[lane.id]}`] : []
    ));

    if (causes.length) {
        sentences.push(`${causes.join('; ')}.`);
    }

    // The backlog ran out before the end of the window: the rate of its jobs, up to the last, is a lower bound
    const drained = rows.filter(({ row }) => row.drained);

    if (drained.length) {
        const list = drained.map(({ lane, row }) => `${lane.name} (${row.seconds.toFixed(1)} s)`);
        const window = compare.machines.throughput?.windowSeconds;

        sentences.push(`The backlog of ${backlog.toLocaleString('en-US')} jobs ran out before the end of the `
            + `${window ? `${window} s ` : ''}window for ${and(list)}: ${drained.length > 1
                ? 'their numbers are lower bounds'
                : 'its number is a lower bound'}.`);
    }

    return sentences.join(' ');
}

/**
 * The sentences under the enqueue chart: sqlane's time in the caller's transaction, the libraries that take less
 * (sqlane not the lowest, said plainly), as long (the same in the chart) and more, then those that enqueue after the
 * COMMIT.
 * @param {Chart} chart
 * @returns {string}
 */
function enqueueText(chart) {
    const rows = chart.bars.filter(bar => bar.parts.length).map(({ lane }) => ({
        lane,
        row: /** @type {Row} */ (runOf(lane, 'steady', { timing: true })),
    }));
    const sqlane = /** @type {Row} */ (rows.find(({ lane }) => lane.id === 'sqlane')?.row);
    const inside = rows.filter(({ lane }) => lane.id !== 'sqlane' && !lane.after)
        .toSorted((a, b) => a.row.enqueueP50Ms - b.row.enqueueP50Ms);
    // As the chart shows them: the same text is a tie
    const shown = (/** @type {Row} */ row) => Number(ms(row.enqueueP50Ms));
    const less = inside.filter(({ row }) => shown(row) < shown(sqlane));
    const same = inside.filter(({ row }) => shown(row) === shown(sqlane));
    const more = inside.filter(({ row }) => shown(row) > shown(sqlane));
    const times50 = (/** @type {Row} */ row) => `${ms(row.enqueueP50Ms)} ms, p99 ${ms(row.enqueueP99Ms)} ms`;
    const sentences = [`In the caller's transaction, sqlane's enqueue takes ${ms(sqlane.enqueueP50Ms)} ms at p50, p99 `
        + `${ms(sqlane.enqueueP99Ms)} ms.`];

    if (less.length) {
        sentences.push(`It is not the lowest: ${and(less.map(({ lane, row }) => `${lane.name} (${times50(row)})`))} `
            + `${less.length > 1 ? 'take' : 'takes'} less.`);
    }

    if (same.length) {
        sentences.push(`${and(same.map(({ lane, row }) => `${lane.name} (p99 ${ms(row.enqueueP99Ms)} ms)`))} `
            + `${same.length > 1 ? 'take' : 'takes'} as long.`);
    }

    if (more.length) {
        const list = more.map(({ lane, row }) => (
            `${lane.name} ${times50(row)} (${ms(shown(row) - shown(sqlane))} ms more)`
        ));

        sentences.push(`${less.length || same.length ? 'The others take' : 'The other libraries take'} longer: `
            + `${list.join('; ')}.`);
    }

    const after = rows.filter(({ lane }) => lane.after);

    if (after.length) {
        const list = after.map(({ lane, row }) => `${lane.name} ${times50(row)}`);

        sentences.push(`After the \`COMMIT\`, on ${after.length > 1 ? 'their' : 'its'} own connection, so not inside the `
            + `caller's transaction, nor atomic with it: ${list.join('; ')}.`);
    }

    return sentences.join(' ');
}

/**
 * @param {Row | undefined} row
 * @param {string} field
 * @returns {boolean} the row has the number
 */
const has = (row, field) => typeof row?.[field] === 'number';

/**
 * @param {number} n megabytes
 * @returns {string}
 */
const mb = n => n.toFixed(0);

/**
 * The connections and the memory of each library at the steady load (phase A): a table, and the ranges under it.
 * @returns {string} empty when the results have neither (before perf.mjs noted them)
 */
function footprint() {
    const rows = LANES.flatMap((lane) => {
        const row = runOf(lane, 'steady');

        return row ? [{ lane, row }] : [];
    });

    if (!rows.some(({ row }) => has(row, 'workerConnections') || has(row, 'workerPeakRssMB'))) {
        return '';
    }

    /**
     * @param {Row} row
     * @param {string} field
     * @param {(n: number) => string} [format]
     * @returns {string}
     */
    const cell = (row, field, format = String) => (has(row, field) ? format(row[field]) : '—');
    const header = ['Library', 'Worker connections', 'Producer connections', 'Worker peak memory (MB)'];
    const lines = rows.map(({ lane, row }) => {
        // On Redis: its connections to Redis
        const unit = (/** @type {number} */ n) => (lane.dialect === 'redis' ? `${n} to Redis` : String(n));

        return [
            lane.name, cell(row, 'workerConnections', unit), cell(row, 'producerConnections', unit),
            cell(row, 'workerPeakRssMB', mb),
        ];
    });
    const sqlane = rows.find(({ lane }) => lane.id === 'sqlane')?.row;
    const others = rows.filter(({ lane }) => lane.id !== 'sqlane' && lane.dialect === 'postgres').map(({ row }) => row);
    /**
     * @param {string} field
     * @param {(n: number) => string} [format]
     * @returns {string} the range of the other libraries on PostgreSQL
     */
    const spanOf = (field, format = String) => range(ascending(others.filter(row => has(row, field))
        .map(row => row[field])).map(format));
    const parts = [];

    if (has(sqlane, 'workerConnections') && others.some(row => has(row, 'workerConnections'))) {
        parts.push(`sqlane's worker holds ${sqlane?.workerConnections} connections to PostgreSQL, the other libraries' `
            + `${spanOf('workerConnections')}`);
    }

    if (has(sqlane, 'producerConnections') && others.some(row => has(row, 'producerConnections'))) {
        parts.push(`sqlane's producer ${sqlane?.producerConnections} besides the business transactions', theirs `
            + `${spanOf('producerConnections')}`);
    }

    if (has(sqlane, 'workerPeakRssMB') && others.some(row => has(row, 'workerPeakRssMB'))) {
        parts.push(`sqlane's worker peaks at ${mb(sqlane?.workerPeakRssMB)} MB of memory, the others' at `
            + `${spanOf('workerPeakRssMB', mb)} MB`);
    }

    return [table([header, ...lines]), ...parts.length ? [wrap(`${parts.join('; ')}.`)] : []].join('\n\n');
}

/**
 * @param {number[]} values
 * @returns {number} how far apart they are: (largest − smallest) / smallest; 0 for fewer than 2
 */
function spread(values) {
    const sorted = ascending(values.filter(Number.isFinite));

    return sorted.length < 2 || !sorted[0] ? 0 : (/** @type {number} */ (sorted.at(-1)) - sorted[0]) / sorted[0];
}

/**
 * @param {number} ratio
 * @returns {string} a percentage, rounded up: "4%", "0.3%" below 1%
 */
function percent(ratio) {
    const value = ratio * 100;

    // Up, so "at most" holds; less a hair, so 4.0000001 stays 4
    return value < 1 ? `${(Math.ceil((value * 10) - 1e-9) / 10).toFixed(1)}%` : `${Math.ceil(value - 1e-9)}%`;
}

/**
 * @param {any} sample a run of a row's `samples`
 * @param {string[]} roles
 * @returns {number} the instructions of the roles in the run
 */
const sampleInstructions = (sample, roles) => sum(roles.map(role => sample[role] ?? 0));

/**
 * @param {string} workload
 * @param {(sample: any, row: Row) => number} value of a run: a sample of the row
 * @param {(a: number[]) => number} measure of the values of a lane's runs
 * @param {RunOptions} [options]
 * @returns {{ lane: Lane, value: number } | undefined} the lane whose runs differ most, by measure; none without a lane
 *     of 2 runs or more
 */
function widest(workload, value, measure, options) {
    /** @type {{ lane: Lane, value: number } | undefined} */
    let found;

    for (const lane of LANES) {
        const row = runOf(lane, workload, options);
        const samples = /** @type {any[]} */ (row?.samples ?? []);

        if (row && samples.length > 1) {
            const candidate = { lane, value: measure(samples.map(sample => value(sample, row))) };

            if (!found || candidate.value > found.value) {
                found = candidate;
            }
        }
    }

    return found;
}

/**
 * @param {number} n
 * @returns {string} "one", or the number
 */
function countOf(n) {
    return n === 1 ? 'one' : String(n);
}

/**
 * The runs of the jobs and the schedules, and how far apart the runs of a library are: from the `samples` of the rows.
 * A results.json of one run each (no `repeats`) says so, as before.
 * @returns {string} an item of the conditions
 */
function runsText() {
    const jobs = compare.machines.perf?.repeats ?? 1;
    // Before phase B had a count of its own, it ran as many times as phase A
    const timing = compare.machines.perf?.timingRepeats ?? jobs;
    const cron = compare.machines.cron?.repeats ?? 1;
    // Without throughput rows: as before they existed
    const throughput = throughputRows.length ? compare.machines.throughput?.repeats ?? 1 : timing;

    if (jobs < 2 && cron < 2 && timing < 2 && throughput < 2) {
        return '**One run:** differences of about 10% are noise.';
    }

    const count = jobs === cron && jobs === timing && jobs === throughput
        ? `${jobs} of each`
        : `${jobs} of each workload for the instructions and statements, ${countOf(timing)} for the latencies, `
            + `${throughputRows.length ? `${countOf(throughput)} for the throughput, ` : ''}${countOf(cron)} for the `
            + 'schedules';
    /** @type {[string, ReturnType<typeof widest>][]} */
    const apart = [];

    if (jobs > 1) {
        apart.push(
            ['in instructions per job', widest('steady', sample => (
                sampleInstructions(sample, ['worker', 'producer', 'db']) / sample.completed
            ), spread)],
            ['in idle instructions per second', widest('idle', (sample, row) => (
                sample.db / (sample.seconds ?? row.seconds)
            ), spread)],
        );
    }

    if (throughputRows.length && throughput > 1) {
        apart.push(['in jobs per second', widest('throughput', sample => sample.jobsPerSecond, spread, { names: 1 })]);
    }

    if (cron > 1) {
        apart.push(['in instructions per schedule slot', widest('cron-fire', (sample, row) => (
            sampleInstructions(sample, ['worker', 'db']) / (sample.seconds ?? row.seconds)
        ), spread, { processes: 3 })]);
    }

    const parts = apart.flatMap(([what, found]) => (
        found ? [`${percent(found.value)} ${what} (${found.lane.name})`] : []
    ));
    let text = `**Runs:** ${count}; the numbers of several runs are medians.`;

    if (parts.length) {
        text += ` The runs of a library differ by at most ${and(parts)}`;
    }

    const latency = timing > 1
        ? widest('steady', sample => sample.latencyP50Ms, values => Math.max(...values) - Math.min(...values), {
                timing: true,
            })
        : undefined;

    if (latency) {
        const by = latency.value ? `by at most ${latency.value} ms (${latency.lane.name})` : 'by less than 1 ms';

        text += parts.length ? `; their p50 latencies ${by}` : ` The p50 latencies of a library's runs differ ${by}`;
    }

    return parts.length || latency ? `${text}.` : text;
}

/**
 * @returns {string} the conditions of the run, as a list
 */
function conditions() {
    const { machines, dates } = compare;
    const perf = machines.perf;
    const machine = machineName(perf) ?? 'unknown machine';
    const runDays = [...new Set([dates.perf, throughputRows.length && dates.throughput, dates.cron].filter(Boolean)
        .map(day))];
    const versions = LIBS.map(({ id, name, versionName }) => `${versionName ?? name} ${versionOf(id)}`);
    const parallel = [...new Set([machines.perf.parallel, machines.cron.parallel])];
    const latency = perf.latency
        ? `${perf.latency.oneWayMs} ms each way on the container's loopback (netem), so each round trip between a `
        + `process and its database takes ${perf.latency.roundTripMs} ms.`
        : 'none added: the round trips are those of the loopback.';
    const counted = perf.kernelCounted
        ? 'user and kernel instructions'
        : 'user-space instructions only (the kernel is not counted)';
    const items = [
        `**Measured** on ${runDays.join(' and ')}, on ${article(machine)} ${machine}. The databases and the `
        + 'libraries run in one container ([linux.dockerfile](../bench/compare/linux.dockerfile)): '
        + `Debian ${container.debian}, Node.js ${compare.node.replace(/^v/u, '')}, PostgreSQL ${container.postgres} `
        + `and Redis ${container.redis}.`,
        `**Versions:** ${versions.join(', ')}.`,
        `**Network:** ${latency}`,
        '**Workers:** one worker process with 8 concurrent jobs; pg-boss has its slots per queue, so up to 8 per job '
        + 'name.',
        `**Instructions** are ${counted} of every process of a library and of its database. They come from up to `
        + `${parallel[0]} runs at once${parallel.length > 1 ? ` (the schedules: ${parallel[1]})` : ''}; times come `
        + 'from one library at a time.',
        runsText(),
        '**BullMQ on Redis** syncs its append-only file every second (`appendfsync everysec`), so a crash can lose up '
        + 'to a second of jobs.',
    ];

    return items.map(item => wrap(item, '- ')).join('\n');
}

/**
 * The rows of the backends table: one operation of each scenario of `pnpm bench:regression` (bench/regression/ab.mjs),
 * at its steady load. Statements and instructions come from the same run, so they describe the same operation.
 * @type {Record<string, string>}
 */
const HOT_PATHS = {
    enqueue: '`enqueue`, in a transaction of its own',
    enqueue_many: '`enqueueMany` of 100 jobs',
    run: 'A job: its enqueue, claim, run and completion, over 1000 job names',
    idle: 'A second of a worker with 1000 job names and no job',
    schedule: 'A schedule firing, one of 1000 `every: \'10s\'` schedules',
    global_limits: 'A job with one of 100 keys of a global limit of 1: its enqueue, claim, run and completion',
    global_rate_limits:
        'A job with one of 100 keys of a global rate limit of 1/s: its enqueue, claim, run and completion',
};

/**
 * @returns {string} sqlane on each backend: a table, and where its numbers come from
 */
function backends() {
    const names = SCENARIOS.map(scenario => scenario.name);
    const unknown = [
        ...names.filter(name => !HOT_PATHS[name]),
        ...Object.keys(HOT_PATHS).filter(name => !names.includes(name)),
    ];

    if (unknown.length) {
        throw new Error(`HOT_PATHS and the scenarios of bench/regression/scenarios.mjs differ: ${unknown.join(', ')}`);
    }

    // The servers of the run, "PostgreSQL 17.11"…; the family alone when the file has no version
    const servers = DIALECTS.map(({ dialect, name }) => ({
        dialect,
        title: regression?.servers.find(server => server.startsWith(`${name} `)) ?? name,
    }));
    /**
     * @param {string} scenario
     * @param {string} dialect
     * @returns {string} "statements · instructions" per operation
     */
    const cell = (scenario, dialect) => {
        const statements = regression?.statements.get(`${scenario}/${dialect}`);
        const instructions = regression?.instructions.get(`${scenario}/${dialect}`);

        if (statements === undefined || instructions === undefined) {
            return '—';
        }

        return `${statements < 1 ? statements.toFixed(3) : statements.toFixed(2)} · ${precise(mega(instructions))} M`;
    };
    const rows = names.map(scenario => (
        [HOT_PATHS[scenario]].concat(servers.map(({ dialect }) => cell(scenario, dialect)))
    ));
    const header = ['Per operation: statements · instructions', ...servers.map(server => server.title)];
    let source = 'Statements and CPU instructions of the sqlane processes and the database server, under steady load '
        + '(`pnpm bench:regression`), without network delay';

    if (regression) {
        const when = regression.date ? `, ${day(regression.date)}` : '';
        const on = regression.machine ? `, on ${article(regression.machine)} ${regression.machine}` : '';
        const user = regression.kernelCounted === false ? ', user space only' : '';

        source += `${when}${on}${user}.`;
    } else {
        source += '; —: not measured yet.';
    }

    return [table([header, ...rows]), wrap(source)].join('\n\n');
}

/**
 * @returns {string} the README's charts: CPU, throughput, statements and latency, which sqlane doesn't win; the
 *     others folded
 */
function readme() {
    return [
        picture(cpuChart),
        ...throughputChart ? [picture(throughputChart)] : [],
        picture(statementsChart),
        picture(latencyChart),
        '<details>\n<summary>More charts: idle and schedules</summary>',
        picture(idleChart),
        picture(cronChart),
        '</details>',
    ].join('\n\n');
}

/**
 * @param {Chart} chart
 * @param {string} text
 * @returns {string} the chart and the sentence under it
 */
const section = (chart, text) => `${picture(chart)}\n\n${wrap(text)}`;

// ---------------------------------------------------------------------------------------------------------------------
// Output

/**
 * Writes the file if its content changes.
 * @param {string} file
 * @param {string} content
 * @returns {boolean} it changed
 */
function update(file, content) {
    if (existsSync(file) && readFileSync(file, 'utf8') === content) {
        return false;
    }

    writeFileSync(file, content);

    return true;
}

/**
 * Rewrites the content between each pair of markers; the text outside them stays.
 * @param {string} file
 * @param {Record<string, string>} blocks by marker name
 * @returns {boolean} the file changed
 */
function fill(file, blocks) {
    let text = readFileSync(file, 'utf8');
    const name = relative(ROOT, file);

    for (const [marker, content] of Object.entries(blocks)) {
        const open = `<!-- generated:${marker} -->`;
        const close = `<!-- /generated:${marker} -->`;
        const start = text.indexOf(open);
        const end = text.indexOf(close);

        if (start === -1 || end === -1 || end < start) {
            throw new Error(`${name}: the markers ${open} … ${close} are missing or out of order`);
        }

        // An empty block: the two markers, one blank line apart
        text = `${text.slice(0, start + open.length)}\n\n${content ? `${content}\n\n` : ''}${text.slice(end)}`;
    }

    // A marker that nothing fills would stay empty
    const unknown = [...text.matchAll(/<!-- generated:([\w-]+) -->/gu)]
        .map(match => match[1])
        .filter(marker => !(marker in blocks));

    if (unknown.length) {
        throw new Error(`${name}: no content for the markers ${unknown.join(', ')}`);
    }

    return update(file, text);
}

mkdirSync(IMAGES, { recursive: true });

const written = new Set();
let changed = 0;

for (const chart of CHARTS) {
    for (const theme of /** @type {const} */ (['light', 'dark'])) {
        const file = `${chart.name}_${theme}.svg`;

        written.add(file);
        changed += Number(update(join(IMAGES, file), svg(chart, theme)));
    }
}

// The perf_ charts are this script's: one that it no longer draws is referenced nowhere
for (const file of readdirSync(IMAGES)) {
    if (/^perf_.*\.svg$/u.test(file) && !written.has(file)) {
        rmSync(join(IMAGES, file));
        console.log(`removed docs/images/${file}`);
        changed++;
    }
}

changed += Number(fill(PERF_DOC, {
    conditions: conditions(),
    cpu: section(cpuChart, cpuText()),
    statements: section(statementsChart, statementsText()),
    idle: section(idleChart, idleText()),
    latency: section(latencyChart, latencyText()),
    // Empty without throughput rows
    throughput: throughputChart ? section(throughputChart, throughputText(throughputChart)) : '',
    // Empty without the enqueue's times, the connections and the memory (results.json before they were measured)
    enqueue: enqueueChart ? section(enqueueChart, enqueueText(enqueueChart)) : '',
    footprint: footprint(),
    schedules: section(cronChart, schedulesText()),
    backends: backends(),
}));
changed += Number(fill(README, { readme: readme() }));

console.log(`${changed} file(s) changed; ${CHARTS.length * 2} charts in docs/images${regression
    ? ''
    : '; no bench/regression/results.json: the instructions of the backends table are —'}`);
