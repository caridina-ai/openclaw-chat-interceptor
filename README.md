# openclaw-chat-interceptor

一個 OpenClaw plugin：在 `before_dispatch` hook 攔下聊天訊息，先交給該對話
對應的 script 處理。script 處理得了就直接回覆，**整輪不呼叫模型，0 token**；
script 說「我不會」時，訊息原封不動交還給 AI 走原本的流程。

適合固定格式、高頻出現、不需要語意判斷的指令——那些交給模型只是浪費 token。

同一個 plugin 也管那些 script 是怎麼生出來的：在房間裡聊出一個點子，打一句
[`/fiat`](#fiat)，Claude Code 就會把整段對話汲取出來——**包含那些被攔掉、從來沒進過
session 的輸入**，以及使用者隨手打的 [`/aside`](#aside)——寫成需求文件、實作、
裝進房間讓你驗收。

- **要寫 script 的人看這份**：[docs/AUTHORING.md](docs/AUTHORING.md)
- 內部設計（hook 機制、plugin 實作）：[docs/DESIGN.md](docs/DESIGN.md)

裝一次，每個對話各自設一個 route。**plugin 只負責路由與呼叫，
本身不含任何領域邏輯**——那些屬於各自獨立的 script 專案。

## 安裝

```bash
git clone https://github.com/caridina-ai/openclaw-chat-interceptor
openclaw plugins install --link <path to this repo>
```

然後在 `~/.openclaw/openclaw.json` 設定。`allowConversationAccess` 要留著：它讓 gateway
啟動時就載入這個 plugin，hook 只在那時註冊。OpenClaw 要有 `before_dispatch` 這個 hook（2026.9.6 實測過）。

```json
{
  "plugins": {
    "entries": {
      "openclaw-chat-interceptor": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "routes": [
            {
              "name": "my-skill",
              "channel": "telegram",
              "target": "-1001234567890",
              "command": [
                "C:/Users/you/.local/bin/uv.exe",
                "run",
                "D:/projects/my-skill/my-script.py"
              ],
              "env": { "MY_SKILL_HOME": "D:/data/my-skill" },
              "timeoutMs": 30000
            },
            {
              "name": "another-skill",
              "channel": "discord",
              "target": "channel:123456789012345678",
              "command": [
                "C:/Program Files/nodejs/node.exe",
                "D:/projects/another-skill/index.mjs"
              ],
              "onError": "passthrough"
            }
          ]
        }
      }
    }
  }
}
```

> **改 `openclaw.json` 之後要 `openclaw gateway restart`。**
> plugin config **不會** hot reload——實測過：設定檔改好之後，下一則訊息還是走舊的
> route。這也是為什麼 [`/fiat -install`](#fiat) 不把 route 寫進設定檔。

> **前提**：Telegram 的 `groupPolicy` 預設是 `allowlist`。群組沒列在
> `channels.telegram.groups` 裡，訊息在 channel ingress 就被丟掉了，根本輪不到
> hook。新的房間要先加進去——而群組 id 正好可以從被丟掉時留下的那行 log 讀出來，
> 見 [DESIGN.md 2.5](docs/DESIGN.md)。

## 設定項

| 欄位 | 說明 |
|---|---|
| `debug` | 每一輪的判斷過程寫進 `logFile` |
| `logFile` | 預設 `~/.openclaw/logs/chat-interceptor.log` |
| `offstageLogFile` | AI 沒看到的每一句話寫到哪（見 [offstage log](#offstage)），預設 `~/.openclaw/logs/chat-interceptor-offstage.log` |
| `fiat` | 開啟 [`/fiat`](#fiat)。省略這一段，`/fiat` 只會回一句「還沒設定」 |
| `routes[]` | 依序比對，第一個對上的勝出；都沒對上就整輪交給 AI |

每個 route：

| 欄位 | 必要 | 說明 |
|---|---|---|
| `target` | ✓ | 對話 id，寫法同 `openclaw message send --target` |
| `project` | ✓＊ | `fiat.projectsDir` 底下的目錄名。要跑什麼**每次派工時才推**（見下） |
| `command` | ✓＊ | script 的 argv，約定不合用時的逃生口。給了就贏過 `project`。**用絕對路徑** |
| `name` | | trace 與錯誤訊息裡的標籤；用 `project` 的話不必給 |
| `channel` | | `telegram`、`discord`…；省略代表不限 channel |
| `cwd` | | script 的工作目錄 |
| `env` | | 額外環境變數，蓋在 gateway 自己的之上 |
| `timeoutMs` | | 預設 60000 |
| `onError` | | `handle`（預設，回錯誤訊息）或 `passthrough`（交給 AI）。只有無副作用的 script 才適合 passthrough |

＊ `project` 與 `command` 給一個就好。

### 一條 route 最少長這樣

```json
{ "project": "my-skill", "channel": "telegram", "target": "-1001234567890" }
```

沒有絕對路徑、沒有直譯器、沒有 argv。**那些每次派工時才推**：

| 找什麼 | 怎麼跑 |
|---|---|
| `<projectsDir>/my-skill/scripts/intercept.mjs`（或 `.js`、`.cjs`、`.py`；也認專案根目錄） | `.mjs`/`.js`/`.cjs` 用 **gateway 自己這支 node**（`process.execPath`）；`.py` 找 `uv` → `uv run`，沒有才退而找 `python` |

為什麼不寫進設定檔：**OpenClaw 沒有「給我 script、我來找直譯器」這種機制**——
它的執行介面是 argv，第一格就得是可執行檔。所以路徑只能有人負責，而寫進設定檔的話，
換個 node 版本、重裝一次 uv，它就悄悄失效了。每次派工才解析就沒有這個問題。

要指到 `projectsDir` 以外、或用完全不同的跑法，就寫 `command`——那條路一直都在。

`target` 的三種寫法等價，都對得上執行時的裸 id：

```
telegram   -1001234567890      ≡  group:-1001234567890
                               ≡  telegram:group:-1001234567890
discord    123456789012345678  ≡  channel:123456789012345678
                               ≡  discord:channel:123456789012345678
```

## Script 協定

| | |
|---|---|
| stdin | JSON `{ body, channel, target, senderId, sessionKey, agentId }` |
| stdout | 要回給使用者的純文字；空的代表「處理掉但不回話」 |
| exit `0` | 處理掉了，0 token |
| exit `20` | 我不會，請交給 AI |
| 其他 | 出錯，依 `onError` 決定 |

`body` 是原樣的使用者輸入，plugin 不做任何 normalize——各 script 自己決定怎麼解讀。

用 stdin 而不是 argv 傳訊息：Windows 的 argv quoting 很容易出事，而且使用者的
訊息是不受信任的輸入。任何語言寫的 script 都能接。

完整的作者指南、可直接抄的範本、以及改寫既有 skill 的步驟，
見 [docs/AUTHORING.md](docs/AUTHORING.md)。

## AI 沒看到的那些：offstage log

<a id="offstage"></a>

被 script 接走的那一輪**不進 session**——這是 0 token 的必然代價。事後要還原整段對話，
AI 看到的那些翻 session 檔就有，AI 沒看到的那些就得另外記。

所以 plugin 把**每一句 AI 沒看到的話**都記進 `offstageLogFile`，一行一筆
`<當地時間> <JSON>`：

| `kind` | 什麼時候 | 記下什麼 |
|---|---|---|
| `script` | script 接走了（exit 0） | 原文、script 回了什麼 |
| `error` | script 出錯，使用者看到錯誤訊息 | 原文、那則錯誤訊息 |
| `aside` | 使用者打了 [`/aside`](#aside) | 原文 |

放行給 AI 的那些不記——session 裡本來就有。這個檔**一直開著**，不看 `debug`：
`debug` 管的是 plugin 的除錯 trace，這個檔是對話紀錄，不該因為某人沒開除錯就少一塊。
[`/tap`](#tap) 讀的就是它。

## `/aside`

<a id="aside"></a>

留一句話在房間裡，**但誰都不要處理它**：

```
/aside 按鍵盤之後要等好幾秒才有反應
```

這是 plugin 註冊給 OpenClaw 的 slash command：**不呼叫 AI、不傳給 script、不回話**，
只記進 [offstage log](#offstage)。多行也可以。房間裡的每個人都能用，每個房間的行為都一樣。

名字取自戲劇的「旁白」——說出口、留在劇本裡，但台上其他角色聽不見。這裡也一樣：
它留在房間的紀錄裡（[`/tap`](#tap) 撈得回來），但 AI 與 script 都收不到。

光靠 AI 答應「看到這種訊息就靜默略過」是不算數的：那句話還是進了 session、
還是叫醒了模型、還是花了 token。真正做得到的只有在模型之前就吃掉，也就是這裡。
萬一寫不進去，那一則會回一句 `aside not recorded: …`，不會默默把使用者的話弄丟。

## `/fiat`

<a id="fiat"></a>

在房間裡聊著聊著，軟體就生出來了。`/fiat` 是 plugin 註冊給 OpenClaw 的 slash command，
它用 [ccrun](https://github.com/neritina-ai/cli-ccrun) 在專案目錄叫起一個 Claude Code——
開著 Remote Control，所以你可以從手機接上去跟它討論——再請它施展 [`/tap`](#tap) 技能。

一般的一輪：

1. `/fiat myproj` 開新專案，或 `/fiat` 維護這個房間的專案。
2. Claude Code 汲取房間的對話，寫出一份需求文件：新專案是 `genesis/FIATLUX.md`，
   維護舊專案是 `genesis/FIAT-{slug}.md`。寫好了回報到房間。
3. 你讀過（有問題就用 Remote Control 跟它談），在 Remote Control 打 `go`，或在房間打 `/fiat -go`，它開始實作。
4. 實作完它回報，**同時自動裝進這個房間**，你直接在房間裡驗收。
5. 驗收過了打 `/fiat -done`：它 commit、寫下交接 memory、回報，
   然後 `.tap` 的 `timestamp` 推到當下，Claude Code 關閉。

連續版是第一步多加一個 `-go`（`/fiat myproj -go` 或 `/fiat -go`）：
它寫完需求文件不停，直接做到第 4 步等你驗收。忘了加也沒關係，停在需求文件時補一句
`/fiat -go` 就會接著做——`-go` 永遠是「接下來一路自動做到裝好」。

| 打這個 | 會發生什麼 |
|---|---|
| `/fiat <projname>` | `projectsDir` 底下還沒有這個目錄：開新專案（寫好 `genesis/.tap`），綁定這個房間，叫起 Claude Code |
| `/fiat` | 叫起 Claude Code 維護這個房間綁定的專案 |
| `/fiat ?` | 只查不做：這個房間綁了哪個專案、裝了什麼、Claude Code 開著沒有、`timestamp`，以及 openclaw.json 裡手寫的 route。全形的 `？` 也行 |
| `… -t yyyy-mm-dd HH:MM` | 這一輪從那個時間開始汲取。房間常常先亂聊很久，聊到某個點子不錯才決定開專案 |
| `… -go` | 一路自動做到裝好。Claude Code 已經開著（例如停在需求文件），就是請它接著實作 |
| `/fiat -install [projname]` | 把專案的 skill 裝進 OpenClaw，在這個房間上線，當場生效 |
| `/fiat -uninstall` | 下線、把裝上去的 skill 拿掉，解除這個房間與專案的綁定 |
| `/fiat -done` | 驗收過了，請 Claude Code 收尾 |

**一個專案就是一個 OpenClaw skill**：`SKILL.md` 教 AI 處理 script 放行的那些輸入，
`scripts/intercept.*` 攔下確定性的那些（見 [AUTHORING.md](docs/AUTHORING.md) 第 6 節）。
skill 放在專案根目錄，或專案底下唯一一個有 `SKILL.md` 的資料夾（`<專案>/<skill>/`）。

**安裝**就是 `openclaw skills install <skill> --force --agent <這個房間的 agent>`：
skill 被**複製**進那個 agent 的 workspace，那一份就是上線版——AI 讀的是它的 `SKILL.md`，
route 跑的是它的 script。開發目錄之後怎麼改都不影響線上，直到再 `-install` 一次。
沒被攔下的輸入怎麼交到這個 skill 手上是 OpenClaw 的事，不必在房間的 systemPrompt 裡指定。

幾條規矩：

- **一個房間一個專案。** 房間已經綁了 A，`/fiat B` 是錯誤——要換就 `/fiat -uninstall`
  再 `/fiat -install B`。`/fiat A` 等於 `/fiat`。
- **一個房間一次一個 Claude Code。** 開著的時候再打 `/fiat` 會被擋下來。
- **起點一定要帶 `-t`**，不然 `/fiat 2026-09-28` 分不出是起點還是專案名。忘了帶的時候，
  回話會直接給出補好的那一句。
- `-t` 只影響這一輪，不會寫進 `.tap`。`.tap` 的 `timestamp` 只在 `-done` 那一刻往前推。
- `-install` 裝之前會先確認 skill 在、script 在、直譯器找得到。已經裝過也照裝——那就是把新版推上線。

### 回報程式

Claude Code 每一段結束（需求文件寫好、實作完成、commit 完）都會呼叫 plugin 附的
回報程式 `src/report.mjs`。它把 Claude Code 寫的那段話送回房間，並且做完那一段該做的
機械動作：

| 那一段 | 回報程式還做什麼 |
|---|---|
| 需求文件寫好 | 連續版的話，替它排好下一步「實作」 |
| 實作完成 | 把 skill 裝進 OpenClaw、在這個房間上線，等同 `/fiat -install` |
| commit 完 | 更新 `.tap` 的 `timestamp`，標記「可以關了」——gateway 接著從外面把 Claude Code 關掉 |

Claude Code 不知道這些，它只知道「每段結束要回報」——這些動作沒有一個需要判斷，
放在一支每段都必經的程式裡，就不會有哪一次忘了做。

### 上線不寫進 `openclaw.json`

那份設定不會 hot reload——寫進去要重啟 gateway 才算數，但使用者按完的下一秒就會去試，
於是會看到「裝好了」卻沒有反應。所以 route 只是在 `projectsFile` 那一筆記下「裝上去的
那一份在哪」，而那個檔**每一則訊息都會重讀**，當場生效；skill 那一側由 OpenClaw 的
skills watcher 在下一輪接手。順帶一個好處：**一則聊天訊息再也碰不到 gateway 的設定。**
`openclaw.json` 裡人手寫的 route 永遠優先。

### 設定

要開這個功能，設定裡加一段 `fiat`：

```json
"fiat": {
  "projectsDir": "D:/projects",
  "ccrun": ["C:/Users/you/go/bin/ccrun.exe"],
  "openclaw": [
    "C:/Program Files/nodejs/node.exe",
    "C:/Users/you/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs"
  ],
  "allowFrom": ["123456789"]
}
```

| 欄位 | 必要 | 說明 |
|---|---|---|
| `projectsDir` | ✓ | 一個專案一個子目錄 |
| `projectsFile` | | 房間 → 專案的對照表（綁哪個專案、裝了沒、開著的 Claude Code），預設 `~/.openclaw/chat-interceptor-projects.json`。帶著 chat id，所以放 state 目錄不放專案裡 |
| `ccrun` | | [ccrun](https://github.com/neritina-ai/cli-ccrun) 的 argv，預設 `["ccrun"]`。ccrun 自己要在 PATH 上找得到 `claude` |
| `openclaw` | | openclaw CLI 的 argv，預設 `["openclaw"]`。回報用 `message send`，安裝用 `skills install` |
| `interpreters` | | 副檔名 → 直譯器 argv，給約定之外的副檔名用 |
| `allowFrom` | | 允許下 `/fiat` 的 sender id，疊在 OpenClaw 自己的指令授權之上。省略＝OpenClaw 認可的人都可以 |

`ccrun` 與 `openclaw` 一律寫**絕對路徑**——gateway 是服務啟動的，PATH 跟 shell 不一樣。

叫起 Claude Code 時**只帶跟任務有關的東西**：工作目錄、Remote Control 的名字（就是專案名）、
回報程式的位置。模型、effort、權限模式一概不帶，照你自己的 Claude Code 全域設定。

> **`/fiat` 會在這台機器上叫起一個能改檔案的 agent。** 它是需要授權的指令，
> 不是自己完全掌握的房間，還要再設 `allowFrom`。

## `/tap`

<a id="tap"></a>

`/tap` 是 Claude Code 這一側的技能（[Agent Skill](https://github.com/vercel-labs/skills)），
`/fiat` 叫起 Claude Code 之後注入給它的就是這個：

```bash
npx skills add caridina-ai/openclaw-chat-interceptor --skill tap -a claude-code -g
```

| 叫法 | 那一段 |
|---|---|
| `/tap [yyyy-mm-dd HH:MM]` | 汲取房間的對話，寫需求文件。帶時間就從那個時間開始汲取 |
| `go` | 照需求文件實作。在 session 裡打，或在房間打 `/fiat -go` |
| `/tap -done` | 驗收過了：commit、寫交接 memory |

汲取的結果是一條完整的時間軸：session 裡 AI 看到的那些（OpenClaw 2026.9 起在 `openclaw-agent.sqlite`，
需要 Node 有 `node:sqlite`），加上 [offstage log](#offstage)
裡 AI 沒看到的那些（每一則標著下場：script 接走、script 出錯、`/aside`）。

每個專案用一個 `genesis/.tap` 記住自己在哪個房間出生，**只有三個欄位**：

```
channel:   telegram
target:    -1001234567890
timestamp: 2026-08-18 20:43:20
```

`timestamp` 是上一輪結束的時間，下一輪從這裡往後汲取；留空就是從頭。
`/fiat` 開新專案時會寫好它，`/fiat -done` 時推到當下。**`.tap` 絕不進版控**——
頻道位置是敏感資訊。

`/tap` 不必由 `/fiat` 叫起也能用：在專案目錄裡自己打 `/tap` 就是汲取加寫需求文件，
只是沒有人接它的回報。

## 測試

```bash
npm test
```

不需要 gateway、不需要網路、不需要 Claude Code，也不依賴任何外部 script——
測試自己把 fixture 寫進暫存目錄，ccrun 與 `openclaw message send` 也都是假的。

## 開發

Plain ESM JavaScript，沒有 build step。`--link` 安裝後 repo 就是線上版，改完
`src/` 跑 `openclaw plugins reload openclaw-chat-interceptor` 就生效。

AI model used: Claude Opus 5.5
