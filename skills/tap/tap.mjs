#!/usr/bin/env node
// tap —— 把一個聊天室的對話整份汲取出來，包括 AI 從來沒看到的那些。
//
//   node tap.mjs                                   讀 ./.tap 或 ./genesis/.tap
//   node tap.mjs --since "2026-09-01 10:00"        起點改成這個時間
//   node tap.mjs --channel telegram --target -1001234567890 --since 0
//   node tap.mjs --format json
//
// 為什麼需要這支：被 chat-interceptor 攔掉的那些輸入**根本沒進 session**，平台上也看不出
// 它們的下場；而平台不一定讀得到歷史（Telegram 就不行）。這支把三類來源合併還原：
//
//   平台上的歷史（房間裡講過什麼，以它為準）
//     6. 經由 gateway 的 /chat-interceptor/history（`openclaw message read`）
//        → OpenClaw 不在場時講的也在：機器人被拉進討論串之前的、跟別的機器人談的。
//          讀不到（平台不給、gateway 沒開）就只靠本機的紀錄
//
//   session 檔（AI 看到的，與 AI 的回應）
//     1. <sessionId>.trajectory.jsonl 的 prompt
//        → Conversation info(metadata，有 message_id 與發話者) + Conversation context
//          (前幾則，格式 "#id  時間 GMT+8 名字: 內容")。context 裡連「AI 沒被叫醒
//          也看得到的鄰近訊息」都有——被攔截的訊息也會從這裡漏出來
//     2. <sessionId>.jsonl（及輪替出去的 .reset./.deleted.）
//        → 乾淨的 role:user 原文，但沒有 message id
//     3. agent/codex-home/sessions/**/rollout-*.jsonl
//        → runtime 另一份副本，補 1 已被輪替掉的部分
//     5. agent/openclaw-agent.sqlite（OpenClaw 2026.9 起）
//        → session 全搬進這裡，上面 1、2 從此不再長大。使用者發言帶著 message id 與發話者，也有 AI 的回應
//
//   offstage log（AI 沒看到的）
//     4. chat-interceptor-offstage.log
//        → script 接走的、script 出錯的、/aside（人打的，或其他機器人只給人看的訊息）。plugin 一直開著在記。
//
// session 來源都會有缺漏（session 輪替、context window 裁切），合併後才接近完整；
// 輸出最後的「涵蓋範圍」會說還缺多少、看不看得出來。

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as zlib from "node:zlib";
import { gatewayUrl } from "./gateway.mjs";

// ---------------------------------------------------------------------------
// 參數與 .tap
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

if (has("help") || has("h")) {
  console.log(
    [
      "usage: node tap.mjs [--tap <file>] [--channel <c> --target <id>] [--since <stamp>|0]",
      "                   [--format md|json] [--agent <id>] [--offstage <file>]",
      "",
      "  --tap       房間檔，三個欄位：channel / target / timestamp（預設找 ./.tap、./genesis/.tap）",
      "  --since     起點，蓋過 .tap 的 timestamp；--since 0 看全部",
      "  --format    md（預設）或 json",
      "  --offstage  AI 沒看到的那些，預設 ~/.openclaw/logs/chat-interceptor-offstage.log",
    ].join("\n"),
  );
  process.exit(0);
}

let channel = arg("channel");
let target = arg("target");
let since = arg("since");
const sinceFromArg = since; // 命令列給的 --since 不可以被檔案裡的 timestamp 蓋掉

const tapPath = arg("tap", [".tap", join("genesis", ".tap")].find((p) => existsSync(p)));
if (tapPath) {
  let text;
  try {
    text = readFileSync(tapPath, "utf8");
  } catch (error) {
    console.error(`讀不到 ${tapPath}：${error.message}`);
    process.exit(2);
  }
  for (const line of text.split(/\r?\n/)) {
    // 認得的鍵只有三個。# 開頭的註解與其它東西一律略過。
    const m = /^\s*(channel|target|timestamp)\s*:\s*(.*?)\s*$/.exec(line);
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
      "  channel:   telegram\n" +
      "  target:    -1001234567890\n" +
      "  timestamp: 2026-08-18 12:43:27",
  );
  process.exit(2);
}

