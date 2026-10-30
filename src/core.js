// plugin 的機械部分：房間怎麼認、對照表怎麼讀寫、`.tap` 長什麼樣、script 怎麼找、
// 訊息怎麼送、寫程式的 AI 怎麼叫。不 import openclaw 的 SDK，測試才載得起來。

import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, extname, join } from "node:path";

export const DEFAULT_PROJECTS_FILE = join(homedir(), ".openclaw", "chat-interceptor-projects.json");
export const DEFAULT_OPENCLAW = ["openclaw"];

/**
 * /fiat 叫得起的 AI harness，以及叫它們的程式。兩支程式的介面一模一樣：
 * `-d <dir> [prompt]` 開（印出 pid）、`-p <pid> <text>` 打字、`-p <pid> -s` 看、`-p <pid> -q` 關、
 * `-m <舊目錄> <新目錄>` 目錄改名之後，把它為那個目錄記的東西搬過去。
 * 設定裡 `fiat.<runner>` 是它的 argv，沒設就在 PATH 上找。
 */
export const HARNESSES = {
  claude: { label: "Claude Code", runner: "ccrun" },
  codex: { label: "Codex", runner: "cdrun" },
};
export const DEFAULT_HARNESS = "claude";

// OpenClaw 自己在 hook-agent-context.ts 用的同一組 conversation prefix。
const CONVERSATION_PREFIXES = new Set(["channel", "chat", "direct", "dm", "group", "thread", "user"]);

export const lower = (value) => String(value ?? "").trim().toLowerCase();

/**
 * 當地時間 `YYYY-MM-DD HH:MM:SS`。
 *
 * offstage log 與 `.tap` 的 `timestamp:` 都用這個尺規：它們是拿來跟聊天室裡看到的
 * 時間對照的，同一個尺規就不必換算時區，比大小也直接字串比就好。
 */
