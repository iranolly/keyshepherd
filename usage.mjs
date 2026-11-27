// 用量统计：按钥匙、按天记账，落盘到 usage.json
import fs from "node:fs";

// cacheVer=2 才代表“缓存那两栏是真的”：之前那版读不懂上游字段，落的是 0，
// 留着会把命中率摊薄成人造的低值，启动时一并清掉。
const CACHE_VER = 2;
const empty = () => ({ input: 0, output: 0, cost: 0, requests: 0, limited: 0, auth: 0, other: 0, cacheRead: 0, promptTotal: 0, cacheVer: CACHE_VER });

function migrateCache(e) {
  if (!e || typeof e !== "object") return;
  if (e.cacheVer !== CACHE_VER) {
    e.cacheRead = 0;
    e.promptTotal = 0;
    e.cacheVer = CACHE_VER;
  }
}
const today = () => new Date().toLocaleDateString("sv-SE"); // 本机时区的 YYYY-MM-DD

let file = null;
let data = { totals: empty(), daily: {}, keys: {} };
let saveTimer = null;

export function init(path, validNames) {
  file = path;
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    if (raw && typeof raw === "object") {
      migrateCache(raw.totals);
      for (const e of Object.values(raw.daily || {})) migrateCache(e);
      for (const e of Object.values(raw.keys || {})) {
        migrateCache(e.total);
        migrateCache(e.today);
      }
      data = {
        totals: { ...empty(), ...(raw.totals || {}) },
        daily: raw.daily || {},
        keys: raw.keys || {},
      };
    }
  } catch {
    /* 第一次运行没有文件 */
  }
  // 只清理既不在钥匙清单里、又 14 天没用过的历史，避免改名/临时移出时丢账
  if (validNames) {
    const stale = Date.now() - 14 * 864e5;
    for (const [name, e] of Object.entries(data.keys)) {
      if (!validNames.has(name) && (!e.lastUsed || e.lastUsed < stale)) delete data.keys[name];
    }
  }
  for (const k of Object.values(data.keys)) {
    k.total = { ...empty(), ...(k.total || {}) };
    k.day = k.day || today();
    k.today = { ...empty(), ...(k.today || {}) };
  }

}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 3000);
}

