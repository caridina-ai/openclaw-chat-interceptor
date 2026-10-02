// openclaw-chat-interceptor
//
// before_dispatch 在訊息交給 agent 之前觸發，比 OpenClaw 處理斜線指令、把這句話
// 寫進 session 都早。回傳 { handled: true, text? } 就到此為止：不寫進 session 歷史、
// 不進模型，所以這條路徑是 0 token，也不受「群組裡一定要回話」的規則管。
// 回傳 undefined 則什麼都沒發生，對話照原本的流程交給 AI。
//
// 2026.9 以前用的是 before_agent_reply。新版在呼叫它之前就先把使用者那句寫進
// session（script 接走的話 AI 照樣看得到），不回話還會被補一句「沒有產生回覆」。
//
// 本檔做三件事：
//   1. 依房間挑出 route，把訊息餵給那支 script，再依 exit code 決定「處理掉」還是
//      「放行給 AI」。AI 沒看到的那些，一律記進 offstage log。斜線指令不送 script。
//   2. `/aside`：OpenClaw 的 slash command。留一句話，AI 與 script 都收不到，
//      只記進 offstage log。
//   3. `/fiat`：OpenClaw 的 slash command。用 ccrun 叫起 Claude Code，請它施展
//      /tap 技能，把房間裡聊出來的東西做成軟體。
// 所有領域邏輯都在 script 裡，所有需要智力的判斷都在 Claude Code 裡。

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_PROJECTS_FILE,
  deriveRoute,
  inject,
  installSkill,
  launch,
  localStamp,
  lower,
  normalizeTarget,
  notify,
  patchRoom,
  patchTap,
  quit,
  readIndex,
  readTap,
  removeInstalledSkill,
  roomKey,
  sessionAlive,
  skillDirOf,
  tapFileOf,
  writeTap,
} from "./core.js";

const PLUGIN_ID = "openclaw-chat-interceptor";
const DEFAULT_LOG_FILE = join(homedir(), ".openclaw", "logs", "chat-interceptor.log");
const DEFAULT_OFFSTAGE_LOG_FILE = join(homedir(), ".openclaw", "logs", "chat-interceptor-offstage.log");
const DEFAULT_TIMEOUT_MS = 15_000;

/** Claude Code 每一段結束時呼叫的回報程式。/fiat 叫起 session 時把路徑交給它。 */
const REPORT_PATH = fileURLToPath(new URL("./report.mjs", import.meta.url));

/** script 用這個 exit code 說「這句我不會，請交給 AI」。 */
const EXIT_PASS = 20;

/**
 * 專案名會直接接在 `projectsDir` 後面當路徑用，而它來自不受信任的聊天輸入，
 * 所以只收「一段自明的名字」：開頭必須是英數，因此不可能是 `.`、`..`
 * 或 `-rf`，中間也不允許任何路徑分隔字元。
 */
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** `-t` 的起點：日期，後面可以接到分或到秒的時間。 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}(:\d{2})?$/;

const FIAT_USAGE =
  "Use /fiat [projname] [-t yyyy-mm-dd HH:MM] [-go], /fiat ?, /fiat -install [projname], /fiat -uninstall or /fiat -done.";

/**
 * debug 為 true 時把每一輪的判斷寫進 logFile。
 * 寫檔失敗只能吞掉，不能反過來炸掉對話。
 */
function createTracer(config, logger) {
  const enabled = config.debug === true;
  const file = config.logFile || DEFAULT_LOG_FILE;
  return (message, data) => {
    if (!enabled) return;
    const line = `[${new Date().toISOString()}] ${message}${data === undefined ? "" : ` ${JSON.stringify(data)}`}`;
    logger?.info?.(`[${PLUGIN_ID}] ${line}`);
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${line}\n`, "utf8");
    } catch {
      // 寫不進 log 就算了
    }
  };
}

/**
 * 記下一句 AI 沒看到的話，回傳錯誤訊息（空字串＝寫進去了）。
 *
 * 被 script 接走的、script 出錯而回了錯誤訊息的、`/aside`——這三種都不進 session，
 * 事後只有這裡有。`/tap` 把它跟 session 檔合起來，才還原得了整段對話。
 * 所以它**一直開著**，不看 `debug`。一行一筆 `<當地時間> <JSON>`：多行原文照原樣
 * 保留，又不必自己發明跳脫規則。
 */
function recordOffstage(config, entry) {
  const file = config.offstageLogFile || DEFAULT_OFFSTAGE_LOG_FILE;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${localStamp()} ${JSON.stringify(entry)}\n`, "utf8");
    return "";
  } catch (error) {
    return String(error?.message || error);
  }
}

