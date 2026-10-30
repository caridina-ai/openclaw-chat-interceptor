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
//   2. `/aside`：留一句話，AI 與 script 都收不到，只記進 offstage log。人打的、AI 寫的都算；
//      這個 plugin 送出去的每一則訊息也算，只是開頭的 `/aside` 是一個看不見的記號。
//   3. `/fiat`：OpenClaw 的 slash command。用 ccrun 叫起 Claude Code、或用 cdrun 叫起
//      Codex，請它施展 /tap 技能，把房間裡聊出來的東西做成軟體。它每一段結束時的回報，
//      從 gateway 的 HTTP 路由回到這裡。
// 所有領域邏輯都在 script 裡，所有需要智力的判斷都在寫程式的 AI 那裡。

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_HARNESS,
  DEFAULT_PROJECTS_FILE,
  HARNESSES,
  asAside,
  asideOf,
  carry,
  deriveRoute,
  inject,
  installSkill,
  launch,
  localStamp,
  lower,
  normalizeTarget,
  notify,
  openclawOf,
  patchRoom,
  patchTap,
  quit,
  readIndex,
  readTap,
  removeInstalledSkill,
  roomKey,
  run,
  sessionAlive,
  skillDirOf,
  tapFileOf,
  writeIndex,
  writeTap,
} from "./core.js";

const PLUGIN_ID = "openclaw-chat-interceptor";
const DEFAULT_LOG_FILE = join(homedir(), ".openclaw", "logs", "chat-interceptor.log");
const DEFAULT_OFFSTAGE_LOG_FILE = join(homedir(), ".openclaw", "logs", "chat-interceptor-offstage.log");
const DEFAULT_TIMEOUT_MS = 60_000;
/** /tap 的回報程式（skills/tap/report.mjs）把每一段交回 gateway 的路由。 */
const REPORT_ROUTE = "/chat-interceptor/report";
/** /tap 的汲取程式（skills/tap/tap.mjs）向平台讀房間歷史的路由。 */
const HISTORY_ROUTE = "/chat-interceptor/history";

/** script 用這個 exit code 說「這句我不會，請交給 AI」。 */
const EXIT_PASS = 20;

/** script 要再送訊息時叫的程式（payload 的 `send`）。 */
const SEND_SCRIPT = fileURLToPath(new URL("./send.mjs", import.meta.url));

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
  "Use /fiat [projname] [-t yyyy-mm-dd HH:MM] [-go] [-claude|-codex], /fiat ?, /fiat -install [projname], /fiat -uninstall, /fiat -rename <newname>, /fiat -done or /fiat -abort.";

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
  const sessionKey = ctx?.sessionKey ?? event?.sessionKey ?? "";
  const turn = {
    ...ctx,
    channel: event?.channel ?? ctx?.channelId ?? "",
    chatId: ctx?.conversationId || targetFromSessionKey(sessionKey),
    sessionKey,
    senderId: ctx?.senderId ?? event?.senderId,
    agentId: sessionKey.startsWith("agent:") ? sessionKey.split(":")[1] : "",
  };
  const aside = asideOf(body) ?? asideOf(event?.content) ?? asideTail(turn, body);
  if (aside) return takeAside(api, turn, aside);
  // 斜線指令是 OpenClaw 的。這個 hook 跑在指令處理之前，送進 script 的話，
  // 「其他的話都由我回」的 script 會把 /new、/status 吃掉。
  if (body.trimStart().startsWith("/")) return;
  const result = await runInterceptedRoute(api, { cleanedBody: body }, turn);
  if (!result?.handled) return;
  // script 的回話是給人看的：其他機器人不必接話。
  return { handled: true, ...(result.reply?.text ? { text: asAside(result.reply.text) } : {}) };
}

/**
 * /aside：不給 AI、不跑 script、不回話，每個房間都一樣。
 * 它是房間裡的獨白，不是對哪一台說的，所以房間裡每一台都記，`/tap` 在哪一台汲取都看得到。
 */
function takeAside(api, ctx, aside) {
  const config = ctx?.pluginConfig ?? api.pluginConfig ?? {};
  const channel = ctx.channel;
  const target = resolveRuntimeTarget(ctx);
  const senderId = String(ctx?.senderId ?? "");
  if (senderId && (aside.tail || maybeSplit(aside.text))) {
    asideTails.set(`${roomKey({ channel, target })}|${senderId}`, { at: Date.now(), bot: aside.bot });
  }
  const failure = recordOffstage(config, { kind: "aside", channel, target, senderId, text: aside.text, ...(aside.bot ? { bot: true } : {}) });
  createTracer(config, api.logger)("aside", { channel, target, bot: aside.bot, ...(failure ? { failure } : {}) });
  // 寫失敗一定要說：「沒記到卻也沒反應」就是把那句話默默弄丟了。
  return { handled: true, ...(failure ? { text: asAside(`aside not recorded: ${failure}`) } : {}) };
}

