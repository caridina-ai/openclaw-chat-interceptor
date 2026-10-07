// 回報程式：/tap 每一段的最後，AI 在專案根目錄用 node 跑它（skills/tap/report.mjs）。
// 這裡也照那樣跑：一支子行程，cwd 是專案，房間從專案的 .tap 認，gateway 的 port 從
// OPENCLAW_GATEWAY_PORT 拿——它 POST 的對象是 plugin 註冊的那條 HTTP 路由，掛在本機的隨機 port 上。
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  OTHER_CHAT,
  PLUGIN_ID,
  TELEGRAM_CHAT,
  fakeOpenclaw,
  fakeRunner,
  readJsonLines,
  register,
  removeLater,
  seedSkill,
  serveRoute,
  tempDir,
  waitFor,
} from "./helpers.js";

const REPORT = fileURLToPath(new URL("../skills/tap/report.mjs", import.meta.url));
const KEY = `telegram:${TELEGRAM_CHAT}`;

let dir;
let CCRUN;
let CDRUN;
let OPENCLAW;
let api;
let server;
let project;
let projectsFile;
let runnerLog;
let workspace;
let notifyLog;
let seq = 0;

before(async () => {
  dir = tempDir("chat-interceptor-report-");
  CCRUN = fakeRunner(dir, "ccrun");
  CDRUN = fakeRunner(dir, "cdrun");
  OPENCLAW = fakeOpenclaw(dir);
  let routes;
  ({ routes, api } = register());
  server = await serveRoute(routes["/chat-interceptor/report"]);
  process.env.RUNNER_ALIVE = "4242";
  process.env.FIAT_CLOSE_GRACE_MS = "20";
});

after(async () => {
  await server.close();
  await removeLater(dir);
});

beforeEach(() => {
  seq += 1;
  project = mkdtempSync(join(dir, "ledger-"));
  projectsFile = join(dir, `projects-${seq}.json`);
  runnerLog = join(dir, `runner-${seq}.log`);
  notifyLog = join(dir, `notify-${seq}.log`);
  workspace = join(dir, `workspace-${seq}`);
  mkdirSync(join(project, "genesis"), { recursive: true });
  writeFileSync(join(project, "genesis", ".tap"), `channel:   telegram\ntarget:    ${TELEGRAM_CHAT}\ntimestamp:\n`, "utf8");
  // 路由跑在 gateway 裡：它叫的假 runner 與假 openclaw 吃的是這個行程的環境變數。
  process.env.RUNNER_LOG = runnerLog;
  process.env.NOTIFY_LOG = notifyLog;
  process.env.FAKE_WORKSPACE = workspace;
  api.runtimeConfig = {
    plugins: { entries: { [PLUGIN_ID]: { config: { fiat: { projectsDir: dir, projectsFile, ccrun: CCRUN, cdrun: CDRUN, openclaw: OPENCLAW } } } } },
  };
});

const port = () => new URL(server.url).port;

function report(args, { cwd = project, env = {}, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [REPORT, ...args],
      { cwd, encoding: "utf8", env: { ...process.env, OPENCLAW_GATEWAY_PORT: port(), ...env } },
      (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout: stdout.trim(), stderr: stderr.trim() }),
    );
    child.stdin.end(input ?? "");
  });
}

const readIndex = () => (existsSync(projectsFile) ? JSON.parse(readFileSync(projectsFile, "utf8")) : {});
const entry = () => readIndex()[KEY];
/** 一輪開著的 session：房間綁著這個專案，叫起它的 harness 與 pid 都記著。 */
const setEntry = (value) =>
  writeFileSync(projectsFile, JSON.stringify({ [KEY]: { name: "ledger", dir: project, harness: "claude", pid: 4242, ...value } }), "utf8");
const messages = () => readJsonLines(notifyLog).map((argv) => argv[5]);
const calls = (mode) => readJsonLines(runnerLog).filter((call) => call.mode === mode);
/** 專案裡的 skill：`<專案>/ledger/SKILL.md` 與 `scripts/intercept.mjs`。 */
const seedScript = () => seedSkill(project, "ledger");

