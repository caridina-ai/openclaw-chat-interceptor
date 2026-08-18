# openclaw-chat-interceptor 技術設計

這份文件說明 `before_agent_reply` 這條路徑怎麼運作、plugin 這一側怎麼實作，
以及職責邊界劃在哪裡。**要寫 script 的人請看 [AUTHORING.md](AUTHORING.md)**，
這份是內部設計。

所有關於 OpenClaw 行為的敘述都對照過 `2026.7.1-2` 的發行原始碼
（`<npm global root>/openclaw/dist`）。

---

## 1. `before_agent_reply` 是什麼

OpenClaw 有兩套 hook，名字很像但完全不同：

| | internal hooks | **typed plugin hooks** |
|---|---|---|
| 形式 | `~/.openclaw/hooks/<name>/HOOK.md` + `handler.ts` | plugin 裡 `api.on(name, handler)` |
| 事件 | `command:new`、`message:received`、`gateway:startup`… | `before_tool_call`、**`before_agent_reply`**、`message_sending`… |
| 能力 | 觀察 + 副作用 | 可以 **block / cancel / 短路** |
| 文件 | `docs/automation/hooks.md` | `docs/plugins/hooks.md` |

`before_agent_reply` 只存在於第二套。**所以 openclaw-chat-interceptor 必須是 plugin，
不能是 skill，也不能是 `~/.openclaw/hooks/` 底下的 internal hook。**

### 它在哪裡被呼叫

`dist/get-reply-*.js`，`getReply()` 之中。時序是：

```
telegram 收到訊息
  ↓
決定 session / agent / model（還沒送任何東西給模型）
  ↓
if (hookRunner.hasHooks("before_agent_reply"))
      hookResult = runBeforeAgentReply({ cleanedBody }, ctx)
      if (hookResult?.handled)
          return hookResult.reply ?? { text: "NO_REPLY" }   ← 從這裡直接跳出
  ↓
stage media → runPreparedReply()   ← 組 prompt、送模型、跑 tool、寫 session 歷史
```

`handled: true` 是**整個 agent turn 的短路**，不是「先回一句再繼續」：

- 不組 system prompt、不載入 session 歷史、不呼叫模型 → **0 token**
- 不寫進 session transcript → 這一輪對後續對話是隱形的
- 回傳的 `reply` 直接進入正常的 outbound pipeline，使用者在 telegram 看到的
  跟 AI 回的沒有差別

### 介面

```ts
// 收到
type PluginHookBeforeAgentReplyEvent = { cleanedBody: string };

// 回傳（回 undefined = 什麼都沒發生，照原流程給 AI）
type PluginHookBeforeAgentReplyResult = {
  handled: boolean;
  reply?: ReplyPayload;   // { text: "..." } 就夠了
  reason?: string;        // 只進 log，不給使用者看
};
```

第二個參數 `ctx` 是 `PluginHookAgentContext`，本專案會用到的欄位：

| 欄位 | telegram 群組 | discord channel |
|---|---|---|
| `ctx.channel` / `ctx.messageProvider` | `"telegram"` | `"discord"` |
| `ctx.chatId` / `ctx.channelId` | `"-1001234567890"` | `"123456789012345678"` |
| `ctx.sessionKey` | `telegram:group:-1001234567890` | `discord:channel:123456789012345678` |
| `ctx.agentId` | 這個房間綁定的 agent id | |
| `ctx.pluginConfig` | 本 plugin 在 openclaw.json 裡的 `config` 區塊 | |

### 對話 id 的三種寫法（跨 channel 的坑）

session key 的格式是 `[agent:<agentId>:]<channel>:<group|channel>:<rawId>`
（`parseRawSessionConversationRef`，`dist/session-key-utils-*.js`），
`ctx.chatId` 就是其中的 `rawId`——**已經剝掉 prefix 的裸 id**。

但使用者在 CLI 看到的不是這個：

```
openclaw message send --channel telegram --target -1001234567890
openclaw message send --channel discord  --target channel:123456789012345678
```

telegram 的 target 是裸 id，discord 的卻帶 `channel:` prefix。如果設定欄位直接拿去
跟 `ctx.chatId` 做字串比對，telegram 會過、**discord 會永遠對不上**。

所以本專案的 `target` 欄位兩邊都先正規化再比：剝掉 OpenClaw 自己那組
conversation prefix（`channel` `chat` `direct` `dm` `group` `thread` `user`）
以及等同 provider 名稱的前綴，重複剝到剝不動為止。結果是這三種寫法等價：

```
123456789012345678  ≡  channel:123456789012345678  ≡  discord:channel:123456789012345678
```

剝到認不得的 prefix 就停手，所以 matrix 的 `!abc:matrix.org` 不會被誤傷。
`ctx.chatId` 萬一缺席，還會退一步自己去解 `ctx.sessionKey`。

### 兩個一定會踩到的限制