const stateDir = process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw");
const agentsDir = join(stateDir, "agents");
const offstagePath = arg("offstage", join(stateDir, "logs", "chat-interceptor-offstage.log"));
const onlyAgent = arg("agent");
const format = arg("format", "md");

// ---------------------------------------------------------------------------
// 時間
// ---------------------------------------------------------------------------
// 全部收斂成當地時間的 `YYYY-MM-DD HH:MM:SS`：聊天室看到的、`.tap` 的 timestamp、
// offstage log 都是這個尺規，補滿到同寬之後直接字串比大小就對了，不必經過 Date。
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
const senderNames = new Map(); // sender id -> 顯示名稱，給 offstage 那些用

/** Telegram 的 id 是小整數；Discord 的、按鍵的偽 id 超過 Number 的精度，留字串。 */
const asId = (value) => (Number.isSafeInteger(Number(value)) ? Number(value) : String(value));

function addById(id, ts, sender, text) {
  const key = String(id);
  const current = byId.get(key);
  if (!current) byId.set(key, { id: asId(key), ts, sender, text });
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
  if (meta?.sender?.id && meta.sender.name) senderNames.set(String(meta.sender.id), meta.sender.name);

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
// 5：OpenClaw 2026.9 起的 session 存法 —— agents/<id>/agent/openclaw-agent.sqlite
// ---------------------------------------------------------------------------
// 升級時 OpenClaw 自己把當時的 session 檔匯入這裡，之後每一輪也只寫這裡。
// 使用者發言在 transcript_events，直接帶著平台的 message id 與發話者，不必從 prompt 裡榨；
// 被 /new、/reset 換掉的 session 整份封存在 session_transcript_archives。
// 只讀：gateway 正開著它。內容有一部分是 zstd 壓縮存的。
let DatabaseSync = null;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // Node 太舊沒有 node:sqlite：涵蓋範圍會說 sqliteSessions 是 null
}
stats.sqliteSessions = DatabaseSync ? 0 : null;
stats.sqliteMessages = 0;

const unzstd = (blob) => (zlib.zstdDecompressSync ? zlib.zstdDecompressSync(Buffer.from(blob)).toString("utf8") : null);

/** AI 選擇不回話時留下的字，房間裡看不到。 */
const SILENT_RE = /^(?:NO_REPLY|HEARTBEAT_OK)$/;

/** transcript 的一個 event：使用者的發言，與 AI 的回應。 */
function harvestTranscriptEvent(json) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch {
    return;
  }
  const message = parsed?.type === "message" ? parsed.message : null;
  if (!message || (message.role !== "user" && message.role !== "assistant")) return;
  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content.filter((part) => part?.type === "text").map((part) => part.text).join("\n")
        : "";
  const ts = localStamp(new Date(message.timestamp ?? parsed.timestamp));
  if (message.role === "assistant") {
    if (text.trim() && !SILENT_RE.test(text.trim())) noId.push({ ts, sender: "AI", text });
    return;
  }
  const meta = message.__openclaw ?? {};
  if (!text || (meta.transport?.channel && meta.transport.channel !== channel)) return;
  const sender = meta.senderName || "?";
  if (meta.senderId && meta.senderName) senderNames.set(String(meta.senderId), meta.senderName);
  stats.sqliteMessages++;
  if (meta.transport?.messageId) addById(meta.transport.messageId, ts, sender, text);
  else noId.push({ ts, sender, text });
}

