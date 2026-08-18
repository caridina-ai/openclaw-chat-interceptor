// openclaw-chat-interceptor
//
// before_agent_reply 在 getReply 內、模型呼叫之前觸發。回傳
// { handled: true, reply } 就直接短路整個 agent turn：不組 prompt、不進模型、
// 不寫進 session 歷史，所以這條路徑是 0 token。回傳 undefined 則什麼都沒發生，
// 對話照原本的流程交給 AI。
//
// 本檔只做兩件事：依 chat room 挑出對應的 route，把訊息餵給那支 script，
// 再依 exit code 決定「處理掉」還是「放行給 AI」；以及把 ISSUE 開頭的訊息
// 直接吃掉寫進 issue log。所有領域邏輯都在 script 裡。

import { execFile } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "openclaw-chat-interceptor";
const DEFAULT_LOG_FILE = join(homedir(), ".openclaw", "logs", "chat-interceptor.log");
const DEFAULT_ISSUE_LOG_FILE = join(homedir(), ".openclaw", "logs", "chat-interceptor-issues.log");
const DEFAULT_TIMEOUT_MS = 15_000;

/** script 用這個 exit code 說「這句我不會，請交給 AI」。 */
const EXIT_PASS = 20;

/**
 * 「ISSUE ＿＿」：使用者隨手記下用起來哪裡不順，plugin 自己吃掉——
 * 不叫 AI、不給 script、不回話。抱怨天生是多行的，所以吃 [\s\S]*；
 * 字界讓 "issues"、"issued" 這些字不會被誤認成指令。
 *
 * 標點不另外判斷：`ISSUE:`、`ISSUE：` 本來就落在「開頭是 ISSUE」裡面，
 * 關鍵字後面接什麼就原樣記什麼。
 */
const ISSUE_RE = /^issue\b([\s\S]*)$/i;

// OpenClaw 自己在 hook-agent-context.ts 用的同一組 conversation prefix。
const CONVERSATION_PREFIXES = new Set(["channel", "chat", "direct", "dm", "group", "thread", "user"]);

const lower = (value) => String(value ?? "").trim().toLowerCase();

/**
 * 當地時間 `YYYY-MM-DD HH:MM:SS`。
 *
 * issue log 刻意不用 ISO/UTC：它是拿來跟聊天室裡看到的時間、跟 `.tap` 的
 * `viewed:` 對照的。同一個尺規，檢討時就不必在腦子裡換算時區。
 */
function localStamp(date = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  );
}

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
 * 把各種寫法收斂成同一個對話 id。
 *
 * 各 channel 的 target 長得不一樣：telegram 是 `-1001234567890`，
 * discord 是 `channel:123456789012345678`。而 hook 拿到的 ctx.chatId 一律是剝過 prefix 的
 * 裸 id（OpenClaw 從 sessionKey `<channel>:<group|channel>:<rawId>` 解出來的）。
 * 所以設定裡不管寫 `123456789012345678`、`channel:123456789012345678` 還是 `discord:channel:123456789012345678`，
 * 都要能對上執行時的 `123456789012345678`。
 */
function normalizeTarget(value, ...providers) {
  const strippable = new Set(CONVERSATION_PREFIXES);
  for (const provider of providers) {
    const key = lower(provider);
    if (key) strippable.add(key);
  }
  let text = String(value ?? "").trim();
  for (;;) {
    const separator = text.indexOf(":");
    if (separator === -1) return text;
    const prefix = lower(text.slice(0, separator));
    const rest = text.slice(separator + 1).trim();
    // 認不得的 prefix 就停手——例如 matrix 的 `!room:server` 不能亂剝。
    if (!rest || !strippable.has(prefix)) return text;
    text = rest;
  }
}

/** ctx.chatId 沒給時，退一步從 sessionKey `<channel>:<group|channel>:<rawId>` 取。 */
function resolveRuntimeTarget(ctx) {
  const direct = ctx?.chatId ?? ctx?.channelId;
  if (direct) return String(direct);
  const parts = String(ctx?.sessionKey ?? "").split(":");
  const start = parts[0]?.toLowerCase() === "agent" ? 2 : 0;
  const kind = parts[start + 1]?.toLowerCase();
  if (kind !== "group" && kind !== "channel") return "";
  return parts.slice(start + 2).join(":");
}

/** 挑第一個 channel + target 都對上的 route；沒有就回 undefined（整輪放行給 AI）。 */
function selectRoute(ctx, config) {
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const runtimeChannel = ctx?.channel ?? ctx?.messageProvider;
  const runtimeTarget = resolveRuntimeTarget(ctx);
  return routes.find((route) => {
    // target 或 command 沒設好的 route 一律略過——寧可多花 token，也不要亂攔。
    if (!route?.target || !Array.isArray(route.command) || route.command.length === 0) return false;
    if (route.channel && lower(runtimeChannel) !== lower(route.channel)) return false;
    const providers = [route.channel, ctx?.channel, ctx?.messageProvider];
    return normalizeTarget(runtimeTarget, ...providers) === normalizeTarget(route.target, ...providers);
  });
}

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
 * 跑 route 的 script：payload 走 stdin JSON、回覆走 stdout。
 *
 * 不用 argv 傳使用者輸入——Windows 的 argv quoting 很容易出事，而且使用者
 * 的訊息是不受信任的輸入。
 */
