# openclaw-chat-interceptor

一個 OpenClaw plugin，做三件事：

- **攔截**：聊天訊息在交給 AI 之前，先給這個房間的 script 看。script 處理得了就直接回覆，
  **整輪不呼叫模型，0 token**；script 說「我不會」，訊息原封不動交給 AI。
- **`/aside`**：在房間裡留一句話，AI 與 script 都看不到，只記下來。
- **`/fiat`**：在房間裡叫起 Claude Code 或 Codex，把房間裡聊出來的點子做成 script，
  裝進房間讓你驗收。

適合固定格式、高頻出現、不需要語意判斷的指令——那些交給模型只是浪費 token。

## 安裝

需要 OpenClaw 2026.9.6 以上（要有 `before_dispatch` hook）。

```bash
openclaw plugins install git:github.com/caridina-ai/openclaw-chat-interceptor
```

### 要用 `/fiat` 才需要

`/fiat` 叫起寫程式的 AI。**用哪一個就裝哪一個**，兩個都要也可以。兩個都只支援 Windows，
都要先裝好 [Go](https://go.dev/dl/)。

**Claude Code**（要有登入好的 Claude Code）：

```bash
go install github.com/neritina-ai/cli-ccrun/cmd/ccrun@latest
npx skills add caridina-ai/openclaw-chat-interceptor --skill tap -a claude-code -g
```

**Codex**（要有登入好的 Codex CLI 或 Codex 桌面版）：

```bash
go install github.com/caridina-ai/cli-cdrun/cmd/cdrun@latest
npx skills add caridina-ai/openclaw-chat-interceptor --skill tap -a codex -g
```

第一行是叫起它的程式，第二行是它要用的 `/tap` 技能。

兩個都照你自己的設定跑（模型、權限），`/fiat` 不另外指定。Codex 要一路做完不停下來問（包括 commit），
`~/.codex/config.toml` 要有 `approval_policy = "never"` 與 `sandbox_mode = "danger-full-access"`。

### 設定

把設定寫成一個檔案，例如 `interceptor.json5`：

```json5
{
  plugins: {
    entries: {
      "openclaw-chat-interceptor": {
        enabled: true,
        hooks: { allowConversationAccess: true },
        config: {
          fiat: {
            projectsDir: "D:/projects",
            harness: "codex", // /fiat 預設叫哪一個：claude 或 codex，省略就是 claude
            cdrun: ["C:/Users/you/go/bin/cdrun.exe"],
            ccrun: ["C:/Users/you/go/bin/ccrun.exe"],
            openclaw: [
              "C:/Program Files/nodejs/node.exe",
              "C:/Users/you/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs",
            ],
            allowFrom: ["123456789"],
          },
        },
      },
    },
  },
}
```

```bash
openclaw config patch --file interceptor.json5 --dry-run   # 先檢查
openclaw config patch --file interceptor.json5
openclaw gateway restart
```

沒用到的那一個（例如只用 Codex 時的 `ccrun`）不必寫。`allowConversationAccess` 一定要留著，
plugin 才會在 gateway 啟動時載入。**改過設定都要 `openclaw gateway restart`。**

### 更新

```bash
openclaw plugins update openclaw-chat-interceptor
openclaw gateway restart
```

## 攔截：給房間一支 script

script 是一支讀 stdin、印 stdout、用 exit code 表態的程式：

| | |
|---|---|
| stdin | JSON `{ body, channel, target, senderId, sessionKey, agentId }`，`body` 是使用者原樣的輸入 |
| stdout | 回給使用者的純文字；空的就是「處理掉但不回話」 |
| exit `0` | 處理掉了，不呼叫模型 |
| exit `20` | 我不會，交給 AI |
| 其他 | 出錯，把錯誤回給使用者 |

`/` 開頭的訊息（斜線指令）不會送進 script。怎麼寫 script，見 [docs/AUTHORING.md](docs/AUTHORING.md)。

script 有兩種方式接上房間：

- **用 `/fiat` 做出來的**：`/fiat -install` 就裝好了，什麼設定都不用寫（見下）。
- **自己寫的**：在設定裡加一條 route。`routes` 是陣列，`config patch` 會**整個換掉**它，
  所以要列出全部的 route：

```json5
{
  plugins: {
    entries: {
      "openclaw-chat-interceptor": {
        config: {
          routes: [
            {
              channel: "telegram",
              target: "-1001234567890",
              command: ["C:/Program Files/nodejs/node.exe", "D:/projects/my-skill/scripts/intercept.mjs"],
            },
          ],
        },
      },
    },
  },
}
```

| route 欄位 | 說明 |
|---|---|
| `target` | 房間 id，寫法同 `openclaw message send --target`。Discord 寫 `channel:123456789012345678` 或裸 id 都可以 |
| `channel` | `telegram`、`discord`…；省略就不限 |
| `command` | script 的 argv，**一律用絕對路徑**（gateway 的 PATH 跟你的 shell 不一樣） |
| `project` | 不寫 `command` 時可以寫這個：`fiat.projectsDir` 底下的目錄名，script 與直譯器自動找 |
| `name` | log 與錯誤訊息裡的名字 |
| `cwd`、`env` | script 的工作目錄、額外的環境變數 |
| `timeoutMs` | 預設 60000 |
| `onError` | `handle`（預設，回錯誤訊息）或 `passthrough`（交給 AI）。有副作用的 script 不要用 passthrough |

多條 route 依序比對，第一個對上的勝出；手寫的 route 比 `/fiat -install` 裝的優先。

> Telegram 群組要先列在 `channels.telegram.groups` 裡，否則訊息在進 plugin 之前就被丟掉了。

## `/aside`

```
/aside 按鍵盤之後要等好幾秒才有反應
```

不呼叫 AI、不送進 script、不回話，只記下來。房間裡誰都能用。之後 `/fiat` 汲取對話時，
這些話會被特別列出來——適合隨手記下「這裡用起來不順」。

## `/fiat`

在房間裡聊出點子，打一句 `/fiat`，寫程式的 AI 就會在專案目錄裡把整段對話汲取出來——
**包含被 script 攔掉、AI 沒看到的那些**，以及 `/aside`——寫成需求文件、實作、裝進房間讓你驗收。

一輪的流程：

1. `/fiat myproj` 開新專案，或 `/fiat` 維護這個房間的專案。
2. AI 寫出需求文件（新專案是 `genesis/FIATLUX.md`，之後每一輪是 `genesis/FIAT-*.md`），回報到房間。
3. 你讀過、沒問題就打 `/fiat -go`，它開始實作。
4. 實作完它回報，**同時自動裝進這個房間**，你直接在房間裡驗收。
5. 驗收過了打 `/fiat -done`：它 commit、回報，然後關閉。

一開始就加 `-go`（`/fiat myproj -go`），它寫完需求文件不停，直接做到第 4 步。
忘了加的話，停在需求文件時補一句 `/fiat -go` 就會接著做。

| 指令 | 作用 |
|---|---|
| `/fiat <projname>` | 開新專案並綁定這個房間 |
| `/fiat` | 開始這個房間的專案的下一輪 |
| `… -t yyyy-mm-dd HH:MM` | 從那個時間開始汲取對話（房間常常先亂聊很久） |
| `… -go` | 一路做到裝好；已經開著就是請它接著實作 |
| `… -claude`／`-codex` | 這一輪用哪一個 AI，不加就用設定的 `harness` |
| `/fiat ?` | 只查不做：綁了哪個專案、裝了什麼、AI 開著沒有 |
| `/fiat -install [projname]` | 把專案裝進這個房間，馬上生效 |
| `/fiat -uninstall` | 從這個房間拿掉，房間就可以綁別的專案 |
| `/fiat -done` | 驗收過了，請它收尾 |

- **一個房間一個專案。** 要換就 `/fiat -uninstall` 再 `/fiat -install <別的專案>`。
- **一個房間一次一個 AI。** 開著的時候再打 `/fiat` 會被擋下來。
- **一個專案就是一個 OpenClaw skill**：`SKILL.md` 教 AI 處理 script 放行的輸入，
  `scripts/intercept.*` 攔下確定性的那些。安裝是複製一份進這個房間的 agent，
  之後開發目錄怎麼改都不影響線上，直到再 `-install` 一次。
- 每個專案的 `genesis/.tap` 記著它在哪個房間出生、上一輪做到哪個時間。**它不進版控**——
  房間 id 是敏感資訊。
- 它停下來的時候，可以從手機接上去跟它討論需求文件，也可以在那裡打 `go`：
  Claude Code 開著 Remote Control；Codex 的對話在 Codex app 裡（以專案名命名）。
  Codex 正在做事的時候手機只能看、不能打字，等它停下來再說。
- `/fiat` 會在這台機器上叫起一個能改檔案的 AI。房間裡不是只有你的話，一定要設 `allowFrom`。

## 設定項

| 欄位 | 說明 |
|---|---|
| `routes[]` | 手寫的 route（見上） |
| `fiat.projectsDir` | 專案放哪裡，一個專案一個子目錄。要用 `/fiat` 就必填 |
| `fiat.harness` | `/fiat` 預設叫哪一個：`claude`（預設）或 `codex` |
| `fiat.ccrun`、`fiat.cdrun` | ccrun、cdrun 的絕對路徑（argv）。用到的那一個才要寫 |
| `fiat.openclaw` | openclaw CLI 的 argv。Windows 上要寫成 node 加 `openclaw.mjs` 的絕對路徑 |
| `fiat.allowFrom` | 允許下 `/fiat` 的 sender id；省略就是 OpenClaw 認可的人都可以 |
| `fiat.projectsFile` | 房間與專案的對照表，預設 `~/.openclaw/chat-interceptor-projects.json` |
| `fiat.interpreters` | 副檔名 → 直譯器 argv，給 `.mjs`/`.js`/`.cjs`/`.py` 以外的 script 用 |
| `offstageLogFile` | AI 沒看到的話記在哪，預設 `~/.openclaw/logs/chat-interceptor-offstage.log` |
| `debug`、`logFile` | 每一輪的判斷過程寫進 `logFile`（預設 `~/.openclaw/logs/chat-interceptor.log`） |

## 開發

```bash
npm test
```

不需要 gateway、網路、Claude Code 或 Codex。內部設計見 [docs/DESIGN.md](docs/DESIGN.md)。

AI model used: Claude Opus 5.5
