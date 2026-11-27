// 选钥匙逻辑的回归测试：node routing.test.mjs
// 度量（2026-11-25 第二次重写）：B = Σ 容量占比 × (已用% − 按时间应使用的%)，取最小；
// R ≤ 0（某档真的满了）才剔除。下面断言固定的是这两件事。
import assert from "node:assert";
import {
  DEFAULTS,
  WINDOW_SHARE,
  affinityKey,
  bodyLooksErrored,
  breakdownOf,
  classifyStatus,
  cooldownMs,
  hasRoom,
  pickKey,
  scoreOf,
  stableSessionId,
  windowProgress,
  canTake,
  capOf,
  effectiveCap,
  fits,
  probeFor,
} from "./routing.mjs";

const cfg = { cooldown: { ...DEFAULTS.cooldown }, routing: { ...DEFAULTS.routing } };
const H = 3_600_000;
const now = Date.UTC(2026, 10, 25, 4, 30, 0); // 2026-11-25 12:30 (UTC+8)
const near = (a, b, tol = 0.2) => Math.abs(a - b) <= tol;

/** 造一档窗口：fullH 本轮长度，elapsedH 已过去多久，percent 已用百分比 */
const win = (fullH, elapsedH, percent, resetShiftH = 0) => ({
  percent,
  fullHours: fullH,
  startMs: now - elapsedH * H,
  resetAtMs: now + (fullH - elapsedH + resetShiftH) * H,
});
const base = { enabled: true, ready: true, probe: false, active: 0, maxConcurrent: 4, fails: 0 };
const mk = (over) => ({ ...base, ...over });

// 状态分类
assert.equal(classifyStatus(429), "rate");
assert.equal(classifyStatus(401), "auth");
assert.equal(classifyStatus(402), "auth");
assert.equal(classifyStatus(503), "upstream");
assert.equal(classifyStatus(529), "upstream");
assert.equal(classifyStatus(408), "upstream");
assert.equal(classifyStatus(400), "fatal");
assert.equal(classifyStatus(200), "ok");

// 冷却：retry-after、指数退避、抖动、上限
assert.equal(cooldownMs("rate", 1, 5, cfg, () => 0.5), 5000);
const r1 = cooldownMs("rate", 1, 0, cfg, () => 0.5);
const r3 = cooldownMs("rate", 3, 0, cfg, () => 0.5);
assert.ok(r3 >= r1 * 4 - 1, `退避 ${r1} -> ${r3}`);
assert.ok(cooldownMs("auth", 1, 0, cfg, () => 0.5) >= 600_000);
assert.ok(cooldownMs("rate", 50, 0, cfg, () => 0.5) <= cfg.cooldown.maxMs);

/* ---------- 单档进度与速度偏差 ---------- */

// 5 小时档用了 21%、已经过了 70%：落后于时间线，贡献 = 0.2 × (21−70) = −9.8
const p1 = windowProgress(win(5, 3.5, 21), now, 5);
assert.ok(near(p1.proRata, 70, 0.5), `应使用 ${p1.proRata}`);
const b1 = breakdownOf({ windows: { rolling: win(5, 3.5, 21) } }, cfg, now);
assert.ok(near(b1.B, -9.8, 0.2), `B=${b1.B}`);
assert.ok(near(b1.R, 0.2 * 79, 0.2), `R=${b1.R}`);

// 三档按容量占比加权，不是一个窗口说了算
assert.equal(WINDOW_SHARE.rolling, 0.2);
assert.equal(WINDOW_SHARE.weekly, 0.5);
assert.equal(WINDOW_SHARE.monthly, 1);
// 周按 80%（7 天里的 5.6 天）、月按 60%（30 天里的 18 天）就把额度烧完
const mix = breakdownOf({ windows: { rolling: win(5, 3.5, 21), weekly: win(168, 52.8, 32), monthly: win(720, 468.7, 94) } }, cfg, now);
assert.ok(near(mix.B, -9.8 - 3.64 - 6, 0.35), `B=${mix.B}`);

