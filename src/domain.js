/** 基础领域记录及输入校验。 */
export function createRecord(payload) {
  const required = ["record_id", "owner_id", "state"];
  const missing = required.filter((name) => !String(payload[name] ?? "").trim());
  if (missing.length) throw new Error(`缺少必要字段：${missing.join("、")}`);
  const revision = Number(payload.revision ?? 1);
  if (!Number.isInteger(revision) || revision < 1) throw new Error("revision 必须是正整数");
  return Object.freeze({
    record_id: String(payload.record_id), owner_id: String(payload.owner_id),
    state: String(payload.state), revision,
    created_at: payload.created_at || new Date().toISOString(),
  });
}

/** 稳定字符串归一化：键排序 + 去空白，保证同一内容指纹一致。 */
export function normalizeText(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
  return JSON.stringify(value, Object.keys(value ?? {}).sort());
}

/** SHA-256 内容指纹，用于批量导入按“来源版本+摘要”去重。 */
import { createHash } from "node:crypto";
export function fingerprint(parts) {
  return createHash("sha256").update(parts.map(normalizeText).join("")).digest("hex");
}

export function requireFields(payload, fields) {
  const missing = fields.filter((name) => !String(payload[name] ?? "").trim());
  if (missing.length) throw new Error(`缺少必要字段：${missing.join("、")}`);
}

export function nonEmpty(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  return text;
}

export function frozen(values) { return Object.freeze({ ...values }); }

/**
 * 可信期一律表示为 ISO 日期的半开区间 [effective_from, expires_at)，
 * 这样相邻版本可在同一天交接而不重叠、不留缝。
 */
export function asDate(value, label) {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`${label}不能为空`);
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new Error(`${label}不是合法日期：${text}`);
  return text.slice(0, 10);
}

export class DateWindow {
  constructor(from, to) {
    this.effective_from = asDate(from, "effective_from");
    this.expires_at = asDate(to, "expires_at");
    if (this.expires_at <= this.effective_from) {
      throw new Error("可信期必须满足 effective_from < expires_at（半开区间）");
    }
  }
  /** 某日期是否落在窗口内；缺省按今天判断。 */
  covers(date = new Date().toISOString()) {
    const day = String(date).slice(0, 10);
    return day >= this.effective_from && day < this.expires_at;
  }
  /** 与另一窗口是否存在重叠（半开语义，端点相接不算重叠）。 */
  overlaps(other) {
    return this.effective_from < other.expires_at && other.effective_from < this.expires_at;
  }
}

/** 来源是否在“以某日为观察时点”可信：已生效且未失效。 */
export function isEffective(source, onDate) {
  const day = String(onDate).slice(0, 10);
  return day >= source.effective_from && day < source.expires_at;
}

/** 当前可信的来源：已生效且未失效。 */
export function isCurrentlyEffective(source, today = new Date().toISOString()) {
  return isEffective(source, today);
}
