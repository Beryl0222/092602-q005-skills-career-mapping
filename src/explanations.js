/**
 * 面向院校人员的只读解释接口。
 *
 * explainMajor 回答四个问题：
 *  1. 某专业为何被建议增减哪些能力；
 *  2. 采用了哪个时点的证据（采用 / 已超可信期分别列出）；
 *  3. 哪些意见被回避（利益回避、驳回提案）；
 *  4. 每条建议与哪些标准版本、哪些岗位需求窗口有关。
 *
 * plansNeedingReevaluation 回答：标准更新后哪些学生计划需要重新评估、受哪次换版影响。
 */
export class Explanations {
  constructor(repo, recommender, standards) {
    this.repo = repo;
    this.recommender = recommender;
    this.standards = standards;
  }

  /** 取某专业在某次运行中的推荐及完整依据；run_id 缺省取该专业最新一条。 */
  explainMajor(majorId, runId = null) {
    const id = String(majorId);
    const major = this.repo.majors.get(id);
    if (!major) throw new Error(`专业不存在：${majorId}`);
    const rec = runId
      ? this.#recommendationOfRun(runId, id)
      : this.repo.recommendations.find((r) => r.major_id === id)
          .sort((a, b) => b.generated_at.localeCompare(a.generated_at))[0] ?? null;
    if (!rec) return { major_id: id, major_name: major.name, generated: false, message: "尚无已生成的推荐分片" };

    const summarize = (d) => ({
      unit_id: d.unit_id, unit_code: d.unit_code, unit_name: d.unit_name,
      action: d.action, reason: d.reason,
      jobs: d.jobs, active_regions: d.active_regions,
      standards: [...new Set(d.evidence_at.adopted
        .filter((b) => b.standard_no)
        .map((b) => `${b.standard_no}@${b.standard_version}`))],
      evidence_adopted: d.evidence_at.adopted.map((b) => ({
        source_no: b.source_no, version: b.version, kind: b.kind,
        standard: b.standard_no ? `${b.standard_no}@${b.standard_version}` : null,
        stance: b.stance, weight: b.weight,
        effective_window: [b.effective_from, b.expires_at],
        approved_at: b.approved_at,
      })),
      evidence_out_of_window: d.evidence_at.expired_or_future.map((b) => ({
        source_no: b.source_no, version: b.version, kind: b.kind,
        effective_window: [b.effective_from, b.expires_at],
      })),
      avoided_opinions: d.avoided_opinions,
    });

    return {
      generated: true,
      run_id: rec.run_id, period_id: rec.period_id, as_of: rec.as_of,
      major_id: rec.major_id, major_name: rec.major_name,
      generated_at: rec.generated_at,
      baseline_unit_ids: rec.baseline_unit_ids,
      add: rec.add.map(summarize),
      remove: rec.remove.map(summarize),
      hold: rec.hold.map(summarize),
      keep: rec.keep.map(summarize),
      summary: {
        add: rec.add.length, remove: rec.remove.length,
        hold: rec.hold.length, keep: rec.keep.length,
      },
    };
  }

  /** 标准更新后需要重新评估的学生计划，含受影响能力与换版事件链。 */
  plansNeedingReevaluation({ majorId = null } = {}) {
    return this.repo.plans
      .find((p) => p.status === "needs_reevaluation" && (!majorId || p.major_id === String(majorId)))
      .map((plan) => {
        const major = this.repo.majors.get(plan.major_id);
        const achieved = new Set(this.repo.achievements
          .find((a) => a.student_id === plan.student_id).map((a) => a.unit_id));
        return {
          plan_id: plan.plan_id, student_id: plan.student_id,
          major_id: plan.major_id, major_name: major?.name,
          flagged_at: plan.reevaluation?.flagged_at ?? null,
          new_standard: plan.reevaluation?.standard_no
            ? `${plan.reevaluation.standard_no}@${plan.reevaluation.to_version}` : null,
          affected_unit_ids: plan.reevaluation?.unit_ids ?? [],
          // 已完成课程事实原样保留，只列出哪些受影响能力其实已经修过。
          already_achieved_units: (plan.reevaluation?.unit_ids ?? []).filter((u) => achieved.has(u)),
          revision_events: this.standards.revisionsForPlan(plan.plan_id),
        };
      });
  }

  /** 单个学生的完整可追溯视图：已达成事实（不回退）+ 计划 + 换版影响。 */
  explainPlan(planId) {
    const plan = this.repo.plans.get(String(planId));
    if (!plan) throw new Error(`学生计划不存在：${planId}`);
    const achievements = this.repo.achievements.find((a) => a.student_id === plan.student_id);
    return {
      plan_id: plan.plan_id, student_id: plan.student_id, major_id: plan.major_id,
      status: plan.status, planned_unit_ids: plan.planned_unit_ids,
      immutable_achievements: achievements.map((a) => ({
        course_code: a.course_code, unit_id: a.unit_id, result: a.result,
        grade: a.grade, achieved_on: a.achieved_on,
      })),
      reevaluation: plan.reevaluation ?? null,
      revision_events: this.standards.revisionsForPlan(plan.plan_id),
    };
  }

  #recommendationOfRun(runId, majorId) {
    const run = this.repo.runs.get(String(runId));
    if (!run) throw new Error(`推荐运行不存在：${runId}`);
    const shard = run.shards.find((s) => s.major_id === majorId);
    if (!shard?.recommendation_id) return null;
    return this.repo.recommendations.get(shard.recommendation_id);
  }
}