/**
 * 太長的訊息，平台會切成好幾則送（Discord 一則 2000 字、17 行），`/aside` 只在第一則的開頭。
 * 所以一則長的 /aside 之後，同一個發話者在同一個房間幾秒內接著送來的，都算同一則的後半。
 * 短的不會被切，不必等後半：人打完一句 /aside 緊接著講的話，是要給 AI 聽的。
 */
const ASIDE_TAIL_MS = 10_000;
const maybeSplit = (text) => text.length >= 1200 || text.split("\n").length >= 12;
const asideTails = new Map();

function asideTail(ctx, body) {
  if (!ctx?.senderId) return null;
  const key = `${roomKey({ channel: ctx.channel, target: resolveRuntimeTarget(ctx) })}|${ctx.senderId}`;
  const last = asideTails.get(key);
  if (last === undefined) return null;
  if (Date.now() - last.at > ASIDE_TAIL_MS) {
    asideTails.delete(key);
    return null;
  }
  return { text: body.trim(), bot: last.bot, tail: true };
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
    // 再送訊息用的 argv，後面接 `openclaw message send` 的選項；房間已經指定好了。
    send: [process.execPath, SEND_SCRIPT, JSON.stringify(openclawOf(fiatConfigOf(config)?.openclaw)), channel, target],
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
 * 指令是從哪個房間打的。`target` 是送得到那個房間的寫法：只拿掉開頭的 provider
 * （`telegram:-100…` → `-100…`），`user:`、`channel:` 這種種類一定要留著——Discord 的裸 id
 * 是頻道，私聊少了 `user:` 就送不到。跟 hook 看到的寫法比對時，用 normalizeTarget 去掉種類再比。
 * Discord 的斜線指令例外：`to` 是 `slash:<使用者 id>`（回覆給按指令的那個人），房間從 sessionKey 認。
 */
function commandRoom(ctx) {
  const channel = lower(ctx?.channel);
  const raw = isSlashInteraction(ctx) ? slashTarget(ctx) : ctx?.to || targetFromSessionKey(ctx?.sessionKey) || ctx?.from || "";
  const target = String(raw).trim();
  return { channel, target: lower(target.slice(0, channel.length + 1)) === `${channel}:` ? target.slice(channel.length + 1) : target };
}

/** Discord 斜線指令的房間：sessionKey 是 `…:discord:direct:<使用者 id>` 就是私聊，否則是頻道；沒有 sessionKey 才看 `from`。 */
function slashTarget(ctx) {
  const parts = String(ctx?.sessionKey ?? "").split(":");
  const start = lower(parts[0]) === "agent" ? 2 : 0;
  const kind = lower(parts[start + 1]);
  const id = parts.slice(start + 2).join(":");
  if (id && (kind === "direct" || kind === "dm")) return `user:${id}`;
  if (id && kind === "channel") return `channel:${id}`;
  return ctx?.from ?? "";
}

/** Discord 的斜線指令：`to` 是按指令的那個人，不是頻道。 */
const isSlashInteraction = (ctx) => /^slash:/i.test(ctx?.to ?? "");

// ---------------------------------------------------------------------------
// `/aside`
// ---------------------------------------------------------------------------
// 留一句話在房間裡，**但誰都不要處理它**。名字取自戲劇的「旁白」：說出口、留在
// 劇本裡，但台上其他角色聽不見。它留在 offstage log 裡（`/tap` 撈得回來），
// AI 與 script 都收不到，也不回話。每個房間的行為都一樣。
//
// 打成一則訊息的由 hook 記下（takeAside）；這裡接的是 OpenClaw 的原生指令（例如 Telegram 的指令選單）。
// Discord 不註冊：那裡的斜線指令要先選一台機器人、只送到那一台，而 /aside 是房間的獨白，
// 不綁哪一台。所以在 Discord 它就是一般文字，房間裡每一台的 hook 都記。

/** 註冊 /aside 的 channel：設定裡 Discord 以外的。OpenClaw 沒有「不要註冊成原生指令」的開關，只有這張白名單。 */
const asideChannels = (config) => Object.keys(config?.channels ?? {}).filter((channel) => lower(channel) !== "discord");

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
//   /fiat [projname] [-t yyyy-mm-dd HH:MM] [-go] [-claude|-codex]   叫起寫程式的 AI，注入 `/tap [起點]`
//   /fiat ?                                        只查不做：這個房間綁了什麼、裝了什麼、session 開著沒有
//   /fiat -install [projname]                      把專案的 skill 裝進 OpenClaw，並在這個房間上線
//   /fiat -uninstall                               下線、拿掉裝上去的 skill，解除綁定
//   /fiat -rename <newname>                        專案目錄改名，對照表跟著改
//   /fiat -done                                    驗收過了：請它 commit、寫交接 memory
//   /fiat -abort                                   叫錯了：直接關掉，不 commit、不動 timestamp
//
// 寫程式的 AI 是 Claude Code（ccrun 叫起）或 Codex（cdrun 叫起）。兩支程式介面一樣，
// 所以這裡只有一張表（core.js 的 HARNESSES），沒有哪一段是專為其中一種寫的。
// `-claude`／`-codex` 指定這一輪用哪一個。沒指定就用這個房間上一次用的那一個——使用者不必記得
// 上次是怎麼叫起來的；這個房間從沒叫起過，才用設定的 `fiat.harness`。
//
// `-go` 只有一個意思：這個房間的專案，接下來一路自動做到裝好。還沒開 session 就叫起
// 連續版（FIAT 文件寫好就替它注入 `go`）；已經開著——例如停在 FIAT 文件等人看——
// 就注入 `go` 請它接著做。
//
// 起點一定要帶 `-t`：`/fiat 2026-09-28` 沒有它，就分不出是起點還是一個叫 2026-09-28 的專案。
// 忘了帶的時候（常常會），回話直接給出補好的那一句。
//
// 那一側只會收到固定的 `/tap [起點]`、`go`、`/tap -done`，其餘的說明都寫在 /tap 的 SKILL.md。
// 它每一段結束會呼叫回報程式（report.mjs），回報程式把那一段交回這裡（receiveReport）：
// 回報到房間、連續版的下一步、安裝、更新 timestamp、關掉 session，都在 gateway 這一側做。

/** 叫起中的房間 → 叫起的是哪一種。runner 要等 session 真的能接話才回來，那段時間裡不能再叫一次。 */
const starting = new Map();

/** 叫起中、但使用者已經打了 `-abort` 的房間：一起來就關掉。 */
const abortAfterStart = new Set();

/**
 * 這個房間的 session 已經沒了（或從沒有過）：對照表裡跟它有關的欄位一起清掉。
 * `harness` 留著：下一輪沒指定的話，就叫上一次那一個。
 */
const NO_SESSION = { pid: undefined, go: undefined, closing: undefined };

const isHarness = (key) => typeof key === "string" && Object.hasOwn(HARNESSES, key);

/** 開著的、或上一次叫起的是哪一種；這個房間從沒叫起過才是設定的預設。 */
const sessionHarness = (settings, entry) => (isHarness(entry?.harness) ? entry.harness : settings.harness);
const sessionLabel = (settings, entry) => HARNESSES[sessionHarness(settings, entry)].label;
const sessionRunner = (settings, entry) => settings.runners[sessionHarness(settings, entry)];

/** 外部程式的 argv 與預設的 harness：指令與回報路由共用的設定。 */
function fiatSettings(fiatConfig) {
  const argv = (value, fallback) => (Array.isArray(value) && value.length ? value.map(String) : [fallback]);
  return {
    projectsDir: String(fiatConfig.projectsDir ?? "").trim(),
    projectsFile: fiatConfig.projectsFile || DEFAULT_PROJECTS_FILE,
    harness: isHarness(fiatConfig.harness) ? fiatConfig.harness : DEFAULT_HARNESS,
    runners: Object.fromEntries(Object.entries(HARNESSES).map(([key, { runner }]) => [key, argv(fiatConfig[runner], runner)])),
    openclaw: fiatConfig.openclaw,
    interpreters: fiatConfig.interpreters,
  };
}

function parseFiat(args) {
  const tokens = String(args ?? "").trim().split(/\s+/).filter(Boolean);
  const parsed = { name: null, since: null, go: false, harness: null, verb: null };
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
    } else if (isHarness(flag)) {
      if (parsed.harness && parsed.harness !== flag) return { error: `-${parsed.harness} and -${flag} do not go together.` };
      parsed.harness = flag;
    } else if (["install", "uninstall", "rename", "done", "abort"].includes(flag) && !parsed.verb) {
      parsed.verb = flag;
    } else {
      return { error: `unknown option "${token}". ${FIAT_USAGE}` };
    }
  }
  const { name, since, go, harness, verb } = parsed;
  if (verb === "install" && (since || go || harness)) return { error: "-install takes nothing but a project name." };
  if (verb === "rename" && (!name || since || go || harness)) return { error: "-rename takes the new name and nothing else: /fiat -rename <newname>" };
  if ((verb === "uninstall" || verb === "done" || verb === "abort") && (name || since || go || harness)) {
    return { error: `-${verb} takes no arguments.` };
  }
  if (verb === "status" && (name || since || go || harness)) return { error: "? takes no arguments." };
  if (name && !PROJECT_RE.test(name)) {
    return { error: `"${name}" is not a usable project name (one path segment: letters, digits, dot, dash, underscore).` };
  }
  return parsed;
}

