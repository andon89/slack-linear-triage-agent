# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev      # Development with tsx (no hot-reload — kill and restart after changes)
npm run build    # Compile TypeScript
npm start        # Run compiled version (dist/index.js)
npm run typecheck # Type-check without emitting
```

## Architecture

Four source files with a clear split between configuration and infrastructure:

- **`src/config.ts`** — **The single customization point.** Product settings (name, triage rules, issue template, model, effort) and 8 prompt builder functions that construct system prompts at runtime.
- **`src/tools.ts`** — Slack and Linear tools (`betaZodTool`), the `RunRecorder`, and the Slack-to-Linear image upload. `createTools(recorder)` builds a fresh tool set per agent run.
- **`src/agent.ts`** — `runAgent()` (one `client.beta.messages.toolRunner()` loop) and the 7 agent flow functions.
- **`src/index.ts`** — Slack Bolt listener (Socket Mode), message queue, in-memory thread/message tracking maps, image upload orchestration, and message routing.

### Message Flow

1. Slack Bolt receives a message event in `index.ts`
2. Message is classified and pushed to a sequential queue (keeps thread replies ordered after their parent's triage)
3. Queue processor routes to the appropriate agent function in `agent.ts`:
   - `triageMessage()` — New top-level messages → create ticket, find duplicate, skip, or defer
   - `handleThreadReply()` — Replies in tracked threads → update ticket or add comment (branches on same vs different reporter)
   - `triageOrphanThreadReply()` — Replies in untracked threads → decide whether to create/update/skip
   - `handleDeferredFollowup()` — Replies in deferred threads → create ticket only if explicitly requested
   - `handleDirectCommand()` — @mention commands → execute ticket management actions
   - `handleMessageEdit()` / `handleMessageDelete()` — Edit/delete of triaged messages
4. Each flow calls `runAgent()` with a system prompt, a list of tool names, and the user prompt

### Outcomes come from tools, not text

Tools write their side effects to the run's `RunRecorder` (`created`, `commentedOn`, `updated`, `deferred`, `repliedInSlack`). Flows derive their result from it — e.g. triage is `created` if `linear_create_issue` ran, `duplicate` if `linear_add_comment` ran, `deferred` if `slack_defer_to_team` ran, otherwise `skipped`. Don't reintroduce regex matching on model output. If a new outcome matters for routing, add a tool (or a recorder field set by an existing tool) that captures it.

### Roadmap claims

`triageRules.deferFor` is the only roadmap knowledge the bot has. The triage prompt forbids stating or implying roadmap status for anything not in that list, and `scripts/smoke.ts` fails a deferral that uses roadmap-claim phrases for an unlisted topic. Keep both in place when editing prompts.

### In-Memory State (index.ts)

- **`threadTicketMap`** — Maps `thread_ts` → ticket info (ID, identifier, isDuplicate, isDeferred, originalReporterId). Used to route thread replies to the correct handler. 24h TTL.
- **`messageTicketMap`** — Maps `message_ts` → ticket info. Used to handle edits/deletes of triaged messages. 24h TTL.
- **`processedMessages`** — Set of message timestamps to prevent duplicate processing. Capped at 1000 entries.

### Tool sets per flow

| Flow | Tools |
|------|-------|
| triageMessage | slack_get_user_info, linear_search_issues, linear_create_issue, linear_add_comment, slack_reply_in_thread, slack_defer_to_team |
| triageOrphanThreadReply, handleDeferredFollowup | same minus slack_defer_to_team |
| handleThreadReply | slack_get_user_info, linear_get_issue, linear_update_issue, linear_add_comment, slack_reply_in_thread, slack_add_reaction |
| handleDirectCommand | everything except slack_defer_to_team / slack_add_reaction |
| handleMessageEdit | slack_get_user_info, linear_get_issue, linear_update_issue, linear_add_comment |
| handleMessageDelete | linear_add_comment |

## Claude API Key Concepts

This uses the Anthropic TypeScript SDK (`@anthropic-ai/sdk`), not the Claude Agent SDK. The tool runner is a beta helper:

```typescript
const runner = client.beta.messages.toolRunner({
  model: config.model,                       // full model ID, e.g. "claude-opus-5"
  max_tokens: 16000,
  max_iterations: 12,                        // cap on API round-trips per run
  system: [{ type: "text", text: SYSTEM_PROMPT }],
  cache_control: { type: "ephemeral" },      // auto prompt caching across iterations
  output_config: { effort: config.effort },
  betas: ["server-side-fallback-2026-07-01"],
  fallbacks: "default",                      // retry safety declines on a fallback model
  tools: [betaZodTool({...}), ...],
  messages: [{ role: "user", content: prompt }],
});
for await (const message of runner) { /* log each assistant turn */ }
const final = await runner.done();
```

- A tool that throws becomes an `is_error` tool result for Claude to react to - no need for try/catch in tools.
- Adaptive thinking is on by default for Opus 5; don't send `budget_tokens` (400) or assistant prefill (400).
- Check `stop_reason === "refusal"` before trusting a result.

## Configuration

### Environment Variables
Required: `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN` (xoxb-), `SLACK_APP_TOKEN` (xapp-), `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID`, `LINEAR_API_KEY`, `LINEAR_TEAM_ID`
Optional: `LINEAR_PROJECT_ID` (scopes new tickets and duplicate search to one project)

### Config Object (`src/config.ts`)
Required: `productName`, `productShortName`, `productDescription`, `slackChannelName`, `linearOrganization`
Optional: `issueTemplate` (titlePrefix, labelIds, stateId, descriptionTemplate), `triageRules` (createFor, skipFor, deferFor), `productContext`, `internalEmailDomain`, `deferMentions` (Slack user IDs tagged on deferral), `model` (full model ID), `effort`

## Development Workflow

1. `npm run typecheck` and `npm run smoke` after changes to tools or prompts (smoke uses fake Slack/Linear and the real Claude API)
2. `npm run dev` in a background process; kill and restart after code changes (tsx doesn't hot-reload)
3. Monitor stdout for `[Triage Agent]`, `[Followup Agent]`, `[Command Agent]` etc. prefixed logs - each tool call and the per-run token/cache usage are logged
4. Message recovery on startup uses `robot_face` emoji as a marker — first run skips historical recovery

## Common Issues

1. **400 on the request**: check the model ID is exact (no date suffix) and that no `budget_tokens`, `temperature`, or assistant prefill slipped in - all rejected on Opus 5
2. **Tool not available to a flow**: add its name to that flow's `tools` list in `agent.ts`
3. **Wrong outcome recorded**: the flow's result comes from `RunRecorder` - check which tool ran, not what the model said
4. **Queue stalls**: messages are processed sequentially - a slow agent run blocks subsequent messages