for (const agentId of DatabaseSync ? agentIds : []) {
  const file = join(agentsDir, agentId, "agent", "openclaw-agent.sqlite");
  if (!existsSync(file)) continue;
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch {
    continue;
  }
  try {
    const events = db.prepare("SELECT event_json, event_zstd FROM transcript_events WHERE session_id = ? ORDER BY seq");
    for (const { session_id: id, session_key: key } of db.prepare("SELECT session_id, session_key FROM session_windows").all()) {
      if (!KEY_RE.test(key)) continue;
      stats.sqliteSessions++;
      for (const row of events.all(id)) {
        const json = row.event_json ?? (row.event_zstd ? unzstd(row.event_zstd) : null);
        if (json) harvestTranscriptEvent(json);
      }
    }
    for (const row of db.prepare("SELECT session_key, encoding, archive_blob FROM session_transcript_archives").all()) {
      if (!KEY_RE.test(row.session_key)) continue;
      stats.sqliteSessions++;
      const text = row.encoding === "zstd" ? unzstd(row.archive_blob) : Buffer.from(row.archive_blob).toString("utf8");
      for (const line of String(text ?? "").split("\n")) if (line.trim()) harvestTranscriptEvent(line);
    }
  } catch (error) {
    // 表長得跟預期不一樣（OpenClaw 又改了）：別讓一個 agent 弄死整份汲取，照實寫進涵蓋範圍
    (stats.sqliteErrors ??= []).push(`${agentId}: ${error.message}`);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// 4：offstage log —— AI 沒看到的那些
// ---------------------------------------------------------------------------
const offstage = [];
let offstageFound = false;
{
  let raw = "";
  try {
    raw = readFileSync(offstagePath, "utf8");
    offstageFound = true;
  } catch {
    // 還沒有任何一句被攔下或留成 /aside
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
    if (String(data.target ?? "").replace(/^(?:[a-z-]+:)*?([^:]+)$/i, "$1") !== bareTarget) continue;
    offstage.push({
      ts: m[1],
      kind: data.kind,
      text: String(data.text ?? ""),
      reply: data.reply ?? null,
      senderId: data.senderId ? String(data.senderId) : null,
      bot: data.bot === true,
    });
  }
}

// ---------------------------------------------------------------------------
// 6：平台上的歷史 —— 經由 gateway 的 `openclaw message read`
// ---------------------------------------------------------------------------
// 一頁要半分鐘，翻好幾頁就是好幾分鐘。`{ messages, complete }`，讀不到就是 `{ error }`。
const platform = await readPlatform();

async function readPlatform() {
  let response;
  try {
    response = await fetch(gatewayUrl("/chat-interceptor/history"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channel, target, since: sinceStamp ? stampMs(sinceStamp) : 0 }),
    });
  } catch (error) {
    return { error: `cannot reach the OpenClaw gateway: ${error.cause?.message ?? error.message}` };
  }
  const answer = await response.json().catch(() => null);
  if (!response.ok || !Array.isArray(answer?.messages)) return { error: answer?.error || `the gateway answered ${response.status}` };
  return { messages: answer.messages.map(fromPlatform).filter(Boolean), complete: answer.complete === true, error: answer.error ?? null };
}

/** 平台原樣的訊息（Discord 的 message 物件）→ 逐字稿的一則。 */
function fromPlatform(message) {
  const at = Number(message?.timestampMs) || Date.parse(message?.timestamp ?? "");
  if (message?.id == null || !at) return null;
  const author = message.author ?? {};
  const names = new Map((message.mentions ?? []).map((user) => [String(user.id), user.global_name || user.username]));
  const text = [
    String(message.content ?? "").replace(/<@!?(\d+)>/g, (all, id) => (names.get(id) ? `@${names.get(id)}` : all)),
    ...(message.embeds ?? []).map((embed) => [embed?.title, embed?.description].filter(Boolean).join("\n")),
    ...(message.attachments ?? []).map((file) => `[附件 ${file?.filename ?? file?.url ?? ""}]`),
  ]
    .filter(Boolean)
    .join("\n");
  if (!text) return null;
  const name = author.global_name || author.username || (author.id ? String(author.id) : "?");
  if (author.id && !author.bot) senderNames.set(String(author.id), name);
  return { id: asId(message.id), ts: localStamp(new Date(at)), sender: author.bot ? botLabel(name) : name, text, source: "platform" };
}

