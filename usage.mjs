// 用量统计：按钥匙、按天记账，落盘到 usage.json
import fs from "node:fs";

const empty = () => ({ input: 0, output: 0, cost: 0, requests: 0, limited: 0, auth: 0, other: 0 });
const today = () => new Date().toLocaleDateString("sv-SE"); // 本机时区的 YYYY-MM-DD

let file = null;
let data = { totals: empty(), daily: {}, keys: {} };
let saveTimer = null;

export function init(path, validNames) {
  file = path;
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    if (raw && typeof raw === "object") {
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

export function addUsage(name, { input, output, cost }) {
  if (!input && !output && !cost) return;
  const delta = { input: input || 0, output: output || 0, cost: cost || 0 };
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
  return { input, output, cost };
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
