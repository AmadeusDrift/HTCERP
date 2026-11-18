> 2026-11-17 用户修正：下述原始计划的 Flex PDF 部分已被 v0.6.2 取代。标签改为 Amazon SP-API 原标 + 固定欧代合成，原标和合成结果仅缓存 ERP。已实现、发布并完成两个真实批次验收；当前规则和证据以 workbench/docs/2026-11-17-Pack订单分拣接入.md 为准。

# Pack Order Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute independent components and spec/quality reviews. Do not commit or revert unrelated existing work.

**Goal:** Existing SellerFlex plugin exports selected Pack orders, transfers complete original data, auto-sorts new rows, and archives matching native labels.
**Architecture:** Native export Blob/data URI capture; isolated content controller; trusted background persistent outbox; scoped existing device API; transactional D1 dedupe plus R2 originals; ERP batch downloads. User approved skip duplicate identity and quarantine quantity changes.
**Tech stack:** MV3 JavaScript, TypeScript, Hono/D1/R2, ExcelJS native streams, PDF-lib for lossless merge, existing React ERP.

## Task 1 Backend
- [x] Implemented tests: source parsing, counts/scope, semantic duplicate across devices, overlapping exports, quantity conflicts, transaction races, PDF slot idempotency and private download.
- [x] Add migrations/0052_pack_orders.sql (0050/0051 reserved by concurrent performance work), pack-types.ts, pack-service.ts, pack-routes.ts; reuse existing sorter and template snapshot. Keep manual runs unchanged.
- [x] Scoped device routes and larger request limit only for exact import/labels endpoints; existing bearer authentication.
- [x] Verify SQLite transaction tests and local Worker native XLSX reads.

## Task 2 Extension
- [x] Implemented tests: native export capture armed only for Pack/dialog, current-row mapping, persisted outbox and response loss, wrong sender/scope rejection, retry without reprinting.
- [x] Add pack-export-main.js, pack-content.js, pack-connector.js. Adapt manifest/background/connector narrowly. Keep credentials trusted-only and inventory pause behavior unchanged.
- [x] UX native selection → open Order List → ERP sync → official per-new-row label download → progress and ERP result link. Preserve complete files in IndexedDB, stable request IDs.
- [x] Verify isolated extension browser test with local fake Pack exporter; real browser update only after review.

## Task 3 ERP UI and output
- [x] Add Pack batch/history/download UI to existing order sorting page, using backend contracts.
- [x] ZIP contains group workbooks + grouped native PDF labels + source data; PDF merge copies original pages without re-encoding barcodes. Incomplete/conflicted items clearly shown and excluded from ready labels.
- [x] Browser and actual PDF rendering tests.

## Task 4 Release
- [x] Independent spec then quality review and fixes; full tests/typecheck/build/Worker runtime.
- [x] Apply new migration only, deploy API/UI and updated plugin folder; user reload if extension controls unavailable.
- [x] Actual selected small-batch end-to-end test, repeated sync verifies no duplicates; automatic inventory remains off.
- [x] Handoff with exact completed/pending state and artifact links.

## Acceptance result (2026-11-17)
Live v0.6.1 batch 2546973f-7427-4eeb-a63d-20c541b9f921: one order, one SKU, two units, READY. Repeated sync retains one batch/one row/two units. Downloaded ZIP preserves original XLSX bytes, correct group workbook quantity, and pixel-identical native labels. Automatic inventory remains disabled. See workbench/docs/2026-11-17-Pack订单分拣接入.md and .local/pack-backend/live-result.json for evidence. Production API/UI: 658ae1ed-5bd6-4721-8276-0866e39b579f; Jobs unchanged.
