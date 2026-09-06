// openclaw-chat-interceptor
//
// before_agent_reply 在 getReply 內、模型呼叫之前觸發。回傳
// { handled: true, reply } 就直接短路整個 agent turn：不組 prompt、不進模型、
// 不寫進 session 歷史，所以這條路徑是 0 token。回傳 undefined 則什麼都沒發生，
// 對話照原本的流程交給 AI。
//
// 本檔只做三件事：依 chat room 挑出對應的 route，把訊息餵給那支 script，
// 再依 exit code 決定「處理掉」還是「放行給 AI」；把 `/aside` 開頭的訊息直接吃掉
// 寫進 issue log；以及把 `/tap` 換算成「在哪個專案目錄叫起哪個 AI harness」。
// 所有領域邏輯都在 script 裡，所有需要智力的判斷都在 harness 裡。

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

const PLUGIN_ID = "openclaw-chat-interceptor";
const DEFAULT_LOG_FILE = join(homedir(), ".openclaw", "logs", "chat-interceptor.log");
const DEFAULT_ASIDE_LOG_FILE = join(homedir(), ".openclaw", "logs", "chat-interceptor-asides.log");
const DEFAULT_PROJECTS_FILE = join(homedir(), ".openclaw", "chat-interceptor-projects.json");
const DEFAULT_TIMEOUT_MS = 15_000;

// `/tap` 那一側的預設值。command 與 notifyCommand 都是 argv：
// gateway 是服務啟動的，PATH 跟 shell 不一樣，實務上一定要在設定裡寫絕對路徑。
const DEFAULT_TAP_COMMAND = ["claude", "-p", "--permission-mode", "bypassPermissions"];
// 預設交給 harness 的話。除了叫它施展 `/tap` 之外，還要告訴它這一輪的**執行條件**：
// 沒有人在等著回答它。少了這一句，它很容易做完調查就停在一個問題上——而那個問題
// 不會有人回答，那一輪就白跑了。
//
// 分層是刻意的：skill 說「做什麼」（從終端機叫它時是有人可以回答的，所以那份不該
// 寫死這件事），這裡說「這一次是什麼情況」。要改就改設定的 `tap.prompt`。
const DEFAULT_TAP_PROMPT = [
  "/tap",
  "",
  "This run is non-interactive: nobody can answer you while it lasts, so do not stop at a question.",
  "When something is unclear, pick the most reasonable reading and carry it through; in your closing",
  "summary say what you chose, what you based it on, and the one point you most want corrected.",
  "",
  "Do not touch any gateway config yourself, and do not write a config file for it either. Put the",
  "script at `scripts/intercept.mjs` (or `.js`, `.cjs`, `.py`) and that is the whole contract: the",
  "plugin finds it by name, works out how to run it from the extension, and resolves the interpreter",
  "when it installs. A `.py` script is run with `uv run`, so write it self-contained — declare its",
  "dependencies in a PEP 723 `# /// script` block at the top rather than assuming an environment.",
  "",
  "Start your closing summary with one of these two words on a line of its own:",
  "READY — the work stands on its own and can go live as it is.",
  "BLOCKED — you need something from the user before the next round is worth running.",
  "",
  "When this run ends, that script goes live in the room by itself, so the user can test it straight",
  "away. Only put it at that path once it is worth running.",
  "",
  "That summary is handed straight to the user, and their reply lands in the transcript you tap next",
  "time. So end it by telling them what to do: try it in the room, then answer there (as",
  "`/aside <what is wrong>` if it is a complaint) and run /tap again to hand the turn back to you.",
].join("\n");
const DEFAULT_TAP_NOTIFY_COMMAND = ["openclaw", "message", "send"];
const DEFAULT_TAP_TIMEOUT_MS = 30 * 60_000;
/** 回報訊息的字數上限——聊天室塞不下一整份檢討，也不該塞。 */
const TAP_REPLY_LIMIT = 3000;

/** script 用這個 exit code 說「這句我不會，請交給 AI」。 */
const EXIT_PASS = 20;

/**
 * 「`/aside ＿＿`」：使用者留在房間裡、但不打算給任何人處理的一句話。
 * plugin 自己吃掉——不叫 AI、不跑 script、不回話。
 *
 * 名字取自戲劇的「旁白」：說出口、留在劇本裡，但台上其他角色聽不見。這裡也一樣，
 * 它留在房間的紀錄裡（`/tap` 事後撈得到），但 AI 與 script 都收不到。
 *
 * 抱怨天生是多行的，所以吃 [\s\S]*。`(?![\w-])` 讓 `/asidefoo` 不會被誤認；
 * telegram 在群組裡會把指令寫成 `/aside@botname`，所以 bot 名字要一起吃掉。
 * 標點不另外判斷：`/aside:` 這種本來就落在「後面接什麼就原樣記什麼」裡面。
 */
const ASIDE_RE = /^\/aside(?:@\S+)?(?![\w-])([\s\S]*)$/i;

/**
 * 「`/tap`」與「`/tap <projname>`」。telegram 在群組裡會把指令寫成
 * `/tap@botname`，所以 bot 名字要一起吃掉。
 *
 * `/tap` 後面必須是空白或字串結尾——否則 `/tapioca` 會被當成
 * 「tap 一個叫 ioca 的專案」。
 */
const TAP_RE = /^\/tap(?:@\S+)?(?:\s+([\s\S]*?))?\s*$/i;