// ---------------------------------------------------------------------------
// 合併成一條時間軸
// ---------------------------------------------------------------------------
// 同一則訊息可能同時出現在好幾個來源（平台、session、offstage log——被攔下的那則，後來又在
// 別一輪的 Conversation context 裡出現），合併時要認出它們是同一則，否則讀的人會以為講了兩次。
// 認法：message id 一樣；沒有 id 的，第一行的原文一樣，而且時間相差在 MATCH_WINDOW_MS 之內
//（各來源記的時間不一樣：平台的送出時間、session 的收訊時間、offstage 的 hook 跑起來的時間）。
const MATCH_WINDOW_MS = 5 * 60 * 1000;
const firstLine = (text) => String(text ?? "").split("\n")[0].trim();
// 機器人的 /aside 開頭是一個看不見的記號（U+E0021），session 裡看到的那一則會帶著它。
const ASIDE_RE = /^(?:\u{E0021}|\/aside(?:@\S+)?(?![\w-]))/iu;
const stripAside = (text) => String(text ?? "").replace(ASIDE_RE, "").trim();
function botLabel(name) {
  const label = String(name ?? "?");
  return label.endsWith("（機器人）") ? label : `${label}（機器人）`;
}

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

/** 在 candidates 裡找出與 (ts, text) 是同一則、而且還沒被認領（free）的那一筆。 */
function findSame(candidates, ts, text, pick, free = (candidate) => !candidate.kind) {
  const wanted = firstLine(text);
  const at = stampMs(ts);
  let best = null;
  let bestGap = Infinity;
  for (const candidate of candidates) {
    if (!free(candidate) || firstLine(pick(candidate.text)) !== wanted) continue;
    const gap = Math.abs(stampMs(candidate.ts) - at);
    if (gap > MATCH_WINDOW_MS || gap >= bestGap) continue;
    best = candidate;
    bestGap = gap;
  }
  return best;
}

// 讀得到平台，就以平台為主幹：本機的每一則對得上平台那一則就算同一則。平台翻到了的那段時間裡，
// 本機有、平台沒有的，是沒送出去的（AI 不回話、中途的旁白）或寫法不一樣的同一則，不收。
let base = merged;
let platformFrom = null; // 平台翻到的最舊那一則；翻完整了就是 null
if (platform.messages) {
  const theirs = platform.messages;
  const theirIds = new Map(theirs.map((m) => [String(m.id), m]));
  if (!platform.complete && theirs.length) platformFrom = theirs.reduce((a, b) => (b.ts < a.ts ? b : a)).ts;
  const covered = (ts) => platform.complete || (platformFrom !== null && ts >= platformFrom);
  const kept = [];
  for (const m of merged) {
    const same = (m.id != null && theirIds.get(String(m.id))) || findSame(theirs, m.ts, m.text, (text) => text, (c) => !c.local);
    if (same) same.local = true;
    else if (!covered(m.ts)) kept.push(m);
  }
  base = [...theirs, ...kept];
}

// offstage 的每一筆：對得上那一則就把下場貼上去，對不上就自成一筆
//（那正是「被攔截、從來沒進過 session」的訊息——這支工具存在的理由）。
const timeline = [...base];
for (const entry of offstage) {
  const pick = entry.kind === "aside" ? stripAside : (text) => text;
  const name = entry.senderId ? (senderNames.get(entry.senderId) ?? entry.senderId) : null;
  const sender = entry.bot ? botLabel(name) : name;
  const message = findSame(base, entry.ts, entry.text, pick);
  if (message) {
    Object.assign(message, { kind: entry.kind, reply: entry.reply, local: true, text: entry.kind === "aside" ? entry.text : message.text });
    if (entry.bot) message.sender = botLabel(message.sender);
  } else {
    timeline.push({ ts: entry.ts, id: null, sender, text: entry.text, kind: entry.kind, reply: entry.reply, source: "offstage" });
  }
}
// offstage log 沒記到的 /aside（例如這一台自己送出去的，hook 看不到）：從原文認。
for (const message of timeline) {
  if (message.kind || !ASIDE_RE.test(message.text)) continue;
  if (message.text.startsWith("\u{E0021}")) message.sender = botLabel(message.sender);
  Object.assign(message, { kind: "aside", text: stripAside(message.text) });
}

