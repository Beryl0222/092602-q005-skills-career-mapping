import test from "node:test";
import assert from "node:assert/strict";
import { buildWorld, approveEvidence } from "./fixtures.js";

test("标准换版只重算受影响映射，不触及无关映射", () => {
  const { s, units, jobs } = buildWorld();
  // 受旧标准支撑的映射：性能测试
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uPerf,
    source_no: "WSC-ST-STD", version: "doc2025", kind: "competition_standard",
    standardNo: "WSC-ST", standardVersion: "2025",
  });
  // 另一条与该标准无关的映射（企业调研来源），换版不应动它
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uTestAuto,
    source_no: "ENT-GENERIC", kind: "enterprise_survey", orgId: "org-c",
  });

  const perfBefore = s.governance.mapping(jobs.jTester.job_id, units.uPerf.unit_id);
  const autoBefore = s.governance.mapping(jobs.jTester.job_id, units.uTestAuto.unit_id);
  assert.equal(perfBefore.status, "active");

  // 登记新版标准（暂未挂任何来源/贡献），执行换版
  s.registerStandardVersion({ standard_no: "WSC-ST", version: "2025", title: "软件测试赛项标准 2025" });
  s.registerStandardVersion({ standard_no: "WSC-ST", version: "2026", title: "软件测试赛项标准 2026", issued_on: "2026-09-01" });
  const { revision, recomputed, flaggedPlans } = s.reviseStandard({
    standard_no: "WSC-ST", from_version: "2025", to_version: "2026",
    period_id: "P2026H1", changed_unit_ids: [units.uPerf.unit_id],
  });

  assert.equal(recomputed.length, 1, "只有性能测试映射被重算");
  assert.equal(recomputed[0].mapping_id, perfBefore.mapping_id);
  assert.equal(recomputed[0].status, "stale", "旧版证据在新周期无新版来源接续 -> stale");
  const autoAfter = s.governance.mapping(jobs.jTester.job_id, units.uTestAuto.unit_id);
  assert.equal(autoAfter.computed_at, autoBefore.computed_at, "无关映射完全未被重算");
  assert.equal(revision.affected_pairs.length, 1);
});

test("学生已完成课程事实不可倒退、不可重复登记", () => {
  const { s, units, majors } = buildWorld();
  s.createPlan({
    student_id: "stu-1", major_id: majors.mSoft.major_id,
    planned_unit_ids: [units.uTestAuto.unit_id, units.uPerf.unit_id],
  });
  s.recordAchievement({
    student_id: "stu-1", course_code: "COURSE-QA101", unit_id: units.uPerf.unit_id,
    result: "credit", grade: "A", achieved_on: "2026-05-20",
  });
  // 同一 (学生,课程,能力) 只能有一条达成事实，不能用更低结果覆盖
  assert.throws(() => s.recordAchievement({
    student_id: "stu-1", course_code: "COURSE-QA101", unit_id: units.uPerf.unit_id,
    result: "pass", achieved_on: "2026-06-01",
  }), /不可重复登记或倒退/);
  assert.equal(s.students.achievementsFor("stu-1")[0].grade, "A");
});

test("换版标记引用受影响能力的在读学生计划，已完成课程在解释中原样保留", () => {
  const { s, units, jobs, majors } = buildWorld();
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uPerf,
    source_no: "WSC-ST-STD2", version: "doc2025", kind: "competition_standard",
    standardNo: "WSC-ST", standardVersion: "2025",
  });
  const plan = s.createPlan({
    student_id: "stu-2", major_id: majors.mSoft.major_id,
    planned_unit_ids: [units.uPerf.unit_id],
  });
  s.recordAchievement({
    student_id: "stu-2", course_code: "QA-PERF", unit_id: units.uPerf.unit_id,
    result: "pass", achieved_on: "2026-04-01",
  });
  s.registerStandardVersion({ standard_no: "WSC-ST", version: "2025", title: "标准2025" });
  s.registerStandardVersion({ standard_no: "WSC-ST", version: "2026", title: "标准2026", issued_on: "2026-09-01" });
  const { flaggedPlans } = s.reviseStandard({
    standard_no: "WSC-ST", from_version: "2025", to_version: "2026",
    period_id: "P2026H1", changed_unit_ids: [units.uPerf.unit_id],
  });
  assert.equal(flaggedPlans.length, 1);
  assert.equal(flaggedPlans[0].status, "needs_reevaluation");

  const needing = s.plansNeedingReevaluation({ majorId: majors.mSoft.major_id });
  assert.equal(needing.length, 1);
  assert.deepEqual(needing[0].affected_unit_ids, [units.uPerf.unit_id]);
  // 已修过的能力仍在 immutable 事实中，且被标注“其实已达成”
  assert.deepEqual(needing[0].already_achieved_units, [units.uPerf.unit_id]);
  assert.equal(needing[0].new_standard, "WSC-ST@2026");
  const explained = s.explainPlan(plan.plan_id);
  assert.equal(explained.immutable_achievements.length, 1);
  assert.equal(explained.immutable_achievements[0].result, "pass");

  // 重评解除后状态回到 active，达成事实仍在
  s.resolveReevaluation(plan.plan_id, "新课程衔接新版标准");
  assert.equal(s.explainPlan(plan.plan_id).status, "active");
  assert.equal(s.students.achievementsFor("stu-2").length, 1);
  assert.equal(s.plansNeedingReevaluation().length, 0);
});

test("已完成（completed 之外由状态控制）——未引用受影响能力的计划不被标记", () => {
  const { s, units, jobs, majors } = buildWorld();
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uPerf,
    source_no: "WSC-ST-STD3", version: "doc2025", kind: "competition_standard",
    standardNo: "WSC-ST", standardVersion: "2025",
  });
  s.createPlan({
    student_id: "stu-3", major_id: majors.mSec.major_id,
    planned_unit_ids: [units.uSecIoT.unit_id],
  });
  s.registerStandardVersion({ standard_no: "WSC-ST", version: "2025", title: "标准2025" });
  s.registerStandardVersion({ standard_no: "WSC-ST", version: "2026", title: "标准2026", issued_on: "2026-09-01" });
  const { flaggedPlans } = s.reviseStandard({
    standard_no: "WSC-ST", from_version: "2025", to_version: "2026",
    period_id: "P2026H1", changed_unit_ids: [units.uPerf.unit_id],
  });
  assert.equal(flaggedPlans.length, 0);
});
