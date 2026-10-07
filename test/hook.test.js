// before_dispatch：依房間挑 route、跑 script、依 exit code 決定短路還是放行，
// 以及 AI 沒看到的那些一律記進 offstage log。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import { ASIDE_MARK } from "../src/core.js";
import {
  OTHER_CHAT,
  TELEGRAM_CHAT,
  DISCORD_CHAT,
  READ_STDIN,
  fakeOpenclaw,
  fixture,
  readJsonLines,
  readOffstage,
  register,
  removeLater,
  tempDir,
  unmark,
} from "./helpers.js";

let dir;
let hook;
let ECHO;
let DECLINE;
let FAIL;
let SILENT;
let COUNTER;
let offstageLogFile;
let seq = 0;

before(() => {
  dir = tempDir("chat-interceptor-hook-");
  ECHO = fixture(dir, "echo.mjs", `${READ_STDIN}process.stdout.write("You said " + payload.body);`);
  DECLINE = fixture(dir, "decline.mjs", `${READ_STDIN}process.exit(20);`);
  FAIL = fixture(dir, "fail.mjs", `${READ_STDIN}process.stderr.write("boom"); process.exit(3);`);
  SILENT = fixture(dir, "silent.mjs", `${READ_STDIN}process.exit(0);`);
  // Read-modify-write with a gap in the middle: races would produce duplicates.
  COUNTER = fixture(
    dir,
    "counter.mjs",
    `${READ_STDIN}
    const fs = await import("node:fs");
    const f = process.env.COUNTER_FILE;
    const n = Number(fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "0") + 1;
    await new Promise((r) => setTimeout(r, 25));
    fs.writeFileSync(f, String(n), "utf8");
    process.stdout.write(String(n));`,
  );
  ({ hook } = register());
});

after(() => removeLater(dir));

// offstage log 一個測試一份：漏了它，測試就會去寫使用者真正的 ~/.openclaw/logs。
beforeEach(() => {
  seq += 1;
  offstageLogFile = join(dir, `offstage-${seq}.log`);
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
      offstageLogFile,
      routes: explicitRoutes ? routes : [{ name: "echo", channel: "telegram", target: TELEGRAM_CHAT, command: ECHO }],
      ...config,
    },
  };
}

/** 回話是給人看的，一律是機器人的 /aside：send 驗過記號就拿掉，其餘的測試只看內容。 */
const send = async (body, overrides) => {
  const result = await sendRaw(body, overrides);
  return typeof result?.text === "string" ? { ...result, text: unmark(result.text) } : result;
};

const sendRaw = (body, overrides) => {
  const context = ctx(overrides);
  return hook({ body, channel: context.channel }, {
    pluginConfig: context.pluginConfig,
    channelId: context.channel,
    conversationId: context.chatId ?? context.channelId,
    sessionKey: context.sessionKey,
    senderId: context.senderId,
  });
};

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
    assert.equal((await send("hi", { routes })).text, "You said hi");
  });

  it("falls back to sessionKey when chatId is absent", async () => {
    const result = await send("hi", { chatId: undefined, channelId: undefined });
    assert.equal(result.text, "You said hi");
  });

  // before_dispatch 跑在 OpenClaw 處理斜線指令之前：送進 script 的話，
  // 回覆所有訊息的 script 會把指令吃掉。
  it("leaves slash commands to OpenClaw without running the script", async () => {
    for (const body of ["/new", "  /status", "/asides", "/fiat -go"]) assert.equal(await send(body), undefined, body);
    assert.deepEqual(readOffstage(offstageLogFile), []);
  });
});

// /aside 是房間裡的獨白，不是對哪一台說的：打成一則訊息的（Discord 上它就是一般文字）在這裡就記下。
// 不給 AI、不跑 script、不回話，每個房間都一樣。
const discord = {
  channel: "discord",
  messageProvider: "discord",
  chatId: DISCORD_CHAT,
  channelId: DISCORD_CHAT,
  sessionKey: `agent:main:discord:channel:${DISCORD_CHAT}`,
  routes: undefined,
};
const bot = { ...discord, senderId: "999999999999999999" };

