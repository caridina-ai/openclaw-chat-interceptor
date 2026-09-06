#!/usr/bin/env node
// tap —— 把一個聊天室的使用過程整份汲取出來，交給 AI 檢討。
//
//   node tap.mjs --tap genesis/.tap
//   node tap.mjs --channel telegram --target -1001234567890 --since 0
//   node tap.mjs --tap .tap --format json
//
// 為什麼需要這支：openclaw CLI 沒有「讀取頻道歷史」的指令
// （`message read` 不支援 telegram、`message search` 只支援 discord），
// 而且被 chat-interceptor 攔掉的那些輸入**根本沒進 session**——0 token 的代價
// 就是這一輪對後續對話是隱形的。但 gateway 早就把每一輪都寫在本機了，
// 這支把三種本機來源合併還原：
//
//   1. <sessionId>.trajectory.jsonl 的 prompt
//      → 內含 Conversation info(metadata，有 message_id) + Conversation context
//        (前幾則，格式 "#id  時間 GMT+8 名字: 內容")
//      → 唯一能拿到 message id 的來源，而且 context 裡連「AI 沒被叫醒也看得到的
//        鄰近訊息」都有——被攔截、甚至 /aside 的訊息會從這裡漏出來
//   2. <sessionId>.jsonl（及輪替出去的 .reset./.deleted.）
//      → 乾淨的 role:user 原文，但沒有 message id
//   3. agent/codex-home/sessions/**/rollout-*.jsonl
//      → runtime 另一份副本，補 1 已被輪替掉的部分
//
// 再加上 plugin 自己留下的兩份紀錄：
//
//   4. chat-interceptor.log（route 的 debug 開著才有）
//      → 每一輪「收到什麼、對上哪條 route、最後是攔掉還是放行」。
//        **「放行給 AI」那幾則就是下一條規則的原料**，這是檢討時最重要的一欄。
//   5. chat-interceptor-asides.log
//      → 使用者打的 `/aside ＿＿`。它不叫 AI 也不進 script，所以只有這裡有。
//
// 三份 session 來源都會有缺漏（session 輪替、context window 裁切），
// 合併後才接近完整；輸出最後的「涵蓋範圍」會說還缺哪些 message id。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// 參數與 .tap
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

if (has("help") || has("h")) {
  console.log(
    [
      "usage: node tap.mjs [--tap <file>] [--channel <c> --target <id>] [--since <stamp>|0]",
      "                   [--format md|json] [--tail <n>] [--agent <id>]",
      "                   [--log <file>] [--asides <file>]",
      "",
      "  --tap      維護現場檔，只有三個欄位：channel / target / viewed",
      "             （預設找 ./.tap、./genesis/.tap）",
      "  --since    這一次要從哪裡看起，蓋過 .tap 的 viewed；--since 0 看全部",
      "  --tail     逐字稿只列最後 n 則（預設 400，0 表示全部）",
      "  --format   md（預設）或 json",
    ].join("\n"),
  );
  process.exit(0);
}

let channel = arg("channel");
let target = arg("target");
let since = arg("since");
const sinceFromArg = since; // 命令列給的 --since 不可以被檔案裡的 viewed 蓋掉

const tapPath = arg("tap", [".tap", join("genesis", ".tap")].find((p) => existsSync(p)));
if (tapPath) {
  let text;
  try {
    text = readFileSync(tapPath, "utf8");
  } catch (error) {
    console.error(`讀不到 ${tapPath}：${error.message}`);
    process.exit(2);
  }
  for (const line of text.split("\n")) {
    // 認得的鍵只有三個。# 開頭的註解與其它東西一律略過。
    const m = /^\s*(channel|target|viewed)\s*:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === "channel") channel = channel ?? m[2];
    else if (m[1] === "target") target = target ?? m[2];
    else if (sinceFromArg === undefined) since = m[2];
  }
}

if (!channel || !target) {
  console.error(
    "缺 channel 或 target。請給 --tap <file>，或直接給 --channel <c> --target <id>。\n" +
      "`.tap` 長這樣（只有三個欄位，而且絕不進版控）：\n" +
      "  channel: telegram\n" +
      "  target:  -1001234567890\n" +
      "  viewed:  2026-08-18 12:43:27",
  );
  process.exit(2);
}

const stateDir = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
const agentsDir = join(stateDir, "agents");
const logPath = arg("log", join(stateDir, "logs", "chat-interceptor.log"));
const issuePath = arg("asides", join(stateDir, "logs", "chat-interceptor-asides.log"));
const onlyAgent = arg("agent");
const format = arg("format", "md");
const tail = Number(arg("tail", "400"));

