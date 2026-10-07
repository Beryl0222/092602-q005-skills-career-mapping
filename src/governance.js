/**
 * 治理层：统计周期、权重贡献、提案审批、企业利益回避、岗位-能力映射重算。
 *
 * 关键不变量：
 *  - 同一条来源在一个统计周期最多形成一条权重贡献（键：period_id|source_id）；
 *  - 与来源所属企业存在利益关系的代表不得审批（批准/驳回）对应提案；
 *  - 审批结果落成不可变贡献，映射权重由贡献重算，不手工改写；
 *  - 同期既出现“纳入”又出现“剔除”证据时映射进入 disputed，不做静默合并。
 */
import { requireFields, nonEmpty, frozen } from "./domain.js";

let seq = 0;
const nextId = (p) => `${p}-${(++seq).toString(36)}${Date.now().toString(36)}`;
const STANCES = new Set(["include", "exclude"]);

export class Governance {
  constructor(repo) { this.repo = repo; }

  /* ---------------- 统计周期 ---------------- */

  openPeriod(payload) {
    requireFields(payload, ["period_id", "starts_on", "ends_on"]);
    const period_id = nonEmpty(payload.period_id, "period_id");
    const starts_on = String(payload.starts_on).slice(0, 10);
    const ends_on = String(payload.ends_on).slice(0, 10);
    if (ends_on <= starts_on) throw new Error("统计周期必须满足 starts_on < ends_on");
    const row = frozen({
      period_id, name: String(payload.name ?? period_id),
      starts_on, ends_on, status: "open",
    });
    return this.repo.periods.insert(period_id, row);
  }

  closePeriod(periodId) {
    const period = this.#require(this.repo.periods, periodId, "统计周期");
    return this.repo.periods.put(periodId, frozen({ ...period, status: "closed" }));
  }

  /* ---------------- 利益关系与回避 ---------------- */

  /** 登记企业代表与某企业（或其来源）的利益关系。 */
  registerConflict(payload) {
    requireFields(payload, ["rep_id", "org_id"]);
    const id = payload.conflict_id || nextId("coi");
    const row = frozen({
      conflict_id: id,
      rep_id: nonEmpty(payload.rep_id, "rep_id"),
      org_id: nonEmpty(payload.org_id, "org_id"),
      source_id: payload.source_id ? String(payload.source_id) : null,
      reason: String(payload.reason ?? "未注明"),
      declared_at: payload.declared_at || new Date().toISOString(),
    });
    return this.repo.conflicts.insert(id, row);
  }