/**
 * 專案的 `.tap` 要指著這個房間：/tap 汲取的就是它指的那個房間。
 * 沒有就寫一份；指著別的房間（專案被裝到新房間來了）就改成這裡，timestamp 留著。
 * 同一個房間但寫法不一樣（舊版把 `user:`、`channel:` 拿掉了）就補成送得到的寫法，不算換房間。
 */
function ensureTap(dir, room) {
  const file = tapFileOf(dir);
  if (!file) {
    writeTap(join(dir, "genesis", ".tap"), room);
    return null;
  }
  const tap = readTap(file);
  if (boundTo(tap, room)) {
    if (tap.target !== room.target) patchTap(file, { target: room.target });
    return null;
  }
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
  const base = fiatSettings(fiatConfig);
  if (!base.projectsDir) return { text: "fiat: set fiat.projectsDir in the plugin config first." };
  const room = commandRoom(ctx);
  if (!room.channel || !room.target) return { text: "fiat: cannot tell which room this is." };

  const parsed = parseFiat(ctx?.args);
  if (parsed.error) return { text: `fiat: ${parsed.error}` };

  const key = roomKey(room);
  const entry = readIndex(base.projectsFile)[key] ?? null;
  // skill 裝進這個房間的 agent 的 workspace。房間沒有另外綁 agent 時，OpenClaw 給的是預設的那個。
  const settings = { ...base, agent: ctx?.agentId || entry?.agent || undefined };
  if (parsed.verb === "status") return { text: await status(config, settings, room, key, entry) };
  // 叫錯了要馬上能收回，不必等它開好。
  if (parsed.verb === "abort") return { text: await abort(settings, key, entry) };
  if (starting.has(key)) return { text: `fiat: ${starting.get(key)} for ${entry?.name ?? "this room"} is still starting.` };

  if (parsed.verb === "uninstall") return { text: await uninstall(config, settings, room, key, entry) };
  if (parsed.verb === "install") return { text: await install(settings, room, key, entry, parsed.name) };
  if (parsed.verb === "rename") return { text: await rename(config, settings, entry, parsed.name) };

  const open = entry?.pid && (await sessionAlive(sessionRunner(settings, entry), entry.pid)) ? entry.pid : null;
  const label = sessionLabel(settings, entry);
  if (parsed.verb === "done") {
    if (!open) {
      if (entry?.pid) patchRoom(settings.projectsFile, key, NO_SESSION);
      return { text: `fiat: no ${label} session is open for ${entry?.name ?? "this room"}.` };
    }
    // 回報程式已經說做完了卻還開著（gateway 在那之間重啟過、或上一次沒關成）：直接關。
    if (entry.closing) return { text: await close(settings, key, entry) };
    return { text: await ask(settings, entry, "/tap -done", "commit and wrap up. It reports here when it is done.") };
  }
  const sameRound =
    (!parsed.name || parsed.name === entry?.name) && (!parsed.harness || parsed.harness === sessionHarness(settings, entry));
  if (open && parsed.go && !parsed.since && sameRound) {
    // 不管它正在做什麼都直接打：它做完手上這一段（還在汲取就先把 FIAT 寫完），自然會接著做。
    return { text: await ask(settings, entry, "go", "go on and implement the FIAT. It reports here when it is built.") };
  }
  if (open) {
    return { text: `fiat: ${label} is already open for ${entry.name} (pid ${open}). /fiat -go to implement, /fiat -done to finish.` };
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
    const alive = entry.pid && (await sessionAlive(sessionRunner(settings, entry), entry.pid));
    const session = starting.has(key) ? "starting" : alive ? `pid ${entry.pid}${entry.closing ? ", closing" : ""}` : "not running";
    lines.push(`${starting.get(key) ?? sessionLabel(settings, entry)}: ${session}`);
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
 * `-q` 請它結束，十秒內沒走就直接結束——卡在確認對話框的 session 也關得掉。
 */
async function close(settings, key, entry) {
  const label = sessionLabel(settings, entry);
  const runner = sessionRunner(settings, entry);
  const result = await quit(runner, entry.pid);
  // 關不掉、它還活著的話 pid 要留著：那是再試一次的把手，-rename 也靠它知道目錄還有人在用。
  if (result.ok || !(await sessionAlive(runner, entry.pid))) patchRoom(settings.projectsFile, key, NO_SESSION);
  if (result.ok) return `fiat: ${label} for ${entry.name} is closed.`;
  return `fiat: could not close ${label} for ${entry.name} (pid ${entry.pid}): ${result.failure}`;
}

/** 已經排好要關的 session：同一個只排一次。 */
const closers = new Set();

/**
 * 回報 done 之後關掉 session。這時它通常還在把這一輪講完（回報程式就是它這一輪叫的），
 * 所以先讓它講一會兒；`-q` 的十秒寬限之後還沒結束，就是被強制結束——該存的 commit、
 * memory、timestamp 在回報之前都存好了。gateway 在這之間重啟的話，`/fiat -done` 會直接關。
 */
function closeSoon(settings, key, entry, room) {
  const closer = `${settings.projectsFile}|${key}|${entry.pid}`;
  if (closers.has(closer)) return;
  closers.add(closer);
  const grace = Number(process.env.FIAT_CLOSE_GRACE_MS ?? 20_000);
  setTimeout(async () => {
    closers.delete(closer);
    const now = readIndex(settings.projectsFile)[key];
    if (!now?.closing || now.pid !== entry.pid) return; // 換人了，或已經被關掉
    const text = await close(settings, key, now);
    if (!/is closed\.$/.test(text)) await notify(settings.openclaw, room, text);
  }, grace).unref();
}

/**
 * `/fiat -abort`：叫錯了（例如叫起了另一個 AI），收回這一輪。直接關掉 session：不請它 commit、
 * 不寫交接 memory、不動 `.tap` 的 timestamp，下一輪還是從同一個地方汲取。它已經寫下的檔案留在專案目錄裡。
 * 還在叫起中的，記下來，等它起來就關。
 */
async function abort(settings, key, entry) {
  if (!entry) return "fiat: this room has no project.";
  if (starting.has(key)) {
    abortAfterStart.add(key);
    return `fiat: ${starting.get(key)} for ${entry.name} is still starting. It will be closed as soon as it is up; the timestamp stays.`;
  }
  const label = sessionLabel(settings, entry);
  if (!entry.pid || !(await sessionAlive(sessionRunner(settings, entry), entry.pid))) {
    if (entry.pid) patchRoom(settings.projectsFile, key, NO_SESSION);
    return `fiat: nothing to abort: ${label} for ${entry.name} is not running. The timestamp stays.`;
  }
  // 已經回報收尾、等著被關的那一輪（done 已經 commit 了）：只是提早關，不能說什麼都沒做。
  const text = await close(settings, key, entry);
  return /is closed\.$/.test(text) && !entry.closing ? `${text} Nothing was committed, and the timestamp stays.` : text;
}

async function ask(settings, entry, prompt, what) {
  const label = sessionLabel(settings, entry);
  const sent = await inject(sessionRunner(settings, entry), entry.pid, prompt);
  if (!sent.ok) return `fiat: could not reach ${label} (pid ${entry.pid}): ${sent.failure}`;
  return `fiat: asked ${label} to ${what}`;
}

/** `/fiat [projname] [-t …] [-go] [-claude|-codex]`：決定是哪個專案，然後叫起寫程式的 AI。 */
function startRound(settings, room, key, entry, { name, since, go, harness }) {
  harness ??= sessionHarness(settings, entry);
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
      ...NO_SESSION,
      harness,
      go: go || undefined,
    });
  } catch (error) {
    return `fiat: could not prepare ${project.name}: ${String(error?.message || error)}`;
  }

  const { label } = HARNESSES[harness];
  const prompt = since ? `/tap ${since}` : "/tap";
  // 不等它：runner 要等 session 真的能接話才回來，冷啟動常常超過半分鐘，
  // 而這段時間裡卡住的是整個房間的回覆。先回話，出事再補一則。
  starting.set(key, label);
  launch(settings.runners[harness], project.dir, prompt).then(async (started) => {
    starting.delete(key);
    const aborted = abortAfterStart.delete(key);
    if (started.pid && readIndex(settings.projectsFile)[key]?.name === project.name) {
      if (aborted) {
        const closed = await quit(settings.runners[harness], started.pid);
        patchRoom(settings.projectsFile, key, NO_SESSION);
        const text = closed.ok
          ? `fiat: ${label} for ${project.name} is closed (-abort). Nothing was committed, and the timestamp stays.`
          : `fiat: could not close ${label} for ${project.name} (pid ${started.pid}): ${closed.failure}`;
        await notify(settings.openclaw, room, text);
        return;
      }
      patchRoom(settings.projectsFile, key, { pid: started.pid });
      return;
    }
    if (started.error) await notify(settings.openclaw, room, `fiat: could not start ${label} for ${project.name}: ${started.error}`);
  });

  const notes = [created ? "new project" : null, since ? `from ${since}` : null, go ? "-go" : null].filter(Boolean);
  const then = go ? "It reports here as it goes, and installs the result when it is built." : "It reports here when the FIAT is ready.";
  return `fiat: starting ${label} for ${project.name}${notes.length ? ` (${notes.join(", ")})` : ""}: ${prompt}. ${then}`;
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
  const open = entry?.pid && (await sessionAlive(sessionRunner(settings, entry), entry.pid)) ? entry.pid : null;
  return [
    entry ? `fiat: this room no longer belongs to ${entry.name}.` : "fiat: this room had no project.",
    removed ? `The ${entry.skill ?? entry.name} skill was removed from OpenClaw (${entry.installedDir}).` : null,
    entry?.installedDir && !removed ? `Remove ${entry.installedDir} yourself.` : null,
    entry ? "Its project files are untouched." : null,
    open ? `Its ${sessionLabel(settings, entry)} session (pid ${open}) is still open.` : null,
    handWritten.length
      ? `Careful: openclaw.json still has a route for this room (${handWritten.join(", ")}). Remove it yourself and restart the gateway.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * `/fiat -rename <newname>`：把這個房間的專案目錄改名，對照表裡指著它的每一筆跟著改，
 * 寫程式的 AI 為這個目錄記的東西也請 runner 搬過去（`-m`）——Claude Code 的交接 memory 是照目錄路徑存的，
 * 不搬的話，下一輪就看不到前幾輪留下的經驗。沒裝的 runner 就是沒有東西可搬。
 *
 * 全部一起改，有一處跟不上就全部改回去：目錄、AI 的記憶與登錄對不上，比沒改還糟。
 * `.tap` 在目錄裡，跟著走；裝進 OpenClaw 的那一份是另一份複製，名字取自它的 SKILL.md，都不必動。
 * session 開著就不改：它的工作目錄就在裡面，Windows 上改不了名，改得了它也會找不到自己。
 */
async function rename(config, settings, entry, name) {
  if (!entry) return "fiat: this room has no project to rename.";
  if (name === entry.name) return `fiat: the project is already called ${name}.`;
  if (!existsSync(entry.dir)) return `fiat: the project recorded for this room is gone: ${entry.dir}`;
  const open = entry.pid && (await sessionAlive(sessionRunner(settings, entry), entry.pid)) ? entry.pid : null;
  if (open) return `fiat: ${sessionLabel(settings, entry)} is still open for ${entry.name} (pid ${open}). Rename it once that session is closed.`;
  const dir = join(dirname(entry.dir), name);
  // 只差大小寫的話，Windows 上看到的就是它自己。
  if (existsSync(dir) && !samePath(dir, entry.dir)) return `fiat: ${name} already exists.`;
  try {
    renameSync(entry.dir, dir);
  } catch (error) {
    const busy = error?.code === "EPERM" || error?.code === "EBUSY";
    return `fiat: could not rename ${entry.name}: ${busy ? "something still has its folder open" : String(error?.message || error)}.`;
  }
  const carried = [];
  let failure = "";
  for (const [harness, { label }] of Object.entries(HARNESSES)) {
    const moved = await carry(settings.runners[harness], entry.dir, dir);
    if (moved.missing) continue;
    if (!moved.ok) {
      // 第一行就是原因；不認得 -m 的舊版 runner 會在後面附上整份用法。
      failure = `${label}: ${moved.failure.split("\n")[0]}`;
      break;
    }
    carried.push(harness);
  }
  if (!failure) {
    const index = readIndex(settings.projectsFile);
    for (const other of Object.values(index)) if (samePath(other?.dir, entry.dir)) Object.assign(other, { name, dir });
    try {
      writeIndex(settings.projectsFile, index);
    } catch (error) {
      failure = String(error?.message || error);
    }
  }
  if (failure) {
    // 先把目錄改回去，runner 才搬得回來：它只在目錄搬好之後搬。
    const stuck = [];
    try {
      renameSync(dir, entry.dir);
      for (const harness of carried.reverse()) {
        if (!(await carry(settings.runners[harness], dir, entry.dir)).ok) stuck.push(HARNESSES[harness].label);
      }
    } catch (error) {
      stuck.push(String(error?.message || error));
    }
    const undo = stuck.length ? ` Could not undo it all: ${stuck.join(", ")}.` : "";
    return `fiat: could not rename ${entry.name}: ${failure}${undo}`;
  }
  // 手寫的 route 用專案名找目錄的話，改名之後就找不到了。它不歸這裡管，但要說。
  const byName = (Array.isArray(config.routes) ? config.routes : []).filter(
    (route) => route?.project === entry.name && !route.dir && !route.command?.length,
  );
  return [
    `fiat: ${entry.name} is now ${name}.`,
    byName.length
      ? `Careful: openclaw.json has a route that finds it by name (${byName.map(routeLabel).join(", ")}). Change it to ${name} yourself and restart the gateway.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

// ---------------------------------------------------------------------------
// 回報：report.mjs 從 session 裡把每一段交回來
// ---------------------------------------------------------------------------
// session 裡能做的事有限：Codex 的 sandbox 不能開子行程、不能寫專案以外的檔案。
// 所以回報程式只把「哪一輪、哪一段、一段話」POST 到這裡，該做的事全在 gateway 做：
//
//   fiat   回報；這一輪是連續版（`go` 記著）的話，替它注入 `go`
//   empty  沒寫成 FIAT 文件：回報，並排好關掉 session（timestamp 不動，下一輪還從同一個地方汲取）
//   built  把專案的 skill 裝進 OpenClaw、在房間上線（等同 /fiat -install），再回報
//   done   更新 .tap 的 timestamp、回報，並排好關掉 session
//
// 每一段重複回報都不會出事：-go 用過就消掉、裝過的照裝、關 session 只排一次。
//
// 哪一輪，是從回報程式送來的房間（專案的 .tap）與專案目錄認的：房間綁的就是這個專案、
// 而且有一個 /fiat 開著的 session，才算數。回報程式拿不到別的線索——Codex 的對話被使用者
// 從手機接手之後，是在 Codex app 裡接著跑的，那裡沒有 /fiat 叫起時的環境變數。
// 房間被 -uninstall、專案換了、session 已經關了，就什麼都不做，只告訴它。

const REPORT_STAGES = new Set(["fiat", "empty", "built", "done"]);

/** 回一個 JSON。 */
function answerJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
  return true;
}

