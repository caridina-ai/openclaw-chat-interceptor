---
name: tap
description: 把 OpenClaw 聊天室裡聊出來的東西做成軟體。`/tap [yyyy-mm-dd HH:MM]` 汲取房間的對話（含被 script 攔掉、AI 沒看到的那些，以及 /aside），寫成 FIAT 文件；收到 go 照 FIAT 文件實作；`/tap -done` 驗收通過後 commit 並寫交接 memory。通常由 OpenClaw 的 /fiat 叫起。
argument-hint: "[yyyy-mm-dd HH:MM] | -done"
---

# tap

三種叫法，各是一段工作。每一段的最後一步都是在專案根目錄呼叫回報程式，然後停下來：

```bash
node <這份 SKILL.md 所在的目錄>/report.mjs <fiat|built|done> "<給主述者的一段話>"
```

主述者可能會在這個 session 裡跟妳討論。談定的修改要寫回 FIAT 文件——下一輪汲取看不到這裡的對話。

## `/tap [yyyy-mm-dd HH:MM]`

1. **新專案還是舊專案**：專案目錄裡除了 `genesis/` 之外沒有程式，就是新專案；已經有程式，就是維護舊專案。

2. **汲取**：

   ```bash
   node <這份 SKILL.md 所在的目錄>/tap.mjs [--since "yyyy-mm-dd HH:MM"]
   ```

   - 房間讀 `genesis/.tap`（`channel` / `target` / `timestamp`）。`timestamp` 是上一輪結束的時間，汲取從那裡開始；空的就是從頭。
   - `/tap` 後面帶了時間，就用 `--since` 把起點改成那個時間。
   - 輸出依序是：`/aside`（房間裡特地留下、誰都不處理的話，整段列出；標著「機器人」的是其他機器人只給人看的訊息）；逐字稿，每一則是 `時間　#id 發話者：內容`，AI 沒看到的那些底下有一行 `↳` 說明下場（script 接走、script 出錯、/aside）；最後是涵蓋範圍（缺了哪些 message id）。太長就用 `--since` 分段讀。

3. **判斷這次要做的範圍**，濃縮成一行描述，當 FIAT 文件的標題（`# ` 那一行）。

4. **寫 FIAT 文件**：
   - 新專案：`genesis/FIATLUX.md`。
   - 舊專案：`genesis/FIAT-{slug}.md`（slug 用英文小寫加連字號，不要跟既有的撞名），並更新 `genesis/README.md`。
   - `genesis/README.md` 依順序列出每份 FIAT 文件的標題，各自連到那份文件，`FIATLUX.md` 排第一。只有 `FIATLUX.md` 時不建。

   寫法：
   - 用主述者的口吻：「我想要……」「請妳幫我……」。
   - 只寫 WHAT，不寫 HOW。主述者明確指定的技術才寫進去。
   - 以主述者的意志為準。其他人或其他 AI 的搭腔與建議，主述者沒有採納的都不算。

5. 回報 `fiat "<FIAT 檔名：標題>"`，然後停下來。

## 收到 `go`

照這一輪的 FIAT 文件實作。

- HOW 全權由妳決定，放手用最強的技術。對話裡 AI 提過的做法、主述者問起的做法，都不必理會。
- 做完先不要 commit。
- 成果是一個 OpenClaw skill，放在專案裡的 `<skill 名>/`（新專案就用專案名）。回報之後它會自動上線到這個房間，主述者直接在房間裡驗收；不必寫設定檔，也不要動 gateway 的設定。
  - `SKILL.md`：教 AI 處理 script 放行的那些輸入。
  - `scripts/intercept.{mjs,js,cjs,py}`：攔截 script。stdin 收 JSON `{ body, channel, target, senderId, sessionKey, agentId, send }`（`send` 用來再送訊息）；stdout 是回給使用者的純文字，空的就是不回話；exit `0` 處理掉、exit `20` 交給 AI、其他是出錯。
  - 有副作用的動作一旦做了，就不可以 exit `20`：AI 會拿同一句話再做一次。
  - `.py` 是用 `uv run` 跑的，依賴寫在開頭的 PEP 723 `# /// script` 區塊。
  - 細節見 [AUTHORING.md](https://github.com/caridina-ai/openclaw-chat-interceptor/blob/main/docs/AUTHORING.md)。
- 想好驗收測試怎麼做，確認專案的 `README.md` 寫清楚了。
- 回報 `built "<做了什麼、怎麼驗收>"`，然後停下來。

## `/tap -done`

驗收通過了。

1. 檢查要 commit 的內容有沒有個人資訊（chat id、姓名、住處、帳號……），有就先處理掉。`.tap` 不進版控。
2. commit。
3. 把這一輪的經驗寫進交接 memory——這個 session 等一下就會結束。
4. 回報 `done "<commit 了什麼>"`。
