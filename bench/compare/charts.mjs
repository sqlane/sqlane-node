// The charts of docs/performance_vs_other_libs.md, from results.json: a light and a dark SVG of each, which the docs
// show with <picture>. Run: node bench/compare/charts.mjs
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const HERE = import.meta.dirname;
const OUT = join(HERE, '../../docs/images');
const results = JSON.parse(readFileSync(join(HERE, 'results.json'), 'utf8'));

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

/**
 * @type {{ id: string, label: string }[]} One bar per library, on PostgreSQL. `*`: the library enqueues after the
 *     COMMIT, not atomically.
 */
const LIBS = [
    { id: 'sqlane', label: 'sqlane' },
    { id: 'graphile-worker', label: 'Graphile Worker' },
    { id: 'river', label: 'River' },
    { id: 'pg-boss', label: 'pg-boss' },
    { id: 'izi-queue', label: 'Izi Queue' },
    { id: 'boring-node-queue', label: 'Boring Node Queue' },
    { id: 'bullmq', label: 'BullMQ*' },
    { id: 'sidequest', label: 'Sidequest*' },
];

const W = 720;
const LABEL_W = 150;
const X0 = LABEL_W + 8;
const X1 = W - 150;
const ROW = 34;
const BAR = 18;
const SVG_NS = 'http://www.w3.org/2000/svg';
const FONT = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"`;

/**
 * @param {string} library
 * @param {string} workload
 * @param {boolean} [timing] the run of phase B, one library at a time, for times
 * @returns {any} the PostgreSQL run of the library with 1000 job names
 */
function run(library, workload, timing = false) {
    const matches = (/** @type {any} */ r) => (
        r.library === library && r.workload === workload && Boolean(r.timing) === timing
    );
    const found = results.perf.find((/** @type {any} */ r) => matches(r) && r.dialect === 'postgres' && r.names === 1000);
    if (!found) throw new Error(`no ${workload} run of ${library}`);
    return found;
}

/**
 * @param {string} library
 * @param {number} processes
 * @returns {any} the PostgreSQL run of 1000 firing schedules of the library with that many worker processes
 */
function fireRun(library, processes) {
    const found = results.perf.find((/** @type {any} */ r) => (
        r.library === library && r.workload === 'cron-fire' && r.processes === processes && r.dialect === 'postgres'
    ));
    if (!found) throw new Error(`no cron-fire run of ${library}`);
    return found;
}

/**
 * @param {number[]} values
 * @returns {number} their sum
 */
function sum(values) {
    let total = 0;
    for (const v of values) total += v;
    return total;
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
    for (let v = 0; v < max + step; v += step) out.push(Math.round(v * 1000) / 1000);
    return out;
}

/**
 * A bar from x to x + w, square at its start, with a rounded end when `round` is set.
 * @param {{ x: number, y: number, w: number, fill: string, round: boolean }} bar
 * @returns {string} an SVG element
 */
function barShape({ x, y, w, fill, round }) {
    const width = Math.max(w, 2);
    const r = round ? Math.min(4, width / 2) : 0;
    if (r === 0) return `<rect x="${x}" y="${y}" width="${width.toFixed(1)}" height="${BAR}" fill="${fill}"/>`;
    const e = x + width;
    const s = (e - r).toFixed(1);
    const arc = `A${r},${r} 0 0 1`;
    const d = `M${x},${y}H${s}${arc} ${e.toFixed(1)},${y + r}V${y + BAR - r}${arc} ${s},${y + BAR}H${x}Z`;
    return `<path d="${d}" fill="${fill}"/>`;
}

/** The palette index of each series, so a series has one color in every chart */
const SERIES = { Worker: 0, Workers: 0, Producer: 1, Database: 2 };

/**
 * @param {{ title: string, subtitle: string, legend?: string[], unit: string, max?: number,
 *   rows: { label: string, parts: number[], value: string }[] }} chart `max`: the end of the axis, when a row would
 *     dwarf the others; its bar stops at the edge, and its value says so
 * @param {keyof typeof THEMES} theme
 * @returns {string} the SVG document
 */
