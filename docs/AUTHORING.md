# 寫一支 chat-interceptor script

**這份文件是給「要寫 script」的人看的**，不管你是人還是 AI。假設 plugin 已經裝好了，
你不需要知道它怎麼安裝、怎麼設定 gateway——那些在 [README](../README.md)，
底層機制在 [DESIGN.md](DESIGN.md)。

你要做的事只有一件：**寫一支讀 stdin、印 stdout、用 exit code 表態的程式**。

---

## 1. 你的 script 站在哪裡

使用者在聊天室打一句話 → OpenClaw 在呼叫模型**之前**先問你的 script：

```
使用者訊息
   ↓
你的 script（stdin 收 JSON）
   ├─ exit 0  → 你的 stdout 直接變成回覆，模型完全沒被呼叫  ← 0 token
   ├─ exit 20 → 「我不會」，照原本的流程交給 AI            ← 正常花 token
   └─ 其他    → 出錯
```

這就是全部。省 token 的關鍵是：**你 exit 0 的比例愈高，愈省**。

一個重要的副作用要先知道：**exit 0 的那一輪不會進 session 歷史**。
使用者之後問 AI「我剛剛記了什麼」，AI 不知道。你的資料檔才是唯一真相。

---

## 2. 協定

### stdin：一個 JSON 物件

```json
{
  "body": "status server-1",
  "channel": "telegram",
  "target": "-1001234567890",
  "senderId": "11111111",
  "sessionKey": "agent:my-agent:telegram:group:-1001234567890",
  "agentId": "my-agent"
}
```

| 欄位 | 說明 |
|---|---|
| `body` | **使用者原樣的輸入**。plugin 不做任何 normalize——全形轉半形、空白收斂、去標點都是領域決定，你自己做 |
| `channel` | `telegram`、`discord`… |
| `target` | 對話 id（已剝掉 prefix 的裸 id） |
| `senderId` | 發話者 id，可能是空字串 |
| `sessionKey` | 這個對話的 session key，適合當狀態檔的 key |
| `agentId` | 這個房間綁定的 agent |

除了 `body` 以外都可能是空字串，不要假設一定有值。

### stdout：使用者會看到的字

原樣送出，不做 markdown 處理也不加工。**空的 stdout = 處理掉了但不回話**
（OpenClaw 會補靜默 token，使用者端什麼都不會收到）。

**stdout 只能放要給使用者看的內容。** debug、進度、警告一律走 stderr——
stderr 只有在你非 0 離開時才會被人看到。

### exit code

| code | 意思 | plugin 的動作 |
|---|---|---|
| `0` | 我處理好了 | stdout 變成回覆，**模型完全不會被呼叫** |
| `20` | 我不會，請交給 AI | 這一輪照原本流程走，你什麼都沒發生過 |
| 其他 | 出錯了 | 依 route 的 `onError`：`handle`（預設）把 stderr 當錯誤訊息回給使用者，`passthrough` 交給 AI |

### 有一種訊息永遠不會到你手上

`ISSUE` 開頭的訊息（大小寫不拘）由 plugin 直接吃掉：那是使用者在記
「這個房間用起來哪裡不順」，不是給你的指令。

所以**不要自己實作 `ISSUE`**，也不必在你的規則表裡幫它留位置——你根本收不到。
使用者記下的那些，之後用 `/tap` 讀出來（見第 12 節）。

---

## 3. 最小可用的 script

### Node

```js
#!/usr/bin/env node
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
raw = raw.replace(/^\uFEFF/, "").trim();          // PowerShell 手動測試時會加 BOM

const { body = "" } = JSON.parse(raw || "{}");

const m = /^status\s+(\S+)$/.exec(body.trim());
if (!m) process.exit(20);                          // 我不會，交給 AI

process.stdout.write(`${m[1]}: OK`);
```

### Python（PEP 723，用 `uv run` 執行，機器上不必先裝 Python）

```python
#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.9"
# dependencies = []
# ///
import json, re, sys

try:
    sys.stdout.reconfigure(encoding="utf-8")       # Windows 主控台預設 cp950
except Exception:
    pass

raw = sys.stdin.read().lstrip("\ufeff").strip()
body = str(json.loads(raw or "{}").get("body") or "")

m = re.match(r"^status\s+(\S+)$", body.strip())
if not m:
    sys.exit(20)                                   # 我不會，交給 AI

sys.stdout.write(f"{m.group(1)}: OK")
```

