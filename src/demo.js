/**
 * 端到端叙事冒烟：在一个进程内 Service 上走通
 * 目录 -> 三类来源 -> 周期/审批/回避 -> 导入去重 -> 标准换版 -> 学生事实 ->
 * 分片推荐（含中断与配额）-> 解释查询 的完整链路。
 * CLI `demo` 子命令调用并打印 JSON 摘要。
 */
import { Service } from "./service.js";

export function buildScenario(service = new Service()) {
  const s = service;

  /* 1. 目录：能力单元、岗位族谱、专业、地区窗口、赛项 */
  const uAuto = s.registerUnit({ code: "ST-AUTO", name: "自动化测试脚本开发" });
  const uPerf = s.registerUnit({ code: "ST-PERF", name: "性能测试与调优" });
  const uAI = s.registerUnit({ code: "ST-AITEST", name: "AI 辅助用例生成" });
  const uIoT = s.registerUnit({ code: "SF-IOT", name: "物联网安防联动部署" });
  const uDenture = s.registerUnit({ code: "DR-DEN", name: "数字化义齿切削" });

  const jTech = s.registerJob({ code: "TECH", name: "数字技术岗族" });
  const jTester = s.registerJob({ code: "QA-ENG", name: "软件测试员", parent_job_id: jTech.job_id });
  const jSec = s.registerJob({ code: "SEC-ENG", name: "智慧安防系统运维员", parent_job_id: jTech.job_id });
  const jOral = s.registerJob({ code: "ORAL-TECH", name: "口腔修复体制作工" });

  const mSoft = s.registerMajor({ code: "M-SOFT", name: "软件技术" });
  const mSec = s.registerMajor({ code: "M-SEC", name: "智慧安防技术" });
  const mOral = s.registerMajor({ code: "M-ORAL", name: "口腔修复工艺" });
  for (const [m, j] of [[mSoft, jTester], [mSec, jSec], [mOral, jOral]]) {
    s.linkMajorJob({ major_id: m.major_id, job_id: j.job_id });
  }
  s.setMajorBaseline(mSoft.major_id, [uAuto.unit_id]);
  s.setMajorBaseline(mSec.major_id, [uIoT.unit_id]);
  s.setMajorBaseline(mOral.major_id, [uDenture.unit_id]);

  s.registerRegionDemand({ region_code: "3301", name: "杭州", job_id: jTester.job_id, window_from: "2026-01-01", window_to: "2027-01-01" });
  s.registerRegionDemand({ region_code: "4401", name: "广州", job_id: jOral.job_id, window_from: "2026-01-01", window_to: "2026-07-01" });
  s.registerSkill({ skill_code: "WSC-ST", name: "软件测试", standard_version: "2025", introduced_at: "2025-09-01" });

  /* 2. 统计周期 */
  s.openPeriod({ period_id: "P2026H1", name: "2026 上半年", starts_on: "2026-01-01", ends_on: "2026-07-01" });

  const approve = ({ job, unit, source_no, kind, stance = "include", org = null, standard = null, from = "2026-01-01", to = "2027-01-01", summary = source_no }) => {
    const source = s.registerSource({
      source_no, version: "v1", kind, title: source_no, summary,
      effective_from: from, expires_at: to, org_id: org,
      standard_no: standard?.[0] ?? null, standard_version: standard?.[1] ?? null,
    });
    s.addEvidence({ source_id: source.source_id, unit_id: unit.unit_id, job_id: job.job_id });
    const p = s.createProposal({ period_id: "P2026H1", job_id: job.job_id, unit_id: unit.unit_id, source_id: source.source_id, proposed_by: "analyst-1" });
    s.submitProposal(p.proposal_id);
    return { source, approved: s.approveProposal(p.proposal_id, "officer-neutral") };
  };

  /* 3. 三类材料（可信期不同）+ 利益回避 */
  approve({ job: jTester, unit: uPerf, source_no: "WSC-STD-2025", kind: "competition_standard", standard: ["WSC-ST", "2025"] });
  approve({ job: jTester, unit: uAI, source_no: "REC-2026Q2", kind: "recruitment_data" });
  approve({ job: jSec, unit: uIoT, source_no: "ENT-SEC-SURVEY", kind: "enterprise_survey", org: "org-sec" });
  // 已超可信期的旧调研：支撑现基线的自动化测试
  approve({ job: jTester, unit: uAuto, source_no: "SURVEY-2024", kind: "enterprise_survey", from: "2024-01-01", to: "2026-01-01" });

  const biased = s.registerSource({
    source_no: "ENT-VENDOR", version: "v1", kind: "enterprise_survey", title: "厂商调研",
    summary: "厂商私有工具", org_id: "org-vendor", effective_from: "2026-01-01", expires_at: "2027-01-01",
  });
  s.registerConflict({ rep_id: "rep-vendor", org_id: "org-vendor", reason: "厂商任职" });
  const bp = s.createProposal({ period_id: "P2026H1", job_id: jTester.job_id, unit_id: uAI.unit_id, source_id: biased.source_id, proposed_by: "rep-vendor" });
  s.submitProposal(bp.proposal_id);
  s.recuseReview({ proposal_id: bp.proposal_id, rep_id: "rep-vendor" });
  s.rejectProposal(bp.proposal_id, "officer-neutral", "私有工具非通用能力");

  /* 4. 批量导入：重复 / 变化复核 */
  const batch = s.importBatch([
    { source_no: "BATCH-SRC", version: "v1", kind: "recruitment_data", title: "批量来源", summary: "A", effective_from: "2026-01-01", expires_at: "2027-01-01" },
    { source_no: "BATCH-SRC", version: "v1", kind: "recruitment_data", title: "批量来源", summary: "A", effective_from: "2026-01-01", expires_at: "2027-01-01" },
    { source_no: "BATCH-SRC", version: "v1", kind: "recruitment_data", title: "批量来源", summary: "B（编号相同内容变化）", effective_from: "2026-01-01", expires_at: "2027-01-01" },
  ], { batch_id: "DEMO-BATCH" });

  /* 5. 学生事实与计划（在换版前已修完性能测试） */
  const plan = s.createPlan({ student_id: "stu-2024-07", major_id: mSoft.major_id, planned_unit_ids: [uAuto.unit_id, uPerf.unit_id] });
  s.recordAchievement({ student_id: "stu-2024-07", course_code: "QA-PERF", unit_id: uPerf.unit_id, result: "credit", grade: "A", achieved_on: "2026-05-18" });

  /* 6. 标准换版 2025 -> 2026：只重算受影响映射，旧来源退役，计划标重评 */
  s.registerStandardVersion({ standard_no: "WSC-ST", version: "2025", title: "软件测试赛项标准 2025" });
  s.registerStandardVersion({ standard_no: "WSC-ST", version: "2026", title: "软件测试赛项标准 2026", issued_on: "2026-09-01" });
  const revision = s.reviseStandard({
    standard_no: "WSC-ST", from_version: "2025", to_version: "2026",
    period_id: "P2026H1", changed_unit_ids: [uPerf.unit_id], on_date: "2026-09-01",
  });

  /* 7. 分片推荐：两分片各耗 1 配额，先给 1 个制造阻塞，再追加续跑 */
  s.startRecommendationRun({ period_id: "P2026H1", run_id: "DEMO-RUN", as_of: "2026-10-07", quota_total: 1, major_ids: [mSoft.major_id, mSec.major_id] });
  s.processShard("DEMO-RUN", mSoft.major_id);
  const blocked = s.processShard("DEMO-RUN", mSec.major_id); // 配额不足 -> blocked
  s.topUpQuota("DEMO-RUN", 1);
  s.resumeRun("DEMO-RUN", { processBlocked: true });

  /* 8. 解释 */
  const explainSoft = s.explainMajor(mSoft.major_id, "DEMO-RUN");
  const explainOral = s.explainMajor(mOral.major_id);
  const reevaluation = s.plansNeedingReevaluation();

  return { service: s, ids: { major_soft: mSoft.major_id, major_sec: mSec.major_id, major_oral: mOral.major_id, plan: plan.plan_id }, batch, blocked, revision, explainSoft, explainOral, reevaluation };
}