describe("/aside typed as a message", () => {
  it("is recorded and never reaches the AI, in a room with no route", async () => {
    assert.deepEqual(await send("/aside 按鈕太小\n第二行", { routes: undefined, senderId: "7" }), { handled: true });
    const [entry] = readOffstage(offstageLogFile);
    assert.deepEqual([entry.kind, entry.text, entry.target, entry.senderId, entry.bot], ["aside", "按鈕太小\n第二行", TELEGRAM_CHAT, "7", undefined]);
  });

  it("comes before the room's script", async () => {
    assert.deepEqual(await send("/aside hi"), { handled: true });
    assert.equal(readOffstage(offstageLogFile)[0].kind, "aside");
  });

  it("is recorded whichever bot it names", async () => {
    await send("/aside@OtherBot hi");
    assert.equal(readOffstage(offstageLogFile)[0].text, "hi");
  });

  it("only counts at the very start", async () => {
    assert.equal((await send("試試 /aside 看看")).text, "You said 試試 /aside 看看");
  });

  it("says so when it could not be written", async () => {
    // The parent of this path is a regular file, so creating the directory fails.
    const result = await send("/aside hi", { config: { offstageLogFile: join(ECHO[1], "x.log") } });
    assert.match(result.text, /^aside not recorded: /);
  });
});

// 這個 plugin 送出去的訊息開頭帶一個看不見的記號，處理跟 /aside 一樣：房間裡別台的回報、script 的回話，
// 都不交給這一台的 AI。
describe("a marked message", () => {
  it("is recorded like an aside and never reaches the AI", async () => {
    assert.deepEqual(await send(`${ASIDE_MARK}ledger: FIAT ready\ngenesis/FIATLUX.md`, bot), { handled: true });
    const [entry] = readOffstage(offstageLogFile);
    assert.deepEqual(
      [entry.kind, entry.bot, entry.channel, entry.target, entry.text],
      ["aside", true, "discord", DISCORD_CHAT, "ledger: FIAT ready\ngenesis/FIATLUX.md"],
    );
  });

  it("comes before the room's script", async () => {
    const routes = [{ name: "echo", channel: "discord", target: DISCORD_CHAT, command: ECHO }];
    assert.deepEqual(await send(`${ASIDE_MARK}built`, { ...bot, routes }), { handled: true });
  });
});

// 太長的訊息平台會切成好幾則，/aside 或記號只在第一則：同一個發話者緊接著送來的是後半。
describe("a long aside split into several messages", () => {
  const long = Array.from({ length: 17 }, (_, i) => `第 ${i + 1} 行`).join("\n");

  afterEach(() => mock.timers.reset());

  for (const [label, head, marked] of [
    ["marked", `${ASIDE_MARK}${long}`, true],
    ["typed", `/aside ${long}`, undefined],
  ]) {
    it(`takes what the same sender sends right after a ${label} one as the rest of it`, async () => {
      mock.timers.enable({ apis: ["Date"], now: 1_000_000 });
      await send(head, bot);
      mock.timers.tick(3_000);
      assert.deepEqual(await send("第二段", bot), { handled: true });
      mock.timers.tick(9_000);
      assert.deepEqual(await send("第三段", bot), { handled: true });
      assert.deepEqual(
        readOffstage(offstageLogFile).map((entry) => [entry.text.split("\n")[0], entry.bot]),
        [["第 1 行", marked], ["第二段", marked], ["第三段", marked]],
      );
      mock.timers.tick(11_000);
      assert.equal(await send("過一會兒再說的", bot), undefined, "a while later it is a message again");
    });
  }

  // 短的不會被切：人打完一句 /aside 緊接著講的話，是要給 AI 聽的。
  it("does not wait for the rest of a short one", async () => {
    await send("/aside 記一下", bot);
    assert.equal(await send("hi", bot), undefined);
    await send(`${ASIDE_MARK}fiat: starting`, bot);
    assert.equal(await send("hi", bot), undefined);
  });

  it("does not swallow anyone else's message", async () => {
    await send(`${ASIDE_MARK}${long}`, bot);
    assert.equal(await send("人講的話", { ...discord, senderId: "7" }), undefined);
    assert.equal(await send("別的房間", { ...bot, chatId: OTHER_CHAT, channelId: OTHER_CHAT, sessionKey: `discord:channel:${OTHER_CHAT}` }), undefined);
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
      assert.equal((await send("hi", { ...discord, routes })).text, "You said hi");
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
    assert.equal(result.text, "You said hi");
  });
});

