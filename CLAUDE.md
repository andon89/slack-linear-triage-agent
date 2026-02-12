# Slack-to-Linear Triage Agent

Customizable Slack-to-Linear triage agent using the Claude Agent SDK.

## Architecture

- **Entry point**: `src/index.ts` - Slack listener using Bolt SDK with Socket Mode
- **Agent logic**: `src/agent.ts` - Claude Agent SDK with inline MCP tools
- **Configuration**: `src/config.ts` - Single customization point (edit this file)

### Key Features
- **Vision support**: Images are uploaded to Linear CDN and passed to Claude as base64 for analysis
- **Forwarded messages**: Detects shared messages and attributes to original author
- **Thread tracking**: Maps Slack threads to Linear tickets for follow-up handling
- **Orphan thread triage**: Handles replies in threads without tracked tickets
- **Message queue**: Sequential processing prevents MCP server conflicts

## Customization

All customization happens in `src/config.ts`:
- `productName`, `productDescription` - Used in all system prompts
- `issueTemplate` - Title prefix, labels, state for new tickets
- `triageRules` - What to create/skip/defer
- `productContext` - Extended product context for the AI
- `internalEmailDomain` - Detect internal vs external users
- `model` - Claude model alias

Prompt builder functions in config.ts construct all 8 system prompts from the config at runtime.

## Claude Agent SDK Key Concepts

### Query Options
```typescript
query({
  prompt: "...",
  options: {
    model: "sonnet",              // Use aliases: "sonnet", "opus", "haiku"
    systemPrompt: SYSTEM_PROMPT,
    maxTurns: 10,
    permissionMode: "bypassPermissions",
    cwd: process.cwd(),
    env: { ...process.env },      // Must spread process.env for PATH
    mcpServers: { ... },
    allowedTools: [ ... ],        // REQUIRED - explicit tool allowlist
  },
})
```

### Tool Allowlist (CRITICAL)
The SDK uses "zero trust" - all tools are blocked unless explicitly allowed:
```typescript
allowedTools: [
  "mcp__<server-name>__<tool-name>",
  // e.g., "mcp__triage-tools__slack_get_user_info"
]
```

### MCP Servers
- `triage-tools` - Main triage (getUserInfo, searchIssues, createIssue, addComment, replyInThread, uploadImage)
- `command-tools` - @mention commands (all tools including status, labels, assign, close, reopen, link, updateTitle)
- `followup-tools` - Thread follow-ups (getUserInfo, getIssue, updateIssue, addComment, replyInThread, addReaction)
- `deferred-tools` - Deferred thread handling (getUserInfo, searchIssues, createIssue, addComment, replyInThread)
- `edit-handler-tools` - Edit handling (getUserInfo, getIssue, updateIssue, addComment)
- `delete-handler-tools` - Delete handling (addComment)

### Inline MCP Tools
Uses `createSdkMcpServer()` and `tool()` for in-process tools (no subprocess overhead).

## Running

```bash
npm run dev      # Development with tsx
npm run build    # Compile TypeScript
npm start        # Run compiled version
npm run typecheck # Type-check without emitting
```

## Common Issues

1. **Model not found**: Use model aliases (`sonnet`, `opus`, `haiku`) not full names
2. **Tools not working**: Ensure `allowedTools` array includes all MCP tools
3. **Process spawn fails**: Spread `process.env` in the `env` option for PATH
