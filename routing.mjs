// 选钥匙 / 分类失败 / 算冷却，纯函数，方便单测
//
// 打分（2026-11-25 第二次重写，换成「配额当量速度偏差」）：
//   每档窗口 w 有：已用 p（%）、本轮长度 T（小时）、已经过 e（小时）。
//   按时间应该用掉的量 = 100·e/T。实际比它多，说明超前（会提前耗尽，该少派活）；
//   比它少，说明时间在走而额度没用（要白扔，该多派活）。
//   三档按容量占比加权（5h 档只占月度的 20%，周 50%，月 100%），加总成一个数：
//       B = Σ 占比_w · ( p_w − 100·e_w/T_w )     单位：月度当量百分点
//   再叠加负载与失败，取最小：
//       score = B + 在途数×0.3 + 近期失败×1.0
//   剔除条件只有一条：R ≤ 0（某档真的用满了）。R = min 占比_w·(100−p_w)，就是"还能用多少"。
//
// 为什么不用「预计停机小时」：那要拿一天的样本外推一个月，误差能翻十倍；还要在三档之间比较
// 5 小时和 720 小时两个量纲。B 只用"你烧得比时间快还是慢"，不外推、不用阈值、三档天然可比。
import crypto from "node:crypto";

export const WINDOW_NAMES = ["rolling", "weekly", "monthly"];

// 三档的默认权重：按平台容量占比 20% / 50% / 100%。可在界面里调（windowWeights）
export const WINDOW_SHARE = { rolling: 0.2, weekly: 0.5, monthly: 1 };

export const DEFAULTS = {
  cooldown: {
    rateLimitMs: 30_000,
    authErrorMs: 600_000,
    upstreamMs: 8_000,
    maxMs: 600_000,
    jitter: 0.25,
  },
  routing: {
    windowHours: { rolling: 5, weekly: 168, monthly: 744 }, // 只作反推起点用；有 startMs 时以实际为准
    // “预期用光时点”：不用等窗口到期，提前烧完。1 = 按真实时长匀速。
    // 0.6 表示月窗 30 天时预期 18 天用完，0.8 表示周窗 7 天时预期 5.6 天用完。
    targetShare: { rolling: 1, weekly: 0.8, monthly: 0.6 },
    // 三档在打分里各占多少份量。默认等于容量占比，改成 1/1/1 就等于三档平权
    windowWeights: { rolling: 0.2, weekly: 0.5, monthly: 1 },
    loadPoints: 0.3, // 一个在途请求 = 0.3 个月度当量百分点（约 3 个典型请求）
    failPoints: 1.0, // 一次近期失败 = 1 个点
    tiePoints: 0.3, // 差距小于这个算并列（约一个典型请求）
    sticky: true,
    stickyTtlMs: 30 * 60_000,
  },
  maxAttempts: 0, // 0 = 不超过钥匙数量的尝试
  queueTimeoutMs: 180_000,
  queueOnCooldownMs: 45_000, // 全在冷却时，若最近的一把在这么久内恢复就等着，不直接回 429
  retrySameKeyMs: 1_500, // 5xx / 连接失败时，同一把钥匙先等这么久重试一次
};

export function classifyStatus(status) {
  if (status === 429) return "rate";
  if (status === 401 || status === 403 || status === 402) return "auth"; // 402 = 这把钥匙的账号没额度了，换一把
  if (status === 408 || (status >= 500 && status <= 599)) return "upstream";
  if (status >= 200 && status < 300) return "ok";
  return "fatal"; // 4xx 类，换钥匙也没用
}

// 2xx 但内容里其实是错误（少见，但真实存在）
export function bodyLooksErrored(text) {
  if (!text) return false;
  const t = text.trim();
  if (!t.startsWith("{")) return false;
  try {
    const j = JSON.parse(t);
    if (!j || typeof j !== "object") return false;
    if (j.error && !j.choices && !j.output && !j.content) return true;
  } catch {
    return false;
  }
  return false;
}

export function cooldownMs(kind, fails, retryAfterSec, cfg, rnd = Math.random) {
  const c = cfg.cooldown ?? DEFAULTS.cooldown;
  const max = c.maxMs ?? DEFAULTS.cooldown.maxMs;
  if (kind === "auth") {
    const base = c.authErrorMs ?? DEFAULTS.cooldown.authErrorMs;
    return Math.min(max, base * Math.pow(1.5, Math.max(0, fails - 1)));
  }
  if (kind === "rate" && Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(max, Math.round(retryAfterSec * 1000));
  }
  const base =
    kind === "rate"
      ? (c.rateLimitMs ?? DEFAULTS.cooldown.rateLimitMs)
      : (c.upstreamMs ?? DEFAULTS.cooldown.upstreamMs);
  const exp = Math.min(max, base * Math.pow(2, Math.max(0, fails - 1)));
  const jitter = 1 + (rnd() * 2 - 1) * (c.jitter ?? 0);
  // 抖动只在封顶内浮动，保证 maxMs 真的是上限
  return Math.max(1000, Math.min(max, Math.round(exp * jitter)));
}