// 预期用光时点：月窗 30 天、已过 18 天 → 应该已用 100%
const monthAt60 = windowProgress(win(720, 432, 40), now, 720, 0.6);
assert.equal(Math.round(monthAt60.proRata), 100, `应 ${monthAt60.proRata}`);
assert.ok(near(monthAt60.targetHours, 432, 1));
// 已过 6 天（1/3 的预期时长）→ 应该已用 1/3
assert.ok(near(windowProgress(win(720, 144, 40), now, 720, 0.6).proRata, 33.3, 0.5));
// 周窗 7 天、预期 5.6 天：已过 2.8 天 → 应该一半
assert.ok(near(windowProgress(win(168, 67.2, 60), now, 168, 0.8).proRata, 50, 0.5));
// 起点算错导致“本轮长度”只有几分钟时，回到标准长度（不然预期线瞬间变 100%）
const badLen = windowProgress({ percent: 30, fullHours: 0.05, startMs: now - 0.01 * H, resetAtMs: now + 0.04 * H }, now, 5, 1);
assert.equal(Math.round(badLen.fullHours), 5, `本轮长度=${badLen.fullHours}`);
assert.ok(badLen.proRata < 5, `应=${badLen.proRata}`);
// 5 小时档不压缩
assert.ok(near(windowProgress(win(5, 2.5, 50), now, 5, 1).proRata, 50, 0.5));

// 5h 实际 0%：闲着的时候平台不推进这档额度，所以不管本轮走了多久，预期线一律 100%
assert.equal(windowProgress(win(5, 0.1, 0), now, 5, 1, "rolling").proRata, 100);
assert.equal(windowProgress(win(5, 3.5, 0), now, 5, 1, "rolling").proRata, 100);
// 只有 5h 档这样：周档 0% 还是按时间算（2.8 天过了 5.6 天的一半 → 50%）
assert.ok(near(windowProgress(win(168, 67.2, 0), now, 168, 0.8, "weekly").proRata, 50, 0.5));
// 于是实际 0% 的钥匙被判成落后 100 个点：B 少了 0.2 × 100 = 20，优先派活
const idle5 = mk({ name: "idle5", windows: { rolling: win(5, 0.1, 0) } });
const idleBreak = breakdownOf(idle5, cfg, now);
assert.equal(idleBreak.windows.find((w) => w.name === "rolling").proRata, 100);
assert.ok(near(idleBreak.B, -20, 0.01), `B=${idleBreak.B}`);

// 落后于时间线的更优先（额度要白扔的那个先烧）
const behind = mk({ name: "behind", windows: { rolling: win(5, 3.5, 10) } });
const ahead = mk({ name: "ahead", windows: { rolling: win(5, 3.5, 70) } });
assert.ok(scoreOf(behind, cfg, now) < scoreOf(ahead, cfg, now));
assert.equal(pickKey([ahead, behind], cfg, now).name, "behind");
// 5h 实际 0% 的钥匙排在最前面：一点没用过，额度不用就白扔
assert.equal(pickKey([ahead, behind, idle5], cfg, now).name, "idle5");

// 5 小时档刚开窗、只过了几分钟也不会炸：按真实比例算，没有覆盖率悬崖
const fresh = breakdownOf({ windows: { monthly: win(720, 0.2, 0.5) } }, cfg, now);
assert.ok(Number.isFinite(fresh.B) && fresh.B > -1, `刚开窗 B=${fresh.B}`);

// 快照过期（重置点已过去）的那档不参与打分：不能把“过期 + 已用 0%”算成极度落后
assert.equal(windowProgress({ percent: 0, fullHours: 168, startMs: now - 200 * H, resetAtMs: now - 32 * H }, now, 168, 0.8), null);
const staleKey = mk({ name: "stale", windows: { weekly: { percent: 0, fullHours: 168, startMs: now - 200 * H, resetAtMs: now - 32 * H } } });
assert.equal(breakdownOf(staleKey, cfg, now).B, 0, "过期数据不该给出负分");
assert.equal(breakdownOf(staleKey, cfg, now).R, null);

// 越界百分比裁回 [0,100]；带 % 号的字符串也要认
assert.equal(windowProgress({ percent: -5, fullHours: 168, resetAtMs: now + 100 * H }, now, 168).percent, 0);
assert.equal(windowProgress({ percent: 250, fullHours: 168, resetAtMs: now + 100 * H }, now, 168).percent, 100);
const noReset = breakdownOf({ windows: { rolling: { percent: "100%" } } }, cfg, now);
assert.equal(noReset.R, 0, "5h 满额必须把余量压到 0");
assert.equal(hasRoom({ windows: { rolling: { percent: "100%" } } }, cfg, now), false);
// 缺 resetsAt 时只算余量，不算预期线
const noLen = breakdownOf({ windows: { rolling: { percent: 40 } } }, cfg, now);
assert.equal(noLen.B, 0);
assert.ok(near(noLen.R, 12, 0.01), `R=${noLen.R}`);

/* ---------- 剔除条件只有 R ≤ 0 ---------- */

