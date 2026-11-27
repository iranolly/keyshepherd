// opencode-go 多钥匙中转
// 选钥匙：按额度松紧 + 当前负载 + 近期失败打分；同一段会话前缀优先粘住同一把（保缓存）
// 换钥匙：429 / 401 / 403 / 5xx / 网络错误 / 2xx 里带 error；冷却退避加抖动，恢复期只放一条试探
// 试探不能没完：拿到 2xx 就放开到满额，20 秒还没回声先放到 3 个位（probeMaxMs），剩下的交给断流检测
// 只剩一把能接活的钥匙时不试探（单点故障再把并发压到 1，等于整池停摆）
// 状态落盘到 state.json，重启不清零
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { handleUi } from "./ui.mjs";
import * as usage from "./usage.mjs";
import {
  DEFAULTS as ROUTING_DEFAULTS,
  affinityKey,
  bodyLooksErrored,
  breakdownOf,
  canTake,
  capOf,
  classifyStatus,
  cooldownMs,
  fits,
  hasRoom,
  pickKey,
  probeFor,
  stableSessionId,
} from "./routing.mjs";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.KP_CONFIG || path.join(DIR, "keys.json");
const STATE_PATH = process.env.KP_STATE || path.join(DIR, "state.json");
const LOG_PATH = process.env.KP_LOG || path.join(DIR, "keypool.log");
const LOG_MAX = 5 * 1024 * 1024;
const QUOTA_URL = process.env.KP_QUOTA_URL || "https://opencode.ai/zen/go/v1/usage";
const QUOTA_TTL = 180_000;
const BODY_CAP = 8 * 1024 * 1024;
const HEADER_TIMEOUT_MS = 120_000;
const IDLE_TIMEOUT_MS = 180_000;

let cfgCache = { mtimeMs: 0, size: 0, cfg: null };
// 失败只算最近一小时：一小时没再出错，惩罚从最短重来。
// 以前这个数是永久累计的，一周前的一串 429 会一直压着这把钥匙的评分和并发。
// 测试可以把窗口调小（KP_FAIL_WINDOW_MS），线上是 1 小时
const FAIL_WINDOW_MS = Number(process.env.KP_FAIL_WINDOW_MS) || 3600e3;

function getFails(s, now = Date.now()) {
  const t = s.failTimes;
  if (!Array.isArray(t)) return s.fails || 0;
  while (t.length && now - t[0] > FAIL_WINDOW_MS) t.shift();
  s.fails = t.length;
  return s.fails;
}

const stats = new Map();
const quotaCache = new Map(); // name -> { at, data, inflight }
const sticky = new Map(); // fingerprint -> { name, at }
let saveTimer = null;

function mask(key) {
  const k = String(key || "");
  return k.length <= 8 ? "***" : `${k.slice(0, 4)}…${k.slice(-4)}`;
}

function state(name) {
  let s = stats.get(name);
  if (!s) {
    s = {
      cooldownUntil: 0,
      fails: 0,
      halfOpen: false,
      total: 0,
      ok: 0,
      rateLimited: 0,
      authErrors: 0,
      errors: 0,
      lastUsed: 0,
      lastStatus: 0,
      active: 0,
      live: new Set(),
      // 半开的代次：失败、进半开、清半开都会 +1；老定时器/老槽位对不上代次就什么也不做
      failSeq: 0,
      // 试探时真正放进去几个位：默认 1，20 秒还没回声放宽到 3
      probeCap: 1,
      // 这次冷却是多久设的（界面用它画倒计时）
      coolTotalMs: 0,
      // 失败的落点时间，超出窗口就丢掉
      failTimes: [],
    };
    stats.set(name, s);
  }
  return s;
}

function hold(s) {
  const tok = { at: Date.now() };
  s.live.add(tok);
  s.active = s.live.size;
  return tok;
}

function drop(s, tok) {
  if (!tok) return;
  if (tok.probeTimer) {
    clearTimeout(tok.probeTimer);
    tok.probeTimer = null;
  }
  if (s.live.delete(tok)) s.active = s.live.size;
  // 放宽过的试探位子要回落到 1：客户端中断 / 总时限 / 4xx 都不走 settle 也不走 strike，
  // 不在这里收回来，下一次“只放一个”就变成“放三个”了
  if (tok.probe && s.halfOpen && tok.seq === s.failSeq && (s.probeCap || 1) > 1) {
    let otherProbe = false;
    for (const t of s.live) {
      if (t.probe && t.seq === s.failSeq) {
        otherProbe = true;
        break;
      }
    }
    if (!otherProbe) s.probeCap = 1;
  }
}

function bumpSeq(s) {
  s.failSeq = (s.failSeq || 0) + 1;
  return s.failSeq;
}

/** 进入半开：只放一个请求去试，并发上限重置回 1 */
function enterProbe(s) {
  s.halfOpen = true;
  s.probeCap = 1;
  bumpSeq(s);
}

function coolDown(s, ms) {
  const until = Date.now() + ms;
  if (until <= s.cooldownUntil) return;
  s.cooldownUntil = until;
  s.coolTotalMs = ms;
}

/** 记一次失败，并把半开的代次推一格（之前那个试探的结果不再作数） */
function strike(s) {
  if (!Array.isArray(s.failTimes)) s.failTimes = [];
  getFails(s);
  s.failTimes.push(Date.now());
  s.fails = s.failTimes.length;
  s.halfOpen = true;
  s.probeCap = 1;
  bumpSeq(s);
}

/** 试探通过：放开到正常并发。代次对不上（期间又失败过/槽位已释放）就什么也不做。 */
function settleProbe(s, name, tok, why) {
  if (!tok || !tok.probe || !s.halfOpen) return false;
  if (tok.seq !== s.failSeq) return false;
  // 槽位已经还回去了（客户端跑了 / 总时限到了），那个 2xx 不能当成“试探通过”的证据
  if (!s.live.has(tok)) return false;
  if (s.cooldownUntil > Date.now()) return false;
  s.halfOpen = false;
  s.fails = 0;
  s.failTimes = [];
  s.probeCap = 1;
  bumpSeq(s);
  if (tok.probeTimer) {
    clearTimeout(tok.probeTimer);
    tok.probeTimer = null;
  }
  log(`PROBE-OPEN key=${name} reason=${why} cap=${s.probeCap}`);
  scheduleSave();
  return true;
}

