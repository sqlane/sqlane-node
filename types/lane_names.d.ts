/**
 * @param {unknown} lane A lane definition (its name), or a name.
 * @param {string} where The caller, for the error.
 * @param {string} [label] What the error calls it. Default: `the lane`.
 * @returns {string} The name of the lane: it matches NAME_REGEXP. Else an `InvalidOptionsError`.
 */
export declare function checkedLaneName(lane: unknown, where: string, label?: string): string;
