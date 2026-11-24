// The runner of a test instance, and the lanes of the tests by name: one definition per name, so that the producer
// side and the handlers of a test share it.
import { createRunner } from '../../src/create_runner.js';
import { defineHandler } from '../../src/define_handler.js';
import { defineLane } from '../../src/define_lane.js';
import { defineSchedule } from '../../src/define_schedule.js';

/** @typedef {import('../../src/types.js').LaneDefinition} LaneDefinition */

/** @type {WeakMap<object, import('../../src/sqlane.js').Runner>} */
const runners = new WeakMap();
/** @type {Map<string, LaneDefinition>} */
const lanes = new Map();

/**
 * The runner of the instance: created at the first call, with the options of that call.
 * @param {import('../../src/types.js').Sqlane<any>} sqlane
 * @param {import('../../src/types.js').RunnerOptions} [options]
 * @returns {import('../../src/sqlane.js').Runner}
 */
export function runnerOf(sqlane, options) {
    let runner = runners.get(sqlane);

    if (!runner) {
        runner = createRunner(sqlane, options);
        runners.set(sqlane, runner);
    }

    return runner;
}

/**
 * A lane of the tests, by name: a definition without options, the same one for each call.
 * @param {string} name
 * @returns {LaneDefinition}
 */
export function testLane(name) {
    let definition = lanes.get(name);

    if (!definition) {
        definition = defineLane({ name });
        lanes.set(name, definition);
    }

    return definition;
}

/**
 * @param {LaneDefinition | string} given
 * @returns {LaneDefinition}
 */
function laneOf(given) {
    return typeof given === 'string' ? testLane(given) : given;
}

/**
 * A handler of a lane: a definition, or the name of a lane of the tests.
 * @param {LaneDefinition | string} given
 * @param {import('../../src/types.js').Handler} handler
 * @param {import('../../src/types.js').HandlerOptions} [options]
 * @returns {import('../../src/types.js').LaneHandler}
 */
export function handle(given, handler, options) {
    return defineHandler(laneOf(given), handler, options);
}

/**
 * A schedule of a lane: a definition, or the name of a lane of the tests. Without a key: the key `k`.
 * @param {LaneDefinition | string} given
 * @param {Record<string, unknown>} options
 * @returns {import('../../src/types.js').ScheduleDefinition}
 */
export function schedule(given, options) {
    return defineSchedule(laneOf(given), /** @type {any} */ ({ key: 'k', ...options }));
}
