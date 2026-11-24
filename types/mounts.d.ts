export type LaneDefinition = import('./types.js').LaneDefinition;
export type HandlerEntry = import('./registry.js').HandlerEntry;
export type ScheduleEntry = import('./schedule.js').ScheduleEntry;
export type MountTarget = {
    added: (entries: readonly HandlerEntry[]) => void;
    removed: (entries: readonly HandlerEntry[]) => void;
};
export type MountHandle = {
    /**
     * Sync, idempotent.
     */
    unmount: () => void;
    /**
     * Its handlers.
     */
    entries: readonly HandlerEntry[];
    /**
     * Its schedules.
     */
    schedules: readonly ScheduleEntry[];
};
export type Mounts = {
    mount: (parts: unknown, where?: string) => MountHandle;
};
/** @typedef {import('./types.js').LaneDefinition} LaneDefinition */
/** @typedef {import('./registry.js').HandlerEntry} HandlerEntry */
/** @typedef {import('./schedule.js').ScheduleEntry} ScheduleEntry */
/**
 * The runner of the mounts: told of the lanes that it handles from now on, and of those that it no longer handles.
 * @typedef {{ added: (entries: readonly HandlerEntry[]) => void, removed: (entries: readonly HandlerEntry[]) => void }}
 *     MountTarget
 */
/**
 * @typedef {object} MountHandle
 * @property {() => void} unmount Sync, idempotent.
 * @property {readonly HandlerEntry[]} entries Its handlers.
 * @property {readonly ScheduleEntry[]} schedules Its schedules.
 */
/**
 * @typedef {object} Mounts
 * @property {(parts: unknown, where?: string) => MountHandle} mount
 */
/**
 * @param {object} params
 * @param {import('./registry.js').Registry} params.registry
 * @param {import('./scheduler.js').Scheduler} params.scheduler
 * @param {MountTarget} params.runner
 * @returns {Mounts}
 */
export declare function createMounts({ registry, scheduler, runner }: {
    registry: import('./registry.js').Registry;
    scheduler: import('./scheduler.js').Scheduler;
    runner: MountTarget;
}): Mounts;