const fiatConfigOf = (config) => (config.fiat && typeof config.fiat === "object" ? config.fiat : null);

/** ctx.chatId 沒給時，退一步從 sessionKey `<channel>:<group|channel>:<rawId>` 取。 */
function resolveRuntimeTarget(ctx) {
  const direct = ctx?.chatId ?? ctx?.channelId;
  if (direct) return String(direct);
  return targetFromSessionKey(ctx?.sessionKey);
}

function targetFromSessionKey(sessionKey) {
  const parts = String(sessionKey ?? "").split(":");
  const start = parts[0]?.toLowerCase() === "agent" ? 2 : 0;
  const kind = parts[start + 1]?.toLowerCase();
  if (kind !== "group" && kind !== "channel") return "";
  return parts.slice(start + 2).join(":");
}

/** 這條 route（或這個 `.tap`）綁的是不是這個房間。target 兩邊都正規化過再比。 */
function boundTo(spec, room) {
  if (spec?.channel && lower(spec.channel) !== lower(room.channel)) return false;
  const providers = [spec?.channel, room.channel];
  return normalizeTarget(spec?.target, ...providers) === normalizeTarget(room.target, ...providers);
}

/**
 * 挑這個房間的 route；沒有就回 undefined（整輪放行給 AI）。
 *
 * 兩個來源，設定優先：
 *   1. `config.routes`——人手寫的，什麼都能設。
 *   2. 對照表裡 `installed` 的那一筆——`/fiat -install` 或回報程式裝的。跑的是裝進
 *      OpenClaw 的那一份（`installedDir`），不是開發目錄。
 *
 * **為什麼上線不寫進 openclaw.json**：plugin config 不會 hot reload。實測過：
 * 設定檔在 17:01 改好，17:02 進來的訊息還是走舊的 route，要重啟 gateway 才算數。
 * 對照表則是每一則訊息都重讀一次，所以裝上、拆掉都**當場生效**。
 */
function selectRoute(ctx, config) {
  const room = { channel: ctx?.channel ?? ctx?.messageProvider ?? "", target: resolveRuntimeTarget(ctx) };
  const configured = configuredRoute(config, room);
  if (configured) return configured;

  const fiatConfig = fiatConfigOf(config);
  if (!fiatConfig) return undefined;
  const entry = readIndex(fiatConfig.projectsFile || DEFAULT_PROJECTS_FILE)[roomKey(room)];
  if (!entry?.installed || !entry.installedDir) return undefined;
  return { project: entry.skill ?? entry.name, dir: entry.installedDir, channel: room.channel, target: room.target };
}

/** 設定裡手寫的、綁這個房間的 route。 */
function configuredRoute(config, room) {
  const routes = Array.isArray(config.routes) ? config.routes : [];
  return routes.find((route) => {
    // target 沒設，或既沒 command 也沒 project 的 route 一律略過——
    // 寧可多花 token，也不要亂攔。
    const runnable = (Array.isArray(route?.command) && route.command.length > 0) || Boolean(route?.project);
    if (!route?.target || !runnable) return false;
    const providers = [route.channel, room.channel];
    if (route.channel && lower(room.channel) !== lower(route.channel)) return false;
    return normalizeTarget(room.target, ...providers) === normalizeTarget(route.target, ...providers);
  });
}

/**
 * route 在 trace 與錯誤訊息裡叫什麼。
 *
 * 只寫 `project` 的 route 沒有 `name`——少了這個 fallback，log 裡每一行都會寫
 * `route: null`，看起來就像「沒有 route 對上」。
 */
const routeLabel = (route) => route?.name ?? route?.project ?? null;

const routeKey = (route) => `${lower(route.channel)}|${route.target}`;

// 同一個 route 一次只跑一支 script：記帳會寫 DB，兩則訊息同時進來會打架。
const routeQueues = new Map();

function enqueue(key, task) {
  const previous = routeQueues.get(key) ?? Promise.resolve();
  const next = previous.then(task, task);
  // 不讓 queue 因為某一輪失敗就卡死，也避免 unhandled rejection。
  routeQueues.set(
    key,
    next.then(
      () => {},
      () => {},
    ),
  );
  return next;
}

/**
 * 這條 route 實際要跑什麼。
 *
 * 寫了 `command` 就照寫的跑——那是完全自由的逃生口。只寫 `project` 的話，
 * script 的位置與直譯器都照約定推出來，**而且是每次派工時才推**：
 * 使用者換了 node 版本、重裝了 uv，設定檔一個字都不必改。
 */
