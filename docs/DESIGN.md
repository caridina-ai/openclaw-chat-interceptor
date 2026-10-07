# openclaw-chat-interceptor 技術設計

這份文件說明 `before_dispatch` 這條路徑怎麼運作、plugin 這一側怎麼實作，
以及職責邊界劃在哪裡。**要寫 script 的人請看 [AUTHORING.md](AUTHORING.md)**，
這份是內部設計。

所有關於 OpenClaw 行為的敘述都對照過發行原始碼（`<npm global root>/openclaw/dist`）：
第 1 節是 `2026.9.6`，其餘是 `2026.7.1-2`。

---

## 1. `before_dispatch` 是什麼

OpenClaw 有兩套 hook，名字很像但完全不同：

| | internal hooks | **typed plugin hooks** |
|---|---|---|
| 形式 | `~/.openclaw/hooks/<name>/HOOK.md` + `handler.ts` | plugin 裡 `api.on(name, handler)` |
| 事件 | `command:new`、`message:received`、`gateway:startup`… | `before_tool_call`、**`before_dispatch`**、`message_sending`… |
| 能力 | 觀察 + 副作用 | 可以 **block / cancel / 短路** |
| 文件 | `docs/automation/hooks.md` | `docs/plugins/hooks.md` |

`before_dispatch` 只存在於第二套。**所以 openclaw-chat-interceptor 必須是 plugin，
不能是 skill，也不能是 `~/.openclaw/hooks/` 底下的 internal hook。**

### 它在哪裡被呼叫

`dist/dispatch-from-config-*.mjs`，`dispatchReplyFromConfig()` 之中。時序是：

```
telegram 收到訊息
  ↓
prepareDispatchOperation   ← 只處理 /stop、/approve 這種要插隊的
  ↓
chooseDispatchRoute:
  if (hookRunner.hasHooks("before_dispatch"))
      result = runBeforeDispatch({ body, channel, sessionKey, senderId, … }, ctx)
      if (result?.handled)
          有 text 就送出；記成 completed，return   ← 從這裡直接跳出
  ↓
executeDispatch → getReply()   ← 處理斜線指令、把這句話寫進 session、
                                  before_agent_reply、組 prompt、送模型、跑 tool
```

`handled: true` 是**整則訊息的短路**，不是「先回一句再繼續」：

- 不處理指令、不寫進 session transcript、不呼叫模型 → **0 token**，這一輪對後續對話是隱形的
- `text` 直接送回原本的對話，使用者看到的跟 AI 回的沒有差別
- 不帶 `text` 就是靜默，不會被補「沒有產生回覆」的警告

**斜線指令也會先經過這裡**，因為指令是在 `getReply()` 裡才處理的。所以 plugin 看到
`/` 開頭的訊息一律放行、不送 script——否則回覆所有訊息的 script 會把 `/new`、
`/status` 吃掉。`/aside`、`/fiat` 在 telegram 是原生指令，走另一條路，碰不到這個 hook。

### 為什麼不是 `before_agent_reply`

2026.9 以前用的是它：在 `getReply()` 裡、模型之前，handled 一樣短路，而且指令已經處理完了。
2026.9 起它有兩個問題：

1. **使用者那句話在它之前就寫進 session 了**（`admitUserTurn`）。script 接走的話 AI
   下一輪照樣看得到——實際上鍵盤按鍵的 `callback_data: …` 就這樣一則則進了 AI 的 session。
2. **群組訊息預設一定要回話**（`agents.defaults.silentReply.group` 預設 `disallow`）。
   handled 但不帶 reply 時 OpenClaw 補的 `NO_REPLY` 不算數，使用者會收到
   「I finished the turn, but it did not produce a visible reply.」

第 2 點設定改得掉，第 1 點改不掉，所以換 hook。

### 介面

```ts
// 收到（只列本專案用到的）
type Event = { body?: string; content?: string; channel?: string; sessionKey?: string; senderId?: string };

// 回傳（回 undefined = 什麼都沒發生，照原流程）
type Result = { handled: boolean; text?: string };
```

第二個參數 `ctx` 本專案會用到的欄位：