function svg({ title, subtitle, legend, rows, unit, max }, theme) {
    const c = THEMES[theme];
    /**
     * @param {number} part
     * @returns {string} The color of the part's series.
     */
    const color = part => c.series[legend ? SERIES[/** @type {keyof typeof SERIES} */ (legend[part])] : 0];
    const tk = ticks(max ?? Math.max(...rows.map(r => sum(r.parts))));
    const end = /** @type {number} */ (tk.at(-1));
    const scale = (/** @type {number} */ v) => ((X1 - X0) * Math.min(v, end)) / end;
    const top = legend ? 84 : 64;
    const plotH = rows.length * ROW;
    const H = top + plotH + 34;
    const out = [
        `<svg xmlns="${SVG_NS}" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" ${FONT} role="img" aria-label="${title}">`,
        `<title>${title}</title>`,
        `<text x="0" y="20" font-size="16" font-weight="600" fill="${c.text}">${title}</text>`,
        `<text x="0" y="42" font-size="13" fill="${c.muted}">${subtitle}</text>`,
    ];
    let lx = 0;
    for (const [i, name] of (legend ?? []).entries()) {
        out.push(
            `<rect x="${lx}" y="56" width="10" height="10" rx="2" fill="${color(i)}"/>`,
            `<text x="${lx + 15}" y="65" font-size="12" fill="${c.muted}">${name}</text>`,
        );
        lx += 15 + name.length * 7 + 18;
    }
    for (const t of tk) {
        const x = (X0 + scale(t)).toFixed(1);
        out.push(
            `<line x1="${x}" y1="${top - 4}" x2="${x}" y2="${top + plotH}" stroke="${t === 0 ? c.axis : c.grid}"/>`,
            `<text x="${x}" y="${top + plotH + 18}" font-size="11" fill="${c.muted}" text-anchor="middle">${t}</text>`,
        );
    }
    out.push(`<text x="${X1 + 22}" y="${top + plotH + 18}" font-size="11" fill="${c.muted}">${unit}</text>`);
    for (const [i, row] of rows.entries()) {
        const y = top + i * ROW + (ROW - BAR) / 2;
        const bold = row.label === 'sqlane' ? ' font-weight="600"' : '';
        const label = `x="${LABEL_W}" y="${y + 13}" font-size="13" fill="${c.text}" text-anchor="end"${bold}`;
        out.push(`<text ${label}>${row.label}</text>`);
        let x = X0;
        for (const [j, v] of row.parts.entries()) {
            const last = j === row.parts.length - 1;
            const w = scale(v);
            // A 2px gap between stacked segments
            const cut = v > end;
            out.push(barShape({ x, y, w: last ? w : Math.max(w - 2, 1), fill: color(j), round: last && !cut }));
            x += w;
            // A bar cut at the end of the axis: two slashes in the page color mark the break
            if (cut) {
                for (const dx of [16, 9]) {
                    const at = `M${(x - dx).toFixed(1)},${y + BAR + 2}l6,${-(BAR + 4)}`;
                    out.push(`<path d="${at}" stroke="${c.page}" stroke-width="2.5"/>`);
                }
            }
        }
        const vx = (Math.max(x, X0 + 2) + 6).toFixed(1);
        out.push(`<text x="${vx}" y="${y + 13}" font-size="13" fill="${c.text}"${bold}>${row.value}</text>`);
    }
    out.push('</svg>');
    return `${out.join('\n')}\n`;
}

const millions = (/** @type {number} */ n) => n / 1e6;
const fixed = (/** @type {number} */ n) => (n >= 100 ? n.toFixed(0) : n.toFixed(n < 0.1 ? 2 : 1));

/**
 * @param {string} library
 * @param {string} dialect
 * @returns {any} the drain of the library on that database, in phase B (one library at a time)
 */