1. **`before_agent_reply` 是 conversation hook。** 非 bundled 的 plugin 註冊它會被
   直接擋掉，除非設 `plugins.entries.<id>.hooks.allowConversationAccess = true`。
   被擋時 plugin 仍會「載入成功」，只是 `hookCount: 0`，很容易誤判成程式沒寫對——
   要用 `openclaw plugins inspect <id> --runtime --json` 看 `diagnostics` 才知道。
   （原始碼：`dist/registry-*.js` 的 `isConversationHookName` 那段。）

2. **`activation.onStartup` 必須是 `true`。** hook 是在 plugin `register()` 時註冊的；
   plugin 沒在 gateway 啟動時載入，`hasHooks("before_agent_reply")` 就是 false，
   hook 永遠不會跑。

---

## 2. plugin 這一側

### 2.1 專案結構

```
openclaw-chat-interceptor/
├── package.json                # openclaw.extensions 指向 src/index.js
├── openclaw.plugin.json        # plugin manifest：id / activation / configSchema
├── src/index.js                # 只做路由與呼叫（plain ESM，沒有 build step）
├── test/hook.test.js           # node --test，不需要 gateway
├── skills/tap/                 # /tap：給 AI harness 裝的檢討工具（見 2.8）
│   ├── SKILL.md
│   └── tap.mjs
├── genesis/FIATLUX.md          # 本專案的原始委託書
└── docs/
    ├── AUTHORING.md            # 給 script 作者
    └── DESIGN.md               # 本檔
```

**這個 repo 不含任何 script。** plugin 是通用的路由器，領域邏輯一律屬於各自的
script 專案（見 AUTHORING.md）。測試用的是寫進暫存目錄的 fixture，
所以跑測試不需要任何外部 script、DB 或 gateway。

用 **plain JavaScript 而不是 TypeScript**：`--link` 安裝後改完檔案重啟 gateway
就生效，中間沒有編譯。要發佈時再轉 TS + `runtimeExtensions` 也不遲。

`package.json` 刻意**不寫** `openclaw.compat`：本機版本是 `2026.7.1-2`，在 semver
眼中是 `2026.7.1` 的 prerelease，寫 `minGatewayVersion: "2026.7.1"` 反而會判定不相容。

### 2.2 攔截邏輯

plugin 本身**不含任何領域邏輯**，只做路由：

```
selectRoute(ctx, config)        依序找第一個 channel + target 都對上的 route
  ↓ 沒有 → return undefined（整輪給 AI）
body 以 ISSUE 開頭？ → 寫進 issueLogFile，handled 但不回話（見 2.7）
  ↓ 不是
spawn route.command，stdin 餵 JSON payload
  ↓
exit 0  → { handled: true, reply: { text: stdout } }   （stdout 空 → 靜默）
exit 20 → return undefined（給 AI）
其他    → 依 route.onError 決定 handled 或 passthrough
```

四個刻意的設計決定：

- **`target` 或 `command` 沒設好的 route 直接略過。** 寧可多花 token，也不要亂攔。
- **script 失敗預設算 `handled`。** 若失敗時 `return undefined`，同一句話會再送給 AI，
  AI 可能把已經做過的事再做一次。只有無副作用的 script 才適合 `onError: "passthrough"`。
- **同一個 route 一次只跑一支 script。** script 常會寫檔或寫 DB，
  兩則訊息同時進來會互相蓋掉。
- **`debug: true` 時每一輪都寫 trace 到 `~/.openclaw/logs/chat-interceptor.log`**，
  包含沒攔到的那些。這是唯一的觀測窗口——gateway 主 log 是 JSON 巨獸，很難看。

### 2.3 script 協定

> 要**寫** script 的人請直接看 [AUTHORING.md](AUTHORING.md)，那份是完整的作者指南。
> 這裡只記 plugin 這一側的合約。

| | |
|---|---|
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
openclaw plugins install --link <path to this repo>
```

`--link` 不複製檔案，只在 `plugins.load.paths` 記一筆路徑，改 code 立刻生效。

然後 `~/.openclaw/openclaw.json`（完整範例見 README）：

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
`before_agent_reply` 根本不會跑。這一步很容易漏掉，症狀是
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
"typedHooks": [{ "name": "before_agent_reply", "priority": 100 }],
"diagnostics": []
```

`typedHooks` 是空的就是沒接上；`diagnostics` 會直接寫出原因。

### 2.7 ISSUE

`ISSUE ＿＿` 由 plugin 直接吃掉：不呼叫模型、不跑 script、不回話，
只往 `issueLogFile` append 一行 `<當地時間> <JSON>`。

```js
const ISSUE_RE = /^issue\b([\s\S]*)$/i;
```

幾個刻意的決定：

- **只認 `ISSUE` 這個開頭，關鍵字後面接什麼就原樣記什麼。** 標點不另外判斷：
  `ISSUE:`、`ISSUE：` 本來就落在「開頭是 ISSUE」裡面，多寫一段判斷只是多一個
  會壞的地方。字界（`\b`）則是必要的，否則 `issues are piling up` 這種
  「一句話裡剛好有這個字」會被當成指令吃掉。

- **排在 script 前面。** 使用者抱怨的是「這個房間用起來怎樣」，不是給 script 的指令。
  送過去只會被誤判成某條規則，甚至產生副作用。
