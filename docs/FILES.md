# 檔案與環境變數

`/fiat`、`/tap` 與攔截 hook 讀寫哪些檔案、放在哪裡，以及讀哪些環境變數。
`~` 是執行那支程式的帳號的家目錄；gateway 以服務執行時，就是服務的帳號。

## `/fiat` 的登錄

| 登錄 | 預設位置 | 換位置 | 記什麼 |
|---|---|---|---|
| 對照表 | `~/.openclaw/chat-interceptor-projects.json` | `fiat.projectsFile` | 一個房間一筆：綁的專案（`name`、`dir`）、房間的 `agent`、裝上去的那一份（`installed`、`skill`、`installedDir`）、上一次叫起的 AI（`harness`），以及開著的 session（`pid`、`go`、`closing`）。專案名與專案目錄只記在這裡 |
| `.tap` | 專案的 `genesis/.tap`（或根目錄的 `.tap`） | — | `channel`、`target`、`timestamp`：專案在哪個房間出生、下一輪從哪裡汲取。不進版控 |
| 上線的 skill | 房間 agent 的 workspace 的 `skills/<skill 名>/` | OpenClaw 的 agent 設定 | `-install` 與回報 `built` 時用 `openclaw skills install` 複製過去的那一份，route 跑的是它。skill 名取自它的 SKILL.md |
| 安裝來源 | 上一列那一份裡的 `.openclaw/source-origin.json` | — | OpenClaw 記下的來源路徑，每次裝都會更新 |
| 手寫的 route | `openclaw.json` 的 `plugins.entries.openclaw-chat-interceptor.config.routes` | — | 人手寫的，plugin 只讀不寫 |

專案目錄是 `fiat.projectsDir` 底下的一個子目錄。

### 寫程式的 AI 照專案目錄記的

這些不是 plugin 寫的，但跟著專案目錄走：`/fiat -rename` 會請 runner（`-m`）搬過去。

| 誰 | 位置 | 記什麼 |
|---|---|---|
| Claude Code | `~/.claude/projects/<目錄路徑換成英數與 - 的名字>/` | 交接 memory（`memory/`）與對話紀錄 |
| Codex | `~/.codex/config.toml` 的 `[projects.'<目錄>']` | 那個目錄的設定，例如信任 |

Claude Code 的 `~/.claude.json` 也有一段照目錄記的設定（信任、這個專案的 MCP server），
那一段不搬：ccrun 開新目錄時會自己回答信任的問題。

## 其他檔案

| 檔案 | 預設位置 | 換位置 | 用途 |
|---|---|---|---|
| offstage log | `~/.openclaw/logs/chat-interceptor-offstage.log` | `offstageLogFile` | AI 沒看到的那些：script 接走的、script 出錯的、`/aside`。一直開著 |
| 除錯 log | `~/.openclaw/logs/chat-interceptor.log` | `logFile` | `debug: true` 時，每一輪的判斷 |

`/tap` 汲取時讀的，都在 OpenClaw 的 state 目錄（預設 `~/.openclaw`）底下：

- `agents/<agent>/agent/openclaw-agent.sqlite`：OpenClaw 2026.9 起的 session。
- `agents/<agent>/sessions/` 的 `*.trajectory.jsonl`、`*.jsonl`，與 `agents/<agent>/agent/codex-home/sessions/**/rollout-*.jsonl`：更早的 session。
- `logs/chat-interceptor-offstage.log`：同上表（`tap.mjs --offstage` 可以指定別的檔案）。
- `openclaw.json` 的 `gateway.port`：找本機 gateway。

## 環境變數

| 變數 | 誰讀 | 作用 |
|---|---|---|
| `PATH` | plugin | 找 `.py` script 的 `uv`、`python`（另外也看 `~/.local/bin`），以及沒寫絕對路徑的 `ccrun`、`cdrun`、`openclaw` |
| `FIAT_CLOSE_GRACE_MS` | plugin | 回報 `done`、`empty` 之後，等多久才關 session，預設 20000 |
| `OPENCLAW_STATE_DIR` | `/tap`（tap.mjs、report.mjs） | OpenClaw 的 state 目錄，預設 `~/.openclaw`。**plugin 不讀它**：plugin 的預設位置固定在 `~/.openclaw`，要換請用上面各表的設定 |
| `OPENCLAW_CONFIG_PATH` | `/tap` | `openclaw.json` 在哪，預設是 state 目錄底下那一份 |
| `OPENCLAW_GATEWAY_PORT` | `/tap` | gateway 的 port，優先於 `openclaw.json` 的 `gateway.port`，都沒有就是 18789 |
| `FIAT_REPORT_WAIT_MS` | report.mjs | gateway 連不上時（例如正在重啟）等多久，預設 180000 |
| `CLAUDE_CONFIG_DIR` | ccrun | Claude Code 的設定目錄，預設 `~/.claude`；`-m` 搬的是它底下的 `projects/` |
| `CODEX_HOME` | cdrun | Codex 的家目錄，預設 `~/.codex`；`-m` 改的是它底下的 `config.toml` |