---

## 4. 三種形態：先確認你屬於哪一種

script 跟 AI 的分工有三種典型比例。**先認出你要做的是哪一種**，
再往下讀對應的章節。

| 形態 | 特徵 | 該讀哪裡 |
|---|---|---|
| **全包** | 永遠 exit 0，AI 完全不會出場 | 下面一小節就夠了 |
| **部分包**（最常見） | 認得的直接做，其餘 exit 20 交還 AI | 第 6 節 |
| **要多做一步** | 中途要模型判斷、要按鈕、要圖片或多則訊息 | **第 8、9 節** |

### 全包：整個房間都歸這支 script

一個房間只提供一種服務、輸入輸出都固定，就永遠 exit 0。適合工具型、
機械型的房間：狀態查詢、開關控制、格式轉換。

```js
// 沒有 exit 20，所以這個房間一次都不會用到模型
process.stdout.write(`You said ${body}`);
```

代價是**那個房間沒有 AI 了**。使用者問任何超出範圍的話，也只會得到你 script
的制式回應。plugin 若被停用，訊息會 fallback 回預設 agent。

### 部分包：吃掉高頻的，其餘交還

**這是大多數人的選擇**，第 6 節整節在講怎麼做。

關鍵是那個 exit 20：它讓你可以「只吃一條指令」就上線，
沒吃到的照原本的 AI 流程走，**行為不會退步**。你可以從一條開始，慢慢往上加。

```python
m = COMMAND_PATTERN.match(body)
if not m:
    sys.exit(EXIT_PASS)      # ← 沒有這行，就變成「全包」了
sys.stdout.write(do_the_thing(m.group(1)))
```

### 要多做一步

流程中間需要模型判斷語意（第 8 節），或者回覆需要按鈕、圖片、多則訊息
（第 9 節）——這兩件事 script 都做得到，只是要多呼叫一次 `openclaw`。
先照「部分包」把確定性的吃掉，再回頭讀那兩節把剩下的補上。

---

## 5. 你要交給安裝者的設定

你的 script 寫完後，安裝者要在他的 `openclaw.json` 加一個 route。
**你在文件裡附上這一段就好**，其餘他自己會處理：

```json
{
  "name": "my-skill",
  "channel": "telegram",
  "target": "<安裝者自己的聊天室 id>",
  "command": ["C:/Users/xxx/.local/bin/uv.exe", "run", "D:/path/to/my-script.py"],
  "cwd": "D:/path/to",
  "env": { "MY_SKILL_HOME": "D:/data/my-skill" },
  "timeoutMs": 15000,
  "onError": "handle"
}
```

| 欄位 | 你該說什麼 |
|---|---|
| `command` | **一律用絕對路徑。** gateway 是系統服務啟動的，PATH 跟使用者的 shell 不一樣，`node`、`uv`、`python` 都可能找不到 |
| `cwd` | 你的 script 如果需要相對路徑，就要求設這個；**更好的做法是根本不依賴 cwd** |
| `env` | 外部工具在哪裡用 env 傳，不要寫死在 script 裡。**但資料路徑要小心**，見下 |
| `timeoutMs` | 預設 15000。你的 script 會慢（例如巢狀呼叫別的程式）就講明要調大 |
| `onError` | **有副作用就用 `handle`（預設）**；純查詢、無副作用才可以用 `passthrough` |

### route 的 `env` 只給你的 script，AI 看不到

plugin 是用 `{ ...process.env, ...route.env }` spawn 你的 script。
AI 那一側（exit 20 之後 agent 自己跑指令）繼承的是 **gateway 的環境**，
拿不到 route env。

所以如果你的 skill 是「script 和 AI 共用同一份資料」的形態，
**資料路徑千萬不要做成 route env 的設定項**——安裝者只改 route 那一側，
就會變成 script 寫一份、AI 寫另一份，而且兩邊都不會報錯。