/** 瀏覽器跨站送來的一定帶 Origin，而 JSON 的 POST 會先被 preflight 擋下。 */
const fromLocalProgram = (req) => !req.headers.origin && /^application\/json\b/i.test(String(req.headers["content-type"] ?? ""));

async function receiveReport(api, req, res) {
  const answer = (status, body) => answerJson(res, status, body);
  if (req.method !== "POST") return answer(405, { error: "POST a report here." });
  if (!fromLocalProgram(req)) return answer(403, { error: "Reports come from the /tap report program only." });
  let request;
  try {
    request = JSON.parse(await readBody(req, 256 * 1024));
  } catch (error) {
    return answer(400, { error: `not a report: ${String(error?.message || error)}` });
  }
  const { room, dir, stage } = request ?? {};
  if (!REPORT_STAGES.has(stage)) return answer(400, { error: `unknown stage "${stage}"` });
  if (!room?.channel || !room?.target || typeof dir !== "string") return answer(400, { error: "a report needs the room and the project directory." });

  const fiatConfig = fiatConfigOf(liveConfig(api));
  if (!fiatConfig) return answer(404, { error: "/fiat is not configured on this gateway." });
  const settings = fiatSettings(fiatConfig);
  const key = roomKey({ channel: String(room.channel), target: String(room.target) });
  const entry = readIndex(settings.projectsFile)[key];
  if (!entry?.pid || !samePath(entry.dir, dir)) {
    return answer(409, { error: "No /fiat round is open for this project in its room, so nothing was reported." });
  }
  // 回報送到專案的 .tap 寫的那個房間：對照表的 key 拿掉了 `user:` 這種種類，送不到 Discord 的私聊。
  const to = { channel: String(room.channel), target: String(room.target) };
  const text = await report(settings, key, entry, to, stage, String(request.message ?? "").trim());
  return answer(200, { text });
}

