import { inArray, sql } from 'drizzle-orm';
import { ConfigError, loadConfig } from '../config.js';
import { createInfrastructure } from '../infrastructure.js';
import { buildDemoData, DEMO_SEED_TAG } from './demo-data.js';
import { detection } from './detection.js';
import { capture } from './schema.js';

// `pnpm --filter @gis-vision/api db:seed-demo` (design D12): replaces the demo set, so a
// re-run leaves exactly one. Never touches rows without the demo tag.
try {
  const config = loadConfig();
  if (config.NODE_ENV === 'production') {
    console.error('db:seed-demo refuses to run with NODE_ENV=production.');
    process.exit(1);
  }
  const infra = createInfrastructure(config);
  try {
    const { db, blobStore } = infra;

    const previous = await db
      .select({ id: capture.id, blobKey: capture.blobKey })
      .from(capture)
      .where(sql`${capture.meta}->>'seed' = ${DEMO_SEED_TAG}`);
    if (previous.length > 0) {
      const ids = previous.map((row) => row.id);
      await db.transaction(async (tx) => {
        await tx.delete(detection).where(inArray(detection.captureId, ids));
        await tx.delete(capture).where(inArray(capture.id, ids));
      });
      for (const row of previous) {
        await blobStore.delete(row.blobKey);
      }
    }

    // Rows first, then blobs: if an upload fails, the rows are tagged and the next run removes them.
    const demo = buildDemoData(new Date());
    await db.transaction(async (tx) => {
      await tx.insert(capture).values(
        demo.map((item) => ({
          id: item.id,
          status: 'ready' as const,
          blobKey: item.blobKey,
          contentType: 'image/png',
          byteSize: item.png.byteLength,
          capturedAt: item.capturedAt,
          geom: item.geom,
          meta: item.meta,
        })),
      );
      await tx
        .insert(detection)
        .values(
          demo.flatMap((item) =>
            item.detections.map((d) => ({ ...d, captureId: item.id, detectorId: 'manual' })),
          ),
        );
    });
    for (const item of demo) {
      await blobStore.put(item.blobKey, item.png, 'image/png');
    }

    const detections = demo.reduce((sum, item) => sum + item.detections.length, 0);
    console.log(
      `Removed ${String(previous.length)} earlier demo captures; seeded ${String(demo.length)} captures and ${String(detections)} detections.`,
    );
  } finally {
    await infra.close();
  }
} catch (error) {
  // Settings are named, values are never printed.
  console.error(error instanceof ConfigError ? error.message : error);
  process.exitCode = 1;
}
