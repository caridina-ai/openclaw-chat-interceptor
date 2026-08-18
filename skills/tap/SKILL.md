---
name: tap
description: 汲取某個聊天室在 openclaw-chat-interceptor 底下的實際使用過程——使用者打過的每一句話（含被 script 攔掉、根本沒進 session 的那些）、每一句的下場（攔到／放行給 AI／出錯），以及使用者隨手打的 ISSUE——然後據此把那個房間的 script 改得更好用。當使用者說「tap 一下我的某某頻道」「看看有哪些輸入沒被攔截到」「檢討一下上線之後的使用狀況」「使用者抱怨了什麼」時使用。
---

# tap

[openclaw-chat-interceptor](https://github.com/caridina-ai/openclaw-chat-interceptor)
會在 OpenClaw 呼叫模型之前，先把訊息交給該聊天室的 script。script 處理得了就直接回覆，
**那一輪 0 token，也不會進 session 歷史**；處理不了才交還給 AI。

省 token 的代價是：**被攔掉的輸入事後沒人看得到**。而檢討時最需要知道的偏偏就是
「哪些話 script 還接不住」。這個 skill 把那些話撈回來。

## 什麼時候用

使用者說「tap 一下」「檢討一下這個頻道」「有哪些輸入沒被攔到」「我抱怨過什麼」時。
目的**不是**產出一份報告——是**改那支 script**。汲取只是手段。

## 一、先確認 `.tap`

每個吃這個 plugin 的專案，用一個 `.tap` 記住自己的頻道在哪裡。放在 repo 根目錄或
`genesis/` 底下都行，工具會自己找。**只有三個欄位**：

```
channel: telegram
target:  -1001234567890
viewed:  2026-08-18 20:43:20
```

| 欄位 | 說明 |
|---|---|
| `channel` | `telegram`、`discord`… |
| `target` | 對話 id，寫法同 `openclaw message send --target`（裸 id、`channel:<id>`、`discord:channel:<id>` 都認得） |
| `viewed` | 上一輪檢討看到哪裡為止。**留空或整行不寫＝看全部** |

沒有 `.tap` 就先建一個。使用者不知道 target 是什麼的話，從攔截器的 log 撈：
`~/.openclaw/logs/chat-interceptor.log` 每一行 `turn` 都帶著 `channel` 與 `target`。

> **`.tap` 絕不進版控。** 頻道位置是敏感資訊——有心的人跑來那個頻道，
> 就能利用機器人的漏洞騙東西。建好之後確認 `.gitignore` 有擋著。

## 二、跑

`tap.mjs` 就在這份 SKILL.md 旁邊（Node 18+，不必安裝任何套件）：

```bash
node <這個 skill 的目錄>/tap.mjs --tap genesis/.tap
```

在專案根目錄執行時，`--tap` 可以省略（自己找 `./.tap`、`./genesis/.tap`）。

| 參數 | 說明 |
|---|---|
| `--tap <file>` | 維護現場檔 |
| `--channel` / `--target` | 不用 `.tap`，直接指定房間 |
| `--since <stamp>` | 這一次要從哪裡看起，蓋過 `viewed`；`--since 0` 看全部 |
| `--tail <n>` | 逐字稿只列最後 n 則（預設 400，`0` 表示全部） |
| `--format json` | 給程式吃的版本 |
| `--log <file>` | 攔截器 trace log，預設 `~/.openclaw/logs/chat-interceptor.log` |
| `--issues <file>` | ISSUE log，預設 `~/.openclaw/logs/chat-interceptor-issues.log` |

第一次 tap 一個老頻道時輸出會很長。先跑一次看摘要，再用 `--since` 分段讀。

## 三、報告怎麼讀

由上而下就是優先順序：

1. **ISSUE** —— 使用者在使用當下自己打的 `ISSUE ＿＿`。plugin 直接吃掉：不叫 AI、
   不給 script、不回話，所以它只存在於 issue log 裡。**這是使用者親口說的待辦，
   比你我的任何推測都準，先看這個。**
2. **放行給 AI 的輸入** —— script 說「我不會」（exit 20）的那些，依相同輸入分群。
   **同一句話講愈多次，就愈值得寫成規則**：那是下一條規則最直接的原料。
3. **出錯** —— 使用者收到的是錯誤訊息而不是答案。優先修。
4. **逐字稿** —— 全部合併還原的對話，每一則底下標著它當時的下場。
   要看使用者「講了什麼之後又補一句」「機器人回錯了他怎麼反應」就讀這裡。
5. **涵蓋範圍** —— 這份汲取完不完整。`missingIds` 有東西代表有幾則真的撈不回來
   （session 輪替或 context 裁切吃掉了）；`interceptLog: null` 代表 route 沒開
   `debug`，所以**不知道每一則的下場**，只有逐字稿。

## 四、然後去改 script

這才是重點。讀完之後：

- 高頻又格式固定的「放行」輸入 → 在那支 script 裡加規則吃下來，變成 0 token。
- 使用者抱怨的 → 照他說的改。他講的是他實際遇到的事，不要替他重新詮釋。
- 出錯的 → 先修。
- 分不清是「該寫新規則」還是「刻意放手」時，回頭看逐字稿裡那句話的上下文。

**動手前先讀那支 script 所屬專案的文件**，以及 plugin 的
[`docs/AUTHORING.md`](https://github.com/caridina-ai/openclaw-chat-interceptor/blob/main/docs/AUTHORING.md)。
其中一條鐵則值得在這裡重複：

> **有副作用的動作，一旦做了就絕對不可以 exit 20。**
> AI 會拿到同一句話再做一次——重複入帳、重複發通知。先判斷，再動手。

改完要跑那個專案自己的測試，並且記得 script 是部署過去的那一份才算數
（很多專案 repo 與部署位置是兩個地方）。

## 五、收尾：把 `viewed` 推到當下

報告最後一行會給你新的 `viewed:`。**改完程式之後**才寫回 `.tap`：

```
viewed: 2026-08-18 20:43:20
```

`viewed` 是**接力棒，不是紀念碑**——推了，下次 tap 就只給你新的東西。
還沒處理完就先別推。

## 疑難排解

| 症狀 | 原因 |
|---|---|
| 有逐字稿，但每一則都沒有「下場」 | route 沒開 `debug`。在 plugin 設定加 `"debug": true`，之後才會有 trace log |
| 一則都汲取不到 | `channel`／`target` 打錯，或 OpenClaw 的狀態目錄不在預設位置（設 `OPENCLAW_STATE_DIR`） |
| ISSUE 是空的，但使用者說他打過 | 舊版 skill 可能是自己寫 issue log 的，用 `--issues <那個檔>` 指過去 |
| 逐字稿比實際短很多 | 正常。session 輪替與 context 裁切會吃掉一部分，看「涵蓋範圍」的 `missingIds` |