/** 一個 POST 的本文，太長就不收。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too long"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// 房間的歷史：tap.mjs 向平台讀
// ---------------------------------------------------------------------------
// 本機的紀錄只有 OpenClaw 在場時收到的那些：機器人被拉進討論串之前、房間裡跟別的機器人談的，
// 本機一則都沒有。平台讀得到（例如 Discord）就以平台為準。讀法是 `openclaw message read`，
// 跟送訊息同一條路；放在 gateway 做，是因為 Codex 的 sandbox 裡 node 開不了子行程。
// 從新往舊一頁一頁翻，翻過 `since` 或翻到底就停。CLI 每叫一次要半分鐘，所以頁數有上限。

const HISTORY_PAGE = 100;
const HISTORY_PAGES = 10;

async function receiveHistory(api, req, res) {
  const answer = (status, body) => answerJson(res, status, body);
  if (req.method !== "POST") return answer(405, { error: "POST a history read here." });
  // 整個房間的歷史：只給這台機器上的程式。
  if (!/^(?:127\.|::1$|::ffff:127\.)/.test(String(req.socket?.remoteAddress ?? "")) || !fromLocalProgram(req)) {
    return answer(403, { error: "History is for the /tap program on this machine only." });
  }
  let request;
  try {
    request = JSON.parse(await readBody(req, 16 * 1024));
  } catch (error) {
    return answer(400, { error: `not a history read: ${String(error?.message || error)}` });
  }
  const { channel, target } = request ?? {};
  if (!channel || !target) return answer(400, { error: "a history read needs the channel and the target." });

  // 翻好幾頁要好幾分鐘：header 先送，每翻完一頁送一個空白，對方才不會以為斷線（JSON 前面的空白不影響解析）。
  res.statusCode = 200;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.flushHeaders?.();
  const openclaw = openclawOf(fiatConfigOf(liveConfig(api))?.openclaw);
  const result = await readHistory(openclaw, { channel: String(channel), target: String(target) }, Number(request.since) || 0, () =>
    res.write(" "),
  );
  res.end(JSON.stringify(result));
  return true;
}

/**
 * `{ messages, complete }`：messages 是平台原樣的訊息物件，新的在前；complete 是翻過了 since 或翻到底。
 * 第一頁就讀不到（平台不給讀，例如 Telegram）是 `{ error }`；翻到一半出事，已經讀到的照給，加上 error。
 */
