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
`/status` 吃掉。唯一的例外是打成一則訊息的 `/aside`：在這裡就記下（見 2.7）。
`/aside`、`/fiat` 在 telegram 是原生指令，走另一條路，碰不到這個 hook。

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
│   ├── core.js                 # 機械部分：房間、對照表、.tap、script、ccrun／cdrun
│   └── send.mjs                # script 再送訊息用的（payload 的 `send`，見 2.7）
├── test/*.test.js              # node --test，不需要 gateway、Claude Code 或 Codex
├── skills/tap/                 # /tap：給 Claude Code 或 Codex 裝的技能（見 2.8）
│   ├── SKILL.md
│   ├── tap.mjs                 # 汲取對話
│   ├── report.mjs              # 回報程式：每一段結束時呼叫（見 2.9）
│   └── gateway.mjs             # 上面兩支找本機 gateway 的路由
├── skills/group-aside/         # OpenClaw 技能，隨 plugin 載入：群聊裡怎麼說只給人看的話（見 2.7）
├── genesis/                    # 本專案的委託書：FIATLUX.md 與後續的 FIAT-*.md
└── docs/
    ├── AUTHORING.md            # 給 script 作者
    ├── DESIGN.md               # 本檔
    └── FILES.md                # 讀寫哪些檔案、放在哪裡，讀哪些環境變數
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
asideOf(body)                   /aside 或帶記號的 → 記進 offstage log，{ handled: true }（見 2.7）
  ↓ 不是
selectRoute(ctx, config)        設定裡的 route 優先，其次是對照表裡裝上的專案
  ↓ 沒有 route → return undefined（整輪給 AI）
spawn route.command，stdin 餵 JSON payload
  ↓
exit 0  → { handled: true, text: stdout }   （stdout 空 → 不帶 text，靜默）  → 記進 offstage log
exit 20 → return undefined（給 AI）
其他    → 依 route.onError 決定 handled（記進 offstage log）或 passthrough
```

回話的 `text` 開頭帶記號（見 2.7）：給人看的，其他機器人不接話。

`/fiat` 不在這條路上：它是 OpenClaw 的 slash command（見 2.9），在 agent 之前就被
OpenClaw 的指令流程接走了，根本不會走到這個 hook。

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
| stdin | JSON `{ body, channel, target, senderId, sessionKey, agentId, send }` |
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

`/aside ＿＿`：不呼叫模型、不跑 script、不回話，只往 offstage log
append 一行 `<當地時間> {"kind":"aside", …}`。兩個入口：

- **OpenClaw 的原生指令**（例如 Telegram 的指令選單）：`api.registerCommand()` 的 handler，
  回 `{ suppressReply: true }`。
- **打成一則訊息的**：hook 在選 route 之前就記下（`takeAside`）。

幾個刻意的決定：

- **名字取自戲劇的旁白。** 說出口、留在劇本裡，但台上其他角色聽不見——這不是比喻，
  這就是定義。它曾經叫 `ISSUE`，但那個名字宣稱了「這是軟體的問題」，
  而使用者留的話多半不是；他只是不想讓那句話被任何人處理。

- **它是房間的獨白，不是對哪一台說的。** 留話的人不會想到將來是哪一台來實作，
  所以房間裡每一台都要記：打成一則訊息的 `/aside`（帶不帶 `@bot` 都一樣），每一台的 hook 都收得到。

- **Discord 上不註冊成原生指令。** 那裡的斜線指令要先選一台機器人、只送到那一台，
  頻道裡也不會留下打的字（`suppressReply` 就是沒有可見的回覆）。不註冊的話，
  Discord 用戶端把 `/aside` 當成一般文字送出。OpenClaw 沒有「不要註冊成原生指令」的開關，
  唯一的把手是 `registerCommand` 的 `channels`——一張白名單，原生指令與文字指令都看它——
  所以列的是設定裡 Discord 以外的 channel；一個都沒有就不註冊，空的白名單在 OpenClaw 眼裡是「全部」。
  其他 channel 照舊走原生指令的 handler。

- **每個房間的行為都一樣，而且誰都能用**（`requireAuth: false`）。有沒有 route、
  有沒有專案，都不影響。使用者要的是「我在這裡留一句，誰都不要理」；這件事如果在
  某些房間會突然叫醒 AI，他每次開口前都得先想「這間算不算」，那就不是一個他敢用的東西了。

- **跟被攔下的訊息記在同一個檔。** 兩者是同一回事：AI 沒看到的話。分兩個檔，
  還原對話的人就得合兩次。

- **寫失敗要回話。** 使用者要的是「記一下、不要有反應」，但「沒記到卻也沒反應」
  就是把他的話默默弄丟了，所以那一則回 `aside not recorded: …`。

#### 機器人的 /aside

好幾台機器人在同一個房間裡互相看得到（Discord 的 `allowBots: true`、不要求 @mention）時，
一台的回報會被另一台的 AI 拿來回應，一來一往就把額度燒光。所以只給人看、不需要其他機器人接話的訊息，
也用 /aside。hook 認兩種開頭，處理完全一樣：

- **`/aside`**：人打的，或 AI 自己寫的。教 AI 這麼做的是隨 plugin 載入的 OpenClaw 技能 `skills/group-aside`
  （manifest 的 `skills`；`user-invocable: false`，不會變成斜線指令）。送出去不做任何轉換：
  人看得到 `/aside`，就知道其他機器人看不到。
- **一個看不見的記號 U+E0021**（TAG EXCLAMATION MARK）：這個 plugin 自己送出去的每一則都帶，畫面上乾淨。
  出口有三個：`core.js` 的 `notify`（回報、失敗通知）、hook 與指令回給 OpenClaw 的 `text`
  （script 的回話與錯誤訊息、`/fiat` 的回覆），以及 script 要再送訊息時叫的 `src/send.mjs`（payload 的 `send`）。
  記號的寬度是零，Telegram 與 Discord 都原樣保留、顯示時看不出來，別台 bot 的訊息進到這一台的 `before_dispatch` 時
  也還在（都實測過）。記下來時標 `"bot": true`，`/tap` 在發話者後面標「機器人」。

幾個刻意的決定：

- **記號不寫進 AUTHORING。** script 作者只學 `send`：記號只有一個地方會加，換了也只改一處。
  回報本來就經過 gateway，加記號不靠 AI 記得。

- **長訊息的後半也算。** 平台會把太長的訊息切成好幾則（Discord 一則 2000 字、17 行），`/aside` 或記號
  只在第一則。所以一則長的 /aside（1200 字或 12 行以上，可能被切過）之後，同一個發話者在同一個房間
  10 秒內接著送來的，都算同一則的後半（每接一則再延 10 秒）。短的不會被切，不必等：人打完一句 /aside
  緊接著講的話，是要給 AI 聽的。hook 分不出發話者是人還是 bot，所以只能看長度。

### 2.8 `/tap`：被攔掉的輸入怎麼還原

`handled: true` 的那一輪不進 session transcript——這是 0 token 的必然代價，
也是回頭檢討時最大的障礙：**最需要看的「script 還接不住哪些話」、「使用者抱怨了什麼」
正好是看不到的那些。**

`skills/tap/` 是一個 [Agent Skill](https://github.com/vercel-labs/skills)
（`npx skills add`，裝進 Claude Code 或 Codex），`tap.mjs` 把平台的歷史與五個本機來源合併還原：

| # | 來源 | 給得出什麼 |
|---|---|---|
| 1 | `<sessionId>.trajectory.jsonl` 的 prompt | `Conversation info` 的 message id 與發話者，以及 `Conversation context` 那幾行「AI 沒被叫醒也看得到的鄰近訊息」 |
| 2 | `<sessionId>.jsonl`（含 `.reset.`／`.deleted.`） | 乾淨的 `role:user` 原文，但沒有 message id |
| 3 | `agent/codex-home/sessions/**/rollout-*.jsonl` | runtime 的另一份副本，補 1 已被輪替掉的部分 |
| 4 | offstage log | AI 沒看到的那些：script 接走、script 出錯、`/aside`（帶記號的，發話者標著「機器人」） |
| 5 | `agent/openclaw-agent.sqlite`（OpenClaw 2026.9 起） | session 全搬進這裡，1、2 從此不再長大。`transcript_events` 的使用者發言直接帶 message id 與發話者，AI 的回應也在；一部分 event 是 zstd 壓縮存的；被換掉的 session 封存在 `session_transcript_archives`。唯讀開啟，gateway 正開著它 |
| 6 | 平台上的歷史（gateway 的 `/chat-interceptor/history`） | 房間裡講過的每一則，包括 OpenClaw 不在場時講的。Discord 讀得到；Telegram 不給讀 |

1～3 都會有缺漏（session 輪替、context window 裁切），合併後才接近完整。
同一則訊息可能同時出現在好幾個來源（被攔下的那則，後來又出現在別一輪的 context 裡），
工具用「message id 相同，或第一行原文相同且時間相差 5 分鐘內」收斂成同一則，
否則讀的人會以為使用者把同一件事講了兩次。

**本機的紀錄只有 OpenClaw 在場時收到的那些。** 機器人被拉進 Discord 討論串之前的對話、房間裡跟別的
機器人談的，本機一則都沒有——而 `/fiat` 的用法本來就是「先聊，聊完再叫」，聊的時候 OpenClaw 在不在場，
主述者不會注意到。所以平台讀得到歷史時，**以平台為主幹**：本機那幾個來源只補上平台看不到的那一層
（offstage 的 ↳ 下場）；平台翻到的那段時間裡，本機有、平台對不上的（沒送出去的旁白、寫法不同的同一則）不收。

- 讀法是 `openclaw message read`，從新往舊一頁 100 則，翻過起點或翻到底就停。它在 **gateway 裡**跑：
  Codex 的 sandbox 開不了子行程（同 2.9 的回報程式）。CLI 每叫一次要半分鐘，所以最多翻 10 頁，沒翻完整就照實說翻到哪裡；
  翻的時候 header 先送、每頁送一個空白，汲取那一端才不會以為斷線。
- 這條路由讀得到整個房間的歷史，所以只收本機來的連線（另外跟回報一樣，只收 JSON、不帶 `Origin`）。
- 平台給的是原樣的訊息物件：機器人發的標「機器人」，開頭帶記號的是 plugin 送的（2.7），當成機器人的 `/aside`。

**缺漏要分得出「沒缺」和「不知道」。** 讀得到平台，翻完整就是沒缺。讀不到平台，只能從本機收到的
message id 看：Telegram 的 id 在一個房間裡連號，範圍內沒收錄到的就是漏的。Discord 的 id 不連號，
按鍵（callback）在 transcript 裡帶的又是 1e18 等級的**偽 message id**——這兩種都超過 Number 的精度，
留成字串、不掃（照著 id 範圍從頭數到尾，會直接 `RangeError` 而整支工具掛掉）。看不出來就是 `null`，不是 0。
**汲取對話是主要目的，缺漏清單只是附帶資訊，不該讓附帶資訊弄死主要目的。**

本機一筆這個房間的紀錄都沒有、平台也讀不到時，汲取結果什麼都不代表：輸出開頭印警告、以 3 結束。
寫程式的 AI 這時不寫 FIAT 文件，用 `empty` 回報（2.9）。

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
`-d <dir> [prompt]` 開並印出 pid、`-p <pid> <text>` 打字、`-p <pid> -s` 看、`-p <pid> -q` 關、
`-m <舊目錄> <新目錄>` 目錄改名之後把它為那個目錄記的東西搬過去——
所以 plugin 裡只有一張表（`core.js` 的 `HARNESSES`：名字與程式），**沒有哪一段程式是專為其中一種寫的**。
相容性不夠的地方改 runner，不在 plugin 裡分支。

`-claude`／`-codex` 指定這一輪叫哪一個。沒指定就叫這個房間上一次那一個，使用者不必記得上次是怎麼叫起來的；
這個房間從沒叫起過，才用設定的 `fiat.harness`（再沒有就是 Claude Code）。叫起之後對照表記下 `harness`，
session 關掉也留著；之後的 `-go`、`-done`、`-abort`、`?`、關 session 都用同一支 runner。

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
| `/fiat -abort` | 叫錯了：直接關掉 session（`-q`），不注入 `/tap -done`、不動 `timestamp`。還在叫起中的，起來就關 |
| `/fiat -install [projname]` | `openclaw skills install` 把專案的 skill 裝進這個房間的 agent，對照表記下裝上去的那一份 |
| `/fiat -uninstall` | 清掉對照表那一筆，拿掉裝上去的 skill |
| `/fiat -rename <newname>` | 專案目錄改名，每一支 runner `-m` 搬它的 AI 為這個目錄記的東西，對照表裡指著它的每一筆跟著改 |

前兩列（加上沒開 session 時的 `-go`）合流之後做同一件事：`<runner> -d <專案目錄> "/tap [起點]"`，
其他什麼都不帶。runner 回傳的 pid 記進對照表，那就是之後 `-go`、`-done` 與關 session 的把手。

**回報**是這個設計的樞紐。AI 每一段結束都在專案根目錄呼叫回報程式（跟 `tap.mjs` 放在一起的
`skills/tap/report.mjs`），它把「哪個房間（專案的 `.tap`）、哪個專案目錄、哪一段、一段話」POST 到
plugin 註冊的 HTTP 路由 `/chat-interceptor/report`，其餘的事都在 gateway 裡做：

| 階段 | gateway 做的事 |
|---|---|
| `fiat` | 回報；`go` 記著的話，往 session 打 `go`，並把 `go` 消掉 |
| `empty` | 汲取之後沒寫成 FIAT 文件：回報，消掉 `go`，標 `closing` 關掉 session。`timestamp` 不動 |
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

- **`-rename` 連 AI 的記憶一起搬，而且全有或全無。** Claude Code 的交接 memory 是照目錄路徑存的，
  不搬的話，下一輪就看不到前幾輪留下的經驗。搬什麼是 runner 的事（`-m`，只在目錄搬好之後搬）；
  沒裝的 runner 跳過。目錄、runner、對照表有一處跟不上，就全部改回去。
  `.tap` 在目錄裡，跟著走；裝上去的那一份是複製，skill 名取自它的 SKILL.md，跟目錄名無關，照樣跑。
  session 開著就不改：它的工作目錄就在裡面。各登錄的位置見 [FILES.md](FILES.md)。

- **`-abort` 與 `-done` 不一樣：不注入、不 commit、不動 `timestamp`。** 叫錯了要馬上能收回，所以叫起中也收得回來：
  記下來，等它起來就關。`-q` 失敗而且它還活著的話 pid 留著：那是再試一次的把手，`-rename` 也靠它知道目錄還有人在用。
  額度用完的 Codex 就是這樣：`/tap -done` 跑不動，session 一直開著，只有 `-abort` 關得掉。

- **起點一定要帶 `-t`。** `/fiat 2026-09-28` 分不出是起點還是一個專案名。忘了帶的時候
  回話直接給出補好的那一句，而不是一句「看不懂」。

- **`-install` 會把專案的 `.tap` 改指到這個房間。** `/tap` 汲取的是 `.tap` 指的那個房間，
  專案被裝到新房間，下一輪就該從新房間汲取。`timestamp` 留著。

- **`allowFrom` 疊在 OpenClaw 自己的指令授權上。** `/fiat` 會在這台機器上叫起一個能改檔案的
  agent；OpenClaw 認可的 sender 不一定都該有這個權力。

- **Discord 上 `/fiat` 維持斜線指令。** 房間裡有好幾台機器人時，從選單選一台，就是指定由哪一台開發；
  打成一般文字的話每一台都收得到，會一起叫起 AI。OpenClaw 的斜線指令回覆預設是臨時訊息
  （`channels.discord.slashCommand.ephemeral` 預設 true），只有下指令的人看得到、過一會兒就消失，
  所以 README 請 Discord 使用者把它設成 false。

- **房間的寫法要送得到。** `.tap`、offstage log 記的 target 只拿掉開頭的 provider，`user:`、`channel:` 這種種類留著：
  Discord 的裸 id 是頻道，私聊少了 `user:` 就送不到。回報送到 `.tap` 寫的那個房間；對照表的 key 是正規化過的，
  只拿來找，不拿來送。比對兩種寫法是不是同一間，一律用 `normalizeTarget` 去掉種類再比，舊的寫法也認得。

- **Discord 的斜線指令，`ctx.to` 是 `slash:<使用者 id>`**（回覆給按指令的那個人），
  不是頻道。房間改從 sessionKey 認（`…:discord:direct:<id>` 是私聊 `user:<id>`，其他是 `channel:<id>`），
  沒有才看 `from`，否則 `/fiat` 會把「這個人」當成房間。私聊的 `from` 是 `discord:<使用者 id>`，不能拿來用。

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
| 按鈕、選單、圖片、多則訊息 | stdin 給的 `send`，後面接 `openclaw message send` 的選項（`--presentation`、`--media`…） |
| 就地更新 | `openclaw message edit` |
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
