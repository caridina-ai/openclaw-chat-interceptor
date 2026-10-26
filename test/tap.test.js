// tap.mjs：把平台的歷史、session 檔（AI 看到的）與 offstage log（AI 沒看到的）合成一條時間軸。
// 這裡在暫存目錄搭一個假的 OpenClaw 狀態目錄，裡面只有汲取會讀的那幾個檔。
// 平台的歷史經由 gateway 的路由讀：沒掛那條路由的測試，gateway 一律連不上（port 9）。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import {
  DISCORD_CHAT,
  OTHER_CHAT,
  PLUGIN_ID,
  TELEGRAM_CHAT,
  fakeOpenclaw,
  readJsonLines,
  register,
  removeLater,
  serveRoute,
  tempDir,
} from "./helpers.js";

const TAP = fileURLToPath(new URL("../skills/tap/tap.mjs", import.meta.url));
const SESSION = "0f0e0d0c-0b0a-4908-8706-050403020100";

let dir;
let state;
let project;

const prompt = [
  "Conversation info (untrusted metadata):",
  "```json",
  JSON.stringify({
    chat_id: `telegram:${TELEGRAM_CHAT}`,
    message_id: "12",
    sender: { id: "7", name: "Alice" },
    timestamp: "Sun 2026-09-20 10:05:00 GMT+8",
  }),
  "```",
  "",
  "Conversation context (untrusted, recent messages):",
  // 別台機器人只給人看的訊息：開頭帶著看不見的記號，AI 的 context 裡看得到原樣。
  "#9  2026-09-20 09:59:00 GMT+8 Carol: \u{E0021}我做完了",
  "#10  2026-09-20 10:00:00 GMT+8 Alice: 自助餐120",
  "#11  2026-09-20 10:01:00 GMT+8 Alice: /aside 按鈕太小",
  "",
  "幫我查這個月的外食",
].join("\n");

const offstage = [
  { at: "2026-09-19 09:00:00", kind: "script", target: TELEGRAM_CHAT, text: "昨天的", reply: "ok" },
  { at: "2026-09-20 10:00:02", kind: "script", target: TELEGRAM_CHAT, text: "自助餐120", reply: "已記帳 外食費 120" },
  { at: "2026-09-20 10:01:01", kind: "aside", target: TELEGRAM_CHAT, text: "按鈕太小\n第二行" },
  { at: "2026-09-20 10:03:00", kind: "error", target: TELEGRAM_CHAT, text: "提款abc", reply: "ledger failed: bad amount" },
  { at: "2026-09-20 10:04:00", kind: "script", target: OTHER_CHAT, text: "別的房間", reply: "ok" },
  // 機器人的 /aside：這一台的 hook 記下來的。
  { at: "2026-09-20 09:59:01", kind: "aside", bot: true, target: TELEGRAM_CHAT, senderId: "9", text: "我做完了" },
  { at: "2026-09-20 10:04:30", kind: "aside", bot: true, target: TELEGRAM_CHAT, senderId: "9", text: "ledger: FIAT ready" },
];

before(() => {
  dir = tempDir("chat-interceptor-tap-");
  state = join(dir, "state");
  const sessions = join(state, "agents", "main", "sessions");
  mkdirSync(sessions, { recursive: true });
  const sessionKey = `agent:main:telegram:group:${TELEGRAM_CHAT}`;
  writeFileSync(
    join(sessions, `${SESSION}.trajectory.jsonl`),
    `${JSON.stringify({ sessionId: SESSION, sessionKey })}\n${JSON.stringify({ type: "prompt", prompt })}\n`,
    "utf8",
  );
  // 同一句也出現在 transcript 裡：合併時要認出是同一則。
  writeFileSync(
    join(sessions, `${SESSION}.jsonl`),
    `${JSON.stringify({
      type: "message",
      message: { role: "user", content: "幫我查這個月的外食", sourceChannel: "telegram", senderName: "Alice", timestamp: Date.parse("2026-09-20T10:05:00+08:00") },
    })}\n`,
    "utf8",
  );
  mkdirSync(join(state, "logs"), { recursive: true });
  writeFileSync(
    join(state, "logs", "chat-interceptor-offstage.log"),
    offstage
      .map(({ at, ...entry }) => `${at} ${JSON.stringify({ channel: "telegram", senderId: "7", ...entry })}`)
      .join("\n")
      .concat("\n"),
    "utf8",
  );
  project = join(dir, "ledger");
  mkdirSync(join(project, "genesis"), { recursive: true });
  writeFileSync(join(project, "genesis", ".tap"), `channel:   telegram\ntarget:    ${TELEGRAM_CHAT}\ntimestamp: 2026-09-20 00:00\n`, "utf8");
});

