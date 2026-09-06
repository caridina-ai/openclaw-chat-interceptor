# openclaw-chat-interceptor

一個 OpenClaw plugin：在 `before_agent_reply` hook 攔下聊天訊息，先交給該對話
對應的 script 處理。script 處理得了就直接回覆，**整輪不呼叫模型，0 token**；
script 說「我不會」時，訊息原封不動交還給 AI 走原本的流程。

適合固定格式、高頻出現、不需要語意判斷的指令——那些交給模型只是浪費 token。

另外兩件事也一併在這裡解決：使用者可以隨手打一則 [`/aside`](#aside) 記下哪裡不順手，
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

> **改 `openclaw.json` 之後要 `openclaw gateway restart`。**
> plugin config **不會** hot reload——實測過：設定檔改好之後，下一則訊息還是走舊的
> route。這也是為什麼 [`/tap -install`](#tap) 不把 route 寫進設定檔（見那一節）。

> **前提**：Telegram 的 `groupPolicy` 預設是 `allowlist`。群組沒列在
> `channels.telegram.groups` 裡，訊息在 channel ingress 就被丟掉了，根本輪不到
> hook。新的房間要先加進去——而群組 id 正好可以從被丟掉時留下的那行 log 讀出來，
> 見 [DESIGN.md 2.5](docs/DESIGN.md)。

## 設定項

| 欄位 | 說明 |
|---|---|
| `debug` | 每一輪的判斷過程寫進 `logFile` |
| `logFile` | 預設 `~/.openclaw/logs/chat-interceptor.log` |
| `asideLogFile` | `/aside` 訊息寫到哪，預設 `~/.openclaw/logs/chat-interceptor-asides.log` |
| `tap` | 開啟房間裡的 [`/tap`](#tap) 指令。省略這一段，`/tap` 就跟一般訊息一樣交給 script 與 AI |
| `routes[]` | 依序比對，第一個對上的勝出；都沒對上就整輪交給 AI |

每個 route：

| 欄位 | 必要 | 說明 |
|---|---|---|
| `target` | ✓ | 對話 id，寫法同 `openclaw message send --target` |
| `project` | ✓＊ | `projectsDir` 底下的目錄名。要跑什麼**每次派工時才推**（見下） |
| `command` | ✓＊ | script 的 argv，約定不合用時的逃生口。給了就贏過 `project`。**用絕對路徑** |
| `name` | | trace 與錯誤訊息裡的標籤；用 `project` 的話不必給 |
| `channel` | | `telegram`、`discord`…；省略代表不限 channel |
| `cwd` | | script 的工作目錄 |
| `env` | | 額外環境變數，蓋在 gateway 自己的之上 |
| `timeoutMs` | | 預設 15000 |
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

## `/aside`

<a id="aside"></a>

留一句話在房間裡，**但誰都不要處理它**：

```
/aside 按鍵盤之後要等好幾秒才有反應
```

plugin 自己吃掉：**不呼叫 AI、不傳給 script、不回話**。多行也可以，大小寫不拘。

名字取自戲劇的「旁白」——說出口、留在劇本裡，但台上其他角色聽不見。這裡也一樣：
它留在房間的紀錄裡（下面的 `/tap` 撈得回來），但 AI 與 script 都收不到。

**每個房間的行為都一樣**：有沒有 route、有沒有專案、`debug` 開不開，都不影響。
使用者要的是「我在這裡留一句，誰都不要理」——這件事如果在某些房間會突然叫醒 AI，
那他每次開口前都得先想「這間算不算」，那就不是一個他敢用的東西了。

只認 `/aside` 這個開頭，後面接什麼就原樣記什麼（`/asidebar` 這種不算）。
Telegram 群組裡的 `/aside@botname` 也認。

光靠 AI 答應「看到這種訊息就靜默略過」是不算數的：那句話還是進了 session、
還是叫醒了模型、還是花了 token。真正做得到的只有在模型之前就吃掉，也就是這裡。

被吃掉的訊息不進 session，所以它會被寫進 `asideLogFile`，一行一筆 JSON——
下面的 `/tap` 讀的就是這個檔。萬一寫不進去，那一則會回一句
`aside not recorded: …`，不會默默把使用者的話弄丟。

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
- 使用者累積的 `/aside`

然後 AI 拿這些去動手：已經有 script 的就改它，還沒有 script 的新專案就把房間裡
聊出來的那個功能做出第一版。汲取只是手段，寫程式才是目的。

每個專案用一個 `.tap` 記住自己的頻道在哪裡，**只有三個欄位**：

```
channel: telegram
target:  -1001234567890
viewed:  2026-08-18 20:43:20
```

`viewed` 是上一輪檢討看到哪裡為止，留空就是看全部；**成果上線之後**才推到當下，
下次只看新的（還沒上線就推，下一輪會看到抱怨卻看不到需求）。
**`.tap` 絕不進版控**——頻道位置是敏感資訊。

要讓每一則都帶著「下場」，plugin 設定裡的 `debug` 要是 `true`；
沒開也還是有逐字稿，只是不知道哪些被攔到了。

### 從聊天室裡叫起來

上面那段講的是「人走到終端機、切到專案目錄、叫起 harness」。那三步都是機械動作，
所以也可以直接在房間裡打：

| 打這個 | 會發生什麼 |
|---|---|
| `/tap <projname>` | 在 `projectsDir` 底下開一個新專案（寫好 `genesis/.tap`），再叫起 harness |
| `/tap <projname> <yyyy-mm-dd>` | 同上，但汲取只從那一天開始 |
| `/tap` | 回到這個房間的專案，再叫一次 harness——「來看我剛剛講的意見」 |
| `/tap -uninstall` | 拆掉 route，並讓這個房間不再屬於任何專案 |
| `/tap -install` | 例外用的手動上線（見下） |

第二種是為了「先亂聊很久，聊到某個點子不錯才決定開專案」的房間：起點日期會寫進
新 `.tap` 的 `viewed:`，那之前的話就不會被撈回來。

前三種會叫起 harness：plugin 立刻回一句「開始了」，harness 在背景跑，跑完再回報
一則結果——一輪檢討動輒好幾分鐘，不能讓房間卡在那裡沒反應。同一個專案一次只跑一輪。
`-uninstall` 只改設定，所以是當場回話。

### 上線是自動的

**harness 跑完就會上線**，所以你改完馬上就能測。日常那條路上根本不需要「上線」
這個指令——需要動手的只有 `-uninstall`，而那是「這個房間要改作別的用途」時才有的事。

**harness 自己不裝任何東西，也不為它寫任何設定檔。** 它只是把 script 放到約定的位置：

```
<projectsDir>/<專案>/scripts/intercept.mjs
```

裝的是 plugin，而它記下來的只有「這個房間現在算 ledger 的，而且正在跑」。

**而且它不寫進 `openclaw.json`。** 那份設定不會 hot reload——寫進去要重啟 gateway
才算數，但使用者按完的下一秒就會去試，於是會看到「裝好了」卻沒有反應。
所以上線只是在 `projectsFile` 那一筆加一個旗標，而那個檔**每一則訊息都會重讀**，
當場生效。順帶一個好處：**一則聊天訊息再也碰不到 gateway 的設定。**

兩種情況會被擋下來，而且會在回報裡說明原因：**專案裡還沒有 script**（那就當它還不是
一條 route，什麼都不做）、**副檔名對應的直譯器找不到**（例如 `.py` 但這台機器上沒有
`uv` 也沒有 `python`）。harness 那一輪失敗的話也不裝——失敗那一輪的產物本來就不該相信。

已經裝著一模一樣的東西時就什麼都不做，回報裡也不會再喊一次。第二輪之後多半都是
這樣：改的是 script 的內容，route 指的還是同一個專案。

`tap.autoInstall` 設成 `false` 就關掉這個行為，改成自己打 `/tap -install`——
想在上線前先看一眼的時候用得上。

### harness 記不記得上一輪

預設**不記得**：每一次 `/tap` 都是一個全新的行程，context 空的。它靠兩個地方
重建理解——repo（需求、取捨、還沒解決的問題）與 `viewed` 之後的房間逐字稿。
這是刻意的：狀態放在你看得見、也改得動的地方。

但它問了你問題、你回答之後，「它記不記得自己問過什麼」就有差了。設 `continueCommand`
就會接續同一個 session：

```json
"continueCommand": [
  "C:/Users/you/.local/bin/claude.exe", "-p", "--continue",
  "--permission-mode", "bypassPermissions"
]
```

`--continue` 接的是**當前目錄**最近那個對話，而 harness 永遠站在專案目錄——
目錄本身就是 session key，不必存 session id。

第一輪一定用 `command`（那時候還沒有 session 可以接，硬接會整輪失敗）。
「這個專案跑過了沒」不用猜，記在對照表裡；接續失敗（session 過期、被刪掉）就把
記號拿掉，下一輪從乾淨的開始，並在回報裡說一句——不然每一輪都會撞同一面牆。

**而且它不會無限接續下去。** harness 把 `viewed` 往前推的那一輪，session 就到此為止：
推書籤代表這一段結案了、來龍去脈已經寫進 repo、逐字稿也翻頁了，那正是丟掉累積
context 最誠實的分界線。下一輪 `/tap` 從乾淨的開始，回報裡會說一句。

**接續是加速器，不是真相來源。** repo 該寫的還是要寫：session 會過期，repo 不會。

### 哪個專案對應哪個房間

一個房間一筆，記在 `projectsFile`（預設 `~/.openclaw/chat-interceptor-projects.json`）。
`/tap <projname>` 寫它，`/tap` 讀它，`/tap -uninstall` 清掉它。

為什麼不是直接掃 `.tap`：同一個房間先後開過兩個專案時，兩份 `.tap` 都還在，掃描
就再也分不出你要哪一個——而那正是「重測一次」最常見的現場。表沒有這個問題，
**最後一次指名的那個專案就是答案**，舊專案的檔案原地不動也不會來搗亂。

`.tap` 不會因此變成裝飾品：它仍然是「這個專案在哪個房間上線」的記載，也仍然是
skill 讀的那一份。表只回答一個掃描答不了的問題——同一個房間現在算哪一個專案的。

表裡沒有那一筆時（例如手工建的專案）會退回掃描，掃到唯一一個就順手記進表。
反過來，表裡有、但目錄已經不見了，就直接說「你記的那個專案不見了」——把專案搬走
或改名往往就是要讓它消失，那就照做，不要自作聰明重新掃一個出來頂替。

要開這個功能，設定裡加一段 `tap`：

```json
"tap": {
  "projectsDir": "D:/projects",
  "command": ["C:/Users/you/.local/bin/claude.exe", "-p", "--permission-mode", "bypassPermissions"],
  "notifyCommand": [
    "C:/Program Files/nodejs/node.exe",
    "C:/Users/you/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs",
    "message",
    "send"
  ],
  "allowFrom": ["123456789"]
}
```

| 欄位 | 必要 | 說明 |
|---|---|---|
| `projectsDir` | ✓ | 一個專案一個子目錄 |
| `projectsFile` | | 房間 → 專案的對照表，預設 `~/.openclaw/chat-interceptor-projects.json`。帶著 chat id，所以放 state 目錄不放專案裡 |
| `autoInstall` | | harness 跑完就把那個專案裝成 route。預設 `true`；設 `false` 就改成自己打 `/tap -install` |
| `command` | | harness 的 argv。`prompt` 接在最後，工作目錄設成專案目錄。預設 `["claude", "-p", "--permission-mode", "bypassPermissions"]` |
| `continueCommand` | | 這個專案跑過之後改用這組 argv，讓 harness 接續同一個 session（`claude` 就是加 `--continue`）。省略＝每一輪都從乾淨的開始 |
| `prompt` | | 要它做什麼。預設是請它施展**它自己的** `/tap` 技能，外加一段它自己無從得知的執行條件：這一輪沒有人能回答它，所以不要停在提問就結束；它的結論會原樣交到使用者手上 |
| `notifyCommand` | | 回報用的 argv，後面會接上 `--channel <c> --target <t> --message <text>`。預設 `["openclaw", "message", "send"]` |
| `env` | | harness 的額外環境變數 |
| `timeoutMs` | | 預設 `1800000`（30 分鐘） |
| `allowFrom` | | 允許下這個指令的 sender id。**省略＝房間裡的人都可以** |

`command`、`continueCommand` 與 `notifyCommand` 一律寫**絕對路徑**——gateway 是服務
啟動的，PATH 跟 shell 不一樣。（route 那一側就不必了，見上面的「一條 route 最少長這樣」。）

> **`/tap` 會在這台機器上叫起一個能改檔案的 agent，`/tap -install` 還會改到 gateway
> 自己的設定。** 房間裡的每個人都打得出這幾行，所以不是自己完全掌握的房間，
> 一定要設 `allowFrom`——它同時管住這五個指令。

被叫起的 harness **不知道自己是被誰叫起的**——它就是站在專案目錄裡施展 `/tap`，
跟人從終端機叫它做的是同一件事。

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
