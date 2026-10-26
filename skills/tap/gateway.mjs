// 本機 OpenClaw gateway 上，chat-interceptor 註冊的路由。report.mjs 與 tap.mjs 共用。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_GATEWAY_PORT = 18789;

export const gatewayUrl = (path) => `http://127.0.0.1:${gatewayPort()}${path}`;

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
