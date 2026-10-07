/**
 * 分片推荐引擎。
 *
 * 一个“推荐运行”按专业切成多个分片：
 *  - 分片三态：pending -> completed（或 blocked:quota_exhausted）；
 *  - 配额按 (run_id, shard_id) 预留，键存在即复用——中断后续跑不会二次扣费；
 *  - completed 分片重放只返回既有结果，既不重算也不耗配额；
 *  - resume() 只处理未完成分片，全部完成后运行收尾。
 *
 * 建议分三类：add（建议增列能力）、remove（建议减/停）、hold（证据互斥或来源失效，
 * 需人工复核）。disputed 永远不会被静默合并成 add/remove。
 */
import { requireFields, frozen } from "./domain.js";

let seq = 0;
const nextId = (p) => `${p}-${(++seq).toString(36)}${Date.now().toString(36)}`;

export class Recommender {
  constructor(repo, catalog, governance, students, { shardCost = 1 } = {}) {
    this.repo = repo;
    this.catalog = catalog;
    this.gov = governance;
    this.students = students;
    this.shardCost = shardCost;
  }

  /**
   * @param quotaTotal 本次运行可用配额总量；每个分片消耗 shardCost。
   */
  startRun(payload = {}) {
    requireFields(payload, ["period_id"]);
    const period = this.repo.periods.get(String(payload.period_id));
    if (!period) throw new Error(`统计周期不存在：${payload.period_id}`);
    const asOf = String(payload.as_of ?? new Date().toISOString()).slice(0, 10);
    const quotaTotal = Number(payload.quota_total ?? Number.POSITIVE_INFINITY);
    if (!(quotaTotal > 0)) throw new Error("quota_total 必须为正数");

    const majorIds = (payload.major_ids?.length
      ? payload.major_ids.map(String)
      : this.catalog.majors.map((m) => m.major_id));
    const runId = payload.run_id || nextId("run");
    const run = frozen({
      run_id: runId,
      period_id: period.period_id,
      as_of: asOf,
      quota_total: quotaTotal === Number.POSITIVE_INFINITY ? null : quotaTotal,
      shard_cost: this.shardCost,
      status: "running",
      shards: majorIds.map((major_id) => ({ major_id, status: "pending", recommendation_id: null, reason: null })),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    this.repo.runs.insert(runId, run);
    // 配额台账：used 只统计不同预留键的金额，天然防重复扣费。
    this.repo.quotas.put(runId, frozen({ run_id: runId, quota_total: quotaTotal, used: 0, reservations: {} }));
    return run;
  }

  /** 幂等预留：同一分片只扣费一次；中断重入直接复用既有预留。 */
  #reserveQuota(run, shardId) {
    const ledger = this.repo.quotas.get(run.run_id);
    const key = `${run.run_id}|${shardId}`;
    if (Object.hasOwn(ledger.reservations, key)) {
      return { reserved: true, reused: true, amount: ledger.reservations[key] };
    }
    const cost = run.shard_cost;
    if (ledger.used + cost > ledger.quota_total) {
      return { reserved: false, reused: false, amount: 0, remaining: ledger.quota_total - ledger.used };
    }
    const reservations = { ...ledger.reservations, [key]: cost };
    this.repo.quotas.put(run.run_id, frozen({ ...ledger, used: ledger.used + cost, reservations }));
    return { reserved: true, reused: false, amount: cost };
  }

  /** 处理单个专业分片；已完成的直接回放，配额不足则停留 pending 并记 blocked。 */
  processShard(runId, majorId) {
    const run = this.#requireRun(runId);
    const shard = run.shards.find((s) => s.major_id === String(majorId));
    if (!shard) throw new Error(`运行 ${runId} 不包含专业分片：${majorId}`);
    if (shard.status === "completed") {
      return { shard, recommendation: this.repo.recommendations.get(shard.recommendation_id), reused: true };
    }

    const reserve = this.#reserveQuota(run, shard.major_id);
    if (!reserve.reserved) {
      this.#updateShard(run, shard, { status: "blocked", reason: "quota_exhausted" });
      const refreshed = this.#requireRun(runId);
      const stillPending = refreshed.shards.some((s) => s.status === "pending");
      this.#touch(refreshed, stillPending ? "running" : "blocked");
      return { shard: this.#requireRun(runId).shards.find((s) => s.major_id === String(majorId)), reused: false, quota_exhausted: true };
    }

    // 预留已存在（上次中断在计算/落库阶段）也安全：计算是确定性的，结果按分片覆盖。
    const recommendation = this.#buildRecommendation(run, shard.major_id);
    this.repo.recommendations.put(recommendation.recommendation_id, recommendation);
    this.#updateShard(run, shard, { status: "completed", recommendation_id: recommendation.recommendation_id, reason: null });

    const refreshed = this.#requireRun(runId);
    const anyPending = refreshed.shards.some((s) => s.status !== "completed");
    const anyBlocked = refreshed.shards.some((s) => s.status === "blocked");
    this.#touch(refreshed, anyBlocked && !refreshed.shards.some((s) => s.status === "pending")
      ? "blocked" : anyPending ? "running" : "completed");
    return {
      shard: this.#requireRun(runId).shards.find((s) => s.major_id === String(majorId)),
      recommendation, reused: reserve.reused,
    };
  }

  /** 中断恢复：从未完成分片继续，completed/blocked 之外的 pending 分片逐个处理。 */
  resume(runId, { processBlocked = false } = {}) {
    const run0 = this.#requireRun(runId);
    const targets = run0.shards
      .filter((s) => s.status === "pending" || (processBlocked && s.status === "blocked"))
      .map((s) => s.major_id);
    const results = targets.map((majorId) => {
      try {
        return this.processShard(runId, majorId);
      } catch (err) {
        return { major_id: majorId, error: err.message };
      }
    });
    // 无目标时（例如全部 completed 但运行状态停在 running）也要把状态对齐。
    const run = this.#requireRun(runId);
    if (!targets.length && run.status !== "completed" && !run.shards.some((s) => s.status !== "completed")) {
      this.#touch(run, "completed");
    }
    return { run: this.#requireRun(runId), results };
  }

  /* ---------------- 单专业推荐计算 ---------------- */

  #buildRecommendation(run, majorId) {
    const major = this.repo.majors.get(String(majorId));
    if (!major) throw new Error(`专业不存在：${majorId}`);
    const baseline = new Set(this.catalog.baselineForMajor(majorId)?.unit_ids ?? []);
    const jobLinks = this.catalog.jobsForMajor(majorId);
    const asOf = run.as_of;

    // 聚合专业面向岗位的映射（岗位与能力多对多，在此汇到专业视角）。
    const perUnit = new Map();
    for (const link of jobLinks) {
      for (const mapping of this.gov.mappingsForJob(link.job_id)) {
        if (mapping.period_id !== run.period_id) continue;
        if (!perUnit.has(mapping.unit_id)) {
          perUnit.set(mapping.unit_id, { unit_id: mapping.unit_id, jobs: new Set(), total_weight: 0, statuses: new Set(), basis: [] });
        }
        const agg = perUnit.get(mapping.unit_id);
        agg.jobs.add(link.job_id);
        agg.total_weight += mapping.weight * link.weight;
        agg.statuses.add(mapping.status);
        agg.basis.push(...mapping.basis.map((b) => ({ ...b, job_id: link.job_id })));
      }
    }

    const decisions = [];
    for (const [unitId, agg] of perUnit) {
      const unit = this.repo.units.get(unitId);
      const effectiveBasis = agg.basis.filter((b) => b.effective_from <= asOf && asOf < b.expires_at);
      const expiredBasis = agg.basis.filter((b) => !(b.effective_from <= asOf && asOf < b.expires_at));
      const activeRegions = [...new Set([...agg.jobs].flatMap((jobId) =>
        this.catalog.activeRegionsForJob(jobId, asOf).map((r) => `${r.region_code}:${r.name}`)))];
      const avoided = this.#avoidedOpinions(agg.jobs, unitId);
      const common = {
        unit_id: unitId, unit_code: unit?.code, unit_name: unit?.name,
        jobs: [...agg.jobs], active_regions: activeRegions,
        evidence_at: {
          as_of: asOf,
          adopted: effectiveBasis,
          expired_or_future: expiredBasis,
        },
        avoided_opinions: avoided,
      };

      if (agg.statuses.has("disputed")) {
        decisions.push({ ...common, action: "hold",
          reason: "同期证据对该能力存在纳入与剔除两种互斥结论，需人工复核，不做静默合并" });
      } else if (!baseline.has(unitId) && effectiveBasis.length && agg.total_weight > 0) {
        decisions.push({ ...common, action: "add",
          reason: `赛事/企业/招聘证据在 ${asOf} 时点一致支持纳入，现培养方案尚未覆盖` });
      } else if (baseline.has(unitId) && !effectiveBasis.length) {
        decisions.push({ ...common, action: "remove",
          reason: "支撑该能力的来源在观察时点均已超出可信期，建议减列或先更新课程依据" });
      } else if (baseline.has(unitId) && agg.total_weight <= 0) {
        decisions.push({ ...common, action: "remove", reason: "现行证据净权重不再支持该能力，建议缩减课时" });
      } else if (baseline.has(unitId)) {
        decisions.push({ ...common, action: "keep", reason: "现培养方案与证据一致，维持" });
      } else {
        decisions.push({ ...common, action: "hold", reason: "证据不足或可信期未覆盖，暂不调整" });
      }
    }

    // 基线里有、但没有任何映射的能力：无证据，不轻易建议删除，给 hold。
    for (const unitId of baseline) {
      if (!perUnit.has(unitId)) {
        const unit = this.repo.units.get(unitId);
        decisions.push({
          unit_id: unitId, unit_code: unit?.code, unit_name: unit?.name, jobs: [], active_regions: [],
          evidence_at: { as_of: asOf, adopted: [], expired_or_future: [] },
          avoided_opinions: [], action: "hold", reason: "缺少任何在可信期内的支撑来源，需补充证据后再决定",
        });
      }
    }

    return frozen({
      recommendation_id: nextId("rec"),
      run_id: run.run_id, major_id: majorId, major_name: major.name,
      period_id: run.period_id, as_of: asOf,
      baseline_unit_ids: [...baseline],
      add: decisions.filter((d) => d.action === "add"),
      remove: decisions.filter((d) => d.action === "remove"),
      hold: decisions.filter((d) => d.action === "hold"),
      keep: decisions.filter((d) => d.action === "keep"),
      generated_at: new Date().toISOString(),
    });
  }

  /** 被回避/未采纳的意见：利益回避记录 + 针对相关(岗位,能力)的驳回提案。 */
  #avoidedOpinions(jobIds, unitId) {
    const jobSet = new Set([...jobIds].map(String));
    const proposals = this.repo.proposals.find(
      (p) => jobSet.has(p.job_id) && p.unit_id === String(unitId));
    const byId = new Map(proposals.map((p) => [p.proposal_id, p]));
    const avoided = [];
    for (const recusal of this.repo.recusals.values()) {
      const p = this.repo.proposals.get(recusal.proposal_id) ?? byId.get(recusal.proposal_id);
      if (p && jobSet.has(p.job_id) && p.unit_id === String(unitId)) {
        avoided.push({ kind: "recusal", proposal_id: p.proposal_id, rep_id: recusal.rep_id,
          org_id: recusal.org_id, reason: recusal.reason, at: recusal.at });
      }
    }
    for (const p of proposals) {
      if (p.status === "rejected") {
        avoided.push({ kind: "rejected_proposal", proposal_id: p.proposal_id,
          decided_by: p.decided_by, reason: p.reason, at: p.decided_at });
      }
    }
    return avoided;
  }

