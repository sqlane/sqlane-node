// The lane that a method of the API is given: a lane definition, or the name of a lane.
import { InvalidOptionsError } from './errors.js';
import { isPlainObject, NAME_REGEXP } from './validate.js';

/**
 * @param {unknown} lane A lane definition (its name), or a name.
 * @param {string} where The caller, for the error.
 * @param {string} [label] What the error calls it. Default: `the lane`.
 * @returns {string} The name of the lane: it matches NAME_REGEXP. Else an `InvalidOptionsError`.
 */
export function checkedLaneName(lane, where, label = 'the lane') {
    const name = isPlainObject(lane) ? lane.name : lane;

    if (typeof name !== 'string' || !NAME_REGEXP.test(name)) {
        throw new InvalidOptionsError(`${where}: ${label} must be a lane definition or a name matching ${NAME_REGEXP}`);
    }

    return name;
}