const fullRolling = mk({ name: "full", windows: { rolling: win(5, 3.5, 100) } });
assert.equal(hasRoom(fullRolling, cfg, now), false);
assert.equal(pickKey([fullRolling, behind], cfg, now).name, "behind");
// 但全池都满时不整池拒绝：仍然返回一把，让上游自己判
assert.ok(pickKey([fullRolling, mk({ name: "full2", windows: { rolling: win(5, 3.5, 100) } })], cfg, now));
// 99% 不再是硬墙（旧规则会在 99% 直接拒绝）
const almostFull = mk({ name: "almost", windows: { rolling: win(5, 3.5, 99) } });
assert.equal(hasRoom(almostFull, cfg, now), true);
assert.equal(pickKey([almostFull], cfg, now).name, "almost");

// 停用的不选
assert.equal(pickKey([mk({ name: "off", enabled: false, windows: { rolling: win(5, 3.5, 10) } })], cfg, now), null);

/* ---------- 负载 / 失败换算成同一个单位 ---------- */

const busy = mk({ name: "busy", active: 3, windows: { rolling: win(5, 3.5, 10) } });
assert.ok(near(scoreOf(busy, cfg, now) - scoreOf(behind, cfg, now), 3 * DEFAULTS.routing.loadPoints, 0.01));
const sick = mk({ name: "sick", fails: 3, windows: { rolling: win(5, 3.5, 10) } });
assert.ok(near(scoreOf(sick, cfg, now) - scoreOf(behind, cfg, now), 3 * DEFAULTS.routing.failPoints, 0.01));
assert.equal(pickKey([sick, behind], cfg, now).name, "behind");

// 冷却后试探只放一个
assert.equal(pickKey([mk({ name: "p", probe: true, active: 1, windows: { rolling: win(5, 3.5, 10) } })], cfg, now), null);

/* ---------- 试探：放几个位、什么时候不放 ---------- */

// 位子数：默认 1，放宽也不超过配置值；0 仍然是不限
assert.equal(capOf({ probe: true, maxConcurrent: 10, probeCap: 1 }), 1);
assert.equal(capOf({ probe: true, maxConcurrent: 10, probeCap: 3 }), 3);
assert.equal(capOf({ probe: true, maxConcurrent: 2, probeCap: 3 }), 2, "放宽不能超过配置值");
assert.equal(capOf({ probe: false, maxConcurrent: 10 }), 10);
assert.equal(capOf({ probe: true, maxConcurrent: 0, probeCap: 3 }), 3);
assert.equal(effectiveCap({ cap: 3, probe: true, maxConcurrent: 10 }), 3, "算好的 cap 优先");
assert.equal(effectiveCap({ probe: true, maxConcurrent: 10, probeCap: 3 }), 3);
assert.equal(effectiveCap({ probe: true, maxConcurrent: 10 }), 1);
assert.equal(effectiveCap({ cap: 0, probe: false, maxConcurrent: 10 }), 0, "0 = 不限");
assert.equal(fits({ probe: true, maxConcurrent: 10, active: 1 }), false);
assert.equal(fits({ probe: false, maxConcurrent: 10, active: 1 }), true);
assert.equal(fits({ probe: true, maxConcurrent: 10, probeCap: 3, active: 2 }), true);

// 只剩自己一把能接活时不试探（单点故障不能再把并发压到 1）
assert.equal(probeFor({ halfOpen: true, fails: 1 }, 2), true);
assert.equal(probeFor({ halfOpen: true, fails: 1 }, 1), false);
assert.equal(probeFor({ halfOpen: true, fails: 1 }, 0), false, "别的钥匙都接不了更不该自我降级");
assert.equal(probeFor({ halfOpen: false, fails: 0 }, 2), false);
assert.equal(probeFor({ halfOpen: true, fails: 0 }, 2), false, "失败数归零就不再半开");

// “还能接活”的判据：冷却中 / 占满 / 停用 都不算
assert.equal(canTake({ enabled: true, ready: true, maxConcurrent: 4, active: 3 }), true);
assert.equal(canTake({ enabled: true, ready: true, maxConcurrent: 4, active: 4 }), false);
assert.equal(canTake({ enabled: true, ready: false, maxConcurrent: 4, active: 0 }), false);
assert.equal(canTake({ enabled: false, ready: true, maxConcurrent: 4, active: 0 }), false);
assert.equal(canTake({ enabled: true, ready: true, maxConcurrent: 0, active: 99 }), true, "0 = 不限");

/* ---------- 并列 ---------- */

const sameB = (name, shift) =>
  mk({ name, windows: { monthly: { percent: 20, fullHours: 720, startMs: now - 26 * H, resetAtMs: now + (300 + shift) * H } } });
