/**
 * 技能赛项职业映射证据库的应用服务入口。
 * 一个 Service 实例组装全部模块；register/find/health 保持与基线兼容。
 */
import { createRecord } from "./domain.js";
import { Repository } from "./repository.js";
import { Catalog } from "./catalog.js";
import { EvidenceStore } from "./sources.js";
import { Governance } from "./governance.js";
import { Standards } from "./standards.js";
import { Students } from "./students.js";
import { Importer } from "./importer.js";
import { Recommender } from "./recommender.js";
import { Explanations } from "./explanations.js";

export class Service {
  constructor(repository = new Repository()) {
    this.repository = repository;
    this.catalog = new Catalog(repository);
    this.evidenceStore = new EvidenceStore(repository);
    this.governance = new Governance(repository);
    this.standardsService = new Standards(repository, this.governance);
    this.students = new Students(repository);
    this.importer = new Importer(repository, this.evidenceStore);
    this.recommender = new Recommender(repository, this.catalog, this.governance, this.students);
    this.explanations = new Explanations(repository, this.recommender, this.standardsService);
  }

  health() { return { service: "skills_career_mapping", status: "ok" }; }

  /** 基线兼容：基础记录登记与查询。 */
  register(payload) { return this.repository.add(createRecord(payload)); }
  find(recordId) { return this.repository.get(String(recordId)); }

  /* 目录 */
  registerSkill(p) { return this.catalog.registerSkill(p); }
  registerUnit(p) { return this.catalog.registerUnit(p); }
  registerJob(p) { return this.catalog.registerJob(p); }
  registerMajor(p) { return this.catalog.registerMajor(p); }
  registerRegionDemand(p) { return this.catalog.registerRegionDemand(p); }
  linkMajorJob(p) { return this.catalog.linkMajorJob(p); }
  setMajorBaseline(id, units) { return this.catalog.setMajorBaseline(id, units); }

  /* 来源与证据 */
  registerSource(p) { return this.evidenceStore.registerSource(p); }
  addEvidence(p) { return this.evidenceStore.addEvidence(p); }

  /* 治理：周期、利益关系、提案审批、映射 */
  openPeriod(p) { return this.governance.openPeriod(p); }
  closePeriod(id) { return this.governance.closePeriod(id); }
  registerConflict(p) { return this.governance.registerConflict(p); }
  recuseReview(p) { return this.governance.recuseReview(p); }
  createProposal(p) { return this.governance.createProposal(p); }
  submitProposal(id) { return this.governance.submitProposal(id); }
  approveProposal(id, approver, note) { return this.governance.approveProposal(id, approver, note); }
  rejectProposal(id, approver, reason) { return this.governance.rejectProposal(id, approver, reason); }
  recomputeMapping(job, unit, period) { return this.governance.recomputeMapping(job, unit, period); }

  /* 标准换版 */
  registerStandardVersion(p) { return this.standardsService.registerVersion(p); }
  reviseStandard(p) { return this.standardsService.revise(p); }

  /* 学生 */
  recordAchievement(p) { return this.students.recordAchievement(p); }
  createPlan(p) { return this.students.createPlan(p); }
  addUnitsToPlan(id, units) { return this.students.addUnitsToPlan(id, units); }
  resolveReevaluation(id, note) { return this.students.resolveReevaluation(id, note); }

  /* 批量导入 */
  importBatch(rows, opts) { return this.importer.importBatch(rows, opts); }
  resolveReview(id, decision, reviewer) { return this.importer.resolveReview(id, decision, reviewer); }

  /* 推荐：分片、恢复、配额 */
  startRecommendationRun(p) { return this.recommender.startRun(p); }
  processShard(runId, majorId) { return this.recommender.processShard(runId, majorId); }
  resumeRun(runId, opts) { return this.recommender.resume(runId, opts); }
  getRun(runId) { return this.recommender.getRun(runId); }
  quotaStatus(runId) { return this.recommender.quotaStatus(runId); }
  topUpQuota(runId, amount) { return this.recommender.topUpQuota(runId, amount); }

  /* 解释接口 */
  explainMajor(majorId, runId) { return this.explanations.explainMajor(majorId, runId); }
  explainPlan(planId) { return this.explanations.explainPlan(planId); }
  plansNeedingReevaluation(opts) { return this.explanations.plansNeedingReevaluation(opts); }
}
