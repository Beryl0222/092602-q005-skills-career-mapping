/** 测试固件：搭一个“软件测试 / 智慧安防 / 口腔修复”的最小证据世界。 */
import { Service } from "../src/service.js";

export const TODAY = "2026-10-07";

export function buildWorld() {
  const s = new Service();

  // 能力单元
  const uTestAuto = s.registerUnit({ code: "ST-AUTO", name: "自动化测试脚本开发" });
  const uPerf = s.registerUnit({ code: "ST-PERF", name: "性能测试与调优" });
  const uSecIoT = s.registerUnit({ code: "SF-IOT", name: "物联网安防联动部署" });
  const uDenture = s.registerUnit({ code: "DR-DEN", name: "数字化义齿切削" });

  // 岗位族谱
  const jTech = s.registerJob({ code: "TECH", name: "数字技术岗族" });
  const jTester = s.registerJob({ code: "QA-ENG", name: "软件测试员", parent_job_id: jTech.job_id });
  const jSecurity = s.registerJob({ code: "SEC-ENG", name: "智慧安防系统运维员", parent_job_id: jTech.job_id });
  const jOral = s.registerJob({ code: "ORAL-TECH", name: "口腔修复体制作工" });

  // 专业与专业-岗位关联、能力基线
  const mSoft = s.registerMajor({ code: "M-SOFT", name: "软件技术" });
  const mSec = s.registerMajor({ code: "M-SEC", name: "智慧安防技术" });
  s.linkMajorJob({ major_id: mSoft.major_id, job_id: jTester.job_id });
  s.linkMajorJob({ major_id: mSec.major_id, job_id: jSecurity.job_id });
  s.setMajorBaseline(mSoft.major_id, [uTestAuto.unit_id]); // 现方案只有自动化测试
  s.setMajorBaseline(mSec.major_id, [uSecIoT.unit_id]);

  // 地区需求窗口（半开）
  s.registerRegionDemand({
    region_code: "3301", name: "杭州", job_id: jTester.job_id,
    window_from: "2026-01-01", window_to: "2027-01-01",
  });

  // 赛项
  const skill = s.registerSkill({
    skill_code: "WSC-ST", name: "软件测试", standard_version: "2025",
    introduced_at: "2025-09-01",
  });

  // 统计周期
  s.openPeriod({ period_id: "P2026H1", name: "2026 上半年", starts_on: "2026-01-01", ends_on: "2026-07-01" });

  return {
    s,
    units: { uTestAuto, uPerf, uSecIoT, uDenture },
    jobs: { jTech, jTester, jSecurity, jOral },
    majors: { mSoft, mSec },
    skill,
  };
}

/** 登记一条来源 + 证据，并提交批准一条权重提案，返回 {source, proposal, result}。 */
export function approveEvidence(s, {
  periodId, job, unit, kind = "competition_standard", source_no, version = "v1",
  summary = "摘要", stance = "include", weight = 1, approver = "officer-1",
  proposedBy = "analyst-1", from = "2026-01-01", to = "2027-01-01",
  orgId = null, standardNo = null, standardVersion = null, skill = null,
}) {
  const source = s.registerSource({
    source_no, version, kind, title: `${source_no} ${version}`, summary,
    effective_from: from, expires_at: to, org_id: orgId,
    standard_no: standardNo, standard_version: standardVersion,
  });
  s.addEvidence({
    source_id: source.source_id, unit_id: unit.unit_id, job_id: job.job_id,
    skill_id: skill?.skill_id ?? null,
  });
  const proposal = s.createProposal({
    period_id: periodId, job_id: job.job_id, unit_id: unit.unit_id,
    source_id: source.source_id, stance, weight, proposed_by: proposedBy,
  });
  s.submitProposal(proposal.proposal_id);
  const result = s.approveProposal(proposal.proposal_id, approver);
  return { source, proposal, result };
}
