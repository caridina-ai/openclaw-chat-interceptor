# 讓機器人在群聊裡可以發其它機器人不處理的訊息

我在 discord 會把好幾台機器上的機器人拉進同一個房間一起討論，故意不用 @mention 討論起來比較方便。所以平常的訊息大家都看得到，她們本來就是要互相討論的

但有的時候例如機器人在 /fiat 流程開發程式的過程，會一直回報進度，其它的機器人就一直在回覆她傳出來的訊息，把額度都消耗光了

所以我希望 chat-interceptor 可以提供一種特殊訊息，是像 /aside 那樣不會被其它機器人處理。所以我們這回合相當於擴充功能，提供機器人用的 /aside

以下是一些細節

## 提供 skill

實作成功後用 skill 提醒機器人群聊時，若只要給 human principal 看，避免其它機器人看到回覆的話，要改傳送這種訊息

私聊的時候不必載入這個 skill

## 使用特殊的 unicode

我們有驗證過用 zero width 的 unicode 例如 TAG EXCLAMATION MARK 測試過，它在 telegram 和 discord 都不會被濾掉，且加到訊息中也不會影響顯示結果。因此這次就可以在訊息中加用這種特殊字元作為辨識

攔截器看到 zero width 或 /aside 開頭的訊息，處理的方式都一樣，而且都不經過任何轉換。機器人自己用 /aside 回覆的，就照原本的樣子顯示：我看得到前面有 /aside，就知道別的機器人看不見

只有程式送出的訊息才帶 zero width，它們自動會以 /aside 的方式被處理，但畫面上看起來沒有 /aside，簡潔清楚

最好不要讓 AI 知道我們有 zero width 這種暗號：在 AUTHORING 中只教她呼叫我們的函數來送訊息，不必告訴她那個函數會偷偷在前面塞 zero width

## 回報程式一律用特殊訊息

/tap 的回報程式一律要用這種訊息。妳也順便盤點看看其它還有哪些發出訊息的地方，也都改成這種訊息

## debug: 不要讓 /aside 成為 discord 中的命令

現在在 discord 打 /aside 會被迫要選機器人，不選就會出現「You don't have permission to run this command」的錯誤；選了之後，那則訊息會變成臨時訊息，幾分鐘後就自動消失，這樣很不好用

我有試過輸入未註冊的如 /ok 就只會被當作普通的文字，不會有上述被當成 command 的問題，因此這次妳要想辦法讓 /aside 在 discord 中被當成普通文字。但是在 OpenClaw 中最好還是維持原本的 handler 機制

後來測試發現 /fiat 也一樣，回覆會變成臨時訊息、過一會兒就消失。原因是 OpenClaw 在 Discord 的斜線指令回覆預設是臨時訊息，所以把 `channels.discord.slashCommand.ephemeral` 設成 false 就好，反正我也沒在用其它的指令

/fiat 還是維持斜線指令：選機器人就是指定由哪一台來開發，這樣比較像產品