function resolveRouteCommand(config, route) {
  if (Array.isArray(route.command) && route.command.length) return { command: route.command };
  const fiatConfig = fiatConfigOf(config);
  let dir = route.dir;
  if (!dir) {
    const projectsDir = String(fiatConfig?.projectsDir ?? "").trim();
    if (!projectsDir) return { error: `route "${route.project}" needs fiat.projectsDir to be set` };
    if (!PROJECT_RE.test(String(route.project))) return { error: `"${route.project}" is not a usable project name` };
    dir = join(projectsDir, String(route.project));
    dir = skillDirOf(dir).dir ?? dir;
  }
  return deriveRoute(fiatConfig?.interpreters, { name: String(route.project), dir });
}

/**
 * 跑 route 的 script：payload 走 stdin JSON、回覆走 stdout。
 *
 * 不用 argv 傳使用者輸入——Windows 的 argv quoting 很容易出事，而且使用者
 * 的訊息是不受信任的輸入。
 */
function runRoute(route, command, payload) {
  const [executable, ...args] = command;
  return new Promise((resolve) => {
    const child = execFile(
      executable,
      args,
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: route.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        cwd: route.cwd || undefined,
        env: { ...process.env, ...(route.env ?? {}) },
      },
      (error, stdout, stderr) => {
        resolve({
          // 非零離開時 error.code 是 exit code；spawn 失敗時是 'ENOENT' 這種字串。
          exitCode: typeof error?.code === "number" ? error.code : error ? -1 : 0,
          failure: error ? String(error.stderr || stderr || error.message || error).trim() : "",
          stdout: (stdout ?? "").trim(),
        });
      },
    );
    // script 不讀 stdin 就直接結束時會 EPIPE，這不是錯。
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(payload), "utf8");
  });
}

/**
 * before_dispatch 的入口：把它的 event / ctx 轉成 runInterceptedRoute 認得的樣子
 * （agentId 它沒給，從 sessionKey `agent:<id>:…` 取），再把結果轉回它要的形狀。
 */
async function beforeDispatch(api, event, ctx) {
  const body = String(event?.body ?? event?.content ?? "");
  // 斜線指令是 OpenClaw 的。這個 hook 跑在指令處理之前，送進 script 的話，
  // 「其他的話都由我回」的 script 會把 /new、/status 吃掉。
  if (body.trimStart().startsWith("/")) return;
  const sessionKey = ctx?.sessionKey ?? event?.sessionKey ?? "";
  const result = await runInterceptedRoute(api, { cleanedBody: body }, {
    ...ctx,
    channel: event?.channel ?? ctx?.channelId ?? "",
    chatId: ctx?.conversationId || targetFromSessionKey(sessionKey),
    sessionKey,
    senderId: ctx?.senderId ?? event?.senderId,
    agentId: sessionKey.startsWith("agent:") ? sessionKey.split(":")[1] : "",
  });
  if (!result?.handled) return;
  return { handled: true, ...(result.reply?.text ? { text: result.reply.text } : {}) };
}

async function runInterceptedRoute(api, event, ctx) {
  const config = ctx?.pluginConfig ?? api.pluginConfig ?? {};
  const trace = createTracer(config, api.logger);
  const channel = ctx?.channel ?? ctx?.messageProvider ?? "";
  const target = resolveRuntimeTarget(ctx);
  const body = String(event?.cleanedBody ?? "");

  const route = selectRoute(ctx, config);
  trace("turn", { body, channel, target, sessionKey: ctx?.sessionKey, route: routeLabel(route) });
  if (!route) return;

  // 原樣送出，不做 normalize——各 script 自己決定怎麼解讀。
  const payload = {
    body,
    channel,
    target,
    senderId: ctx?.senderId ?? "",
    sessionKey: ctx?.sessionKey ?? "",
    agentId: ctx?.agentId ?? "",
  };

  // 只寫 project 的 route，要跑什麼是現在才推出來的。推不出來（script 還沒寫、
  // 直譯器不在）就當成這一輪出錯，照 onError 處理——不要默默放行，
  // 使用者會以為 script 判斷過了。
  const resolved = resolveRouteCommand(config, route);
  let result;
  if (resolved.error) {
    result = { exitCode: -1, failure: resolved.error, stdout: "" };
  } else {
    try {
      result = await enqueue(routeKey(route), () => runRoute(route, resolved.command, payload));
    } catch (error) {
      result = { exitCode: -1, failure: String(error?.message || error), stdout: "" };
    }
  }

  if (result.exitCode === EXIT_PASS) {
    trace("pass: script declined", { route: routeLabel(route) });
    return;
  }

  // 從這裡往下，這一輪都不會進 session：script 接走了，或回了錯誤訊息。
  const offstage = (kind, reply) => {
    const failure = recordOffstage(config, {
      kind,
      channel,
      target,
      senderId: payload.senderId,
      text: body,
      reply,
      route: routeLabel(route),
    });
    if (failure) trace("offstage: write failed", { failure });
  };

  if (result.exitCode !== 0) {
    // 預設把錯誤也算 handled：script 可能已經有副作用（例如記帳寫了一半），
    // 放行給 AI 會讓 AI 再做一次。無副作用的 script 才適合 passthrough。
    if (route.onError === "passthrough") {
      trace("pass: script failed", { route: routeLabel(route), exitCode: result.exitCode, failure: result.failure });
      return;
    }
    trace("error", { route: routeLabel(route), exitCode: result.exitCode, failure: result.failure });
    const text = `${routeLabel(route) ?? "script"} failed: ${result.failure}`;
    offstage("error", text);
    return { handled: true, reply: { text }, reason: `chat-interceptor: ${routeLabel(route) ?? "script"} failed` };
  }

  trace("handled", { route: routeLabel(route), stdout: result.stdout });
  offstage("script", result.stdout);
  // stdout 空的就是「處理掉但不回話」：回給 before_dispatch 的就是不帶 text 的 handled。
  return {
    handled: true,
    ...(result.stdout ? { reply: { text: result.stdout } } : {}),
    reason: `chat-interceptor: ${routeLabel(route) ?? "script"}`,
  };
}

