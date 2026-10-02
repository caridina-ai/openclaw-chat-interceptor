// `/aside` 與 `/fiat`：OpenClaw 的 slash command，不經過攔截 hook。
// ccrun 與 `openclaw message send` 都換成 fixture，所以不需要 Claude Code，也不會送出訊息。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import {
  DISCORD_CHAT,
  OTHER_CHAT,
  PLUGIN_ID,
  READ_STDIN,
  TELEGRAM_CHAT,
  fakeCcrun,
  fakeOpenclaw,
  fixture,
  readJsonLines,
  readOffstage,
  register,
  removeLater,
  samePath,
  seedSkill,
  tempDir,
  waitFor,
} from "./helpers.js";

let dir;
let hook;
let commands;
let CCRUN;
let OPENCLAW;
let ECHO;

before(() => {
  dir = tempDir("chat-interceptor-commands-");
  CCRUN = fakeCcrun(dir);
  OPENCLAW = fakeOpenclaw(dir);
  ECHO = fixture(dir, "echo.mjs", `${READ_STDIN}process.stdout.write("You said " + payload.body);`);
  ({ hook, commands } = register());
});

after(() => removeLater(dir));

/** 指令的 ctx 長得跟 OpenClaw 給的一樣：`to` 帶 provider，設定在整份 config 裡。 */
function commandCtx(args, { config = {}, channel = "telegram", to = `telegram:${TELEGRAM_CHAT}`, ...rest } = {}) {
  return {
    channel,
    to,
    agentId: "main",
    senderId: "7",
    isAuthorizedSender: true,
    args: args || undefined,
    commandBody: args ? `/cmd ${args}` : "/cmd",
    config: { plugins: { entries: { [PLUGIN_ID]: { config } } } },
    ...rest,
  };
}

describe("registration", () => {
  it("registers /aside for everyone and /fiat for authorized senders only", () => {
    assert.equal(commands.aside.requireAuth, false);
    assert.equal(commands.aside.acceptsArgs, true);
    assert.notEqual(commands.fiat.requireAuth, false);
    assert.equal(commands.fiat.acceptsArgs, true);
  });
});

// 留一句話在房間裡，**但誰都不要處理它**：不叫 AI、不跑 script、不回話。
describe("/aside", () => {
  let seq = 0;
  let offstageLogFile;
  beforeEach(() => {
    offstageLogFile = join(dir, `asides-${++seq}.log`);
  });
  const aside = (args, overrides = {}) =>
    commands.aside.handler(commandCtx(args, { config: { offstageLogFile }, ...overrides }));

  it("records the aside and says nothing back", async () => {
    const result = await aside("the keyboard feels slow");
    assert.deepEqual(result, { suppressReply: true });
    const [entry] = readOffstage(offstageLogFile);
    assert.deepEqual(
      { ...entry, ts: undefined },
      { ts: undefined, kind: "aside", channel: "telegram", target: TELEGRAM_CHAT, senderId: "7", text: "the keyboard feels slow" },
    );
  });

  for (const [label, args, text] of [
    ["multiline", "first\n\nsecond", "first\n\nsecond"],
    ["nothing after the keyword", undefined, ""],
    ["padded", "  too slow  ", "too slow"],
  ]) {
    it(`records the ${label} form`, async () => {
      await aside(args);
      assert.equal(readOffstage(offstageLogFile)[0].text, text);
    });
  }

  it("works out the room from the session key when there is no `to`", async () => {
    await aside("hi", { to: "", sessionKey: `agent:main:telegram:group:${OTHER_CHAT}` });
    assert.equal(readOffstage(offstageLogFile)[0].target, OTHER_CHAT);
  });

  it("files a Discord aside under the bare channel id, as the hook sees it", async () => {
    await aside("hi", { channel: "discord", to: `channel:${DISCORD_CHAT}` });
    const [entry] = readOffstage(offstageLogFile);
    assert.equal(entry.channel, "discord");
    assert.equal(entry.target, DISCORD_CHAT);
  });

  it("tells the user when the aside could not be written", async () => {
    // The parent of this path is a regular file, so creating the directory fails.
    const result = await commands.aside.handler(commandCtx("nowhere", { config: { offstageLogFile: join(ECHO[1], "x.log") } }));
    assert.match(result.text, /^aside not recorded: /);
  });
});

