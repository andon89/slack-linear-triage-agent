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

Three-file codebase with a clear separation between configuration and infrastructure:

- **`src/config.ts`** (~500 lines) — **The single customization point.** All product-specific settings (name, triage rules, issue templates) and 8 prompt builder functions that construct system prompts at runtime. Edit this file to customize behavior.
- **`src/agent.ts`** (~1600 lines) — Tool definitions (inline MCP), MCP server creation, system prompt instantiation, and 7 agent functions that call `query()` from the Claude Agent SDK.
- **`src/index.ts`** (~1200 lines) — Slack Bolt listener (Socket Mode), message queue, in-memory thread/message tracking maps, image upload orchestration, and message routing logic.

### Message Flow

1. Slack Bolt receives a message event in `index.ts`
2. Message is classified and pushed to a sequential queue (prevents MCP server conflicts)
3. Queue processor routes to the appropriate agent function in `agent.ts`:
   - `triageMessage()` — New top-level messages → create ticket, find duplicate, skip, or defer
   - `handleThreadReply()` — Replies in tracked threads → update ticket or add comment (branches on same vs different reporter)
   - `triageOrphanThreadReply()` — Replies in untracked threads → decide whether to create/update/skip
   - `handleDeferredFollowup()` — Replies in deferred threads → create ticket only if explicitly requested
   - `handleDirectCommand()` — @mention commands → execute ticket management actions
   - `handleMessageEdit()` / `handleMessageDelete()` — Edit/delete of triaged messages
4. Each agent function creates an inline MCP server with scoped tools and calls `query()` with the appropriate system prompt

### In-Memory State (index.ts)

- **`threadTicketMap`** — Maps `thread_ts` → ticket info (ID, identifier, isDuplicate, isDeferred, originalReporterId). Used to route thread replies to the correct handler. 24h TTL.
- **`messageTicketMap`** — Maps `message_ts` → ticket info. Used to handle edits/deletes of triaged messages. 24h TTL.
- **`processedMessages`** — Set of message timestamps to prevent duplicate processing. Capped at 1000 entries.

### MCP Server Pattern

Each agent function gets its own `createSdkMcpServer()` with a scoped tool set. Tools are defined once as `tool()` instances and composed into different servers:

| Server | Used by | Key tools |
|--------|---------|-----------|
| `triage-tools` | triageMessage, triageOrphanThreadReply | getUserInfo, searchIssues, createIssue, addComment, replyInThread, uploadImage |
| `command-tools` | handleDirectCommand | All tools including status, labels, assign, close, reopen, link, updateTitle |
| `followup-tools` | handleThreadReply | getUserInfo, getIssue, updateIssue, addComment, replyInThread, addReaction |
| `deferred-tools` | handleDeferredFollowup | getUserInfo, searchIssues, createIssue, addComment, replyInThread |
| `edit-handler-tools` | handleMessageEdit | getUserInfo, getIssue, updateIssue, addComment |
| `delete-handler-tools` | handleMessageDelete | addComment |

Tool allowlists in `query()` options must match the server name: `mcp__<server-name>__<tool-name>`.

## Claude Agent SDK Key Concepts

```typescript
query({
  prompt: "..." | asyncIterableOfSDKUserMessages,  // string or multi-modal
  options: {
    model: "sonnet",              // Use aliases: "sonnet", "opus", "haiku" (NOT full model IDs)
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: 10,
    permissionMode: "bypassPermissions",
    cwd: process.cwd(),
    env: { ...process.env },      // MUST spread process.env for PATH
    mcpServers: { "server-name": serverInstance },
    allowedTools: ["mcp__server-name__tool_name"],  // REQUIRED — zero trust, all tools blocked unless listed
  },
})
```

Processing results: `for await (const message of result)` yields `assistant` (Claude responses/tool calls) and `result` (final output with `total_cost_usd`).

## Configuration

### Environment Variables (all required)
`ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN` (xoxb-), `SLACK_APP_TOKEN` (xapp-), `SLACK_SIGNING_SECRET`, `SLACK_CHANNEL_ID`, `LINEAR_API_KEY`, `LINEAR_TEAM_ID`, `LINEAR_PROJECT_ID`

### Config Object (`src/config.ts`)
Required: `productName`, `productShortName`, `productDescription`, `slackChannelName`, `linearOrganization`
Optional: `issueTemplate` (titlePrefix, labelIds, stateId, descriptionTemplate), `triageRules` (createFor, skipFor, deferFor), `productContext`, `internalEmailDomain`, `model`

## Development Workflow

1. Run `npm run dev` in a background process
2. After code changes, kill and restart the process (tsx doesn't hot-reload)
3. Monitor stdout for `[Agent]`, `[Followup Agent]`, `[Command Agent]` etc. prefixed logs
4. Message recovery on startup uses `robot_face` emoji as a marker — first run skips historical recovery

## Common Issues

1. **Model not found**: Use model aliases (`sonnet`, `opus`, `haiku`) not full model IDs
2. **Tools not working**: Ensure `allowedTools` array includes all MCP tools with correct server name prefix
3. **Process spawn fails**: Spread `process.env` in the `env` option (needed for PATH)
4. **Queue stalls**: Messages are processed sequentially — a slow agent call blocks subsequent messages
