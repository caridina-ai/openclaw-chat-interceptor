// 測試共用。不需要 gateway、網路、Claude Code、Codex 或任何使用者的 script：
// 要跑的東西全是寫進暫存目錄的 fixture。
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASIDE_MARK } from "../src/core.js";
import entry from "../src/index.js";

export const PLUGIN_ID = "openclaw-chat-interceptor";
export const TELEGRAM_CHAT = "-1001234567890";
export const DISCORD_CHAT = "123456789012345678";
export const OTHER_CHAT = "-1009876543210";

export const READ_STDIN = `
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw.replace(/^\\uFEFF/, "").trim() || "{}");
`;

export function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 剛結束的子行程在 Windows 上還抓著檔案；刪不掉也不算測試失敗，那只是暫存目錄。 */
export async function removeLater(dir) {
  await new Promise((resolve) => setTimeout(resolve, 300));
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 60, retryDelay: 100 });
  } catch {
    // 留著就留著
  }
}

/** 寫一支 fixture script，回傳跑它的 argv。 */
export function fixture(dir, name, source) {
  const file = join(dir, name);
  writeFileSync(file, source, "utf8");
  return [process.execPath, file];
}

/**
 * 把 plugin 註冊到一個假的 api 上，拿回 hook、兩個指令與 HTTP 路由。
 * `config` 是 OpenClaw 啟動時的整份設定（/aside 從它認有哪些 channel）；
 * `runtimeConfig` 是 gateway 當下那一份設定（回報路由從那裡取），測試可以隨時換掉它。
 */
export function register({ config = { channels: { telegram: {}, discord: {} } } } = {}) {
  const commands = {};
  const routes = {};
  const hooks = {};
  const api = {
    config,
    pluginConfig: {},
    runtimeConfig: {},
    runtime: { config: { current: () => api.runtimeConfig } },
    logger: { info() {}, warn() {}, error() {} },
    on(name, handler) {
      hooks[name] = handler;
    },
    registerCommand(definition) {
      commands[definition.name] = definition;
    },
    registerHttpRoute(route) {
      routes[route.path] = route;
    },
  };
  entry.register(api);
  assert.ok(hooks.before_dispatch, "before_dispatch handler was not registered");
  assert.deepEqual(Object.keys(hooks), ["before_dispatch"]);
  return { hook: hooks.before_dispatch, commands, routes, api };
}

/** 這個 plugin 送出去的每一則開頭都帶記號：驗過再拿掉，其餘的測試只看內容。 */
export function unmark(text) {
  assert.ok(String(text).startsWith(ASIDE_MARK), `not marked as an aside: ${JSON.stringify(text)}`);
  return text.slice(ASIDE_MARK.length);
}

