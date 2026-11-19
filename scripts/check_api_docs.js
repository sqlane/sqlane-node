// Every method of the Sqlane interface (src/sqlane.ts) is documented for the editor: a description, a `@param` with
// text for each parameter, and a `@returns` with text unless it returns void. oxlint's JSDoc rules check the typedefs
// of src/types.js, but not the members of a TypeScript interface. No TypeScript API: TypeScript 7 has none in JS, so
// this reads the one interface of the file, whose shape it knows: it ends the file, and each member is a method.
// Usage: node scripts/check_api_docs.js [file]
import { readFileSync } from 'node:fs';

const FILE = 'src/sqlane.ts';

/**
 * @param {string} text
 * @param {number} from An opening bracket.
 * @returns {number} The index of its closing bracket: `()`, `{}`, `<>` and `[]` nest; `=>` is not a bracket.
 */
function closingOf(text, from) {
    let depth = 0;

    for (let index = from; index < text.length; index++) {
        const char = text[index];

        if ('({[<'.includes(char)) {
            depth++;
        } else if (')}]'.includes(char) || (char === '>' && text[index - 1] !== '=')) {
            depth--;

            if (depth === 0) {
                return index;
            }
        }
    }

    throw new Error('unbalanced brackets');
}

/**
 * @param {string} list The parameters, without their parentheses.
 * @returns {string[]} Their names.
 */
function paramNames(list) {
    /** @type {string[]} */
    const names = [];
    let depth = 0;
    let start = 0;

    for (let index = 0; index <= list.length; index++) {
        const char = list[index];

        if (char !== undefined && '({[<'.includes(char)) {
            depth++;
        } else if (char !== undefined && (')}]'.includes(char) || (char === '>' && list[index - 1] !== '='))) {
            depth--;
        } else if ((char === ',' && depth === 0) || char === undefined) {
            const name = /^\s*(\w+)\??\s*:/u.exec(list.slice(start, index))?.[1];

            if (name) {
                names.push(name);
            }

            start = index + 1;
        }
    }

    return names;
}

/** Return types that need no `@returns` */
const NO_RESULT = new Set(['void', 'Promise<void>']);

/**
 * @param {string} source A file that ends with `export interface Sqlane<…> { … }`.
 * @returns {string[]} The problems: a member without docs, a parameter or a return value without text.
 */
export function checkApiDocs(source) {
    const head = /export interface Sqlane<[^>]*> \{/u.exec(source);

    if (!head) {
        return ['no `export interface Sqlane<…> {`'];
    }

    // Its end: the last `}` of the file. The JSDoc between has brackets of its own, so they can't be counted
    const body = source.slice(head.index + head[0].length, source.lastIndexOf('}'));
    const problems = [];
    // A member: its JSDoc, if any, then its name, its type parameters and its parameters, up to the `;` at depth 0
    const member = /(?:\/\*\*(?<doc>(?:[^*]|\*(?!\/))*)\*\/\s*)?(?<name>\w+)(?<generics><)?/gu;
    let match;

    while ((match = member.exec(body))) {
        const { doc, name, generics } = /** @type {Record<string, string | undefined>} */ (match.groups);
        let at = match.index + match[0].length;

        if (generics) {
            at = closingOf(body, at - 1) + 1;
        }

        if (body[at] !== '(') {
            problems.push(`${name}: not a method`);
            member.lastIndex = body.indexOf(';', at) + 1;
            continue;
        }

        const close = closingOf(body, at);
        const end = body.indexOf(';', close);
        const returns = body.slice(close + 1, end).replace(/^\s*:\s*/u, '').trim();

        member.lastIndex = end + 1;

        if (!doc) {
            problems.push(`${name}: no JSDoc`);
            continue;
        }

        const lines = doc.split('\n').map(line => line.replace(/^\s*\*?\s?/u, ''));
        const firstTag = lines.findIndex(line => line.startsWith('@'));
        const description = (firstTag === -1 ? lines : lines.slice(0, firstTag)).join(' ').trim();

        if (!description) {
            problems.push(`${name}: no description`);
        }

        for (const param of paramNames(body.slice(at + 1, close))) {
            if (!new RegExp(`@param ${param}\\s+\\S`, 'u').test(doc)) {
                problems.push(`${name}: no @param text for "${param}"`);
            }
        }

        if (!NO_RESULT.has(returns) && !/@returns\s+\S/u.test(doc)) {
            problems.push(`${name}: no @returns text`);
        }
    }

    return problems;
}

if (process.argv[1] === import.meta.filename) {
    const file = process.argv[2] ?? FILE;
    const problems = checkApiDocs(readFileSync(file, 'utf8'));

    for (const problem of problems) {
        process.stderr.write(`${file}: ${problem}\n`);
    }

    process.exitCode = problems.length ? 1 : 0;
}
