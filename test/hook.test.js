// Router tests. No gateway, no network, no user-supplied scripts:
// every route here runs a throwaway fixture written into a temp directory.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import entry from "../src/index.js";

const TELEGRAM_CHAT = "-1001234567890";
const DISCORD_CHAT = "123456789012345678";
const OTHER_CHAT = "-1009876543210";

let dir;
let hook;

/** Writes a fixture script and returns the argv that runs it. */
function fixture(name, source) {
  const file = join(dir, name);
  writeFileSync(file, source, "utf8");
  return [process.execPath, file];
}

const READ_STDIN = `
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw.replace(/^\\uFEFF/, "").trim() || "{}");
`;

let ECHO;
let DECLINE;
let FAIL;
let SILENT;
let COUNTER;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "chat-interceptor-"));

  ECHO = fixture("echo.mjs", `${READ_STDIN}process.stdout.write("You said " + payload.body);`);
  DECLINE = fixture("decline.mjs", `${READ_STDIN}process.exit(20);`);
  FAIL = fixture("fail.mjs", `${READ_STDIN}process.stderr.write("boom"); process.exit(3);`);
  SILENT = fixture("silent.mjs", `${READ_STDIN}process.exit(0);`);
  // Read-modify-write with a gap in the middle: races would produce duplicates.
  COUNTER = fixture(
    "counter.mjs",
    `${READ_STDIN}
    const fs = await import("node:fs");
    const f = process.env.COUNTER_FILE;
    const n = Number(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "0") + 1;
    await new Promise((r) => setTimeout(r, 25));
    fs.writeFileSync(f, String(n), "utf8");
    process.stdout.write(String(n));`,
  );

  entry.register({
    pluginConfig: {},
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler) {
      if (name === "before_agent_reply") hook = handler;
    },
  });
  assert.ok(hook, "before_agent_reply handler was not registered");
});

// /tap 的測試會在這底下開子行程，而 Windows 要等行程真的收掉才放開它的 cwd。
// 等一下再刪；真的刪不掉也不算測試失敗，那只是一個暫存目錄。
after(async () => {
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 100 });
  } catch {
    // 留著就留著
  }
});

function ctx(overrides = {}) {
  // `{ routes: undefined }` has to mean "explicitly unset", not "use the default".
  const explicitRoutes = Object.hasOwn(overrides, "routes");
  const { routes, config, ...rest } = overrides;
  return {
    channel: "telegram",
    messageProvider: "telegram",
    chatId: TELEGRAM_CHAT,
    channelId: TELEGRAM_CHAT,
    agentId: "test-agent",
    sessionKey: `telegram:group:${TELEGRAM_CHAT}`,
    ...rest,
    pluginConfig: {
      routes: explicitRoutes
        ? routes
        : [{ name: "echo", channel: "telegram", target: TELEGRAM_CHAT, command: ECHO }],
      ...config,
    },
  };
}

const send = (body, overrides) => hook({ cleanedBody: body }, ctx(overrides));

describe("route selection", () => {
  it("passes the turn to the AI when no route matches", async () => {
    const other = { chatId: OTHER_CHAT, channelId: OTHER_CHAT, sessionKey: `telegram:group:${OTHER_CHAT}` };
    assert.equal(await send("hello", other), undefined);
  });

  it("does not match a route bound to another channel", async () => {
    assert.equal(await send("hello", { channel: "discord", messageProvider: "discord" }), undefined);
  });

  it("intercepts nothing when routes are unset", async () => {
    assert.equal(await send("hello", { routes: undefined }), undefined);
  });

  it("skips routes missing target or command", async () => {
    const routes = [
      { name: "no-target", channel: "telegram", command: ECHO },
      { name: "no-command", channel: "telegram", target: TELEGRAM_CHAT },
    ];
    assert.equal(await send("hello", { routes }), undefined);
  });

  it("picks the first matching route", async () => {
    const routes = [
      { name: "first", channel: "telegram", target: TELEGRAM_CHAT, command: ECHO },
      { name: "second", channel: "telegram", target: TELEGRAM_CHAT, command: SILENT },
    ];
    assert.equal((await send("hi", { routes })).reply.text, "You said hi");
  });

  it("falls back to sessionKey when chatId is absent", async () => {
    const result = await send("hi", { chatId: undefined, channelId: undefined });
    assert.equal(result.reply.text, "You said hi");
  });
});

// Channels spell targets differently: Telegram uses a bare id, Discord uses
// `channel:<id>`. The hook always sees the bare id, so config must accept both.
describe("target normalization", () => {
  const discord = {
    channel: "discord",
    messageProvider: "discord",
    chatId: DISCORD_CHAT,
    channelId: DISCORD_CHAT,
    sessionKey: `discord:channel:${DISCORD_CHAT}`,
  };

  for (const target of [DISCORD_CHAT, `channel:${DISCORD_CHAT}`, `discord:channel:${DISCORD_CHAT}`]) {
    it(`accepts "${target}"`, async () => {
      const routes = [{ name: "echo", channel: "discord", target, command: ECHO }];
      assert.equal((await send("hi", { ...discord, routes })).reply.text, "You said hi");
    });
  }

  it("does not match a different conversation on the same channel", async () => {
    const routes = [{ name: "echo", channel: "discord", target: "999999999999999999", command: ECHO }];
    assert.equal(await send("hi", { ...discord, routes }), undefined);
  });

  it("leaves ids that embed a colon alone, such as Matrix room ids", async () => {
    const room = "!abc:matrix.example";
    const routes = [{ name: "echo", channel: "matrix", target: room, command: ECHO }];
    const result = await send("hi", {
      channel: "matrix",
      messageProvider: "matrix",
      chatId: room,
      channelId: room,
      sessionKey: `matrix:group:${room}`,
      routes,
    });
    assert.equal(result.reply.text, "You said hi");
  });
});