async function readHistory(openclaw, room, since, onPage) {
  const messages = [];
  let before = null;
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const read = await run(
      [...openclaw, "message", "read"],
      ["--channel", room.channel, "--target", room.target, "--limit", String(HISTORY_PAGE), "--json", ...(before ? ["--before", before] : [])],
      { timeout: 120_000 },
    );
    onPage();
    let batch = null;
    let error = read.ok ? null : cliReason(read.failure);
    if (!error) {
      try {
        batch = JSON.parse(read.stdout.slice(Math.max(0, read.stdout.search(/^\{/m)))).payload?.messages;
      } catch {
        // 下面一起說
      }
      if (!Array.isArray(batch)) error = "openclaw message read did not return a list of messages";
    }
    if (error) return page ? { messages, complete: false, error } : { error };
    messages.push(...batch);
    const oldest = batch.reduce((a, b) => (messageTime(b) < messageTime(a) ? b : a), batch[0]);
    if (batch.length < HISTORY_PAGE || !oldest?.id || messageTime(oldest) < since) return { messages, complete: true };
    before = String(oldest.id);
  }
  return { messages, complete: false };
}

const messageTime = (message) => Number(message?.timestampMs) || Date.parse(message?.timestamp ?? "") || 0;

/** CLI 失敗時印一大段，原因在 `Reason:` 那一行。 */
const cliReason = (failure) => /Reason:\s*(.+)/.exec(failure)?.[1].trim() || String(failure).trim().split("\n").at(-1) || "openclaw message read failed";