| 欄位 | telegram 群組 |
|---|---|
| `event.channel` / `ctx.channelId` | `"telegram"` |
| `ctx.conversationId` | `"-1001234567890"` |
| `ctx.sessionKey` | `agent:<agentId>:telegram:group:-1001234567890` |
| `ctx.senderId` | 發話者 |
| `ctx.pluginConfig` | 本 plugin 在 openclaw.json 裡的 `config` 區塊（沒給就用 `api.pluginConfig`） |

沒有 `agentId`：這個房間綁的 agent 從 sessionKey 的 `agent:<agentId>:` 取。

### 對話 id 的三種寫法（跨 channel 的坑）

session key 的格式是 `[agent:<agentId>:]<channel>:<group|channel>:<rawId>`
（`parseRawSessionConversationRef`，`dist/session-key-utils-*.js`），
`ctx.conversationId` 就是其中的 `rawId`——**已經剝掉 prefix 的裸 id**。

但使用者在 CLI 看到的不是這個：

```
openclaw message send --channel telegram --target -1001234567890
openclaw message send --channel discord  --target channel:123456789012345678
```

telegram 的 target 是裸 id，discord 的卻帶 `channel:` prefix。如果設定欄位直接拿去
跟 `ctx.conversationId` 做字串比對，telegram 會過、**discord 會永遠對不上**。

所以本專案的 `target` 欄位兩邊都先正規化再比：剝掉 OpenClaw 自己那組
conversation prefix（`channel` `chat` `direct` `dm` `group` `thread` `user`）
以及等同 provider 名稱的前綴，重複剝到剝不動為止。結果是這三種寫法等價：

```
123456789012345678  ≡  channel:123456789012345678  ≡  discord:channel:123456789012345678
```

剝到認不得的 prefix 就停手，所以 matrix 的 `!abc:matrix.org` 不會被誤傷。
`ctx.conversationId` 萬一缺席，還會退一步自己去解 `ctx.sessionKey`。

### 兩個一定會踩到的限制

1. **`hooks.allowConversationAccess` 留著。** `before_dispatch` 不是 conversation hook，
   不靠它也註冊得上（`before_agent_reply` 是，當年沒它就被擋）。但它也是 OpenClaw 認的
   「啟動時就載入」訊號，見下一條。被擋或沒載入時 plugin 照樣「載入成功」，
   要用 `openclaw plugins inspect <id> --runtime --json` 看 `typedHooks` 與 `diagnostics` 才知道。

2. **`activation.onStartup` 必須是 `true`。** hook 是在 plugin `register()` 時註冊的；
   plugin 沒在 gateway 啟動時載入，`hasHooks("before_dispatch")` 就是 false，
   hook 永遠不會跑。

---

## 2. plugin 這一側

### 2.1 專案結構

```
openclaw-chat-interceptor/
├── package.json                # openclaw.extensions 指向 src/index.js
├── openclaw.plugin.json        # plugin manifest：id / activation / configSchema
├── src/
│   ├── index.js                # hook 與兩個 slash command（plain ESM，沒有 build step）
│   └── core.js                 # 機械部分：房間、對照表、.tap、script、ccrun／cdrun
├── test/*.test.js              # node --test，不需要 gateway、Claude Code 或 Codex
├── skills/tap/                 # /tap：給 Claude Code 或 Codex 裝的技能（見 2.8）
│   ├── SKILL.md
│   ├── tap.mjs                 # 汲取對話
│   └── report.mjs              # 回報程式：每一段結束時呼叫（見 2.9）
├── genesis/                    # 本專案的委託書：FIATLUX.md 與後續的 FIAT-*.md
└── docs/
    ├── AUTHORING.md            # 給 script 作者
    └── DESIGN.md               # 本檔
```

**這個 repo 不含任何 script。** plugin 是通用的路由器，領域邏輯一律屬於各自的
script 專案（見 AUTHORING.md）。測試用的是寫進暫存目錄的 fixture，
所以跑測試不需要任何外部 script、DB 或 gateway。

用 **plain JavaScript 而不是 TypeScript**：從 GitHub 裝下來就能跑，中間沒有編譯。

`package.json` 刻意**不寫** `openclaw.compat`：本機版本是 `2026.7.1-2`，在 semver
眼中是 `2026.7.1` 的 prerelease，寫 `minGatewayVersion: "2026.7.1"` 反而會判定不相容。

### 2.2 攔截邏輯

plugin 本身**不含任何領域邏輯**，只做路由：