after(() => removeLater(dir));

/** 跑 tap.mjs，回傳 exit code 與輸出。 */
function runTap(args, { cwd = project, stateDir = state, port = "9" } = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [TAP, ...args],
      { cwd, encoding: "utf8", env: { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_GATEWAY_PORT: port, TZ: "Asia/Taipei" } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
    );
  });
}

async function tap(args = [], options) {
  const { code, stdout, stderr } = await runTap(args, options);
  if (code !== 0) throw new Error(stderr || `exit ${code}`);
  return stdout;
}

/** 汲取會讀的那幾張表、那幾個欄位。sessions：[{ key, events: [event 物件…] }]。 */
function seedDatabase(stateDir, sessions) {
  const agentDir = join(stateDir, "agents", "main", "agent");
  mkdirSync(agentDir, { recursive: true });
  const db = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"));
  db.exec(`
    CREATE TABLE session_windows (session_id TEXT, session_key TEXT);
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB);
    CREATE TABLE session_transcript_archives (session_key TEXT, encoding TEXT, archive_blob BLOB);
  `);
  sessions.forEach(({ key, events }, i) => {
    db.prepare("INSERT INTO session_windows VALUES (?, ?)").run(`s${i}`, key);
    events.forEach((event, seq) => db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run(`s${i}`, seq, JSON.stringify(event), null));
  });
  return db;
}

const userEvent = (at, text, { sender = { id: "8", name: "Bob" }, channel = "telegram", id } = {}) => ({
  type: "message",
  timestamp: at,
  message: {
    role: "user",
    content: text,
    timestamp: Date.parse(at),
    __openclaw: { senderId: sender.id, senderName: sender.name, transport: { channel, ...(id ? { messageId: String(id) } : {}) } },
  },
});
const aiEvent = (at, text) => ({
  type: "message",
  message: { role: "assistant", content: [{ type: "text", text }, { type: "toolCall", name: "bash", arguments: {} }], timestamp: Date.parse(at) },
});

const timeline = async (args = []) => JSON.parse(await tap(["--format", "json", ...args])).timeline;
const brief = (entries) => entries.map(({ ts, id, sender, text, kind, reply }) => ({ ts, id, sender, text, kind, reply }));

