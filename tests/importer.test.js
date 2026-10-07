import test from "node:test";
import assert from "node:assert/strict";
import { buildWorld } from "./fixtures.js";

const sourceRow = (over = {}) => ({
  source_no: "IMP-SRC", version: "v1", kind: "enterprise_survey",
  title: "导入来源", summary: "原始摘要",
  effective_from: "2026-01-01", expires_at: "2027-01-01", org_id: "org-imp",
  ...over,
});

test("批量导入：新内容入库，相同 来源版本+摘要 去重，编号相同内容变化进复核", () => {
  const { s } = buildWorld();
  const result = s.importBatch([
    sourceRow(),
    sourceRow(), // 完全重复
    sourceRow({ summary: "编号版本相同但摘要变了" }), // -> 复核
  ], { batch_id: "B1" });

  assert.equal(result.imported.length, 1);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.reviews.length, 1);
  assert.equal(s.repository.sources.size >= 1, true);
  assert.equal(s.importer.pendingReviews().length, 1);
});

test("批次可安全重跑：已入库识别为 duplicate，待复核条目不重复入队", () => {
  const { s } = buildWorld();
  const first = s.importBatch([sourceRow(), sourceRow({ summary: "变化" })], { batch_id: "B1" });
  const changedReview = first.reviews[0];
  const second = s.importBatch([
    sourceRow(),
    sourceRow({ summary: "变化" }),
  ], { batch_id: "B2" });

  assert.equal(second.imported.length, 0);
  assert.equal(second.duplicates.length, 1);
  assert.equal(second.reviews.length, 1);
  assert.equal(second.reviews[0].review_id, changedReview.review_id, "复用既有复核条目");
  assert.equal(s.importer.pendingReviews().length, 1);
});

test("复核通过后按新摘要入库；复核驳回则该内容始终被拦截", () => {
  const { s } = buildWorld();
  // 先入库原始版本，再导入“编号+版本相同、摘要变化”的行 -> 复核
  s.importBatch([sourceRow()], { batch_id: "B0" });
  const { reviews } = s.importBatch([sourceRow({ summary: "变化内容" })], { batch_id: "B1" });
  assert.equal(reviews.length, 1);
  const accepted = s.resolveReview(reviews[0].review_id, "accept", "reviewer-1");
  assert.equal(accepted.source.summary, "变化内容");
  // 同内容再导入 -> duplicate（指向复核通过产生的来源）
  const rerun = s.importBatch([sourceRow({ summary: "变化内容" })], { batch_id: "B2" });
  assert.equal(rerun.duplicates.length, 1);
  assert.equal(rerun.imported.length, 0);

  const { reviews: r2 } = s.importBatch([sourceRow({ summary: "另一种变化" })], { batch_id: "B3" });
  s.resolveReview(r2[0].review_id, "reject", "reviewer-1");
  const afterReject = s.importBatch([sourceRow({ summary: "另一种变化" })], { batch_id: "B4" });
  assert.equal(afterReject.imported.length, 0);
  assert.equal(afterReject.duplicates[0].reason, "review_rejected");
});

test("非法行不会污染批次，错误按行号返回", () => {
  const { s } = buildWorld();
  const result = s.importBatch([
    sourceRow(),
    sourceRow({ version: "v2", summary: "另一家来源", expires_at: "2025-01-01" }), // 窗口非法
  ], { batch_id: "B1" });
  assert.equal(result.imported.length, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].index, 1);
});
