// The schedules on MariaDB: the SQL of MySQL (mysql_schedules.js), with the insert of the jobs of MariaDB.
import { insertJobsMariadb } from './mariadb_enqueue.js';
import { fireSlotsWith } from './mysql_schedules.js';

export { readSchedules, registerSchedules } from './mysql_schedules.js';

/** @type {import('./mysql_schedules.js').FireSlots} */
export const fireSlots = fireSlotsWith(insertJobsMariadb);