it("does nothing outside a /fiat project", async () => {
  rmSync(join(project, "genesis", ".tap"));
  const result = await report(["fiat", "hello"]);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /not a \/fiat project/);
  assert.deepEqual(messages(), []);
});

it("refuses an unknown stage", async () => {
  const result = await report(["finished", "hello"]);
  assert.equal(result.code, 2);
  assert.match(result.stderr, /usage: node report\.mjs <fiat\|built\|done>/);
});

it("posts into the room the project's .tap names", async () => {
  setEntry();
  await report(["fiat", "FIAT-x.md"]);
  const [argv] = readJsonLines(notifyLog);
  assert.deepEqual(argv.slice(0, 5), ["--channel", "telegram", "--target", TELEGRAM_CHAT, "--message"]);
});

it("reads the message from stdin when it is -", async () => {
  setEntry();
  await report(["fiat", "-"], { input: "line one\nline two\n" });
  assert.match(messages()[0], /\nline one\nline two\n/);
});

it("finds the gateway port in the OpenClaw config when the environment does not say", async () => {
  setEntry();
  const state = join(dir, `state-${seq}`);
  mkdirSync(state);
  writeFileSync(join(state, "openclaw.json"), JSON.stringify({ gateway: { port: Number(port()) } }), "utf8");
  const result = await report(["fiat", "x"], { env: { OPENCLAW_GATEWAY_PORT: "", OPENCLAW_STATE_DIR: state } });
  assert.equal(result.stdout, "reported to the room.");
});

it("says so when the gateway cannot be reached", async () => {
  const result = await report(["fiat", "x"], { env: { OPENCLAW_GATEWAY_PORT: "9", FIAT_REPORT_WAIT_MS: "0" } });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^cannot reach the OpenClaw gateway at http:\/\/127\.0\.0\.1:9\//);
});

it("only takes JSON POSTs from local programs", async () => {
  assert.equal((await fetch(server.url)).status, 405);
  const json = { "content-type": "application/json" };
  const body = JSON.stringify({ room: { channel: "telegram", target: TELEGRAM_CHAT }, dir: project, stage: "fiat", message: "x" });
  setEntry();
  // 網頁跨站送來的：不帶 JSON 的 content-type（才不必 preflight），或帶著 Origin。
  assert.equal((await fetch(server.url, { method: "POST", headers: { "content-type": "text/plain" }, body })).status, 403);
  assert.equal((await fetch(server.url, { method: "POST", headers: { ...json, origin: "https://example.com" }, body })).status, 403);
  assert.deepEqual(messages(), []);
});

describe("fiat", () => {
  it("reports and waits for the author to read it", async () => {
    setEntry();
    const result = await report(["fiat", "genesis/FIAT-x.md: 我想要一個 x"]);
    assert.equal(result.stdout, "reported to the room.");
    assert.deepEqual(messages(), ["ledger: FIAT ready\ngenesis/FIAT-x.md: 我想要一個 x\nRead it, then /fiat -go to implement."]);
    assert.deepEqual(calls("inject"), []);
  });

  // 連續版：FIAT 文件一寫好就注入 go。用過就消掉，重複回報也不會實作兩次。
  it("sends go in a continuous round, once", async () => {
    setEntry({ go: true });
    await report(["fiat", "FIAT-x.md"]);
    assert.match(messages()[0], /\nImplementing it now \(-go\)\.$/);
    assert.deepEqual(calls("inject"), [{ runner: "ccrun", mode: "inject", pid: 4242, text: "go" }]);
    assert.equal(entry().go, undefined);

    await report(["fiat", "FIAT-x.md"]);
    assert.equal(calls("inject").length, 1);
  });

  it("sends go through the runner that started the session", async () => {
    setEntry({ harness: "codex", go: true });
    await report(["fiat", "FIAT-x.md"]);
    assert.deepEqual(calls("inject"), [{ runner: "cdrun", mode: "inject", pid: 4242, text: "go" }]);
  });
});

