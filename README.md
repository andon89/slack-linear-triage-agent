# Slack-to-Linear Triage Agent

AI-powered Slack-to-Linear triage agent built with the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk). Monitors a Slack channel for product feedback and automatically creates, deduplicates, and manages Linear tickets.

## Features

- **Automatic triage**: Analyzes messages and creates Linear tickets for actionable feedback
- **Duplicate detection**: Searches existing tickets before creating new ones, links duplicates
- **Thread tracking**: Follows up on conversations, updates tickets with new context
- **Vision support**: Analyzes screenshots and uploads images to Linear CDN
- **Forwarded messages**: Detects shared messages and attributes to original author
- **@mention commands**: Manage tickets directly from Slack (close, assign, change priority, etc.)
- **Edit/delete handling**: Updates tickets when original messages are edited or deleted
- **Message recovery**: Catches up on missed messages after downtime

## Quick Start

### 1. Clone and install

```bash
git clone <this-repo>
cd slack-linear-triage-agent
npm install
```

### 2. Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps)
2. Click "Create New App" → "From an app manifest"
3. Paste the contents of `slack-app-manifest.yaml`
4. Install to your workspace
5. Note your **Bot Token** (`xoxb-...`), **App Token** (`xapp-...`), and **Signing Secret**

### 3. Get a Linear API key

1. Go to Linear → Settings → API → Personal API keys
2. Create a new key
3. Note your **Team ID** and **Project ID** (from the Linear URL or API)

### 4. Configure environment

```bash
cp .env.example .env
# Edit .env with your actual values
```

### 5. Customize for your product

Edit `src/config.ts` — this is the **single file** you need to change:

```typescript
const config: TriageConfig = {
  productName: "My Product",           // Your product name
  productShortName: "MP",              // Short name for logs
  productDescription: "...",           // 1-3 sentence description
  slackChannelName: "product-feedback", // Slack channel name
  linearOrganization: "mycompany",     // Linear org slug

  // Optional customization:
  issueTemplate: { ... },             // Title prefix, labels, state
  triageRules: { ... },               // What to create/skip/defer
  productContext: "...",               // Extended product context for the AI
  internalEmailDomain: "mycompany.com", // Detect internal vs external users
  model: "sonnet",                     // Claude model to use
};
```

### 6. Run

```bash
npm run dev      # Development (with hot-reload via tsx)
npm run build    # Compile TypeScript
npm start        # Run compiled version
```

## Architecture

```
src/
  config.ts   -- Single customization point (edit this file)
  agent.ts    -- Claude Agent SDK tools, prompts, and agent logic
  index.ts    -- Slack event listener and message infrastructure
```

### Config vs Infrastructure

The codebase is split into two layers:

- **`config.ts`** (~300 lines): Everything you customize — product name, triage rules, prompt templates, issue template. Edit this file + `.env` to deploy.
- **`agent.ts` + `index.ts`** (~3500 lines): Infrastructure you don't touch — tool implementations, message queuing, thread tracking, image uploads, connection management.

### How it works

1. **Slack listener** (`index.ts`) receives messages via Socket Mode
2. Messages are queued for sequential processing (prevents MCP server conflicts)
3. For each message, the appropriate **agent function** (`agent.ts`) is called:
   - `triageMessage()` — New messages → create ticket, find duplicate, skip, or defer
   - `handleThreadReply()` — Replies in tracked threads → update ticket or add comment
   - `triageOrphanThreadReply()` — Replies in untracked threads → decide what to do
   - `handleDeferredFollowup()` — Replies in deferred threads → create ticket if requested
   - `handleDirectCommand()` — @mention commands → execute ticket management actions
   - `handleMessageEdit()` / `handleMessageDelete()` — Edit/delete handling
4. Each agent function calls `query()` from the Claude Agent SDK with inline MCP tools

## Configuration Reference

### Required Fields

| Field | Description | Example |
|-------|-------------|---------|
| `productName` | Full product name | `"Acme Dashboard"` |
| `productShortName` | Short name / acronym | `"AD"` |
| `productDescription` | 1-3 sentence description | `"A tool for building..."` |
| `slackChannelName` | Slack channel name | `"product-feedback"` |
| `linearOrganization` | Linear org slug | `"mycompany"` |

### Optional Fields

| Field | Description | Default |
|-------|-------------|---------|
| `issueTemplate.titlePrefix` | Prefix for ticket titles | `""` (none) |
| `issueTemplate.labelIds` | Linear label UUIDs to auto-apply | `[]` |
| `issueTemplate.stateId` | Initial workflow state UUID | `""` (team default) |
| `issueTemplate.descriptionTemplate` | Markdown template for descriptions | Built-in template |
| `triageRules.createFor` | What messages create tickets | Bug reports, feature requests, etc. |
| `triageRules.skipFor` | What messages to skip | Thanks, ok, +1, casual chat |
| `triageRules.deferFor` | What to defer to team | `[]` (nothing deferred) |
| `productContext` | Extended product context (markdown) | `""` |
| `internalEmailDomain` | Email domain for internal users | `""` |
| `model` | Claude model alias | `"sonnet"` |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `SLACK_BOT_TOKEN` | Slack bot token (`xoxb-...`) |
| `SLACK_APP_TOKEN` | Slack app token (`xapp-...`) |
| `SLACK_SIGNING_SECRET` | Slack signing secret |
| `SLACK_CHANNEL_ID` | Channel ID to monitor |
| `LINEAR_API_KEY` | Linear API key |
| `LINEAR_TEAM_ID` | Linear team UUID |
| `LINEAR_PROJECT_ID` | Linear project UUID |

## @mention Commands

Users can @mention the bot in any thread to execute commands:

- **merge into [ticket]** — Add thread content as comment on another ticket
- **close this** / **cancel this** — Close or cancel the ticket
- **reopen this** — Reopen a closed ticket
- **change priority to [1-4]** — Update priority
- **assign to [user]** — Assign to a team member
- **add/remove label [label]** — Manage labels
- **link to [ticket]** — Create cross-reference
- **help** — List available commands
