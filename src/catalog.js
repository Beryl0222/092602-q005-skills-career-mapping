/**
 * 静态/缓变目录：赛项版本、能力单元、岗位族谱、专业、地区需求窗口。
 * 目录只回答“有什么”，权重与推荐在其他模块处理。
 */
import { requireFields, nonEmpty, frozen, asDate } from "./domain.js";

let seq = 0;
const nextId = (prefix) => `${prefix}-${(++seq).toString(36)}${Date.now().toString(36)}`;

export class Catalog {
  constructor(repo) { this.repo = repo; }

  /** 登记赛项（世界技能大赛新增/既有赛项），同一编号可有多个版本行。 */
  registerSkill(payload) {
    requireFields(payload, ["skill_code", "name", "standard_version"]);
    const id = payload.skill_id || nextId("sk");
    const row = frozen({
      skill_id: id,
      skill_code: nonEmpty(payload.skill_code, "skill_code"),
      name: nonEmpty(payload.name, "赛项名称"),
      standard_version: nonEmpty(payload.standard_version, "standard_version"),
      introduced_at: payload.introduced_at ? asDate(payload.introduced_at, "introduced_at") : null,
    });
    return this.repo.skills.insert(id, row);
  }

  /** 登记能力单元（软件测试、智慧安防、口腔修复等岗位的最小可评价能力）。 */
  registerUnit(payload) {
    requireFields(payload, ["code", "name"]);
    const id = payload.unit_id || nextId("u");
    const row = frozen({
      unit_id: id,
      code: nonEmpty(payload.code, "能力单元编号"),
      name: nonEmpty(payload.name, "能力单元名称"),
      category: String(payload.category ?? "general"),
    });
    return this.repo.units.insert(id, row);
  }

  /**
   * 登记岗位族谱节点。parent_job_id 形成族谱（岗位族 -> 岗位 -> 细分岗），
   * 用于沿族谱向上汇总地区需求。
   */
  registerJob(payload) {
    requireFields(payload, ["code", "name"]);
    const id = payload.job_id || nextId("job");
    if (payload.parent_job_id && !this.repo.jobs.has(String(payload.parent_job_id))) {
      throw new Error(`父岗位不存在：${payload.parent_job_id}`);
    }
    const row = frozen({
      job_id: id,
      code: nonEmpty(payload.code, "岗位编号"),
      name: nonEmpty(payload.name, "岗位名称"),
      parent_job_id: payload.parent_job_id ? String(payload.parent_job_id) : null,
    });
    return this.repo.jobs.insert(id, row);
  }

  registerMajor(payload) {
    requireFields(payload, ["code", "name"]);
    const id = payload.major_id || nextId("mj");
    const row = frozen({
      major_id: id,
      code: nonEmpty(payload.code, "专业编号"),
      name: nonEmpty(payload.name, "专业名称"),
    });
    return this.repo.majors.insert(id, row);
  }

  /** 地区 + 需求窗口（半开区间），表示该地区在窗口内对某岗位有需求。 */
  registerRegionDemand(payload) {
    requireFields(payload, ["region_code", "name", "job_id", "window_from", "window_to"]);
    if (!this.repo.jobs.has(String(payload.job_id))) throw new Error(`岗位不存在：${payload.job_id}`);
    const id = payload.demand_id || nextId("reg");
    const window_from = asDate(payload.window_from, "window_from");
    const window_to = asDate(payload.window_to, "window_to");
    if (window_to <= window_from) throw new Error("地区需求窗口必须满足 window_from < window_to");
    const row = frozen({
      demand_id: id,
      region_code: nonEmpty(payload.region_code, "地区编号"),
      name: nonEmpty(payload.name, "地区名称"),
      job_id: String(payload.job_id),
      window_from, window_to,
      note: String(payload.note ?? ""),
    });
    return this.repo.regions.insert(id, row);
  }

  /** 某岗位（含族谱祖先）在给定日期命中需求的地区清单。 */
  activeRegionsForJob(jobId, onDate = new Date().toISOString()) {
    const day = String(onDate).slice(0, 10);
    const chain = this.#ancestorChain(jobId);
    return this.repo.regions.find((d) =>
      chain.includes(d.job_id) && day >= d.window_from && day < d.window_to);
  }

  #ancestorChain(jobId) {
    const chain = [];
    let current = this.repo.jobs.get(String(jobId));
    const guard = new Set();
    while (current && !guard.has(current.job_id)) {
      guard.add(current.job_id);
      chain.push(current.job_id);
      current = current.parent_job_id ? this.repo.jobs.get(current.parent_job_id) : null;
    }
    return chain;
  }

  get units() { return this.repo.units.values(); }
  get jobs() { return this.repo.jobs.values(); }
  get majors() { return this.repo.majors.values(); }

  /** 关联专业与岗位（一个专业可面向多个岗位，多对多）。 */
  linkMajorJob(payload) {
    requireFields(payload, ["major_id", "job_id"]);
    if (!this.repo.majors.has(String(payload.major_id))) throw new Error(`专业不存在：${payload.major_id}`);
    if (!this.repo.jobs.has(String(payload.job_id))) throw new Error(`岗位不存在：${payload.job_id}`);
    const key = `${payload.major_id}|${payload.job_id}`;
    const row = frozen({
      link_id: key, major_id: String(payload.major_id), job_id: String(payload.job_id),
      weight: Number(payload.weight ?? 1),
    });
    return this.repo.majorJobs.put(key, row);
  }

  /** 登记专业现行能力基线（当前培养方案覆盖的能力单元集合）。 */
  setMajorBaseline(majorId, unitIds) {
    if (!this.repo.majors.has(String(majorId))) throw new Error(`专业不存在：${majorId}`);
    const units = [...new Set(unitIds.map(String))];
    for (const unitId of units) {
      if (!this.repo.units.has(unitId)) throw new Error(`能力单元不存在：${unitId}`);
    }
    const row = frozen({ major_id: String(majorId), unit_ids: units, set_at: new Date().toISOString() });
    this.repo.majorUnits.put(String(majorId), row);
    return row;
  }

  jobsForMajor(majorId) {
    return this.repo.majorJobs.find((l) => l.major_id === String(majorId));
  }

  baselineForMajor(majorId) {
    return this.repo.majorUnits.get(String(majorId));
  }
}
