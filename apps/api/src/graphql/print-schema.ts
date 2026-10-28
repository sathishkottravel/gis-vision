// Writes the sorted SDL to apps/api/schema.graphql (`pnpm --filter @gis-vision/api graphql:schema`).
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { printSortedSchema } from './schema.js';

const target = fileURLToPath(new URL('../../schema.graphql', import.meta.url));
await writeFile(target, printSortedSchema());
console.log(`Wrote ${target}`);