```
selectRoute(ctx, config)        設定裡的 route 優先，其次是對照表裡裝上的專案
  ↓ 沒有 route → return undefined（整輪給 AI）
spawn route.command，stdin 餵 JSON payload
  ↓
exit 0  → { handled: true, text: stdout }   （stdout 空 → 不帶 text，靜默）  → 記進 offstage log
exit 20 → return undefined（給 AI）
其他    → 依 route.onError 決定 handled（記進 offstage log）或 passthrough
```

`/aside` 與 `/fiat` 不在這條路上：它們是 OpenClaw 的 slash command（見 2.7、2.9），
在 agent 之前就被 OpenClaw 的指令流程接走了，根本不會走到這個 hook。

六個刻意的設計決定：

- **route 可以只寫 `project`，要跑什麼每次派工時才推。** OpenClaw 沒有「給我一支
  script、我來找直譯器」這種機制——plugin SDK 的執行介面是
  `runPluginCommandWithTimeout({ argv, … })`，argv 第一格就得是可執行檔。所以那個
  責任只能有人扛，而扛進設定檔的代價是：`C:/Program Files/nodejs/node.exe` 這種東西
  散在每一條 route 裡，換個 node 版本、重裝一次 uv 就悄悄失效。改成每次派工才解析：
  `.mjs`/`.js`/`.cjs` 用 gateway 自己這支 node（`process.execPath`，不可能錯），
  `.py` 當場找 `uv`（沒有才退而找 `python`）。設定檔裡不再有任何這台機器專屬的東西。
  約定不合用時 `command` 仍在，那是逃生口。

- **`target` 或 `command` 沒設好的 route 直接略過。** 寧可多花 token，也不要亂攔。
- **script 失敗預設算 `handled`。** 若失敗時 `return undefined`，同一句話會再送給 AI，
  AI 可能把已經做過的事再做一次。只有無副作用的 script 才適合 `onError: "passthrough"`。
- **同一個 route 一次只跑一支 script。** script 常會寫檔或寫 DB，
  兩則訊息同時進來會互相蓋掉。
- **`debug: true` 時每一輪都寫 trace 到 `~/.openclaw/logs/chat-interceptor.log`**，
  包含沒攔到的那些。這是 plugin 的除錯窗口——gateway 主 log 是 JSON 巨獸，很難看。
- **AI 沒看到的每一句話都記進 offstage log，一直開著。** script 接走的、script 出錯而
  回了錯誤訊息的，都不進 session；不記下來，事後就沒有人知道使用者講過。放行給 AI 的
  不記，session 裡本來就有。它跟 `debug` 無關：那是除錯，這是對話紀錄。

### 2.3 script 協定

> 要**寫** script 的人請直接看 [AUTHORING.md](AUTHORING.md)，那份是完整的作者指南。
> 這裡只記 plugin 這一側的合約。

| | |
|---|---|
| 位置 | `<projectsDir>/<project>/scripts/intercept.{mjs,js,cjs,py}`（用 `project` route 時） |
| stdin | JSON `{ body, channel, target, senderId, sessionKey, agentId }` |
| stdout | 要回給使用者的純文字；空的代表「處理掉但不回話」 |
| exit `0` | 處理掉了 |
| exit `20` | 我不會，請交給 AI |
| 其他 | 出錯 |

`body` 是**原樣**的使用者輸入，plugin 不做 normalize。要不要把全形數字轉半形、
要不要收斂空白，都是領域決定——有的 script 需要，有的必須保留原樣——所以交給
script 自己處理。

用 stdin 而不是 argv：Windows 的 argv quoting 很容易出事，而且使用者的訊息是
不受信任的輸入。stdin 也讓任何語言寫的 script 都能接。

### 2.4 安裝與設定

```bash
openclaw plugins install git:github.com/caridina-ai/openclaw-chat-interceptor
```

裝進去的是一份複製，更新用 `openclaw plugins update openclaw-chat-interceptor` 再重啟 gateway。

設定寫在 `~/.openclaw/openclaw.json` 的這一段（README 用 `openclaw config patch` 寫進去）：