// route 可以只寫 project：script 的位置與直譯器都照約定推出來，而且是**每次派工時**
// 才推——使用者換了 node 版本、重裝了 uv，設定檔一個字都不必改。
describe("route by project", () => {
  let projects;

  const projectRoute = (overrides = {}) => ({
    routes: [{ project: "ledger", channel: "telegram", target: TELEGRAM_CHAT, ...overrides }],
    config: { tap: { projectsDir: projects } },
  });

  const seedScript = (file, source) => {
    const script = join(projects, "ledger", file);
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, source, "utf8");
    return script;
  };

  beforeEach(() => {
    projects = mkdtempSync(join(dir, "route-projects-"));
  });

  it("finds and runs scripts/intercept.mjs without any path in the config", async () => {
    seedScript(join("scripts", "intercept.mjs"), `${READ_STDIN}process.stdout.write("ledger says " + payload.body);`);
    assert.equal((await send("hi", projectRoute())).reply.text, "ledger says hi");
  });

  it("still hands the turn to the AI on exit 20", async () => {
    seedScript(join("scripts", "intercept.mjs"), `${READ_STDIN}process.exit(20);`);
    assert.equal(await send("hi", projectRoute()), undefined);
  });

  it("reports a project whose script is missing instead of silently passing", async () => {
    mkdirSync(join(projects, "ledger"), { recursive: true });
    const result = await send("hi", projectRoute());
    assert.equal(result.handled, true);
    assert.match(result.reply.text, /ledger has no script yet/);
  });

  it("hands the turn to the AI when a broken project route is passthrough", async () => {
    mkdirSync(join(projects, "ledger"), { recursive: true });
    assert.equal(await send("hi", projectRoute({ onError: "passthrough" })), undefined);
  });

  it("says so when tap.projectsDir is not configured", async () => {
    const result = await send("hi", {
      routes: [{ project: "ledger", channel: "telegram", target: TELEGRAM_CHAT }],
      config: {},
    });
    assert.match(result.reply.text, /needs tap\.projectsDir to be set/);
  });

  // 專案名會被接在 projectsDir 後面當路徑用，而 route 是人寫的設定——still，
  // 打錯或寫成 `../` 都不該讓它跑出去。
  it("refuses a project name that is not one path segment", async () => {
    const result = await send("hi", {
      routes: [{ project: "../evil", channel: "telegram", target: TELEGRAM_CHAT }],
      config: { tap: { projectsDir: projects } },
    });
    assert.match(result.reply.text, /is not a usable project name/);
  });

  it("prefers an explicit command when both are given", async () => {
    seedScript(join("scripts", "intercept.mjs"), `${READ_STDIN}process.stdout.write("wrong one");`);
    const result = await send("hi", projectRoute({ command: ECHO }));
    assert.equal(result.reply.text, "You said hi");
  });
});

describe("script outcome", () => {
  it("passes the body through verbatim, without normalizing it", async () => {
    for (const body of ["hi", "  padded  ", "multi\nline", "全形１２３", "emoji 🙂"]) {
      assert.equal((await send(body)).reply.text, `You said ${body}`.trim(), body);
    }
  });

  it("hands the turn to the AI on exit 20", async () => {
    const routes = [{ name: "decline", channel: "telegram", target: TELEGRAM_CHAT, command: DECLINE }];
    assert.equal(await send("hi", { routes }), undefined);
  });

  it("treats empty stdout as handled-but-silent", async () => {
    const routes = [{ name: "silent", channel: "telegram", target: TELEGRAM_CHAT, command: SILENT }];
    const result = await send("hi", { routes });
    assert.equal(result.handled, true);
    assert.equal(result.reply, undefined);
  });

  it("reports failures to the user by default", async () => {
    const routes = [{ name: "boom", channel: "telegram", target: TELEGRAM_CHAT, command: FAIL }];
    const result = await send("hi", { routes });
    assert.equal(result.handled, true);
    assert.match(result.reply.text, /^boom failed: /);
  });

  it("hands failures to the AI when onError is passthrough", async () => {
    const routes = [
      { name: "boom", channel: "telegram", target: TELEGRAM_CHAT, command: FAIL, onError: "passthrough" },
    ];
    assert.equal(await send("hi", { routes }), undefined);
  });
});

describe("per-route serialization", () => {
  it("runs one script at a time so concurrent turns cannot clobber shared state", async () => {
    const counterFile = join(dir, "counter.txt");
    const routes = [
      {
        name: "counter",
        channel: "telegram",
        target: TELEGRAM_CHAT,
        command: COUNTER,
        env: { COUNTER_FILE: counterFile },
      },
    ];
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => send("go", { routes })));
    assert.deepEqual(
      results.map((r) => Number(r.reply.text)).sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
    );
  });
});