describe("/fiat", () => {
  let projects;
  let projectsFile;
  let ccrunLog;
  let notifyLog;
  let installLog;
  let workspace;
  let seq = 0;

  // projectsFile 一定要指到暫存目錄：漏了它，測試就會去寫使用者真正的
  // ~/.openclaw/chat-interceptor-projects.json。
  const settings = (overrides = {}) => ({
    offstageLogFile: join(dir, "offstage-unused.log"),
    fiat: { projectsDir: projects, projectsFile, ccrun: CCRUN, openclaw: OPENCLAW, ...overrides },
  });
  const fiat = (args, { config, ...overrides } = {}) =>
    commands.fiat.handler(commandCtx(args, { config: config ?? settings(), ...overrides }));
  const reply = async (args, overrides) => (await fiat(args, overrides)).text;

  const readIndex = () => (existsSync(projectsFile) ? JSON.parse(readFileSync(projectsFile, "utf8")) : {});
  const entry = () => readIndex()[`telegram:${TELEGRAM_CHAT}`];
  const setEntry = (value) => writeFileSync(projectsFile, JSON.stringify({ [`telegram:${TELEGRAM_CHAT}`]: value }), "utf8");
  const ccrunCalls = (mode) => readJsonLines(ccrunLog).filter((call) => call.mode === mode);

  const seed = (name, body) => {
    const file = join(projects, name, "genesis", ".tap");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
    return file;
  };
  const here = `channel:   telegram\ntarget:    ${TELEGRAM_CHAT}\ntimestamp:\n`;
  /** 一個裝得起來的專案：`<專案>/<專案名>/` 是 skill，裡面有 SKILL.md 與攔截 script。 */
  const seedProject = (name, source = `${READ_STDIN}process.stdout.write("${name} says " + payload.body);`) =>
    seedSkill(join(projects, name), name, source);
  /** 裝進 OpenClaw 的那一份在哪。 */
  const installedDir = (name) => join(workspace, "main", "skills", name);

  /** /fiat 叫起 Claude Code 是背景跑的：等 pid 記進對照表才算叫起來了。 */
  const started = () => waitFor(() => entry()?.pid, "Claude Code to start");

  beforeEach(() => {
    seq += 1;
    projects = mkdtempSync(join(dir, "projects-"));
    projectsFile = join(dir, `projects-${seq}.json`);
    ccrunLog = join(dir, `ccrun-${seq}.log`);
    notifyLog = join(dir, `notify-${seq}.log`);
    installLog = join(dir, `install-${seq}.log`);
    workspace = join(dir, `workspace-${seq}`);
    process.env.CCRUN_LOG = ccrunLog;
    process.env.NOTIFY_LOG = notifyLog;
    process.env.INSTALL_LOG = installLog;
    process.env.FAKE_WORKSPACE = workspace;
    delete process.env.CCRUN_ALIVE;
    delete process.env.CCRUN_FAIL;
    delete process.env.CCRUN_DELAY;
  });

  it("says so when the fiat block is missing", async () => {
    assert.equal(await reply("ledger", { config: {} }), "fiat: add a fiat block to the plugin config first.");
  });

  describe("starting a round", () => {
    it("creates a new project and starts Claude Code there with /tap", async () => {
      const text = await reply("ledger");
      assert.match(text, /^fiat: starting Claude Code for ledger \(new project\): \/tap\. It reports here when the FIAT is ready\.$/);

      const dirOf = join(projects, "ledger");
      assert.equal(readFileSync(join(dirOf, "genesis", ".tap"), "utf8"), here);
      // 頻道位置是敏感資訊，全新的專案順手把擋板放好。
      assert.equal(readFileSync(join(dirOf, ".gitignore"), "utf8"), ".tap\n");

      assert.equal(await started(), 4242);
      const [launch] = ccrunCalls("launch");
      assert.ok(samePath(launch.dir, dirOf), launch.dir);
      assert.equal(launch.prompt, "/tap");
      assert.equal(entry().name, "ledger");
      assert.equal(entry().go, undefined);
    });

    it("hands the session the report program and everything it needs", async () => {
      await reply("ledger");
      await started();
      const [launch] = ccrunCalls("launch");
      assert.ok(existsSync(launch.report), launch.report);
      assert.match(launch.report, /report\.mjs$/);
      const context = JSON.parse(launch.context);
      assert.equal(context.room, `telegram:${TELEGRAM_CHAT}`);
      assert.equal(context.name, "ledger");
      assert.equal(context.projectsFile, projectsFile);
      assert.deepEqual(context.ccrun, CCRUN);
      assert.deepEqual(context.openclaw, OPENCLAW);
      // skill 要裝進這個房間的 agent：OpenClaw 在指令的 ctx 裡給了。
      assert.equal(context.agent, "main");
      assert.equal(entry().agent, "main");
    });

    it("passes a start time straight through to /tap", async () => {
      const text = await reply("ledger -t 2026-09-01 10:00 -go");
      assert.match(text, /\(new project, from 2026-09-01 10:00, -go\): \/tap 2026-09-01 10:00\./);
      await started();
      assert.equal(ccrunCalls("launch")[0].prompt, "/tap 2026-09-01 10:00");
      assert.equal(entry().go, true);
    });

    for (const [args, prompt] of [
      ["ledger -t 2026-09-01", "/tap 2026-09-01"],
      ["-t 2026-09-01 10:00:30 ledger", "/tap 2026-09-01 10:00:30"],
    ]) {
      it(`accepts ${JSON.stringify(args)}`, async () => {
        await reply(args);
        await started();
        assert.equal(ccrunCalls("launch")[0].prompt, prompt);
      });
    }

    it("never writes the start time into .tap", async () => {
      await reply("ledger -t 2026-09-01 10:00");
      await started();
      assert.equal(readFileSync(join(projects, "ledger", "genesis", ".tap"), "utf8"), here);
    });

    it("comes back to the room's project without a name", async () => {
      await reply("ledger");
      await started();
      setEntry({ ...entry(), pid: undefined });
      process.env.CCRUN_PID = "4343";
      try {
        assert.match(await reply(""), /^fiat: starting Claude Code for ledger: \/tap\./);
        assert.equal(await waitFor(() => entry()?.pid === 4343 && 4343, "the second session"), 4343);
      } finally {
        delete process.env.CCRUN_PID;
      }
    });

    it("treats the room's own project name like no name at all", async () => {
      await reply("ledger");
      await started();
      setEntry({ ...entry(), pid: undefined });
      assert.match(await reply("ledger"), /^fiat: starting Claude Code for ledger: \/tap\./);
      await started();
    });

    it("keeps an existing .tap, timestamp and all", async () => {
      const body = `channel: telegram\ntarget: ${TELEGRAM_CHAT}\ntimestamp: 2026-09-01 10:00:00\n`;
      const file = seed("ledger", body);
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      await reply("");
      await started();
      assert.equal(readFileSync(file, "utf8"), body);
    });

    it("adopts an existing project whose .tap already names this room", async () => {
      seed("ledger", here);
      assert.match(await reply("ledger"), /^fiat: starting Claude Code for ledger: /);
      await started();
      assert.equal(entry().name, "ledger");
    });

    it("refuses an existing project that is not this room's", async () => {
      seed("ledger", `channel: telegram\ntarget: ${OTHER_CHAT}\n`);
      assert.equal(
        await reply("ledger"),
        "fiat: ledger already exists and belongs to no room here. To bring it here: /fiat -install ledger.",
      );
      assert.equal(readJsonLines(ccrunLog).length, 0);
    });

    // 換綁定只有一條路：-uninstall 再 -install。
    it("refuses another project while the room belongs to one", async () => {
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      assert.equal(
        await reply("other"),
        "fiat: this room belongs to ledger. To switch: /fiat -uninstall, then /fiat -install other.",
      );
      assert.equal(existsSync(join(projects, "other")), false);
    });

    it("needs a project name the first time", async () => {
      assert.equal(await reply(""), "fiat: this room has no project yet. /fiat <projname> starts one.");
    });

    it("says so when the recorded project is gone", async () => {
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      assert.match(await reply(""), /^fiat: the project recorded for this room is gone: /);
    });

    it("refuses to open a second session while one is open", async () => {
      setEntry({ name: "ledger", dir: join(projects, "ledger"), pid: 4242 });
      process.env.CCRUN_ALIVE = "4242";
      assert.equal(
        await reply(""),
        "fiat: Claude Code is already open for ledger (pid 4242). /fiat -go (or go in Claude Code) to implement, /fiat -done to finish.",
      );
      assert.equal(ccrunCalls("launch").length, 0);
    });

    it("starts afresh when the recorded session is no longer running", async () => {
      mkdirSync(join(projects, "ledger"), { recursive: true });
      setEntry({ name: "ledger", dir: join(projects, "ledger"), pid: 999 });
      assert.match(await reply(""), /^fiat: starting Claude Code for ledger/);
      assert.equal(await waitFor(() => entry()?.pid === 4242 && 4242, "the new session"), 4242);
    });

    it("says so while Claude Code is still starting", async () => {
      process.env.CCRUN_DELAY = "400";
      await reply("ledger");
      assert.equal(await reply(""), "fiat: Claude Code for ledger is still starting.");
      await started();
    });

    it("reports a launch that failed", async () => {
      process.env.CCRUN_FAIL = "claude not found on PATH";
      await reply("ledger");
      const [notify] = await waitFor(() => readJsonLines(notifyLog).length && readJsonLines(notifyLog), "the failure report");
      assert.deepEqual(notify.slice(0, 5), ["--channel", "telegram", "--target", TELEGRAM_CHAT, "--message"]);
      assert.equal(notify[5], "fiat: could not start Claude Code for ledger: claude not found on PATH");
      assert.equal(entry().pid, undefined);
    });

    it("only lets allowFrom accounts start a round", async () => {
      const config = settings({ allowFrom: ["8"] });
      assert.equal(await reply("ledger", { config }), "fiat: this account is not allowed to run fiat here.");
      assert.equal(existsSync(join(projects, "ledger")), false);
    });
  });

  // 只查不做：不叫起、不注入、不改對照表。
  describe("?", () => {
    it("says so when the room has no project", async () => {
      assert.equal(await reply("?"), "project: none");
    });

    it("takes a full-width ？ too, even after a full-width space", async () => {
      assert.equal(await reply("？"), "project: none");
      assert.equal(await reply("　？"), "project: none");
    });

    it("shows the project, what is installed, the session and the timestamp", async () => {
      seed("ledger", `channel:   telegram\ntarget:    ${TELEGRAM_CHAT}\ntimestamp: 2026-10-02 21:45\n`);
      setEntry({ name: "ledger", dir: join(projects, "ledger"), installed: true, skill: "ledger-skill", pid: 4242 });
      process.env.CCRUN_ALIVE = "4242";
      assert.equal(await reply("?"), "project: ledger\ninstalled: ledger-skill\nClaude Code: pid 4242\ntimestamp: 2026-10-02 21:45");
      assert.deepEqual(ccrunCalls("inject"), []);
    });

    it("never starts Claude Code, even for a bound room with no session", async () => {
      seed("ledger", here);
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      assert.equal(await reply("?"), "project: ledger\ninstalled: no\nClaude Code: not running\ntimestamp: none");
      assert.deepEqual(ccrunCalls("launch"), []);
      assert.equal(entry().pid, undefined);
    });

    // 手寫 route 優先於綁定的專案，所以要列；但只列 skill 目錄名，路徑會洩漏機器的目錄結構。
    it("lists a hand-written route by its skill folder only", async () => {
      const script = join(dir, "skills", "my-skill", "scripts", "intercept.js");
      const config = { ...settings(), routes: [{ channel: "telegram", target: TELEGRAM_CHAT, command: ["C:/Program Files/nodejs/node.exe", script] }] };
      assert.equal(await reply("?", { config }), "project: none\nroute: my-skill (openclaw.json)");
    });

    it("takes no arguments", async () => {
      assert.equal(await reply("? ledger"), "fiat: ? takes no arguments.");
    });
  });

  // session 開著的時候，-go 與 -done 就是往它的輸入框打一句 /tap。
  describe("talking to the open session", () => {
    beforeEach(() => {
      mkdirSync(join(projects, "ledger"), { recursive: true });
      setEntry({ name: "ledger", dir: join(projects, "ledger"), pid: 4242 });
      process.env.CCRUN_ALIVE = "4242";
    });

    // -go 永遠是「接下來一路自動做到裝好」：已經開著，就是請它接著做，不另開一個。
    // 不管它正在做什麼都直接打 go：它做完手上這一段，自然會接著做下去。
    for (const args of ["-go", "ledger -go"]) {
      it(`${args} sends go`, async () => {
        assert.equal(await reply(args), "fiat: asked Claude Code to go on and implement the FIAT. It reports here when it is built.");
        assert.deepEqual(ccrunCalls("inject"), [{ mode: "inject", pid: 4242, text: "go" }]);
        assert.equal(ccrunCalls("launch").length, 0);
      });
    }

    it("-go with a start time cannot restart an open round", async () => {
      assert.match(await reply("-t 2026-09-01 -go"), /^fiat: Claude Code is already open for ledger /);
      assert.deepEqual(ccrunCalls("inject"), []);
    });

    it("-done asks it to commit and wrap up", async () => {
      assert.equal(await reply("-done"), "fiat: asked Claude Code to commit and wrap up. It reports here when it is done.");
      assert.deepEqual(ccrunCalls("inject"), [{ mode: "inject", pid: 4242, text: "/tap -done" }]);
    });

    // 關 session 是 gateway 從外面關的：session 自己打 /exit 可能卡在確認對話框。
    describe("closing", () => {
      beforeEach(() => {
        process.env.FIAT_CLOSE_POLL_MS = "20";
        process.env.FIAT_CLOSE_GRACE_MS = "20";
      });

      it("closes the session from outside once the round reports done", async () => {
        await reply("-done");
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.deepEqual(ccrunCalls("quit"), [], "nothing is closed before the report says so");

        setEntry({ ...entry(), closing: true }); // 回報程式在 done 那一段做的事
        await waitFor(() => ccrunCalls("quit").length, "the session to be closed");
        assert.deepEqual(ccrunCalls("quit"), [{ mode: "quit", pid: 4242 }]);
        await waitFor(() => entry().pid === undefined, "the pid to be cleared");
        assert.equal(entry().closing, undefined);
      });

      it("keeps the pid until it is really closed, so a second -done can still find it", async () => {
        setEntry({ ...entry(), closing: true });
        assert.equal(await reply("-done"), "fiat: Claude Code for ledger is closed.");
        assert.deepEqual(ccrunCalls("quit"), [{ mode: "quit", pid: 4242 }]);
        assert.deepEqual(ccrunCalls("inject"), [], "the round already wrapped up; do not ask again");
        assert.equal(entry().pid, undefined);
      });

      it("stops waiting when the room moves on", async () => {
        await reply("-done");
        setEntry({ name: "ledger", dir: join(projects, "ledger"), closing: true }); // pid 被清掉了
        await new Promise((resolve) => setTimeout(resolve, 150));
        assert.deepEqual(ccrunCalls("quit"), []);
      });
    });

    it("-done says so when no session is open, and forgets the stale pid", async () => {
      delete process.env.CCRUN_ALIVE;
      assert.equal(await reply("-done"), "fiat: no Claude Code session is open for ledger.");
      assert.equal(ccrunCalls("inject").length, 0);
      assert.equal(entry().pid, undefined);
    });

    // 連續版：沒有 session 開著時，-go 是「維護舊專案，一路做到裝好」。
    it("-go starts a continuous round when no session is open", async () => {
      delete process.env.CCRUN_ALIVE;
      assert.match(await reply("-go"), /^fiat: starting Claude Code for ledger \(-go\): \/tap\. /);
      await started();
      assert.equal(entry().go, true);
    });
  });

  // 裝上＝`openclaw skills install` 把專案的 skill 複製進這個房間的 agent，route 跑那一份。
  // 上線與下線只動對照表，所以**當場生效**：plugin config 不會 hot reload，
  // 寫進 openclaw.json 的話要重啟 gateway 才算數。
  describe("-install / -uninstall", () => {
    const hookCtx = () => ({
      channelId: "telegram",
      conversationId: TELEGRAM_CHAT,
      sessionKey: `telegram:group:${TELEGRAM_CHAT}`,
      pluginConfig: { ...settings(), routes: [] },
    });
    const say = (body) => hook({ body, channel: "telegram" }, hookCtx());

    // 這是一個真實踩到的 bug 的回歸測試：回話說裝好了，但下一則訊息還是走舊的。
    it("takes effect on the very next message", async () => {
      seed("ledger", here);
      seedProject("ledger");
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      assert.equal(await say("hi"), undefined, "not routed before installing");

      assert.match(await reply("-install"), /^fiat: ledger is installed and live in this room\./);
      assert.equal((await say("hi")).text, "ledger says hi");

      await reply("-uninstall");
      assert.equal(await say("hi"), undefined, "not routed after uninstalling");
    });

    // Windows 上真的發生過：--force 把舊的那份搬走，新的改名失敗、也沒還原，線上那份就沒了。
    it("puts the previous install back when openclaw skills install loses it", async () => {
      seedProject("ledger");
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      await reply("-install");
      process.env.FAKE_INSTALL_EPERM = "1";
      try {
        assert.match(await reply("-install"), /^fiat: openclaw skills install failed: .*EPERM.* The previous install was put back\.$/);
      } finally {
        delete process.env.FAKE_INSTALL_EPERM;
      }
      assert.equal(existsSync(join(installedDir("ledger"), "scripts", "intercept.mjs")), true);
      assert.equal((await say("hi")).text, "ledger says hi");
    });

    it("installs the skill into the room's agent with openclaw skills install", async () => {
      const skill = seedProject("ledger");
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      const text = await reply("-install");
      assert.equal(
        text,
        `fiat: ledger is installed and live in this room.\nruns: ${process.execPath} ${join(installedDir("ledger"), "scripts", "intercept.mjs")}`,
      );
      assert.deepEqual(readJsonLines(installLog), [{ source: skill, agent: "main", force: true }]);
      assert.equal(entry().installed, true);
      assert.equal(entry().skill, "ledger");
      assert.equal(entry().installedDir, installedDir("ledger"));
    });

    // 安裝以後就是上線版：開發目錄再怎麼改，線上都不動，直到再裝一次。
    it("runs the installed copy, not the project folder", async () => {
      const skill = seedProject("ledger");
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      await reply("-install");
      writeFileSync(join(skill, "scripts", "intercept.mjs"), `${READ_STDIN}process.stdout.write("work in progress");`, "utf8");
      assert.equal((await say("hi")).text, "ledger says hi");

      await reply("-install");
      assert.equal((await say("hi")).text, "work in progress");
    });

    it("finds the skill at the project root too", async () => {
      seedSkill(projects, "ledger");
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      assert.match(await reply("-install"), /^fiat: ledger is installed/);
    });

    it("refuses a project that is not a skill yet", async () => {
      seed("ledger", here);
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      assert.match(await reply("-install"), /^fiat: ledger has no skill yet/);
      assert.notEqual(entry().installed, true);
      assert.deepEqual(readJsonLines(installLog), []);
    });

    it("refuses a skill that has no script yet", async () => {
      seedSkill(join(projects, "ledger"), "ledger", null);
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      assert.match(await reply("-install"), /^fiat: ledger has no script yet/);
      assert.deepEqual(readJsonLines(installLog), []);
    });

    it("says so when openclaw skills install fails", async () => {
      seedProject("ledger");
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      const text = await reply("-install", { config: settings({ openclaw: ECHO }) });
      assert.match(text, /^fiat: openclaw skills install failed/);
      assert.notEqual(entry().installed, true);
    });

    it("binds an existing project to a room that has none, and points its .tap here", async () => {
      const file = seed("ledger", `channel: telegram\ntarget: ${OTHER_CHAT}\ntimestamp: 2026-09-01 10:00:00\n`);
      seedProject("ledger");
      const text = await reply("-install ledger");
      assert.match(text, /^fiat: ledger is installed and live in this room\./);
      assert.match(text, /now points at this room\.$/);
      assert.equal(entry().name, "ledger");
      assert.equal(
        readFileSync(file, "utf8"),
        `channel:   telegram\ntarget:    ${TELEGRAM_CHAT}\ntimestamp: 2026-09-01 10:00:00\n`,
      );
    });

    it("writes a .tap for a project that never had one", async () => {
      seedProject("ledger");
      await reply("-install ledger");
      assert.equal(readFileSync(join(projects, "ledger", "genesis", ".tap"), "utf8"), here);
    });

    it("refuses to install another project over this room's", async () => {
      seedProject("other");
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      assert.equal(await reply("-install other"), "fiat: this room belongs to ledger. /fiat -uninstall first.");
    });

    it("needs a name in a room with no project", async () => {
      assert.equal(await reply("-install"), "fiat: this room has no project. /fiat -install <projname> binds one.");
    });

    it("refuses a project that does not exist", async () => {
      assert.match(await reply("-install ghost"), /^fiat: .*ghost does not exist\.$/);
    });

    it("never starts Claude Code", async () => {
      seedProject("ledger");
      await reply("-install ledger");
      assert.equal(readJsonLines(ccrunLog).length, 0);
    });

    // 舊版裝的（沒有 installedDir）不算數：那是直接跑開發目錄的，目錄一搬走整個房間就開始報錯。
    it("ignores an entry that never went through openclaw skills install", async () => {
      setEntry({ name: "ledger", dir: join(projects, "ledger"), installed: true });
      assert.equal(await say("hi"), undefined);
    });

    it("uninstalls: the route goes, the installed skill goes, the project stays", async () => {
      const skill = seedProject("ledger");
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      await reply("-install");
      assert.ok(existsSync(installedDir("ledger")));
      assert.equal(
        await reply("-uninstall"),
        `fiat: this room no longer belongs to ledger. The ledger skill was removed from OpenClaw (${installedDir("ledger")}). Its project files are untouched.`,
      );
      assert.deepEqual(readIndex(), {});
      assert.equal(existsSync(installedDir("ledger")), false);
      assert.ok(existsSync(join(skill, "scripts", "intercept.mjs")));
    });

    it("never removes anything that is not an installed skill folder", async () => {
      const elsewhere = join(projects, "not-a-skills-folder");
      mkdirSync(elsewhere, { recursive: true });
      setEntry({ name: "ledger", dir: join(projects, "ledger"), installed: true, installedDir: elsewhere });
      assert.match(await reply("-uninstall"), /Remove .*not-a-skills-folder yourself\./);
      assert.ok(existsSync(elsewhere));
    });

    it("mentions a session that is still open", async () => {
      setEntry({ name: "ledger", dir: join(projects, "ledger"), pid: 4242 });
      process.env.CCRUN_ALIVE = "4242";
      assert.match(await reply("-uninstall"), /Its Claude Code session \(pid 4242\) is still open\.$/);
    });

    it("lets the room take another project afterwards", async () => {
      setEntry({ name: "ledger", dir: join(projects, "ledger") });
      await reply("-uninstall");
      assert.match(await reply("other"), /^fiat: starting Claude Code for other \(new project\)/);
      await started();
    });

    it("says so when there is nothing to uninstall", async () => {
      assert.equal(await reply("-uninstall"), "fiat: this room has no project and no route.");
    });

    // 設定裡人手寫的 route 不歸它管，但不能讓使用者以為拆乾淨了。
    it("warns about a hand-written route it cannot remove", async () => {
      const config = { ...settings(), routes: [{ name: "by-hand", channel: "telegram", target: TELEGRAM_CHAT, command: ECHO }] };
      const text = await reply("-uninstall", { config });
      assert.match(text, /openclaw\.json still has a route for this room \(by-hand\)/);
      assert.match(text, /restart the gateway/);
    });
  });

  describe("arguments", () => {
    for (const [args, expected] of [
      ["-rf", /^fiat: unknown option "-rf"\. Use \/fiat /],
      ["-install -go", /^fiat: -install takes nothing but a project name\.$/],
      ["-done now", /^fiat: -done takes no arguments\.$/],
      ["-uninstall -go", /^fiat: -uninstall takes no arguments\.$/],
      ["-install -done", /^fiat: unknown option "-done"/],
      ["ledger other", /^fiat: unexpected "other"\./],
      ["-t", /^fiat: -t needs a start: -t yyyy-mm-dd HH:MM$/],
      ["ledger -t 2026-9-1", /^fiat: -t needs a start/],
      // 起點一定要 -t；忘了的時候（常常會）直接給出補好的那一句。
      ["2026-09-01", /^fiat: a start time needs -t\. Did you mean: \/fiat -t 2026-09-01$/],
      ["ledger 2026-09-28 -go", /^fiat: a start time needs -t\. Did you mean: \/fiat ledger -t 2026-09-28 -go$/],
      ["ledger 2026-09-28 10:00", /^fiat: a start time needs -t\. Did you mean: \/fiat ledger -t 2026-09-28 10:00$/],
    ]) {
      it(`refuses ${JSON.stringify(args)}`, async () => {
        assert.match(await reply(args), expected);
        assert.equal(readJsonLines(ccrunLog).length, 0);
        assert.equal(existsSync(join(projects, "2026-09-01")), false);
      });
    }

    for (const name of ["../evil", "a/b", "a\\b", ".hidden", "_x"]) {
      it(`refuses ${JSON.stringify(name)} as a project name`, async () => {
        assert.match(await reply(name), /is not a usable project name/);
      });
    }
  });
});
