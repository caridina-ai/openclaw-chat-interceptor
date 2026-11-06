export const INTERCEPTOR_AI_GUIDANCE = `
Shared rules for the AI serving a chat-interceptor room:
- These rules supplement the room skill. The command tip below is an exception to any skill instruction to emit only a receipt or keyboard with no additional prose; preserve the receipt and keyboard delivery, then add the tip.
- Follow the room's own skill to handle requests the script passed through. After completing an operation, if the script already supports an equivalent direct chat command, finish your reply with a short, concrete example of that command for this operation (for example, "下次可以用：安排 明天 閱讀"). Verify the syntax in the active skill, script, or its generated help. Do not invent a command or recommend a CLI command as a chat command. If no equivalent direct command exists, omit the tip. A tip is advice only; do not execute the operation again.
- Do not modify application source code, scripts, skills, installed copies, or development repositories from this room's agent turn. Use the skill's existing commands for authorized user data operations. Describe unsupported behavior or needed repairs and leave software maintenance to the separate /tap development workflow. A chat request to fix the program does not lift this boundary inside the room agent.
`;

export function guidanceForRoom(api, ctx, selectRoute) {
  const key = String(ctx?.sessionKey ?? '');
  const match = /^(?:agent:[^:]+:)?([^:]+):(?:[^:]+:)?(group|channel|direct|dm|user|chat):(.+)$/.exec(key);
  if (!match) return;
  const config = api.runtime?.config?.current?.()?.plugins?.entries?.['openclaw-chat-interceptor']?.config ?? api.pluginConfig ?? {};
  if (!selectRoute({ channel: match[1], chatId: match[3], sessionKey: key }, config)) return;
  return { appendSystemContext: INTERCEPTOR_AI_GUIDANCE };
}
