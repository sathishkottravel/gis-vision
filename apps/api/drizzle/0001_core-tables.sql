CREATE TYPE "public"."capture_status" AS ENUM('pending', 'ready');--> statement-breakpoint
CREATE TYPE "public"."detector_kind" AS ENUM('manual', 'ml');--> statement-breakpoint
CREATE TABLE "capture" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" "capture_status" DEFAULT 'pending' NOT NULL,
	"blob_key" text NOT NULL,
	"content_type" text NOT NULL,
	"byte_size" bigint NOT NULL,
	"idempotency_key" text,
	"captured_at" timestamp with time zone NOT NULL,
	"geom" geometry(Point, 4326),
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "capture_blob_key_unique" UNIQUE("blob_key"),
	CONSTRAINT "capture_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "capture_byte_size_positive" CHECK ("capture"."byte_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "detector" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"kind" "detector_kind" NOT NULL,
	"output_schema" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "capture_geom_gist" ON "capture" USING gist ("geom");