// ---------------------------------------------------------------------------
// slash command 共用
// ---------------------------------------------------------------------------

/** 指令拿不到 ctx.pluginConfig，從整份設定裡取本 plugin 那一段——那份是每次重讀的。 */
const commandConfigOf = (api, ctx) => ctx?.config?.plugins?.entries?.[PLUGIN_ID]?.config ?? api.pluginConfig ?? {};

/**
 * 指令是從哪個房間打的。算法要跟 hook 對得上，對照表的 key 才會是同一個。
 * `ctx.to` 是 `telegram:-100…` 這種帶 provider 的寫法，正規化之後就是 hook 看到的裸 id。
 */
function commandRoom(ctx) {
  const channel = lower(ctx?.channel);
  const raw = ctx?.to || targetFromSessionKey(ctx?.sessionKey) || ctx?.from || "";
  return { channel, target: normalizeTarget(raw, channel) };
}

// ---------------------------------------------------------------------------
// `/aside`
// ---------------------------------------------------------------------------
// 留一句話在房間裡，**但誰都不要處理它**。名字取自戲劇的「旁白」：說出口、留在
// 劇本裡，但台上其他角色聽不見。它留在 offstage log 裡（`/tap` 撈得回來），
// AI 與 script 都收不到，也不回話。每個房間的行為都一樣。

function aside(api, ctx) {
  const room = commandRoom(ctx);
  const failure = recordOffstage(commandConfigOf(api, ctx), {
    kind: "aside",
    channel: room.channel,
    target: room.target,
    senderId: ctx?.senderId ?? "",
    text: String(ctx?.args ?? "").trim(),
  });
  // 寫失敗一定要說。使用者要的是「記一下、不要有反應」，
  // 但「沒記到卻也沒反應」就是把他的話默默弄丟了。
  return failure ? { text: `aside not recorded: ${failure}` } : { suppressReply: true };
}

// ---------------------------------------------------------------------------
// `/fiat`
// ---------------------------------------------------------------------------
// 在房間裡聊著聊著，軟體就生出來了：
//
//   /fiat [projname] [-t yyyy-mm-dd HH:MM] [-go]   叫起 Claude Code，注入 `/tap [起點]`
//   /fiat ?                                        只查不做：這個房間綁了什麼、裝了什麼、session 開著沒有
//   /fiat -install [projname]                      把專案的 skill 裝進 OpenClaw，並在這個房間上線
//   /fiat -uninstall                               下線、拿掉裝上去的 skill，解除綁定
//   /fiat -done                                    驗收過了：請它 commit、寫交接 memory
//
// `-go` 只有一個意思：這個房間的專案，接下來一路自動做到裝好。還沒開 session 就叫起
// 連續版（FIAT 文件寫好由回報程式注入 `go`）；已經開著——例如停在 FIAT 文件等人看——
// 就注入 `go` 請它接著做。主述者在 Remote Control 打 `go` 也一樣，但那條路壞了、
// 或 FIAT 文件一時看不到的時候，房間裡的 `/fiat -go` 是唯一讓它繼續的辦法。
//
// 起點一定要帶 `-t`：`/fiat 2026-09-28` 沒有它，就分不出是起點還是一個叫 2026-09-28 的專案。
// 忘了帶的時候（常常會），回話直接給出補好的那一句。
//
// Claude Code 那一側只會收到固定的 `/tap [起點]`、`go`、`/tap -done`，
// 其餘的說明都寫在 /tap 的 SKILL.md。它每一段結束會呼叫回報程式（report.mjs），
// 安裝、連續版的下一步、更新 timestamp、關掉 session 都在那裡。