```json
"openclaw-chat-interceptor": {
  "enabled": true,
  "hooks": { "allowConversationAccess": true },
  "config": {
    "debug": true,
    "routes": [
      {
        "name": "my-skill",
        "channel": "telegram",
        "target": "-1001234567890",
        "command": ["C:/Users/you/.local/bin/uv.exe", "run", "D:/projects/my-skill/my-script.py"],
        "env": { "MY_SKILL_HOME": "D:/data/my-skill" }
      }
    ]
  }
}
```

`command` 一律寫**絕對路徑**：gateway 是 Windows 排程工作啟動的，PATH 跟 shell 不一樣。

### 2.5 新房間的前提：channel allowlist

`channels.telegram.groupPolicy` 預設是 `allowlist`。群組沒列在
`channels.telegram.groups` 裡，訊息在 **channel ingress 就被丟掉**了，
`before_dispatch` 根本不會跑。這一步很容易漏掉，症狀是
「hook 完全沒反應但 plugin 一切正常」。

所以要在新房間架服務，一定要先把該群組加進 `channels.telegram.groups`
（discord 是 `channels.discord.guilds`，目前設 `"*"` 所以不受限）。

**而群組 id 就從被丟掉時留下的 log 讀。** `telegram-ingress-spool` 擋掉時會寫：

```js
logger.info({ chatId, title: chatTitle, reason: "not-allowed" }, "skipping group message");
```

所以流程是：先把 bot 加進群組 → 隨便傳一則 → 從 log 撈 id：

```powershell
Select-String -Path "$env:LOCALAPPDATA\Temp\openclaw\openclaw-*.log" `
  -Pattern 'skipping group message' -Encoding utf8 |
  ForEach-Object { $j = $_.Line | ConvertFrom-Json
    "chatId={0}  title={1}" -f $j."1".chatId, $j."1".title }