const soonExpire = sameB("soon", -200);
const laterExpire = sameB("later", 200);
assert.ok(near(scoreOf(soonExpire, cfg, now), scoreOf(laterExpire, cfg, now), 0.01), "两者应同分");
assert.equal(pickKey([laterExpire, soonExpire], cfg, now).name, "soon", "并列时先烧快到期的那档");

/* ---------- 查不到额度：中性，不加惩罚常数 ---------- */

const unknown = mk({ name: "unknown", windows: null });
const ub = breakdownOf(unknown, cfg, now);
assert.equal(ub.B, 0);
assert.equal(ub.R, null);
assert.equal(hasRoom(unknown, cfg, now), true);
assert.equal(pickKey([unknown], cfg, now).name, "unknown");

/* ---------- 2026-11-25 12:30 的实测状态回归 ---------- */
// 008：5h 21%/已过 70%，周 32%/31.4%，月 94%/65.1%（12-06 重置）
// 009：5h 100%/已过 70%，周 40%/31.4%，月 20%/3.6%（12-24 重置）
const k008 = mk({
  name: "008",
  windows: { rolling: win(5, 3.5, 21), weekly: win(168, 52.8, 32), monthly: win(720, 468.7, 94) },
});
const k009 = mk({
  name: "009",
  windows: { rolling: win(5, 3.5, 100), weekly: win(168, 52.8, 40), monthly: win(720, 26, 20) },
});
assert.ok(near(breakdownOf(k008, cfg, now).B, -19.4, 0.35), `008 B=${breakdownOf(k008, cfg, now).B}`);
assert.ok(near(breakdownOf(k008, cfg, now).R, 6, 0.1));
assert.ok(near(breakdownOf(k009, cfg, now).B, 20.3, 0.35), `009 B=${breakdownOf(k009, cfg, now).B}`);
assert.equal(breakdownOf(k009, cfg, now).R, 0, "009 的 5h 满了");
assert.equal(pickKey([k008, k009], cfg, now).name, "008", "5h 满的那把先出局");

// 009 的 5h 重置后仍然略差于 008：008 继续走
const k009after = mk({
  name: "009",
  windows: { rolling: win(5, 0.1, 0), weekly: win(168, 52.8, 40), monthly: win(720, 26, 20) },
});
assert.ok(hasRoom(k009after, cfg, now));
assert.equal(pickKey([k008, k009after], cfg, now).name, "008");

/* ---------- 其他 ---------- */

// 会话指纹
const body = (ck, text) => JSON.stringify({ model: "m", prompt_cache_key: ck, input: [{ role: "user", content: text }] });
assert.equal(affinityKey({ bodyText: body("abc", "x") }), "ck:abc");
const one = body("", "第一段");
const two = JSON.stringify({ model: "m", input: [{ role: "user", content: "第一段" }, { role: "assistant", content: "y" }] });
assert.equal(affinityKey({ bodyText: one }), affinityKey({ bodyText: two }));
assert.notEqual(affinityKey({ bodyText: one }), affinityKey({ bodyText: body("", "别的") }));

// 会话号：客户端带了就用客户端的；没带就用同一段对话里稳定的指纹，不能每次变
assert.equal(stableSessionId({ headers: { session_id: "s-1" }, fp: "p:aa" }), "s-1");
assert.equal(stableSessionId({ headers: { "x-client-request-id": "r-1" } }), "r-1");
assert.equal(stableSessionId({ headers: {}, bodyText: body("ck-1", "x") }), "ck-1");
const fpOne = affinityKey({ bodyText: one });
assert.equal(stableSessionId({ headers: {}, bodyText: one, fp: fpOne }), `kp-${fpOne}`);
assert.equal(
  stableSessionId({ headers: {}, bodyText: one, fp: fpOne }),
  stableSessionId({ headers: {}, bodyText: two, fp: fpOne }),
  "同一段对话前缀 → 同一个会话号",
);
assert.notEqual(
  stableSessionId({ headers: {}, bodyText: one, fp: fpOne }),
  stableSessionId({ headers: {}, bodyText: body("", "别的"), fp: affinityKey({ bodyText: body("", "别的") }) }),
);
assert.equal(stableSessionId({ headers: {} }), null, "什么都没有时返回 null，由调用方兜底");

// 200 里包错误
assert.equal(bodyLooksErrored('{"error":{"message":"x"}}'), true);
assert.equal(bodyLooksErrored('{"output":[{"type":"message"}]}'), false);

console.log("routing tests passed");
