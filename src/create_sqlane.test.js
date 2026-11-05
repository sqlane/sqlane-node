import { expect, test } from 'vitest';
import { ConfigError } from './errors.js';
import { createSqlane } from './create_sqlane.js';

test('createSqlane needs an adapter', () => {
    expect(() => createSqlane(/** @type {any} */ ({}))).toThrow(ConfigError);
});
