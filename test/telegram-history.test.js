import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { after, test } from 'node:test';
import { readTelegramHistory } from '../skills/tap/telegram-history.mjs';
import { tempDir, removeLater, TELEGRAM_CHAT, OTHER_CHAT } from './helpers.js';
const state = tempDir('tap-retained-');
after(() => removeLater(state));
mkdirSync(join(state,'state'));
mkdirSync(join(state,'logs'));
const file = join(state,'state','openclaw.sqlite');
const db = new DatabaseSync(file);
db.exec('CREATE TABLE plugin_state_entries(plugin_id TEXT, namespace TEXT, entry_key TEXT, value_json TEXT, expires_at INTEGER)');
const row = db.prepare('INSERT INTO plugin_state_entries VALUES(?,?,?,?,?)');
function seed(id,extra = {},{chat=TELEGRAM_CHAT,namespace='@retained.telegram.message-cache',expires=null} = {}) {
  const value = {version:1,historyEligible:true,sourceMessage:{message_id:id,date:1793664000+id,chat:{id:Number(chat),type:'supergroup'},from:{id:7,first_name:'Tester'},text:`Message ${id}`},...extra};
  row.run('telegram',namespace,`scope:default:${chat}:${String(id).padStart(10,'0')}`,JSON.stringify(value),expires);
}
seed(1);seed(2,{historyEligible:false});seed(3,{version:2});seed(4,{}, {chat:OTHER_CHAT});
seed(5,{threadId:9});seed(6,{}, {expires:1});seed(7,{}, {namespace:'telegram.message-cache'});
seed(8,{sourceMessage:{message_id:8,date:1793664008,chat:{id:Number(TELEGRAM_CHAT),type:'supergroup'},from:{id:9,is_bot:true,first_name:'Helper'},caption:'Caption',document:{file_name:'file.txt'}}});
db.close();
test('reads only retained admitted records in the exact room/topic without writing', () => {
  const before = readFileSync(file);
  const result = readTelegramHistory({DatabaseSync,stateDir:state,target:TELEGRAM_CHAT});
  assert.equal(result.available,true);
  assert.deepEqual(result.messages.map(m=>m.id),['1','8']);
  assert.equal(result.skipped,2);
  assert.match(result.messages[1].content,/Caption.*\n.*file.txt/);
  assert.equal(result.messages[1].author.bot,true);
  assert.deepEqual(readFileSync(file),before);
  assert.deepEqual(readTelegramHistory({DatabaseSync,stateDir:state,target:`${TELEGRAM_CHAT}:topic:9`}).messages.map(m=>m.id),['5']);
});
test('tap merges retained messages with offstage results without calling the Telegram CLI', () => {
  writeFileSync(join(state,'logs','chat-interceptor-offstage.log'),`2026-11-03 08:00:01 ${JSON.stringify({kind:'script',channel:'telegram',target:TELEGRAM_CHAT,senderId:'7',text:'Message 1',reply:'Done'})}\n`);
  const stdout=execFileSync(process.execPath,[new URL('../skills/tap/tap.mjs',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),'--channel','telegram','--target',TELEGRAM_CHAT,'--since','0','--format','json'],{encoding:'utf8',env:{...process.env,OPENCLAW_STATE_DIR:state,OPENCLAW_GATEWAY_PORT:'9',TZ:'Asia/Taipei'}});
  const output=JSON.parse(stdout);
  assert.equal(output.warning,undefined);
  assert.equal(output.coverage.retainedTelegram.complete,false);
  assert.equal(output.timeline.filter(m=>m.text==='Message 1').length,1);
  assert.equal(output.timeline.find(m=>m.id===1).kind,'script');
});
