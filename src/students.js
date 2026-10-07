/**
 * 学生侧事实：课程达成记录（append-only，不可倒退）与学生计划。
 *
 * 不可倒退的含义：
 *  - 达成记录只能追加，不提供更新/删除入口；
 *  - 重复登记同一 (student, course, unit) 达成事件被拒绝而不是覆盖；
 *  - 计划引用的达成事实在标准换版/重算后原样保留，计划只能被“标记重评”，
 *    不能删除或降低学生已经取得的达成。
 */
import { requireFields, nonEmpty, frozen, asDate } from "./domain.js";

let seq = 0;
const nextId = (p) => `${p}-${(++seq).toString(36)}${Date.now().toString(36)}`;

export class Students {
  constructor(repo) { this.repo = repo; }

  /** 登记一条课程达成事实。result 只允许前进（pass/credit/exempt），不存在撤销。 */
  recordAchievement(payload) {
    requireFields(payload, ["student_id", "course_code", "unit_id", "result", "achieved_on"]);
    const result = nonEmpty(payload.result, "result");
    if (!["pass", "credit", "exempt"].includes(result)) {
      throw new Error("result 只能是 pass、credit 或 exempt");
    }
    const key = `${payload.student_id}|${payload.course_code}|${payload.unit_id}`;
    if (this.repo.achievements.has(key)) {
      throw new Error("该课程达成事实已存在，达成记录不可重复登记或倒退");
    }
    if (!this.repo.units.has(String(payload.unit_id))) throw new Error(`能力单元不存在：${payload.unit_id}`);
    const row = frozen({
      achievement_key: key,
      achievement_id: nextId("ach"),
      student_id: nonEmpty(payload.student_id, "student_id"),
      course_code: nonEmpty(payload.course_code, "course_code"),
      unit_id: String(payload.unit_id),
      result,
      grade: payload.grade === undefined ? null : String(payload.grade),
      achieved_on: asDate(payload.achieved_on, "achieved_on"),
      evidence_ref: String(payload.evidence_ref ?? ""),
    });
    this.repo.achievements.insert(key, row);
    return row;
  }

  achievementsFor(studentId) {
    return this.repo.achievements.find((a) => a.student_id === String(studentId));
  }

  /** 已达成的能力单元集合（事实，只增不减）。 */
  achievedUnits(studentId) {
    return new Set(this.achievementsFor(studentId).map((a) => a.unit_id));
  }

  /** 建立学生计划：专业 + 计划修读的能力单元。 */
  createPlan(payload) {
    requireFields(payload, ["student_id", "major_id", "planned_unit_ids"]);
    if (!this.repo.majors.has(String(payload.major_id))) throw new Error(`专业不存在：${payload.major_id}`);
    const planned = [...new Set((payload.planned_unit_ids ?? []).map(String))];
    for (const unitId of planned) {
      if (!this.repo.units.has(unitId)) throw new Error(`能力单元不存在：${unitId}`);
    }
    const id = payload.plan_id || nextId("plan");
    const row = frozen({
      plan_id: id,
      student_id: nonEmpty(payload.student_id, "student_id"),
      major_id: String(payload.major_id),
      planned_unit_ids: planned,
      status: "active",
      created_at: new Date().toISOString(),
    });
    this.repo.plans.insert(id, row);
    return row;
  }

  /**
   * 把新能力单元加入计划（只会增加，不删除已修读/已规划事实）。
   * 标准换版建议增列能力时走这里。
   */
  addUnitsToPlan(planId, unitIds) {
    const plan = this.#requirePlan(planId);
    const merged = [...new Set([...plan.planned_unit_ids, ...unitIds.map(String)])];
    const updated = frozen({ ...plan, planned_unit_ids: merged });
    this.repo.plans.put(plan.plan_id, updated);
    return updated;
  }

  /** 重评完成后解除标记；已完成课程事实不受影响。 */
  resolveReevaluation(planId, note = "") {
    const plan = this.#requirePlan(planId);
    if (plan.status !== "needs_reevaluation") throw new Error("该计划当前不在待重评状态");
    const updated = frozen({
      ...plan, status: "active",
      reevaluation: frozen({ ...(plan.reevaluation ?? {}), resolved_at: new Date().toISOString(), note: String(note) }),
    });
    this.repo.plans.put(plan.plan_id, updated);
    return updated;
  }

  plansNeedingReevaluation() {
    return this.repo.plans.find((p) => p.status === "needs_reevaluation");
  }

  #requirePlan(planId) {
    const plan = this.repo.plans.get(String(planId));
    if (!plan) throw new Error(`学生计划不存在：${planId}`);
    return plan;
  }
}