function drainRun(library, dialect) {
    const found = results.perf.find((/** @type {any} */ r) => (
        r.library === library && r.workload === 'drain' && r.timing && r.dialect === dialect && r.names === 1000
    ));
    if (!found) throw new Error(`no drain run of ${library} on ${dialect}`);
    return found;
}

const DRAINS = [
    ...LIBS.map(({ id, label }) => ({ id, label, dialect: 'postgres' })),
    { id: 'bullmq', label: 'BullMQ* (Redis)', dialect: 'redis' },
].map(({ id, label, dialect }) => ({ label, r: drainRun(id, dialect) }));

const charts = {
    perf_cpu_per_job: {
        title: 'CPU instructions per job, steady load',
        subtitle: 'PostgreSQL 17, 1000 job names, 20 jobs/s with an INSERT each. *: after the COMMIT. Lower is better.',
        legend: ['Worker', 'Producer', 'Database'],
        unit: 'M instr.',
        rows: LIBS.map(({ id, label }) => {
            const r = run(id, 'steady');
            const parts = [r.worker, r.producer, r.db].map(p => millions(p.instructions) / r.completed);
            return { label, parts, value: `${fixed(sum(parts))} M` };
        }),
    },
    perf_latency: {
        title: 'From enqueue to handler start, median',
        subtitle: 'PostgreSQL 17, steady load, one library at a time. Lower is better.',
        unit: 'ms',
        rows: LIBS.map(({ id, label }) => {
            const r = run(id, 'steady', true);
            return { label, parts: [r.latencyP50Ms], value: `${r.latencyP50Ms} ms · p99 ${r.latencyP99Ms} ms` };
        }),
    },
    perf_idle: {
        title: 'Database cost while idle, 1000 job names',
        subtitle: 'PostgreSQL 17, no jobs. Database instructions per second. Lower is better.',
        unit: 'M/s',
        rows: LIBS.map(({ id, label }) => {
            const r = run(id, 'idle');
            const v = millions(r.db.instructions) / r.seconds;
            return { label, parts: [v], value: `${fixed(v)} M/s` };
        }),
    },
    perf_drain: {
        title: 'Time to drain 10,000 jobs',
        subtitle: 'PostgreSQL 17 (BullMQ also on Redis), 1000 job names, one library at a time. *: after the COMMIT. Lower is better.',
        unit: 's',
        // The axis ends at the slowest library that finished: a stopped drain runs off it
        max: Math.max(...DRAINS.filter(({ r }) => r.drainMs).map(({ r }) => r.drainMs / 1000)),
        rows: DRAINS.map(({ label, r }) => {
            if (!r.drainMs) {
                return { label, parts: [r.stoppedAfterMs / 1000], value: `> ${Math.round(r.stoppedAfterMs / 1000)} s, stopped` };
            }
            const s = r.drainMs / 1000;
            // pg-boss's slots are per queue: up to 8 per job name, where the others run 8 jobs at once in all
            const note = r.library === 'pg-boss' ? ' · up to 8,000 at once' : '';
            return { label, parts: [s], value: `${s.toFixed(1)} s${note}` };
        }),
    },
    perf_cron: {
        title: 'CPU instructions per fired job of a schedule, 3 workers',
        subtitle: 'PostgreSQL 17, 1000 schedules due every minute, 3 workers. *: not transactional. Lower is better.',
        legend: ['Workers', 'Database'],
        unit: 'M instr.',
        rows: LIBS.map(({ id, label }) => {
            const r = fireRun(id, 3);
            // The CPU window holds one slot of each schedule per minute
            const slots = (r.schedules * r.seconds) / 60;
            const parts = [r.worker, r.db].map(p => millions(p.instructions) / slots);
            return { label, parts, value: `${fixed(sum(parts))} M` };
        }),
    },
};

mkdirSync(OUT, { recursive: true });
for (const [name, chart] of Object.entries(charts)) {
    for (const theme of /** @type {const} */ (['light', 'dark'])) {
        writeFileSync(join(OUT, `${name}_${theme}.svg`), svg(chart, theme));
    }
}
console.log(`wrote ${Object.keys(charts).length * 2} charts to ${OUT}`);
