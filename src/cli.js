/** 本地 JSON / 演示命令入口。 */
import { readFile } from "node:fs/promises";
import { Service } from "./service.js";
import { buildScenario } from "./demo.js";

const [command, arg] = process.argv.slice(2);

if (command === "validate" && arg) {
  const payload = JSON.parse(await readFile(arg, "utf8"));
  console.log(JSON.stringify(new Service().register(payload)));
} else if (command === "demo") {
  const r = buildScenario();
  console.log(JSON.stringify({
    导入批次: {
      新入库: r.batch.batch.imported_source_ids.length,
      去重: r.batch.duplicates.length,
      进复核: r.batch.reviews.length,
    },
    标准换版: {
      重算映射数: r.revision.revision.affected_pairs.length,
      退役来源数: r.revision.revision.retired_source_ids.length,
      标记重评计划: r.revision.revision.flagged_plan_ids.length,
    },
    软件技术专业建议: {
      建议增列: r.explainSoft.add.map((d) => d.unit_code),
      建议减列: r.explainSoft.remove.map((d) => d.unit_code),
      暂缓待核: r.explainSoft.hold.map((d) => d.unit_code),
      回避意见: r.explainSoft.add.flatMap((d) => d.avoided_opinions.map((o) => o.kind)),
    },
    待重评学生: r.reevaluation.map((p) => ({
      计划: p.plan_id, 受影响能力: p.affected_unit_ids,
      其中已修完: p.already_achieved_units, 新标准: p.new_standard,
    })),
    运行状态: r.service.getRun("DEMO-RUN").status,
    配额实耗: r.service.quotaStatus("DEMO-RUN").used,
  }, null, 2));
} else {
  console.log(JSON.stringify(new Service().health()));
}
