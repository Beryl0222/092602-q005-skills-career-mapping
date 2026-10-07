/**
 * 标准换版与增量重算。
 *
 * 换版时：
 *  1. 登记新标准版本与其来源；
 *  2. 计算“受影响映射”——只取支撑证据来自旧版、且新版窗口/结论发生变化的映射，
 *     其它映射不重算；
 *  3. 旧来源到期（expires_at）后受影响映射标记为 stale/disputed，等待新周期证据；
 *  4. 凡课程/计划引用了受影响能力单元的在读学生，其计划标记 needs_reevaluation，
 *     已完成课程事实保持不变（见 students.js）。
 */
import { requireFields, nonEmpty, frozen, asDate } from "./domain.js";

let seq = 0;
const nextId = (p) => `${p}-${(++seq).toString(36)}${Date.now().toString(36)}`;

export class Standards {
  constructor(repo, governance) { this.repo = repo; this.gov = governance; }

  /** 登记一个标准版本（赛事标准或行业标准的某一版）。 */
  registerVersion(payload) {
    requireFields(payload, ["standard_no", "version", "title"]);
    const id = payload.standard_id || nextId("std");
    const row = frozen({
      standard_id: id,
      standard_no: nonEmpty(payload.standard_no, "standard_no"),
      version: nonEmpty(payload.version, "version"),
      title: nonEmpty(payload.title, "标准标题"),
      source_id: payload.source_id ? String(payload.source_id) : null,
      issued_on: payload.issued_on ? asDate(payload.issued_on, "issued_on") : null,
    });
    return this.repo.standards.insert(id, row);
  }

  versionsOf(standardNo) {
    return this.repo.standards.find((s) => s.standard_no === String(standardNo))
      .sort((a, b) => String(a.issued_on ?? "").localeCompare(String(b.issued_on ?? "")));
  }

  /**
   * 声明一次换版事件。
   * changed_unit_ids：新版相对旧版能力要求发生变化的能力单元；
   * affected_pairs 可显式给出，否则由“引用旧标准来源的已批准贡献”自动推导。
   */
  revise(payload) {
    requireFields(payload, ["standard_no", "from_version", "to_version", "period_id"]);
    const from_version = nonEmpty(payload.from_version, "from_version");
    const to_version = nonEmpty(payload.to_version, "to_version");
    const changedUnitIds = new Set((payload.changed_unit_ids ?? []).map(String));
    const reviseOn = payload.on_date ? asDate(payload.on_date, "on_date")
      : new Date().toISOString().slice(0, 10);

    const oldStandard = this.versionsOf(payload.standard_no).find((s) => s.version === from_version);
    const newStandard = this.versionsOf(payload.standard_no).find((s) => s.version === to_version);
    if (!oldStandard) throw new Error(`旧版标准不存在：${payload.standard_no}@${from_version}`);
    if (!newStandard) throw new Error(`新版标准不存在：${payload.standard_no}@${to_version}`);

    // 与旧版标准关联的来源（含已到期来源）。
    const oldSources = this.repo.sources.find(
      (s) => s.standard_no === String(payload.standard_no) && s.standard_version === from_version
    );
    const oldSourceIds = oldSources.map((s) => s.source_id);

    // 受影响映射：旧来源支撑的映射，且（显式声明变化，或新版来源未覆盖同一映射）。
    const touched = this.gov.pairsTouchedBySources(oldSourceIds);
    const newSourceIds = new Set(this.repo.sources.find(
      (s) => s.standard_no === String(payload.standard_no) && s.standard_version === to_version
    ).map((s) => s.source_id));
    const affected = touched.filter(({ job_id, unit_id }) => {
      if (changedUnitIds.has(String(unit_id))) return true;
      const stillCovered = this.repo.contributions.find(
        (c) => c.period_id === String(payload.period_id) &&
          c.job_id === String(job_id) && c.unit_id === String(unit_id) &&
          newSourceIds.has(c.source_id)).length > 0;
      return !stillCovered;
    });

    // 旧版来源在换版时点被替代退役：可信期截断到换版日（半开），只改尚未到期者。
    const retiredSourceIds = [];
    for (const src of oldSources) {
      if (src.expires_at > reviseOn) {
        this.repo.sources.put(src.source_id, frozen({
          ...src, expires_at: reviseOn,
          retired_by_revision: `${payload.standard_no}@${to_version}`,
        }));
        retiredSourceIds.push(src.source_id);
      }
    }

    // 增量重算：只有 affected 中的映射被重算，并以换版时点过滤可信期。
    const recomputed = this.gov.recomputeAffected(affected, payload.period_id, { asOf: reviseOn });

    // 标记引用了受影响能力单元的在读学生计划。
    const affectedUnitIds = new Set(affected.map((p) => p.unit_id));
    const flaggedPlans = this.#flagPlans(affectedUnitIds, newStandard);

    const id = payload.revision_id || nextId("rev");
    const event = frozen({
      revision_id: id,
      standard_no: String(payload.standard_no),
      from_version, to_version,
      period_id: String(payload.period_id),
      on_date: reviseOn,
      old_source_ids: oldSourceIds,
      retired_source_ids: retiredSourceIds,
      affected_pairs: affected,
      recomputed_mapping_ids: recomputed.map((m) => m.mapping_id),
      flagged_plan_ids: flaggedPlans.map((p) => p.plan_id),
      occurred_at: new Date().toISOString(),
    });
    this.repo.revisions.insert(id, event);
    return { revision: event, recomputed, flaggedPlans };
  }

  #flagPlans(unitIds, newStandard) {
    if (!unitIds.size) return [];
    const flagged = [];
    for (const plan of this.repo.plans.values()) {
      if (plan.status === "completed") continue;
      const hits = plan.planned_unit_ids.filter((u) => unitIds.has(u));
      if (!hits.length) continue;
      if (plan.status === "needs_reevaluation") { flagged.push(plan); continue; }
      const updated = frozen({
        ...plan,
        status: "needs_reevaluation",
        reevaluation: frozen({
          ...(plan.reevaluation ?? {}),
          standard_no: newStandard.standard_no,
          to_version: newStandard.version,
          unit_ids: [...new Set([...(plan.reevaluation?.unit_ids ?? []), ...hits])],
          flagged_at: new Date().toISOString(),
        }),
      });
      this.repo.plans.put(plan.plan_id, updated);
      flagged.push(updated);
    }
    return flagged;
  }

  revisionsForPlan(planId) {
    const plan = this.repo.plans.get(String(planId));
    if (!plan) return [];
    const flagged = new Set(plan.reevaluation?.unit_ids ?? []);
    return this.repo.revisions.find((r) =>
      r.flagged_plan_ids.includes(plan.plan_id)).map((r) => ({
      revision_id: r.revision_id, standard_no: r.standard_no,
      from_version: r.from_version, to_version: r.to_version,
      unit_ids: r.affected_pairs.filter((p) => flagged.has(p.unit_id)).map((p) => p.unit_id),
      occurred_at: r.occurred_at,
    }));
  }
}
