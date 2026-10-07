import test from "node:test";
import assert from "node:assert/strict";
import { buildWorld, approveEvidence, TODAY } from "./fixtures.js";

test("三类材料版本与可信期独立：观察时点落在窗口外的来源不被采用", () => {
  const { s, units, jobs } = buildWorld();
  // 赛事标准 2025 版在 2026-06-30 到期
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uPerf,
    kind: "competition_standard", source_no: "WSC-STD", version: "2025",
    summary: "赛项标准：性能测试", to: "2026-07-01",
  });
  const evidence = s.evidenceStore.effectiveEvidence({
    unitId: units.uPerf.unit_id, jobId: jobs.jTester.job_id, onDate: "2026-07-02",
  });
  assert.equal(evidence.length, 0, "已过 expires_at 的来源不再可信");
  const inWindow = s.evidenceStore.effectiveEvidence({
    unitId: units.uPerf.unit_id, jobId: jobs.jTester.job_id, onDate: "2026-06-30",
  });
  assert.equal(inWindow.length, 1);
});

test("同一 source_no 的相邻版本可信期相接不重叠，重叠登记被拒绝", () => {
  const { s } = buildWorld();
  s.registerSource({
    source_no: "REC-PLATFORM", version: "2025Q4", kind: "recruitment_data",
    title: "招聘季报", summary: "旧", effective_from: "2026-01-01", expires_at: "2026-04-01",
  });
  // 半开区间端点相接：4/1 新版生效，合法
  s.registerSource({
    source_no: "REC-PLATFORM", version: "2026Q1", kind: "recruitment_data",
    title: "招聘季报", summary: "新", effective_from: "2026-04-01", expires_at: "2026-07-01",
  });
  assert.throws(() => s.registerSource({
    source_no: "REC-PLATFORM", version: "2026Q1x", kind: "recruitment_data",
    title: "招聘季报", summary: "重叠", effective_from: "2026-03-01", expires_at: "2026-05-01",
  }), /可信期重叠/);
});

test("同一条来源在一个统计周期只能贡献一次权重", () => {
  const { s, units, jobs } = buildWorld();
  const { source } = approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uPerf,
    source_no: "ENT-SURVEY-A", kind: "enterprise_survey", orgId: "org-a",
  });
  // 同来源再为另一条能力提提案并批准 -> 被拒（贡献键 period|source 唯一）
  const p2 = s.createProposal({
    period_id: "P2026H1", job_id: jobs.jTester.job_id, unit_id: units.uTestAuto.unit_id,
    source_id: source.source_id, proposed_by: "analyst-2",
  });
  s.submitProposal(p2.proposal_id);
  assert.throws(() => s.approveProposal(p2.proposal_id, "officer-2"), /已贡献过权重/);
  // 下一个统计周期同一来源可以再次贡献
  s.openPeriod({ period_id: "P2026H2", starts_on: "2026-07-01", ends_on: "2027-01-01" });
  const p3 = s.createProposal({
    period_id: "P2026H2", job_id: jobs.jTester.job_id, unit_id: units.uTestAuto.unit_id,
    source_id: source.source_id, proposed_by: "analyst-2",
  });
  s.submitProposal(p3.proposal_id);
  assert.doesNotThrow(() => s.approveProposal(p3.proposal_id, "officer-2"));
});

test("存在利益关系的企业代表不得审批对应权重，他人可正常审批，且回避留痕", () => {
  const { s, units, jobs } = buildWorld();
  const source = s.registerSource({
    source_no: "ENT-BIASED", version: "v1", kind: "enterprise_survey",
    title: "企业调研", summary: "来自甲企业", org_id: "org-b",
    effective_from: "2026-01-01", expires_at: "2027-01-01",
  });
  s.registerConflict({ rep_id: "rep-b", org_id: "org-b", reason: "本人任职甲企业" });
  const p = s.createProposal({
    period_id: "P2026H1", job_id: jobs.jTester.job_id, unit_id: units.uPerf.unit_id,
    source_id: source.source_id, proposed_by: "analyst-1",
  });
  s.submitProposal(p.proposal_id);
  assert.throws(() => s.approveProposal(p.proposal_id, "rep-b"), /利益关系/);
  assert.throws(() => s.rejectProposal(p.proposal_id, "rep-b", "不同意"), /利益关系/);
  // 代表可以主动登记回避，提案仍可由无关联代表审批
  s.recuseReview({ proposal_id: p.proposal_id, rep_id: "rep-b" });
  const approved = s.approveProposal(p.proposal_id, "officer-9");
  assert.equal(approved.proposal.status, "approved");
  assert.equal(s.repository.recusals.values().length, 1);
});

test("同一映射在同一周期出现 include 与 exclude 互斥证据时进入 disputed", () => {
  const { s, units, jobs } = buildWorld();
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uDenture,
    source_no: "S-INCLUDE", kind: "enterprise_survey", stance: "include",
  });
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uDenture,
    source_no: "S-EXCLUDE", kind: "recruitment_data", stance: "exclude",
  });
  const mapping = s.governance.mapping(jobs.jTester.job_id, units.uDenture.unit_id);
  assert.equal(mapping.status, "disputed");
});