/** 试探迟迟没有回声：只把位子放宽到 cap，不清失败数（真失败得由失败路径来记） */
function rampProbe(s, name, tok, cap) {
  if (!tok || !tok.probe || !s.halfOpen) return;
  if (tok.seq !== s.failSeq) return;
  if (!s.live.has(tok)) return; // 这次试探已经结束，交给成功/失败去判
  // 已经看过一个失败状态（比如刚回 500、正在等重试）就不要放宽了
  if (tok.lastStatus && (tok.lastStatus < 200 || tok.lastStatus >= 300)) return;
  if ((s.probeCap || 1) >= cap) return;
  s.probeCap = cap;
  log(`PROBE-RAMP key=${name} cap=${cap} 还没拿到响应头`);
  scheduleSave();
}

/** 拿一个槽位。probe 的槽位带代次，并起一个“20 秒还没回声”的定时器 */
function admit(cand, cfg, settle = true) {
  const s = state(cand.name);
  const probe = !!cand.probe && settle;
  const tok = hold(s);
  tok.probe = probe;
  tok.seq = s.failSeq || 0;
  if (probe) {
    const ms = Number(cfg.probeMaxMs) || 0;
    const cap = Math.max(1, Math.min(3, Number(cand.maxConcurrent) || 3));
    if (ms > 0 && cap > 1) {
      tok.probeTimer = setTimeout(() => rampProbe(s, cand.name, tok, cap), ms);
      if (tok.probeTimer.unref) tok.probeTimer.unref();
    }
  }
  return { key: cand, tok, probe };
}

/** 每把钥匙此刻为什么接不了活：给 503 的正文用 */
function blockReport(cfg, tried) {
  const now = Date.now();
  return candidates(cfg, tried).map((c) => ({
    name: c.name,
    enabled: c.enabled,
    coolingSeconds: Math.max(0, Math.ceil((state(c.name).cooldownUntil - now) / 1000)),
    probe: !!c.probe,
    active: c.active,
    cap: c.cap,
  }));
}

function busyText(list, waitedMs) {
  const parts = list.map((k) => {
    if (!k.enabled) return `${k.name} 已停用`;
    if (k.coolingSeconds > 0) return `${k.name} 冷却中，还剩 ${fmtDur(k.coolingSeconds)}`;
    if (k.probe) return `${k.name} 刚出过问题，只放 ${k.cap} 个（现在 ${k.active} 个在跑）`;
    return `${k.name} 满员 ${k.active}/${k.cap || "不限"}`;
  });
  const waited = fmtDur(Math.round((Number(waitedMs) || 0) / 1000));
  return `${parts.join("；")}。等了 ${waited}仍没有空位。`;
}

function fmtDur(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
}

function markOk(s) {
  s.ok++;
  // 冷却中的钥匙被别的在途请求带成 2xx 时，不能清 fails/halfOpen，
  // 否则冷却一到期就按满并发打回去，探针语义也就没了
  if (s.cooldownUntil <= Date.now()) {
    if (s.halfOpen || getFails(s) > 0) {
      // 代次也要推一格：正在飞的试探槽位不能拿这个 2xx 当自己的结论
      s.probeCap = 1;
      bumpSeq(s);
    }
    s.fails = 0;
    s.failTimes = [];
    s.halfOpen = false;
  }
}

function log(line) {
  fs.appendFile(LOG_PATH, `${new Date().toISOString()} ${line}\n`, () => {});
  try {
    if (fs.statSync(LOG_PATH).size > LOG_MAX) fs.renameSync(LOG_PATH, LOG_PATH + ".1");
  } catch {}
}

// opencode 在响应头里自报 server-timing：gateway=它家网关排队，upstream=模型出字。
// 记下来才能分清「上游排队」和「模型慢」，不然只有总耗时没法归因。
function timingOf(headers) {
  const raw = headers ? String(headers["server-timing"] || "") : "";
  if (!raw) return "";
  const parts = {};
  for (const seg of raw.split(",")) {
    const [name, ...rest] = seg.trim().split(";");
    const dur = rest.map((x) => x.trim()).find((x) => x.startsWith("dur="));
    if (!dur) continue;
    const n = Number(dur.slice(4));
    if (Number.isFinite(n)) parts[name.trim()] = Math.round(n);
  }
  if (parts.gateway === undefined && parts.upstream === undefined) return "";
  return ` gw=${parts.gateway ?? "-"} up=${parts.upstream ?? "-"}`;
}

/* ---------------- 配置 ---------------- */

function loadConfig() {
  const st = fs.statSync(CONFIG_PATH);
  if (cfgCache.cfg && st.mtimeMs === cfgCache.mtimeMs && st.size === cfgCache.size) return cfgCache.cfg;
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  const num = (v, d, min = 0) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? n : d;
  };
  const sanitize = (defaults, given) => {
    const out = { ...defaults };
    for (const [k, dv] of Object.entries(defaults)) {
      const v = given ? given[k] : undefined;
      if (v === undefined) continue;
      if (typeof dv === "number") {
        const n = Number(v);
        out[k] = Number.isFinite(n) && n >= 0 ? n : dv;
      } else if (typeof dv === "boolean") {
        out[k] = Boolean(v);
      } else if (dv && typeof dv === "object" && !Array.isArray(dv)) {
        // 嵌套对象（如 windowHours）：只允许覆盖里面已有的数字字段，其余保持默认
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const merged = { ...dv };
          for (const [k2, d2] of Object.entries(dv)) {
            if (typeof d2 !== "number") continue;
            const n = Number(v[k2]);
            if (Number.isFinite(n) && n > 0) merged[k2] = n;
          }
          out[k] = merged;
        }
      }
    }
    return out;
  };
  const cfg = {
    port: num(raw.port, 18787, 1),
    routes: { "opencode-go": "https://opencode.ai/inference/go", ...(raw.routes || {}) },
    cooldown: sanitize(ROUTING_DEFAULTS.cooldown, raw.cooldown),
    routing: sanitize(ROUTING_DEFAULTS.routing, raw.routing),
    maxAttempts: num(raw.maxAttempts, 0),
    queueTimeoutMs: num(raw.queueTimeoutMs, ROUTING_DEFAULTS.queueTimeoutMs, 1000),
    queueOnCooldownMs: num(raw.queueOnCooldownMs, ROUTING_DEFAULTS.queueOnCooldownMs),
    retrySameKeyMs: num(raw.retrySameKeyMs, ROUTING_DEFAULTS.retrySameKeyMs),
    streamIdleTimeoutMs: num(raw.streamIdleTimeoutMs, 180000, 1000),
    // 试探多久没回声就先放宽到 3 个位（0 = 不放宽，只等响应头或失败）
    probeMaxMs: num(raw.probeMaxMs, 20000),
    // 单次请求的总时限：到点就断开并回 504，别让一把钥匙的槽位挂到天荒地老。
    // 默认 285 秒，比 pi 的 300 秒上限早一点，好让它先看到结果而不是被客户端掐。
    totalTimeoutMs: num(raw.totalTimeoutMs, 285000, 1000),
    sessionHeader: raw.sessionHeader || "x-opencode-session",
    keys: (raw.keys || [])
      .filter((k) => k && k.key && String(k.key).trim() && !String(k.key).includes("PASTE-HERE"))
      .map((k) => ({
        name: k.name || mask(k.key),
        key: String(k.key).trim(),
        route: k.route || "opencode-go",
        maxConcurrent: Number(k.maxConcurrent || 0),
        enabled: k.enabled !== false,
      })),
  };
  const names = new Set(cfg.keys.map((k) => k.name));
  for (const n of [...stats.keys()]) {
    if (names.has(n)) continue;
    // 还有在跑的请求就先把记录留着：删了再以同名加回来，新对象 active=0，
    // 旧槽位那几条就白占了（同一把上游钥匙会被超发）
    const st0 = stats.get(n);
    if (st0 && st0.live && st0.live.size) continue;
    stats.delete(n);
    quotaCache.delete(n);
  }
  for (const [fp, e] of sticky) if (!names.has(e.name)) sticky.delete(fp);

  cfgCache = { mtimeMs: st.mtimeMs, size: st.size, cfg };
  return cfg;
}

