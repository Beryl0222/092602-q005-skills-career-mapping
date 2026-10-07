import test from "node:test";
import assert from "node:assert/strict";
import { buildWorld, approveEvidence, TODAY } from "./fixtures.js";

test("推荐按专业分片：中断后只从未完成分片继续，completed 分片不重复消耗配额", () => {
  const { s, units, jobs, majors } = buildWorld();
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uPerf,
    source_no: "WSC-ST", kind: "competition_standard",
  });
  const run = s.startRecommendationRun({
    period_id: "P2026H1", run_id: "R1", as_of: TODAY, quota_total: 10,
  });
  assert.equal(run.shards.length, 2);

  // 完成第一个分片
  const first = s.processShard("R1", majors.mSoft.major_id);
  assert.equal(first.shard.status, "completed");
  // 重放已完成分片：复用结果，不二次扣费
  const replay = s.processShard("R1", majors.mSoft.major_id);
  assert.equal(replay.reused, true);
  assert.equal(s.quotaStatus("R1").used, 1);

  // 模拟崩溃：分片尚未完成但配额预留已落库（预留键已存在）
  const ledger = s.quotaStatus("R1");
  const mSecId = majors.mSec.major_id;
  s.repository.quotas.put("R1", {
    ...ledger, used: ledger.used + 1,
    reservations: { ...ledger.reservations, [`R1|${mSecId}`]: 1 },
  });
  // resume 从未完成分片继续：沿用既有预留，used 不重复增加
  const resumed = s.resumeRun("R1");
  assert.equal(resumed.results.length, 1, "只处理未完成的那一个分片");
  assert.equal(resumed.results[0].reused, true);
  assert.equal(s.quotaStatus("R1").used, 2);
  assert.equal(s.getRun("R1").status, "completed");
  // 再 resume 没有任何目标，也不扣费
  assert.equal(s.resumeRun("R1").results.length, 0);
  assert.equal(s.quotaStatus("R1").used, 2);
});

test("配额耗尽时分片 blocked 且不消耗配额；追加配额后续跑完成", () => {
  const { s, majors } = buildWorld();
  s.startRecommendationRun({
    period_id: "P2026H1", run_id: "R2", as_of: TODAY, quota_total: 1,
  });
  const [a, b] = s.getRun("R2").shards;
  s.processShard("R2", a.major_id);
  const blocked = s.processShard("R2", b.major_id);
  assert.equal(blocked.quota_exhausted, true);
  assert.equal(blocked.shard.status, "blocked");
  assert.equal(s.quotaStatus("R2").used, 1, "阻塞分片未扣费");
  assert.equal(s.getRun("R2").status, "blocked");

  // 普通 resume 不处理 blocked；追加配额后显式续跑 blocked
  assert.equal(s.resumeRun("R2").results.length, 0);
  s.topUpQuota("R2", 1);
  const resumed = s.resumeRun("R2", { processBlocked: true });
  assert.equal(resumed.results.length, 1);
  assert.equal(s.getRun("R2").status, "completed");
  assert.equal(s.quotaStatus("R2").used, 2);
});

test("推荐内容：基线缺失但证据一致支持的能力建议 add，并给出证据时点与地区窗口", () => {
  const { s, units, jobs, majors } = buildWorld();
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uPerf,
    source_no: "WSC-ST", kind: "competition_standard",
  });
  s.startRecommendationRun({ period_id: "P2026H1", run_id: "R3", as_of: TODAY });
  s.resumeRun("R3");
  const explain = s.explainMajor(majors.mSoft.major_id, "R3");
  const addPerf = explain.add.find((d) => d.unit_code === "ST-PERF");
  assert.ok(addPerf, "性能测试应被建议增列");
  assert.equal(addPerf.evidence_adopted.length, 1);
  assert.equal(addPerf.evidence_adopted[0].source_no, "WSC-ST");
  assert.deepEqual(addPerf.active_regions, ["3301:杭州"]);
  assert.equal(addPerf.avoided_opinions.length, 0);
});

test("证据超出可信期：基线内能力建议 remove，超窗来源单列且不计入", () => {
  const { s, units, jobs, majors } = buildWorld();
  // 自动化测试是现基线能力，但其来源在观察时点之前已到期
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uTestAuto,
    source_no: "OLD-SURVEY", kind: "enterprise_survey", orgId: "org-old",
    from: "2025-01-01", to: "2026-01-01",
  });
  s.startRecommendationRun({ period_id: "P2026H1", run_id: "R4", as_of: "2026-10-01" });
  s.resumeRun("R4");
  const explain = s.explainMajor(majors.mSoft.major_id, "R4");
  const removeAuto = explain.remove.find((d) => d.unit_code === "ST-AUTO");
  assert.ok(removeAuto, "失去在窗证据的基线能力应建议减列");
  assert.equal(removeAuto.evidence_adopted.length, 0);
  assert.equal(removeAuto.evidence_out_of_window[0].source_no, "OLD-SURVEY");
});

test("disputed 映射只产生 hold，绝不静默合并为增减建议", () => {
  const { s, units, jobs, majors } = buildWorld();
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uPerf,
    source_no: "S1", kind: "competition_standard", stance: "include",
  });
  approveEvidence(s, {
    periodId: "P2026H1", job: jobs.jTester, unit: units.uPerf,
    source_no: "S2", kind: "recruitment_data", stance: "exclude",
  });
  s.startRecommendationRun({ period_id: "P2026H1", run_id: "R5", as_of: TODAY });
  s.resumeRun("R5");
  const explain = s.explainMajor(majors.mSoft.major_id, "R5");
  assert.equal(explain.add.length, 0);
  assert.equal(explain.remove.length, 0);
  assert.ok(explain.hold.find((d) => d.unit_code === "ST-PERF"));
});