// route 可以只寫 project：script 的位置與直譯器都照約定推出來，而且是**每次派工時**
// 才推——使用者換了 node 版本、重裝了 uv，設定檔一個字都不必改。
describe("route by project", () => {
  let projects;

  const projectRoute = (overrides = {}) => ({
    routes: [{ project: "ledger", channel: "telegram", target: TELEGRAM_CHAT, ...overrides }],
    config: { fiat: { projectsDir: projects } },
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
    assert.equal((await send("hi", projectRoute())).text, "ledger says hi");
  });

  for (const file of ["scripts/intercept.js", "scripts/intercept.cjs", "intercept.mjs"]) {
    it(`finds ${file}`, async () => {
      seedScript(join(...file.split("/")), `process.stdout.write("found");`);
      assert.equal((await send("hi", projectRoute())).text, "found");
    });
  }

  it("still hands the turn to the AI on exit 20", async () => {
    seedScript(join("scripts", "intercept.mjs"), `${READ_STDIN}process.exit(20);`);
    assert.equal(await send("hi", projectRoute()), undefined);
  });

  it("reports a project whose script is missing instead of silently passing", async () => {
    mkdirSync(join(projects, "ledger"), { recursive: true });
    const result = await send("hi", projectRoute());
    assert.equal(result.handled, true);
    assert.match(result.text, /ledger has no script yet/);
  });

  it("hands the turn to the AI when a broken project route is passthrough", async () => {
    mkdirSync(join(projects, "ledger"), { recursive: true });
    assert.equal(await send("hi", projectRoute({ onError: "passthrough" })), undefined);
  });

  it("says so when fiat.projectsDir is not configured", async () => {
    const result = await send("hi", {
      routes: [{ project: "ledger", channel: "telegram", target: TELEGRAM_CHAT }],
      config: {},
    });
    assert.match(result.text, /needs fiat\.projectsDir to be set/);
  });

  // 專案名會被接在 projectsDir 後面當路徑用，而 route 是人寫的設定——still，
  // 打錯或寫成 `../` 都不該讓它跑出去。
  it("refuses a project name that is not one path segment", async () => {
    const result = await send("hi", {
      routes: [{ project: "../evil", channel: "telegram", target: TELEGRAM_CHAT }],
      config: { fiat: { projectsDir: projects } },
    });
    assert.match(result.text, /is not a usable project name/);
  });

  it("prefers an explicit command when both are given", async () => {
    seedScript(join("scripts", "intercept.mjs"), `${READ_STDIN}process.stdout.write("wrong one");`);
    const result = await send("hi", projectRoute({ command: ECHO }));
    assert.equal(result.text, "You said hi");
  });

  // .py 走 uv run。測試不能靠這台機器裝了什麼，所以用設定指定一個假的。
  it("runs a .py script through the configured interpreter", async () => {
    seedScript(join("scripts", "intercept.py"), "unused");
    const fakeUv = fixture(dir, "fake-uv.mjs", `process.stdout.write("uv ran " + process.argv.slice(2).join(" "));`);
    const result = await send("hi", {
      routes: [{ project: "ledger", channel: "telegram", target: TELEGRAM_CHAT }],
      config: { fiat: { projectsDir: projects, interpreters: { ".py": fakeUv } } },
    });
    assert.equal(result.text, `uv ran ${join(projects, "ledger", "scripts", "intercept.py")}`);
  });

  it("refuses an interpreter that does not exist", async () => {
    seedScript(join("scripts", "intercept.py"), "unused");
    const result = await send("hi", {
      routes: [{ project: "ledger", channel: "telegram", target: TELEGRAM_CHAT }],
      config: { fiat: { projectsDir: projects, interpreters: { ".py": ["C:/nope/uv.exe", "run"] } } },
    });
    assert.match(result.text, /the interpreter for \.py does not exist/);
  });
});

