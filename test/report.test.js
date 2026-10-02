// 回報程式：Claude Code 在 /tap 每一段的最後，用 node 直接跑它。
// 這裡也照那樣跑：一支子行程，環境變數 FIAT_CONTEXT 是 /fiat 叫起 session 時給的那份。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import { OTHER_CHAT, TELEGRAM_CHAT, fakeCcrun, fakeOpenclaw, readJsonLines, removeLater, seedSkill, tempDir } from "./helpers.js";

const REPORT = fileURLToPath(new URL("../src/report.mjs", import.meta.url));
const KEY = `telegram:${TELEGRAM_CHAT}`;

let dir;
let CCRUN;
let OPENCLAW;
let project;
let projectsFile;
let ccrunLog;
let workspace;
let notifyLog;
let seq = 0;

before(() => {
  dir = tempDir("chat-interceptor-report-");
  CCRUN = fakeCcrun(dir);
  OPENCLAW = fakeOpenclaw(dir);
});

after(() => removeLater(dir));

beforeEach(() => {
  seq += 1;
  project = mkdtempSync(join(dir, "ledger-"));
  projectsFile = join(dir, `projects-${seq}.json`);
  ccrunLog = join(dir, `ccrun-${seq}.log`);
  notifyLog = join(dir, `notify-${seq}.log`);
  workspace = join(dir, `workspace-${seq}`);
  mkdirSync(join(project, "genesis"), { recursive: true });
  writeFileSync(join(project, "genesis", ".tap"), `channel:   telegram\ntarget:    ${TELEGRAM_CHAT}\ntimestamp:\n`, "utf8");
});

const context = (overrides = {}) =>
  JSON.stringify({
    room: KEY,
    name: "ledger",
    dir: project,
    projectsFile,
    ccrun: CCRUN,
    openclaw: OPENCLAW,
    agent: "main",
    ...overrides,
  });

function report(args, { env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [REPORT, ...args],
      {
        encoding: "utf8",
        env: { ...process.env, FIAT_CONTEXT: context(), CCRUN_LOG: ccrunLog, CCRUN_ALIVE: "4242", NOTIFY_LOG: notifyLog, FAKE_WORKSPACE: workspace, ...env },
      },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout: stdout.trim(), stderr: stderr.trim() }),
    );
    child.stdin.end(input ?? "");
  });
}

const readIndex = () => (existsSync(projectsFile) ? JSON.parse(readFileSync(projectsFile, "utf8")) : {});
const entry = () => readIndex()[KEY];
const setEntry = (value) => writeFileSync(projectsFile, JSON.stringify({ [KEY]: value }), "utf8");
const messages = () => readJsonLines(notifyLog).map((argv) => argv[5]);
const injected = () => readJsonLines(ccrunLog).map((call) => call.text);
/** 專案裡的 skill：`<專案>/ledger/SKILL.md` 與 `scripts/intercept.mjs`。 */
const seedScript = () => seedSkill(project, "ledger");

it("does nothing outside a session started by /fiat", async () => {
  const result = await report(["fiat", "hello"], { env: { FIAT_CONTEXT: "" } });
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not started by \/fiat/);
  assert.deepEqual(messages(), []);
});

