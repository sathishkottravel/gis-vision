-- Built-in `manual` detector (spec detector-registry): a human annotating a capture.
-- Its output schema accepts free-form attributes; it must stay within the supported subset
-- (`checkDetectorSchema` in packages/schemas). Later versions of it get their own migration.
INSERT INTO "detector" ("id", "name", "version", "kind", "output_schema")
VALUES (
	'manual',
	'Manual annotation',
	1,
	'manual',
	'{
		"$schema": "https://json-schema.org/draft/2020-12/schema",
		"title": "Manual annotation attributes",
		"description": "Free-form attributes recorded by a human annotator.",
		"type": "object",
		"additionalProperties": true
	}'::jsonb
)
ON CONFLICT ("id") DO NOTHING;
