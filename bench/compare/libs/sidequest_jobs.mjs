// The job classes of the Sidequest adapter: Sidequest finds a job by its class and the module that exports it. Each
// runs the handler of the current check: the inline runner runs jobs in this process.
import { Job } from 'sidequest';

/** @type {(name: string, payload: any, signal?: AbortSignal) => Promise<void>} The handler of the current check */
let handler = async () => {};

/** @param {typeof handler} func */
export function setHandler(func) {
    handler = func;
}

/**
 * @param {string} name
 * @returns {typeof Job} A job class of this name.
 */
function jobClass(name) {
    const NamedJob = class extends Job {
        /**
         * @param {object} payload
         * @returns {Promise<void>}
         */
        run(payload) {
            return handler(name, payload, this.abortSignal);
        }
    };

    Object.defineProperty(NamedJob, 'name', { value: name });

    return NamedJob;
}

export const order_created = jobClass('order_created');
export const later = jobClass('later');
export const flaky = jobClass('flaky');
export const slow = jobClass('slow');
export const stuck = jobClass('stuck');
export const charge = jobClass('charge');
export const refund = jobClass('refund');
export const task = jobClass('task');