it("refuses an unknown stage", async () => {
  const result = await report(["finished", "hello"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage: node report\.mjs <fiat\|built\|done>/);
});

it("posts into the room the session belongs to", async () => {
  setEntry({ name: "ledger", dir: project, pid: 4242 });
  await report(["fiat", "FIAT-x.md"]);
  const [argv] = readJsonLines(notifyLog);
  assert.deepEqual(argv.slice(0, 5), ["--channel", "telegram", "--target", TELEGRAM_CHAT, "--message"]);
});

it("reads the message from stdin when it is -", async () => {
  setEntry({ name: "ledger", dir: project, pid: 4242 });
  await report(["fiat", "-"], { input: "line one\nline two\n" });
  assert.match(messages()[0], /\nline one\nline two\n/);
});

describe("fiat", () => {
  it("reports and waits for the author to read it", async () => {
    setEntry({ name: "ledger", dir: project, pid: 4242 });
    const result = await report(["fiat", "genesis/FIAT-x.md: 我想要一個 x"]);
    assert.equal(result.stdout, "reported to the room.");
    assert.deepEqual(messages(), ["ledger: FIAT ready\ngenesis/FIAT-x.md: 我想要一個 x\nRead it, then /fiat -go (or go in Claude Code) to implement."]);
    assert.deepEqual(injected(), []);
  });

  // 連續版：FIAT 文件一寫好就注入 go。用過就消掉，重複回報也不會實作兩次。
  it("sends go in a continuous round, once", async () => {
    setEntry({ name: "ledger", dir: project, pid: 4242, go: true });
    await report(["fiat", "FIAT-x.md"]);
    assert.match(messages()[0], /\nImplementing it now \(-go\)\.$/);
    assert.deepEqual(injected(), ["go"]);
    assert.equal(entry().go, undefined);

    await report(["fiat", "FIAT-x.md"]);
    assert.deepEqual(injected(), ["go"]);
  });
});

describe("built", () => {
  it("installs the project into the room, then reports", async () => {
    seedScript();
    setEntry({ name: "ledger", dir: project, pid: 4242 });
    const result = await report(["built", "兩條規則"]);
    assert.equal(result.stdout, "installed; reported to the room.");
    // 裝進 OpenClaw 的是一份複製，route 跑的是那一份。
    assert.equal(entry().installed, true);
    assert.equal(entry().skill, "ledger");
    assert.equal(entry().installedDir, join(workspace, "main", "skills", "ledger"));
    assert.ok(existsSync(join(entry().installedDir, "scripts", "intercept.mjs")));
    assert.deepEqual(messages(), ["ledger: built\n兩條規則\nInstalled ledger: live in this room now. Test it here, then /fiat -done."]);
  });

  it("says why it could not install", async () => {
    setEntry({ name: "ledger", dir: project, pid: 4242 });
    const result = await report(["built", "還沒有 skill"]);
    assert.notEqual(entry().installed, true);
    assert.match(messages()[0], /\nnot installed: .* has no skill yet/);
    assert.match(result.stdout, /^not installed: .* has no skill yet/);
  });

  it("is the same in a continuous round", async () => {
    seedScript();
    setEntry({ name: "ledger", dir: project, pid: 4242, go: true });
    await report(["built", "done"]);
    assert.equal(entry().installed, true);
    assert.deepEqual(injected(), []);
  });
});

describe("done", () => {
  it("moves the timestamp, reports, and marks the session ready to close", async () => {
    setEntry({ name: "ledger", dir: project, pid: 4242, installed: true });
    const result = await report(["done", "commit abc123"]);
    const tap = readFileSync(join(project, "genesis", ".tap"), "utf8");
    const stamp = /^timestamp: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/m.exec(tap)?.[1];
    assert.ok(stamp, tap);
    assert.equal(tap, `channel:   telegram\ntarget:    ${TELEGRAM_CHAT}\ntimestamp: ${stamp}\n`);
    assert.deepEqual(messages(), [`ledger: done\ncommit abc123\ntimestamp: ${stamp}. Closing Claude Code.`]);
    // pid 留著：那是 gateway 從外面關它的把手。
    assert.deepEqual(entry(), { name: "ledger", dir: project, pid: 4242, installed: true, closing: true });
    assert.match(result.stdout, /this session will be closed shortly\.$/);
  });

  // 從 session 裡面只能打 /exit，而 /exit 可能卡在確認對話框。關 session 是 gateway 的事。
  it("never tries to close its own session", async () => {
    setEntry({ name: "ledger", dir: project, pid: 4242 });
    await report(["done", "x"]);
    await report(["done", "x"]);
    assert.deepEqual(readJsonLines(ccrunLog), []);
  });
});

// session 開著的時候房間可能已經被 -uninstall、或換綁了別的專案。
// 那就只回報，不再替那個房間做任何決定。
describe("a room that moved on", () => {
  for (const [label, value] of [
    ["uninstalled", null],
    ["bound to another project", { name: "other", dir: project, pid: 4242, go: true }],
  ]) {
    it(`only reports when the room was ${label}`, async () => {
      seedScript();
      if (value) setEntry(value);
      await report(["built", "x"]);
      await report(["fiat", "x"]);
      assert.equal(messages().length, 2);
      assert.notEqual(entry()?.installed, true);
      assert.deepEqual(injected(), []);
    });
  }

  it("reports to the room it was started from, not the one in .tap", async () => {
    writeFileSync(join(project, "genesis", ".tap"), `channel: telegram\ntarget: ${OTHER_CHAT}\n`, "utf8");
    setEntry({ name: "ledger", dir: project, pid: 4242 });
    await report(["fiat", "x"]);
    assert.equal(readJsonLines(notifyLog)[0][3], TELEGRAM_CHAT);
  });
});
