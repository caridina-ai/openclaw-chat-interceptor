# 在 OpenClaw 改用 /fiat 建立新專案或新功能，在 Claude Code 才用 /tap 汲取對話

經過幾次的使用，我決定流程應該改成這樣

    1. 我在 OpenClaw 的 channel 中以 /fiat projname 建立新的專案，或 /fiat 維護舊專案
    2. /fiat 會叫起 Claude Code 來施展 /tap 技能，從 .tap 汲取對話內容，產生 FIATLUX.md 或 FIAT-{slug}.md，並於完成後呼叫回報程式
    3. 我透過 remote control 與 Claude 討論規格，沒問題就在 remote control 打 go，或在頻道下 /fiat -go，請 Claude 開始實作，並於完成後呼叫回報程式
    4. 回報程式會自動呼叫 /fiat -install 安裝實作成果供我做驗收測試
    5. 驗收通過後我用 /fiat -done 通知 Claude 可以 commit 了，並將經驗寫入交接 memory，完成後呼叫回報程式
    6. 回報程式會更新 timestamp，並關閉 Claude Code

連續版的流程則是在第 1. 步加一個 -go 參數，它就會一路做到 4. 等我驗收

    1. 我在 OpenClaw 的 channel 中以 /fiat projname -go 建立新的專案，或 /fiat -go 維護舊專案
    2. /fiat 會叫起 Claude Code 來施展 /tap 技能，從 .tap 汲取對話內容，產生 FIATLUX.md 或 FIAT-{slug}.md，並於完成後呼叫回報程式
    3. 回報程式會自動注入 go 請 Claude 開始實作，並於完成後呼叫回報程式
    4. 回報程式會自動呼叫 /fiat -install 安裝實作成果供我做驗收測試
    5. 驗收通過後我用 /fiat -done 通知 Claude 可以 commit 了，並將經驗寫入交接 memory，完成後呼叫回報程式
    6. 回報程式會更新 timestamp，並關閉 Claude Code

因此我們這回合修改有以下幾個重點

## 供 Claude Code 呼叫的回報程式

從 Claude 的角度來看上述流程，/tap 的 SKILL.md 中會要求它呼叫回報程式的地方有：

1. 完成 FIAT 文件後
2. 完成實作後
3. 完成 commit 並寫入交接 memory 後

回報程式在一般啟動指令沒有加 -go 的情境下

1. 完成 FIAT 文件後 => 就是一般的回報，然後停下來等我審閱 FIAT 文件
2. 完成實作後 => 即使沒有加 -go 仍會自動執行 /fiat -install，然後再回報
3. 完成 commit 並寫入交接 memory 後 => 更新 timestamp 並關閉 Claude Code

回報程式在啟動指令有加 -go 的情境下

1. 完成 FIAT 文件後 => 回報後會自動注入 go 開始實作
2. 完成實作後 => 有加 -go 就是會自動執行 /fiat -install，然後再回報 <-- 與沒有加 -go 一模一樣
3. 完成 commit 並寫入交接 memory 後 => 更新 timestamp 並關閉 Claude Code <-- 與沒有加 -go 一模一樣

由此分析可知，回報程式只有 1. 在完成 FIAT 文件後行為不同；2. 3. 的行為在有 -go 或沒有 -go 都一模一樣

## .tap 的 viewed 欄位要改名為 timestamp

改名是為了配合 /fiat 的 -t 參數

不必在程式幫 viewed 留後路，妳要假設 viewed 從來沒有出現過、從來沒有被使用過，這樣程式才會簡潔

只要把 D:\projects 所有 .tap 的 viewed 都改成 timestamp 就好。這個 chat-interceptor 只有在我們這台電腦用過，也沒有別人 clone 過，因此更動以簡潔為最大原則，不必考慮相容性

## /fiat 的規格

/fiat 有以下幾種模式

/fiat [projname] [-t yyyy-mm-dd HH:MM] [-go]  建立新專案，或維護舊專案

/fiat ?  我不確定某頻道有沒有綁定過時，用這個命令查詢。只查不做，不會叫起 Claude。不小心打成全形的 ？ 也要接住。訊息要簡潔，一行一個欄位：project、installed（裝了就列 skill 名稱，沒裝就是 no）、Claude Code、timestamp（直接用 .tap 的欄位名稱）。openclaw.json 手寫的 route 只列 skill 上一層子目錄名稱如 my-skill，不必列整個路徑，會洩密，也太長