要嘛把資料路徑寫死（少一個旋鈕就少一種分裂方式），要嘛要求安裝者設在
gateway 也看得到的地方，並講明**那需要 `openclaw gateway restart`**
才會生效（環境變數只在服務啟動時讀一次；相對地，改 `openclaw.json` 的
plugin config 是熱重載，不必重啟）。

---

## 6. 怎麼把現有的 skill 改寫過來

這是這份文件的重點。原本的 skill 是「SKILL.md 教 AI 怎麼呼叫 script」，
改寫的目標是「**script 自己認得使用者的話**，AI 只在真的需要推論時才出場」。

### 步驟一：把 SKILL.md 的每一條指令分成兩堆

拿出 SKILL.md 的路由表，逐條問：**這一條需要「理解」嗎？**

| | 例子 | 歸類 |
|---|---|---|
| 格式固定、參數看得出來 | `status server-1`、`餘額多少`、`本月報表` | **確定性** → script 直接做 |
| 需要語意判斷或世界知識 | `午餐 120`（要歸到哪個分類？）、`下週二`（是幾號？） | **需要推論** → 先 exit 20 |

實務上「需要推論」的那堆還可以再切：
「下週二 → 日期」其實是**日曆計算**，不是推論，寫得出來就自己做；
「把某個沒看過的詞歸到某個分類」才是真的需要語意。

### 步驟二：先把確定性的那堆做掉，其餘全部 exit 20

**不要一開始就想吃下全部。** 先讓最高頻、最確定的幾條命中，其餘 exit 20 交還 AI——
行為完全不變（AI 照舊處理），只是那幾條變成 0 token。這是可以隨時上線的安全狀態。

### 步驟三：量測，再決定下一條要吃什麼

打開 route 的 `debug`，`~/.openclaw/logs/chat-interceptor.log` 會記下每一輪
命中或沒命中。跑幾天，看沒命中的裡面哪一種最常出現，就寫下一條。

不必自己翻 log——`/tap`（第 12 節）會把「放行給 AI 的輸入」依相同輸入分群列出來，
**同一句話講愈多次，就愈值得寫成規則**。

### 步驟四：SKILL.md 留下來，但只寫「script 不處理的部分」

script 吃掉的那些，SKILL.md 就不用再教 AI 怎麼做了——但**不要整份刪掉**。
AI 仍然要處理 exit 20 的那些輸入，SKILL.md 還是它的說明書。
兩邊的行為必須一致，改 script 時記得同步改 SKILL.md。

### 一個必須守住的鐵則

> **有副作用的動作，一旦做了就絕對不可以 exit 20。**

如果你的 script 已經寫了資料庫、發了通知、改了檔案，然後才決定「這個我不會」，
AI 會拿到同一句話**再做一次**——重複入帳、重複發通知。

正確做法是：**先判斷，再動手**。判斷不了就在動手前 exit 20；
已經動手了就算後面出錯，也要 exit 非 0（讓 `onError: handle` 把錯誤回給使用者），
永遠不要 exit 20。

---

## 7. 陷阱

**每次呼叫都是全新的 process。** 沒有記憶體、沒有 session 狀態。要記東西就自己寫檔，
用 `sessionKey` 當 key。

**同一個 route 一次只跑一支。** plugin 會排隊，所以你不必自己處理並行寫檔；
但也代表你的 script 慢，後面的訊息就會等。

**逾時會被砍。** 超過 `timeoutMs` 直接 kill，寫到一半的檔案自己負責。

**編碼。** Windows 上 Python 要 `sys.stdout.reconfigure(encoding="utf-8")`，
否則中文會炸。stdin 前面可能有 BOM（PowerShell 手動測試時），記得剝掉。

**不要依賴 cwd 和 PATH。** 資料路徑用 env 傳，外部工具用絕對路徑。

**stdout 是給使用者的，不是給你 debug 的。** 印錯東西使用者就會看到。

**`body` 沒有被清理過。** 使用者可能貼一大段、可能有 emoji、可能是空字串。
你的正則要夠嚴——寧可 exit 20 讓 AI 處理，也不要誤判成某條指令然後做錯事。

---

## 8. 中途需要模型判斷的那一小段

很多流程只有**一個**環節需要語意判斷，其餘都是確定性的。
「午餐 120 要歸到哪個科目」就是典型：金額、日期、寫入都不必模型，
只有分類需要。這種流程整條交給 AI，等於整輪的 token 都白花了。

