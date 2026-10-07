# 設定可用 ccrun 或 cdrun 叫起外部 AI harness 來寫程式

原版用 ccrun 叫起外部 Claude Code 來寫程式，後來我們又發展出參數完全相容的 cdrun 來叫起外部 Codex 來寫程式

這次任務就是要將 cdrun 整合進來

    /fiat -claude  叫起 Claude Code，內部則是呼叫 ccrun
    /fiat -codex   叫起 Codex，內部則是呼叫 cdrun
    /fiat          叫起預設 AI harness

預設 AI harness 要在設定檔中設定。若連設定檔都沒設的話，就預設為 ccrun

如果使用者沒有要用其中一個，就不要強迫設定檔中一定要設。例如沒有要用 cdrun 的話，就不必強迫設定 cdrun 的路徑

README.md 的安裝步驟要包含 ccrun 和 cdrun 的正式安裝指令，文字中稍微強調一下有用到才安裝

很複雜的設定，最好介紹用 `openclaw config patch` 的指令來達成

README.md 應面對大眾使用者，請去蕪存菁，整理成精簡易懂的使用者手冊。與大眾無關，使用者不需要知道的事情請刪除

docs/AUTHORING.md 的內容也有點繞太遠了，需要精簡一下，讓寫程式的 AI 很容易就抓到重點

不論 Claude Code 或 Codex，模型與權限一律照我自己的設定，ccrun 與 cdrun 都不另外指定。我在哪裡用（PC、手機）都習慣同一套設定，這樣才不會意外

叫起的 AI 要守兩個原則：要再注入提示詞時，用 pid 一定注入得到；它停下來時，我要能從手機接上去跟它討論
