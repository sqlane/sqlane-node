// MikroORM 6, for the tests of @sqlane/core: its drivers resolve @mikro-orm/core 6 from this package.
export { MikroORM as MariaDbMikroORM } from '@mikro-orm/mariadb';
export { MikroORM as MySqlMikroORM } from '@mikro-orm/mysql';
export { MikroORM as PostgreSqlMikroORM } from '@mikro-orm/postgresql';

// MikroORM 6 compares its version with the @mikro-orm/* packages of the package.json in the working directory: the
// root's, with MikroORM 7 for the other tests
// oxlint-disable-next-line node/no-process-env -- the only switch of that check
process.env.MIKRO_ORM_ALLOW_VERSION_MISMATCH = '1';
