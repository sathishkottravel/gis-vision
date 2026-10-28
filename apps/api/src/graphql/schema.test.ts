import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { printSortedSchema } from './schema.js';

const SDL_FILE = fileURLToPath(new URL('../../schema.graphql', import.meta.url));

describe('published GraphQL schema (design D10)', () => {
  it('matches the schema the server builds', async () => {
    const committed = await readFile(SDL_FILE, 'utf8').catch(() => '');

    expect(
      committed.replaceAll('\r\n', '\n'),
      'apps/api/schema.graphql is out of date: run `pnpm --filter @gis-vision/api graphql:schema`',
    ).toBe(printSortedSchema());
  });

  it('has no Mutation or Subscription type (read-only)', () => {
    expect(printSortedSchema()).not.toMatch(/^type (Mutation|Subscription)\b/m);
  });
});
