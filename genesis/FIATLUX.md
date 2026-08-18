# openclaw-chat-interceptor 利用 before agent reply 攔截特定的輸入，達到省 tokens 的目的

我有寫一個 bookkeeping 的 skill，使用者透過 openclaw 的 telegram channel 直接下記帳的指令，例如「自助餐120」、「提款3000」

原版是全程由 AI 判斷「自助餐」的記帳科目是「外食費」，然後呼叫 uv run book.py 帶 記帳科目=外食費、項目=自助餐、金額=120

我發現有些記帳指令如「提款3000」是常常出現且不必經由 AI 判斷就可以直接呼叫 script 的，想透過 openclaw 的 before agent reply 這個 hook 去把它們攔截下來，免花 tokens 就能達成任務；而其它較複雜的輸入才走原來流程，請 AI 判斷

我最終的目標 openclaw-chat-interceptor 是一個 general purpose 的 plugin，使用者只要安裝一次，然後它在另一個 telegram chat room 中要提供另一個 skill 服務時，只要稍微設定，他就可以把那個 skill 改成「先給 script 處理看看，若不行再給 AI 處理」

## 附屬功能 ISSUE

使用者在使用過程中，如果有發現問題，或對軟體有意見，可以在頻道中留下以 ISSUE 開頭的訊息。此訊息類似註解，既不呼叫 AI 處理，也不傳給 script，只是把訊息原封不動留著給下述的 /tap 處理

## 附屬功能 /tap

提供外部的 AI 工具如 Claude Code 或 ChatGPT 一個技能 `/tap`，它能汲取專案上線頻道中的對話，包括使用者留下的 ISSUE 訊息，而了解使用情形，據以除錯或修改程式

我覺得可以在專案中放一個設定檔 `.tap` 來告知這個軟體是在哪個頻道上線的