/** 把一條 plugin 的 HTTP 路由掛在本機的隨機 port 上，回傳它的網址與關掉它的方法。 */
export async function serveRoute(route) {
  const server = createServer((req, res) => {
    if (new URL(req.url, "http://x").pathname !== route.path) {
      res.statusCode = 404;
      res.end();
      return;
    }
    route.handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${server.address().port}${route.path}`, close: () => new Promise((resolve) => server.close(resolve)) };
}

/** offstage log 一行一筆 `<當地時間> <JSON>`。 */
export function readOffstage(file) {
  return (existsSync(file) ? readFileSync(file, "utf8") : "")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) (\{.*\})$/.exec(line);
      assert.ok(match, `offstage line is not "<local stamp> <json>": ${line}`);
      return { ts: match[1], ...JSON.parse(match[2]) };
    });
}

export const readJson = (file) => {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null; // 還在寫
  }
};

/** 一行一筆 JSON 的紀錄檔（fixture 用 appendFileSync 寫的那種）。 */
export const readJsonLines = (file) =>
  (existsSync(file) ? readFileSync(file, "utf8") : "")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/** 背景跑的東西，等它的產物出現，而不是等呼叫的人回來。 */
export async function waitFor(read, label) {
  for (let i = 0; i < 400; i += 1) {
    const value = read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`timed out waiting for ${label}`);
}

// Windows 的 temp 目錄可能是 8.3 短檔名，子行程回報的卻是長的。
export const samePath = (a, b) => realpathSync(a).toLowerCase() === realpathSync(b).toLowerCase();

/**
 * 假的 ccrun／cdrun（兩支介面一樣）。每一次被叫都在 RUNNER_LOG 記一行，帶著自己的名字：
 *   -d <dir> <prompt>   印出 pid（RUNNER_PID，預設 4242）；RUNNER_FAIL 有值就失敗
 *   -p <pid> -s         pid 列在 RUNNER_ALIVE 裡才成功
 *   -p <pid> <text>     同上，成功時記下打了什麼
 *   -p <pid> -q         同上，記下來；RUNNER_QUIT_FAIL 有值就失敗
 *   -m <from> <to>      記下來；跟真的一樣，目錄要先搬好（to 在、from 不在）。RUNNER_MOVE_FAIL 是自己的名字就失敗
 */
export function fakeRunner(dir, name) {
  return fixture(
    dir,
    `${name}.mjs`,
    `
    const fs = await import("node:fs");
    const args = process.argv.slice(2);
    const log = (entry) => fs.appendFileSync(process.env.RUNNER_LOG, JSON.stringify({ runner: "${name}", ...entry }) + "\\n", "utf8");
    if (args[0] === "-m") {
      log({ mode: "move", from: args[1], to: args[2] });
      if (!fs.existsSync(args[2]) || fs.existsSync(args[1])) { process.stderr.write("${name}: move the directory first"); process.exit(1); }
      if (process.env.RUNNER_MOVE_FAIL === "${name}") { process.stderr.write("${name}: cannot move\\nusage: ${name} …"); process.exit(1); }
      process.exit(0);
    }
    if (args[0] === "-d") {
      await new Promise((r) => setTimeout(r, Number(process.env.RUNNER_DELAY || 0)));
      log({ mode: "launch", dir: args[1], prompt: args[2], report: process.env.FIAT_REPORT, context: process.env.FIAT_CONTEXT });
      if (process.env.RUNNER_FAIL) { process.stderr.write(process.env.RUNNER_FAIL); process.exit(1); }
      process.stdout.write((process.env.RUNNER_PID || "4242") + "\\n");
      process.exit(0);
    }
    const alive = String(process.env.RUNNER_ALIVE || "").split(",").includes(args[1]);
    if (!alive) { process.stderr.write("pid " + args[1] + " is not a session of mine"); process.exit(1); }
    if (args[2] === "-q") {
      log({ mode: "quit", pid: Number(args[1]) });
      if (process.env.RUNNER_QUIT_FAIL) { process.stderr.write(process.env.RUNNER_QUIT_FAIL); process.exit(1); }
    } else if (args[2] !== "-s") log({ mode: "inject", pid: Number(args[1]), text: args[2] });
    process.exit(0);`,
  );
}

/**
 * 假的 `openclaw` CLI，只會三件事：
 *   message send …                         把 send 之後的參數記進 NOTIFY_LOG，一行一次
 *   message read … --limit N [--before id] 從 FAKE_HISTORY（JSON 陣列，新的在前）翻一頁，印出跟真的一樣的外殼；
 *                                          參數記進 HISTORY_LOG。FAKE_HISTORY_ERROR 有設：照真的那樣失敗
 *   skills install <dir> --force --agent X  複製進 FAKE_WORKSPACE/<agent>/skills/<slug>，
 *                                          記進 INSTALL_LOG，印出跟真的一樣的那一行
 *                                          FAKE_INSTALL_EPERM 有設：學 Windows 上真的發生過的那樣，
 *                                          舊的那份搬走了、新的改名失敗、也沒還原回去
 */
export function fakeOpenclaw(dir) {
  return fixture(
    dir,
    "openclaw.mjs",
    `
    const fs = await import("node:fs");
    const path = await import("node:path");
    const args = process.argv.slice(2);
    if (args[0] === "message" && args[1] === "send") {
      fs.appendFileSync(process.env.NOTIFY_LOG, JSON.stringify(args.slice(2)) + "\\n", "utf8");
      process.exit(0);
    }
    if (args[0] === "message" && args[1] === "read") {
      const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
      if (process.env.HISTORY_LOG) fs.appendFileSync(process.env.HISTORY_LOG, JSON.stringify(args.slice(2)) + "\\n", "utf8");
      if (process.env.FAKE_HISTORY_ERROR) {
        process.stderr.write("[openclaw] The CLI command failed.\\n[openclaw] Reason: Error: " + process.env.FAKE_HISTORY_ERROR + "\\n[openclaw] Try: openclaw doctor\\n");
        process.exit(1);
      }
      const all = JSON.parse(fs.readFileSync(process.env.FAKE_HISTORY, "utf8"));
      const from = opt("--before") ? all.findIndex((m) => m.id === opt("--before")) + 1 : 0;
      const messages = all.slice(from, from + Number(opt("--limit") || 50));
      process.stdout.write(JSON.stringify({ action: "read", channel: opt("--channel"), handledBy: "plugin", payload: { ok: true, messages } }, null, 2));
      process.exit(0);
    }
    if (args[0] === "skills" && args[1] === "install") {
      const source = args[2];
      const agent = args.includes("--agent") ? args[args.indexOf("--agent") + 1] : "default";
      const name = /^name:\\s*"?([^"\\r\\n]+?)"?\\s*$/m.exec(fs.readFileSync(path.join(source, "SKILL.md"), "utf8"))?.[1];
      const slug = name || path.basename(source);
      const target = path.join(process.env.FAKE_WORKSPACE, agent, "skills", slug);
      if (fs.existsSync(target) && !args.includes("--force")) { process.stderr.write("already installed"); process.exit(1); }
      fs.rmSync(target, { recursive: true, force: true });
      if (process.env.FAKE_INSTALL_EPERM) { process.stderr.write("failed to install skill: Error: EPERM: operation not permitted, rename"); process.exit(1); }
      fs.cpSync(source, target, { recursive: true });
      if (process.env.INSTALL_LOG) fs.appendFileSync(process.env.INSTALL_LOG, JSON.stringify({ source, agent, force: args.includes("--force") }) + "\\n", "utf8");
      process.stdout.write("Installed " + slug + " from path -> " + target + "\\n");
      process.exit(0);
    }
    process.stderr.write("unexpected: " + args.join(" "));
    process.exit(1);`,
  );
}

/** 一個專案裡的 skill：`<專案>/<skill>/SKILL.md` 與 `scripts/intercept.mjs`。回傳 skill 目錄。 */
export function seedSkill(projectDir, name, script) {
  const skill = join(projectDir, name);
  mkdirSync(join(skill, "scripts"), { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n\n# ${name}\n`, "utf8");
  if (script !== null) writeFileSync(join(skill, "scripts", "intercept.mjs"), script ?? "process.exit(20);", "utf8");
  return skill;
}