/** 叫起中的房間。ccrun 要等 session 真的能打字才回來，那段時間裡不能再叫一次。 */
const starting = new Set();

function parseFiat(args) {
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  const parsed = { name: null, since: null, go: false, verb: null };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (DATE_RE.test(token)) {
      const fixed = [...tokens.slice(0, i), "-t", ...tokens.slice(i)].join(" ");
      return { error: `a start time needs -t. Did you mean: /fiat ${fixed}` };
    }
    // 手機上常常打成全形的「？」。
    if ((token === "?" || token === "？") && !parsed.verb) {
      parsed.verb = "status";
      continue;
    }
    if (!token.startsWith("-")) {
      if (parsed.name) return { error: `unexpected "${token}". ${FIAT_USAGE}` };
      parsed.name = token;
      continue;
    }
    const flag = lower(token).replace(/^-+/, "");
    if (flag === "t") {
      const [date, time] = [tokens[i + 1], tokens[i + 2]];
      if (!DATE_RE.test(date ?? "")) return { error: "-t needs a start: -t yyyy-mm-dd HH:MM" };
      parsed.since = TIME_RE.test(time ?? "") ? `${date} ${time}` : date;
      i += parsed.since === date ? 1 : 2;
    } else if (flag === "go") {
      parsed.go = true;
    } else if ((flag === "install" || flag === "uninstall" || flag === "done") && !parsed.verb) {
      parsed.verb = flag;
    } else {
      return { error: `unknown option "${token}". ${FIAT_USAGE}` };
    }
  }
  const { name, since, go, verb } = parsed;
  if (verb === "install" && (since || go)) return { error: "-install takes nothing but a project name." };
  if ((verb === "uninstall" || verb === "done") && (name || since || go)) return { error: `-${verb} takes no arguments.` };
  if (verb === "status" && (name || since || go)) return { error: "? takes no arguments." };
  if (name && !PROJECT_RE.test(name)) {
    return { error: `"${name}" is not a usable project name (one path segment: letters, digits, dot, dash, underscore).` };
  }
  return parsed;
}

/**
 * 專案的 `.tap` 要指著這個房間：/tap 汲取的就是它指的那個房間。
 * 沒有就寫一份；指著別的房間（專案被裝到新房間來了）就改成這裡，timestamp 留著。
 */
function ensureTap(dir, room) {
  const file = tapFileOf(dir);
  if (!file) {
    writeTap(join(dir, "genesis", ".tap"), room);
    return null;
  }
  if (boundTo(readTap(file), room)) return null;
  patchTap(file, { channel: room.channel, target: room.target });
  return file;
}