// `/aside <anything>` is eaten by the plugin itself: no model, no script, no reply,
// and it behaves the same in every room — with a route or without one.
describe("/aside", () => {
  let seq = 0;
  /** A fresh log per test, so one test's writes cannot be mistaken for another's. */
  const asideLog = () => join(dir, `asides-${++seq}.log`);
  const readAsides = (file) =>
    (existsSync(file) ? readFileSync(file, "utf8") : "")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\{.*\})$/.exec(line);
        assert.ok(match, `aside line is not "<local stamp> <json>": ${line}`);
        return { ts: match[1], ...JSON.parse(match[2]) };
      });

  it("records the aside and says nothing back", async () => {
    const asideLogFile = asideLog();
    const result = await send("/aside the keyboard feels slow", { config: { asideLogFile } });
    assert.equal(result.handled, true);
    assert.equal(result.reply, undefined);
    assert.deepEqual(readAsides(asideLogFile), [
      {
        ts: readAsides(asideLogFile)[0].ts,
        text: "the keyboard feels slow",
        channel: "telegram",
        target: TELEGRAM_CHAT,
        route: "echo",
      },
    ]);
  });

  it("never reaches the script", async () => {
    const asideLogFile = asideLog();
    // The default route is ECHO: had the script run, the reply would be "You said …".
    const result = await send("/aside do not echo me", { config: { asideLogFile } });
    assert.equal(result.reply, undefined);
  });

  // 使用者要的是「我在這裡留一句，誰都不要處理」。那句話在哪個房間都要成立，
  // 否則他每次開口前都得先想「這間算不算」。
  it("works the same in a room with no route at all", async () => {
    const asideLogFile = asideLog();
    const other = { chatId: OTHER_CHAT, channelId: OTHER_CHAT, sessionKey: `telegram:group:${OTHER_CHAT}` };
    const result = await send("/aside not my room", { ...other, routes: undefined, config: { asideLogFile } });
    assert.equal(result.handled, true);
    assert.equal(result.reply, undefined);
    assert.equal(readAsides(asideLogFile)[0].text, "not my room");
    assert.equal(readAsides(asideLogFile)[0].route, "");
  });

  for (const [label, body, text] of [
    ["uppercase", "/ASIDE too slow", "too slow"],
    ["newline right after the keyword", "/aside\ntoo slow", "too slow"],
    ["no space at all", "/aside太慢了", "太慢了"],
    ["multiline", "/aside first\n\nsecond", "first\n\nsecond"],
    ["nothing after the keyword", "/aside", ""],
    ["the /aside@botname form Telegram sends in groups", "/aside@some_bot too slow", "too slow"],
    // 標點不另外判斷：後面接什麼就原樣記什麼。
    ["colon, kept verbatim", "/aside: too slow", ": too slow"],
    ["fullwidth colon, kept verbatim", "/aside：too slow", "：too slow"],
  ]) {
    it(`accepts the ${label} form`, async () => {
      const asideLogFile = asideLog();
      const result = await send(body, { config: { asideLogFile } });
      assert.equal(result.handled, true);
      assert.equal(readAsides(asideLogFile)[0].text, text);
    });
  }

  // 只有 `/aside` 這個字才算，剛好以它開頭的字不算。
  for (const body of ["/asidebar is open", "an /aside happened", "aside from that"]) {
    it(`leaves ${JSON.stringify(body)} to the script`, async () => {
      const asideLogFile = asideLog();
      const result = await send(body, { config: { asideLogFile } });
      assert.equal(result.reply.text, `You said ${body}`);
      assert.equal(existsSync(asideLogFile), false);
    });
  }

  it("tells the user when the aside could not be written", async () => {
    // The parent of this path is a regular file, so creating the directory fails.
    const asideLogFile = join(dir, "echo.mjs", "asides.log");
    const result = await send("/aside nowhere to write this", { config: { asideLogFile } });
    assert.equal(result.handled, true);
    assert.match(result.reply.text, /^aside not recorded: /);
  });
});

describe("payload handed to the script", () => {
  it("carries the conversation identity fields", async () => {
    const dump = fixture("dump.mjs", `${READ_STDIN}process.stdout.write(JSON.stringify(payload));`);
    const routes = [{ name: "dump", channel: "telegram", target: TELEGRAM_CHAT, command: dump }];
    const result = await send("hi", { routes, senderId: "42" });
    assert.deepEqual(JSON.parse(result.reply.text), {
      body: "hi",
      channel: "telegram",
      target: TELEGRAM_CHAT,
      senderId: "42",
      sessionKey: `telegram:group:${TELEGRAM_CHAT}`,
      agentId: "test-agent",
    });
  });
});

