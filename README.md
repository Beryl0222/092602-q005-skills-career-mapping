# 技能赛项职业映射证据库

面向职业院校产教协作办公室的领域服务：把世界技能大赛新增赛项（软件测试、智慧安防、口腔修复等）
转化为专业调整建议时，统一管理**赛项版本、能力单元、行业来源、岗位族谱、地区需求窗口、
课程达成记录、企业利益关系与推荐解释**。只使用 Node.js 内置模块，进程内仓库可替换为持久实现。

## 为什么需要它

赛事标准、企业调研、招聘数据三类材料的**版本与可信期并不一致**，直接合并会产生过时甚至互斥的培养建议。
本库用四条硬约束兜底：

1. **可信期半开区间** `[effective_from, expires_at)`：同一 `source_no` 的版本窗口不得重叠，推荐只采用观察时点在窗的证据，超窗证据单列但不计权；
2. **一个统计周期一条来源只贡献一次权重**（唯一键 `period_id|source_id`）；
3. **标准换版只重算受影响映射**，旧来源在换版日截断退役，无关映射完全不触碰；
4. **学生已完成课程事实 append-only 不可倒退**，换版只能把在读计划标记为 `needs_reevaluation`。

此外：存在利益关系的企业代表既不能批准也不能驳回对应权重提案，回避与驳回都留痕，最终在推荐解释中可查。

## 模块

| 文件 | 职责 |
| --- | --- |
| `src/domain.js` | 基础记录、字段校验、半开日期窗口 `DateWindow`、内容指纹 `fingerprint` |
| `src/repository.js` | 进程内多表仓库（`Table` 键值集合），只负责存取与唯一性 |
| `src/catalog.js` | 赛项、能力单元、岗位族谱、专业、专业-岗位多对多、地区需求窗口 |
| `src/sources.js` | 三类行业来源版本与证据条目、窗口重叠校验、时点有效性查询 |
| `src/governance.js` | 统计周期、权重提案/审批、利益回避、映射重算（active/stale/disputed） |
| `src/standards.js` | 标准版本登记、换版事件、受影响映射推导、增量重算、学生计划标记 |
| `src/students.js` | 课程达成 append-only 事实、学生计划与重评状态 |
| `src/importer.js` | 批量导入：按 `source_no+version+summary` 指纹去重，编号相同内容变化进复核 |
| `src/recommender.js` | 分片推荐运行、配额幂等台账、中断恢复、add/remove/keep/hold 决策 |
| `src/explanations.js` | 院校人员只读接口：专业建议解释、待重评计划、学生计划追溯 |
| `src/service.js` | 组装全部模块的门面，`register/find/health` 与基线兼容 |
| `src/demo.js` | 端到端叙事场景（CLI `demo` 调用） |
| `contracts/evidence-base.json` | 领域契约与不变量清单 |
| `tests/` | 24 个测试：基线 + 六组规则 + 端到端覆盖 |

## 关键流程

**权重审批**：`createProposal → submitProposal → approveProposal`。审批时校验
审批人非提案人、与来源企业无利益关系、本周期该来源尚未贡献；通过后落成不可变贡献并重算对应映射。
`include` 与 `exclude` 同期并存时映射为 `disputed`，不会被静默合并。

**批量导入**：每行计算 SHA-256 指纹。指纹已入库 → `duplicate`；`source_no+version` 相同而指纹不同
→ 进入复核队列（不直接入库）；复核 `accept` 时旧内容窗口截断、新内容入库，`reject` 永久拦截该内容。
批次可安全重跑，不会重复入队或重复扣费。

**标准换版**：`reviseStandard({standard_no, from_version, to_version, period_id, changed_unit_ids, on_date})`
自动推导受影响映射（旧标准来源支撑、新版未接续或声明变化的能力），仅重算这些映射；
旧来源可信期截断到换版日；引用受影响能力的在读计划标记重评（已修完的能力在解释中标注 `already_achieved_units`）。

**分片推荐**：`startRecommendationRun` 按专业切分片；`processShard` 幂等——
配额按 `run_id|major_id` 预留，重放已完成分片不二次扣费；配额不足分片为 `blocked`（不扣费），
`topUpQuota` 后 `resumeRun(runId, {processBlocked:true})` 续跑；崩溃后 `resumeRun` 从未完成分片继续。

**解释接口**：

- `explainMajor(majorId[, runId])`：每个能力的 `add/remove/keep/hold` 理由、采用证据及其标准版本与可信窗口、
  超窗证据、命中的地区需求窗口、被回避（recusal）/被驳回（rejected_proposal）的意见；
- `plansNeedingReevaluation({majorId})`：标准更新后需重评的学生计划及换版事件链；
- `explainPlan(planId)`：学生不可变课程达成事实、计划与受影响能力。

## 运行

```bash
npm test           # 24 个测试
npm run build      # 全部 src/*.js 语法检查
npm run demo       # 端到端叙事场景（含换版、回避、中断续跑）
npm run check:sample
```

项目只依赖 Node.js 内置模块，不需要外部服务。仓库当前为进程内实现，
`Repository` 的各张 `Table` 可在不改领域逻辑的前提下替换为数据库持久化。