async function fiat(api, ctx) {
  const config = commandConfigOf(api, ctx);
  const fiatConfig = fiatConfigOf(config);
  if (!fiatConfig) return { text: "fiat: add a fiat block to the plugin config first." };
  // 這一句會在這台機器上叫起一個能改檔案的 agent，所以允許誰下這個指令
  // 是設定要管的事。沒設 allowFrom 就是「OpenClaw 認可的人都可以」。
  const allowFrom = Array.isArray(fiatConfig.allowFrom) ? fiatConfig.allowFrom.map(String) : null;
  if (allowFrom && !allowFrom.includes(String(ctx?.senderId ?? ""))) {
    return { text: "fiat: this account is not allowed to run fiat here." };
  }
  const projectsDir = String(fiatConfig.projectsDir ?? "").trim();
  if (!projectsDir) return { text: "fiat: set fiat.projectsDir in the plugin config first." };
  const room = commandRoom(ctx);
  if (!room.channel || !room.target) return { text: "fiat: cannot tell which room this is." };

  const parsed = parseFiat(ctx?.args);
  if (parsed.error) return { text: `fiat: ${parsed.error}` };

  const key = roomKey(room);
  const entry = readIndex(fiatConfig.projectsFile || DEFAULT_PROJECTS_FILE)[key] ?? null;
  const settings = {
    projectsDir,
    projectsFile: fiatConfig.projectsFile || DEFAULT_PROJECTS_FILE,
    ccrun: fiatConfig.ccrun,
    openclaw: fiatConfig.openclaw,
    interpreters: fiatConfig.interpreters,
    // skill 裝進這個房間的 agent 的 workspace。房間沒有另外綁 agent 時，OpenClaw 給的是預設的那個。
    agent: ctx?.agentId || entry?.agent || undefined,
  };
  if (parsed.verb === "status") return { text: await status(config, settings, room, key, entry) };
  if (starting.has(key)) return { text: `fiat: Claude Code for ${entry?.name ?? "this room"} is still starting.` };

  if (parsed.verb === "uninstall") return { text: await uninstall(config, settings, room, key, entry) };
  if (parsed.verb === "install") return { text: await install(settings, room, key, entry, parsed.name) };

  const open = entry?.pid && (await sessionAlive(settings.ccrun, entry.pid)) ? entry.pid : null;
  if (parsed.verb === "done") {
    if (!open) {
      if (entry?.pid) patchRoom(settings.projectsFile, key, { pid: undefined, closing: undefined });
      return { text: `fiat: no Claude Code session is open for ${entry?.name ?? "this room"}.` };
    }
    // 回報程式已經標了「可以關了」卻還開著（gateway 在那之間重啟過、或上一次沒關成）：直接關。
    if (entry.closing) return { text: await close(settings, room, key, entry) };
    const text = await ask(settings, entry, "/tap -done", "commit and wrap up. It reports here when it is done.");
    closeWhenDone(settings, room, key, entry);
    return { text };
  }
  if (open && parsed.go && !parsed.since && (!parsed.name || parsed.name === entry.name)) {
    // 不管它正在做什麼都直接打：它做完手上這一段（還在汲取就先把 FIAT 寫完），自然會接著做。
    return { text: await ask(settings, entry, "go", "go on and implement the FIAT. It reports here when it is built.") };
  }
  if (open) {
    return {
      text: `fiat: Claude Code is already open for ${entry.name} (pid ${open}). /fiat -go (or go in Claude Code) to implement, /fiat -done to finish.`,
    };
  }
  return { text: startRound(settings, room, key, entry, parsed) };
}

/**
 * `/fiat ?`：這個房間現在是什麼狀況。只讀，不叫起、不改任何東西。
 * 路徑一律不給——房間裡的人看得到，而它們帶著這台機器的目錄結構。
 */
async function status(config, settings, room, key, entry) {
  const lines = [`project: ${entry?.name ?? "none"}`];
  if (entry) {
    lines.push(`installed: ${entry.installed ? (entry.skill ?? entry.name) : "no"}`);
    const alive = entry.pid && (await sessionAlive(settings.ccrun, entry.pid));
    const session = starting.has(key) ? "starting" : alive ? `pid ${entry.pid}${entry.closing ? ", closing" : ""}` : "not running";
    lines.push(`Claude Code: ${session}`);
    const tapFile = existsSync(entry.dir) ? tapFileOf(entry.dir) : null;
    lines.push(`timestamp: ${(tapFile && readTap(tapFile).timestamp) || "none"}`);
  }
  // 手寫的 route 比綁定的專案優先：有的話一定要列，否則「project: none」會讓人以為沒有 script 在攔。
  const route = configuredRoute(config, room);
  if (route) lines.push(`route: ${routeSkillName(route)} (openclaw.json)`);
  return lines.join("\n");
}

/** 手寫 route 的 script 在哪個 skill 底下：`…/<skill>/scripts/intercept.js` 的 `<skill>`。 */
function routeSkillName(route) {
  if (route.project) return String(route.project);
  const script = [...route.command].reverse().find((arg) => /[\\/]/.test(String(arg)));
  if (!script) return route.name ?? "script";
  const dir = dirname(String(script));
  return basename(lower(basename(dir)) === "scripts" ? dirname(dir) : dir);
}

/**
 * 關 session 是 gateway 的事：它叫起的，把手在它這裡，而且它在 session 外面。
 * `ccrun -q` 打 `/exit`，十秒內沒走就直接結束——卡在確認對話框的 session 也關得掉。
 */
async function close(settings, room, key, entry) {
  const result = await quit(settings.ccrun, entry.pid);
  patchRoom(settings.projectsFile, key, { pid: undefined, closing: undefined });
  if (result.ok) return `fiat: Claude Code for ${entry.name} is closed.`;
  return `fiat: could not close Claude Code for ${entry.name} (pid ${entry.pid}): ${result.failure}`;
}

/** 正在等回報程式標 closing 的房間：同一個房間只要一個人在等。 */
const closers = new Set();

