import { configDefaults, defineConfig } from 'vitest/config';

const sources = '{apps,packages}/*/src/**';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: [`${sources}/*.test.ts`],
          // `*.int.test.ts` also matches `*.test.ts`, so exclude it explicitly.
          exclude: [...configDefaults.exclude, '**/*.int.test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          include: [`${sources}/*.int.test.ts`],
        },
      },
    ],
  },
});