/** 路由拿不到指令的 ctx：設定從 gateway 當下那一份取，取不到才用載入時的。 */
const liveConfig = (api) => api.runtime?.config?.current?.()?.plugins?.entries?.[PLUGIN_ID]?.config ?? api.pluginConfig ?? {};

/** Windows 上大小寫、斜線方向都不算數。 */
const samePath = (a, b) => lower(resolve(String(a ?? ""))) === lower(resolve(String(b ?? "")));

async function report(settings, key, entry, room, stage, message) {
  const name = entry.name;
  const done = [];
  const lines = [];
  if (stage === "fiat") {
    lines.push(`${name}: FIAT ready`, message, entry.go ? "Implementing it now (-go)." : "Read it, then /fiat -go to implement.");
  } else if (stage === "empty") {
    lines.push(`${name}: no FIAT`, message, `Closing ${sessionLabel(settings, entry)}.`);
  } else if (stage === "built") {
    lines.push(`${name}: built`, message);
    const installed = await installSkill({ ...settings, name, dir: entry.dir, agent: entry.agent, installedDir: entry.installedDir });
    if (installed.error) {
      lines.push(`not installed: ${installed.error}`);
      done.push(`not installed: ${installed.error}`);
    } else {
      patchRoom(settings.projectsFile, key, { installed: true, skill: installed.skill, installedDir: installed.installedDir });
      lines.push(`Installed ${installed.skill}: live in this room now. Test it here, then /fiat -done.`);
      done.push("installed");
    }
  } else {
    // 下一輪 /tap 從這裡開始汲取。這一步排在最前面：後面不管哪一步出事，它都已經做了。
    const stamp = localStamp();
    const tapFile = tapFileOf(entry.dir);
    if (tapFile) {
      patchTap(tapFile, { timestamp: stamp });
      done.push(`timestamp ${stamp}`);
    }
    const closing = `Closing ${sessionLabel(settings, entry)}.`;
    lines.push(`${name}: done`, message, tapFile ? `timestamp: ${stamp}. ${closing}` : closing);
  }

  const sent = await notify(settings.openclaw, room, lines.filter(Boolean).join("\n"));
  done.push(sent.ok ? "reported to the room" : `could not report to the room: ${sent.failure}`);

  if (entry.pid && stage === "fiat" && entry.go) {
    patchRoom(settings.projectsFile, key, { go: undefined });
    const queued = await inject(sessionRunner(settings, entry), entry.pid, "go");
    if (!queued.ok) done.push(`could not send go: ${queued.failure}`);
  }
  if (entry.pid && (stage === "done" || stage === "empty")) {
    // pid 留著：那是關它的把手。
    patchRoom(settings.projectsFile, key, { closing: true, go: undefined });
    closeSoon(settings, key, entry, room);
    done.push("this session will be closed shortly");
  }
  return `${done.join("; ")}.`;
}

