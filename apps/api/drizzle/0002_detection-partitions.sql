-- Design D6/D7: detections are time series, range-partitioned by month on observed_at.
-- Partitioned tables need the partition key in every unique constraint, hence PK (id, observed_at);
-- nothing may reference `detection` with a foreign key. Mapped (not managed) in src/db/detection.ts.
CREATE TABLE "detection" (
	"id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"capture_id" uuid NOT NULL REFERENCES "capture" ("id"),
	"detector_id" text NOT NULL REFERENCES "detector" ("id"),
	"label" text NOT NULL,
	"confidence" real CHECK ("confidence" BETWEEN 0 AND 1),
	"bbox_px" jsonb NOT NULL,
	"geom" geometry(Point, 4326),
	"observed_at" timestamp with time zone NOT NULL,
	"attributes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	PRIMARY KEY ("id", "observed_at")
) PARTITION BY RANGE ("observed_at");
--> statement-breakpoint
-- Monthly partitions for the 12 months before and after the current month (25 in total),
-- named detection_yYYYYmMM. Anything outside that range lands in the DEFAULT partition.
DO $$
DECLARE
  month_start date;
BEGIN
  FOR i IN -12..12 LOOP
    month_start := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => i))::date;
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF "detection" FOR VALUES FROM (%L) TO (%L)',
      'detection_' || to_char(month_start, '"y"YYYY"m"MM'),
      month_start::timestamp AT TIME ZONE 'UTC',
      (month_start + interval '1 month')::timestamp AT TIME ZONE 'UTC'
    );
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE TABLE "detection_default" PARTITION OF "detection" DEFAULT;
--> statement-breakpoint
-- Indexes on the parent cascade to every partition, including ones created later.
CREATE INDEX "detection_geom_gist" ON "detection" USING gist ("geom");
--> statement-breakpoint
CREATE INDEX "detection_observed_at_brin" ON "detection" USING brin ("observed_at");
--> statement-breakpoint
CREATE INDEX "detection_capture_id_idx" ON "detection" USING btree ("capture_id");
--> statement-breakpoint
CREATE INDEX "detection_detector_id_observed_at_idx" ON "detection" USING btree ("detector_id", "observed_at");