/* ---------------- 状态落盘 ---------------- */

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveState();
  }, 3000);
}

function saveState() {
  const keys = {};
  for (const [name, s] of stats) {
    keys[name] = {
      cooldownUntil: s.cooldownUntil,
      coolTotalMs: s.coolTotalMs || 0, // 界面画恢复进度要用
      fails: s.fails,
      failTimes: s.failTimes || [],
      lastStatus: s.lastStatus,
      total: s.total,
      ok: s.ok,
      rateLimited: s.rateLimited,
      authErrors: s.authErrors,
      errors: s.errors,
      lastUsed: s.lastUsed,
    };
  }
  try {
    const tmp = `${STATE_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ updated: Date.now(), keys }, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, STATE_PATH);
  } catch {}
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    for (const [name, s] of Object.entries(raw.keys || {})) {
      const t = state(name);
      Object.assign(t, s, { active: 0 });
      // 老存档只有次数没有时间点：按“一分钟前刚失败过”补上，升级后不会突然全清
      if (!Array.isArray(t.failTimes)) t.failTimes = Array.from({ length: t.fails || 0 }, () => Date.now() - 60000);
      getFails(t);
      // 重启后冷却剩余时间超过上限说明时钟异常，忽略
      if (t.cooldownUntil - Date.now() > DEFAULTS_MAX_COOLDOWN) t.cooldownUntil = Date.now() + DEFAULTS_MAX_COOLDOWN;
    }
  } catch {}
}

const DEFAULTS_MAX_COOLDOWN = ROUTING_DEFAULTS.cooldown.maxMs;

/* ---------------- 额度窗口 ---------------- */

function quotaScore(name) {
  const c = quotaCache.get(name);
  if (!c || !c.data) return null;
  const vals = [c.data.rolling, c.data.weekly, c.data.monthly]
    .filter(Boolean)
    .map((w) => Number(w.percent) || 0);
  if (!vals.length) return null;
  return Math.max(...vals);
}

function refreshQuota(cfg) {
  const now = Date.now();
  for (const k of cfg.keys) {
    if (k.enabled === false) continue;
    const c = quotaCache.get(k.name);
    if (c && (c.inflight || now - c.at < QUOTA_TTL)) continue;
    const prevData = c ? c.data : null;
    const prevStarts = c ? c.starts : null;
    quotaCache.set(k.name, { at: c ? c.at : 0, data: prevData, starts: prevStarts, inflight: true });
    fetch(QUOTA_URL, { headers: { authorization: `Bearer ${k.key}` }, signal: AbortSignal.timeout(10_000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((json) => {
        const u = json && json.usage;
        if (!u) throw new Error("no usage");
        const pick = (o) => {
          if (!o) return null;
          const raw = String(o.percent ?? "").replace("%", "").trim();
          const n = Number(raw);
          return {
            // 解析不了就记 0：至少不会把满额当成空闲
            percent: Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0,
            status: o.status || "",
            resetsAt: o.resetsAt || "",
          };
        };
        const data = { rolling: pick(u.rolling), weekly: pick(u.weekly), monthly: pick(u.monthly) };
        quotaCache.set(k.name, {
          at: Date.now(),
          data,
          starts: windowStarts(prevData, prevStarts, data),
          inflight: false,
        });
      })
      .catch(() => {
        // 一直拉不到就丢掉旧数据：陈旧快照会把“重置点已过 + 已用很低”当成极度落后，抢走全部流量
        const at = c ? c.at : Date.now();
        const stale = Date.now() - at > 10 * 60_000;
        quotaCache.set(k.name, {
          at,
          data: stale ? null : prevData,
          starts: stale ? null : prevStarts,
          inflight: false,
        });
      });
  }
}

const WINDOW_KEYS = ["rolling", "weekly", "monthly"];

/** 上个月的同一天（按日历算，不是减 30 天）；31 号遇到短月就夹到月末 */
function minusOneMonth(ms) {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  const lastDayPrev = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Date.UTC(y, m - 1, Math.min(day, lastDayPrev), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

/**
 * 记住每档窗口的起点。额度接口只给 resetsAt，月档按订阅日每月同一天重置（不是固定 30 天），
 * 所以月档用“上个月同一天”反推，不用减 744 小时；一旦观察到 resetsAt 变化，
 * 上一轮的重置点就是这一轮的精确起点。
 */
function windowStarts(prevData, prevStarts, data) {
  const out = {};
  const periods = ROUTING_DEFAULTS.routing.windowHours;
  for (const w of WINDOW_KEYS) {
    const cur = data ? data[w] : null;
    const old = (prevStarts && prevStarts[w]) || null;
    if (!cur) {
      if (old) out[w] = old;
      continue;
    }
    const resetMs = Date.parse(cur.resetsAt || "") || 0;
    let startMs = 0;
    if (w === "monthly") {
      // 月度不是定长（28~31 天）：用上一轮重置点作起点，没历史就按“上个月同一天”
      let candidate = 0;
      if (old && old.resetMs === resetMs && old.startMs > 0) candidate = old.startMs;
      // 只接受“上一轮重置点早于这一轮”的推断；重置点往回调了就不能再粘着旧起点
      else if (old && old.resetMs > 0 && old.resetMs < resetMs) candidate = old.resetMs;
      if (!candidate || candidate >= resetMs) candidate = resetMs ? minusOneMonth(resetMs) : 0;
      startMs = candidate;
    } else {
      // 定长窗口（5 小时 / 168 小时）：起点直接由 resetsAt 反推。
      // 不能用“上一轮的重置点”：闲一段时间后平台会把整窗往后移，那样算出来的本轮长度只有几分钟。
      const full = Number(periods[w]) || 0;
      if (resetMs && full > 0) startMs = resetMs - full * 3_600_000;
    }
    const fullHours = startMs > 0 && resetMs > startMs ? (resetMs - startMs) / 3_600_000 : 0;
    out[w] = { resetMs, startMs: startMs > 0 ? startMs : 0, fullHours };
  }
  return out;
}

/** 给选钥匙用的三档窗口快照：百分比、重置时刻、本轮起点、本轮实际长度 */
function quotaWindows(name) {
  const c = quotaCache.get(name);
  if (!c || !c.data) return null;
  const out = {};
  for (const w of WINDOW_KEYS) {
    const win = c.data[w];
    if (!win) continue;
    const s = c.starts && c.starts[w] ? c.starts[w] : null;
    out[w] = {
      percent: win.percent,
      status: win.status,
      resetsAt: win.resetsAt,
      resetAtMs: Date.parse(win.resetsAt || "") || 0,
      startMs: s && s.startMs > 0 ? s.startMs : 0,
      fullHours: s && s.fullHours > 0 ? s.fullHours : 0,
    };
  }
  return out;
}

async function validateKey(key) {
  try {
    const r = await fetch(QUOTA_URL, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, reason: `平台拒绝了这把钥匙（HTTP ${r.status}）` };
    return { ok: true };
  } catch {
    return { ok: true, warning: "没能当场验证（网络或平台没响应），先存下了" };
  }
}

/* ---------------- 选钥匙 ---------------- */

function bindingReset(name) {
  const c = quotaCache.get(name);
  if (!c || !c.data) return 0;
  const windows = [c.data.rolling, c.data.weekly, c.data.monthly].filter(Boolean);
  if (!windows.length) return 0;
  const top = windows.reduce((a, b) => ((Number(b.percent) || 0) > (Number(a.percent) || 0) ? b : a));
  const t = Date.parse(top.resetsAt || "");
  return Number.isFinite(t) ? t : 0;
}

function candidates(cfg, tried = new Set()) {
  const now = Date.now();
  // 只有一把可用钥匙时，把它冷却掉等于整池停摆；宁可继续用，让上游自己去限制
  const solo = cfg.keys.filter((k) => k.enabled !== false).length === 1;
  const list = cfg.keys.map((k) => {
    const s = state(k.name);
    // 冷却结束、失败数还留着 → 进半开，先只放一个请求去试
    if (!s.halfOpen && s.cooldownUntil <= now && getFails(s, now) > 0) enterProbe(s);
    const maxConcurrent = Number(k.maxConcurrent) || 0;
    return {
      name: k.name,
      key: k.key,
      route: k.route,
      enabled: k.enabled !== false,
      ready: solo || s.cooldownUntil <= now,
      halfOpen: s.halfOpen && s.cooldownUntil <= now && getFails(s, now) > 0,
      active: s.active,
      maxConcurrent,
      probeCap: Math.max(1, Number(s.probeCap) || 1),
      quota: quotaScore(k.name),
      resetAt: bindingReset(k.name),
      windows: quotaWindows(k.name),
      fails: getFails(s, now),
    };
  });
  // “只剩一把能接活”按“其他钥匙既没在冷却、也没占满”算，而不是按“没在冷却”算：
  // 别的钥匙都满员时这一把再自我降级，整池又得排队到超时（2026-11-26 的事故就是这样卡死的）。
  // 传进去的是“能接活的钥匙个数”：1 = 就它自己 → 不降级；0 = 连它自己都接不了，降不降无所谓。
  const others = list.filter((c) => !tried.has(c.name) && canTake(c));
  for (const c of list) {
    c.probe = probeFor(c, others.length);
    c.cap = capOf(c);
  }
  return list;
}

function stickyGet(fp, cfg) {
  if (!fp || !cfg.routing.sticky) return null;
  const e = sticky.get(fp);
  if (!e) return null;
  if (Date.now() - e.at > cfg.routing.stickyTtlMs) {
    sticky.delete(fp);
    return null;
  }
  return e.name;
}

function stickySet(fp, name, cfg) {
  if (!fp || !cfg.routing.sticky) return;
  if (sticky.size > 1000) {
    const oldest = [...sticky.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 200);
    for (const [k] of oldest) sticky.delete(k);
  }
  sticky.set(fp, { name, at: Date.now() });
}

function stickyDrop(fp, name) {
  const e = fp && sticky.get(fp);
  if (e && (!name || e.name === name)) sticky.delete(fp);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function acquire(cfg, tried, ignoreCapacity = false) {
  const deadline = Date.now() + (ignoreCapacity ? 8000 : cfg.queueTimeoutMs);
  for (;;) {
    const raw = candidates(cfg, tried).filter((c) => !tried.has(c.name));
    // GET / HEAD 只做探活，不占位、也不替这扇门结测（/models 返回 200 不代表对话并发健康）
    const cands = ignoreCapacity ? raw.map((c) => ({ ...c, active: 0, cap: 0, probe: false, quota: null })) : raw;
    if (!cands.length) return { none: true };
    const anyReady = cands.some((c) => c.enabled && c.ready);
    if (!anyReady) {
      const enabled = cands.filter((c) => c.enabled);
      const soonest = Math.min(...enabled.map((c) => state(c.name).cooldownUntil), Infinity);
      if (!Number.isFinite(soonest)) return { none: true }; // 一把启用的都没有
      const wait = Math.max(0, soonest - Date.now());
      if (wait > 0 && wait <= cfg.queueOnCooldownMs && Date.now() + wait <= deadline) {
        await sleep(Math.min(wait + 60, 2000));
        continue;
      }
      if (wait <= 0) return { none: true };
      return { coolingMs: wait };
    }
    const pick = pickKey(cands, cfg);
    if (pick) return admit(pick, cfg, !ignoreCapacity);
    // pickKey 只在“没有一把能接”时返回 null（全停用 / 全冷却 / 全满并发），
    // 额度打满不再整池拒绝，交给上游自己判（429 会进冷却）。
    if (Date.now() > deadline) return { busy: true };
    await sleep(100);
  }
}

/* ---------------- 上游请求 ---------------- */

function upstreamRequest({ targetUrl, headers, body, method = "POST", idleMs = IDLE_TIMEOUT_MS, deadlineAt = 0 }) {
  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const mod = url.protocol === "https:" ? https : http;
    let settled = false;
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
        method,
        headers,
      },
      (res) => {
        settled = true;
        clearTimeout(timer);
        // 响应头到了之后如果长时间没有新数据，直接把连接拆掉，
        // 由 error 处理走冷却，别让槽位挂到 30 分钟回收
        res.setTimeout(idleMs, () => {
          res.destroy(new Error("body idle timeout"));
        });
        resolve(res);
      },
    );
    const headerMs = deadlineAt ? Math.max(1, Math.min(HEADER_TIMEOUT_MS, deadlineAt - Date.now())) : HEADER_TIMEOUT_MS;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      req.destroy(new Error("header timeout"));
    }, headerMs);
    req.on("error", (err) => {
      clearTimeout(timer);
      if (!settled) reject(err);
    });
    req.end(method === "GET" || method === "HEAD" ? undefined : body);
  });
}

// 诊断用：设 KP_TRACE=<文件路径> 时，把每次请求里“会进缓存”的几块内容各算一个指纹，写一行。
// 用来比对两次请求从哪一条开始不一样，定位“开头变了什么”。默认关闭，不写任何东西。
const TRACE_PATH = process.env.KP_TRACE || "";
function traceBody(route, model, bodyText, fp, headers) {
  if (!TRACE_PATH || !bodyText) return;
  let j;
  try {
    j = JSON.parse(bodyText);
  } catch {
    return;
  }
  const h = (v) =>
    createHash("sha1").update(typeof v === "string" ? v : JSON.stringify(v ?? "")).digest("hex").slice(0, 12);
  const raw = j.input ?? j.messages ?? null;
  const items = Array.isArray(raw)
    ? raw.map((m, i) => ({ i, role: m && m.role, len: JSON.stringify(m).length, h: h(m) }))
    : [];
  const line = {
    ts: new Date().toISOString(),
    route,
    model,
    fp,
    sid: String(headers[process.env.KP_TRACE_SID_HEADER || "x-opencode-session"] || "").slice(0, 60),
    bytes: bodyText.length,
    keys: Object.keys(j).sort(),
    instructions: h(j.instructions ?? ""),
    tools: h(j.tools ?? null),
    toolCount: Array.isArray(j.tools) ? j.tools.length : 0,
    items,
    itemCount: items.length,
  };
  try {
    fs.appendFileSync(TRACE_PATH, JSON.stringify(line) + "\n");
  } catch {}
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// pipe 不会在 source error 时结束目标流，两边的收尾都要自己接
function pipeSafely(upstream, res) {
  upstream.on("error", () => {
    try {
      res.destroy();
    } catch {}
  });
  res.on("close", () => {
    try {
      upstream.destroy();
    } catch {}
  });
  upstream.pipe(res);
}

/* ---------------- 主流程 ---------------- */

const server = http.createServer(async (req, res) => {
  // 客户端早于槽位释放就断开时，close 事件已经发过，必须靠这里的一旦监听兜住
  let held = null;
  const releaseHeld = () => {
    if (!held) return;
    const cur = held;
    held = null;
    drop(cur.s, cur.tok);
  };
  res.once("finish", releaseHeld);
  res.once("close", releaseHeld);

  let cfg;
  try {
    cfg = loadConfig();
  } catch (err) {
    sendJson(res, 500, { error: "keys.json 读取失败", detail: String(err && err.message) });
    return;
  }

  const url = new URL(req.url, "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, health(cfg));
    return;
  }
  if (
    await handleUi(req, res, url, {
      configPath: CONFIG_PATH,
      getConfig: loadConfig,
      reload: () => {
        cfgCache = { mtimeMs: 0, size: 0, cfg: null };
      },
      state,
      mask,
      usage: () => usage.snapshot(),
      refreshQuota: () => refreshQuota(loadConfig()),
      validateKey,
      quota: (name) => {
        const c = quotaCache.get(name);
        return c && c.data ? { ...c.data, at: c.at } : null;
      },
      breakdown: (name) => {
        const s = state(name);
        return breakdownOf(
          { windows: quotaWindows(name), active: s.active, fails: getFails(s), quota: quotaScore(name) },
          loadConfig(),
          Date.now(),
        );
      },
      // 界面要知道“现在实际放几个位”：试跑时是 1，20 秒后可能是 3，其余时候是配置值
      slotView: (name) => {
        const c = candidates(loadConfig()).find((x) => x.name === name);
        return c ? { probe: !!c.probe, cap: c.cap, halfOpen: !!c.halfOpen } : null;
      },
      renameExtra: (from, to) => {
        usage.renameKey(from, to);
        const q = quotaCache.get(from);
        if (q) {
          quotaCache.delete(from);
          // 带着 inflight 搬过去会让新名字永远不再刷新额度，清掉
          quotaCache.set(to, { ...q, inflight: false });
        }
        const s = stats.get(from);
        if (s) {
          stats.delete(from);
          stats.set(to, s);
        }
        for (const [fp, e] of sticky) if (e.name === from) sticky.set(fp, { ...e, name: to });
        scheduleSave();
      },
      removeExtra: (name) => {
        usage.removeKey(name);
        const st0 = stats.get(name);
        if (!st0 || !st0.live || !st0.live.size) stats.delete(name);
        quotaCache.delete(name);
        for (const [fp, e] of sticky) if (e.name === name) sticky.delete(fp);
        scheduleSave();
      },
    })
  ) {
    return;
  }

  const [, route, ...rest] = url.pathname.split("/");
  const base = cfg.routes[route];
  if (!base) {
    sendJson(res, 404, { error: `未知路由 /${route}`, routes: Object.keys(cfg.routes) });
    return;
  }
  const targetUrl = base.replace(/\/$/, "") + "/" + rest.join("/") + (url.search || "");

  const fwdMethod = req.method === "GET" || req.method === "HEAD" ? req.method : "POST";

  let body = Buffer.alloc(0);
  try {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > BODY_CAP) {
        sendJson(res, 413, { error: "请求体过大" });
        return;
      }
      chunks.push(c);
    }
    body = Buffer.concat(chunks);
  } catch {
    sendJson(res, 400, { error: "读取请求体失败" });
    return;
  }

  const bodyText = body.length < BODY_CAP ? body.toString("utf8") : "";
  let model = "";
  try {
    model = JSON.parse(bodyText).model || "";
  } catch {}
  const fp = affinityKey({ bodyText, sessionId: String(req.headers.session_id || ""), model });
  traceBody(route, model, bodyText, fp, req.headers);

  const started = Date.now();
  // 总时限：从收到请求算起，包括排队、等响应头、流式传输
  const deadlineAt = cfg.totalTimeoutMs > 0 ? started + cfg.totalTimeoutMs : 0;
  let curKey = "-";
  let upstreamRes = null;
  let deadlineFired = false;
  const deadlineTimer = deadlineAt
    ? setTimeout(() => {
        deadlineFired = true;
        const secs = Math.round((Date.now() - started) / 1000);
        log(
          `TIMEOUT route=${route} key=${curKey} after=${secs}s streaming=${upstreamRes ? "yes" : "no"} limit=${Math.round(cfg.totalTimeoutMs / 1000)}s${timingOf(upstreamRes && upstreamRes.headers)}`,
        );
        releaseHeld();
        if (upstreamRes) {
          try {
            upstreamRes.destroy(new Error("total timeout"));
          } catch {}
        }
        if (!res.headersSent) {
          sendJson(res, 504, { error: "上游超过总时限仍未完成", limitSeconds: Math.round(cfg.totalTimeoutMs / 1000) });
        } else {
          try {
            res.destroy();
          } catch {}
        }
      }, Math.max(1, deadlineAt - Date.now()))
    : null;
  if (deadlineTimer) res.on("close", () => clearTimeout(deadlineTimer));
  const tried = new Set();
  const maxAttempts = Math.min(
    cfg.maxAttempts > 0 ? cfg.maxAttempts : cfg.keys.length || 1,
    Math.max(1, cfg.keys.length),
  );

  outer: for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (deadlineFired) return;
    const stickyName = stickyGet(fp, cfg);
    let key = null;

    const cands = candidates(cfg).filter((c) => !tried.has(c.name));
    if (stickyName && !tried.has(stickyName)) {
      const c = cands.find((x) => x.name === stickyName);
      if (c && c.enabled && c.ready && fits(c) && hasRoom(c, cfg)) {
        const slot = admit(c, cfg, fwdMethod === "POST");
        key = { ...slot.key, tok: slot.tok };
      }
    }

    if (!key) {
      const slot = await acquire(cfg, tried, fwdMethod !== "POST");
      if (slot.none) {
        sendJson(res, 429, { error: "没有可用的 key" });
        log(`FAIL no-key route=${route}`);
        return;
      }
      if (slot.coolingMs > 0) {
        const secs = Math.max(1, Math.ceil(slot.coolingMs / 1000));
        res.writeHead(429, { "content-type": "application/json", "retry-after": String(secs) });
        res.end(JSON.stringify({ error: "所有 key 都在冷却", retryAfterSeconds: secs }));
        log(`FAIL cooling route=${route} secs=${secs}`);
        return;
      }
      if (slot.exhausted) {
        res.writeHead(429, { "content-type": "application/json", "retry-after": "600" });
        res.end(JSON.stringify({ error: "所有 key 的额度窗口都接近上限" }));
        log(`FAIL quota route=${route}`);
        return;
      }
      if (slot.busy) {
        // 报“并发满了”而不说谁在冷却、谁在试跑，就是把人往错的方向引。
        // 这里逐把写清现场，界面和客户端都能直接看到原因。
        const detail = blockReport(cfg, tried);
        const waited = Date.now() - started;
        sendJson(res, 503, {
          error: busyText(detail, waited),
          waitedSeconds: Math.round(waited / 1000),
          keys: detail,
        });
        log(
          `FAIL busy route=${route} waited=${Math.round(waited / 1000)}s ${detail
            .map((d) => `${d.name}:${d.coolingSeconds > 0 ? `cool${d.coolingSeconds}s` : d.probe ? `probe${d.cap}` : "full"}${d.active}/${d.cap || "-"}`)
            .join(" ")}`,
        );
        return;
      }
      if (!slot.key || !slot.key.key) {
        sendJson(res, 429, { error: "没有可用的 key" });
        log(`FAIL no-key route=${route}`);
        return;
      }
      key = { ...slot.key, tok: slot.tok };
    }

    const s = state(key.name);
    curKey = key.name;
    const tok = key.tok;
    held = { s, tok };
    if (res.destroyed) {
      releaseHeld();
      return;
    }
    if (!tried.has(key.name)) {
      tried.add(key.name);
      s.total++;
      s.lastUsed = Date.now();
      usage.addRequests(key.name);
    }

    for (let sameTry = 0; sameTry < 2; sameTry++) {
      const headers = {};
      for (const [hname, value] of Object.entries(req.headers)) {
        const n = hname.toLowerCase();
        if (n === "host" || n === "authorization" || n === "content-length" || n === "connection") continue;
        if (n === "accept-encoding") continue; // 不压缩，方便读回用量
        headers[n] = value;
      }
      headers.authorization = `Bearer ${key.key}`;
      if (fwdMethod === "POST") headers["content-length"] = String(body.length);
      else delete headers["content-length"];
      // 会话号必须稳定，否则上游每次都当新会话、缓存全丢（见 routing.mjs / stableSessionId）
      if (cfg.sessionHeader && !headers[cfg.sessionHeader]) {
        headers[cfg.sessionHeader] = stableSessionId({ headers, bodyText, fp }) || randomUUID();
      }

      let upstream;
      try {
        upstream = await upstreamRequest({ targetUrl, headers, body, method: fwdMethod, idleMs: cfg.streamIdleTimeoutMs, deadlineAt });
        upstreamRes = upstream;
        // 等响应头的这段时间里客户端可能已经跑了、总时限也可能到了，那这个 2xx 不作数；
        // 上游这一头也不能晴着：不消费也不销毁，它会继续生成、继续计费
        if (deadlineFired || res.destroyed) {
          try {
            upstream.destroy();
          } catch {}
          return;
        }
      } catch (err) {
        if (deadlineFired) return;
        if (sameTry === 0) {
          log(`RETRY-SAME key=${key.name} kind=network wait=${cfg.retrySameKeyMs}ms`);
          await sleep(cfg.retrySameKeyMs);
          if (deadlineFired) return;
          continue;
        }
        s.errors++;
        strike(s);
        releaseHeld();
        s.lastStatus = -1;
        const ms = cooldownMs("upstream", getFails(s), 0, cfg);
        coolDown(s, ms);
        stickyDrop(fp, key.name);
        usage.addFailure(key.name, "other");
        log(`ROTATE key=${key.name} kind=network tries=2 cooldown=${Math.round(ms / 1000)}s ${String(err && err.message).slice(0, 120)}`);
        scheduleSave();
        continue outer;
      }

      const status = upstream.statusCode || 0;
      const kind = classifyStatus(status);
      s.lastStatus = status;
      if (tok) tok.lastStatus = status;

      // 试探过了：拿到 2xx 就说明这把钥匙又能接活了。流式这里算最贴近的判据——
      // 响应头已到、模型在出字，再等它跑完可能要几分钟，那就是事故里的卡死。
      if (kind === "ok" && tok && tok.probe) {
        const ct = String(upstream.headers["content-type"] || "");
        if (ct.includes("event-stream")) settleProbe(s, key.name, tok, "stream-headers");
      }

      if (kind === "rate" || kind === "auth") {
        upstream.resume();
        const retryAfter = Number.parseInt(String(upstream.headers["retry-after"] || ""), 10);
        const ms = cooldownMs(kind, getFails(s) + 1, retryAfter, cfg);
        strike(s);
        if (kind === "auth") s.authErrors++;
        else s.rateLimited++;
        coolDown(s, ms);
        releaseHeld();
        stickyDrop(fp, key.name);
        usage.addFailure(key.name, kind === "auth" ? "auth" : "limited");
        log(`ROTATE key=${key.name} status=${status} kind=${kind} fails=${getFails(s)} cooldown=${Math.round(ms / 1000)}s attempt=${attempt + 1}/${maxAttempts}`);
        scheduleSave();
        continue outer;
      }

      if (kind === "upstream") {
        upstream.resume();
        if (sameTry === 0) {
          log(`RETRY-SAME key=${key.name} status=${status} wait=${cfg.retrySameKeyMs}ms`);
          await sleep(cfg.retrySameKeyMs);
          continue;
        }
        const retryAfter = Number.parseInt(String(upstream.headers["retry-after"] || ""), 10);
        const ms = cooldownMs("upstream", getFails(s) + 1, retryAfter, cfg);
        strike(s);
        s.errors++;
        coolDown(s, ms);
        releaseHeld();
        stickyDrop(fp, key.name);
        usage.addFailure(key.name, "other");
        log(`ROTATE key=${key.name} status=${status} kind=upstream fails=${getFails(s)} cooldown=${Math.round(ms / 1000)}s attempt=${attempt + 1}/${maxAttempts}`);
        scheduleSave();
        continue outer;
      }

      if (kind === "fatal") {
        releaseHeld();
        // 客户端自己的错（坏参数、路径不对）不是钥匙的问题，但也不能拿来“洗白”半开：
        // 以前这里减 fails，一串 400 就能把病钥匙放开到满并发。
        s.clientErrors = (s.clientErrors || 0) + 1;
        const outHeaders = { ...upstream.headers };
        delete outHeaders["transfer-encoding"];
        res.writeHead(status, outHeaders);
        pipeSafely(upstream, res);
        log(`PASS key=${key.name} status=${status} (不换钥匙)`);
        return;
      }

      if (fwdMethod !== "POST") {
        markOk(s);
        releaseHeld();
        const outHeaders = { ...upstream.headers };
        delete outHeaders["transfer-encoding"];
        res.writeHead(status, outHeaders);
        pipeSafely(upstream, res);
        log(`OK key=${key.name} ${fwdMethod} ${url.pathname} status=${status} ms=${Date.now() - started}${timingOf(upstream.headers)}`);
        scheduleSave();
        return;
      }

      const contentType = String(upstream.headers["content-type"] || "");
      const isStream = contentType.includes("event-stream");

      if (!isStream) {
        const chunks = [];
        let size = 0;
        let broken = false;
        let overCap = false;
        try {
          for await (const c of upstream) {
            size += c.length;
            if (size > BODY_CAP) {
              broken = true;
              overCap = true;
              break;
            }
            chunks.push(c);
          }
        } catch {
          broken = true;
        }
        const buf = Buffer.concat(chunks);

        if (broken) {
          releaseHeld();
          // 总时限到点是我们自己提断的，不是上游的错；已经不记失败了，这里也不能再记
          if (deadlineFired) return;
          // 包太大是客户端的问题，不怪钥匙；中途断流是上游的故障，要换下一把，
          // 否则这把"假健康"的钥匙会被反复选中
          if (!overCap) {
            strike(s);
            s.errors++;
            const ms = cooldownMs("upstream", getFails(s), 0, cfg);
            coolDown(s, ms);
            stickyDrop(fp, key.name);
            usage.addFailure(key.name, "other");
            log(`ROTATE key=${key.name} kind=body-timeout bytes=${buf.length} cooldown=${Math.round(ms / 1000)}s attempt=${attempt + 1}/${maxAttempts}`);
            scheduleSave();
            continue outer;
          }
          sendJson(res, 502, { error: "上游响应超过 8MB，已放弃这一包" });
          log(`FAIL body-cap key=${key.name} bytes=${buf.length} route=${route}`);
          scheduleSave();
          return;
        }

        const text = buf.toString("utf8");
        if (bodyLooksErrored(text)) {
          releaseHeld();
          strike(s);
          s.errors++;
          const ms = cooldownMs("upstream", getFails(s), 0, cfg);
          coolDown(s, ms);
          stickyDrop(fp, key.name);
          usage.addFailure(key.name, "other");
          log(`ROTATE key=${key.name} kind=body-error fails=${getFails(s)} cooldown=${Math.round(ms / 1000)}s`);
          scheduleSave();
          continue outer;
        }

        settleProbe(s, key.name, tok, "body-ok");
        markOk(s);
        releaseHeld();
        stickySet(fp, key.name, cfg);
        usage.addUsage(key.name, usage.extractUsage(text));
        const outHeaders = { ...upstream.headers };
        delete outHeaders["transfer-encoding"];
        res.writeHead(status, outHeaders);
        res.end(buf);
        log(`OK key=${key.name} status=${status} ms=${Date.now() - started} bytes=${buf.length} route=${route}${timingOf(upstream.headers)}`);
        scheduleSave();
        return;
      }

      const outHeaders = { ...upstream.headers };
      delete outHeaders["transfer-encoding"];
      res.writeHead(status, outHeaders);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        releaseHeld();
        scheduleSave();
      };
      let chunks = [];
      let collected = 0;
      let completed = false;
      let clientGone = false;
      // 上游发完 [DONE] 常常不挂断，客户端拿到就自己关了。那不是“中途跑掉”，
      // 不分这个就只能把每次正常收尾都记成 CLIENT-ABORT。
      let doneSeen = false;
      upstream.on("data", (buf) => {
        if (collected >= BODY_CAP) return;
        chunks.push(buf);
        collected += buf.length;
        if (!doneSeen) {
          const s = buf.toString("utf8");
          if (s.includes("[DONE]") || s.includes("message_stop") || s.includes('"finish_reason"')) doneSeen = true;
        }
      });
      upstream.on("end", () => {
        completed = true;
        release();
        markOk(s);
        stickySet(fp, key.name, cfg);
        if (collected < BODY_CAP) {
          try {
            usage.addUsage(key.name, usage.extractUsage(Buffer.concat(chunks).toString("utf8")));
          } catch {}
        }
        log(`OK key=${key.name} status=${status} stream ms=${Date.now() - started} route=${route}${timingOf(upstream.headers)}`);
      });
      upstream.on("error", () => {
        release();
        if (clientGone || completed) return;
        // 总时限到点是我们自己提断的，不记成钥匙的错（以前长对话一到 285 秒就把钥匙打冷却）
        if (deadlineFired) return;
        s.errors++;
        strike(s);
        const ms = cooldownMs("upstream", getFails(s), 0, cfg);
        coolDown(s, ms);
        stickyDrop(fp, key.name);
        log(`STREAM-BREAK key=${key.name} after=${collected}B cooldown=${Math.round(ms / 1000)}s`);
        res.destroy();
      });
      res.on("close", () => {
        if (!completed) {
          clientGone = true;
          if (!deadlineFired) {
            if (doneSeen) {
              // 上游发了 [DONE] 就自己挂了、客户端跟着关：这算成功，得留一行 OK，
              // 否则正常请求在日志里一片空白
              markOk(s);
              stickySet(fp, key.name, cfg);
              if (collected > 0 && collected < BODY_CAP) {
                try {
                  usage.addUsage(key.name, usage.extractUsage(Buffer.concat(chunks).toString("utf8")));
                } catch {}
              }
              log(`OK key=${key.name} status=${status} stream ms=${Date.now() - started} route=${route} (client-close)${timingOf(upstream.headers)}`);
            } else {
              // 客户端先跑了（多见于 pi 的 300 秒上限）：以前这里什么也不写，日志里查不到
              log(`CLIENT-ABORT key=${key.name} after=${Math.round((Date.now() - started) / 1000)}s bytes=${collected}${timingOf(upstream.headers)}`);
            }
          }
        }
        upstream.destroy();
        release();
      });
      upstream.pipe(res);
      return;
    }
  }

  sendJson(res, 429, { error: "重试了所有 key 仍然失败", tried: [...tried] });
  log(`FAIL exhausted route=${route}`);
});

/* ---------------- 汇总 ---------------- */

function health(cfg) {
  const now = Date.now();
  // 和挑钥匙用同一份候选：界面看到的“能不能接、几个位”必须和真的调度一致
  const views = new Map(candidates(cfg).map((c) => [c.name, c]));
  return {
    ok: true,
    port: cfg.port,
    keys: cfg.keys.map((k) => {
      const s = state(k.name);
      const view = views.get(k.name) || {};
      const bd = breakdownOf({ windows: quotaWindows(k.name), active: s.active, fails: getFails(s) }, cfg, now);
      return {
        name: k.name,
        route: k.route,
        enabled: k.enabled !== false,
        masked: mask(k.key),
        ready: s.cooldownUntil <= now,
        cooldownSeconds: Math.max(0, Math.ceil((s.cooldownUntil - now) / 1000)),
        cooldownTotalSeconds: Math.max(0, Math.ceil((s.coolTotalMs || 0) / 1000)),
        probe: !!view.probe,
        cap: view.cap == null ? (k.maxConcurrent || 0) : view.cap,
        fails: getFails(s),
        quota: quotaScore(k.name),
        resetsAt: bindingReset(k.name) ? new Date(bindingReset(k.name)).toISOString() : null,
        score: Math.round(bd.total * 10) / 10,
        paceDeviation: Math.round(bd.B * 10) / 10,
        roomLeft: bd.R == null ? null : Math.round(bd.R * 100) / 100,
        active: s.active,
        maxConcurrent: k.maxConcurrent || "unlimited",
        requests: s.total,
        ok: s.ok,
        rateLimited: s.rateLimited,
        authErrors: s.authErrors,
        errors: s.errors,
        lastStatus: s.lastStatus,
      };
    }),
    stickySessions: sticky.size,
    today: usage.snapshot().todayTotals,
    configPath: CONFIG_PATH,
  };
}

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") process.exit(0);
  log(`SERVER-ERR ${String(err && err.message).slice(0, 300)}`);
  process.exit(1);
});

server.on("clientError", (err, socket) => {
  if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

let startPort = 18787;
try {
  startPort = Number(loadConfig().port) || 18787;
} catch {}

loadState();
try {
  usage.init(process.env.KP_USAGE || path.join(DIR, "usage.json"), new Set(loadConfig().keys.map((k) => k.name)));
} catch {
  usage.init(process.env.KP_USAGE || path.join(DIR, "usage.json"));
}

const QUOTA_TICK = setInterval(() => {
  try {
    refreshQuota(loadConfig());
  } catch {}
}, 60_000);
QUOTA_TICK.unref?.();

server.listen(startPort, "127.0.0.1", () => {
  log(`START listening=127.0.0.1:${server.address().port} config=${CONFIG_PATH}`);
  try {
    refreshQuota(loadConfig());
  } catch {}
  console.log(`keypool listening on http://127.0.0.1:${server.address().port}`);
});

const shutdown = () => {
  try {
    saveState();
    usage.saveNow();
  } catch {}
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => {
  try {
    saveState();
    usage.saveNow();
  } catch {}
});

process.on("uncaughtException", (err) => {
  log(`FATAL ${String(err && err.stack).slice(0, 500)}`);
});