/** id 的先後：位數多的大，同位數照字串比——Discord 的 id 超過 Number 的精度。 */
const idOrder = (a, b) => {
  const x = String(a ?? "");
  const y = String(b ?? "");
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
};
const inWindow = timeline.filter((entry) => !sinceStamp || pad(entry.ts) >= sinceStamp);
const shown = inWindow
  .sort((a, b) => (a.ts === b.ts ? idOrder(a.id, b.id) : a.ts < b.ts ? -1 : 1))
  .map(({ ts, id, sender, text, kind, reply, source }) => ({
    ts,
    id: id ?? null,
    sender: sender ?? null,
    text,
    kind: kind ?? null,
    reply: reply ?? null,
    source,
  }));

const asides = shown.filter((entry) => entry.kind === "aside");
const count = (kind) => shown.filter((entry) => entry.kind === kind).length;
const summary = {
  messages: shown.length,
  offstage: count("script") + count("error") + count("aside"),
  script: count("script"),
  error: count("error"),
  aside: count("aside"),
};

// 缺了多少。讀得到平台就照平台：翻完整了就沒缺，沒翻完整就說翻到哪裡。
// 讀不到平台，只能從本機收到的 message id 看：Telegram 的 id 在一個房間裡是連號的，
// 這段範圍內從最小掃到最大，沒收錄到的就是漏的，收成一段一段的。看不出來就是 null（不知道），不是 0。
//
// 按鍵（callback）的偽 id 是 1e18 等級、Discord 的 id 也不連號，asId 都留成字串，不掃。
// 範圍還是太大就放棄：汲取對話是主要目的，缺漏清單只是附帶資訊，不該讓附帶資訊弄死主要目的。
const MAX_GAP_SCAN = 100_000;
const withId = [...byId.values()].sort((a, b) => idOrder(a.id, b.id));
const inRange = withId.filter((m) => typeof m.id === "number" && (!sinceStamp || pad(m.ts) >= sinceStamp));
let missingCount = null;
let missingIds = null;
if (platform.messages) {
  if (platform.complete && !platform.error) [missingCount, missingIds] = [0, []];
} else if (inRange.length && inRange[inRange.length - 1].id - inRange[0].id <= MAX_GAP_SCAN) {
  [missingCount, missingIds] = [0, []];
  const lo = inRange[0].id;
  const hi = inRange[inRange.length - 1].id;
  let start = null;
  for (let i = lo; i <= hi + 1; i++) {
    const missing = i <= hi && !byId.has(String(i));
    if (missing) {
      missingCount += 1;
      start ??= i;
    } else if (start !== null) {
      missingIds.push(start === i - 1 ? String(start) : `${start}-${i - 1}`);
      start = null;
    }
  }
}

// 本機一筆這個房間的紀錄都沒有：OpenClaw 從來沒在這裡收過話。平台也讀不到的話，這份汲取什麼都不代表。
const localRecords =
  stats.trajectoryFiles + stats.transcriptFiles + stats.rolloutFiles + (stats.sqliteSessions ?? 0) > 0 || offstage.length > 0;
const blind = !localRecords && !platform.messages;
const warning = blind
  ? `OpenClaw 本機沒有這個房間的任何紀錄，平台的歷史也讀不到（${platform.error}）：這份汲取看不到這個房間的對話，不代表房間是空的。`
  : null;

const onPlatform = inWindow.filter((entry) => entry.source === "platform");
const coverage = {
  channel,
  target: bareTarget,
  agents: agentIds,
  since: sinceStamp,
  platform: platform.messages
    ? {
        messages: onPlatform.length,
        onlyOnPlatform: onPlatform.filter((entry) => !entry.local).length,
        complete: platform.complete,
        ...(platformFrom ? { from: platformFrom } : {}),
        ...(platform.error ? { error: platform.error } : {}),
      }
    : { error: platform.error },
  localRecords,
  files: stats,
  offstageLog: offstageFound ? offstagePath : null,
  recovered: { withId: withId.length, transcriptOnly: merged.length - withId.length, offstageOnly: timeline.length - base.length },
  idRange: inRange.length ? [inRange[0].id, inRange[inRange.length - 1].id] : null,
  missing: missingCount,
  missingIds,
};