  #conflicted(repId, source) {
    if (!repId || !source) return null;
    return this.repo.conflicts.find((c) => c.rep_id === String(repId) && (
      (source.org_id && c.org_id === source.org_id) ||
      (c.source_id && c.source_id === source.source_id))) [0] ?? null;
  }

  /** 代表主动回避：记录在案，供推荐解释“哪些意见被回避”。 */
  recuseReview(payload) {
    requireFields(payload, ["proposal_id", "rep_id"]);
    const proposal = this.#require(this.repo.proposals, payload.proposal_id, "提案");
    const source = this.repo.sources.get(proposal.source_id);
    const conflict = this.#conflicted(payload.rep_id, source);
    if (!conflict) throw new Error("该代表与提案来源之间不存在已登记利益关系，无需回避");
    const id = payload.recusal_id || nextId("rec");
    const row = frozen({
      recusal_id: id,
      proposal_id: proposal.proposal_id,
      rep_id: String(payload.rep_id),
      org_id: conflict.org_id,
      source_id: source.source_id,
      reason: String(payload.reason ?? conflict.reason),
      at: new Date().toISOString(),
    });
    this.repo.recusals.insert(id, row);
    return row;
  }

  /* ---------------- 权重提案 ---------------- */

  createProposal(payload) {
    requireFields(payload, ["period_id", "job_id", "unit_id", "source_id", "proposed_by"]);
    const period = this.#require(this.repo.periods, payload.period_id, "统计周期");
    if (period.status !== "open") throw new Error("统计周期已关闭，不能新增提案");
    for (const [table, id, label] of [
      [this.repo.jobs, payload.job_id, "岗位"],
      [this.repo.units, payload.unit_id, "能力单元"],
    ]) if (!table.has(String(id))) throw new Error(`${label}不存在：${id}`);
    const source = this.#require(this.repo.sources, payload.source_id, "来源");
    const stance = String(payload.stance ?? "include");
    if (!STANCES.has(stance)) throw new Error("stance 只能是 include 或 exclude");
    const weight = Number(payload.weight ?? 1);
    if (!Number.isFinite(weight) || weight <= 0) throw new Error("weight 必须是正数");
    const id = payload.proposal_id || nextId("prop");
    const row = frozen({
      proposal_id: id,
      period_id: period.period_id,
      job_id: String(payload.job_id), unit_id: String(payload.unit_id),
      source_id: source.source_id, stance, weight,
      rationale: String(payload.rationale ?? ""),
      proposed_by: nonEmpty(payload.proposed_by, "proposed_by"),
      status: "draft",
    });
    return this.repo.proposals.insert(id, row);
  }

  submitProposal(proposalId) {
    const p = this.#require(this.repo.proposals, proposalId, "提案");
    if (p.status !== "draft") throw new Error("只有 draft 提案可以提交");
    return this.repo.proposals.put(p.proposal_id, frozen({ ...p, status: "submitted" }));
  }

  approveProposal(proposalId, approverId, note = "") {
    const p = this.#require(this.repo.proposals, proposalId, "提案");
    if (p.status !== "submitted") throw new Error("只有 submitted 提案可以审批");
    if (String(approverId) === p.proposed_by) throw new Error("提案人不能审批自己的提案");
    const source = this.repo.sources.get(p.source_id);
    const conflict = this.#conflicted(approverId, source);
    if (conflict) throw new Error(`代表 ${approverId} 与来源企业 ${conflict.org_id} 存在利益关系，应当回避`);

    // 同一周期同一条来源只能贡献一次权重。
    const contributionKey = `${p.period_id}|${p.source_id}`;
    if (this.repo.contributions.has(contributionKey)) {
      const existing = this.repo.contributions.get(contributionKey);
      throw new Error(`来源在本周期已贡献过权重（提案 ${existing.proposal_id}），不能重复计入`);
    }
    const decidedAt = new Date().toISOString();
    const decided = frozen({ ...p, status: "approved", decided_by: String(approverId), decided_at: decidedAt, decision_note: String(note) });
    this.repo.proposals.put(p.proposal_id, decided);
    const contribution = frozen({
      contribution_id: nextId("ctr"),
      contribution_key: contributionKey,
      period_id: p.period_id, source_id: p.source_id,
      job_id: p.job_id, unit_id: p.unit_id,
      stance: p.stance, weight: p.weight,
      proposal_id: p.proposal_id, approved_by: String(approverId), approved_at: decidedAt,
    });
    this.repo.contributions.insert(contributionKey, contribution);
    return { proposal: decided, contribution, mapping: this.recomputeMapping(p.job_id, p.unit_id, p.period_id) };
  }

  rejectProposal(proposalId, approverId, reason) {
    const p = this.#require(this.repo.proposals, proposalId, "提案");
    if (p.status !== "submitted") throw new Error("只有 submitted 提案可以审批");
    const source = this.repo.sources.get(p.source_id);
    const conflict = this.#conflicted(approverId, source);
    if (conflict) throw new Error(`代表 ${approverId} 与来源企业 ${conflict.org_id} 存在利益关系，应当回避`);
    const row = frozen({
      ...p, status: "rejected", decided_by: String(approverId),
      decided_at: new Date().toISOString(), reason: String(reason ?? ""),
    });
    this.repo.proposals.put(p.proposal_id, row);
    return row;
  }

  /* ---------------- 映射与重算 ---------------- */

  /**
   * 依据某周期内已批准贡献重算单条映射；无在可信期内的支撑 -> stale，方向互斥 -> disputed。
   * asOf 给定时只统计该时点仍有效的来源贡献，超窗贡献留在 basis 并标记 out_of_window，
   * 保证审批痕迹不丢、但权重不再计入。
   */
  recomputeMapping(jobId, unitId, periodId, { asOf = null } = {}) {
    const key = this.#mappingKey(jobId, unitId);
    const contributions = this.repo.contributions.find(
      (c) => c.period_id === String(periodId) && c.job_id === String(jobId) && c.unit_id === String(unitId));
    const day = asOf ? String(asOf).slice(0, 10) : null;
    const basis = contributions.map((c) => {
      const s = this.repo.sources.get(c.source_id);
      const inWindow = !day || (s && s.effective_from <= day && day < s.expires_at);
      return {
        contribution_id: c.contribution_id, source_id: c.source_id,
        source_no: s?.source_no, version: s?.version, kind: s?.kind,
        standard_no: s?.standard_no, standard_version: s?.standard_version,
        stance: c.stance, weight: c.weight,
        effective_from: s?.effective_from, expires_at: s?.expires_at,
        in_window: inWindow,
        approved_at: c.approved_at,
      };
    });
    const live = contributions.filter((c) => {
      if (!day) return true;
      const s = this.repo.sources.get(c.source_id);
      return s && s.effective_from <= day && day < s.expires_at;
    });
    const include = live.filter((c) => c.stance === "include");
    const exclude = live.filter((c) => c.stance === "exclude");
    let status;
    if (!live.length) status = "stale";
    else if (include.length && exclude.length) status = "disputed";
    else status = "active";
    const weight = include.reduce((n, c) => n + c.weight, 0)
      - exclude.reduce((n, c) => n + c.weight, 0);
    const previous = this.repo.mappings.get(key);
    const row = frozen({
      mapping_id: previous?.mapping_id || nextId("map"),
      job_id: String(jobId), unit_id: String(unitId),
      period_id: String(periodId), weight, status, basis,
      computed_as_of: day,
      computed_at: new Date().toISOString(),
    });
    this.repo.mappings.put(key, row);
    return row;
  }

  /** 批量重算：仅重算给定 (job,unit) 集合，供标准换版增量调用。 */
  recomputeAffected(pairs, periodId, opts) {
    return pairs.map(({ job_id, unit_id }) => this.recomputeMapping(job_id, unit_id, periodId, opts));
  }

  mapping(jobId, unitId) { return this.repo.mappings.get(this.#mappingKey(jobId, unitId)); }

  mappingsForJob(jobId) {
    return this.repo.mappings.find((m) => m.job_id === String(jobId));
  }
  mappingsForUnit(unitId) {
    return this.repo.mappings.find((m) => m.unit_id === String(unitId));
  }

  /** 与某来源集合有关的映射对（通过周期内已批准贡献追溯）。 */
  pairsTouchedBySources(sourceIds) {
    const wanted = new Set(sourceIds.map(String));
    const pairs = new Map();
    for (const c of this.repo.contributions.values()) {
      if (wanted.has(c.source_id)) pairs.set(`${c.job_id}|${c.unit_id}`, { job_id: c.job_id, unit_id: c.unit_id });
    }
    return [...pairs.values()];
  }

  #mappingKey(jobId, unitId) { return `${String(jobId)}|${String(unitId)}`; }

  #require(table, id, label) {
    const row = table.get(String(id));
    if (!row) throw new Error(`${label}不存在：${id}`);
    return row;
  }
}
