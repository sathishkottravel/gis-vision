-- Radius search (spec geo-temporal-query, design D6): ST_DWithin on geography (meters,
-- geodesic) can only use an index built on the same expression, so these index
-- `geom::geography`. The existing geometry GiST indexes keep serving bounding boxes.
-- The predicate in src/search/spatial.ts must stay textually equal to this expression.
CREATE INDEX "capture_geog_gist" ON "capture" USING gist ((geom::geography));
--> statement-breakpoint
-- On the partitioned parent, so every partition (including detection_default and ones
-- created later) gets its own copy.
CREATE INDEX "detection_geog_gist" ON "detection" USING gist ((geom::geography));
