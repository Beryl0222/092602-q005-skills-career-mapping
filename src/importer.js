/**
 * 批量导入：以“来源版本 + 摘要”内容指纹去重。
 *
 *  - 指纹已入库          -> duplicate，跳过；
 *  - source_no+version 相同但摘要变化（指纹不同） -> review，进入复核队列，不直接入库；
 *  - 全新内容           -> imported，登记来源（及其证据行）。
 * 整个批次可安全重跑：已入库的只会再次被识别为 duplicate。
 */
import { frozen, fingerprint } from "./domain.js";

let seq = 0;
const nextId = (p) => `${p}-${(++seq).toString(36)}${Date.now().toString(36)}`;

export class Importer {
  constructor(repo, evidenceStore) { this.repo = repo; this.evidence = evidenceStore; }

  /**
   * @param rows 来源载荷数组，每项可带 evidence: [...] 一起导入。
   */
  importBatch(rows, { batch_id = null, operator = "system" } = {}) {
    const id = batch_id || nextId("batch");
    const imported = [];
    const duplicates = [];
    const reviews = [];
    const errors = [];

    rows.forEach((row, index) => {
      try {
        const source_no = String(row.source_no ?? "").trim();
        const version = String(row.version ?? "").trim();
        const summary = String(row.summary ?? "").trim();
        const digest = fingerprint([source_no, version, summary]);

        // 1) 完全相同内容已入库（可能来自不同批次）。
        const sameDigest = this.repo.sources.find((s) => s.digest === digest)[0];
        if (sameDigest) {
          duplicates.push({ index, source_no, version, source_id: sameDigest.source_id, digest });
          return;
        }

        // 2) 编号+版本相同而内容变化 -> 复核（同内容的待复核/已裁定条目不重复入队）。
        const priorReview = this.repo.reviews.find(
          (r) => r.source_no === source_no && r.version === version && r.digest === digest)[0];
        if (priorReview) {
          if (priorReview.status === "rejected") {
            duplicates.push({ index, source_no, version, reason: "review_rejected", digest });
          } else {
            reviews.push(priorReview); // pending 或已 accepted，重跑批次直接复用
          }
          return;
        }
        const sameNoVersion = this.repo.sources.find(
          (s) => s.source_no === source_no && s.version === version)[0];
        if (sameNoVersion) {
          const reviewId = nextId("revq");
          const review = frozen({
            review_id: reviewId, batch_id: id, index,
            source_no, version, digest,
            existing_source_id: sameNoVersion.source_id,
            existing_digest: sameNoVersion.digest,
            payload: frozen({ ...row }),
            status: "pending",
            raised_by: String(operator),
            raised_at: new Date().toISOString(),
          });
          this.repo.reviews.insert(reviewId, review);
          reviews.push(review);
          return;
        }

        // 3) 新来源登记。
        const source = this.evidence.registerSource({ ...row });
        const evidenceRows = [];
        for (const ev of row.evidence ?? []) {
          evidenceRows.push(this.evidence.addEvidence({ ...ev, source_id: source.source_id }));
        }
        imported.push({ source, evidence: evidenceRows });
      } catch (err) {
        errors.push({ index, error: err.message });
      }
    });

    const batch = frozen({
      batch_id: id,
      total: rows.length,
      imported_source_ids: imported.map((x) => x.source.source_id),
      duplicate_digests: duplicates.map((d) => d.digest),
      review_ids: reviews.map((r) => r.review_id),
      errors,
      operator: String(operator),
      imported_at: new Date().toISOString(),
    });
    this.repo.importBatches.insert(id, batch);
    return { batch, imported, duplicates, reviews, errors };
  }

  pendingReviews() { return this.repo.reviews.find((r) => r.status === "pending"); }

  /** 复核裁定：accept 按载荷登记来源；reject 留存否决记录。 */
  resolveReview(reviewId, decision, reviewerId) {
    const review = this.repo.reviews.get(String(reviewId));
    if (!review) throw new Error(`复核条目不存在：${reviewId}`);
    if (review.status !== "pending") throw new Error("该复核条目已裁定");
    if (!["accept", "reject"].includes(decision)) throw new Error("decision 只能是 accept 或 reject");

    if (decision === "accept") {
      const { evidence: evRows, ...sourcePayload } = review.payload;
      // 复核通过意味着“同编号同版本的新内容”替代旧内容：先把旧行可信期截断到新行生效日。
      const existing = this.repo.sources.find(
        (s) => s.source_no === sourcePayload.source_no && s.version === sourcePayload.version)[0];
      if (existing) {
        const from = String(sourcePayload.effective_from).slice(0, 10);
        const cut = existing.expires_at > from ? from : existing.expires_at;
        this.repo.sources.put(existing.source_id, frozen({
          ...existing, expires_at: cut, superseded_by_review: review.review_id,
        }));
      }
      const source = this.evidence.registerSource({ ...sourcePayload });
      const evidenceRows = [];
      for (const ev of evRows ?? []) {
        evidenceRows.push(this.evidence.addEvidence({ ...ev, source_id: source.source_id }));
      }
      const updated = frozen({
        ...review, status: "accepted", reviewed_by: String(reviewerId),
        reviewed_at: new Date().toISOString(), accepted_source_id: source.source_id,
      });
      this.repo.reviews.put(review.review_id, updated);
      return { review: updated, source, evidence: evidenceRows };
    }

    const updated = frozen({
      ...review, status: "rejected", reviewed_by: String(reviewerId),
      reviewed_at: new Date().toISOString(),
    });
    this.repo.reviews.put(review.review_id, updated);
    return { review: updated };
  }
}