describe("built", () => {
  it("installs the project into the room, then reports", async () => {
    seedScript();
    setEntry({ agent: "main" });
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
    setEntry();
    const result = await report(["built", "還沒有 skill"]);
    assert.notEqual(entry().installed, true);
    assert.match(messages()[0], /\nnot installed: .* has no skill yet/);
    assert.match(result.stdout, /^not installed: .* has no skill yet/);
  });

  it("is the same in a continuous round", async () => {
    seedScript();
    setEntry({ go: true });
    await report(["built", "done"]);
    assert.equal(entry().installed, true);
    assert.deepEqual(calls("inject"), []);
  });
});

describe("done", () => {
  it("moves the timestamp, reports, and closes the session from outside", async () => {
    setEntry({ installed: true });
    const result = await report(["done", "commit abc123"]);
    const tap = readFileSync(join(project, "genesis", ".tap"), "utf8");
    const stamp = /^timestamp: (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})$/m.exec(tap)?.[1];
    assert.ok(stamp, tap);
    assert.equal(tap, `channel:   telegram\ntarget:    ${TELEGRAM_CHAT}\ntimestamp: ${stamp}\n`);
    assert.deepEqual(messages(), [`ledger: done\ncommit abc123\ntimestamp: ${stamp}. Closing Claude Code.`]);
    assert.match(result.stdout, /this session will be closed shortly\.$/);

    // 關它的是 gateway，等它把這一輪講完；關掉之前 pid 一直留著，那是關它的把手。
    await waitFor(() => calls("quit").length, "the session to be closed");
    assert.deepEqual(calls("quit"), [{ runner: "ccrun", mode: "quit", pid: 4242 }]);
    await waitFor(() => entry().pid === undefined, "the session to be forgotten");
    assert.deepEqual(entry(), { name: "ledger", dir: project, installed: true });
  });

  it("closes a Codex session with cdrun", async () => {
    setEntry({ harness: "codex" });
    await report(["done", "x"]);
    assert.match(messages()[0], /\. Closing Codex\.$/);
    await waitFor(() => calls("quit").length, "the session to be closed");
    assert.deepEqual(calls("quit"), [{ runner: "cdrun", mode: "quit", pid: 4242 }]);
  });

  it("closes the session only once when done is reported twice", async () => {
    setEntry();
    await Promise.all([report(["done", "x"]), report(["done", "x"])]);
    await waitFor(() => entry().pid === undefined, "the session to be closed");
    assert.equal(calls("quit").length, 1);
  });
});

// session 開著的時候房間可能已經被 -uninstall、換綁了別的專案，或那一輪已經結束。
// 那就什麼都不做，只告訴它。
describe("a room that moved on", () => {
  for (const [label, seed] of [
    ["uninstalled", () => {}],
    ["bound to another project", () => setEntry({ dir: join(dir, "other"), go: true })],
    ["no longer running a session", () => setEntry({ pid: undefined, go: true })],
  ]) {
    it(`does nothing when the room was ${label}`, async () => {
      seedScript();
      seed();
      const result = await report(["built", "x"]);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /No \/fiat round is open/);
      await report(["fiat", "x"]);
      assert.deepEqual(messages(), []);
      assert.notEqual(entry()?.installed, true);
      assert.deepEqual(calls("inject"), []);
    });
  }

  it("reports to the room in .tap, which /fiat keeps pointing at the bound room", async () => {
    writeFileSync(join(project, "genesis", ".tap"), `channel: telegram\ntarget: ${OTHER_CHAT}\n`, "utf8");
    setEntry();
    const result = await report(["fiat", "x"]);
    assert.match(result.stdout, /No \/fiat round is open/);
    assert.deepEqual(messages(), []);
  });
});