/**
 * `/fiat -done` 之後在背景等：回報程式在 session 裡標了 `closing`，就從外面把它關掉。
 * 標完之後 session 通常還在把這一輪講完，所以先讓它講一會兒；`ccrun -q` 的十秒寬限之後
 * 還沒結束，就是被強制結束——它該存的 commit、memory、timestamp 在回報之前都存好了。
 */
function closeWhenDone(settings, room, key, entry) {
  const closer = `${settings.projectsFile}|${key}|${entry.pid}`;
  if (closers.has(closer)) return;
  closers.add(closer);
  const poll = Number(process.env.FIAT_CLOSE_POLL_MS ?? 5_000);
  const grace = Number(process.env.FIAT_CLOSE_GRACE_MS ?? 20_000);
  const deadline = Date.now() + 2 * 60 * 60_000;
  // 等待本身不該讓任何行程為它活著。
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());
  (async () => {
    try {
      while (Date.now() < deadline) {
        await wait(poll);
        const now = readIndex(settings.projectsFile)[key];
        if (!now || now.pid !== entry.pid) return; // 換人了，或已經被關掉
        if (!now.closing) continue;
        await wait(grace);
        const text = await close(settings, room, key, now);
        if (!/is closed\.$/.test(text)) await notify(settings.openclaw, room, text);
        return;
      }
    } finally {
      closers.delete(closer);
    }
  })();
}

async function ask(settings, entry, prompt, what) {
  const sent = await inject(settings.ccrun, entry.pid, prompt);
  if (!sent.ok) return `fiat: could not reach Claude Code (pid ${entry.pid}): ${sent.failure}`;
  return `fiat: asked Claude Code to ${what}`;
}

/** `/fiat [projname] [-t …] [-go]`：決定是哪個專案，然後叫起 Claude Code。 */
function startRound(settings, room, key, entry, { name, since, go }) {
  let project;
  let created = false;
  if (name) {
    // 換綁定只有一條路：-uninstall 再 -install。直接 `/fiat 別的專案` 太容易混淆。
    if (entry && entry.name !== name) {
      return `fiat: this room belongs to ${entry.name}. To switch: /fiat -uninstall, then /fiat -install ${name}.`;
    }
    const dir = entry ? entry.dir : join(settings.projectsDir, name);
    if (!existsSync(dir)) {
      created = true;
    } else if (!entry) {
      // 已經有這個目錄、房間卻沒綁它：只有它的 .tap 本來就指著這裡，才算是這個房間的專案。
      const file = tapFileOf(dir);
      if (!file || !boundTo(readTap(file), room)) {
        return `fiat: ${name} already exists and belongs to no room here. To bring it here: /fiat -install ${name}.`;
      }
    }
    project = { name, dir };
  } else {
    if (!entry) return "fiat: this room has no project yet. /fiat <projname> starts one.";
    if (!existsSync(entry.dir)) return `fiat: the project recorded for this room is gone: ${entry.dir}`;
    project = { name: entry.name, dir: entry.dir };
  }

  try {
    mkdirSync(project.dir, { recursive: true });
    ensureTap(project.dir, room);
    // `.tap` 絕不進版控——房間位置是敏感資訊。全新的目錄順手把擋板放好；
    // 既有的 .gitignore 一律不動。
    const ignore = join(project.dir, ".gitignore");
    if (created && !existsSync(ignore)) writeFileSync(ignore, ".tap\n", "utf8");
    patchRoom(settings.projectsFile, key, {
      name: project.name,
      dir: project.dir,
      agent: settings.agent,
      pid: undefined,
      go: go || undefined,
      closing: undefined,
    });
  } catch (error) {
    return `fiat: could not prepare ${project.name}: ${String(error?.message || error)}`;
  }

  const prompt = since ? `/tap ${since}` : "/tap";
  const env = {
    ...process.env,
    FIAT_REPORT: REPORT_PATH,
    FIAT_CONTEXT: JSON.stringify({
      room: key,
      name: project.name,
      dir: project.dir,
      agent: settings.agent,
      projectsFile: settings.projectsFile,
      ccrun: settings.ccrun,
      openclaw: settings.openclaw,
      interpreters: settings.interpreters,
    }),
  };
  // 不等它：ccrun 要等 session 真的能打字才回來，冷啟動常常超過半分鐘，
  // 而這段時間裡卡住的是整個房間的回覆。先回話，出事再補一則。
  starting.add(key);
  launch(settings.ccrun, project.dir, prompt, env).then(async (started) => {
    starting.delete(key);
    if (started.pid && readIndex(settings.projectsFile)[key]?.name === project.name) {
      patchRoom(settings.projectsFile, key, { pid: started.pid });
      return;
    }
    if (started.error) await notify(settings.openclaw, room, `fiat: could not start Claude Code for ${project.name}: ${started.error}`);
  });

  const notes = [created ? "new project" : null, since ? `from ${since}` : null, go ? "-go" : null].filter(Boolean);
  const then = go ? "It reports here as it goes, and installs the result when it is built." : "It reports here when the FIAT is ready.";
  return `fiat: starting Claude Code for ${project.name}${notes.length ? ` (${notes.join(", ")})` : ""}: ${prompt}. ${then}`;
}