// ---------------------------------------------------------------------------
// 時間
// ---------------------------------------------------------------------------
// 全部收斂成當地時間的 `YYYY-MM-DD HH:MM:SS`：聊天室看到的、`.tap` 的 viewed、
// issue log 都是這個尺規，補滿到同寬之後直接字串比大小就對了，不必經過 Date。
const pad = (value) => {
  const raw = String(value ?? "").trim().replace("T", " ");
  if (raw.length === 10) return `${raw} 00:00:00`; // 只有日期
  if (raw.length === 16) return `${raw}:00`; // 到分
  return raw.slice(0, 19);
};
const sinceStamp = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(String(since ?? "").trim())
  ? pad(since)
  : null; // `--since 0`、留空、寫壞了 → 不過濾

const two = (n) => String(n).padStart(2, "0");
const localStamp = (date) =>
  `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
  `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
/** 當地時間字串 → epoch ms（比對前後幾秒用的，壞掉就回 NaN）。 */
const stampMs = (stamp) => new Date(String(stamp).replace(" ", "T")).getTime();

// ---------------------------------------------------------------------------
// 1~3：從本機 session 檔還原對話
// ---------------------------------------------------------------------------
// target 正規化：telegram 是裸 id，discord 是 channel:<id>，sessionKey 是
// agent:<id>:<channel>:<group|channel>:<rawId>。統一剝到裸 id 再比對。
const bareTarget = String(target).replace(/^(?:[a-z-]+:)*?([^:]+)$/i, "$1");
const CHAT_TAG = `${channel}:${bareTarget}`; // prompt metadata 裡的 chat_id
const KEY_RE = new RegExp(
  `^(?:agent:([^:]+):)?${channel}:(?:group|channel|thread|dm|direct|user|chat):` +
    `${bareTarget.replace(/[-[\]{}()*+?.,\\^$|#]/g, "\\$&")}$`,
);

const byId = new Map(); // message id -> { id, ts, sender, text }
const noId = []; // { ts, sender, text }：來自 transcript，沒有 message id

function addById(id, ts, sender, text) {
  const key = String(id);
  const current = byId.get(key);
  if (!current) byId.set(key, { id: Number(key), ts, sender, text });
  // 同一則在不同來源被裁切的長度不同，留最長的那份
  else if (text && text.length > (current.text || "").length) current.text = text;
}

/** 從一段 prompt 文字裡榨出 metadata + context 各則 + 本次的新訊息。 */
function harvestPrompt(prompt) {
  if (!prompt.includes(CHAT_TAG)) return;
  let meta = null;
  const infoMatch = prompt.match(/Conversation info \(untrusted metadata\):\s*```json\s*([\s\S]*?)```/);
  if (infoMatch) {
    try {
      meta = JSON.parse(infoMatch[1]);
    } catch {
      // metadata 壞了就當作沒有，context 那半段還是撿得到
    }
  }
  if (meta?.chat_id && meta.chat_id !== CHAT_TAG) return; // 別的房間

  let tail = null;
  const contextIndex = prompt.indexOf("Conversation context (untrusted");
  if (contextIndex >= 0) {
    const block = prompt.slice(contextIndex);
    for (const line of block.split("\n")) {
      const m = /^#(\d+)\s+(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) GMT\+\d+ ([^:]+): (.*)$/.exec(line);
      if (m) addById(m[1], m[2], m[3].trim(), m[4]);
    }
    const parts = block.split("\n\n");
    tail = parts[parts.length - 1].trim();
  } else if (infoMatch) {
    tail = prompt.slice(prompt.indexOf(infoMatch[0]) + infoMatch[0].length).trim();
  }
  if (meta?.message_id && tail != null) {
    const ts = String(meta.timestamp || "").replace(/^\w{3} /, "").replace(/ GMT\+\d+$/, "");
    addById(meta.message_id, ts, meta.sender?.name || "?", tail);
  }
}

/** 深走一個 JSON 物件，對每個含 CHAT_TAG 的字串試 harvestPrompt。 */
function harvestJsonLine(line) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return; // 壞行略過
  }
  const stack = [parsed];
  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string") {
      if (value.includes(CHAT_TAG)) harvestPrompt(value);
    } else if (value && typeof value === "object") {
      for (const key of Object.keys(value)) stack.push(value[key]);
    }
  }
}

