# Proposal

> **Skeleton.** Planned in detail when Phase 2.5 is archived. Features are implemented one at a time, in order.

## Why

The UI is still hand-written pages. This phase makes it generated: entities come from GraphQL introspection and detector attribute forms from detector JSON Schemas. A new detector type then needs no frontend code, which is the base the later ML detectors plug into.

## What Changes

- **F3.1 App shell:** Vite + React app with routing, a GraphQL client and a layout that hosts the existing map page.
- **F3.2 Introspection-driven views:** generic list and detail views generated from the GraphQL schema.
- **F3.3 Detector forms:** JSON Forms renderer for detector output schemas, restricted to the supported JSON Schema subset, with custom renderers where needed.
- **F3.4 Image annotation:** draw a bounding box on a capture image, fill the generated form, and create the detection.
- **F3.5 Detector registration:** register a new detector and its schema through the API (the schema itself is validated), and it appears in the UI without a rebuild.
- **F3.6 End-to-end tests:** Playwright covering upload -> annotate -> visible on the map.

## Capabilities

### New Capabilities
- `schema-driven-ui`: rendering of lists, forms, annotation and map from server-provided schemas.

### Modified Capabilities
- `detector-registry`: adds runtime registration of detectors and validation of their schemas.

## Exit Criteria

A detector registered through the API appears in the UI with working forms and annotation, with no rebuild. E2E tests are green in CI.

## Impact

`apps/web` (most of the work), `apps/api` (detector registration). New deps: @jsonforms/react, a GraphQL client, @playwright/test.
