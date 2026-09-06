# 從 OpenClaw 內部用 /tap 呼叫 Claude Code 施展它的 /tap 技能

目前版本 chat-interceptor 的運作方式是，使用者先手動建立好一個專案，並建立 <projname>/genesis/.tap 檔，再在專案子目錄啟動 Claude Code 施展 /tap 技能，回頭汲取群組中的對話來開發或修改 scripts。

我們這個版本想要在群組中遠端完成對應的動作，不必到終端機叫起 Claude Code。

只有三種操作模式要開發：

/tap projname 產生新專案

/tap projname yyyy-mm-dd 產生新專案，並且只從 yyyy-mm-dd 開始往後汲取

/tap 維護舊功能

須注意，這裡的 /tap 是由 chat-interceptor 攔截 OpenClaw 上面的對話，而本專案裡面建立的 skills/tap，是安裝在 Claude Code 上面的 /tap 技能，供 Claude Code 施展。這兩個 /tap 只是名稱一樣而已，請區分清楚。

也就是說，使用者在 OpenClaw 下 /tap 命令，被 chat-interceptor 攔截下來後，叫起 Claude Code，請它施展 /tap 技能。

Claude Code 不必知道它是被 chat-interceptor 叫起的，因為舊的操作模式從終端機叫起也是做一模一樣的動作。

## /tap projname

chat-interceptor 攔截到 /tap projname 輸入詞時，首先在 D:\projects 建立 D:\projects\projname\genesis\.tap，然後叫起 Claude Code，工作目錄設在 D:\projects\projname，然後請它施展 /tap 技能，完成後即退出。

## /tap projname yyyy-mm-dd

跟上一種一樣，只差在寫進 .tap 的 viewed 欄位不留空，而是填 yyyy-mm-dd。

為什麼要這一種：一個頻道往往是先亂聊了很久，聊到某個點子不錯才決定開專案。這時候整個頻道從頭汲取只會撈回一堆跟這個專案無關的話，所以要能指定「從那一天開始才算數」。

.tap 的 viewed 本來就是「上一輪檢討看到哪裡為止」，Claude Code 一律從 viewed 往後汲取。所以這裡不必為它多發明一個欄位，開專案時把起點直接寫進 viewed 就是了。

## /tap

chat-interceptor 攔截到 /tap 輸入詞時，首先依據目前所在 channel+target 找到對應的專案，然後叫起 Claude Code，設好工作目錄，然後請它施展 /tap 技能，完成後即退出。

這三個操作，我希望是寫在 script 裡面，而不必用到 AI 的智力。