這種時候**在 script 裡直接問模型**：用一個很窄的問題換一個很短的答案，
成本遠低於一整輪帶著 skill、記憶與 tool 的 agent turn。

### 用 `openclaw infer model run`

```bash
openclaw infer model run --gateway --json --prompt "<很窄的問題>"
```

```json
{ "ok": true, "provider": "openai", "model": "gpt-5.6-terra",
  "outputs": [{ "text": "保健費" }] }
```

兩個參數的選擇都是有原因的，**照抄就好**：

- **不要指定 `--model`。** 不指定時吃的是設定裡 `agents.defaults.model` 的
  `primary` + `fallbacks`，primary 掛掉會自動換備援——跟 agent turn 享受
  同一套 model routing。自己去打 provider API 或寫死 `--model` 就沒有這層
  保護，使用者換模型、加備援時你也不會跟著改。
- **一定要 `--gateway`。** 本機模式要自行初始化 provider，實測約 30 秒；
  走已經開著的 gateway 約 9 秒。route 的 `timeoutMs` 記得放寬（建議 60000）。

執行檔用絕對路徑，而且**繞過 `.cmd`／`.ps1` 包裝直接跑 `.mjs`**，
免得在 Windows 上被 shell quoting 咬到：

```json
"env": {
  "OPENCLAW_NODE": "C:/Program Files/nodejs/node.exe",
  "OPENCLAW_MJS": "C:/Users/you/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs"
}
```

### 四條規則

1. **問之前不能有副作用。** 模型可能超時、可能亂答，那時你要能乾淨地
   exit 20。所以順序永遠是：全部解析完 → 問完模型 → 才開始寫。
2. **一則訊息只問一次。** 三個未知品項就把三個一起問，別問三次——
   9 秒 × 3 會直接撞上 timeout。
3. **答案要驗證。** 限定模型只能從一個封閉集合裡選，回來的東西不在集合裡
   就當作失敗 exit 20。**寧可多花 token，也不要寫錯資料。**
4. **沒設定就降級。** `OPENCLAW_MJS` 沒給、指令失敗、超時，一律 exit 20
   交給 AI。功能退回原狀，不能壞。

### 問完要記起來

問過的答案寫進你自己的資料檔，下次直接命中就不用再問。實測一本記帳的
帳本，78 筆帳只有 39 個相異品項——**43.5% 的寫入是重複的**，
用久了模型呼叫會收斂到「這輩子第一次買的東西」。
使用者明講答案時（`維他命飲67 外食費`）更要記下來，那是免費且最可靠的
訓練資料。

