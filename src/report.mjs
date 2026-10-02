#!/usr/bin/env node
// 回報程式：Claude Code 在 /tap 每一段的最後呼叫它。
//
//   node report.mjs fiat  "<一段話>"   FIAT 文件寫好了
//   node report.mjs built "<一段話>"   實作完成
//   node report.mjs done  "<一段話>"   commit 了、交接 memory 也寫了
//
// Claude Code 只知道「每段結束要回報」。回報之外的事都在這裡，它不需要知道：
//
//   fiat   回報；有人要它一路做下去（`go` 記著）的話，替它注入 `go`
//   built  把專案的 skill 裝進 OpenClaw、在房間上線（等同 /fiat -install），再回報
//   done   更新 .tap 的 timestamp、回報，並標記「可以關了」
//
// 注入 `go` 是用 ccrun 往 session 自己的輸入框打字，跟主述者在 Remote Control 打的是同一個字。
// 它這時正在跑一輪（就是呼叫這支程式的這一輪），純文字會在這一輪中途就送進去，
// 它把手上這一段做完，自然會接著實作。所以打完就走，不必等。
//
// 關 session 則**不在這裡做**。從 session 裡面只能打 `/exit`，而 `/exit` 可能停在
// 「還有背景工作，確定要離開嗎」；能在十秒後強制結束的 `ccrun -q` 又會等 session 結束，
// 而 session 正在等這支程式。所以這裡只標記 `closing`，關是 gateway 從外面關。
//
// 每一段重複呼叫都不會出事：-go 用過就消掉、裝過的照裝、closing 標過就是標過。
//
// 房間、專案與設定，是 /fiat 叫起 session 時放進環境變數 FIAT_CONTEXT 的。

import { readFileSync } from "node:fs";
import {
  DEFAULT_PROJECTS_FILE,
  inject,
  installSkill,
  localStamp,
  notify,
  patchRoom,
  patchTap,
  readIndex,
  roomOf,
  tapFileOf,
} from "./core.js";

const STAGES = ["fiat", "built", "done"];

const [stage, ...rest] = process.argv.slice(2);
if (!STAGES.includes(stage)) {
  console.error(`usage: node report.mjs <${STAGES.join("|")}> "<message>"   ("-" reads the message from stdin)`);
  process.exit(2);
}
let message = rest.join(" ").trim();
if (message === "-") message = readFileSync(0, "utf8").trim();

let context;
try {
  context = JSON.parse(process.env.FIAT_CONTEXT ?? "");
} catch {
  context = null;
}
if (!context?.room) {
  console.log("This session was not started by /fiat, so there is no room to report to. Nothing done.");
  process.exit(0);
}

const projectsFile = context.projectsFile || DEFAULT_PROJECTS_FILE;
const room = roomOf(context.room);
const name = context.name;
const entry = readIndex(projectsFile)[context.room];
// session 開著的時候，房間有可能已經被 -uninstall 或換綁了。那就只回報，
// 不再替這個房間做任何決定。
const bound = entry?.name === name;
const done = [];

const lines = [];
if (stage === "fiat") {
  lines.push(`${name}: FIAT ready`, message);
  if (bound && entry.go && entry.pid) {
    lines.push("Implementing it now (-go).");
  } else {
    lines.push("Read it, then /fiat -go (or go in Claude Code) to implement.");
  }
} else if (stage === "built") {
  lines.push(`${name}: built`, message);
  if (bound) {
    const installed = await installSkill({ ...context, projectsFile, name, dir: context.dir, installedDir: entry.installedDir });
    if (installed.error) {
      lines.push(`not installed: ${installed.error}`);
      done.push(`not installed: ${installed.error}`);
    } else {
      patchRoom(projectsFile, context.room, {
        installed: true,
        skill: installed.skill,
        installedDir: installed.installedDir,
      });
      lines.push(`Installed ${installed.skill}: live in this room now. Test it here, then /fiat -done.`);
      done.push("installed");
    }
  }
} else {
  // 下一輪 /tap 從這裡開始汲取。這一步排在最前面：後面不管哪一步出事，它都已經做了。
  const stamp = localStamp();
  const tapFile = tapFileOf(context.dir);
  if (tapFile) {
    patchTap(tapFile, { timestamp: stamp });
    done.push(`timestamp ${stamp}`);
  }
  lines.push(`${name}: done`, message, tapFile ? `timestamp: ${stamp}. Closing Claude Code.` : "Closing Claude Code.");
}

const sent = await notify(context.openclaw, room, lines.filter(Boolean).join("\n"));
done.push(sent.ok ? "reported to the room" : `could not report to the room: ${sent.failure}`);

if (bound && entry.pid) {
  if (stage === "fiat" && entry.go) {
    patchRoom(projectsFile, context.room, { go: undefined });
    const queued = await inject(context.ccrun, entry.pid, "go");
    if (!queued.ok) done.push(`could not send go: ${queued.failure}`);
  }
  if (stage === "done") {
    // pid 留著：那是 gateway 關它的把手。
    patchRoom(projectsFile, context.room, { closing: true, go: undefined });
    done.push("this session will be closed shortly");
  }
}

console.log(`${done.join("; ")}.`);