/** 指令的回覆也是這個 plugin 送出去的訊息：開頭帶記號。 */
const asideReply = (result) => (typeof result?.text === "string" ? { ...result, text: asAside(result.text) } : result);

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Chat Interceptor",
  description: "Runs a per-room script before the agent replies; falls through to the AI when the script declines.",
  register(api) {
    api.on("before_dispatch", (event, ctx) => beforeDispatch(api, event, ctx), { priority: 100 });
    const channels = asideChannels(api.config);
    // 一個都沒有的話（例如只接了 Discord）就不註冊：空的白名單在 OpenClaw 眼裡是「全部」。
    if (channels.length) {
      api.registerCommand({
        name: "aside",
        description: "Leave a note here that neither the AI nor the room's script will see.",
        acceptsArgs: true,
        channels,
        // 誰都可以留一句話；它什麼都不會觸發。
        requireAuth: false,
        handler: async (ctx) => asideReply(await aside(api, ctx)),
      });
    }
    api.registerCommand({
      name: "fiat",
      description: "Start an AI coder on this room's project: /fiat [projname] [-t yyyy-mm-dd HH:MM] [-go] [-claude|-codex]",
      acceptsArgs: true,
      handler: async (ctx) => asideReply(await fiat(api, ctx)),
    });
    // 憑證由這個 plugin 自己驗（每一輪一個），不走 gateway 的登入。
    api.registerHttpRoute({
      path: REPORT_ROUTE,
      auth: "plugin",
      match: "exact",
      handler: (req, res) => receiveReport(api, req, res),
    });
    // 只收本機來的，見 receiveHistory。
    api.registerHttpRoute({
      path: HISTORY_ROUTE,
      auth: "plugin",
      match: "exact",
      handler: (req, res) => receiveHistory(api, req, res),
    });
  },
});
