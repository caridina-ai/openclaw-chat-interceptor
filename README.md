# openclaw-chat-interceptor

一個 OpenClaw plugin：在 `before_agent_reply` hook 攔下聊天訊息，先交給該對話
對應的 script 處理。script 處理得了就直接回覆，**整輪不呼叫模型，0 token**；
script 說「我不會」時，訊息原封不動交還給 AI 走原本的流程。

適合固定格式、高頻出現、不需要語意判斷的指令——那些交給模型只是浪費 token。

另外兩件事也一併在這裡解決：使用者可以隨手打一則 [`ISSUE`](#issue) 記下哪裡不順手，
而 [`/tap`](#tap) 把整段使用過程汲取出來交給 AI 檢討——**包含那些被攔掉、
從來沒進過 session 的輸入**。

- **要寫 script 的人看這份**：[docs/AUTHORING.md](docs/AUTHORING.md)
- 內部設計（hook 機制、plugin 實作）：[docs/DESIGN.md](docs/DESIGN.md)

裝一次，每個對話各自設一個 route。**plugin 只負責路由與呼叫，
本身不含任何領域邏輯**——那些屬於各自獨立的 script 專案。

## 安裝

```bash
git clone https://github.com/caridina-ai/openclaw-chat-interceptor
openclaw plugins install --link <path to this repo>
```

然後在 `~/.openclaw/openclaw.json` 設定。`allowConversationAccess` 是必要的：
非 bundled 的 plugin 沒有它就不能註冊 `before_agent_reply`。

```json
{
  "plugins": {
    "entries": {
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

改設定會 hot reload；改 `src/index.js` 才要 `openclaw gateway restart`。

> **前提**：Telegram 的 `groupPolicy` 預設是 `allowlist`。群組沒列在
> `channels.telegram.groups` 裡，訊息在 channel ingress 就被丟掉了，根本輪不到
> hook。新的房間要先加進去——而群組 id 正好可以從被丟掉時留下的那行 log 讀出來，
> 見 [DESIGN.md 2.5](docs/DESIGN.md)。

## 設定項

| 欄位 | 說明 |
|---|---|
| `debug` | 每一輪的判斷過程寫進 `logFile` |
| `logFile` | 預設 `~/.openclaw/logs/chat-interceptor.log` |
| `issueLogFile` | `ISSUE` 訊息寫到哪，預設 `~/.openclaw/logs/chat-interceptor-issues.log` |
| `routes[]` | 依序比對，第一個對上的勝出；都沒對上就整輪交給 AI |

每個 route：

| 欄位 | 必要 | 說明 |
|---|---|---|
| `name` | | trace 與錯誤訊息裡的標籤 |
| `channel` | | `telegram`、`discord`…；省略代表不限 channel |
| `target` | ✓ | 對話 id，寫法同 `openclaw message send --target` |
| `command` | ✓ | script 的 argv。**用絕對路徑**——gateway 是服務啟動的，PATH 跟 shell 不一樣 |
| `cwd` | | script 的工作目錄 |
| `env` | | 額外環境變數，蓋在 gateway 自己的之上 |
| `timeoutMs` | | 預設 15000 |
| `onError` | | `handle`（預設，回錯誤訊息）或 `passthrough`（交給 AI）。只有無副作用的 script 才適合 passthrough |

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

## ISSUE

<a id="issue"></a>

有 route 的房間裡，使用者可以隨手打一則 `ISSUE` 開頭的訊息，記下哪裡不順手：

```
ISSUE 按鍵盤之後要等好幾秒才有反應
```

plugin 自己吃掉：**不呼叫 AI、不傳給 script、不回話**。多行也可以，大小寫不拘。

認的就是 `ISSUE` 這個開頭，關鍵字後面接什麼就原樣記什麼
（`issues are piling up` 這種不算，那是一句話裡剛好有這個字）。

光靠 AI 答應「看到 ISSUE 就靜默略過」是不算數的：那句話還是進了 session、
還是叫醒了模型、還是花了 token。真正做得到的只有在模型之前就吃掉，也就是這裡。

被吃掉的訊息不進 session，所以它會被寫進 `issueLogFile`，一行一筆 JSON——
下面的 `/tap` 讀的就是這個檔。萬一寫不進去，那一則會回一句
`ISSUE not recorded: …`，不會默默吞掉使用者的待辦。

沒有 route 的房間不吃 `ISSUE`：那個房間沒套用本 plugin，攔下它等於偷走一句
本來會有人回應的話。

## `/tap`

<a id="tap"></a>

上線之後真正的問題是「哪裡還可以改」。但被攔掉的輸入不進 session，
OpenClaw 的 CLI 也沒有讀取頻道歷史的指令。`/tap` 是一個
[Agent Skill](https://github.com/vercel-labs/skills)，把整段使用過程還原出來
交給 Claude Code 這類 AI harness 檢討：

```bash
npx skills add caridina-ai/openclaw-chat-interceptor
```

（只裝這一個 skill：`npx skills add caridina-ai/openclaw-chat-interceptor --skill tap`；
裝給特定 harness 加 `-a claude-code`，裝成全域加 `-g`。）

裝好之後在專案裡叫它：**「tap 一下我的記帳頻道，看看哪裡可以改」**。它會給你

- 使用者實際打過的每一句話，**包含被 script 攔掉、沒進 session 的那些**
- 每一句當時的下場：攔下了、放行給 AI、還是出錯了
  ——**「放行給 AI」那幾則就是下一條規則的原料**
- 使用者累積的 `ISSUE`

然後 AI 拿這些去改那支 script。汲取只是手段，改程式才是目的。

每個專案用一個 `.tap` 記住自己的頻道在哪裡，**只有三個欄位**：

```
channel: telegram
target:  -1001234567890
viewed:  2026-08-18 20:43:20
```

`viewed` 是上一輪檢討看到哪裡為止，留空就是看全部；每檢討完一輪就推到當下，
下次只看新的。**`.tap` 絕不進版控**——頻道位置是敏感資訊。

要讓每一則都帶著「下場」，plugin 設定裡的 `debug` 要是 `true`；
沒開也還是有逐字稿，只是不知道哪些被攔到了。

## 測試

```bash
npm test
```

不需要 gateway、不需要網路，也不依賴任何外部 script——測試自己把 fixture
寫進暫存目錄。

## 開發

Plain ESM JavaScript，沒有 build step。`--link` 安裝後改完
`src/index.js` 重啟 gateway 就生效。

AI model used: Claude Opus 5.0
