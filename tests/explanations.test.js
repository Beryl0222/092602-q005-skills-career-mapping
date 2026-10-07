import test from "node:test";
import assert from "node:assert/strict";
import { buildWorld, approveEvidence, TODAY } from "./fixtures.js";

test("解释接口列出被回避的企业意见与被驳回提案", () => {
  const { s, units, jobs, majors } = buildWorld();

  // 甲企业代表的意见：登记利益关系并主动回避，提案由他人驳回 -> 两种回避都应可见
  const biased = s.registerSource({
    source_no: "ENT-BIASED-X", version: "v1", kind: "enterprise_survey",
    title: "甲企业调研", summary: "要求增列厂商私有工具", org_id: "org-x",
    effective_from: "2026-01-01", expires_at: "2027-01-01",
  });
  s.registerConflict({ rep_id: "rep-x", org_id: "org-x", reason: "受聘于甲企业" });
  const p = s.createProposal({
    period_id: "P2026H1", job_id: jobs.jTester.job_id, unit_id: units.uPerf.unit_id,
    source_id: biased.source_id, proposed_by: "rep-x", rationale: "厂商专属工具能力",
  });
  s.submitProposal(p.proposal_id);
  s.recuseReview({ proposal_id: p.proposal_id, rep_id: "rep-x" });
  s.rejectProposal(p.proposal_id, "officer-neutral", "属厂商私有工具，非通用能力");

  // 另一条无争议来源支持增列
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uPerf,
    source_no: "WSC-CLEAN", kind: "competition_standard",
  });

  s.startRecommendationRun({ period_id: "P2026H1", run_id: "RX", as_of: TODAY });
  s.resumeRun("RX");
  const explain = s.explainMajor(majors.mSoft.major_id);
  const addPerf = explain.add.find((d) => d.unit_code === "ST-PERF");
  const kinds = addPerf.avoided_opinions.map((o) => o.kind).sort();
  assert.deepEqual(kinds, ["recusal", "rejected_proposal"]);
  assert.equal(addPerf.evidence_adopted.length, 1, "被驳回/回避来源不进入采用证据");
  assert.equal(addPerf.evidence_adopted[0].source_no, "WSC-CLEAN");
});

test("解释接口标注每条建议采用证据的标准版本与可信期时点", () => {
  const { s, units, jobs, majors } = buildWorld();
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uPerf,
    source_no: "STD-DOC", version: "2025", kind: "competition_standard",
    standardNo: "WSC-ST", standardVersion: "2025",
  });
  s.startRecommendationRun({ period_id: "P2026H1", run_id: "RY", as_of: TODAY });
  s.resumeRun("RY");
  const explain = s.explainMajor(majors.mSoft.major_id, "RY");
  const addPerf = explain.add.find((d) => d.unit_code === "ST-PERF");
  assert.equal(addPerf.standards[0], "WSC-ST@2025");
  assert.deepEqual(addPerf.evidence_adopted[0].effective_window, ["2026-01-01", "2027-01-01"]);
  assert.equal(explain.as_of, TODAY);
});

test("未生成推荐时解释接口给出明确提示而非报错", () => {
  const { s, majors } = buildWorld();
  const out = s.explainMajor(majors.mSoft.major_id);
  assert.equal(out.generated, false);
  assert.match(out.message, /尚无/);
});