/* ---------------- 额度窗口 ---------------- */

/** 单档进度：已用百分比、本轮长度、已过时长、按预期到目前该用多少 */
export function windowProgress(win, now, fallbackHours, targetShare = 1) {
  if (!win || typeof win !== "object") return null;
  const rawPercent = Number(String(win.percent ?? "").replace("%", "").trim());
  if (!Number.isFinite(rawPercent)) return null;
  const percent = Math.min(100, Math.max(0, rawPercent)); // 越界值一律裁回去
  const expected = Number(fallbackHours);
  let fullHours = Number(win.fullHours) > 0 ? Number(win.fullHours) : expected;
  // 定长窗口（5 小时 / 168 小时）不可能只有几分钟——那是起点算错了，回到标准长度
  if (Number.isFinite(expected) && expected > 0 && fullHours < expected * 0.5) fullHours = expected;
  if (!Number.isFinite(fullHours) || fullHours <= 0) fullHours = null;

  const beta = Number(targetShare) > 0 && Number(targetShare) <= 1 ? Number(targetShare) : 1;
  const resetAtMs = Number(win.resetAtMs) || (win.resetsAt ? Date.parse(win.resetsAt) : NaN);
  // 一份快照过期了（重置点已经过去超过一分钟）：这一档的数字不可信，不参与打分。
  // 否则“预期早已过线 + 已用 0%”会把它算成极度落后，反而抢走所有流量。
  if (Number.isFinite(resetAtMs) && resetAtMs > 0 && resetAtMs <= now - 60_000) return null;

  const startMs = Number(win.startMs);
  let elapsedHours = NaN;
  if (Number.isFinite(startMs) && startMs > 0) elapsedHours = (now - startMs) / 3_600_000;
  else if (Number.isFinite(resetAtMs) && fullHours) elapsedHours = fullHours - (resetAtMs - now) / 3_600_000;

  if (!fullHours) {
    // 没有窗口长度也算一份数据：余量还能用，只是没法定预期线
    return { percent, elapsedHours: null, fullHours: null, targetHours: null, targetShare: beta, proRata: null, resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : 0 };
  }
  if (!Number.isFinite(elapsedHours)) {
    return { percent, elapsedHours: null, fullHours, targetHours: fullHours * beta, targetShare: beta, proRata: null, resetAtMs: Number.isFinite(resetAtMs) ? resetAtMs : 0 };
  }
  const e = Math.min(Math.max(elapsedHours, 0), fullHours);
  const targetHours = fullHours * beta; // 预期在这一刻把本档用到 100%
  return {
    percent,
    elapsedHours: e,
    fullHours,
    targetHours,
    targetShare: beta,
    // 预期线：到 targetHours 时刚好 100%，之后封顶 100%（“按预期你早该用完了”）
    proRata: Math.min(100, (100 * e) / targetHours),
    resetAtMs: Number.isFinite(resetAtMs) && resetAtMs > 0 ? resetAtMs : 0,
  };
}

/**
 * 一把钥匙的完整拆解：
 *   B       月度当量速度偏差（负=落后于时间线，该多派活；正=超前，该少派活）
 *   R       还能用多少（min 三档剩余，月度当量百分点）；≤0 表示某档真的满了
 *   windows 每档的明细，给界面用
 */
export function breakdownOf(cand, cfg, now = Date.now()) {
  const r = (cfg && cfg.routing) ?? DEFAULTS.routing;
  const periods = { ...DEFAULTS.routing.windowHours, ...((r && r.windowHours) || {}) };
  const targets = { ...DEFAULTS.routing.targetShare, ...((r && r.targetShare) || {}) };
  const shares = { ...WINDOW_SHARE, ...((r && r.windowWeights) || {}) };
  const wins = (cand && cand.windows) || {};
  const rows = [];
  let B = 0;
  let R = null;
  let hasData = false;
  for (const name of WINDOW_NAMES) {
    const share = Number.isFinite(Number(shares[name])) ? Number(shares[name]) : WINDOW_SHARE[name];
    const w = windowProgress(wins[name], now, periods[name], targets[name]);
    if (!w) {
      rows.push({ name, share, missing: true });
      continue;
    }
    hasData = true;
    const dev = w.proRata == null ? 0 : w.percent - w.proRata;
    const contrib = share * dev;
    const room = share * (100 - w.percent);
    rows.push({
      name,
      share,
      missing: false,
      percent: w.percent,
      elapsedHours: w.elapsedHours,
      fullHours: w.fullHours,
      targetHours: w.targetHours,
      targetShare: w.targetShare,
      proRata: w.proRata,
      dev,
      contrib,
      room,
      resetAtMs: w.resetAtMs,
    });
    B += contrib;
    R = R == null ? room : Math.min(R, room);
  }
  const active = cand && Number(cand.active) > 0 ? Number(cand.active) : 0;
  const fails = cand && Number(cand.fails) > 0 ? Number(cand.fails) : 0;
  const betaLoad = Number.isFinite(Number(r.loadPoints)) ? Number(r.loadPoints) : 0.3;
  const betaFail = Number.isFinite(Number(r.failPoints)) ? Number(r.failPoints) : 1;
  const load = active * betaLoad;
  const fail = fails * betaFail;
  return {
    total: B + load + fail,
    B,
    R,
    hasData,
    active,
    fails,
    load,
    fail,
    betaLoad,
    betaFail,
    windows: rows,
  };
}

