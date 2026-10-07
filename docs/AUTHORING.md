# 寫一支 chat-interceptor script

給要寫攔截 script 的人或 AI。plugin 已經裝好；安裝與設定見 [README](../README.md)。

## 1. 協定

使用者在房間裡打一句話，OpenClaw 在呼叫模型**之前**先跑你的 script：

| | |
|---|---|
| stdin | 一個 JSON 物件（見下） |
| stdout | 回給使用者的純文字，原樣送出；**空的 = 處理掉但不回話** |
| exit `0` | 處理好了，模型完全不會被呼叫（0 token） |
| exit `20` | 我不會，這一輪照原本的流程交給 AI |
| 其他 | 出錯：stderr 當成錯誤訊息回給使用者 |

```json
{
  "body": "status server-1",
  "channel": "telegram",
  "target": "-1001234567890",
  "senderId": "11111111",
  "sessionKey": "agent:my-agent:telegram:group:-1001234567890",
  "agentId": "my-agent",
  "send": ["…"]
}
```

- `body` 是使用者**原樣**的輸入，沒有任何清理。全形半形、空白、標點都由你決定怎麼處理。
- 除了 `body` 與 `send` 以外都可能是空字串。
- `send` 是再送訊息用的，見第 7 節。
- `/` 開頭的訊息（斜線指令）永遠不會送到你手上，不要拿 `/` 開頭的字當觸發詞。
- stdout 只放給使用者看的字。debug、進度、警告一律寫 stderr。

## 2. 放在哪裡

一個專案就是一個 OpenClaw skill：

```
<skill>/
├── SKILL.md                 教 AI 處理 script 放行（exit 20）的那些輸入
└── scripts/intercept.mjs    攔截 script（也可以是 .js、.cjs、.py）
```

- `.mjs`/`.js`/`.cjs` 用 gateway 自己的 node 跑；`.py` 用 `uv run` 跑。
- Python 的依賴寫在檔案開頭的 [PEP 723](https://peps.python.org/pep-0723/) 區塊，不要假設環境裡裝了什麼。
- `/fiat -install` 會把整個 skill 複製進房間的 agent。不必寫任何設定。
- script 沒處理的輸入會交給 AI，AI 讀的是 `SKILL.md`。兩邊的行為要一致：script 吃掉的，`SKILL.md` 不必再教。

## 3. 範本

Node：

```js
let raw = "";
for await (const chunk of process.stdin) raw += chunk;
const { body = "" } = JSON.parse(raw.replace(/^﻿/, "").trim() || "{}");

const m = /^status\s+(\S+)$/.exec(body.trim());
if (!m) process.exit(20); // 我不會，交給 AI

process.stdout.write(`${m[1]}: OK`);
```

Python：

```python
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
import json, re, sys

sys.stdout.reconfigure(encoding="utf-8")  # Windows 主控台預設不是 UTF-8

body = str(json.loads(sys.stdin.read().lstrip("﻿").strip() or "{}").get("body") or "")
m = re.match(r"^status\s+(\S+)$", body.strip())
if not m:
    sys.exit(20)  # 我不會，交給 AI
sys.stdout.write(f"{m.group(1)}: OK")
```

## 4. 鐵則：有副作用就不准 exit 20

寫了資料、發了通知、改了檔案之後才 exit 20，AI 會拿同一句話**再做一次**。

- 順序永遠是：**全部判斷完 → 才動手**。判斷不了就在動手前 exit 20。
- 動手之後出錯，exit 非 0（錯誤訊息會回給使用者），不要 exit 20。

## 5. 怎麼切分

- **先吃最高頻、格式最固定的幾條**，其餘全部 exit 20。行為不會退步，那幾條變成 0 token。
- 一條規則需不需要「理解」？格式固定、參數看得出來的 → script；要語意判斷或世界知識的 → AI。
  「下週二」是日曆計算不是推論，寫得出來就自己做。
- 正則要嚴。寧可 exit 20 讓 AI 處理，也不要誤判成某條指令做錯事。

## 6. 中途需要模型判斷一小段

整個流程只有一步需要語意（例如「這筆帳歸哪個分類」）時，在 script 裡直接問：

```bash
openclaw infer model run --gateway --json --prompt "<很窄的問題>"
# → { "ok": true, "outputs": [{ "text": "保健費" }] }
```

- 一定要 `--gateway`（快得多），不要指定 `--model`（吃設定裡的預設與備援）。
- **問之前不能有副作用**；一則訊息只問一次；答案限定在封閉集合裡，不在集合裡就 exit 20。
- 問不到、逾時、失敗，一律 exit 20。
- 問過的答案自己記起來，下次直接命中。
- route 的 timeout 預設 60 秒，一次模型呼叫約 10 秒。

## 7. 按鈕、圖片、多則訊息

stdout 只能是一則純文字。要更多就用 stdin 給的 `send` 自己送：它是一串 argv，後面接
`openclaw message send` 的選項（`--message`、`--presentation`、`--media`…），房間已經指定好了。
**送完 stdout 留空**再 exit 0，否則使用者會多收到一則。

```js
import { execFileSync } from "node:child_process";
const [command, ...args] = payload.send;
execFileSync(command, [...args, "--message", "要哪一筆？", "--presentation", JSON.stringify({ buttons: [{ text: "#18 七月水費", value: "18" }] })]);
execFileSync(command, [...args, "--media", "./chart.png"]);
```

```python
subprocess.run([*payload["send"], "--message", "要哪一筆？"], check=True)
```

不要直接呼叫 `openclaw message send`：用 `send` 送的，房間裡其他機器人才不會接話。

## 8. 陷阱

- **每次都是全新的 process**，沒有記憶。跨訊息的狀態用 `sessionKey` 當 key 自己寫檔。
- **被你 exit 0 的那一輪不進 AI 的 session。** 使用者之後問 AI「我剛剛記了什麼」，AI 不知道。你的資料檔才是真相。
- **同一個房間一次只跑一支**，後面的訊息會排隊等你。
- **逾時會被砍**（預設 60 秒），寫到一半的檔案自己負責。
- **不要依賴 cwd 與 PATH。** 外部程式用絕對路徑。Windows 上 `openclaw` 要用 node 直接跑 `openclaw.mjs`，不要走 `.cmd`。
- **stdin 可能有 BOM**（PowerShell 手動測試時），要剝掉。

## 9. 測試

```bash
printf '{"body":"status server-1"}' | node scripts/intercept.mjs; echo "exit=$?"
```

命中（exit 0）、不命中（exit 20）、出錯（其他）三條路都要各測一次，還有空字串、超長輸入、
貼一大段文字。上線之後打開 `debug`，`~/.openclaw/logs/chat-interceptor.log` 會記下每一輪命中與否。

AI model used: Claude Opus 5.5