/fiat -go 只有一種意思：「綁定」這個頻道的專案，且後面都自動化。已經綁定就不必再綁定一次；Claude Code 已經開著、還沒開始實作（例如寫完 FIATLUX.md 停下來），就幫它注入 go。這樣它對使用者就沒有歧義了

這個指令很重要：我下 /fiat myproj 忘記加 -go，它寫完 FIATLUX.md 就停下來，要是 WebDAV 臨時不通看不到檔案，或 Claude 的 remote control 壞掉，就永遠沒有機會讓停下來的事情繼續走。這時補一句 /fiat -go，一切又自動進行下去了

/fiat -install  實作完成後以這個命令安裝於本頻道，準備驗收測試

/fiat -done  通知 Claude 驗收完成

/fiat -uninstall  某些情況下，要解除本頻道與原本專案的連結關係

### /fiat [projname] [-t yyyy-mm-dd HH:MM] [-go]

符合此模式的指令都會以 ccrun 叫起 Claude Code，並注入 `/tap [yyyy-mm-dd HH:MM]` 要求 Claude 汲取聊天紀錄，產生 FIATLUX.md 或  FIAT-{slug}.md

* [projname] 僅在子目錄不存在時代表建立新專案

若子目錄存在，須檢查是否與原綁定名稱相同，若不同則為錯誤，相同則忽略，和 `/fiat [-t] [-go] 沒加專案名稱` 等價

若我想綁定其它專案，必須以 /fiat -uninstall 再 /fiat -install projname 來達成，禁止直接 `/fiat 別的專案` 以避免混淆

沒加專案名稱時，若本頻道未曾綁定任何專案，也是錯誤

* 由「子目錄中是否已有程式」來判斷是否為新專案，而不是由綁定狀態或參數型態。有可能 `/fiat (沒加 projname)` 子目錄也存在，綁定也存在且有效，但因子目錄是空的，還是屬於「建立新專案 FIATLUX 的流程」而不是「維護舊專案」

* [-t yyyy-mm-dd HH:MM] 代表開始汲取的時間，不論是否建立新專案都可以加此參數

* [-go] 會在回報程式動手腳，讓 Claude 回報完成 FIAT 文件時，又馬上被驅動「實作 FIAT 文件」，且在回報完成實作時，自動執行 /fiat -install

### /fiat -install [projname]

沒加 projname 時，以原綁定佈署

若有加 projname 則須與原綁定相同，或本頻道未曾綁定則重新綁定；否則為錯誤

### /fiat -uninstall

解除安裝，使本頻道可綁定其它專案

### /fiat -done 

以 ccrun 通知 Claude 可以 commit 了，要寫交接 memory，最後要呼叫回報程式

回報程式會關閉 Claude Code，並更新 .tap 裡的 timestamp

## 叫起 Claude Code 注意事項

* 叫起 Claude Code 時，只要控制 back ground、remote control、working directory，以及將來關閉的把柄就好，其它不必要的參數例如 model、efforts、permission level 等都不要設，由我的 global settings 決定

* 啟動後的提示詞只傳入 /tap [yyyy-mm-dd HH:MM] 就好，其它所有的解釋都要寫在 /tap 的 SKILL.md 中，而不是在提示詞中

* 注意 Claude Code 的 /tap skill 參數只有 /tap [yyyy-mm-dd HH:MM] 不必加 -t 也不必傳入 projname，和 /fiat 不一樣

## /fiat 直接掛在 OpenClaw 之下，而不要掛在 chat-interceptor

舊版 /tap 還要請 AI 寫完程式自動佈署，還要 AI 修改 viewed，會增加 AI 出錯的機率

新版的這兩個動作都改由回報程式來控制了

再來就是 /fiat 都是透過 ccrun 對 AI 注入固定的 `/tap [yyyy-mm-dd HH:MM]` `go` `/tap -done`，因此不要再把 /fiat 掛在 chat-interceptor 之下，而是要掛成 OpenClaw 的 slash command

openclaw config set commands.handlers.fiat

## /aside 也是要掛成 OpenClaw 的 slash command

/aside 本來就一定不會呼叫 AI，因此不要掛在 chat-interceptor 之下，而是要掛成 OpenClaw 的 slash command

## /aside 內容和 intercepted 內容記在同一個檔案

上一個版本提出以 /aside 取代 ISSUE 後，只是把 ISSUE 檔改名而已，而被 interceptor 攔下來沒進入 AI session 的內容則另外存檔，並取消「debug mode 才存檔」的概念，讓它們變成 general 的對話記錄方式

這個版本以後，我們要進一步把兩個檔案改為同一個檔案，讓它的邏輯更單純，「記錄沒有進到 AI session 的所有對話，以供 /tap 還原內容」