describe("tap.mjs", () => {
  it("merges what the AI saw with what it never saw, from the .tap timestamp on", async () => {
    assert.deepEqual(brief(await timeline()), [
      { ts: "2026-09-20 09:59:00", id: 9, sender: "Carol（機器人）", text: "我做完了", kind: "aside", reply: null },
      { ts: "2026-09-20 10:00:00", id: 10, sender: "Alice", text: "自助餐120", kind: "script", reply: "已記帳 外食費 120" },
      { ts: "2026-09-20 10:01:00", id: 11, sender: "Alice", text: "按鈕太小\n第二行", kind: "aside", reply: null },
      { ts: "2026-09-20 10:03:00", id: null, sender: "Alice", text: "提款abc", kind: "error", reply: "ledger failed: bad amount" },
      { ts: "2026-09-20 10:04:30", id: null, sender: "9（機器人）", text: "ledger: FIAT ready", kind: "aside", reply: null },
      { ts: "2026-09-20 10:05:00", id: 12, sender: "Alice", text: "幫我查這個月的外食", kind: null, reply: null },
    ]);
  });

  it("lets --since move the start", async () => {
    const all = await timeline(["--since", "0"]);
    assert.equal(all[0].text, "昨天的");
    assert.equal(all.length, 7);
    const late = await timeline(["--since", "2026-09-20 10:02"]);
    assert.deepEqual(
      late.map((entry) => entry.text),
      ["提款abc", "ledger: FIAT ready", "幫我查這個月的外食"],
    );
  });

  it("lists missing message ids as ranges, within the window only", async () => {
    const { coverage } = JSON.parse(await tap(["--format", "json"]));
    assert.deepEqual(coverage.idRange, [9, 12]);
    assert.equal(coverage.missing, 0);
    assert.deepEqual(coverage.missingIds, []);
    assert.match(coverage.platform.error, /^cannot reach the OpenClaw gateway/);
    assert.equal(coverage.localRecords, true);
  });

  it("counts what the AI never saw", async () => {
    const { summary } = JSON.parse(await tap(["--format", "json"]));
    assert.deepEqual(summary, { messages: 6, offstage: 5, script: 1, error: 1, aside: 3 });
  });

  it("prints asides in full and marks each offstage line in the transcript", async () => {
    const text = await tap();
    assert.match(text, /^範圍：2026-09-20 00:00:00 起/m);
    assert.match(
      text,
      /## \/aside（3 則）\n\n### 2026-09-20 09:59:00　Carol（機器人）\n\n我做完了\n\n### 2026-09-20 10:01:00　Alice\n\n按鈕太小\n第二行\n\n### 2026-09-20 10:04:30　9（機器人）\n\nledger: FIAT ready\n/,
    );
    assert.match(text, /- 2026-09-20 10:00:00　#10 Alice：自助餐120\n  ↳ script 接走，回：已記帳 外食費 120\n/);
    assert.match(text, /- 2026-09-20 10:01:00　#11 Alice：\/aside 按鈕太小　…（全文見 \/aside 那節）\n  ↳ \/aside/);
    assert.match(text, /- 2026-09-20 10:03:00　Alice：提款abc\n  ↳ script 出錯，使用者看到：ledger failed: bad amount\n/);
    assert.match(text, /- 2026-09-20 10:05:00　#12 Alice：幫我查這個月的外食\n\n## 涵蓋範圍/);
  });
});

// OpenClaw 2026.9 起 session 全在 agents/<id>/agent/openclaw-agent.sqlite。
// 這裡只建汲取會讀的那幾張表、那幾個欄位。
describe("tap.mjs on the SQLite session store", () => {
  let sqliteState;
  let room;

  before(() => {
    sqliteState = join(dir, "sqlite-state");
    const db = seedDatabase(sqliteState, [
      {
        key: `agent:main:telegram:group:${TELEGRAM_CHAT}`,
        events: [
          userEvent("2026-10-01T23:42:02Z", "幫我加 洗澡 上去", { id: 21 }),
          // AI 的回應也收：只收文字，不回話的那種不收
          aiEvent("2026-10-01T23:43:00Z", "好，加上去了"),
          aiEvent("2026-10-01T23:44:00Z", "NO_REPLY"),
        ],
      },
      { key: `agent:main:telegram:group:${OTHER_CHAT}`, events: [userEvent("2026-10-01T15:00:00Z", "別的房間", { id: 99 })] },
    ]);
    // 有一部分 event 是 zstd 壓縮存的，event_json 是 NULL
    db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)").run(
      "s0",
      9,
      null,
      zstdCompressSync(Buffer.from(JSON.stringify(userEvent("2026-10-01T14:03:43Z", "咦？怎麼沒有洗澡？", { id: 20 })))),
    );
    // /new、/reset 換掉的 session：整份 transcript 封存成一塊
    db.prepare("INSERT INTO session_transcript_archives VALUES (?, ?, ?)").run(
      `agent:main:telegram:group:${TELEGRAM_CHAT}`,
      "zstd",
      zstdCompressSync(Buffer.from(`${JSON.stringify(userEvent("2026-09-30T02:00:00Z", "舊的一輪", { id: 19 }))}\n`)),
    );
    db.close();
    mkdirSync(join(sqliteState, "logs"), { recursive: true });
    writeFileSync(
      join(sqliteState, "logs", "chat-interceptor-offstage.log"),
      `2026-10-02 08:00:00 ${JSON.stringify({ kind: "aside", channel: "telegram", target: TELEGRAM_CHAT, senderId: "8", text: "按鈕太小" })}\n`,
      "utf8",
    );
    room = join(dir, "sqlite-room");
    mkdirSync(room, { recursive: true });
  });

  const run = async () =>
    JSON.parse(await tap(["--channel", "telegram", "--target", TELEGRAM_CHAT, "--since", "0", "--format", "json"], { cwd: room, stateDir: sqliteState }));

  it("reads what the AI saw and said from the database, compressed and archived sessions included", async () => {
    const { timeline: entries, coverage } = await run();
    assert.deepEqual(brief(entries), [
      { ts: "2026-09-30 10:00:00", id: 19, sender: "Bob", text: "舊的一輪", kind: null, reply: null },
      { ts: "2026-10-01 22:03:43", id: 20, sender: "Bob", text: "咦？怎麼沒有洗澡？", kind: null, reply: null },
      { ts: "2026-10-02 07:42:02", id: 21, sender: "Bob", text: "幫我加 洗澡 上去", kind: null, reply: null },
      { ts: "2026-10-02 07:43:00", id: null, sender: "AI", text: "好，加上去了", kind: null, reply: null },
      // offstage 那筆只有 senderId：名字是從資料庫裡的發言認出來的
      { ts: "2026-10-02 08:00:00", id: null, sender: "Bob", text: "按鈕太小", kind: "aside", reply: null },
    ]);
    assert.equal(coverage.files.sqliteSessions, 2);
    assert.equal(coverage.files.sqliteMessages, 3);
  });
});

// .tap 的 target 帶著 `user:`、`channel:` 這種種類（送得到的寫法）：汲取照樣認得出是哪一間，舊版記下的裸 id 也算。
describe("tap.mjs with a target that keeps its kind", () => {
  it("reads a Discord DM whichever way its target was written", async () => {
    const dmState = join(dir, "dm-state");
    mkdirSync(join(dmState, "logs"), { recursive: true });
    const line = (at, target, text) =>
      `${at} ${JSON.stringify({ kind: "aside", channel: "discord", target, senderId: "999999999999999999", text })}`;
    writeFileSync(
      join(dmState, "logs", "chat-interceptor-offstage.log"),
      `${line("2026-10-07 20:20:53", "user:999999999999999999", "帶 user: 的")}\n${line("2026-10-07 20:21:00", "999999999999999999", "舊版的裸 id")}\n`,
      "utf8",
    );
    const out = await tap(["--channel", "discord", "--target", "user:999999999999999999", "--since", "0", "--format", "json"], {
      cwd: dir,
      stateDir: dmState,
    });
    assert.deepEqual(JSON.parse(out).timeline.map((entry) => entry.text), ["帶 user: 的", "舊版的裸 id"]);
  });
});

// 平台讀得到歷史（Discord）：以平台為主幹，本機的紀錄只補上平台看不到的那一層。
// 路由跑在這個行程裡（gateway），它叫的假 openclaw 從 FAKE_HISTORY 一頁一頁給。
describe("tap.mjs with the platform's history", () => {
  const JOHN = { id: "999999999999999999", username: "john", global_name: "John" };
  const HELPER = { id: "888888888888888888", username: "Helper", bot: true };
  const SELF = { id: "777777777777777777", username: "Caridina", bot: true };
  let history;
  let historyFile;
  let historyLog;
  let snowflake = 100000000000000000n;

  /** Discord 原樣的訊息物件。 */
  const said = (at, author, content, extra = {}) => ({
    id: String(snowflake++),
    timestamp: new Date(at).toISOString().replace("Z", "000+00:00"),
    author,
    content,
    mentions: [],
    ...extra,
  });
  /** 平台上的歷史，舊的在前寫，存成新的在前。 */
  const seedHistory = (messages) => writeFileSync(historyFile, JSON.stringify([...messages].reverse()), "utf8");
  const reads = () => readJsonLines(historyLog);
  const brief = (entries) => entries.map(({ ts, sender, text, kind, reply }) => ({ ts, sender, text, kind, reply }));
  const discord = ["--channel", "discord", "--target", `channel:${DISCORD_CHAT}`];

  before(async () => {
    const { routes, api } = register();
    api.runtimeConfig = { plugins: { entries: { [PLUGIN_ID]: { config: { fiat: { openclaw: fakeOpenclaw(dir) } } } } } };
    history = await serveRoute(routes["/chat-interceptor/history"]);
    historyFile = join(dir, "history.json");
    historyLog = join(dir, "history.log");
    process.env.FAKE_HISTORY = historyFile;
    process.env.HISTORY_LOG = historyLog;
  });

  after(() => history.close());

  const port = () => new URL(history.url).port;
  const read = (args, stateDir) => runTap([...args, "--format", "json"], { cwd: dir, stateDir, port: port() });

  it("reads a room OpenClaw was never in", async () => {
    seedHistory([
      said("2026-07-10T02:00:00Z", JOHN, `<@${HELPER.id}> 我想做一個熱詞雷達`, { mentions: [HELPER] }),
      said("2026-07-10T02:00:05Z", HELPER, "⏳ Working…"),
      said("2026-07-10T02:01:00Z", HELPER, "可以每天抓各平台的熱搜，整理成一張清單"),
      said("2026-07-10T02:02:00Z", JOHN, "好，就這樣"),
      // 這個 plugin 自己送的：開頭帶記號
      said("2026-10-26T03:00:00Z", SELF, "\u{E0021}fiat: starting Claude Code for radar: /tap."),
    ]);
    const { code, stdout } = await read([...discord, "--since", "0"], join(dir, "never-there"));
    assert.equal(code, 0);
    const { coverage, timeline: entries } = JSON.parse(stdout);
    assert.deepEqual(brief(entries), [
      { ts: "2026-07-10 10:00:00", sender: "John", text: "@Helper 我想做一個熱詞雷達", kind: null, reply: null },
      { ts: "2026-07-10 10:00:05", sender: "Helper（機器人）", text: "⏳ Working…", kind: null, reply: null },
      { ts: "2026-07-10 10:01:00", sender: "Helper（機器人）", text: "可以每天抓各平台的熱搜，整理成一張清單", kind: null, reply: null },
      { ts: "2026-07-10 10:02:00", sender: "John", text: "好，就這樣", kind: null, reply: null },
      { ts: "2026-10-26 11:00:00", sender: "Caridina（機器人）", text: "fiat: starting Claude Code for radar: /tap.", kind: "aside", reply: null },
    ]);
    assert.deepEqual(coverage.platform, { messages: 5, onlyOnPlatform: 5, complete: true });
    assert.equal(coverage.localRecords, false);
    assert.equal(coverage.missing, 0);
  });

  it("pages back until it passes the start", async () => {
    const start = Date.parse("2026-10-01T00:00:00Z");
    const all = Array.from({ length: 150 }, (_, i) => said(start + i * 60_000, JOHN, `第 ${i} 則`));
    seedHistory(all);
    const done = reads().length;
    const { stdout } = await read([...discord, "--since", "2026-10-01 08:30"], join(dir, "never-there"));
    const { coverage, timeline: entries } = JSON.parse(stdout);
    assert.equal(entries.length, 120);
    assert.equal(entries[0].text, "第 30 則");
    const [first, second, third] = reads().slice(done);
    assert.ok(!first.includes("--before"));
    assert.equal(second[second.indexOf("--before") + 1], all[50].id);
    assert.equal(third, undefined);
    assert.equal(coverage.platform.complete, true);
  });

  it("says each message once, with what only the local records know", async () => {
    const stateDir = join(dir, "both-state");
    seedDatabase(stateDir, [
      {
        key: `agent:main:discord:channel:${DISCORD_CHAT}`,
        events: [
          userEvent("2026-10-20T02:00:01Z", "我想做一個熱詞雷達", { sender: { id: JOHN.id, name: "John Lin" }, channel: "discord" }),
          aiEvent("2026-10-20T02:00:30Z", "好的，我來整理"),
          // 這段時間平台上沒有：沒送出去的
          aiEvent("2026-10-20T02:00:40Z", "先查一下資料"),
        ],
      },
    ]).close();
    mkdirSync(join(stateDir, "logs"), { recursive: true });
    const scripted = { kind: "script", channel: "discord", target: `channel:${DISCORD_CHAT}`, senderId: JOHN.id, text: "記一下 熱詞", reply: "ok" };
    writeFileSync(join(stateDir, "logs", "chat-interceptor-offstage.log"), `2026-10-20 10:03:00 ${JSON.stringify(scripted)}\n`, "utf8");
    seedHistory([
      said("2026-10-20T02:00:00Z", JOHN, "我想做一個熱詞雷達"),
      said("2026-10-20T02:00:31Z", SELF, "好的，我來整理"),
      said("2026-10-20T02:02:59Z", JOHN, "記一下 熱詞"),
      said("2026-10-20T02:04:00Z", HELPER, "另一台的話"),
    ]);
    const { coverage, timeline: entries } = JSON.parse((await read([...discord, "--since", "0"], stateDir)).stdout);
    assert.deepEqual(brief(entries), [
      { ts: "2026-10-20 10:00:00", sender: "John", text: "我想做一個熱詞雷達", kind: null, reply: null },
      { ts: "2026-10-20 10:00:31", sender: "Caridina（機器人）", text: "好的，我來整理", kind: null, reply: null },
      { ts: "2026-10-20 10:02:59", sender: "John", text: "記一下 熱詞", kind: "script", reply: "ok" },
      { ts: "2026-10-20 10:04:00", sender: "Helper（機器人）", text: "另一台的話", kind: null, reply: null },
    ]);
    assert.deepEqual(coverage.platform, { messages: 4, onlyOnPlatform: 1, complete: true });
    assert.equal(coverage.localRecords, true);
  });

  it("says it sees nothing when it has no record of the room and the platform will not tell", async () => {
    process.env.FAKE_HISTORY_ERROR = "Telegram history read requires the authenticated current group session.";
    try {
      const args = ["--channel", "telegram", "--target", OTHER_CHAT, "--since", "0"];
      const json = await read(args, join(dir, "never-there"));
      assert.equal(json.code, 3);
      const { warning, coverage } = JSON.parse(json.stdout);
      assert.match(warning, /本機沒有這個房間的任何紀錄/);
      assert.match(coverage.platform.error, /^Error: Telegram history read requires/);
      assert.equal(coverage.missing, null);
      assert.equal(coverage.missingIds, null);

      const md = await runTap(args, { cwd: dir, stateDir: join(dir, "never-there"), port: port() });
      assert.equal(md.code, 3);
      assert.match(md.stdout, /\*\*OpenClaw 本機沒有這個房間的任何紀錄/);
    } finally {
      delete process.env.FAKE_HISTORY_ERROR;
    }
  });

  it("does not count Discord ids for gaps", async () => {
    const stateDir = join(dir, "snowflake-state");
    const sender = { sender: { id: JOHN.id, name: "John" }, channel: "discord" };
    seedDatabase(stateDir, [
      {
        key: `agent:main:discord:channel:${DISCORD_CHAT}`,
        events: [
          userEvent("2026-10-20T02:00:00Z", "一", { ...sender, id: "1500000000000000001" }),
          userEvent("2026-10-20T02:00:01Z", "二", { ...sender, id: "1500000000004194305" }),
        ],
      },
    ]).close();
    // gateway 連不上：只剩本機的紀錄
    const { code, stdout } = await runTap([...discord, "--since", "0"], { cwd: dir, stateDir });
    assert.equal(code, 0);
    assert.match(stdout, /#1500000000000000001 John：一/);
    assert.match(stdout, /"missing": null/);
    assert.match(stdout, /`missing: null` ＝ 看不出缺了哪些/);
  });

  it("only answers programs on this machine", async () => {
    const body = JSON.stringify({ channel: "discord", target: DISCORD_CHAT });
    assert.equal((await fetch(history.url)).status, 405);
    assert.equal((await fetch(history.url, { method: "POST", headers: { "content-type": "text/plain" }, body })).status, 403);
    const crossSite = { "content-type": "application/json", origin: "https://example.com" };
    assert.equal((await fetch(history.url, { method: "POST", headers: crossSite, body })).status, 403);
  });
});