- **只在有 route 的房間生效。** 沒 route 的房間沒套用本 plugin，
  攔下它等於偷走一句本來會有人回應的話。
- **這是 plugin 的事，不是 script 的事。** 放進 script 就變成「每支 script 各自實作
  一次，而且各自可能忘記」；使用者要的是一個**在每個房間都一定成立**的約定。
- **另開一個檔，不寫進 `logFile`。** 那個檔記的是異常（放行、出錯），
  把使用者的抱怨堆進去等於把兩種完全不同的東西混在一起；而且 issue 不該因為
  某人沒開 `debug` 就消失。一行一筆 JSON：多行原文照原樣保留，
  又不必自己發明跳脫規則。
- **當地時間，不用 ISO。** 這個檔是拿來跟聊天室看到的時間、跟 `.tap` 的
  `viewed:` 對照的，同一個尺規才不必換算時區，比大小也直接字串比就好。
- **寫失敗要回話。** 使用者要的是「記一下、不要有反應」，但「沒記到卻也沒反應」
  就是把他的待辦默默弄丟了，所以那一則回 `ISSUE not recorded: …`。

### 2.8 `/tap`：被攔掉的輸入怎麼還原

`handled: true` 的那一輪不進 session transcript——這是 0 token 的必然代價，
也是檢討時最大的障礙：**最需要看的「script 還接不住哪些話」正好是看不到的那些。**

`skills/tap/` 是一個 [Agent Skill](https://github.com/vercel-labs/skills)
（`npx skills add`，裝進 Claude Code 這類 harness），把五個本機來源合併還原：

| # | 來源 | 給得出什麼 |
|---|---|---|
| 1 | `<sessionId>.trajectory.jsonl` 的 prompt | `Conversation info` 的 message id，以及 `Conversation context` 那幾行「AI 沒被叫醒也看得到的鄰近訊息」——**被攔截的訊息從這裡漏出來** |
| 2 | `<sessionId>.jsonl`（含 `.reset.`／`.deleted.`） | 乾淨的 `role:user` 原文，但沒有 message id |
| 3 | `agent/codex-home/sessions/**/rollout-*.jsonl` | runtime 的另一份副本，補 1 已被輪替掉的部分 |
| 4 | `logFile`（要 `debug: true`） | **每一輪的下場**：攔下、放行、出錯 |
| 5 | `issueLogFile` | `ISSUE`，只有這裡有 |

1～3 都會有缺漏（session 輪替、context window 裁切），合併後才接近完整。
同一則訊息可能同時出現在三個來源，工具用「第一行原文相同且時間相差 5 分鐘內」
收斂成同一則，否則檢討的人會以為使用者把同一件事講了三次。

一個實務上會炸掉的細節：按鍵（callback）在 transcript 裡帶的是 1e18 等級的**偽
message id**，不是 telegram 的 id。缺漏偵測若照著 id 範圍從頭數到尾，會直接
`RangeError` 而整支工具掛掉——所以掃描範圍設了上限，超過就放棄缺漏偵測並誠實說明。
**汲取對話是主要目的，缺漏清單只是附帶資訊，不該讓附帶資訊弄死主要目的。**

房間位置寫在各專案自己的 `.tap`（`channel` / `target` / `viewed` 三個欄位，
不進版控）。細節見 [`skills/tap/SKILL.md`](../skills/tap/SKILL.md)。

---

## 3. 邊界：plugin 到哪裡為止

plugin 是通用的路由器，職責只有四件事：選 route、吃掉 `ISSUE`、跑 script、
依 exit code 決定短路還是放行。**領域邏輯與一切額外能力都在 script 那一側。**

script 需要更多能力時，OpenClaw CLI 本身就是它的介面，plugin 不必轉手：

| script 想做 | 它自己怎麼做 |
|---|---|
| 中途問模型（含 model routing 與 fallback） | `openclaw infer model run --gateway --json` |
| 按鈕、選單、圖片、多則訊息、就地更新 | `openclaw message send`／`edit`（`--presentation`、`--media`…） |
| 來回兩輪的流程狀態 | 用 stdin 給的 `sessionKey` 當 key 自己寫狀態檔 |
| 同一個房間內依關鍵字分流 | 一支 script，內部自己 dispatch |

這幾條都寫在 [AUTHORING.md](AUTHORING.md) 第 8、9 節，給 script 作者看。
plugin 這一側不需要為它們新增任何欄位。

真正屬於 plugin 的設定只有 route 的 `channel` + `target`：
路由到「哪一支 script」是 plugin 的事，那支 script 之後做什麼都不是。

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
  事後要檢討那些輸入，用 `/tap`（2.8）從本機檔案還原。
- **`handled: true` 但沒給 `reply`** → OpenClaw 回 `{ text: "NO_REPLY" }`，
  這是內建的靜默 token，使用者端什麼都不會收到。要「處理掉但不回話」就用這個。
- **hot reload。** 改 `openclaw.json` 的 plugin config 會觸發 hot reload，
  改 `src/index.js` 則要 `openclaw gateway restart`。

---

AI model used: Claude Opus 5.0