export function localStamp(date = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ` +
    `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`
  );
}

/**
 * 把各種寫法收斂成同一個對話 id。
 *
 * 各 channel 的 target 長得不一樣：telegram 是 `-1001234567890`，
 * discord 是 `channel:123456789012345678`。而 hook 拿到的 ctx.chatId 一律是剝過 prefix 的
 * 裸 id。所以設定裡不管寫 `123456789012345678`、`channel:123456789012345678` 還是
 * `discord:channel:123456789012345678`，都要能對上執行時的 `123456789012345678`。
 */
export function normalizeTarget(value, ...providers) {
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

/**
 * 一個房間一個 key。target 先正規化，`-100…` 與 `telegram:group:-100…` 是同一間。
 * key 只拿來找對照表，不拿來送訊息：它拿掉了 `user:` 這種種類，Discord 的私聊就送不到了。
 */
export const roomKey = (room) => `${lower(room.channel)}:${normalizeTarget(room.target, room.channel)}`;

// ---------------------------------------------------------------------------
// 房間 → 專案的對照表
// ---------------------------------------------------------------------------
// 一個房間一筆：`{ name, dir, agent, installed, skill, installedDir, harness, pid, token, go, closing }`。
//   name / dir     這個房間綁的是哪個專案（開發目錄）
//   agent          這個房間的 OpenClaw agent，skill 裝進它的 workspace
//   installed      裝上了：`installedDir` 是 OpenClaw 裡那一份上線版，route 跑的是它的 script
//   skill          裝上去的 skill 名字
//   harness        上一次叫起的是哪一種 AI（HARNESSES 的 key）；開著的話就是它，下一輪沒指定也叫它
//   pid            開著的 session（ccrun／cdrun 的把手）
//   token          這一輪的回報憑證：回報程式拿它找到這一筆，舊 session 拿不到新一輪的
//   go             這一輪是不是連續版：FIAT 文件寫好，回報程式就注入 `go`
//   closing        回報程式說這一輪做完了，等 gateway 把 session 關掉
//
// 放在 state 目錄而不是專案裡：它帶著 chat id。

export function readIndex(file) {
  try {
    const index = JSON.parse(readFileSync(file, "utf8"));
    return index && typeof index === "object" ? index : {};
  } catch {
    return {}; // 還沒有表，或表壞了——都當成「沒登記過」
  }
}

/** 整張表寫回去。值是 undefined 的欄位寫出去時自然消失。 */
export function writeIndex(file, index) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

/** 改一筆；`patch` 是 null 就整筆拿掉。 */
export function patchRoom(file, key, patch) {
  const index = readIndex(file);
  if (patch === null) delete index[key];
  else index[key] = { ...(index[key] ?? {}), ...patch };
  writeIndex(file, index);
  return index[key] ?? null;
}

// ---------------------------------------------------------------------------
// `.tap`：這個專案在哪個房間出生，以及上一輪看到哪裡
// ---------------------------------------------------------------------------
// 只有三個欄位：channel / target / timestamp。永不進版控——房間位置是敏感資訊。

/** `.tap` 放專案根目錄或 `genesis/` 都行，順序跟 skill 找檔案的一致。 */
export const tapFileOf = (dir) => [join(dir, ".tap"), join(dir, "genesis", ".tap")].find((file) => existsSync(file)) ?? null;

export function readTap(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const tap = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(channel|target|timestamp)\s*:\s*(.*?)\s*$/.exec(line);
    if (m && tap[m[1]] === undefined) tap[m[1]] = m[2];
  }
  return tap;
}

export function writeTap(file, { channel, target, timestamp = "" }) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `channel:   ${channel}\ntarget:    ${target}\ntimestamp:${timestamp ? ` ${timestamp}` : ""}\n`, "utf8");
}

/** 改 `.tap` 裡的某幾個欄位，其餘的行原封不動；沒有那一行就補在最後。 */
export function patchTap(file, fields) {
  const text = readFileSync(file, "utf8");
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  for (const [key, value] of Object.entries(fields)) {
    const line = `${`${key}:`.padEnd(10)} ${value}`.trimEnd();
    const index = lines.findIndex((current) => new RegExp(`^\\s*${key}\\s*:`).test(current));
    if (index === -1) lines.push(line);
    else lines[index] = line;
  }
  writeFileSync(file, `${lines.join(eol)}${eol}`, "utf8");
}

// ---------------------------------------------------------------------------
// 專案就是一個 skill：SKILL.md 教 AI 處理 script 放行的那些，script 攔確定性的那些
// ---------------------------------------------------------------------------

/**
 * 專案裡的 skill 目錄：專案根目錄本身有 SKILL.md 就是它，否則是底下唯一一個有
 * SKILL.md 的子目錄（`<專案>/<skill>/SKILL.md`）。
 */
export function skillDirOf(projectDir) {
  if (existsSync(join(projectDir, "SKILL.md"))) return { dir: projectDir };
  let entries = [];
  try {
    entries = readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return { error: `${projectDir} does not exist.` };
  }
  const found = entries
    .filter((entry) => entry.isDirectory() && existsSync(join(projectDir, entry.name, "SKILL.md")))
    .map((entry) => join(projectDir, entry.name));
  if (found.length === 1) return { dir: found[0] };
  if (found.length === 0) return { error: `${basename(projectDir)} has no skill yet (no SKILL.md in it or in a folder right under it).` };
  return { error: `${basename(projectDir)} has more than one skill: ${found.map((dir) => basename(dir)).join(", ")}.` };
}

/**
 * 把專案的 skill 裝進 OpenClaw：`openclaw skills install <skill 目錄> --force [--agent <id>]`。
 *
 * 裝進去的是一份**複製**（那個 agent 的 workspace `skills/` 底下），那一份才是上線版：
 * AI 讀的是它的 SKILL.md，route 跑的是它的 script。開發目錄之後怎麼改都不影響線上，
 * 直到再裝一次。載入 skill 是 OpenClaw 的事，plugin 只負責把 route 指到那一份。
 */
export async function installSkill({ openclaw, interpreters, agent, name, dir, installedDir }) {
  const skill = skillDirOf(dir);
  if (skill.error) return { error: skill.error };
  // 裝之前先確定 script 在、直譯器找得到：裝一條跑不動的 route，整個房間都會開始回錯誤訊息。
  const check = deriveRoute(interpreters, { name, dir: skill.dir });
  if (check.error) return { error: check.error };
  // `--force` 是先把舊的那份搬去備份、再把新的改名進來。Windows 上改名撞到 EPERM（有程式
  // 握著那個目錄）、還原也失敗的時候，線上那份就整個不見了，房間裡每一句都找不到 script。
  // 所以自己先留一份：失敗了、而且它真的不見了，就放回去。
  const keep = installedDir && existsSync(installedDir) ? mkdtempSync(join(tmpdir(), "chat-interceptor-skill-")) : null;
  try {
    if (keep) cpSync(installedDir, keep, { recursive: true });
    const result = await run(
      [...openclawOf(openclaw), "skills", "install"],
      [skill.dir, "--force", ...(agent ? ["--agent", agent] : [])],
      { timeout: 180_000 },
    );
    const installed = /^Installed (\S+) from \S+ -> (.+?)\s*$/m.exec(result.stdout);
    if (!result.ok || !installed) {
      const lost = keep && !existsSync(installedDir);
      if (lost) cpSync(keep, installedDir, { recursive: true });
      const restored = lost ? " The previous install was put back." : "";
      return { error: `openclaw skills install failed: ${result.failure || result.stdout}${restored}` };
    }
    const route = deriveRoute(interpreters, { name, dir: installed[2] });
    if (route.error) return { error: route.error };
    return { skill: installed[1], installedDir: installed[2], command: route.command };
  } finally {
    if (keep) rmSync(keep, { recursive: true, force: true });
  }
}

/** 拿掉 installSkill 裝上去的那一份。只認 `…/skills/<名字>` 這種位置，別的一律不動。 */
export function removeInstalledSkill(installedDir) {
  if (!installedDir || basename(dirname(installedDir)).toLowerCase() !== "skills") return false;
  rmSync(installedDir, { recursive: true, force: true });
  return true;
}

/**
 * skill 的攔截 script 在哪。約定俗成的位置，由上而下第一個找到的算數。
 *
 * 為什麼是約定而不是設定：一個 skill 只會有一支攔截 script，而它叫什麼、放哪裡，
 * 每個 skill 都一樣。真的要放在別的地方，那就自己寫一條 route 進 openclaw.json。
 */
export const SCRIPT_CANDIDATES = [
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
  const suffixes = process.platform === "win32" ? [".exe", ".com"] : [""];
  const dirs = [...String(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")];
  let found = null;
  for (const dir of dirs) {
    if (found || !dir.trim()) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir.trim(), `${name}${suffix}`);
      if (existsSync(candidate)) {
        found = candidate;
        break;
      }
    }
  }
  executableCache.set(name, found);
  return found;
}

/**
 * 副檔名決定怎麼跑它，而且**是派工當下才解析**——不是寫死在設定檔裡。
 * 寫死的路徑會因為換 node 版本、重裝 uv 就悄悄失效。
 *
 *   .mjs/.js/.cjs  gateway 自己這支 node。那是唯一保證跑得起來的路徑，不必偵測。
 *   .py            先找 uv（`uv run <script>`），沒有才退而找 python。
 *
 * `fiat.interpreters`（副檔名 → argv 前綴）永遠優先，留給不在這張表上的東西。
 */
function interpreterFor(interpreters, ext) {
  const configured = interpreters?.[ext];
  if (Array.isArray(configured) && configured.length) return { argv: configured.map(String) };
  if (ext === ".mjs" || ext === ".js" || ext === ".cjs") return { argv: [process.execPath] };
  if (ext === ".py") {
    const uv = findExecutable("uv");
    if (uv) return { argv: [uv, "run"] };
    const python = findExecutable("python") || findExecutable("python3");
    if (python) return { argv: [python] };
    return { error: "neither uv nor python was found on PATH" };
  }
  return { error: `nothing is configured to run ${ext} files — add fiat.interpreters["${ext}"]` };
}

/** 從專案目錄推出要跑的 argv：約定位置的 script ＋ 副檔名對應的直譯器。 */
export function deriveRoute(interpreters, project) {
  const relative = SCRIPT_CANDIDATES.find((candidate) => existsSync(join(project.dir, candidate)));
  if (!relative) {
    return { error: `${project.name} has no script yet (looked for scripts/intercept.mjs, .js, .cjs and .py).` };
  }
  const ext = extname(relative).toLowerCase();
  const interpreter = interpreterFor(interpreters, ext);
  if (interpreter.error) return { error: `cannot run ${relative}: ${interpreter.error}.` };
  // 設定裡給的直譯器也要真的存在。裝下去之後每一則訊息都會跑它，打錯一個字母的
  // 代價是整個房間開始回錯誤訊息。
  const missing = interpreter.argv.filter((arg) => /^([A-Za-z]:[\\/]|\/)/.test(arg) && !existsSync(arg));
  if (missing.length) return { error: `the interpreter for ${ext} does not exist: ${missing.join(", ")}` };
  return { command: [...interpreter.argv, join(project.dir, relative)] };
}

// ---------------------------------------------------------------------------
// 外部指令：送訊息、叫 ccrun／cdrun
// ---------------------------------------------------------------------------

/** 跑一支外部指令，永遠 resolve：`ok` 是它有沒有乾淨地結束，`missing` 是根本沒有這支程式。 */
export function run([command, ...args], extra = [], { timeout = 60_000, env } = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      [...args, ...extra],
      { encoding: "utf8", windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, env },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          missing: error?.code === "ENOENT",
          stdout: String(stdout ?? "").trim(),
          failure: error ? String(stderr || error.message || error).trim() : "",
        });
      },
    );
    // 它不讀 stdin；關掉，才不會有人在那裡等一個永遠不來的輸入。
    child.stdin?.on("error", () => {});
    child.stdin?.end();
  });
}

export const openclawOf = (openclaw) => (openclaw?.length ? openclaw : DEFAULT_OPENCLAW);

// ---------------------------------------------------------------------------
// /aside：給人看、誰都不處理的訊息
// ---------------------------------------------------------------------------
// 好幾個機器人在同一個房間裡互相看得到（Discord 的 allowBots）時，一台的回報會被另一台的 AI
// 拿來回應，一來一往就把額度燒光。所以 `/aside` 開頭的訊息，每一台的 hook 都記進 offstage log、
// 不交給 AI——人打的、AI 寫的都一樣。這個 plugin 自己送出去的訊息也是這樣處理，只是 `/aside`
// 換成一個看不見的記號：畫面上乾淨，其他機器人照樣不接話。

/** U+E0021 TAG EXCLAMATION MARK：寬度是零，Telegram 與 Discord 都原樣保留，顯示時看不出來。 */
export const ASIDE_MARK = "\u{E0021}";

/** 這個 plugin 送出去的訊息：開頭帶記號。 */
export const asAside = (text) => (String(text).startsWith(ASIDE_MARK) ? String(text) : `${ASIDE_MARK}${text}`);

/**
 * 這則訊息是不是 /aside：`/aside …`（可以帶 `@bot`），或開頭帶記號的（這個 plugin 送的）。
 * 是就回傳 `{ text, bot }`，`text` 是後面那段話，`bot` 是帶記號的那種；不是就回 null。
 */
export function asideOf(body) {
  const text = String(body ?? "").trimStart();
  if (text.startsWith(ASIDE_MARK)) return { text: text.slice(ASIDE_MARK.length).trim(), bot: true };
  const typed = /^\/aside(?:@\S+)?(?:\s+|$)/i.exec(text);
  return typed ? { text: text.slice(typed[0].length).trim(), bot: false } : null;
}

/** 對房間講一句話。走 `openclaw message send`，跟 script 想額外送訊息時同一條路。這個 plugin 講的一律是 /aside。 */
export const notify = (openclaw, room, text) =>
  run([...openclawOf(openclaw), "message", "send"], [
    "--channel",
    room.channel,
    "--target",
    room.target,
    "--message",
    asAside(text),
  ]);

/**
 * 把一句話打進那個 session。對方正在跑一輪的時候也可以打：它會排在這一輪後面。
 * `runner` 是 ccrun 或 cdrun 的 argv。
 */
export const inject = (runner, pid, text) => run(runner, ["-p", String(pid), text]);

/**
 * 關掉那個 session：請它結束，十秒內沒走（例如卡在確認對話框）就直接結束它。
 * 只能從 session **外面**叫：它會等 session 結束。
 */
export const quit = (runner, pid) => run(runner, ["-p", String(pid), "-q"]);

/**
 * 目錄已經從 from 改名成 to 之後，請 runner 把它的 AI 為那個目錄記的東西搬過去
 * （Claude Code 的交接 memory 與對話紀錄就是照目錄路徑存的）。搬什麼是 runner 的事。
 */
export const carry = (runner, from, to) => run(runner, ["-m", from, to]);

/** 那個 pid 還是不是一個開著的 session。runner 會順便確認它是自己叫起的那一種。 */
export async function sessionAlive(runner, pid) {
  if (!pid) return false;
  return (await run(runner, ["-p", String(pid), "-s"])).ok;
}

/** 在 dir 開一個 session，第一句話是 prompt。回傳 pid。 */
export async function launch(runner, dir, prompt, env) {
  // runner 會等 session 真的能接話才回來，冷啟動要十幾秒以上。
  const result = await run(runner, ["-d", dir, prompt], { timeout: 120_000, env });
  const pid = Number(/^\s*(\d+)\s*$/m.exec(result.stdout)?.[1]);
  if (result.ok && pid) return { pid };
  return { error: result.failure || result.stdout || `${runner[0]} did not print a pid` };
}