function walk(dir, visit) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, visit);
    else visit(path);
  }
}

const stats = { trajectoryFiles: 0, transcriptFiles: 0, rolloutFiles: 0 };
let agentIds = [];
try {
  agentIds = (onlyAgent ? [onlyAgent] : readdirSync(agentsDir)).filter((id) => existsSync(join(agentsDir, id)));
} catch {
  console.error(`讀不到 ${agentsDir} —— OPENCLAW_STATE_DIR 設對了嗎？`);
}

// 輪替出去的 .reset./.deleted. 也要讀：使用者的歷史不會因為 session 被重置就不算數。
const JSONL_RE = /\.jsonl(\.(?:reset|deleted)\..*)?$/;

for (const agentId of agentIds) {
  const root = join(agentsDir, agentId);

  // (1)+(3) 任何 jsonl 裡帶 chat_id 的 prompt
  walk(root, (file) => {
    if (!JSONL_RE.test(file)) return;
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      return;
    }
    if (!text.includes(CHAT_TAG)) return;
    if (file.includes("codex-home")) stats.rolloutFiles++;
    else if (file.endsWith(".trajectory.jsonl")) stats.trajectoryFiles++;
    for (const line of text.split("\n")) if (line.includes(CHAT_TAG)) harvestJsonLine(line);
  });

  // (2) transcript：先用 trajectory 首行把 sessionId -> sessionKey 建表
  const sessionsDir = join(root, "sessions");
  if (!existsSync(sessionsDir)) continue;
  const sessionKeys = new Map();
  for (const name of readdirSync(sessionsDir)) {
    if (!name.endsWith(".trajectory.jsonl")) continue;
    try {
      const first = readFileSync(join(sessionsDir, name), "utf8").split("\n", 1)[0];
      const parsed = JSON.parse(first);
      if (parsed.sessionId && parsed.sessionKey) sessionKeys.set(parsed.sessionId, parsed.sessionKey);
    } catch {
      // 首行壞掉就查不到這個 session 的房間，只好放過
    }
  }
  for (const name of readdirSync(sessionsDir)) {
    const m = /^([0-9a-f-]{36})\.jsonl(\.(?:reset|deleted)\..*)?$/.exec(name);
    if (!m) continue;
    const key = sessionKeys.get(m[1]);
    if (!key || !KEY_RE.test(key)) continue;
    stats.transcriptFiles++;
    for (const line of readFileSync(join(sessionsDir, name), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed.type !== "message") continue;
      const message = parsed.message;
      if (!message || message.role !== "user" || typeof message.content !== "string") continue;
      if (message.sourceChannel !== channel) continue;
      noId.push({
        ts: localStamp(new Date(message.timestamp)),
        sender: message.senderName || "?",
        text: message.content,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// 4：攔截器的 trace log —— 每一輪的下場
// ---------------------------------------------------------------------------
// 一輪是兩行：先 `turn`（收到什麼、對上哪條 route），再一行結果。
// 兩行之間可能插進別的房間的 turn，所以結果要往回找「同一條 route 還沒收尾的那一輪」。
const OUTCOMES = {
  handled: "handled",
  issue: "issue",
  "pass: script declined": "pass",
  "pass: script failed": "pass-error",
  error: "error",
};

const turns = [];
let traceLogFound = false;
{
  let raw = "";
  try {
    raw = readFileSync(logPath, "utf8");
    traceLogFound = true;
  } catch {
    // 沒有這個檔＝route 沒開 debug。逐字稿還是有，只是不知道每一則的下場。
  }
  const open = [];
  for (const line of raw.split("\n")) {
    const m = /^\[([^\]]+)\] (\S+(?: [^{]*?)?) (\{.*\})$/.exec(line.trim());
    if (!m) continue;
    let data;
    try {
      data = JSON.parse(m[3]);
    } catch {
      continue;
    }
    const label = m[2].trim();
    const ts = localStamp(new Date(m[1])); // trace 是 ISO/UTC，換成當地時間才好對照
    if (label === "turn") {
      if (data.channel !== channel || String(data.target) !== bareTarget) continue;
      const turn = { ts, body: String(data.body ?? ""), route: data.route ?? null, outcome: null, detail: null };
      turns.push(turn);
      // route 沒對上就沒有第二行——這一輪整個交給 AI 了
      if (turn.route === null) turn.outcome = "no-route";
      else open.push(turn);
      continue;
    }
    const outcome = OUTCOMES[label];
    if (!outcome) continue;
    const index = open.findLastIndex((t) => t.route === (data.route ?? null));
    if (index === -1) continue; // 別的房間的結果
    const turn = open.splice(index, 1)[0];
    turn.outcome = outcome;
    turn.detail = data;
  }
}

// ---------------------------------------------------------------------------
// 5：/aside
// ---------------------------------------------------------------------------
const issues = [];
{
  let raw = "";
  try {
    raw = readFileSync(issuePath, "utf8");
  } catch {
    // 還沒有人記過 issue
  }
  for (const line of raw.split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\{.*\})$/.exec(line.trim());
    if (!m) continue;
    let data;
    try {
      data = JSON.parse(m[2]);
    } catch {
      continue;
    }
    if (data.channel && data.channel !== channel) continue;
    if (data.target && String(data.target) !== bareTarget) continue;
    issues.push({ ts: m[1], text: String(data.text ?? ""), route: data.route ?? "" });
  }
}

// ---------------------------------------------------------------------------
// 合併成一條時間軸
// ---------------------------------------------------------------------------
// 同一則訊息最多會在三個地方出現（session、trace log、issue log），合併時要認出
// 它們是同一則，否則檢討的人會以為使用者講了三次。
// 認法：第一行的原文一樣，而且時間相差在 MATCH_WINDOW_MS 之內
//（session 記的是 telegram 收訊時間，trace 記的是 hook 跑起來的時間，差幾秒是正常的）。
const MATCH_WINDOW_MS = 5 * 60 * 1000;
const firstLine = (text) => String(text ?? "").split("\n")[0].trim();
const stripIssue = (text) => String(text ?? "").replace(/^issue\b/i, "").trim();

const messages = [
  ...[...byId.values()].map((m) => ({ ...m, source: "session" })),
  ...noId.map((m) => ({ ...m, id: null, source: "transcript" })),
];
// transcript 那些沒有 id，跟已經有 id 的同一則會重複，逐字比對去掉
const knownText = new Set([...byId.values()].map((m) => firstLine(m.text)));
const seen = new Set();
const merged = messages.filter((m) => {
  if (m.source !== "transcript") return true;
  if (knownText.has(firstLine(m.text))) return false;
  const key = `${m.ts}|${firstLine(m.text)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

/** 在 candidates 裡找出與 (ts, text) 是同一則的那一筆。 */
function findSame(candidates, ts, text, { pick = (c) => c.text } = {}) {
  const wanted = firstLine(text);
  const at = stampMs(ts);
  let best = null;
  let bestGap = Infinity;
  for (const candidate of candidates) {
    if (firstLine(pick(candidate)) !== wanted) continue;
    const gap = Math.abs(stampMs(candidate.ts) - at);
    if (gap > MATCH_WINDOW_MS || gap >= bestGap) continue;
    best = candidate;
    bestGap = gap;
  }
  return best;
}

// trace 的每一輪：對得上 session 那則就把下場貼上去，對不上就自成一筆
//（那正是「被攔截、從來沒進過 session」的訊息——這支工具存在的理由）。
const orphanTurns = [];
for (const turn of turns) {
  const message = findSame(merged, turn.ts, turn.body);
  if (message) {
    message.outcome = turn.outcome;
    message.route = turn.route;
    message.detail = turn.detail;
  } else {
    orphanTurns.push(turn);
  }
}

// /aside 同理，只是它可能出現在兩個地方：後來某一輪的 Conversation context 撈得到它，
// trace log 也記過那一輪。**三個來源都要收斂成同一則**，否則檢討的人會以為
// 使用者把同一件事講了三次。
const orphanIssues = [];
for (const issue of issues) {
  const message = findSame(merged, issue.ts, issue.text, { pick: (m) => stripIssue(m.text) });
  if (message) {
    message.issue = issue.text;
    message.outcome = message.outcome ?? "issue";
    continue;
  }
  const turn = findSame(orphanTurns, issue.ts, issue.text, { pick: (t) => stripIssue(t.body) });
  if (turn) {
    turn.issue = issue.text;
    continue;
  }
  orphanIssues.push(issue);
}

const timeline = [
  ...merged.map((m) => ({
    ts: m.ts,
    id: m.id,
    sender: m.sender,
    text: m.text,
    issue: m.issue,
    outcome: m.outcome ?? null,
    route: m.route ?? null,
    detail: m.detail ?? null,
    source: m.source,
  })),
  ...orphanTurns.map((t) => ({
    ts: t.ts,
    id: null,
    sender: null,
    text: t.body,
    issue: t.issue,
    outcome: t.outcome,
    route: t.route,
    detail: t.detail,
    source: "intercept-log",
  })),
  ...orphanIssues.map((i) => ({
    ts: i.ts,
    id: null,
    sender: null,
    text: i.text,
    issue: i.text,
    outcome: "issue",
    route: i.route || null,
    detail: null,
    source: "issue-log",
  })),
]
  .filter((entry) => !sinceStamp || pad(entry.ts) >= sinceStamp)
  .sort((a, b) => (a.ts === b.ts ? (a.id ?? 0) - (b.id ?? 0) : a.ts < b.ts ? -1 : 1));

const shownIssues = issues.filter((i) => !sinceStamp || pad(i.ts) >= sinceStamp);
const shownTurns = turns.filter((t) => !sinceStamp || pad(t.ts) >= sinceStamp);
const count = (outcome) => shownTurns.filter((t) => t.outcome === outcome).length;
const summary = {
  turns: shownTurns.length,
  handled: count("handled"),
  pass: count("pass"),
  passAfterError: count("pass-error"),
  error: count("error"),
  noRoute: count("no-route"),
  issue: shownIssues.length,
};

// 缺哪些 message id：從最小掃到最大，沒收錄到的就是漏的。
//
// **但這個範圍不一定是真的 message id 範圍。** 按鍵（callback）在 transcript 裡帶的是
// 1e18 等級的偽 id，不是 telegram 的 message id；只要頻道裡有人按過鍵盤，這個迴圈
// 就會想從四位數一路數到那個天文數字，當場 RangeError，一則對話都汲取不到。
// 所以掃描範圍設上限：超過就放棄缺漏偵測（在涵蓋範圍裡誠實說明），其餘功能照常。
// 汲取對話是主要目的，缺漏清單只是附帶資訊，不該讓附帶資訊弄死主要目的。
const MAX_GAP_SCAN = 100_000;
const withId = [...byId.values()].sort((a, b) => a.id - b.id);
let missingIds = [];
let gapScanned = true;
if (withId.length) {
  const lo = withId[0].id;
  const hi = withId[withId.length - 1].id;
  if (hi - lo > MAX_GAP_SCAN) gapScanned = false;
  else for (let i = lo; i <= hi; i++) if (!byId.has(String(i))) missingIds.push(i);
}

const coverage = {
  channel,
  target: bareTarget,
  agents: agentIds,
  since: sinceStamp,
  files: stats,
  interceptLog: traceLogFound ? logPath : null,
  issueLog: existsSync(issuePath) ? issuePath : null,
  recovered: { withId: withId.length, transcriptOnly: merged.length - withId.length },
  idRange: withId.length ? [withId[0].id, withId[withId.length - 1].id] : null,
  missingIds: gapScanned ? missingIds : null,
};

// ---------------------------------------------------------------------------
// 輸出
// ---------------------------------------------------------------------------
if (format === "json") {
  console.log(JSON.stringify({ tap: tapPath ?? null, coverage, summary, issues: shownIssues, timeline }, null, 1));
  process.exit(0);
}

const OUTCOME_LABEL = {
  handled: "攔下了，0 token",
  issue: "/aside，記下來就好",
  pass: "**放行給 AI**（script exit 20）",
  "pass-error": "script 出錯後放行給 AI",
  error: "**出錯**，使用者看到錯誤訊息",
  "no-route": "沒有 route 對上，整輪交給 AI",
};
const indent = (text, prefix = "    ") =>
  String(text ?? "")
    .split("\n")
    .map((line) => (line.trim() ? prefix + line : ""))
    .join("\n");

console.log(`# tap ${channel}:${bareTarget}`);
console.log("");
console.log(`範圍：${sinceStamp ? `${sinceStamp} 起` : "全部"}${tapPath ? `（${tapPath}）` : ""}`);
if (!traceLogFound) {
  console.log("");
  console.log(
    "> ⚠️ 找不到攔截器的 trace log，所以**不知道每一則的下場**（有沒有被攔到）。\n" +
      `> 那個檔是 ${logPath}，要 plugin 設定裡 \`"debug": true\` 才會有。`,
  );
}
console.log("");
if (summary.turns) {
  console.log(
    `攔截器經手 ${summary.turns} 輪：攔下 ${summary.handled}、` +
      `放行給 AI ${summary.pass}、出錯 ${summary.error + summary.passAfterError}、` +
      `沒有 route ${summary.noRoute}`,
  );
}
console.log(`/aside ${summary.issue} 則、逐字稿 ${timeline.length} 則`);

// ---- /aside：使用者親口留下的話，優先於任何人的推測 ----
if (shownIssues.length) {
  console.log("");
  console.log(`## /aside（${shownIssues.length} 則）`);
  console.log("");
  console.log("使用者自己記下的問題。**這比任何推測都準，先看這個。**");
  console.log("");
  for (const issue of shownIssues) {
    console.log(`### ${issue.ts}`);
    console.log("");
    console.log(issue.text || "（空的）");
    console.log("");
  }
}

// ---- 放行給 AI 的：下一條規則要寫什麼，原料在這裡 ----
const passes = shownTurns.filter((t) => t.outcome === "pass" || t.outcome === "no-route");
if (passes.length) {
  console.log("");
  console.log(`## 放行給 AI 的輸入（${passes.length} 則）`);
  console.log("");
  console.log(
    "script 說「我不會」（exit 20），或這個房間根本還沒設 route——總之這些都花了 token。\n" +
      "**同一句話講愈多次，就愈值得寫成規則。**",
  );
  console.log("");
  const bySame = new Map();
  for (const turn of passes) {
    const key = firstLine(turn.body).slice(0, 100);
    bySame.set(key, (bySame.get(key) || 0) + 1);
  }
  for (const [text, n] of [...bySame.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`- \`${String(n).padStart(3)}×\`  ${JSON.stringify(text)}`);
  }
}

// ---- 出錯的：使用者真的看到紅字，優先修 ----
const errors = shownTurns.filter((t) => t.outcome === "error" || t.outcome === "pass-error");
if (errors.length) {
  console.log("");
  console.log(`## 出錯（${errors.length} 則）`);
  console.log("");
  console.log("使用者收到的是錯誤訊息，不是答案。**優先修這些。**");
  console.log("");
  for (const turn of errors) {
    console.log(`- ${turn.ts}　${JSON.stringify(firstLine(turn.body).slice(0, 60))}`);
    if (turn.detail?.failure) console.log(`  ${JSON.stringify(String(turn.detail.failure).slice(0, 200))}`);
  }
}

// ---- 逐字稿 ----
console.log("");
console.log("## 逐字稿");
console.log("");
const shown = tail > 0 && timeline.length > tail ? timeline.slice(-tail) : timeline;
if (shown.length < timeline.length) {
  console.log(`（只列最後 ${shown.length} 則，全部有 ${timeline.length} 則；要全部請加 \`--tail 0\`）`);
  console.log("");
}
for (const entry of shown) {
  const id = entry.id ? `#${entry.id} ` : "";
  const who = entry.sender ? `${entry.sender}：` : "";
  // ISSUE 的全文已經在上面整段印過了，這裡只留一行位置感，不要洗版
  const text = entry.issue
    ? `ISSUE ${firstLine(entry.issue)}${entry.issue.includes("\n") ? "　…（全文見上面 ISSUE 那節）" : ""}`
    : entry.text;
  const head = `${entry.ts}　${id}${who}`;
  const lines = String(text ?? "").split("\n");
  console.log(`- ${head}${lines[0]}`);
  for (const line of lines.slice(1)) console.log(indent(line, "  "));
  if (entry.outcome) {
    const route = entry.route ? `「${entry.route}」` : "";
    console.log(`  ↳ ${OUTCOME_LABEL[entry.outcome] ?? entry.outcome}${route}`);
  }
}

// ---- 涵蓋範圍：這份汲取到底完不完整 ----
console.log("");
console.log("## 涵蓋範圍");
console.log("");
console.log("```json");
console.log(JSON.stringify(coverage, null, 1));
console.log("```");
if (!gapScanned) {
  console.log("");
  console.log("（`missingIds: null` ＝ 這個頻道有人按過鍵盤，id 範圍被偽 id 撐爆，放棄缺漏偵測。其餘照常。）");
}

// ---- 接力棒 ----
const last = timeline.length ? timeline[timeline.length - 1].ts : sinceStamp;
console.log("");
console.log("———");
if (last) {
  console.log("檢討完、改完程式之後，把 `.tap` 的 viewed 推到這裡，下次就只看新的：");
  console.log("");
  console.log("```");
  console.log(`viewed: ${last}`);
  console.log("```");
} else {
  console.log("這段期間沒有任何紀錄。要看全部請加 `--since 0`。");
}
