/**
 * 行业来源与证据条目。
 * 三类材料：competition_standard（赛事标准）、enterprise_survey（企业调研）、
 * recruitment_data（招聘数据）。每条来源带版本、摘要与可信期半开窗口；
 * 版本与可信期各自独立，合并映射时必须带证据时点。
 */
import { requireFields, nonEmpty, frozen, asDate, fingerprint, isEffective } from "./domain.js";

export const SOURCE_KINDS = Object.freeze({
  COMPETITION_STANDARD: "competition_standard",
  ENTERPRISE_SURVEY: "enterprise_survey",
  RECRUITMENT_DATA: "recruitment_data",
});
const KINDS = new Set(Object.values(SOURCE_KINDS));

let seq = 0;
const nextId = (p) => `${p}-${(++seq).toString(36)}${Date.now().toString(36)}`;

export class EvidenceStore {
  constructor(repo) { this.repo = repo; }

  /**
   * 登记一条来源版本。source_no 是跨版本稳定标识，version+summary 决定内容指纹。
   * 同一 source_no 的窗口不允许重叠（防止一条来源在同一时点出现两个互相矛盾的版本）。
   */
  registerSource(payload) {
    requireFields(payload, ["source_no", "version", "kind", "title", "effective_from", "expires_at"]);
    const kind = nonEmpty(payload.kind, "来源类型");
    if (!KINDS.has(kind)) throw new Error(`未知来源类型：${kind}`);
    const source_no = nonEmpty(payload.source_no, "source_no");
    const version = nonEmpty(payload.version, "version");
    const summary = String(payload.summary ?? "").trim();
    const effective_from = asDate(payload.effective_from, "effective_from");
    const expires_at = asDate(payload.expires_at, "expires_at");
    if (expires_at <= effective_from) throw new Error("可信期必须满足 effective_from < expires_at");
    const overlap = this.repo.sources.find((s) => s.source_no === source_no &&
      s.effective_from < expires_at && effective_from < s.expires_at);
    if (overlap.length) {
      throw new Error(`来源 ${source_no} 与既有版本 ${overlap[0].version} 可信期重叠`);
    }
    const id = payload.source_id || nextId("src");
    const row = frozen({
      source_id: id, source_no, version, kind,
      title: nonEmpty(payload.title, "来源标题"), summary,
      effective_from, expires_at,
      standard_no: payload.standard_no ? String(payload.standard_no) : null,
      standard_version: payload.standard_version ? String(payload.standard_version) : null,
      org_id: payload.org_id ? String(payload.org_id) : null,
      digest: fingerprint([source_no, version, summary]),
      registered_at: payload.registered_at || new Date().toISOString(),
    });
    return this.repo.sources.insert(id, row);
  }

  /** 登记证据：某来源版本在某时点对“能力单元 x 岗位/赛项”的一条描述。 */
  addEvidence(payload) {
    requireFields(payload, ["source_id", "unit_id"]);
    const source = this.repo.sources.get(String(payload.source_id));
    if (!source) throw new Error(`来源不存在：${payload.source_id}`);
    if (!this.repo.units.has(String(payload.unit_id))) throw new Error(`能力单元不存在：${payload.unit_id}`);
    if (payload.job_id && !this.repo.jobs.has(String(payload.job_id))) {
      throw new Error(`岗位不存在：${payload.job_id}`);
    }
    if (payload.skill_id && !this.repo.skills.has(String(payload.skill_id))) {
      throw new Error(`赛项不存在：${payload.skill_id}`);
    }
    const id = payload.evidence_id || nextId("ev");
    const row = frozen({
      evidence_id: id,
      source_id: source.source_id,
      unit_id: String(payload.unit_id),
      job_id: payload.job_id ? String(payload.job_id) : null,
      skill_id: payload.skill_id ? String(payload.skill_id) : null,
      claim: String(payload.claim ?? ""),
      observed_at: payload.observed_at ? asDate(payload.observed_at, "observed_at")
        : source.effective_from,
    });
    return this.repo.evidence.insert(id, row);
  }

  /** 某观察时点下，关于某能力单元（可限岗位）的全部有效证据。 */
  effectiveEvidence({ unitId, jobId = null, onDate = new Date().toISOString() }) {
    return this.repo.evidence.find((e) => {
      if (e.unit_id !== String(unitId)) return false;
      if (jobId && e.job_id !== String(jobId)) return false;
      const source = this.repo.sources.get(e.source_id);
      return source && isEffective(source, onDate);
    }).map((e) => ({ evidence: e, source: this.repo.sources.get(e.source_id) }));
  }

  /** 找到某来源编号在观察时点有效的版本行（可能为空——此时点无可信版本）。 */
  versionAt(sourceNo, onDate) {
    return this.repo.sources.find((s) => s.source_no === sourceNo && isEffective(s, onDate))[0] ?? null;
  }
}