function runRoute(route, payload) {
  const [command, ...args] = route.command;
  return new Promise((resolve) => {
    const child = execFile(
      command,
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
 * 把一則 ISSUE 寫進獨立的檔案，回傳錯誤訊息（空字串＝寫進去了）。
 *
 * 為什麼另開一個檔：debug log 記的是異常（放行、出錯），把使用者的抱怨堆進去
 * 等於把兩種完全不同的東西混在一起；而且 issue 不該因為某人沒開 debug 就消失——
 * 它是使用者親口說的待辦。一行一筆 JSON：多行原文照原樣保留，又不必自己
 * 發明跳脫規則。`/tap` 讀的就是這個檔。
 */
function recordIssue(config, entry) {
  const file = config.issueLogFile || DEFAULT_ISSUE_LOG_FILE;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${localStamp()} ${JSON.stringify(entry)}\n`, "utf8");
    return "";
  } catch (error) {
    return String(error?.message || error);
  }
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Chat Interceptor",
  description: "Runs a per-room script before the agent replies; falls through to the AI when the script declines.",
  register(api) {
    api.on(
      "before_agent_reply",
      async (event, ctx) => {
        const config = ctx?.pluginConfig ?? api.pluginConfig ?? {};
        const trace = createTracer(config, api.logger);
        const channel = ctx?.channel ?? ctx?.messageProvider;
        const target = resolveRuntimeTarget(ctx);
        const body = String(event?.cleanedBody ?? "");

        const route = selectRoute(ctx, config);
        trace("turn", { body, channel, target, sessionKey: ctx?.sessionKey, route: route?.name ?? null });
        if (!route) return;

        // ISSUE 排在 script 前面：使用者抱怨的是「這個房間用起來怎樣」，
        // 不是給 script 的指令。送過去只會被誤判成某條規則，甚至產生副作用。
        // 沒有 route 的房間不吃 ISSUE——那個房間沒套用本 plugin，
        // 攔下它等於偷走了一句本來會有人回應的話。
        const issue = ISSUE_RE.exec(body);
        if (issue) {
          const failure = recordIssue(config, {
            text: issue[1].trim(),
            channel: channel ?? "",
            target,
            route: route.name ?? "",
          });
          trace("issue", { route: route.name ?? null, chars: issue[1].trim().length, failure: failure || undefined });
          // 寫失敗一定要說。使用者要的是「記一下、不要有反應」，
          // 但「沒記到卻也沒反應」就是把他的待辦默默弄丟了。
          return {
            handled: true,
            ...(failure ? { reply: { text: `ISSUE not recorded: ${failure}` } } : {}),
            reason: `chat-interceptor: issue${failure ? " (write failed)" : ""}`,
          };
        }

        // 原樣送出，不做 normalize——各 script 自己決定怎麼解讀。
        const payload = {
          body,
          channel: channel ?? "",
          target,
          senderId: ctx?.senderId ?? "",
          sessionKey: ctx?.sessionKey ?? "",
          agentId: ctx?.agentId ?? "",
        };

        let result;
        try {
          result = await enqueue(routeKey(route), () => runRoute(route, payload));
        } catch (error) {
          result = { exitCode: -1, failure: String(error?.message || error), stdout: "" };
        }

        if (result.exitCode === EXIT_PASS) {
          trace("pass: script declined", { route: route.name ?? null });
          return;
        }

        if (result.exitCode !== 0) {
          // 預設把錯誤也算 handled：script 可能已經有副作用（例如記帳寫了一半），
          // 放行給 AI 會讓 AI 再做一次。無副作用的 script 才適合 passthrough。
          if (route.onError === "passthrough") {
            trace("pass: script failed", { route: route.name ?? null, exitCode: result.exitCode, failure: result.failure });
            return;
          }
          trace("error", { route: route.name ?? null, exitCode: result.exitCode, failure: result.failure });
          return {
            handled: true,
            reply: { text: `${route.name ?? "script"} failed: ${result.failure}` },
            reason: `chat-interceptor: ${route.name ?? "script"} failed`,
          };
        }

        trace("handled", { route: route.name ?? null, stdout: result.stdout });
        // stdout 空的就是「處理掉但不回話」——OpenClaw 會補靜默 token NO_REPLY。
        return {
          handled: true,
          ...(result.stdout ? { reply: { text: result.stdout } } : {}),
          reason: `chat-interceptor: ${route.name ?? "script"}`,
        };
      },
      { priority: 100 },
    );
  },
});
