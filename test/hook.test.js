// Router tests. No gateway, no network, no user-supplied scripts:
// every route here runs a throwaway fixture written into a temp directory.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
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

after(() => rmSync(dir, { recursive: true, force: true }));

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

// `ISSUE <anything>` is eaten by the plugin itself: no model, no script, no reply.
// The only trace it leaves is a line in the issue log, which is what /tap reads.
describe("ISSUE", () => {
  let seq = 0;
  /** A fresh issue log per test, so one test's writes cannot be mistaken for another's. */
  const issueLog = () => join(dir, `issues-${++seq}.log`);
  const readIssues = (file) =>
    (existsSync(file) ? readFileSync(file, "utf8") : "")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\{.*\})$/.exec(line);
        assert.ok(match, `issue line is not "<local stamp> <json>": ${line}`);
        return { ts: match[1], ...JSON.parse(match[2]) };
      });

  it("records the issue and says nothing back", async () => {
    const issueLogFile = issueLog();
    const result = await send("ISSUE the keyboard feels slow", { config: { issueLogFile } });
    assert.equal(result.handled, true);
    assert.equal(result.reply, undefined);
    assert.deepEqual(readIssues(issueLogFile), [
      {
        ts: readIssues(issueLogFile)[0].ts,
        text: "the keyboard feels slow",
        channel: "telegram",
        target: TELEGRAM_CHAT,
        route: "echo",
      },
    ]);
  });

  it("never reaches the script", async () => {
    const issueLogFile = issueLog();
    // The default route is ECHO: had the script run, the reply would be "You said …".
    const result = await send("ISSUE do not echo me", { config: { issueLogFile } });
    assert.equal(result.reply, undefined);
  });

  for (const [label, body, text] of [
    ["lowercase", "issue too slow", "too slow"],
    ["newline right after the keyword", "ISSUE\ntoo slow", "too slow"],
    ["no space at all", "ISSUE太慢了", "太慢了"],
    ["multiline", "ISSUE first\n\nsecond", "first\n\nsecond"],
    ["nothing after the keyword", "ISSUE", ""],
    // 冒號不另外判斷：開頭是 ISSUE 就已經涵蓋了，後面接什麼就原樣記什麼。
    ["colon, kept verbatim", "ISSUE: too slow", ": too slow"],
    ["fullwidth colon, kept verbatim", "ISSUE：too slow", "：too slow"],
  ]) {
    it(`accepts the ${label} form`, async () => {
      const issueLogFile = issueLog();
      const result = await send(body, { config: { issueLogFile } });
      assert.equal(result.handled, true);
      assert.equal(readIssues(issueLogFile)[0].text, text);
    });
  }

  // Only a message that starts with the keyword is a marker; a sentence that
  // merely contains the word is an ordinary message and belongs to the script.
  for (const body of ["issues are piling up", "an ISSUE happened", "please file ISSUE 3"]) {
    it(`leaves ${JSON.stringify(body)} to the script`, async () => {
      const issueLogFile = issueLog();
      const result = await send(body, { config: { issueLogFile } });
      assert.equal(result.reply.text, `You said ${body}`);
      assert.equal(existsSync(issueLogFile), false);
    });
  }

  it("ignores ISSUE in rooms this plugin was not applied to", async () => {
    const issueLogFile = issueLog();
    const other = { chatId: OTHER_CHAT, channelId: OTHER_CHAT, sessionKey: `telegram:group:${OTHER_CHAT}` };
    // No route here, so the room has no interceptor: the turn belongs to the AI.
    assert.equal(await send("ISSUE not my room", { ...other, config: { issueLogFile } }), undefined);
    assert.equal(existsSync(issueLogFile), false);
  });

  it("tells the user when the issue could not be written", async () => {
    // The parent of this path is a regular file, so creating the directory fails.
    const issueLogFile = join(dir, "echo.mjs", "issues.log");
    const result = await send("ISSUE nowhere to write this", { config: { issueLogFile } });
    assert.equal(result.handled, true);
    assert.match(result.reply.text, /^ISSUE not recorded: /);
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
