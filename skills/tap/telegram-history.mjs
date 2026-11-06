import { existsSync } from "node:fs";
import { join } from "node:path";

// This is a local operator read, not an authenticated agent message-tool call.
export function readTelegramHistory({ DatabaseSync, stateDir, target, now = Date.now() }) {
  const scope = /^(?:telegram:)?(-\d+)(?::(?:topic:)?(\d+))?$/.exec(String(target));
  const result = { messages: [], admitted: 0, skipped: 0, available: false };
  if (!scope) return { ...result, error: 'Unsupported Telegram group/topic target' };
  const file = join(stateDir, 'state', 'openclaw.sqlite');
  if (!existsSync(file)) return result;
  if (!DatabaseSync) return { ...result, error: 'Retained Telegram history requires Node.js with node:sqlite' };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(`SELECT entry_key, value_json FROM plugin_state_entries
      WHERE plugin_id = 'telegram' AND namespace = '@retained.telegram.message-cache'
      AND (expires_at IS NULL OR expires_at > ?)`);
    for (const row of rows.iterate(now)) {
      const key = /^([^:]+):([^:]+):(-\d+):(\d+)$/.exec(row.entry_key);
      if (!key || key[3] !== scope[1]) continue;
      let value;
      try { value = JSON.parse(row.value_json); } catch { result.skipped++; continue; }
      const msg = value?.sourceMessage;
      if (String(msg?.chat?.id) !== scope[1] || !['group', 'supergroup'].includes(msg.chat.type)) continue;
      const thread = value.threadBinding?.threadSpec;
      const topic = thread?.scope === 'none' ? undefined : thread?.id ?? value.threadId ?? msg.message_thread_id;
      if (String(topic ?? '') !== String(scope[2] ?? '')) continue;
      if (value.version !== 1 || value.historyEligible !== true ||
          !Number.isSafeInteger(msg.message_id) || msg.message_id <= 0 ||
          Number(key[4]) !== msg.message_id || !Number.isFinite(msg.date) || msg.date <= 0) {
        result.skipped++;
        continue;
      }
      result.admitted++;
      const text = msg.text ?? msg.caption ?? '';
      const attachment = ['photo', 'video', 'document', 'audio', 'voice', 'sticker'].find(k => msg[k]);
      const content = [text, attachment ? `[附件 ${msg.document?.file_name || attachment}]` : ''].filter(Boolean).join('\n');
      if (!content) continue;
      const author = msg.from ?? msg.sender_chat ?? {};
      result.messages.push({
        id: String(msg.message_id), timestampMs: msg.date * 1000, content,
        author: { id: String(author.id ?? ''), bot: author.is_bot === true,
          username: author.username, global_name: [author.first_name, author.last_name].filter(Boolean).join(' ') || author.title }
      });
    }
    result.available = true;
  } catch (error) {
    result.error = `Cannot read retained Telegram history: ${error.message}`;
  } finally { db?.close(); }
  return result;
}