```

```
chatId=-1009876543210  title=My Test Group
```

不必自己去 Telegram 查 id。注意這行是 `logger.info`；同一段裡其他幾個分支
（`groupPolicy: disabled`、沒有 senderId 等）走的是 `logVerbose`，那些就不會出現。

**bot 沒被加進群組的話連這行都不會有**——Telegram 根本不會把 update 送出來。
「一行 log 都沒有」和「有 skipping group message」是兩種不同的狀況，別搞混。

### 2.6 怎麼確認裝好了

```bash
openclaw plugins inspect openclaw-chat-interceptor --runtime --json
```

要看到：

```json
"typedHooks": [{ "name": "before_dispatch", "priority": 100 }],
"diagnostics": []
```

`typedHooks` 是空的就是沒接上；`diagnostics` 會直接寫出原因。

### 2.7 `/aside`

`/aside ＿＿` 是 plugin 用 `api.registerCommand()` 註冊的 OpenClaw slash command：
不呼叫模型、不跑 script、不回話（`{ suppressReply: true }`），只往 offstage log
append 一行 `<當地時間> {"kind":"aside", …}`。

幾個刻意的決定：

- **名字取自戲劇的旁白。** 說出口、留在劇本裡，但台上其他角色聽不見——這不是比喻，
  這就是定義。它曾經叫 `ISSUE`，但那個名字宣稱了「這是軟體的問題」，
  而使用者留的話多半不是；他只是不想讓那句話被任何人處理。

- **是 slash command，不是 hook 裡的字串比對。** 它本來就一定不會叫 AI，沒有理由走
  「先攔、再判斷」那條路。掛成指令之後 OpenClaw 自己處理 `/aside@botname`、
  Telegram 的指令選單也看得到它。

- **每個房間的行為都一樣，而且誰都能用**（`requireAuth: false`）。有沒有 route、
  有沒有專案，都不影響。使用者要的是「我在這裡留一句，誰都不要理」；這件事如果在
  某些房間會突然叫醒 AI，他每次開口前都得先想「這間算不算」，那就不是一個他敢用的東西了。

- **跟被攔下的訊息記在同一個檔。** 兩者是同一回事：AI 沒看到的話。分兩個檔，
  還原對話的人就得合兩次。

- **寫失敗要回話。** 使用者要的是「記一下、不要有反應」，但「沒記到卻也沒反應」
  就是把他的話默默弄丟了，所以那一則回 `aside not recorded: …`。

### 2.8 `/tap`：被攔掉的輸入怎麼還原

`handled: true` 的那一輪不進 session transcript——這是 0 token 的必然代價，
也是回頭檢討時最大的障礙：**最需要看的「script 還接不住哪些話」、「使用者抱怨了什麼」
正好是看不到的那些。**

`skills/tap/` 是一個 [Agent Skill](https://github.com/vercel-labs/skills)
（`npx skills add`，裝進 Claude Code 或 Codex），`tap.mjs` 把五個本機來源合併還原：

| # | 來源 | 給得出什麼 |
|---|---|---|
| 1 | `<sessionId>.trajectory.jsonl` 的 prompt | `Conversation info` 的 message id 與發話者，以及 `Conversation context` 那幾行「AI 沒被叫醒也看得到的鄰近訊息」 |
| 2 | `<sessionId>.jsonl`（含 `.reset.`／`.deleted.`） | 乾淨的 `role:user` 原文，但沒有 message id |
| 3 | `agent/codex-home/sessions/**/rollout-*.jsonl` | runtime 的另一份副本，補 1 已被輪替掉的部分 |
| 4 | offstage log | AI 沒看到的那些：script 接走、script 出錯、`/aside` |
| 5 | `agent/openclaw-agent.sqlite`（OpenClaw 2026.9 起） | session 全搬進這裡，1、2 從此不再長大。`transcript_events` 的使用者發言直接帶 message id 與發話者；一部分 event 是 zstd 壓縮存的；被換掉的 session 封存在 `session_transcript_archives`。唯讀開啟，gateway 正開著它 |

1～3 都會有缺漏（session 輪替、context window 裁切），合併後才接近完整。
同一則訊息可能同時出現在 session 與 offstage log（被攔下的那則，後來又出現在別一輪的
context 裡），工具用「第一行原文相同且時間相差 5 分鐘內」收斂成同一則，
否則讀的人會以為使用者把同一件事講了兩次。

一個實務上會炸掉的細節：按鍵（callback）在 transcript 裡帶的是 1e18 等級的**偽
message id**，不是 telegram 的 id。缺漏偵測若照著 id 範圍從頭數到尾，會直接
`RangeError` 而整支工具掛掉——所以掃描範圍設了上限，超過就放棄缺漏偵測並誠實說明。
**汲取對話是主要目的，缺漏清單只是附帶資訊，不該讓附帶資訊弄死主要目的。**

房間位置寫在各專案自己的 `genesis/.tap`（`channel` / `target` / `timestamp` 三個欄位，
不進版控）。`timestamp` 是上一輪結束的時間，汲取從那裡開始。

SKILL.md 分三段：`/tap [起點]` 汲取並寫 FIAT 文件、收到 `go` 實作、
`/tap -done` commit 並寫交接 memory。每一段最後都呼叫回報程式。
**SKILL.md 只寫寫程式的 AI 需要知道的事**——回報之後 gateway 還會做什麼，它不需要知道。

### 2.9 `/fiat`：在房間裡把軟體生出來

`/fiat` 也是 `api.registerCommand()` 註冊的 slash command，**不在 hook 裡**：它叫起的
AI 只會收到固定的 `/tap [起點]`、`go`、`/tap -done`，完全不需要「先攔下來看看」那一套。

寫程式的 AI 有兩種：Claude Code（[ccrun](https://github.com/neritina-ai/cli-ccrun) 叫起）與
Codex（[cdrun](https://github.com/caridina-ai/cli-cdrun) 叫起）。兩支程式的介面一模一樣——
`-d <dir> [prompt]` 開並印出 pid、`-p <pid> <text>` 打字、`-p <pid> -s` 看、`-p <pid> -q` 關——
所以 plugin 裡只有一張表（`core.js` 的 `HARNESSES`：名字與程式），**沒有哪一段程式是專為其中一種寫的**。
相容性不夠的地方改 runner，不在 plugin 裡分支。

`-claude`／`-codex` 指定這一輪叫哪一個，沒指定就用設定的 `fiat.harness`（再沒有就是 Claude Code）。
叫起之後對照表記下 `harness`，之後的 `-go`、`-done`、`?`、關 session 都用同一支 runner。

**`-go` 只有一個意思：這個房間的專案，接下來一路自動做到裝好。** 還沒開 session 就是連續版；
已經開著（例如停在 FIAT 文件等人看），就注入 `go` 請它接著做。主述者也可以在手機上直接打 `go`
（Claude Code 走 Remote Control，Codex 走 Codex app），但那條路壞了、或 FIAT 文件一時看不到時，
房間裡的 `/fiat -go` 是唯一的路。

**Codex 的對話一次只能有一個程式在寫。** cdrun 只在有事做的時候拿著它，閒下來就放手，主述者
才能從手機（經由 Codex app）接上去討論；之後再注入的話，沒人拿著就由 cdrun 拿回來跑，Codex app
拿著就排進 Codex 自己的佇列、由 Codex app 跑。所以一輪裡的後半段，可能是在 Codex app 裡跑的。
收尾關 session 時，Claude Code 是結束行程，Codex 則是封存對話（`cdrun -q` 會做）。Codex app 正開著
那段對話時封存不了：對話留在 app 裡，app 為它開的背景程式也還佔著專案目錄，直到在 app 裡關掉它。

| 訊息 | plugin 做的事 |
|---|---|
| `/fiat <projname>` | 目錄不存在：開新專案（寫 `genesis/.tap` 與 `.gitignore`），在對照表綁定這個房間 |
| `/fiat` | 查對照表找出這個房間的專案 |
| `/fiat ?`（或 `？`） | 讀對照表、`.tap` 與設定裡的 route 回報狀況。不叫起、不改任何東西，也不列路徑——房間裡的人都看得到 |
| `… -t yyyy-mm-dd HH:MM` | 注入的變成 `/tap yyyy-mm-dd HH:MM` |
| `… -go` | 對照表那一筆記上 `go` |
| `… -claude`／`-codex` | 這一輪用哪一個 |
| `/fiat -go` | session 開著：注入 `go`。沒開：連續版（上一列） |
| `/fiat -done` | 注入 `/tap -done` |
| `/fiat -install [projname]` | `openclaw skills install` 把專案的 skill 裝進這個房間的 agent，對照表記下裝上去的那一份 |
| `/fiat -uninstall` | 清掉對照表那一筆，拿掉裝上去的 skill |

前兩列（加上沒開 session 時的 `-go`）合流之後做同一件事：`<runner> -d <專案目錄> "/tap [起點]"`，
其他什麼都不帶。runner 回傳的 pid 記進對照表，那就是之後 `-go`、`-done` 與關 session 的把手。

**回報**是這個設計的樞紐。AI 每一段結束都在專案根目錄呼叫回報程式（跟 `tap.mjs` 放在一起的
`skills/tap/report.mjs`），它把「哪個房間（專案的 `.tap`）、哪個專案目錄、哪一段、一段話」POST 到
plugin 註冊的 HTTP 路由 `/chat-interceptor/report`，其餘的事都在 gateway 裡做：

| 階段 | gateway 做的事 |
|---|---|
| `fiat` | 回報；`go` 記著的話，往 session 打 `go`，並把 `go` 消掉 |
| `built` | 把 skill 裝進 OpenClaw、在房間上線（等同 `/fiat -install`），再回報 |
| `done` | 更新 `.tap` 的 `timestamp`、回報，標 `closing`，等 session 把這一輪講完再從外面關掉 |

幾個刻意的設計決定：

- **機械動作放在每段必經的那道門，不寫進 SKILL.md。** 部署、連續版的下一步、
  推 `timestamp`——沒有一個需要判斷，而寫在 SKILL.md 裡拜託 AI 記得，總有一次會忘。

- **回報程式只送一個 HTTP 請求，事情全在 gateway 做。** Codex 開著 sandbox（`workspace-write`）的時候，
  node 開不了任何子行程、也寫不了專案以外的檔案，`openclaw` CLI、runner、對照表全碰不到；連回本機 gateway
  倒是可以。gateway 這一側什麼都碰得到，而且 runner 的把手本來就在它手上。

- **回報程式不靠環境變數。** 被主述者從手機接手之後，Codex 的對話是在 Codex app 裡接著跑的，那裡沒有
  /fiat 叫起時的環境。所以房間從專案的 `.tap` 認，gateway 的 port 照 OpenClaw 自己的順序找
  （`OPENCLAW_GATEWAY_PORT`、設定檔的 `gateway.port`、18789）。gateway 只認「房間綁的就是這個專案目錄、
  而且有一個開著的 session」的回報；房間被 `-uninstall`、換了專案、session 已經關了，就什麼都不做。
  路由用 `auth: "plugin"`，只收 JSON 而且不帶 `Origin` 的請求——網頁跨站送不出這種請求。
  gateway 重啟期間連不上，回報程式會等它回來。

- **`go` 不管它正在做什麼都直接打。** 它做完手上這一段，自然會接著做下去——
  還在汲取就先把 FIAT 寫完、回報，再實作。所以不需要 `/tap -go` 這種斜線指令：
  主述者、`/fiat -go`、回報打的是同一個 `go`，而且都是打完就走。

- **關 session 是 gateway 從外面關，不是 session 自己關。** 從裡面只能打 `/exit`，而 `/exit`
  會停在「還有背景工作，確定要離開嗎」這種對話框。`-q` 能在十秒後強制結束，但它會等 session
  結束，所以只能從外面叫。收到 `done` 時 session 還在把這一輪講完（回報就是它這一輪叫的），
  所以先等一會兒再 `-q`。gateway 在那之間重開過的話，對照表停在 `closing`，再打一次
  `/fiat -done` 就直接關。

- **每一段重複回報都不會出事。** `go` 用過就消掉、裝過的照裝、關 session 只排一次。
  AI 偶爾會重試，重試不能變成「實作兩次」。

- **一個房間一個專案，換綁定只有一條路**：`-uninstall` 再 `-install`。直接
  `/fiat 別的專案` 太容易混淆，所以是錯誤。目錄已經存在、房間卻沒綁它的時候，
  只有它自己的 `.tap` 本來就指著這個房間才算數。

- **新專案看的是「目錄存不存在」，FIATLUX 還是 FIAT-{slug} 看的是「目錄裡有沒有程式」。**
  前者是 plugin 的事（要不要建目錄），後者是 AI 的事（寫哪一種文件）。
  目錄存在、綁定有效、裡面卻空空的，仍然是「建立新專案」的那一種文件。

- **`-t` 只影響這一輪。** 它直接變成 `/tap` 的參數，不寫進 `.tap`；`timestamp` 只在
  `done` 那一刻往前推。

- **`/fiat` 不等 runner 回來。** runner 要等 session 真的能接話才回來，冷啟動常常超過半分鐘，
  而指令卡住的是整個房間的回覆。所以先回話，失敗再補一則；等待期間同一個房間再打
  `/fiat` 會被擋下來。

- **一個房間一次一個 session。** 開著的時候再 `/fiat` 會被擋；pid 記著但已經不在了
  （視窗被關掉、當機），就當沒有、重新叫一個。「還在不在」問叫起它的那支 runner。

- **只帶跟任務有關的參數。** 工作目錄與第一句話。模型、effort、
  權限模式一概不帶，照使用者自己的 Claude Code／Codex 設定。

- **專案名要通過 `/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/`。** 它來自不受信任的聊天輸入，
  而且會直接接在 `projectsDir` 後面當路徑用。開頭限定英數，所以不可能是 `.`、`..`
  或 `-rf`，中間不允許任何路徑分隔字元。

- **一個專案就是一個 OpenClaw skill，安裝就是 `openclaw skills install`。** SKILL.md 教 AI
  處理 script 放行的那些，`scripts/intercept.*` 攔確定性的那些。裝進去的是一份**複製**，
  在這個房間的 agent 的 workspace 裡：AI 讀它的 SKILL.md、route 跑它的 script，開發目錄
  怎麼改都不影響線上，直到再裝一次。沒被攔下的輸入怎麼交到那個 skill 手上是 OpenClaw 的事——
  plugin 不替它注入任何提示詞，房間的 systemPrompt 也不必寫「載入某某 skill」。
  skill 本身也不知道自己在哪個房間——它跟任何 skill 一樣，只描述自己做什麼、什麼時候用。
  對照表記下 `installedDir`，route 只認它；沒有這一欄的舊登記一律不算數。

- **`-uninstall` 會把裝上去的那一份拿掉**，否則它還會出現在這個 agent 的每一個房間。
  只刪 `…/skills/<名字>` 這種位置；開發目錄一個檔案都不動。

- **起點一定要帶 `-t`。** `/fiat 2026-09-28` 分不出是起點還是一個專案名。忘了帶的時候
  回話直接給出補好的那一句，而不是一句「看不懂」。

- **`-install` 會把專案的 `.tap` 改指到這個房間。** `/tap` 汲取的是 `.tap` 指的那個房間，
  專案被裝到新房間，下一輪就該從新房間汲取。`timestamp` 留著。

- **`allowFrom` 疊在 OpenClaw 自己的指令授權上。** `/fiat` 會在這台機器上叫起一個能改檔案的
  agent；OpenClaw 認可的 sender 不一定都該有這個權力。

- **Discord 的斜線指令，`ctx.to` 是 `slash:<使用者 id>`**（回覆給按指令的那個人），
  不是頻道。房間改從 sessionKey 或 `from`（`discord:channel:<id>`）認，否則 `/fiat`
  會把「這個人」當成房間。

---

## 3. 邊界：plugin 到哪裡為止

plugin 是通用的路由器，職責只有這幾件事：選 route、跑 script、依 exit code 決定
短路還是放行、把 AI 沒看到的話記下來，以及 `/aside` 與 `/fiat` 兩個指令。
**領域邏輯與一切額外能力都在 script 那一側；需要智力的判斷則在 `/fiat` 叫起的
AI（Claude Code 或 Codex）那一側。**

script 需要更多能力時，OpenClaw CLI 本身就是它的介面，plugin 不必轉手：

| script 想做 | 它自己怎麼做 |
|---|---|
| 中途問模型（含 model routing 與 fallback） | `openclaw infer model run --gateway --json` |
| 按鈕、選單、圖片、多則訊息、就地更新 | `openclaw message send`／`edit`（`--presentation`、`--media`…） |
| 來回兩輪的流程狀態 | 用 stdin 給的 `sessionKey` 當 key 自己寫狀態檔 |
| 同一個房間內依關鍵字分流 | 一支 script，內部自己 dispatch |

這幾條都寫在 [AUTHORING.md](AUTHORING.md) 第 6、7 節，給 script 作者看。
plugin 這一側不需要為它們新增任何欄位。

真正屬於 plugin 的設定只有兩組，而且兩組都是路由問題：route 的
`channel` + `target`（這個房間交給哪一支 script），以及 `fiat` 的 `projectsDir`
+ `ccrun`／`cdrun`（這個房間對應哪個專案目錄、用什麼叫起寫程式的 AI）。
路由到「哪裡」是 plugin 的事，到了那裡之後做什麼都不是。

### 為什麼 stdout 只收純文字

底層的 `ReplyPayload` 支援 `presentation` 與 `interactive`，plugin 刻意不把
這些欄位接進 script 協定。理由是：接了就等於在 stdout 上再發明一套序列化格式，
而 `openclaw message send --presentation` 已經是那件事的正規介面，
script 直接呼叫就好，而且順便拿到多則訊息與 edit——那些本來就不可能塞進
「一個 stdout」裡。

所以 stdout 保持最單純的意思：**一則純文字，或空字串代表不回話**。
要更多就自己送，送完印空 stdout 收尾。

---

## 4. 已知的行為特性

- **被攔截的訊息不會進 session 歷史。** 使用者後面問 AI「我剛剛做了什麼」，
  AI 不知道。這是省 token 的必然代價，DB 才是唯一真相。
  事後要檢討那些輸入，offstage log 裡都有，`/tap`（2.8）會把它跟 session 檔合起來還原。
- **`handled: true` 但沒給 `text`** → 使用者端什麼都不會收到，也不會被補「沒有產生回覆」。
  要「處理掉但不回話」就用這個。
- **plugin config 不會 hot reload。** 改 `openclaw.json` 之後要
  `openclaw gateway restart` 才算數。
  這一條是實測出來的，而且付過代價：`-install` 曾經把 route 寫進
  `openclaw.json`，回話說「裝好了」，使用者下一句話卻還是走舊的 route——
  設定檔在 17:01 就改好了，17:02 的訊息用的還是啟動時載入的那份。
  **所以上線改成寫進 `projectsFile`**（每一則訊息都重讀，當場生效）；
  plugin 自己也不可能去重啟 gateway——那等於在回話中途把自己殺掉。

- **`commands.handlers` 不是 OpenClaw 的設定。** 要把一個指令掛成 OpenClaw 的
  slash command，唯一的路是 plugin 的 `api.registerCommand()`——`commands` 那一段的
  schema 是 strict 的，沒有 `handlers` 這個鍵。

---

AI model used: Claude Opus 5.5
