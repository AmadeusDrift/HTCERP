# ERP Order Sorting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Follow the approved design and original Python scripts as executable behavior reference.

**Goal:** Add authenticated order sorting to HTC ERP with the user's current attributes/template, identical classification and workbook values, persistent history and attribute maintenance.
**Architecture:** Pure TypeScript rule engine; browser ExcelJS I/O; Hono/D1 revisioned state and immutable runs, private R2 source files; existing ERP navigation and roles.
**Tech Stack:** TypeScript, React, Hono, D1, R2, ExcelJS, JSZip, Vitest, isolated browser tests.

## Task 1: Compatible rule engine and workbook adapter
- [x] Create failing tests in workbench/tests/integration/order-sorting-rules.test.ts and order-sorting-workbook.test.ts. Required assertions: exact D SKU wins over longer C prefix; duplicate best-rank categories throw; known A overrides ZT keyword; keyword JA+HX wins; absent categories become待确认; duplicate SKU/FNSKU sum without Transfer dedup; unmatched code appended once, unique suggestion fills A.
- [x] Implement workbench/packages/order-sorting/rules.ts and workbook.ts per design contracts. Exported detail row construction: `[index,...fields.slice(0,3),null,sku,fnsku,units,fields[3], '=IF(I'+r+'="","",H'+r+'*I'+r+')',...fields.slice(4),date.replaceAll('-','/')]`.
- [x] Verify with `pnpm exec vitest run tests/integration/order-sorting-rules.test.ts tests/integration/order-sorting-workbook.test.ts`. Reopen exported XLSX and assert values/formulas, empty image column, row styles, original raw rows.
- [x] Run saved Python sorter only against isolated fixture order/attribute/template copies and compare every output worksheet value to TS outputs. Never use default network output paths.

## Task 2: Cloud persistence, routes, authorization
- [x] Add failing service tests for revision CAS, config initialization, role policy, idempotent run IDs, same-date file conflicts, immutable run exports and concurrent runs.
- [x] Implement 0049_order_sorting.sql, packages/order-sorting/service.ts and routes.ts. Store config version/rows and asset references, runs, unique date/group output fingerprints. Use one D1 atomic batch with revision guard; conflict aborts whole batch. R2 keys are immutable content-hashed or UUID names, only registered files downloadable.
- [x] Add router registration, targeted upload request limits, operator preview/run and administrator config rules in existing index.ts/access.ts. Unknown body fields/type/size reject before writes.
- [x] Verify `pnpm exec vitest run tests/integration/order-sorting-service.test.ts` and API auth tests. Exercise actual D1 SQL via node:sqlite and production-like Worker local runtime.

## Task 3: ERP page and import/export
- [x] Add order-sorting.tsx/CSS using existing Title/Panel/Notice/ErrorBox/useAccess/useData. New main nav entry /order-sorting. State UI handles loading/empty/error, invalid file, config conflict and disabled roles.
- [x] Upload Order List, show group/row/unit/addition preview, generate via server and download individual files or ZIP. History opens immutable plan+template. Config tab lets admin import two source workbooks, edit A-K values, and download updated attributes.
- [x] Refresh dependent queries after writes. File input and successful generation clear only when appropriate, retain request UUID across retry. Never show a stale preview as generated.
- [x] Browser test uses local fake/mock data only; check actual exported workbook content and successful configuration/preview/run/history flow.

## Task 4: Review, deploy and initialize
- [x] Run targeted tests, full suite, typecheck, frontend build, Worker packaging and independent specification/code review. Resolve actionable findings.
- [x] Apply only 0049 migration to production; deploy API/UI preserving all vars/bindings and existing inventory pause. Initialize current user-provided attributes/template into private ERP state using authenticated bounded admin bootstrap; do not generate live sort runs.
- [x] Verify online route/auth, seeded 172 attribute records and template, source hashes and persisted revision; confirm automatic inventory still disabled. Document deployment versions, tests and usage link.

No commits/reverts of unrelated existing dirty files; work only in the task's new files and minimal integration hunks.