## /tap 不再是 OpenClaw 裡的命令，而是 Claude Code 的技能

* 為配合 `/fiat [projname] [-t yyyy-mm-dd HH:MM] [-go]` 的 -t 參數，我們也要分成 `/tap` 或 `/tap yyyy-mm-dd HH:MM` 兩種情形

當 /fiat 有給定 -t 參數時，則啟動 Claude Code 時注入 `/tap yyyy-mm-dd HH:MM` (這邊就直接用而不必加 -t 了)，若沒有給定 -t 參數則啟動 Claude Code 時只注入 `/tap` 即可

* 實作的注意事項寫在 SKILL.md「收到 go 時」的對應章節，而不是寫在 ccrun 的注入提示詞中，這樣會比較好維護。/tap 事實上已經載入了，所以不必多一個 /tap -go 指令：我在 remote control 打的 go、/fiat -go 與回報程式注入的 go 都是同一個 go，不要讓我打難打的命令。SKILL.md 要先講好收到 go 要做什麼：要實作，而且要呼叫回報程式

* 為配合 `/fiat -done` 通知驗收通過，我們也設計一個 `/tap -done` 讓驗收通過的注意事項可以寫在 SKILL.md 的對應章節，而不是寫在 ccrun 的注入提示詞中，這樣會比較好維護

## 建議 /tap 的 SKILL.md 的寫法

在撰寫 SKILL.md 時務必將其它舊版不相關的內容清除乾淨，儘量保持簡潔

僅提供 Claude 需要知道的事情，保持簡潔。例如請 Claude 呼叫回報程式就好，至於回報程式還會自動 -go 或 -install 根本都不必寫出來，因為那些和它無關

建議分成以下章節

### /tap [yyyy-mm-dd HH:MM]

- 首先判斷是要建立新專案還是維護舊專案，專案子目錄都空空的就是要建立新專案，若已經有程式則是要維護舊專案

- 從 .tap 檔汲取聊天紀錄，判斷這次要寫程式的範圍，濃縮成「一行描述詞」作為 FIAT 文件的標題
  - 要說明參數 [yyyy-mm-dd HH:MM] 是用來改變汲取的開始時間點
  - 所以妳也要說清楚如何汲取，以及汲取結果的格式

- 若屬於建立新專案的情境，則產生的 FIAT 文件為 genesis/FIATLUX.md，然後呼叫回報程式

- 若屬於維護舊專案的情境，則再多將它取一個 {slug} 檔名，產生 genesis/FIAT-{slug}.md，更新 genesis/README.md，然後呼叫回報程式

- genesis/README.md 的內容是依順序列出各 FIAT 文件的「一行描述詞」作為超連結，連到 FIAT 文件

- 只有 FIATLUX.md 時則不加 genesis/README.md，比較簡潔

- 請 Claude 撰寫 FIAT 文件時注意
  - FIAT 文件原本是由主述者撰寫，請 Claude 幫忙實作的，因此要以「我想要什麼功能」、「我希望妳幫我產生什麼」的語氣來寫
  - 內容必須全部都是 WHAT 而不要包含 HOW；只要描述需求是什麼，主述者想要什麼，至於如何達成則不要寫進文件中成為限制。除非主述者有明確要求使用指定技術，才寫進文件中
  - 要完全以主述者的意志為準，其它 AI 在旁搭腔或給什麼建議都不需要考慮

- 完成後呼叫回報程式  

### 收到 go

請 Claude 開始依 FIAT 文件實作，須注意

- 放手使用 SOTA 的技術，完全不需要考慮對話中 AI 提議的，或主述者詢問的方法。我不准頻道中陪聊的 AI 撰寫程式，所以才會發展出這套 /fiat 方法，請外部最強的模型來開發程式；也因此 FIAT 文件只有 WHAT 主述者想要什麼，而沒有 HOW。 HOW 的部分全權交由實作者應用最強的技術來完成

- 實作後先不要 commit，等我驗收測試通過後會另行通知

- 安裝方式須以 /fiat -install 即可安裝
  - 所以妳也要說清楚撰寫準則

- 請 Claude 考慮驗收測試要如何操作，並檢查操作方法在 README.md 是否有寫清楚

- 完成後呼叫回報程式

### /tap -done

通知 Claude 驗收測試通過了，請 commit。須注意

- 要檢查 commit 的內容有沒有洩漏個人資訊，須先加以處理

- commit 後再呼叫回報程式，這個 session 就會結束了，因此要先將經驗寫入交接 memory

- 完成後呼叫回報程式
