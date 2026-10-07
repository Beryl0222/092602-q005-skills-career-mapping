/**
 * 进程内多表仓库，后续可替换为持久实现。
 * 每张表是“编号 -> 冻结行”的键值集合，不做跨表决策，只负责存取与唯一性。
 */
export class Table {
  #rows = new Map();
  constructor(name) { this.name = name; }
  insert(key, row) {
    if (this.#rows.has(key)) throw new Error(`${this.name}编号已存在：${key}`);
    this.#rows.set(key, row);
    return row;
  }
  /** 无条件覆盖（仅用于状态机明确授权的更新）。 */
  put(key, row) { this.#rows.set(key, row); return row; }
  get(key) { return this.#rows.get(key) ?? null; }
  has(key) { return this.#rows.has(key); }
  delete(key) { return this.#rows.delete(key); }
  get size() { return this.#rows.size; }
  values() { return [...this.#rows.values()]; }
  find(predicate) { return this.values().filter(predicate); }
}

export class Repository {
  constructor() {
    this.records = new Table("记录");
    this.skills = new Table("赛项");
    this.units = new Table("能力单元");
    this.jobs = new Table("岗位");
    this.majors = new Table("专业");
    this.majorJobs = new Table("专业岗位关联");
    this.majorUnits = new Table("专业能力基线");
    this.regions = new Table("地区");
    this.sources = new Table("行业来源");
    this.evidence = new Table("证据");
    this.standards = new Table("标准版本");
    this.revisions = new Table("标准换版事件");
    this.periods = new Table("统计周期");
    this.contributions = new Table("权重贡献");
    this.proposals = new Table("权重提案");
    this.conflicts = new Table("企业利益关系");
    this.recusals = new Table("回避记录");
    this.mappings = new Table("岗位能力映射");
    this.achievements = new Table("课程达成");
    this.plans = new Table("学生计划");
    this.importBatches = new Table("导入批次");
    this.reviews = new Table("复核条目");
    this.runs = new Table("推荐运行");
    this.quotas = new Table("配额台账");
    this.recommendations = new Table("推荐");
  }
  /** 兼容基线：基础记录登记与查询。 */
  add(record) { return this.records.insert(record.record_id, record); }
  get(recordId) { return this.records.get(String(recordId)); }
}