describe("script outcome", () => {
  it("passes the body through verbatim, without normalizing it", async () => {
    for (const body of ["hi", "  padded  ", "multi\nline", "全形１２３", "emoji 🙂"]) {
      assert.equal((await send(body)).text, `You said ${body}`.trim(), body);
    }
  });

  it("hands the turn to the AI on exit 20", async () => {
    const routes = [{ name: "decline", channel: "telegram", target: TELEGRAM_CHAT, command: DECLINE }];
    assert.equal(await send("hi", { routes }), undefined);
  });

  it("treats empty stdout as handled-but-silent", async () => {
    const routes = [{ name: "silent", channel: "telegram", target: TELEGRAM_CHAT, command: SILENT }];
    assert.deepEqual(await send("callback_data: srd k 763", { routes }), { handled: true });
  });

  it("reports failures to the user by default", async () => {
    const routes = [{ name: "boom", channel: "telegram", target: TELEGRAM_CHAT, command: FAIL }];
    const result = await send("hi", { routes });
    assert.equal(result.handled, true);
    assert.match(result.text, /^boom failed: /);
  });

  it("hands failures to the AI when onError is passthrough", async () => {
    const routes = [{ name: "boom", channel: "telegram", target: TELEGRAM_CHAT, command: FAIL, onError: "passthrough" }];
    assert.equal(await send("hi", { routes }), undefined);
  });
});

describe("per-route serialization", () => {
  it("runs one script at a time so concurrent turns cannot clobber shared state", async () => {
    const counterFile = join(dir, "counter.txt");
    const routes = [
      { name: "counter", channel: "telegram", target: TELEGRAM_CHAT, command: COUNTER, env: { COUNTER_FILE: counterFile } },
    ];
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => send("go", { routes })));
    assert.deepEqual(
      results.map((r) => Number(r.text)).sort((a, b) => a - b),
      [1, 2, 3, 4, 5],
    );
  });
});

describe("payload handed to the script", () => {
  it("carries the conversation identity fields", async () => {
    const dump = fixture(dir, "dump.mjs", `${READ_STDIN}process.stdout.write(JSON.stringify(payload));`);
    const routes = [{ name: "dump", channel: "telegram", target: TELEGRAM_CHAT, command: dump }];
    const result = await send("hi", { routes, senderId: "42", sessionKey: `agent:test-agent:telegram:group:${TELEGRAM_CHAT}` });
    const { send: sender, ...identity } = JSON.parse(result.text);
    assert.deepEqual(identity, {
      body: "hi",
      channel: "telegram",
      target: TELEGRAM_CHAT,
      senderId: "42",
      sessionKey: `agent:test-agent:telegram:group:${TELEGRAM_CHAT}`,
      agentId: "test-agent",
    });
    assert.ok(Array.isArray(sender) && sender.length > 0);
  });
});