/**
 * `/fiat -install [projname]`：把專案的 skill 裝進 OpenClaw，route 指到裝上去的那一份，當場生效。
 *
 * 已經裝過也照裝：開發目錄改過之後，再 -install 一次就是把新版推上線。
 */
async function install(settings, room, key, entry, name) {
  if (name && entry && entry.name !== name) {
    return `fiat: this room belongs to ${entry.name}. /fiat -uninstall first.`;
  }
  if (!name && !entry) return "fiat: this room has no project. /fiat -install <projname> binds one.";
  const project = entry ? { name: entry.name, dir: entry.dir } : { name, dir: join(settings.projectsDir, name) };
  if (!existsSync(project.dir)) return `fiat: ${project.dir} does not exist.`;
  const installed = await installSkill({ ...settings, ...project, installedDir: entry?.installedDir });
  if (installed.error) return `fiat: ${installed.error}`;
  let moved;
  try {
    moved = ensureTap(project.dir, room);
    patchRoom(settings.projectsFile, key, {
      name: project.name,
      dir: project.dir,
      agent: settings.agent,
      installed: true,
      skill: installed.skill,
      installedDir: installed.installedDir,
    });
  } catch (error) {
    return `fiat: could not install ${project.name}: ${String(error?.message || error)}`;
  }
  return [
    `fiat: ${installed.skill} is installed and live in this room.`,
    `runs: ${installed.command.join(" ")}`,
    moved ? `${moved} now points at this room.` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * `/fiat -uninstall`：讓房間回到空的，可以再綁別的專案。
 *
 * 清掉對照表那一筆——route 沒了、綁定也沒了，而且當場生效；-install 裝進 OpenClaw 的那一份
 * skill 也一起拿掉，否則它還會出現在這個 agent 的每一個房間裡。開發目錄一個檔案都不動。
 * openclaw.json 裡人手寫的 route 不歸這裡管：有的話就照實說，別讓使用者以為拆乾淨了。
 */
async function uninstall(config, settings, room, key, entry) {
  let removed = false;
  if (entry) {
    patchRoom(settings.projectsFile, key, null);
    try {
      removed = removeInstalledSkill(entry.installedDir);
    } catch {
      removed = false;
    }
  }
  const handWritten = (Array.isArray(config.routes) ? config.routes : [])
    .filter((route) => boundTo(route, room))
    .map((route) => routeLabel(route) ?? "(unnamed)");
  if (!entry && !handWritten.length) return "fiat: this room has no project and no route.";
  const open = entry?.pid && (await sessionAlive(settings.ccrun, entry.pid)) ? entry.pid : null;
  return [
    entry ? `fiat: this room no longer belongs to ${entry.name}.` : "fiat: this room had no project.",
    removed ? `The ${entry.skill ?? entry.name} skill was removed from OpenClaw (${entry.installedDir}).` : null,
    entry?.installedDir && !removed ? `Remove ${entry.installedDir} yourself.` : null,
    entry ? "Its project files are untouched." : null,
    open ? `Its Claude Code session (pid ${open}) is still open.` : null,
    handWritten.length
      ? `Careful: openclaw.json still has a route for this room (${handWritten.join(", ")}). Remove it yourself and restart the gateway.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Chat Interceptor",
  description: "Runs a per-room script before the agent replies; falls through to the AI when the script declines.",
  register(api) {
    api.on("before_dispatch", (event, ctx) => beforeDispatch(api, event, ctx), { priority: 100 });
    api.registerCommand({
      name: "aside",
      description: "Leave a note here that neither the AI nor the room's script will see.",
      acceptsArgs: true,
      // 誰都可以留一句話；它什麼都不會觸發。
      requireAuth: false,
      handler: (ctx) => aside(api, ctx),
    });
    api.registerCommand({
      name: "fiat",
      description: "Start Claude Code on this room's project: /fiat [projname] [-t yyyy-mm-dd HH:MM] [-go]",
      acceptsArgs: true,
      handler: (ctx) => fiat(api, ctx),
    });
  },
});