參考實作：[openclaw-bookkeeper](https://github.com/caridina-ai/openclaw-bookkeeper)
的 `intercept.py`（`classify()` 與 `resolve_entries()`）。

---

## 9. 回覆不只一則純文字：按鈕、圖片、多則訊息

`stdout` 只會變成一則純文字。要按鈕、圖片、一次多則、或就地更新先前那則，
**用 `openclaw message` 自己送**，跟第 8 節同一個手法：

```bash
openclaw message send --channel telegram --target <chatId> \
  --message "找到 3 筆，你要哪一筆？" \
  --presentation '{"buttons":[{"text":"#18 七月水費 230","value":"18"},
                              {"text":"#9 六月水電 410","value":"9"}]}'

openclaw message send --channel telegram --target <chatId> --media ./chart.png
openclaw message edit --channel telegram --target <chatId> --message-id <id> -m "已完成"
```

`--presentation` 吃 `text`／`context`／`dividers`／`buttons`／`selects`；
每個 button 是 `{ "text": ..., "value": ... }`（另可加 `style`）。
還有 `--media`、`--reply-to`、`--pin`、`--silent`、`--thread-id`。
`channel` 和 `target` 直接用 stdin 拿到的那兩個欄位，不必自己拼。

跟第 8 節一樣，執行檔用絕對路徑直接跑 `.mjs`，不要走 `.cmd` 包裝。

### 送完要用空的 stdout 收尾

自己送了訊息之後，**stdout 一定要留空**再 exit 0，否則使用者會多收到一則。
空 stdout 的意思是「處理掉了但不回話」，OpenClaw 會補靜默 token。

```python
send_the_fancy_reply(...)     # 自己送
sys.exit(0)                   # stdout 什麼都沒印
```

一則文字就夠的時候，還是印 stdout 最省事——少一次 CLI 呼叫。

### 來回兩輪的流程要自己記狀態

「我找到三筆，你要哪一筆？」第二輪你只會收到一句「第二筆」，
不會知道上一輪發生過什麼（第 7 節：每次都是全新的 process）。
用 `sessionKey` 當 key 寫一個狀態檔，並自己處理過期。

按鈕的 `value` 按下去之後怎麼回到你手上，各 channel 不一樣，
**用之前先自己確認一次**（開 `debug` 看 `chat-interceptor.log` 那一輪的 `body`）。
確認得到就能少記一半狀態；確認不到就老實寫狀態檔。

### 還是有值得放給 AI 的

介面複雜、每次長得都不一樣、或本來就需要來回商量的流程，
直接 exit 20 交給 AI 仍然是對的選擇。**不要為了硬吃下來而用純文字模擬
按鈕介面**——那會讓使用者體驗變差，省下的 token 不值得。

---

## 10. 怎麼測

**先單獨測 script**，不要一開始就進聊天室：

```bash
# bash：乾淨的 UTF-8
printf '{"body":"status server-1"}' | uv run my-script.py; echo "exit=$?"
```

```powershell
# PowerShell：注意它會加 BOM，這正好順便測到你的 BOM 容錯
'{"body":"status server-1"}' | & "C:\path\to\uv.exe" run my-script.py; "exit=$LASTEXITCODE"
```

三件事一定要各測一次：**命中（exit 0）**、**不命中（exit 20）**、**出錯（其他）**。

然後才進聊天室，開 `debug` 看 `~/.openclaw/logs/chat-interceptor.log`：

```
turn    {"body":"status server-1", ..., "route":"my-skill"}
handled {"route":"my-skill","stdout":"server-1: OK"}
```

`pass: script declined` 就是 exit 20，`error` 就是出錯。

---

## 11. 交出去之前

- [ ] 命中、exit 20、出錯三條路都測過
- [ ] 有副作用的動作，確定不可能走到 exit 20
- [ ] stdout 只有給使用者看的內容，debug 都在 stderr
- [ ] 沒有依賴 cwd 或 PATH，資料路徑用 env
- [ ] 中文輸出在 Windows 上正常
- [ ] stdin 有沒有 BOM 都能跑
- [ ] 空字串、超長輸入、貼一大段文字都不會誤判成某條指令
- [ ] 附上一段可以直接貼進 `openclaw.json` 的 route 設定範例
- [ ] SKILL.md 跟 script 的行為一致（script 沒吃的部分 AI 才看得懂怎麼做）
- [ ] 有問模型的話：問之前沒有副作用、答案有驗證、失敗會降級成 exit 20
- [ ] 有自己送訊息的話：stdout 留空，使用者不會收到重複的一則

---

## 12. 上線之後：用 `/tap` 檢討

你的 script 上線之後，最想知道的是「還有哪些話我接不住」。但**被你 exit 0 吃掉的
那些輸入不會進 session**，事後翻不到；使用者的抱怨更是散在對話裡。

`/tap` 是這個 plugin 附的 Agent Skill，裝進 Claude Code 這類 harness：

```bash
npx skills add caridina-ai/openclaw-chat-interceptor
```

然後在你的 script 專案裡叫它「tap 一下這個頻道」。它會給你：

- **放行給 AI 的輸入**，依相同輸入分群——這就是下一條規則要寫什麼的原料
- **出錯的那幾輪**——使用者收到的是錯誤訊息而不是答案，優先修
- **使用者打的 `ISSUE`**——他親口說的待辦，比任何推測都準
- 完整逐字稿，每一則底下標著它當時的下場

前提是兩件事：route 的 `debug` 要開（沒開就只有逐字稿，不知道每一則的下場），
以及你的專案裡要有一個 `.tap` 記著房間位置（`channel` / `target` / `viewed`
三個欄位，**不進版控**）。細節見
[`skills/tap/SKILL.md`](../skills/tap/SKILL.md)。

---

AI model used: Claude Opus 5.0