// script 要再送訊息（按鈕、圖片、多則）時，用 stdin 給的 `send`：房間已經指定好，送出去的跟 plugin 自己的訊息一樣。
describe("send, for a script's extra messages", () => {
  let notifyLog;
  const sendWith = (options) =>
    fixture(
      dir,
      `send-${++seq}.mjs`,
      `${READ_STDIN}
      const { execFileSync } = await import("node:child_process");
      const [command, ...args] = payload.send;
      execFileSync(command, [...args, ...${JSON.stringify(options)}]);`,
    );
  const run = async (options) => {
    const routes = [{ name: "sender", channel: "telegram", target: TELEGRAM_CHAT, command: sendWith(options) }];
    assert.deepEqual(await send("hi", { routes, config: { fiat: { openclaw: fakeOpenclaw(dir) } } }), { handled: true });
    return readJsonLines(notifyLog);
  };

  beforeEach(() => {
    notifyLog = join(dir, `notify-${seq}.log`);
    process.env.NOTIFY_LOG = notifyLog;
  });

  it("sends into the room, marked like the plugin's own messages", async () => {
    const [argv] = await run(["--message", "要哪一筆？", "--presentation", "{}"]);
    assert.deepEqual(argv, ["--channel", "telegram", "--target", TELEGRAM_CHAT, "--message", `${ASIDE_MARK}要哪一筆？`, "--presentation", "{}"]);
  });

  for (const options of [["-m", "hi"], ["--message=hi"]]) {
    it(`marks ${JSON.stringify(options)} too`, async () => {
      const [argv] = await run(options);
      assert.ok(argv.includes(`${ASIDE_MARK}hi`) || argv.includes(`--message=${ASIDE_MARK}hi`), JSON.stringify(argv));
    });
  }

  it("marks a message that is only a picture", async () => {
    const [argv] = await run(["--media", "chart.png"]);
    assert.deepEqual(argv.slice(4), ["--media", "chart.png", "--message", ASIDE_MARK]);
  });
});

// AI 沒看到的每一句都要記下來，/tap 才還原得了整段對話。
// 反過來，AI 看到的那些 session 裡本來就有，不重複記。
describe("offstage log", () => {
  const strip = ({ ts, ...rest }) => {
    assert.match(ts, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    return rest;
  };

  it("records a turn the script handled, with what it replied", async () => {
    await send("hi", { senderId: "42" });
    assert.deepEqual(readOffstage(offstageLogFile).map(strip), [
      { kind: "script", channel: "telegram", target: TELEGRAM_CHAT, senderId: "42", text: "hi", reply: "You said hi", route: "echo" },
    ]);
  });

  it("records a silent turn with an empty reply", async () => {
    const routes = [{ name: "silent", channel: "telegram", target: TELEGRAM_CHAT, command: SILENT }];
    await send("quietly", { routes });
    const [entry] = readOffstage(offstageLogFile);
    assert.equal(entry.kind, "script");
    assert.equal(entry.reply, "");
  });

  it("records a failed turn with the error the user saw", async () => {
    const routes = [{ name: "boom", channel: "telegram", target: TELEGRAM_CHAT, command: FAIL }];
    await send("hi", { routes });
    const [entry] = readOffstage(offstageLogFile);
    assert.equal(entry.kind, "error");
    assert.match(entry.reply, /^boom failed: boom/);
  });

  it("keeps multi-line messages intact", async () => {
    await send("first\n\nsecond");
    assert.equal(readOffstage(offstageLogFile)[0].text, "first\n\nsecond");
  });

  it("is written without debug", async () => {
    await send("hi", { config: { debug: false } });
    assert.equal(readOffstage(offstageLogFile).length, 1);
  });

  for (const [label, overrides] of [
    ["a declined turn", { routes: [{ name: "decline", channel: "telegram", target: TELEGRAM_CHAT, command: DECLINE }] }],
    [
      "a passthrough failure",
      { routes: [{ name: "boom", channel: "telegram", target: TELEGRAM_CHAT, command: FAIL, onError: "passthrough" }] },
    ],
    ["a room with no route", { routes: [] }],
  ]) {
    it(`leaves out ${label}, which the AI did see`, async () => {
      await send("hi", overrides);
      assert.equal(existsSync(offstageLogFile), false);
    });
  }

  it("never lets a write failure break the turn", async () => {
    // The parent of this path is a regular file, so creating the directory fails.
    const result = await send("hi", { config: { offstageLogFile: join(ECHO[1], "offstage.log") } });
    assert.equal(result.text, "You said hi");
  });
});
