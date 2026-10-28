import { createRequire } from 'node:module';
import { configDefaults, defineConfig } from 'vitest/config';

const sources = '{apps,packages,deploy}/*/src/**';

// graphql 16 ships CJS (`main`) and ESM (`module`) builds without an `exports` map. Vite would
// pick the ESM build for our code while Node loads the CJS build for Pothos and Yoga, giving two
// copies ("Cannot use GraphQLScalarType from another module or realm"). Pin every import to the
// CJS entry that Node itself resolves.
const graphqlEntry = createRequire(new URL('apps/api/package.json', import.meta.url)).resolve(
  'graphql',
);
const resolve = { alias: [{ find: /^graphql$/, replacement: graphqlEntry }] };

export default defineConfig({
  test: {
    projects: [
      {
        resolve,
        test: {
          name: 'unit',
          include: [`${sources}/*.test.ts`],
          // `*.int.test.ts` also matches `*.test.ts`, so exclude it explicitly.
          exclude: [...configDefaults.exclude, '**/*.int.test.ts'],
        },
      },
      {
        resolve,
        test: {
          name: 'integration',
          include: [`${sources}/*.int.test.ts`],
          // Starts PostGIS and RustFS once per run (Testcontainers; Docker must be running).
          globalSetup: ['apps/api/src/testing/global-setup.ts'],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