// ---------------------------------------------------------------------------
// 輸出
// ---------------------------------------------------------------------------
if (format === "json") {
  console.log(JSON.stringify({ tap: tapPath ?? null, ...(warning ? { warning } : {}), coverage, summary, timeline: shown }, null, 1));
  process.exit(blind ? 3 : 0);
}

const indent = (text, prefix) =>
  String(text ?? "")
    .split("\n")
    .map((line) => (line.trim() ? prefix + line : ""))
    .join("\n");

console.log(`# tap ${channel}:${bareTarget}`);
console.log("");
console.log(`範圍：${sinceStamp ? `${sinceStamp} 起` : "全部"}${tapPath ? `（${tapPath}）` : ""}`);
console.log(
  `逐字稿 ${summary.messages} 則，其中 AI 沒看到的 ${summary.offstage} 則` +
    `（script 接走 ${summary.script}、script 出錯 ${summary.error}、/aside ${summary.aside}）`,
);
if (warning) {
  console.log("");
  console.log(`**${warning}**`);
}

// ---- /aside：房間裡特地留下、誰都不處理的話 ----
if (asides.length) {
  console.log("");
  console.log(`## /aside（${asides.length} 則）`);
  console.log("");
  for (const entry of asides) {
    console.log(`### ${entry.ts}${entry.sender ? `　${entry.sender}` : ""}`);
    console.log("");
    console.log(entry.text || "（空的）");
    console.log("");
  }
}

// ---- 逐字稿 ----
const MARKS = {
  script: (entry) => `↳ script 接走${entry.reply ? `，回：${firstLine(entry.reply)}` : "，沒有回話"}`,
  error: (entry) => `↳ script 出錯，使用者看到：${firstLine(entry.reply)}`,
  aside: () => "↳ /aside，AI 與 script 都沒看到",
};
console.log("");
console.log("## 逐字稿");
console.log("");
console.log("`時間　#message id 發話者：內容`。被 script 接走、script 出錯、/aside 的，底下有一行 ↳。");
console.log("");
for (const entry of shown) {
  const id = entry.id ? `#${entry.id} ` : "";
  const who = entry.sender ? `${entry.sender}：` : "";
  // /aside 的全文已經在上面整段印過了，這裡只留一行位置感，不要洗版
  const text =
    entry.kind === "aside"
      ? `/aside ${firstLine(entry.text)}${entry.text.includes("\n") ? "　…（全文見 /aside 那節）" : ""}`
      : entry.text;
  const lines = String(text ?? "").split("\n");
  console.log(`- ${entry.ts}　${id}${who}${lines[0]}`);
  for (const line of lines.slice(1)) console.log(indent(line, "  "));
  if (entry.kind) console.log(`  ${MARKS[entry.kind]?.(entry) ?? `↳ ${entry.kind}`}`);
}
if (!shown.length) console.log(`（這段期間沒有任何紀錄。${sinceStamp ? "要看全部請加 `--since 0`。" : ""}）`);

// ---- 涵蓋範圍：這份汲取到底完不完整 ----
console.log("");
console.log("## 涵蓋範圍");
console.log("");
console.log("```json");
console.log(JSON.stringify(coverage, null, 1));
console.log("```");
console.log("");
const notes = [
  platform.messages
    ? platform.complete
      ? "逐字稿以平台的歷史為準。"
      : `平台只翻到 ${platformFrom ?? "?"}，更早的只有本機的紀錄。`
    : "平台的歷史讀不到，逐字稿只有本機的紀錄。",
  missingCount === null ? "`missing: null` ＝ 看不出缺了哪些。" : null,
];
console.log(`（${notes.filter(Boolean).join("")}）`);
process.exitCode = blind ? 3 : 0;