export function saveNow() {
  if (!file) return;
  const cutoff = new Date(Date.now() - 14 * 864e5).toLocaleDateString("sv-SE");
  for (const day of Object.keys(data.daily)) if (day < cutoff) delete data.daily[day];
  const tmp = `${file}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    fs.renameSync(tmp, file);
  } catch {
    /* 写不动就算了，不影响转发 */
  }
}

function entry(name) {
  let e = data.keys[name];
  if (!e) {
    e = { total: empty(), day: today(), today: empty(), lastUsed: 0 };
    data.keys[name] = e;
  }
  if (e.day !== today()) {
    e.day = today();
    e.today = empty();
  }
  return e;
}

function bump(target, delta) {
  for (const [k, v] of Object.entries(delta)) target[k] = (target[k] || 0) + v;
}

export function addRequests(name) {
  const e = entry(name);
  const d = today();
  e.total.requests++;
  e.today.requests++;
  data.totals.requests++;
  data.daily[d] = data.daily[d] || empty();
  data.daily[d].requests++;
  e.lastUsed = Date.now();
  scheduleSave();
}

export function addFailure(name, kind) {
  const e = entry(name);
  const field = kind === "limited" ? "limited" : kind === "auth" ? "auth" : "other";
  e.total[field]++;
  e.today[field]++;
  data.totals[field]++;
  const d = today();
  data.daily[d] = data.daily[d] || empty();
  data.daily[d][field]++;
  scheduleSave();
}

export function addUsage(name, { input, output, cost, cacheRead, promptTotal, hasCache }) {
  if (!input && !output && !cost && !cacheRead) return;
  const delta = { input: input || 0, output: output || 0, cost: cost || 0 };
  // 上游没给缓存字段就不进分母：宁可这几天不显示，也不显示一个被摊薄的低值
  if (hasCache) {
    delta.cacheRead = cacheRead || 0;
    delta.promptTotal = promptTotal || 0;
  }
  const e = entry(name);
  bump(e.total, delta);
  bump(e.today, delta);
  bump(data.totals, delta);
  const d = today();
  data.daily[d] = data.daily[d] || empty();
  bump(data.daily[d], delta);
  e.lastUsed = Date.now();
  scheduleSave();
}

export function renameKey(from, to) {
  const e = data.keys[from];
  if (!e) return;
  const target = entry(to);
  bump(target.total, e.total);
  bump(target.today, e.today);
  delete data.keys[from];
  scheduleSave();
}

export function removeKey(name) {
  delete data.keys[name];
  scheduleSave();
}

export function snapshot() {
  const d = today();
  return {
    today: d,
    totals: data.totals,
    todayTotals: data.daily[d] || empty(),
    keys: Object.fromEntries(
      Object.entries(data.keys).map(([name, e]) => [
        name,
        { today: e.today, total: e.total, lastUsed: e.lastUsed || 0 },
      ]),
    ),
  };
}

// 从响应文本里抠 usage：兼容 openai 与 anthropic 两种格式
export function extractUsage(text) {
  let input = 0;
  let output = 0;
  let cost = 0;
  let cacheRead = 0;
  let promptTotal = 0;
  // 只有上游真的给了缓存字段，这一次才算“可测量”：混进没给的请求会把命中率摊薄成人造的低值
  let hasCache = false;
  const re = /"usage"\s*:\s*\{/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length - 1;
    const obj = balancedObject(text, start);
    if (!obj) continue;
    let u;
    try {
      u = JSON.parse(obj);
    } catch {
      continue;
    }
    if (!u || typeof u !== "object") continue;
    const inTok = num(u.prompt_tokens ?? u.input_tokens);
    // 缓存命中：anthropic 单独给 cache_read_input_tokens（input 不含它），
    // openai 兼容的塞在 prompt_tokens_details.cached_tokens（prompt_tokens 含它）
    const cachedA = num(u.cache_read_input_tokens);
    // 各家叫法：anthropic 的 cache_read_input_tokens、openai 的 prompt_tokens_details.cached_tokens、
    // deepseek 的 prompt_cache_hit_tokens、少数直接给 cached_tokens
    // responses 接口（pi 的默认后端）塞在 input_tokens_details.cached_tokens 里，
    // 网关自己还有一份 opencode.tokens.cache_read 兜底
    const cachedO =
      num(u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
      num(u.input_tokens_details && u.input_tokens_details.cached_tokens) ||
      num(u.prompt_cache_hit_tokens) ||
      num(u.cached_tokens) ||
      num(u.opencode && u.opencode.tokens && u.opencode.tokens.cache_read);
    const hasField =
      typeof u.cache_read_input_tokens === "number" ||
      typeof u.prompt_cache_hit_tokens === "number" ||
      typeof u.cached_tokens === "number" ||
      typeof (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) === "number" ||
      typeof (u.input_tokens_details && u.input_tokens_details.cached_tokens) === "number";
    const pTotal = cachedA ? inTok + cachedA : hasField ? Math.max(inTok, cachedO) : inTok;
    const cRead = cachedA || cachedO;
    if (pTotal > promptTotal) {
      promptTotal = pTotal;
      cacheRead = cRead;
      hasCache = hasField;
    }
    const outTok = num(u.completion_tokens ?? u.output_tokens);
    const c = num(u.cost) || num(u.list_cost) || num(u.opencode && u.opencode.list_cost);
    if (inTok > input) input = inTok;
    if (outTok > output) output = outTok;
    if (c > cost) cost = c;
  }
  if (!input && !output && !cost) {
    // 兜底：anthropic 的 message_delta 单独给 output_tokens
    const out = /"output_tokens"\s*:\s*(\d+)/g;
    let o;
    while ((o = out.exec(text))) output = Math.max(output, Number(o[1]));
  }
  return { input, output, cost, cacheRead, promptTotal, hasCache };
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function balancedObject(text, start) {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
