# Inventory device connection and handoff implementation plan

> Use subagent-driven-development for isolated implementation tasks and independent review. User has approved automatic ERP session detection, one-click connection, pairing-code fallback, and safe cross-computer task takeover.

**Goal:** Connect a new extension through the logged-in ERP account and safely move execution between computers without repeating a possible upload.

**Architecture:** Existing same-origin ERP session authentication authorizes a short-lived, proof-bound connection grant. Only the extension background exchanges it for a persistent scoped device credential. ERP stores the selected executor and transfers ownership atomically; issued upload permits are never recreated during handoff.

**Stack:** Existing Hono Workers, D1/R2, React, MV3 extension, Vitest and Miniflare.

- [x] Session connection backend: administrator session discovery, short-lived proof-bound grant, replay-safe redemption, existing pair-code fallback unchanged. No passwords, session cookies or Amazon credentials exposed to extension.
- [x] Device handoff backend: administrator-selected executor; atomic ownership/lease replacement; fresh preflight for never-submitted jobs; filename-only reconciliation for possibly submitted jobs; durable handoff audit and old-device retirement proof. Preserve current live trial and its upload evidence.
- [x] Extension: detect trusted ERP tabs using a restricted content-script relay; one-click connect UI; pairing-code fallback; show executor and handoff status; archive retired local work with server proof; never discard unresolved receipts or grant another upload during handoff.
- [x] ERP UI: show selected executor and online state; select another paired computer and safely take over current work; display execution versus reconciliation transfer mode.
- [x] Tests first for authorization, wrong/expired proof, idempotent redemption, simultaneous executor selection, stale old-device requests, transfer during prepare, submitted/unknown tasks, restart and lost acknowledgements. Actual isolated browser profiles stand in for two computers.
- [x] Review, typecheck, targeted/full tests, real local Worker and extension integration; package v0.4.0 and deploy additive migration/API/UI. Preserve hourly read-only patrol; do not enable full automatic uploads.
- [x] Real connected-device check and takeover of existing submitted job for read-only reconciliation where available. No extra Amazon stock upload is necessary for this change; use isolated fixtures for upload races.

## Required invariants

- Stock rules remain unchanged: API authoritative, target five, no REMOVE, image 300404 ignored when active, restrictions win.
- A newly connected computer does not silently steal current work. First executor defaults safely to the existing owner/device; later changes are explicit administrator actions.
- One selected executor at a time; device selection and in-flight ownership fencing commit together.
- Once a CSV may have been issued, the new owner can only observe the same filename and reconcile. Absence from the visible results page is not permission to reupload.
- Old device reconnects cannot submit new commands for a transferred lease. Retired local receipts are preserved under their original identity.
- Manual uploads outside the managed ERP task protocol are not globally deduplicated.
- Record actual two-profile test results separately from physical two-computer verification.

## Completion evidence

365 tests across 45 files passed; typecheck, build and production dry-run passed. Two actual isolated Edge profiles running MV3 + local Workers/D1/R2 completed one-click connection, lost acknowledgement, executor takeover, old-profile restart, exact receipt archive and a single fixture upload. Backend and extension independent spec/quality reviews approved. Migration 0045 and API/UI version 5c760dba-0689-4769-b100-5b49edd6a076 deployed; v0.4.0 ZIP available in ERP. User reloaded production extension; current ERP admin/store detected and existing pairing preserved. Production still has one device and one original upload attempt, trial COMPLETE at API stock 5. No second physical computer or additional real inventory upload used; no active production task required takeover. Screenshots and detailed record are in workbench/docs/2026-11-16-库存联调接入说明.md.
