#!/usr/bin/env node
// script 要再送訊息時用的：stdin 給的 `send` 就是叫這支的 argv，後面接 `openclaw message send` 的選項。
// 房間已經指定好了；送出去的跟這個 plugin 自己的訊息一樣，其他機器人不接話。
//
//   node send.mjs <openclaw 的 argv（JSON）> <channel> <target> [openclaw message send 的選項…]

import { spawn } from "node:child_process";
import { ASIDE_MARK, asAside } from "./core.js";

const [openclaw, channel, target, ...options] = process.argv.slice(2);
const [command, ...prefix] = JSON.parse(openclaw);

const at = options.findIndex((option) => option === "--message" || option === "-m" || option.startsWith("--message="));
if (at === -1) options.push("--message", ASIDE_MARK); // 只有圖片或按鈕：訊息本文只放記號
else if (options[at].startsWith("--message=")) options[at] = `--message=${asAside(options[at].slice("--message=".length))}`;
else if (at + 1 < options.length) options[at + 1] = asAside(options[at + 1]);

const child = spawn(command, [...prefix, "message", "send", "--channel", channel, "--target", target, ...options], {
  stdio: "inherit",
  windowsHide: true,
});
child.on("error", (error) => {
  console.error(String(error?.message || error));
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 1));