/**
 * 專案名會直接接在 `projectsDir` 後面當路徑用，而它來自不受信任的聊天輸入，
 * 所以只收「一段自明的名字」：開頭必須是英數，因此不可能是 `.`、`..`
 * 或 `-rf`，中間也不允許任何路徑分隔字元。
 */
const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `.tap` 的 `viewed:` 尺規，跟 skill 那一側認的完全一樣：當地時間，
 * 可以只寫到日、到分或到秒。開新專案時 `/tap <projname> <yyyy-mm-dd>`
 * 就是把起點直接寫進這個欄位。
 */
const VIEWED_RE = /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/;

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

/**
 * 挑這個房間的 route；沒有就回 undefined（整輪放行給 AI）。
 *
 * 兩個來源，設定優先：
 *   1. `config.routes`——人手寫的，什麼都能設。
 *   2. 對照表裡 `installed` 的那一筆——`/tap -install` 開的。
 *
 * **為什麼上線不寫進 openclaw.json**：plugin config 不會 hot reload。實測過：
 * 設定檔在 17:01 改好，17:02 進來的訊息還是走舊的 route，要重啟 gateway 才算數。
 * 而「重啟 gateway」這件事 plugin 自己不能做——那等於在回話中途把自己殺掉。
 * 對照表則是每一則訊息都重讀一次，所以 `-install`／`-uninstall` **當場生效**，
 * 那才是使用者按下去時預期會發生的事。
 */
function selectRoute(ctx, config) {
  const routes = Array.isArray(config.routes) ? config.routes : [];
  const runtimeChannel = ctx?.channel ?? ctx?.messageProvider;
  const runtimeTarget = resolveRuntimeTarget(ctx);
  const configured = routes.find((route) => {
    // target 沒設，或既沒 command 也沒 project 的 route 一律略過——
    // 寧可多花 token，也不要亂攔。
    const runnable = (Array.isArray(route?.command) && route.command.length > 0) || Boolean(route?.project);
    if (!route?.target || !runnable) return false;
    if (route.channel && lower(runtimeChannel) !== lower(route.channel)) return false;
    const providers = [route.channel, ctx?.channel, ctx?.messageProvider];
    return normalizeTarget(runtimeTarget, ...providers) === normalizeTarget(route.target, ...providers);
  });
  if (configured) return configured;

  const tapConfig = config.tap && typeof config.tap === "object" ? config.tap : null;
  if (!tapConfig) return undefined;
  const room = { channel: runtimeChannel ?? "", target: runtimeTarget };
  const entry = readProjectIndex(tapConfig)[roomKey(room)];
  if (!entry?.installed || !entry.name) return undefined;
  return { project: entry.name, channel: room.channel, target: room.target };
}

/**
 * route 在 trace 與錯誤訊息裡叫什麼。
 *
 * 只寫 `project` 的 route 沒有 `name`——少了這個 fallback，log 裡每一行都會寫
 * `route: null`，看起來就像「沒有 route 對上」。那會讓人把「有攔到」誤讀成
 * 「沒攔到」，追起問題來完全反了方向。
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
 * 跑 route 的 script：payload 走 stdin JSON、回覆走 stdout。
 *
 * 不用 argv 傳使用者輸入——Windows 的 argv quoting 很容易出事，而且使用者
 * 的訊息是不受信任的輸入。
 */
/**
 * 這條 route 實際要跑什麼。
 *
 * 寫了 `command` 就照寫的跑——那是完全自由的逃生口。只寫 `project` 的話，
 * script 的位置與直譯器都照 `/tap` 那套約定推出來，**而且是每次派工時才推**：
 * 使用者換了 node 版本、重裝了 uv，設定檔一個字都不必改。
 */
function resolveRouteCommand(config, route) {
  if (Array.isArray(route.command) && route.command.length) return { command: route.command };
  const tapConfig = config.tap && typeof config.tap === "object" ? config.tap : null;
  const projectsDir = String(tapConfig?.projectsDir ?? "").trim();
  if (!projectsDir) return { error: `route "${route.project}" needs tap.projectsDir to be set` };
  if (!PROJECT_RE.test(String(route.project))) return { error: `"${route.project}" is not a usable project name` };
  const dir = join(projectsDir, String(route.project));
  const derived = deriveRoute(tapConfig, { name: String(route.project), dir });
  if (derived.error) return { error: derived.error };
  return { command: derived.route.command };
}

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
 * 把一則 `/aside` 寫進獨立的檔案，回傳錯誤訊息（空字串＝寫進去了）。
 *
 * 為什麼另開一個檔：debug log 記的是異常（放行、出錯），把使用者的抱怨堆進去
 * 等於把兩種完全不同的東西混在一起；而且 issue 不該因為某人沒開 debug 就消失——
 * 它是使用者親口說的待辦。一行一筆 JSON：多行原文照原樣保留，又不必自己
 * 發明跳脫規則。`/tap` 讀的就是這個檔。
 */
