// 用量账本的回归测试：缓存命中率怎么读、哪些请求该算进分母、老存档怎么升级。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as usage from "./usage.mjs";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const j = (o) => JSON.stringify(o);
const ex = (u) => usage.extractUsage(j({ usage: u }));

// 各家上游对“缓存命中”的叫法不一样，四种都要认
const a = ex({ input_tokens: 1019, output_tokens: 94, cache_read_input_tokens: 94336 });
check("anthropic：cache_read_input_tokens", a.cacheRead === 94336 && a.promptTotal === 95355 && a.hasCache === true, j(a));

const b = ex({ prompt_tokens: 1000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 900 } });
check("openai：prompt_tokens_details.cached_tokens", b.cacheRead === 900 && b.promptTotal === 1000 && b.hasCache === true, j(b));

const c = ex({ prompt_tokens: 96000, completion_tokens: 10, prompt_cache_hit_tokens: 94000, prompt_cache_miss_tokens: 2000 });
check("deepseek：prompt_cache_hit_tokens", c.cacheRead === 94000 && c.promptTotal === 96000 && c.hasCache === true, j(c));

// responses 接口（pi 走的是这个）：缓存藏在 input_tokens_details 里，input_tokens 已经包含它
const rsp = ex({ input_tokens: 6836, output_tokens: 16, input_tokens_details: { cached_tokens: 6784 } });
check("responses：input_tokens_details.cached_tokens", rsp.cacheRead === 6784 && rsp.promptTotal === 6836 && rsp.hasCache === true, j(rsp));

const d = ex({ prompt_tokens: 5000, completion_tokens: 5, cached_tokens: 0 });
check("直接给 cached_tokens=0：算“测过但没命中”", d.cacheRead === 0 && d.promptTotal === 5000 && d.hasCache === true, j(d));

const e = ex({ prompt_tokens: 5000, completion_tokens: 5 });
check("上游没给缓存字段：不算进分母", e.hasCache === false && e.promptTotal === 5000, j(e));

// 没给的请求不能摊薄命中率
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "keypool-usage-"));
const p = path.join(tmp, "usage.json");
usage.init(p);
usage.addUsage("A", { input: 1000, output: 0, cost: 0.1, cacheRead: 900, promptTotal: 1000, hasCache: true });
usage.addUsage("A", { input: 100000, output: 0, cost: 1, cacheRead: 0, promptTotal: 100000, hasCache: false });
const snap = usage.snapshot();
const t = snap.keys.A.today;
check("只有带缓存字段的请求进分母", t.promptTotal === 1000 && t.cacheRead === 900, j({ promptTotal: t.promptTotal, cacheRead: t.cacheRead }));
check("token 与花费照旧累计", t.input === 101000 && Math.abs(t.cost - 1.1) < 1e-9, j({ input: t.input, cost: t.cost }));

// 老存档（读数坏掉那一版）里那两栏是假的，启动时要清掉
const p2 = path.join(tmp, "old.json");
fs.writeFileSync(
  p2,
  j({ totals: { input: 100, promptTotal: 7125213, cacheRead: 0 }, daily: { "2026-11-27": { input: 5, promptTotal: 9 } }, keys: { B: { day: "2026-11-27", total: { promptTotal: 7 }, today: { promptTotal: 7 } } } }),
);
usage.init(p2);
const s2 = usage.snapshot();
check("老存档的假缓存数被清掉", s2.totals.promptTotal === 0 && s2.keys.B.today.promptTotal === 0 && s2.todayTotals.promptTotal === 0, j({ totals: s2.totals.promptTotal, key: s2.keys.B.today.promptTotal, day: s2.todayTotals.promptTotal }));
check("老存档的其他账没被动", s2.totals.input === 100 && s2.keys.B.today.input === 0, j({ input: s2.totals.input }));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
if (failed.length) process.exitCode = 1;
