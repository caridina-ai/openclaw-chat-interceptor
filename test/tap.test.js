// tap.mjs：把 session 檔（AI 看到的）與 offstage log（AI 沒看到的）合成一條時間軸。
// 這裡在暫存目錄搭一個假的 OpenClaw 狀態目錄，裡面只有汲取會讀的那幾個檔。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, describe, it } from "node:test";
import { OTHER_CHAT, TELEGRAM_CHAT, removeLater, tempDir } from "./helpers.js";

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

function tap(args = []) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [TAP, ...args],
      { cwd: project, encoding: "utf8", env: { ...process.env, OPENCLAW_STATE_DIR: state, TZ: "Asia/Taipei" } },
      (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout)),
    );
  });
}

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

  const userEvent = (id, at, text, sender = { id: "8", name: "Bob" }) =>
    JSON.stringify({
      type: "message",
      timestamp: at,
      message: {
        role: "user",
        content: text,
        timestamp: Date.parse(at),
        __openclaw: { senderId: sender.id, senderName: sender.name, transport: { channel: "telegram", messageId: String(id) } },
      },
    });

  before(() => {
    sqliteState = join(dir, "sqlite-state");
    const agentDir = join(sqliteState, "agents", "main", "agent");
    mkdirSync(agentDir, { recursive: true });
    const db = new DatabaseSync(join(agentDir, "openclaw-agent.sqlite"));
    db.exec(`
      CREATE TABLE session_windows (session_id TEXT, session_key TEXT);
      CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB);
      CREATE TABLE session_transcript_archives (session_key TEXT, encoding TEXT, archive_blob BLOB);
    `);
    db.prepare("INSERT INTO session_windows VALUES (?, ?)").run("s1", `agent:main:telegram:group:${TELEGRAM_CHAT}`);
    db.prepare("INSERT INTO session_windows VALUES (?, ?)").run("s2", `agent:main:telegram:group:${OTHER_CHAT}`);
    const event = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)");
    event.run("s1", 1, userEvent(21, "2026-10-01T23:42:02Z", "幫我加 洗澡 上去"), null);
    // 有一部分 event 是 zstd 壓縮存的，event_json 是 NULL
    event.run("s1", 2, null, zstdCompressSync(Buffer.from(userEvent(20, "2026-10-01T14:03:43Z", "咦？怎麼沒有洗澡？"))));
    event.run("s1", 3, JSON.stringify({ type: "message", message: { role: "assistant", content: "好", timestamp: 0 } }), null);
    event.run("s2", 1, userEvent(99, "2026-10-01T15:00:00Z", "別的房間"), null);
    // /new、/reset 換掉的 session：整份 transcript 封存成一塊
    db.prepare("INSERT INTO session_transcript_archives VALUES (?, ?, ?)").run(
      `agent:main:telegram:group:${TELEGRAM_CHAT}`,
      "zstd",
      zstdCompressSync(Buffer.from(`${userEvent(19, "2026-09-30T02:00:00Z", "舊的一輪")}\n`)),
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

  const run = () =>
    new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [TAP, "--channel", "telegram", "--target", TELEGRAM_CHAT, "--since", "0", "--format", "json"],
        { cwd: room, encoding: "utf8", env: { ...process.env, OPENCLAW_STATE_DIR: sqliteState, TZ: "Asia/Taipei" } },
        (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(JSON.parse(stdout))),
      );
    });

  it("reads what the AI saw from the database, compressed and archived sessions included", async () => {
    const { timeline: entries, coverage } = await run();
    assert.deepEqual(brief(entries), [
      { ts: "2026-09-30 10:00:00", id: 19, sender: "Bob", text: "舊的一輪", kind: null, reply: null },
      { ts: "2026-10-01 22:03:43", id: 20, sender: "Bob", text: "咦？怎麼沒有洗澡？", kind: null, reply: null },
      { ts: "2026-10-02 07:42:02", id: 21, sender: "Bob", text: "幫我加 洗澡 上去", kind: null, reply: null },
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
    const out = await new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [TAP, "--channel", "discord", "--target", "user:999999999999999999", "--since", "0", "--format", "json"],
        { cwd: dir, encoding: "utf8", env: { ...process.env, OPENCLAW_STATE_DIR: dmState, TZ: "Asia/Taipei" } },
        (error, stdout, stderr) => (error ? reject(new Error(stderr || error.message)) : resolve(stdout)),
      );
    });
    assert.deepEqual(JSON.parse(out).timeline.map((entry) => entry.text), ["帶 user: 的", "舊版的裸 id"]);
  });
});