function recordAside(config, entry) {
  const file = config.asideLogFile || DEFAULT_ASIDE_LOG_FILE;
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${localStamp()} ${JSON.stringify(entry)}\n`, "utf8");
    return "";
  } catch (error) {
    return String(error?.message || error);
  }
}

// ---------------------------------------------------------------------------
// `/tap`：在聊天室裡就地叫起 AI harness
// ---------------------------------------------------------------------------
// 一個房間上線之後要檢討，本來得走到終端機、切到那個專案、叫起 Claude Code
// 這類 harness，再請它施展 `/tap` 技能。那幾步全是機械動作，沒有一步需要判斷，
// 所以搬進來由 plugin 做：使用者在房間裡打一句 `/tap` 就好。
//
// 被叫起的 harness **不需要知道自己是被誰叫起的**——它照舊站在專案目錄裡施展
// `/tap`，跟人從終端機叫它做的是同一件事。plugin 只決定兩件事：站在哪個目錄，
// 以及傳哪一句話。真正需要智力的部分全在 harness 那一側。

/** 從一個 `.tap` 讀出房間位置。認得的鍵跟 skill 一樣，這裡只用得到前兩個。 */
function readTap(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const tap = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(channel|target)\s*:\s*(.*?)\s*$/.exec(line);
    if (m && tap[m[1]] === undefined) tap[m[1]] = m[2];
  }
  return tap.target ? tap : null;
}

/** 讀 `.tap` 的 `viewed:`。讀不到就當空的——空的意思本來就是「從頭看」。 */
function readViewed(file) {
  try {
    const found = /^\s*viewed\s*:\s*(.*?)\s*$/m.exec(readFileSync(file, "utf8"));
    return found ? found[1] : "";
  } catch {
    return "";
  }
}

/** `.tap` 放專案根目錄或 `genesis/` 都行，順序跟 skill 找檔案的一致。 */
const tapFilesOf = (dir) => [join(dir, ".tap"), join(dir, "genesis", ".tap")];

/** 這個 `.tap` 指的是不是就是這個房間。target 兩邊都正規化過再比，跟 route 同一套規則。 */
function tapMatchesRoom(tap, room) {
  if (tap.channel && lower(tap.channel) !== lower(room.channel)) return false;
  const providers = [tap.channel, room.channel];
  return normalizeTarget(tap.target, ...providers) === normalizeTarget(room.target, ...providers);
}

/**
 * 掃 `projectsDir` 底下每個專案的 `.tap`，找出宣稱自己在這個房間上線的。
 *
 * 為什麼用 `.tap` 而不是 route 的設定來對應專案：route 指的是**部署出去的那支
 * script**，而檢討要開的是**原始碼專案**，這兩個地方常常不同。`.tap` 本來就是
 * 「這個專案在哪個房間上線」的唯一記載，拿它當索引就不必再多一份設定。
 */
function findTappedProjects(projectsDir, room) {
  let entries;
  try {
    entries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(projectsDir, entry.name);
    for (const file of tapFilesOf(dir)) {
      const tap = readTap(file);
      if (!tap) continue;
      if (tapMatchesRoom(tap, room)) found.push({ name: entry.name, dir, file });
      break; // 一個專案只認第一個 .tap
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// 房間 → 專案的對照表
// ---------------------------------------------------------------------------
// 光靠掃描 `.tap` 是不夠的：一個房間先後開過兩個專案，兩份 `.tap` 都還在，
// 掃描就再也分不出你要哪一個——而那正是「重測一次」最常見的現場。
//
// 所以認定哪個專案屬於這個房間，以這張表為準。`.tap` 不會因此變成裝飾品，
// 它仍然是「這個專案在哪個房間上線」的記載，也仍然是 skill 讀的那份；表只回答
// 一個掃描答不了的問題：**同一個房間，現在算哪一個專案的。**
//
// 表放在 state 目錄而不是專案裡，理由跟兩個 log 一樣：它帶著 chat id。

/** 一個房間一個 key。target 先正規化，`-100…` 與 `telegram:group:-100…` 是同一間。 */
const roomKey = (room) => `${lower(room.channel)}:${normalizeTarget(room.target, room.channel)}`;

function readProjectIndex(tapConfig) {
  const file = tapConfig.projectsFile || DEFAULT_PROJECTS_FILE;
  try {
    const index = JSON.parse(readFileSync(file, "utf8"));
    return index && typeof index === "object" ? index : {};
  } catch {
    return {}; // 還沒有表，或表壞了——兩種都當成「沒登記過」，退回掃描
  }
}

/**
 * 記下這個房間現在算哪個專案的，回傳被換掉的那個專案名（沒有就 null）。
 *
 * 同一個專案就只更新時間戳，其餘欄位（`installed`、`harnessRan`）原封不動——
 * 那些是這個房間目前的狀態，不該因為又 tap 了一次就被清掉。
 *
 * 換成別的專案則整筆重來：舊專案不再跑在這個房間（房間會先回到純 AI，直到新的
 * 那個裝得起來），舊的 session 記號也不該被新專案繼承。
 *
 * 寫不進去不算致命，退回掃描還是能動。
 */
function claimRoom(tapConfig, room, project, trace) {
  const file = tapConfig.projectsFile || DEFAULT_PROJECTS_FILE;
  const index = readProjectIndex(tapConfig);
  const key = roomKey(room);
  const previous = index[key];
  const same = previous?.name === project.name && previous?.dir === project.dir;
  index[key] = same
    ? { ...previous, claimed: localStamp() }
    : { name: project.name, dir: project.dir, claimed: localStamp() };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  } catch (error) {
    trace?.("tap: could not record the project", { failure: String(error?.message || error) });
  }
  return same ? null : (previous?.name ?? null);
}

/**
 * 這個房間該打開哪個專案。
 *
 * 表優先，但**表說了不算數就得驗**：目錄還在嗎、那份 `.tap` 還指著這個房間嗎。
 * 使用者把專案改名或搬走，往往就是要讓它從這裡消失——那就照他的意思消失，
 * 而且明白說出來，不要自作聰明地重新掃一個出來頂替。
 *
 * 表裡沒有才退回掃描；掃到唯一一個就順手記進表，下次不必再猜。
 */
function resolveProject(tapConfig, projectsDir, room, trace) {
  const entry = readProjectIndex(tapConfig)[roomKey(room)];
  if (entry?.dir) {
    const file = tapFilesOf(entry.dir).find((candidate) => {
      const tap = readTap(candidate);
      return tap && tapMatchesRoom(tap, room);
    });
    if (file) return { project: { name: entry.name || basename(entry.dir), dir: entry.dir, file } };
    return {
      error: `the project recorded for this room is gone: ${entry.dir}. Use "/tap <projname> [yyyy-mm-dd]" to start a new one.`,
    };
  }

  const found = findTappedProjects(projectsDir, room);
  if (found.length === 0) {
    return { error: `no project under ${projectsDir} has a .tap for this room. Use "/tap <projname> [yyyy-mm-dd]" to start one.` };
  }
  if (found.length > 1) {
    return { error: `${found.map((p) => p.name).join(", ")} all claim this room. Name the one you mean: /tap <projname>` };
  }
  claimRoom(tapConfig, room, found[0], trace);
  return { project: found[0] };
}

/** 改登記裡的某幾個欄位。沒登記過就不記——那種房間本來就沒有東西可以更新。 */
function updateRoom(tapConfig, room, patch, trace) {
  const file = tapConfig.projectsFile || DEFAULT_PROJECTS_FILE;
  const index = readProjectIndex(tapConfig);
  const key = roomKey(room);
  if (!index[key]) return;
  index[key] = { ...index[key], ...patch };
  try {
    writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  } catch (error) {
    trace?.("tap: could not update the project record", { failure: String(error?.message || error) });
  }
}

/** 讓這個房間不再屬於任何專案。`-uninstall` 用它，好讓房間真的回到空的。 */
function forgetRoom(tapConfig, room, trace) {
  const file = tapConfig.projectsFile || DEFAULT_PROJECTS_FILE;
  const index = readProjectIndex(tapConfig);
  const entry = index[roomKey(room)];
  if (!entry) return null;
  delete index[roomKey(room)];
  try {
    writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  } catch (error) {
    trace?.("tap: could not forget the project", { failure: String(error?.message || error) });
  }
  return entry;
}

/** 把 `viewed:` 改寫成指定的起點，其餘的行原封不動。 */
function setViewed(file, viewed) {
  const text = readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const line = `viewed:  ${viewed}`;
  let found = false;
  const lines = text.split(/\r?\n/).map((current) => {
    if (!/^\s*viewed\s*:/.test(current)) return current;
    found = true;
    return line;
  });
  if (!found) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    lines.push(line, "");
  }
  writeFileSync(file, lines.join(eol), "utf8");
}

/**
 * 替這個房間開一個新專案：只寫 `.tap`，其餘留給 harness。
 *
 * 已經有 `.tap` 的話**不會**自己去動它——裡面的 `viewed:` 是上一輪檢討的進度，
 * 蓋掉等於叫下一輪從頭看起。只有使用者自己打了起點日期才改，那是他明講的。
 * 指到別的房間就直接說，不要默默改掉別人的現場。
 */
function createTappedProject(projectsDir, name, room, viewed) {
  const dir = join(projectsDir, name);
  for (const file of tapFilesOf(dir)) {
    const tap = readTap(file);
    if (!tap) continue;
    if (!tapMatchesRoom(tap, room)) return { error: `${name} already has a .tap pointing at another room (${file})` };
    if (viewed) setViewed(file, viewed);
    return { name, dir, file, viewed };
  }
  const file = join(dir, "genesis", ".tap");
  const fresh = !existsSync(dir);
  mkdirSync(dirname(file), { recursive: true });
  // viewed 留空＝從頭看全部。房間常常是先亂聊很久才決定開專案，那種時候
  // 使用者會給一個起點日期，這裡就把它當成「上一輪已經看到這裡了」。
  writeFileSync(file, `channel: ${room.channel}\ntarget:  ${room.target}\nviewed:${viewed ? `  ${viewed}` : ""}\n`, "utf8");
  // `.tap` 絕不進版控——頻道位置是敏感資訊。全新的目錄順手把擋板放好，
  // 免得日後 git init 的人不知道有這回事。既有的 .gitignore 一律不動。
  const ignore = join(dir, ".gitignore");
  if (fresh && !existsSync(ignore)) writeFileSync(ignore, ".tap\n", "utf8");
  return { name, dir, file, viewed, created: true };
}

/** 同一個專案一次只跑一輪：兩個 harness 同時改同一份 script 只會互相蓋掉。 */
const tapRuns = new Set();

/** 聊天室不是 log viewer：太長就只留結論那一段，而結論在尾巴。 */
const tapTail = (text) => (text.length <= TAP_REPLY_LIMIT ? text : `…${text.slice(-TAP_REPLY_LIMIT)}`);

/**
 * harness 跑完之後回房間報告。
 *
 * 走 `openclaw message send` 而不是 hook 的回傳值——那一輪早在幾分鐘前就回完了。
 * 這跟 script 想額外送一則訊息時的做法是同一條路（見 AUTHORING.md 第 9 節）。
 */
function notifyRoom(tapConfig, room, text, trace) {
  const [command, ...args] = tapConfig.notifyCommand?.length ? tapConfig.notifyCommand : DEFAULT_TAP_NOTIFY_COMMAND;
  execFile(
    command,
    [...args, "--channel", room.channel, "--target", room.target, "--message", text],
    { encoding: "utf8", windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 },
    (error) => {
      if (error) trace("tap: report failed", { failure: String(error.stderr || error.message || error).trim() });
    },
  );
}

/**
 * 叫起 harness，然後**立刻**放手。
 *
 * 不等它跑完：一輪檢討動輒好幾分鐘，而 hook 卡住的就是那一則訊息的回覆——
 * 使用者會盯著一個沒有反應的房間。所以先回一句「開始了」，跑完再補一則結果。
 * 代價是 gateway 中途重開的話那則結果就沒了，log 裡還看得到。
 */
function runTap(tapConfig, project, room, trace) {
  // 第二輪之後可以接續同一個 harness session，前提是設定裡給了 continueCommand
  // ——plugin 不假設 harness 的 CLI 長什麼樣子，那句 `--continue` 是操作者寫的。
  //
  // 「這個專案跑過了沒」不去猜，看登記：猜錯的代價是第一輪就叫 harness 去接續
  // 一個不存在的 session，整輪直接失敗。
  const entry = readProjectIndex(tapConfig)[roomKey(room)];
  const continued = Boolean(entry?.harnessRan && tapConfig.continueCommand?.length);
  const argv = continued ? tapConfig.continueCommand : tapConfig.command?.length ? tapConfig.command : DEFAULT_TAP_COMMAND;
  const [command, ...args] = argv;
  const prompt = tapConfig.prompt || DEFAULT_TAP_PROMPT;
  const started = Date.now();
  const viewedBefore = readViewed(project.file);
  tapRuns.add(project.dir);
  const child = execFile(
    command,
    [...args, prompt],
    {
      encoding: "utf8",
      windowsHide: true,
      cwd: project.dir,
      timeout: tapConfig.timeoutMs ?? DEFAULT_TAP_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...(tapConfig.env ?? {}) },
    },
    async (error, stdout, stderr) => {
      tapRuns.delete(project.dir);
      const seconds = Math.round((Date.now() - started) / 1000);
      const exitCode = typeof error?.code === "number" ? error.code : error ? -1 : 0;
      const failure = error ? String(error.stderr || stderr || error.message || error).trim() : "";
      trace("tap: finished", { project: project.name, exitCode, seconds, continued });
      if (error) {
        // 接續失敗（session 過期、被刪掉…）就把記號拿掉，下一輪從乾淨的開始，
        // 免得每一輪都撞同一面牆。
        if (continued) updateRoom(tapConfig, room, { harnessRan: false }, trace);
        const note = continued ? "\nThe next /tap will start a fresh session." : "";
        notifyRoom(
          tapConfig,
          room,
          tapTail(`tap: ${project.name} failed after ${seconds}s\n${failure || (stdout ?? "").trim()}${note}`.trim()),
          trace,
        );
        return;
      }
      // `viewed` 往前推＝這一段結案了：來龍去脈已經寫進 repo，逐字稿也翻頁了。
      // 那就是丟掉累積 context 的正確時機——session 不能無限 --continue 下去，
      // 而「使用者滿意到願意推書籤」正好是最誠實的那條分界線。
      const viewedAfter = readViewed(project.file);
      const closed = Boolean(viewedAfter) && viewedAfter !== viewedBefore;
      updateRoom(tapConfig, room, { harnessRan: !closed }, trace);
      // 跑完就上線，使用者才有東西可以測。失敗的那一輪不裝——那一輪的產物
      // 本來就不該相信。
      let installed = "";
      try {
        installed = await autoInstall(tapConfig, room, project, trace);
      } catch (problem) {
        installed = `not installed: ${String(problem?.message || problem)}`;
      }
      const chapter = closed ? `viewed moved to ${viewedAfter} — the next /tap starts a fresh session.` : null;
      const report = [`tap: ${project.name} done in ${seconds}s`, installed || null, chapter, (stdout ?? "").trim() || null]
        .filter(Boolean)
        .join("\n");
      notifyRoom(tapConfig, room, tapTail(report), trace);
    },
  );
  // harness 不讀 stdin，關掉它才不會有人在那裡等一個永遠不來的輸入。
  child.stdin?.on("error", () => {});
  child.stdin?.end();
}

// ---------------------------------------------------------------------------
// `/tap -install` / `/tap -uninstall`：上線與下線
// ---------------------------------------------------------------------------
// 上線刻意**不是** harness 自己做的，而是使用者自己打的一句指令。
//
// harness 每一輪只做兩件事：把程式寫好，然後回報。要不要讓這個房間真的開始
// 走那支 script，是使用者看完回報之後的決定——他可能還要再問幾句、再改幾輪。
// 把上線交給人，才有「一來一往」可言；由 AI 自動裝上去的話，每一輪都會直接
// 生效，半成品也會。
//
// 於是這一步就完全不需要智力了：harness 把它要的 route 寫成
// 約定的位置放一支 script，`/tap -install` 只是照副檔名推出怎麼跑它、補上房間、寫進設定。

/**
 * 這個專案的 script 在哪。約定俗成的位置，由上而下第一個找到的算數。
 *
 * 為什麼是約定而不是設定：一個專案只會有一支攔截 script，而它叫什麼、放哪裡，
 * 每個專案都一樣。要為此多一個設定檔，等於每開一個專案就要使用者重講一次大家
 * 都知道的事。真的要放在別的地方，那就自己寫一條 route 進 openclaw.json——
 * 從聊天室裝的這條路只認約定。
 */
const SCRIPT_CANDIDATES = [
  join("scripts", "intercept.mjs"),
  join("scripts", "intercept.js"),
  join("scripts", "intercept.cjs"),
  join("scripts", "intercept.py"),
  "intercept.mjs",
  "intercept.js",
  "intercept.cjs",
  "intercept.py",
];

/**
 * 在 PATH 上找一支可執行檔，回傳絕對路徑。
 *
 * gateway 是服務啟動的，PATH 跟 shell 不一樣，所以除了 PATH 也看 `~/.local/bin`
 * ——uv 這類工具的預設落點。**Windows 上只認 `.exe`**：`.cmd`／`.bat` 在
 * Node 20 之後不能直接 execFile，裝下去會在第一則訊息才爆炸，不如現在就說找不到。
 */
const executableCache = new Map();
function findExecutable(name) {
  if (executableCache.has(name)) return executableCache.get(name);
  const found = searchPath(name);
  executableCache.set(name, found);
  return found;
}

function searchPath(name) {
  const suffixes = process.platform === "win32" ? [".exe", ".com"] : [""];
  const dirs = [...String(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")];
  for (const dir of dirs) {
    if (!dir.trim()) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir.trim(), `${name}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * 副檔名決定怎麼跑它，而且**是安裝當下才解析**——不是寫死在設定檔裡。
 * 寫死的路徑會因為換 node 版本、重裝 uv 就悄悄失效。
 *
 *   .mjs/.js/.cjs  gateway 自己這支 node。那是唯一保證跑得起來的路徑，不必偵測。
 *   .py            先找 uv（`uv run <script>`），沒有才退而找 python。
 *
 * `tap.interpreters`（副檔名 → argv 前綴）永遠優先，留給不在這張表上的東西。
 */
function interpreterFor(tapConfig, ext) {
  const configured = tapConfig.interpreters?.[ext];
  if (Array.isArray(configured) && configured.length) return { argv: configured.map(String) };
  if (ext === ".mjs" || ext === ".js" || ext === ".cjs") return { argv: [process.execPath] };
  if (ext === ".py") {
    const uv = findExecutable("uv");
    if (uv) return { argv: [uv, "run"] };
    const python = findExecutable("python") || findExecutable("python3");
    if (python) return { argv: [python] };
    return { error: "neither uv nor python was found on PATH" };
  }
  return { error: `nothing is configured to run ${ext} files — add tap.interpreters["${ext}"]` };
}

/**
 * 從專案目錄推出要裝的 route。**沒有設定檔**：
 *
 *   name     ← 專案目錄名
 *   command  ← 約定位置的 script ＋ 副檔名對應的直譯器（安裝當下解析）
 *
 * `onError` 與 `timeoutMs` 用 plugin 的預設值就好；實務上不會有別的選擇，
 * 真的要不一樣就自己去 openclaw.json 改那一條。
 */
function deriveRoute(tapConfig, project) {
  const relative = SCRIPT_CANDIDATES.find((candidate) => existsSync(join(project.dir, candidate)));
  if (!relative) {
    return { error: `${project.name} has no script yet (looked for scripts/intercept.mjs, .js, .cjs and .py).` };
  }
  const ext = extname(relative).toLowerCase();
  const interpreter = interpreterFor(tapConfig, ext);
  if (interpreter.error) return { error: `cannot run ${relative}: ${interpreter.error}.` };
  // 設定裡給的直譯器也要真的存在。裝下去之後每一則訊息都會跑它，打錯一個字母的
  // 代價是整個房間開始回錯誤訊息。
  const missing = interpreter.argv.filter((arg) => /^([A-Za-z]:[\/]|\/)/.test(arg) && !existsSync(arg));
  if (missing.length) return { error: `the interpreter for ${ext} does not exist: ${missing.join(", ")}` };
  return { route: { name: project.name, command: [...interpreter.argv, join(project.dir, relative)] } };
}

/** 這條 route 綁的是不是這個房間。 */
const routeBoundTo = (route, room) => {
  if (route?.channel && lower(route.channel) !== lower(room.channel)) return false;
  const providers = [route?.channel, room.channel];
  return normalizeTarget(route?.target, ...providers) === normalizeTarget(room.target, ...providers);
};

/**
 * 把這個專案設成這個房間的 route。
 *
 * 寫的是對照表，不是 openclaw.json——理由見 selectRoute 上面那段：那份設定不會
 * hot reload，寫進去要重啟才算數，而使用者按完 `-install` 的下一秒就會去試。
 * 順帶一個好處：**一則聊天訊息再也碰不到 gateway 的設定。**
 *
 * 已經是這個專案就什麼都不做（`unchanged`）；第二輪之後多半都是這樣。
 */
async function applyRoute(tapConfig, room, project) {
  // 先確定它真的跑得起來：script 在不在、副檔名對應的直譯器找不找得到。
  // 裝一條跑不動的 route，只會讓整個房間開始回錯誤訊息。
  const spec = deriveRoute(tapConfig, project);
  if (spec.error) return { error: spec.error };

  const entry = readProjectIndex(tapConfig)[roomKey(room)];
  if (entry?.installed && entry.name === project.name) {
    return { name: project.name, command: spec.route.command, unchanged: true };
  }
  claimRoom(tapConfig, room, project);
  updateRoom(tapConfig, room, { installed: true });
  return { name: project.name, command: spec.route.command };
}

/** `/tap -install`：使用者自己按的上線。 */
async function installRoute(tapConfig, room, project) {
  const result = await applyRoute(tapConfig, room, project);
  if (result.error) return `tap: ${result.error}`;
  if (result.unchanged) return `tap: ${result.name} was already live here, unchanged.`;
  return [
    `tap: ${result.name} is live in this room.`,
    `runs: ${result.command.join(" ")}`,
    "Say something here to test it. If nothing intercepts, the gateway needs a restart.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * harness 跑完之後的自動上線。
 *
 * 為什麼自動：使用者要的是「改完就能測」。上線這件事本身沒有任何判斷——
 * script 放在約定位置就是裝什麼——所以讓他每一輪都要多打一句 `/tap -install`
 * 只是把一個機械動作變成一個要記得的步驟。
 *
 * 但它仍然**不是 harness 自己裝的**：harness 只把 script 寫到約定位置，裝的是 plugin，
 * 而且照的是同一套檢查（檔案要在、command 要指到專案裡面、先 dry-run）。
 * 不想要就把 `tap.autoInstall` 設成 false，改回自己按 `/tap -install`。
 */
async function autoInstall(tapConfig, room, project, trace) {
  if (tapConfig.autoInstall === false) return "";
  const result = await applyRoute(tapConfig, room, project);
  if (result.error && /has no script yet/.test(result.error)) return ""; // 還不是一條 route，沒事
  trace("tap: auto-install", { project: project.name, ...result, command: undefined });
  if (result.error) return `not installed: ${result.error}`;
  if (result.unchanged) return "";
  return `installed: ${result.name} is live in this room now — say something to test it.`;
}

/**
 * `/tap -uninstall`：讓房間真的回到空的。
 *
 * 清掉對照表那一筆——route 沒了、專案綁定也沒了，而且**當場生效**。
 * 專案的檔案一個都不動：那是上一輪的成果，也是下一輪比對的依據。
 *
 * openclaw.json 裡人手寫的 route 不歸這裡管：那是操作者自己設的，改了也要重啟
 * 才算數。有的話就照實說，別讓使用者以為已經拆乾淨了。
 */
async function uninstallRoute(tapConfig, room, config, trace) {
  const entry = readProjectIndex(tapConfig)[roomKey(room)];
  const forgotten = entry ? forgetRoom(tapConfig, room, trace) : null;
  const handWritten = (Array.isArray(config?.routes) ? config.routes : [])
    .filter((route) => routeBoundTo(route, room))
    .map((route) => routeLabel(route) ?? "(unnamed)");

  if (!forgotten && !handWritten.length) return "tap: this room has no route and no project.";
  return [
    forgotten?.installed
      ? `tap: ${forgotten.name} no longer runs here, and the room no longer belongs to it.`
      : forgotten
        ? `tap: the room no longer belongs to ${forgotten.name} (it was not running).`
        : "tap: this room had no project.",
    forgotten ? "Its files are untouched." : null,
    handWritten.length
      ? `Careful: openclaw.json still has a route for this room (${handWritten.join(", ")}). Remove it yourself and restart the gateway.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * `/tap` 三種寫法的全部邏輯，回傳要立刻回給使用者的那句話：
 *
 *   `/tap`                        依 channel + target 比對各專案的 `.tap`
 *   `/tap <projname>`             寫一個新的 `.tap` 記住這個房間
 *   `/tap <projname> yyyy-mm-dd`  同上，但汲取只從那一天開始
 *
 * 三條路合流之後做的是同一件事：換到那個目錄，把 harness 叫起來。
 *
 * 另外兩個是上線與下線，它們不叫 harness，只改設定：
 *
 *   `/tap -install`               把這個房間對應專案的 script 裝成 route
 *   `/tap -uninstall`             把這個房間的 route 拆掉
 *
 * `-` 開頭永遠不會跟專案名撞到——專案名的第一個字必須是英數。
 */
async function startTap(config, tapConfig, room, args, senderId, trace) {
  // 第一個詞是專案名，剩下的是起點——起點自己就帶空白（`日期 時:分`），
  // 所以只切第一刀。
  const [, name, viewed] = /^(\S*)\s*([\s\S]*)$/.exec(args);
  // 這一句會在這台機器上叫起一個能改檔案的 agent，所以允許誰下這個指令
  // 是設定要管的事。沒設 allowFrom 就是「房間裡的人都可以」。
  const allowFrom = Array.isArray(tapConfig.allowFrom) ? tapConfig.allowFrom.map(String) : null;
  if (allowFrom && !allowFrom.includes(String(senderId))) return "tap: this account is not allowed to run tap here.";

  const projectsDir = String(tapConfig.projectsDir ?? "").trim();
  if (!projectsDir) return "tap: set tap.projectsDir in the plugin config first.";
  if (!room.channel) return "tap: this conversation has no channel id, so a .tap cannot be written.";

  // `-` 開頭是選項而不是專案名——專案名的第一個字必須是英數，所以兩者永遠不會撞。
  const flag = name.startsWith("-") ? lower(name).replace(/^-+/, "") : "";
  if (flag && flag !== "install" && flag !== "uninstall") {
    return `tap: unknown option "${name}". Use /tap, /tap <projname> [yyyy-mm-dd], /tap -install or /tap -uninstall.`;
  }
  if (flag && viewed) return `tap: ${name} takes no further arguments.`;
  // 下線不必知道是哪個專案：這個房間有幾條 route 就拆幾條。
  if (flag === "uninstall") return uninstallRoute(tapConfig, room, config, trace);

  let project;
  let displaced = null;
  if (name && !flag) {
    // 只給了一個日期，多半是想開新專案卻漏了名字。開一個叫 2026-08-20 的
    // 目錄絕對不是他要的，所以問回去。
    if (VIEWED_RE.test(args)) return `tap: a start date needs a project name: /tap <projname> ${args}`;
    if (!PROJECT_RE.test(name)) {
      return `tap: "${name}" is not a usable project name (one path segment: letters, digits, dot, dash, underscore).`;
    }
    if (viewed && !VIEWED_RE.test(viewed)) {
      return `tap: "${viewed}" is not a usable start date. Use /tap ${name} yyyy-mm-dd.`;
    }
    try {
      project = createTappedProject(projectsDir, name, room, viewed);
    } catch (error) {
      return `tap: could not create ${name}: ${String(error?.message || error)}`;
    }
    if (project.error) return `tap: ${project.error}`;
    // 指名道姓的那一刻就是宣告主權：這個房間從現在起算這個專案的，
    // 舊專案的 `.tap` 留在原地也不再構成歧義。
    displaced = claimRoom(tapConfig, room, project, trace);
  } else {
    const resolved = resolveProject(tapConfig, projectsDir, room, trace);
    if (resolved.error) return `tap: ${resolved.error}`;
    project = resolved.project;
  }

  // 上線是**使用者**的決定，不是 harness 的：它每一輪只寫程式跟回報，
  // 要不要讓這個房間真的開始走那支 script，等你看完回報再說。
  if (flag === "install") return installRoute(tapConfig, room, project);

  if (tapRuns.has(project.dir)) return `tap: ${project.name} is still running.`;
  runTap(tapConfig, project, room, trace);
  const notes = [
    project.created ? "new project" : null,
    displaced ? `taken over from ${displaced}, which no longer runs here` : null,
    project.viewed ? `from ${project.viewed}` : null,
  ].filter(Boolean);
  const suffix = notes.length ? ` (${notes.join(", ")})` : "";
  return `tap: ${project.name} started in ${project.dir}${suffix}. I will report back when it finishes.`;
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
        trace("turn", { body, channel, target, sessionKey: ctx?.sessionKey, route: routeLabel(route) });

        // `/tap`：從聊天室裡就地叫起 AI harness，請它施展**它自己的** /tap 技能，
        // 回頭檢討這個房間。這裡不要求房間已經有 route——
        // `/tap <projname>` 正是拿來替一個還沒有 script 的新房間開專案的。
        const tapConfig = config.tap && typeof config.tap === "object" ? config.tap : null;
        const tapMatch = tapConfig ? TAP_RE.exec(body.trim()) : null;
        if (tapMatch) {
          const args = (tapMatch[1] ?? "").trim();
          const text = await startTap(config, tapConfig, { channel: channel ?? "", target }, args, ctx?.senderId ?? "", trace);
          trace("tap", { args: args || null, route: routeLabel(route), reply: text });
          return { handled: true, reply: { text }, reason: "chat-interceptor: tap" };
        }
        // `/aside ＿＿` 排在所有東西前面，而且**每個房間的行為都一樣**：不管有沒有
        // route、有沒有專案、debug 開不開，它就是被記下來、不回話。
        //
        // 這是刻意的：使用者要的是「我在這裡留一句，誰都不要處理」。如果它在某些
        // 房間會突然叫醒 AI，那他每留一句話之前都得先想「這間算不算」——那就不是
        // 一個他敢用的東西了。斜線指令也打不出意外，不必擔心誤攔。
        const aside = ASIDE_RE.exec(body);
        if (aside) {
          const failure = recordAside(config, {
            text: aside[1].trim(),
            channel: channel ?? "",
            target,
            route: route?.name ?? "",
          });
          trace("aside", { route: routeLabel(route), chars: aside[1].trim().length, failure: failure || undefined });
          // 寫失敗一定要說。使用者要的是「記一下、不要有反應」，
          // 但「沒記到卻也沒反應」就是把他的話默默弄丟了。
          return {
            handled: true,
            ...(failure ? { reply: { text: `aside not recorded: ${failure}` } } : {}),
            reason: `chat-interceptor: aside${failure ? " (write failed)" : ""}`,
          };
        }

        if (!route) return;

        // 原樣送出，不做 normalize——各 script 自己決定怎麼解讀。
        const payload = {
          body,
          channel: channel ?? "",
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

        if (result.exitCode !== 0) {
          // 預設把錯誤也算 handled：script 可能已經有副作用（例如記帳寫了一半），
          // 放行給 AI 會讓 AI 再做一次。無副作用的 script 才適合 passthrough。
          if (route.onError === "passthrough") {
            trace("pass: script failed", { route: routeLabel(route), exitCode: result.exitCode, failure: result.failure });
            return;
          }
          trace("error", { route: routeLabel(route), exitCode: result.exitCode, failure: result.failure });
          return {
            handled: true,
            reply: { text: `${routeLabel(route) ?? "script"} failed: ${result.failure}` },
            reason: `chat-interceptor: ${routeLabel(route) ?? "script"} failed`,
          };
        }

        trace("handled", { route: routeLabel(route), stdout: result.stdout });
        // stdout 空的就是「處理掉但不回話」——OpenClaw 會補靜默 token NO_REPLY。
        return {
          handled: true,
          ...(result.stdout ? { reply: { text: result.stdout } } : {}),
          reason: `chat-interceptor: ${routeLabel(route) ?? "script"}`,
        };
      },
      { priority: 100 },
    );
  },
});