  #updateShard(run, shard, patch) {
    const shards = run.shards.map((s) => s === shard ? frozen({ ...s, ...patch }) : s);
    this.repo.runs.put(run.run_id, frozen({ ...run, shards, updated_at: new Date().toISOString() }));
  }

  #touch(run, status) {
    this.repo.runs.put(run.run_id, frozen({ ...run, status, updated_at: new Date().toISOString() }));
  }

  #requireRun(runId) {
    const run = this.repo.runs.get(String(runId));
    if (!run) throw new Error(`推荐运行不存在：${runId}`);
    return run;
  }

  getRun(runId) { return this.#requireRun(runId); }
  quotaStatus(runId) { return this.repo.quotas.get(String(runId)); }

  /** 追加配额（例如申请到新额度后让 blocked 分片继续）；既有预留不重复扣费。 */
  topUpQuota(runId, amount) {
    const ledger = this.#requireLedger(runId);
    const add = Number(amount);
    if (!(add > 0)) throw new Error("追加配额必须为正数");
    const updated = frozen({ ...ledger, quota_total: ledger.quota_total + add });
    this.repo.quotas.put(runId, updated);
    const run = this.#requireRun(runId);
    if (run.status === "blocked") this.#touch(run, "running");
    return updated;
  }

  #requireLedger(runId) {
    const ledger = this.repo.quotas.get(String(runId));
    if (!ledger) throw new Error(`配额台账不存在：${runId}`);
    return ledger;
  }
}
