#!/usr/bin/env node
// 回報程式：/tap 每一段的最後呼叫它。
//
//   node report.mjs fiat  "<一段話>"   FIAT 文件寫好了
//   node report.mjs built "<一段話>"   實作完成
//   node report.mjs done  "<一段話>"   commit 了、交接 memory 也寫了
//
// 它只做一件事：把這一段 POST 給本機的 OpenClaw gateway（chat-interceptor 註冊的
// /chat-interceptor/report）。回報到房間、連續版注入 go、安裝、推 timestamp、關 session，
// 都在 gateway 那一側做。不是 /fiat 開的這一輪，gateway 會說沒有這一輪，什麼都不做。
//
// 不靠環境變數：Codex 的對話可能在 Codex app 裡接著跑（使用者從手機接手之後），那裡沒有
// /fiat 叫起時的環境。所以房間從專案的 .tap 認，gateway 的 port 從 OpenClaw 的設定找。
// 也不開子行程、不寫檔：Codex 的 sandbox 兩樣都不准，連回本機 gateway 倒是可以。

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const STAGES = ["fiat", "built", "done"];
const DEFAULT_GATEWAY_PORT = 18789;

const [stage, ...rest] = process.argv.slice(2);
if (!STAGES.includes(stage)) {
  console.error(`usage: node report.mjs <${STAGES.join("|")}> "<message>"   ("-" reads the message from stdin)`);
  process.exit(2);
}
let message = rest.join(" ").trim();
if (message === "-") message = readFileSync(0, "utf8").trim();

// 跟 tap.mjs 一樣，在專案根目錄找 .tap。
const tapPath = [".tap", join("genesis", ".tap")].find((path) => existsSync(path));
const room = {};
for (const line of tapPath ? readFileSync(tapPath, "utf8").split(/\r?\n/) : []) {
  const m = /^\s*(channel|target)\s*:\s*(.*?)\s*$/.exec(line);
  if (m && room[m[1]] === undefined) room[m[1]] = m[2];
}
if (!room.channel || !room.target) {
  console.log("No .tap here, so this is not a /fiat project. Nothing reported.");
  process.exit(0);
}

const url = `http://127.0.0.1:${gatewayPort()}/chat-interceptor/report`;
const body = JSON.stringify({ room, dir: process.cwd(), stage, message });

// gateway 重啟要一分鐘上下：連不上就等它回來。
const deadline = Date.now() + Number(process.env.FIAT_REPORT_WAIT_MS ?? 180_000);
for (;;) {
  let response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
  } catch (error) {
    if (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      continue;
    }
    console.error(`cannot reach the OpenClaw gateway at ${url}: ${error.cause?.message ?? error.message}`);
    process.exit(1);
  }
  const answer = await response.json().catch(() => ({}));
  if (response.status === 409) {
    console.log(answer.error);
    process.exit(0);
  }
  if (!response.ok) {
    console.error(answer.error || `the gateway answered ${response.status}`);
    process.exit(1);
  }
  console.log(answer.text);
  process.exit(0);
}

/** OpenClaw 自己找 gateway 的順序：環境變數、設定檔的 gateway.port、預設值。 */
function gatewayPort() {
  if (Number(process.env.OPENCLAW_GATEWAY_PORT)) return Number(process.env.OPENCLAW_GATEWAY_PORT);
  const config =
    process.env.OPENCLAW_CONFIG_PATH || join(process.env.OPENCLAW_STATE_DIR || join(homedir(), ".openclaw"), "openclaw.json");
  let text;
  try {
    text = readFileSync(config, "utf8");
  } catch {
    return DEFAULT_GATEWAY_PORT;
  }
  try {
    return Number(JSON.parse(text)?.gateway?.port) || DEFAULT_GATEWAY_PORT;
  } catch {
    // 手寫的 JSON5（註解、尾逗號）：退一步找 gateway 那一段的 port。
    const gateway = text.slice(Math.max(0, text.search(/["']?gateway["']?\s*:/)));
    return Number(/["']?port["']?\s*:\s*(\d+)/.exec(gateway)?.[1]) || DEFAULT_GATEWAY_PORT;
  }
}