export function scoreOf(cand, cfg, now = Date.now()) {
  return breakdownOf(cand, cfg, now).total;
}

/** 还有余量（没有哪档真的用满）。没有额度数据时按“未知、可用”处理，不加惩罚常数。 */
export function hasRoom(cand, cfg, now = Date.now()) {
  const b = breakdownOf(cand, cfg, now);
  return b.R == null ? true : b.R > 0;
}

export function fits(cand) {
  const cap = cand.probe ? 1 : cand.maxConcurrent || 0;
  return !cap || (cand.active || 0) < cap;
}

/** 并列时用来“先烧先到期”的判据：最早就重置、且还没满的那档 */
function earliestExpiry(cand, breakdown) {
  let best = Number.POSITIVE_INFINITY;
  for (const row of breakdown.windows || []) {
    if (!row || row.missing) continue;
    if (row.percent >= 100) continue;
    if (row.resetAtMs > 0 && row.resetAtMs < best) best = row.resetAtMs;
  }
  return best;
}

/**
 * cands: [{ name, enabled, ready, probe, active, maxConcurrent, fails, windows }]
 * 返回最优先的一把；都不可用时返回 null
 */
export function pickKey(cands, cfg, now = Date.now()) {
  const r = (cfg && cfg.routing) ?? DEFAULTS.routing;
  const usable = (cands || []).filter((c) => c && c.enabled !== false && c.ready && fits(c));
  if (!usable.length) return null;

  const scored = usable.map((c) => ({ c, b: breakdownOf(c, cfg, now) }));
  const withRoom = scored.filter((x) => x.b.R == null || x.b.R > 0);
  // 全池都满了也不整池拒绝：仍然挑最划算的一把，让上游自己去判（429 会进冷却）
  const pool = withRoom.length ? withRoom : scored;

  let best = pool[0];
  for (const x of pool) if (x.b.total < best.b.total) best = x;

  const tol = Number(r.tiePoints ?? 0.3);
  const tied = pool.filter((x) => x.b.total <= best.b.total + tol);
  if (tied.length <= 1) return best.c;

  // 并列时：近期失败少的先 → 更早到期的那档先烧（额度不用就过期）→ 在途少的先
  tied.sort((a, b) => {
    const fa = a.c.fails || 0;
    const fb = b.c.fails || 0;
    if (fa !== fb) return fa - fb;
    const ea = earliestExpiry(a.c, a.b);
    const eb = earliestExpiry(b.c, b.b);
    if (ea !== eb) return ea < eb ? -1 : 1;
    return (a.c.active || 0) - (b.c.active || 0);
  });
  return tied[0].c;
}

// 会话粘住：同一段前缀尽量用同一把钥匙，保住供应商侧的缓存
export function affinityKey({ bodyText, sessionId, model }) {
  const h = crypto.createHash("sha1");
  if (bodyText) {
    let cacheKey = "";
    let prefix = "";
    try {
      const j = JSON.parse(bodyText);
      cacheKey = typeof j.prompt_cache_key === "string" ? j.prompt_cache_key : "";
      const input = j.messages ?? j.input;
      if (Array.isArray(input)) {
        const flat = (x) => {
          if (typeof x === "string") return x;
          if (Array.isArray(x)) return x.map(flat).join("");
          if (x && typeof x === "object") return flat(x.content ?? x.text ?? "");
          return "";
        };
        prefix = flat(input[0] ?? "").slice(0, 4000);
      }
      h.update(String(j.model || model || ""));
    } catch {
      prefix = bodyText.slice(0, 4000);
    }
    if (cacheKey) return `ck:${cacheKey}`;
    h.update(prefix);
    return `p:${h.digest("hex").slice(0, 16)}`;
  }
  if (sessionId) return `s:${sessionId}`;
  return null;
}