// `/tap` 由 plugin 自己吃掉：找到（或開出）這個房間對應的專案，換到那個目錄，
// 叫起一個 AI harness，請它施展**它自己的** /tap 技能。這裡的 harness 與
// `openclaw message send` 都換成 fixture，所以測試不需要 Claude Code，也不會送出訊息。
describe("/tap", () => {
  let projects;
  let harnessLog;
  let notifyLog;
  let HARNESS;
  let SLOW_HARNESS;
  let NOTIFY;
  let projectsIndex;
  let seq = 0;
  let round = 0;

  // Windows 的 temp 目錄可能是 8.3 短檔名，子行程回報的卻是長的。
  const samePath = (a, b) => realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();

  /** harness 是背景跑的，所以這裡等它的產物出現，而不是等 hook 回來。 */
  async function waitFor(read, label) {
    for (let i = 0; i < 400; i += 1) {
      const value = read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.fail(`timed out waiting for ${label}`);
  }

  const readJson = (file) => {
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return null; // 還在寫
    }
  };

  const seed = (name, body) => {
    const file = join(projects, name, "genesis", ".tap");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, body, "utf8");
    return file;
  };

  // projectsFile 一定要指到暫存目錄：漏了它，測試就會去寫使用者真正的
  // ~/.openclaw/chat-interceptor-projects.json。
  const tap = (overrides = {}) => ({
    config: {
      tap: {
        projectsDir: projects,
        projectsFile: projectsIndex,
        command: HARNESS,
        notifyCommand: NOTIFY,
        env: { HARNESS_LOG: harnessLog },
        ...overrides,
      },
    },
  });

  before(() => {
    // 站在哪裡、被交代了什麼，寫下來就好——真正的 harness 在這一步會去改 script。
    const record = `
      const fs = await import("node:fs");
      fs.writeFileSync(process.env.HARNESS_LOG, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }), "utf8");
      process.stdout.write("rewrote two rules");`;
    HARNESS = fixture("harness.mjs", record);
    SLOW_HARNESS = fixture("slow-harness.mjs", `await new Promise((r) => setTimeout(r, 400));${record}`);
    NOTIFY = fixture(
      "notify.mjs",
      `
      const fs = await import("node:fs");
      fs.writeFileSync(process.env.NOTIFY_LOG, JSON.stringify(process.argv.slice(2)), "utf8");`,
    );
  });

  // 每個測試都用全新的檔名與目錄，什麼都不重複使用。剛跑完的 harness 還會
  // 抓著工作目錄、剛寫完的檔案在 Windows 上也不是刪掉就馬上消失——與其在
  // 測試之間清場，不如讓每一輪從一開始就沒有別人的東西。
  beforeEach(() => {
    seq += 1;
    round = 0;
    rotate();
    projectsIndex = join(dir, `projects-index-${seq}.json`);
    projects = mkdtempSync(join(dir, "projects-"));
  });

  // 一個測試裡要跑第二輪時，換新檔名，不要刪掉再用同一個：Windows 上「刪掉」
  // 只是標記待刪，檔案還握在剛結束的子行程手上時，讀回來的可能還是舊內容——
  // 那會讓第二輪誤以為自己已經跑完了。
  function rotate() {
    round += 1;
    harnessLog = join(dir, `harness-${seq}-${round}.json`);
    notifyLog = join(dir, `notify-${seq}-${round}.json`);
    process.env.NOTIFY_LOG = notifyLog;
  }

  it("leaves /tap to the script when tap is not configured", async () => {
    assert.equal((await send("/tap")).reply.text, "You said /tap");
  });

  it("starts the harness in the project whose .tap names this room", async () => {
    seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\nviewed:  2026-08-18 20:43:20\n`);
    const result = await send("/tap", tap());
    assert.match(result.reply.text, /^tap: ledger started in /);

    const run = await waitFor(() => readJson(harnessLog), "the harness to run");
    assert.ok(samePath(run.cwd, join(projects, "ledger")), `${run.cwd} is not the project directory`);
    // prompt 是最後一個參數，而且第一行就是 /tap——後面那段是這一輪的執行條件。
    assert.equal(run.argv.length, 1);
    assert.equal(run.argv[0].split("\n")[0], "/tap");
    assert.match(run.argv[0], /non-interactive/);

    const notify = await waitFor(() => readJson(notifyLog), "the finished run to be reported");
    assert.deepEqual(notify.slice(0, 4), ["--channel", "telegram", "--target", TELEGRAM_CHAT]);
    assert.equal(notify[4], "--message");
    assert.match(notify[5], /^tap: ledger done in \d+s\nrewrote two rules$/);
  });

  it("wins over the script bound to the same room", async () => {
    // 這個房間的 route 是 ECHO：script 若跑到了，回的會是 "You said /tap"。
    seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
    assert.match((await send("/tap", tap())).reply.text, /^tap: ledger started/);
    await waitFor(() => readJson(notifyLog), "the run to finish");
  });

  it("accepts the /tap@botname form Telegram sends in groups", async () => {
    seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
    assert.match((await send("/tap@some_bot", tap())).reply.text, /^tap: ledger started/);
    await waitFor(() => readJson(notifyLog), "the run to finish");
  });

  it("creates the .tap for a new project and starts there", async () => {
    const result = await send("/tap ledger", tap());
    assert.match(result.reply.text, /^tap: ledger started in .* \(new project\)\./);

    const file = join(projects, "ledger", "genesis", ".tap");
    assert.equal(readFileSync(file, "utf8"), `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\nviewed:\n`);
    // 頻道位置是敏感資訊，全新的專案順手把擋板放好。
    assert.equal(readFileSync(join(projects, "ledger", ".gitignore"), "utf8"), ".tap\n");

    const run = await waitFor(() => readJson(harnessLog), "the harness to run");
    assert.ok(samePath(run.cwd, join(projects, "ledger")), `${run.cwd} is not the project directory`);
    await waitFor(() => readJson(notifyLog), "the run to finish");
  });

  it("bootstraps a room that has no route at all", async () => {
    const other = { chatId: OTHER_CHAT, channelId: OTHER_CHAT, sessionKey: `telegram:group:${OTHER_CHAT}` };
    const result = await send("/tap fresh", { ...other, ...tap() });
    assert.match(result.reply.text, /^tap: fresh started/);
    const written = readFileSync(join(projects, "fresh", "genesis", ".tap"), "utf8");
    assert.equal(written, `channel: telegram\ntarget:  ${OTHER_CHAT}\nviewed:\n`);
    await waitFor(() => readJson(notifyLog), "the run to finish");
  });

  it("never overwrites an existing .tap, so viewed survives", async () => {
    const body = `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\nviewed:  2026-08-18 20:43:20\n`;
    const file = seed("ledger", body);
    assert.match((await send("/tap ledger", tap())).reply.text, /^tap: ledger started/);
    assert.equal(readFileSync(file, "utf8"), body);
    await waitFor(() => readJson(notifyLog), "the run to finish");
  });

  it("refuses a project whose .tap points at another room", async () => {
    seed("ledger", `channel: telegram\ntarget:  ${OTHER_CHAT}\n`);
    const result = await send("/tap ledger", tap());
    assert.match(result.reply.text, /already has a \.tap pointing at another room/);
    assert.equal(readJson(harnessLog), null);
  });

  for (const name of ["../evil", "a/b", "a\\b", ".", ".."]) {
    it(`refuses ${JSON.stringify(name)} as a project name`, async () => {
      const result = await send(`/tap ${name}`, tap());
      assert.match(result.reply.text, /is not a usable project name/);
      assert.equal(readJson(harnessLog), null);
    });
  }

  // 房間常常是先亂聊很久，聊到某個點子不錯才決定開專案。起點日期就是
  // 「從這裡才算數」，寫進 .tap 的 viewed 之後 harness 自然從那裡往後看。
  it("writes the start date into viewed when the new project is created", async () => {
    const result = await send("/tap ledger 2026-08-20", tap());
    assert.match(result.reply.text, /^tap: ledger started in .* \(new project, from 2026-08-20\)\./);
    const file = join(projects, "ledger", "genesis", ".tap");
    assert.equal(readFileSync(file, "utf8"), `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\nviewed:  2026-08-20\n`);
    await waitFor(() => readJson(notifyLog), "the run to finish");
  });

  for (const since of ["2026-08-20 14:30", "2026-08-20 14:30:05"]) {
    it(`accepts a start date given as ${JSON.stringify(since)}`, async () => {
      const reply = (await send(`/tap ledger ${since}`, tap())).reply.text;
      assert.ok(reply.endsWith(`(new project, from ${since}). I will report back when it finishes.`), reply);
      const file = join(projects, "ledger", "genesis", ".tap");
      assert.equal(readFileSync(file, "utf8"), `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\nviewed:  ${since}\n`);
      await waitFor(() => readJson(notifyLog), "the run to finish");
    });
  }

  it("moves viewed when an existing project is given a start date", async () => {
    const file = seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\nviewed:  2026-08-18 20:43:20\n`);
    const result = await send("/tap ledger 2026-08-20", tap());
    assert.match(result.reply.text, /^tap: ledger started in .* \(from 2026-08-20\)\./);
    assert.equal(readFileSync(file, "utf8"), `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\nviewed:  2026-08-20\n`);
    await waitFor(() => readJson(notifyLog), "the run to finish");
  });

  it("adds viewed to a .tap that never had one", async () => {
    const file = seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
    await send("/tap ledger 2026-08-20", tap());
    assert.equal(readFileSync(file, "utf8"), `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\nviewed:  2026-08-20\n`);
    await waitFor(() => readJson(notifyLog), "the run to finish");
  });

  for (const since of ["words", "2026-8-20", "20260820", "2026-08-20 14"]) {
    it(`refuses ${JSON.stringify(since)} as a start date`, async () => {
      const result = await send(`/tap ledger ${since}`, tap());
      assert.match(result.reply.text, /is not a usable start date/);
      assert.equal(existsSync(join(projects, "ledger")), false);
    });
  }

  it("asks for the project name when only a date is given", async () => {
    const result = await send("/tap 2026-08-20", tap());
    assert.equal(result.reply.text, "tap: a start date needs a project name: /tap <projname> 2026-08-20");
    assert.equal(existsSync(join(projects, "2026-08-20")), false);
  });
  it("says so when no project claims this room", async () => {
    const result = await send("/tap", tap());
    assert.match(result.reply.text, /^tap: no project under .* has a \.tap for this room\./);
    assert.equal(readJson(harnessLog), null);
  });

  it("names the candidates when more than one project claims the room", async () => {
    seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
    seed("older-ledger", `channel: telegram\ntarget:  telegram:group:${TELEGRAM_CHAT}\n`);
    const result = await send("/tap", tap());
    assert.match(result.reply.text, /^tap: ledger, older-ledger all claim this room\./);
    assert.equal(readJson(harnessLog), null);
  });

  it("ignores a .tap that names a different room", async () => {
    seed("elsewhere", `channel: telegram\ntarget:  ${OTHER_CHAT}\n`);
    seed("wrong-channel", `channel: discord\ntarget:  ${TELEGRAM_CHAT}\n`);
    assert.match((await send("/tap", tap())).reply.text, /^tap: no project under /);
  });

  it("runs one harness per project at a time", async () => {
    seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
    const config = tap({ command: SLOW_HARNESS });
    assert.match((await send("/tap", config)).reply.text, /^tap: ledger started/);
    assert.equal((await send("/tap", config)).reply.text, "tap: ledger is still running.");
    await waitFor(() => readJson(notifyLog), "the first run to finish");
  });

  it("reports a harness that failed", async () => {
    seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
    await send("/tap", tap({ command: FAIL }));
    const notify = await waitFor(() => readJson(notifyLog), "the failure to be reported");
    assert.match(notify[5], /^tap: ledger failed after \d+s\nboom$/);
  });

  it("only lets allowFrom accounts start a run", async () => {
    seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
    const config = tap({ allowFrom: ["7"] });
    const refused = await send("/tap", { ...config, senderId: "9" });
    assert.equal(refused.reply.text, "tap: this account is not allowed to run tap here.");
    assert.equal(readJson(harnessLog), null);

    assert.match((await send("/tap", { ...config, senderId: "7" })).reply.text, /^tap: ledger started/);
    await waitFor(() => readJson(notifyLog), "the run to finish");
  });

  it("tells the user when projectsDir is missing", async () => {
    const result = await send("/tap", { config: { tap: { command: HARNESS } } });
    assert.equal(result.reply.text, "tap: set tap.projectsDir in the plugin config first.");
  });

  // 對照表：同一個房間先後開過兩個專案時，兩份 .tap 都還在——掃描分不出來，
  // 表分得出來。這是「重測一次」最常見的現場。
  describe("哪個專案屬於這個房間", () => {
    const readIndex = () => (existsSync(projectsIndex) ? JSON.parse(readFileSync(projectsIndex, "utf8")) : {});

    it("records the project when one is created by name", async () => {
      await send("/tap ledger", tap());
      const entry = Object.values(readIndex())[0];
      assert.equal(entry.name, "ledger");
      assert.ok(samePath(entry.dir, join(projects, "ledger")), entry.dir);
      await waitFor(() => readJson(notifyLog), "the run to finish");
    });

    it("keeps using the recorded project even when an older .tap still claims the room", async () => {
      await send("/tap ledger", tap());
      await waitFor(() => readJson(notifyLog), "the first run to finish");
      // 另一個專案也宣稱同一個房間——掃描會卡在這裡，表不會。
      seed("stale-ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
      rotate();

      assert.match((await send("/tap", tap())).reply.text, /^tap: ledger started/);
      const run = await waitFor(() => readJson(harnessLog), "the harness to run");
      assert.ok(samePath(run.cwd, join(projects, "ledger")), run.cwd);
    });

    it("hands the room over to the project named last", async () => {
      await send("/tap ledger", tap());
      await waitFor(() => readJson(notifyLog), "the first run to finish");
      rotate();
      await send("/tap ledger-two", tap());
      assert.equal(Object.values(readIndex())[0].name, "ledger-two");
      await waitFor(() => readJson(notifyLog), "the second run to finish");
      rotate();

      assert.match((await send("/tap", tap())).reply.text, /^tap: ledger-two started/);
    });

    // 使用者把專案改名或搬走，往往就是要讓它消失。那就照做，而且說清楚。
    it("says the recorded project is gone instead of scanning for a replacement", async () => {
      await send("/tap ledger", tap());
      await waitFor(() => readJson(notifyLog), "the run to finish");
      rmSync(join(projects, "ledger"), { recursive: true, force: true, maxRetries: 60, retryDelay: 100 });
      seed("something-else", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);

      const result = await send("/tap", tap());
      assert.match(result.reply.text, /^tap: the project recorded for this room is gone: /);
      assert.match(result.reply.text, /Use "\/tap <projname> \[yyyy-mm-dd\]" to start a new one\./);
    });

    it("falls back to scanning, and remembers what it found", async () => {
      seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
      assert.deepEqual(readIndex(), {});
      assert.match((await send("/tap", tap())).reply.text, /^tap: ledger started/);
      assert.equal(Object.values(readIndex())[0].name, "ledger");
      await waitFor(() => readJson(notifyLog), "the run to finish");
    });

    it("comes back to an old project when it is named again", async () => {
      const body = `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\nviewed:  2026-08-18 20:43:20\n`;
      const file = seed("ledger", body);
      const result = await send("/tap ledger", tap());
      // 既有專案：不是新開的，viewed 也原封不動。
      assert.doesNotMatch(result.reply.text, /new project/);
      assert.equal(readFileSync(file, "utf8"), body);
      assert.equal(Object.values(readIndex())[0].name, "ledger");
      await waitFor(() => readJson(notifyLog), "the run to finish");
    });
  });

  // 第二輪之後可以接續同一個 harness session，這樣它才記得自己問過什麼。
  // 「跑過了沒」看登記，不用猜——猜錯就是第一輪去接一個不存在的 session。
  describe("接續同一個 session", () => {
    let CONTINUE;
    const readIndex = () => (existsSync(projectsIndex) ? JSON.parse(readFileSync(projectsIndex, "utf8")) : {});
    const entry = () => Object.values(readIndex())[0];

    before(() => {
      // 跟 HARNESS 一樣，只是把自己標記成「這一輪是接續的」。
      CONTINUE = fixture(
        "continue-harness.mjs",
        `
      const fs = await import("node:fs");
      fs.writeFileSync(process.env.HARNESS_LOG, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2), continued: true }), "utf8");
      process.stdout.write("carried on");`,
      );
    });

    it("starts fresh the first time, then continues", async () => {
      seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
      const config = tap({ continueCommand: CONTINUE });

      await send("/tap", config);
      await waitFor(() => readJson(notifyLog), "the first run to finish");
      assert.equal(readJson(harnessLog).continued, undefined, "the first run must not continue anything");
      assert.equal(entry().harnessRan, true);

      // rotate 之後要重新組 config：HARNESS_LOG 是組 config 那一刻決定的。
      rotate();
      await send("/tap", tap({ continueCommand: CONTINUE }));
      await waitFor(() => readJson(notifyLog), "the second run to finish");
      assert.equal(readJson(harnessLog).continued, true, "the second run should continue the first");
    });

    // session 不能無限接續下去。`viewed` 往前推＝這一段結案、來龍去脈已經進 repo，
    // 那就是丟掉累積 context 最誠實的分界線。
    it("ends the session when the harness moves viewed forward", async () => {
      const file = seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\nviewed:  2026-08-18 20:43:20\n`);
      const PUSHES_VIEWED = fixture(
        "pushes-viewed.mjs",
        `
      const fs = await import("node:fs");
      fs.writeFileSync(process.env.HARNESS_LOG, JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }), "utf8");
      fs.writeFileSync(process.env.TAP_FILE, "channel: telegram\\ntarget:  ${TELEGRAM_CHAT}\\nviewed:  2026-09-06 21:00:00\\n", "utf8");
      process.stdout.write("chapter closed");`,
      );
      const config = tap({
        command: PUSHES_VIEWED,
        continueCommand: CONTINUE,
        env: { HARNESS_LOG: harnessLog, TAP_FILE: file },
      });

      await send("/tap", config);
      const notify = await waitFor(() => readJson(notifyLog), "the run to finish");
      assert.match(notify[5], /viewed moved to 2026-09-06 21:00:00 — the next \/tap starts a fresh session\./);
      assert.equal(entry().harnessRan, false);
    });

    it("keeps the session when viewed did not move", async () => {
      seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\nviewed:  2026-08-18 20:43:20\n`);
      await send("/tap", tap({ continueCommand: CONTINUE }));
      const notify = await waitFor(() => readJson(notifyLog), "the run to finish");
      assert.doesNotMatch(notify[5], /viewed moved/);
      assert.equal(entry().harnessRan, true);
    });

    it("stays on the plain command when no continueCommand is configured", async () => {
      seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
      await send("/tap", tap());
      await waitFor(() => readJson(notifyLog), "the first run to finish");
      rotate();

      await send("/tap", tap());
      await waitFor(() => readJson(notifyLog), "the second run to finish");
      assert.equal(readJson(harnessLog).continued, undefined);
    });

    it("does not mark a failed run as having run", async () => {
      seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
      await send("/tap", tap({ command: FAIL, continueCommand: CONTINUE }));
      await waitFor(() => readJson(notifyLog), "the failure to be reported");
      assert.notEqual(entry().harnessRan, true);
    });

    // session 過期或被刪掉時，每一輪都撞同一面牆是最糟的結局。
    it("falls back to a fresh session after a continued run fails", async () => {
      seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
      await send("/tap", tap({ continueCommand: CONTINUE }));
      await waitFor(() => readJson(notifyLog), "the first run to finish");
      assert.equal(entry().harnessRan, true);
      rotate();

      await send("/tap", tap({ continueCommand: FAIL }));
      const notify = await waitFor(() => readJson(notifyLog), "the failure to be reported");
      assert.match(notify[5], /The next \/tap will start a fresh session\.$/);
      assert.equal(entry().harnessRan, false);
    });
  });

  // 上線與下線。這兩個不叫 harness，只改設定——所以它們是同步回話的，
  // 不像 /tap 那樣先回「開始了」再背景跑。
  // 上線與下線。這兩個不叫 harness，只動對照表——所以它們是同步回話的，
  // 而且**當場生效**：plugin config 不會 hot reload，寫進 openclaw.json 的話
  // 要重啟 gateway 才算數，那不是使用者按下去時預期的事。
  describe("-install / -uninstall", () => {
    const readIndex = () => (existsSync(projectsIndex) ? JSON.parse(readFileSync(projectsIndex, "utf8")) : {});
    const entry = () => Object.values(readIndex())[0];

    /** 一個裝得起來的專案：`.tap` 指著這個房間，script 放在約定的位置。 */
    const seedInstallable = (name = "ledger", file = join("scripts", "intercept.mjs"), source = "process.exit(20);") => {
      seed(name, `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
      const script = join(projects, name, file);
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, source, "utf8");
      return script;
    };

    const withConfig = (overrides = {}) => tap(overrides);

    // 這是那個真實踩到的 bug 的回歸測試：回話說裝好了，但下一則訊息還是走舊的。
    it("takes effect on the very next message", async () => {
      seedInstallable("ledger", join("scripts", "intercept.mjs"), `${READ_STDIN}process.stdout.write("ledger says " + payload.body);`);
      assert.equal(await send("hi", { routes: undefined, ...withConfig() }), undefined, "not routed before installing");

      await send("/tap -install", withConfig());
      assert.equal((await send("hi", { routes: undefined, ...withConfig() })).reply.text, "ledger says hi");

      await send("/tap -uninstall", withConfig());
      assert.equal(await send("hi", { routes: undefined, ...withConfig() }), undefined, "not routed after uninstalling");
    });

    it("derives the route from the script it finds, with no config file at all", async () => {
      const script = seedInstallable();
      const result = await send("/tap -install", withConfig());
      assert.match(result.reply.text, /^tap: ledger is live in this room\./);
      assert.ok(result.reply.text.includes(`runs: ${process.execPath} ${script}`), result.reply.text);
      // 設定檔一個字都沒動——上線只是對照表多了一個旗標。
      assert.equal(entry().installed, true);
      assert.equal(entry().name, "ledger");
    });

    it("accepts the --install spelling too", async () => {
      seedInstallable();
      assert.match((await send("/tap --install", withConfig())).reply.text, /is live in this room/);
    });

    it("never starts the harness", async () => {
      seedInstallable();
      await send("/tap -install", withConfig());
      assert.equal(readJson(harnessLog), null);
    });

    it("says nothing changed when it is already live", async () => {
      seedInstallable();
      await send("/tap -install", withConfig());
      assert.match((await send("/tap -install", withConfig())).reply.text, /was already live here, unchanged/);
    });

    for (const file of ["scripts/intercept.js", "scripts/intercept.cjs", "intercept.mjs"]) {
      it(`finds ${file}`, async () => {
        const script = seedInstallable("ledger", join(...file.split("/")));
        const result = await send("/tap -install", withConfig());
        assert.ok(result.reply.text.includes(`runs: ${process.execPath} ${script}`), result.reply.text);
      });
    }

    // .py 走 uv run。測試不能靠這台機器裝了什麼，所以用設定指定一個假的。
    it("runs a .py script through the configured interpreter", async () => {
      const script = seedInstallable("ledger", join("scripts", "intercept.py"));
      const fakeUv = join(dir, "fake-uv.mjs");
      writeFileSync(fakeUv, "process.exit(20);", "utf8");
      const result = await send("/tap -install", withConfig({ interpreters: { ".py": [fakeUv, "run"] } }));
      assert.ok(result.reply.text.includes(`runs: ${fakeUv} run ${script}`), result.reply.text);
    });

    it("refuses an interpreter that does not exist", async () => {
      seedInstallable("ledger", join("scripts", "intercept.py"));
      const result = await send("/tap -install", withConfig({ interpreters: { ".py": ["C:/nope/uv.exe", "run"] } }));
      assert.match(result.reply.text, /the interpreter for \.py does not exist/);
      assert.notEqual(entry()?.installed, true);
    });

    it("says so when the project has no script yet", async () => {
      seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
      const result = await send("/tap -install", withConfig());
      assert.match(result.reply.text, /ledger has no script yet/);
      assert.notEqual(entry()?.installed, true);
    });

    it("hands the room over to another project, and says so", async () => {
      seedInstallable("ledger");
      await send("/tap -install", withConfig());
      seedInstallable("ledger-two");
      const result = await send("/tap ledger-two", tap({ autoInstall: false }));
      await waitFor(() => readJson(notifyLog), "the run to finish");
      assert.match(result.reply.text, /^tap: ledger-two started/);

      // 接手的那一刻就講清楚：舊的那個不再跑在這個房間了。
      assert.match(result.reply.text, /taken over from ledger, which no longer runs here/);
      assert.notEqual(entry().installed, true);

      rotate();
      await send("/tap -install", withConfig());
      assert.equal(entry().name, "ledger-two");
      assert.equal(entry().installed, true);
    });

    it("uninstalls what this room had", async () => {
      seedInstallable();
      await send("/tap -install", withConfig());
      const result = await send("/tap -uninstall", withConfig());
      assert.match(result.reply.text, /^tap: ledger no longer runs here, and the room no longer belongs to it\./);
      assert.match(result.reply.text, /Its files are untouched\./);
      assert.deepEqual(readIndex(), {});
      // 專案的檔案一個都不動。
      assert.ok(existsSync(join(projects, "ledger", "scripts", "intercept.mjs")));
    });

    it("still unbinds a project that was never installed", async () => {
      seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
      await send("/tap", tap());
      await waitFor(() => readJson(notifyLog), "the run to finish");
      const result = await send("/tap -uninstall", withConfig());
      assert.match(result.reply.text, /no longer belongs to ledger \(it was not running\)/);
      assert.deepEqual(readIndex(), {});
    });

    it("says so when there is nothing to uninstall", async () => {
      const result = await send("/tap -uninstall", { routes: [], ...withConfig() });
      assert.equal(result.reply.text, "tap: this room has no route and no project.");
    });

    // 設定裡人手寫的 route 不歸它管，但不能讓使用者以為拆乾淨了。
    it("warns about a hand-written route it cannot remove", async () => {
      const routes = [{ name: "by-hand", channel: "telegram", target: TELEGRAM_CHAT, command: ECHO }];
      const result = await send("/tap -uninstall", { routes, ...withConfig() });
      assert.match(result.reply.text, /openclaw\.json still has a route for this room \(by-hand\)/);
      assert.match(result.reply.text, /restart the gateway/);
    });

    it("obeys allowFrom", async () => {
      seedInstallable();
      const config = withConfig({ allowFrom: ["7"] });
      const refused = await send("/tap -install", { ...config, senderId: "9" });
      assert.equal(refused.reply.text, "tap: this account is not allowed to run tap here.");
      assert.notEqual(entry()?.installed, true);
    });

    for (const body of ["/tap -rf", "/tap -install-now", "/tap -x"]) {
      it(`refuses ${JSON.stringify(body)}`, async () => {
        assert.match((await send(body, withConfig())).reply.text, /^tap: unknown option /);
      });
    }

    it("refuses extra arguments after an option", async () => {
      assert.equal((await send("/tap -install today", withConfig())).reply.text, "tap: -install takes no further arguments.");
    });

    // 跑完就上線：使用者要的是「改完就能測」，不是「改完再記得打一句上線」。
    describe("自動上線", () => {
      it("puts the project live once the harness has finished", async () => {
        seedInstallable();
        assert.match((await send("/tap", withConfig())).reply.text, /^tap: ledger started/);
        const notify = await waitFor(() => readJson(notifyLog), "the run to finish");
        assert.match(notify[5], /^tap: ledger done in \d+s\ninstalled: ledger is live in this room now/);
        assert.equal(entry().installed, true);
      });

      it("stays quiet when it is already live", async () => {
        seedInstallable();
        await send("/tap", withConfig());
        await waitFor(() => readJson(notifyLog), "the first run to finish");
        rotate();

        await send("/tap", withConfig());
        const notify = await waitFor(() => readJson(notifyLog), "the second run to finish");
        assert.doesNotMatch(notify[5], /installed:/);
        assert.equal(entry().installed, true);
      });

      it("does not install anything when the harness failed", async () => {
        seedInstallable();
        await send("/tap", withConfig({ command: FAIL }));
        const notify = await waitFor(() => readJson(notifyLog), "the failure to be reported");
        assert.match(notify[5], /^tap: ledger failed after/);
        assert.notEqual(entry()?.installed, true);
      });

      it("leaves it alone when autoInstall is off", async () => {
        seedInstallable();
        await send("/tap", withConfig({ autoInstall: false }));
        const notify = await waitFor(() => readJson(notifyLog), "the run to finish");
        assert.doesNotMatch(notify[5], /installed:/);
        assert.notEqual(entry()?.installed, true);
      });

      it("says why it could not install, without hiding the run", async () => {
        seedInstallable("ledger", join("scripts", "intercept.py"));
        await send("/tap", withConfig({ interpreters: { ".py": ["C:/nope/uv.exe", "run"] } }));
        const notify = await waitFor(() => readJson(notifyLog), "the run to finish");
        assert.match(notify[5], /^tap: ledger done in \d+s\nnot installed: .*does not exist/);
        assert.match(notify[5], /rewrote two rules$/);
        assert.notEqual(entry()?.installed, true);
      });

      it("ignores projects that have no script at all", async () => {
        seed("ledger", `channel: telegram\ntarget:  ${TELEGRAM_CHAT}\n`);
        await send("/tap", withConfig());
        const notify = await waitFor(() => readJson(notifyLog), "the run to finish");
        assert.doesNotMatch(notify[5], /installed:|not installed:/);
      });
    });
  });

  // 只有 `/tap` 這個字才是指令，剛好以 tap 開頭的字不是。
  for (const body of ["/tapioca", "/tap-dance", "tap this", "please /tap it"]) {
    it(`leaves ${JSON.stringify(body)} to the script`, async () => {
      assert.equal((await send(body, tap())).reply.text, `You said ${body}`);
      assert.equal(readJson(harnessLog), null);
    });
  }
});
