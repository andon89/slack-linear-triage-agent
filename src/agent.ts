import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlockParam,
  BetaImageBlockParam,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import config, {
  buildTriageSystemPrompt,
  buildCommandSystemPrompt,
  buildOrphanThreadPrompt,
  buildFollowupSameReporterPrompt,
  buildFollowupDifferentPersonPrompt,
  buildDeferredFollowupPrompt,
  buildEditHandlerPrompt,
  buildDeleteHandlerPrompt,
} from "./config.js";
import { createTools, RunRecorder, type ToolName } from "./tools.js";

export { setDependencies, uploadImageToLinearCdn } from "./tools.js";

// Credentials resolve from the environment (ANTHROPIC_API_KEY by default).
const client = new Anthropic({ maxRetries: 4 });

// Server-side refusal fallbacks are only offered on these model families.
const SUPPORTS_FALLBACKS = /^claude-(opus-5|fable-5)/.test(config.model);

const SYSTEM_PROMPT = buildTriageSystemPrompt(config);
const COMMAND_SYSTEM_PROMPT = buildCommandSystemPrompt(config);
const ORPHAN_THREAD_SYSTEM_PROMPT = buildOrphanThreadPrompt(config);
const FOLLOWUP_SYSTEM_PROMPT_SAME_REPORTER = buildFollowupSameReporterPrompt(config);
const FOLLOWUP_SYSTEM_PROMPT_DIFFERENT_PERSON = buildFollowupDifferentPersonPrompt(config);
const DEFERRED_FOLLOWUP_SYSTEM_PROMPT = buildDeferredFollowupPrompt(config);
const MESSAGE_EDIT_SYSTEM_PROMPT = buildEditHandlerPrompt(config);
const MESSAGE_DELETE_SYSTEM_PROMPT = buildDeleteHandlerPrompt(config);

// ---------------------------------------------------------------------------
// Agent runner
// ---------------------------------------------------------------------------

interface RunOptions {
  label: string;
  system: string;
  tools: ToolName[];
  prompt: string | BetaContentBlockParam[];
  maxIterations: number;
  effort?: typeof config.effort;
}

/**
 * Run one agent turn: Claude calls the given tools until it is done, and the
 * final text is returned. Each tool records its side effects on `recorder`,
 * which the caller owns so those effects survive an API error mid-run.
 */
async function runAgent(opts: RunOptions, recorder: RunRecorder): Promise<string> {
  const allTools = createTools(recorder);
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  const runner = client.beta.messages.toolRunner({
    model: config.model,
    max_tokens: 16000,
    max_iterations: opts.maxIterations,
    system: [{ type: "text", text: opts.system }],
    // Caches the growing conversation between tool-loop iterations.
    cache_control: { type: "ephemeral" },
    output_config: { effort: opts.effort ?? config.effort },
    ...(SUPPORTS_FALLBACKS && {
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default" as const,
    }),
    tools: opts.tools.map((name) => allTools[name]),
    messages: [{ role: "user", content: opts.prompt }],
  });

  console.log(`[${opts.label}] Starting...`);
  for await (const message of runner) {
    usage.input += message.usage.input_tokens;
    usage.output += message.usage.output_tokens;
    usage.cacheRead += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += message.usage.cache_creation_input_tokens ?? 0;

    for (const block of message.content) {
      if (block.type === "tool_use") {
        console.log(`[${opts.label}] -> ${block.name} ${JSON.stringify(block.input).substring(0, 200)}`);
      } else if (block.type === "text" && block.text.trim()) {
        console.log(`[${opts.label}]: ${block.text.substring(0, 300)}`);
      }
    }
    if (message.stop_reason === "refusal") {
      console.warn(`[${opts.label}] Model declined (${message.stop_details?.category ?? "unknown"}): ${message.stop_details?.explanation ?? ""}`);
    }
  }

  const final = await runner.done();
  const finalText = final.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  console.log(
    `[${opts.label}] Done (stop: ${final.stop_reason}, model: ${final.model}) tokens in=${usage.input} out=${usage.output} cacheRead=${usage.cacheRead} cacheWrite=${usage.cacheWrite}`,
  );
  return finalText;
}

function describeError(error: unknown): string {
  if (error instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API";
  if (error instanceof Anthropic.AuthenticationError) return "Invalid Anthropic API credentials";
  if (error instanceof Anthropic.APIError) return `Claude API error ${error.status}: ${error.message}`;
  return error instanceof Error ? error.message : "Unknown error";
}

function imageUrlSection(urls: string[] | undefined, heading: string): string {
  if (!urls || urls.length === 0) return "";
  return `\n${heading}:\n${urls.map((url, i) => `  ${i + 1}. ${url}`).join("\n")}`;
}

const VISION_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
type VisionMediaType = (typeof VISION_MEDIA_TYPES)[number];

function isVisionMediaType(type: string): type is VisionMediaType {
  return (VISION_MEDIA_TYPES as readonly string[]).includes(type);
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TriageImage {
  url: string;
  base64: string;
  contentType: string;
}

export interface TriageInput {
  messageText: string;
  userId: string;
  channel: string;
  threadTs: string;
  slackMessageUrl: string;
  images?: TriageImage[];
  forwardedMessage?: {
    text: string;
    originalAuthorId?: string;
    originalAuthorName?: string;
    sourceUrl?: string;
    threadContext?: string[];
    threadContextError?: string;
  };
}

export type TriageAction = "created" | "duplicate" | "skipped" | "deferred" | "error";

export interface TriageResult {
  action: TriageAction;
  ticketId?: string;
  ticketUrl?: string;
  ticketIdentifier?: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Triage Message
// ---------------------------------------------------------------------------

export async function triageMessage(input: TriageInput): Promise<TriageResult> {
  const images = input.images ?? [];

  let forwardedSection = "";
  if (input.forwardedMessage) {
    const fwd = input.forwardedMessage;
    let threadContextSection = "";
    if (fwd.threadContext && fwd.threadContext.length > 0) {
      threadContextSection = `

### Full Thread Context (from source channel)
The forwarded message was part of a thread. Here is the full conversation:
${fwd.threadContext.join("\n")}

Use this full context to understand the complete discussion and create a more comprehensive ticket.`;
    } else if (fwd.threadContextError) {
      threadContextSection = `

Note: Could not fetch full thread context (bot may not have access to the source channel). Only the forwarded message text is available.`;
    }

    forwardedSection = `

## FORWARDED MESSAGE
This message was FORWARDED/SHARED to the feedback channel. The original feedback is below:
Original Message: "${fwd.text}"
Original Author ID: ${fwd.originalAuthorId || "unknown"}
Original Author Name: ${fwd.originalAuthorName || "unknown"}
Original Message URL: ${fwd.sourceUrl || "not available"}
${threadContextSection}

The forwarder (User ID: ${input.userId}) added this context: "${input.messageText}"

For forwarded messages:
- Get user info for the ORIGINAL AUTHOR (${fwd.originalAuthorId || "if available"}) to attribute the ticket
- The original message content is the primary feedback to triage
- If full thread context is available, use all messages to understand the complete discussion
- Include the forwarder's context in the ticket description
- Note in the description that this was forwarded feedback`;
  }

  const textPrompt = `New message in ${config.slackChannelName}:
User ID: ${input.userId}
Message: "${input.messageText}"
Slack Message Link: ${input.slackMessageUrl}
Slack Channel: ${input.channel}
Slack Thread TS: ${input.threadTs}${imageUrlSection(
    images.map((img) => img.url),
    "Image URLs (already uploaded to Linear CDN - embed them in the ticket description with ![Screenshot](url))",
  )}${forwardedSection}

${images.length > 0 ? "The screenshot(s) are attached below - use them to understand what the user is showing." : ""}

Analyze and take action. If it's actionable feedback, create a ticket (include the Slack link in the description, and embed any image URLs above as markdown images). If it's not actionable, call no tools.
When replying in Slack, use the channel and thread_ts provided above.`;

  const content: BetaContentBlockParam[] = [{ type: "text", text: textPrompt }];
  for (const img of images) {
    if (!isVisionMediaType(img.contentType)) continue;
    const block: BetaImageBlockParam = {
      type: "image",
      source: { type: "base64", media_type: img.contentType, data: img.base64 },
    };
    content.push(block);
  }

  const recorder = new RunRecorder();
  let finalText: string;
  try {
    finalText = await runAgent({
      label: "Triage Agent",
      system: SYSTEM_PROMPT,
      tools: [
        "slack_get_user_info",
        "linear_search_issues",
        "linear_create_issue",
        "linear_add_comment",
        "slack_reply_in_thread",
        "slack_defer_to_team",
      ],
      prompt: content.length > 1 ? content : textPrompt,
      maxIterations: 12,
    }, recorder);
  } catch (error) {
    console.error("[Triage Agent Error]:", error);
    // A ticket may already exist from an earlier iteration; report it so the thread is still tracked.
    if (!recorder.primaryTicket() && !recorder.deferred) return { action: "error", message: describeError(error) };
    finalText = describeError(error);
  }

  const ticket = recorder.primaryTicket();
  const action: TriageAction = recorder.created.length > 0
    ? "created"
    : recorder.commentedOn.length > 0
      ? "duplicate"
      : recorder.deferred
        ? "deferred"
        : "skipped";

  return {
    action,
    ticketId: ticket?.id,
    ticketUrl: ticket?.url,
    ticketIdentifier: ticket?.identifier,
    message: finalText,
  };
}

// ---------------------------------------------------------------------------
// Orphan Thread Triage
// ---------------------------------------------------------------------------

export interface OrphanThreadInput {
  replyText: string;
  userId: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  slackMessageUrl: string;
  threadContext: string;
  imageUrls?: string[];
}

export interface OrphanThreadResult {
  action: "created" | "updated" | "skipped" | "error";
  ticketId?: string;
  ticketIdentifier?: string;
  message: string;
}

export async function triageOrphanThreadReply(input: OrphanThreadInput): Promise<OrphanThreadResult> {
  const prompt = `Analyze this thread reply and decide what to do:

User ID: ${input.userId}
Latest Reply: "${input.replyText}"
Slack Message Link: ${input.slackMessageUrl}
Slack Channel: ${input.channel}
Slack Thread TS (for replying): ${input.threadTs}${imageUrlSection(
    input.imageUrls,
    "Image URLs (already uploaded to Linear CDN - include these in the ticket description using ![Screenshot](url))",
  )}

Full Thread Context:
${input.threadContext}

Based on the thread context and the latest reply, decide:
1. SKIP if not actionable (call no tools)
2. Search for existing tickets and UPDATE if this relates to a known issue
3. CREATE a new ticket if this is new actionable feedback

If you take action (update or create), reply in Slack using the channel and thread_ts above.`;

  const recorder = new RunRecorder();
  let finalText: string;
  try {
    finalText = await runAgent({
      label: "Orphan Thread Agent",
      system: ORPHAN_THREAD_SYSTEM_PROMPT,
      tools: [
        "slack_get_user_info",
        "linear_search_issues",
        "linear_create_issue",
        "linear_add_comment",
        "slack_reply_in_thread",
      ],
      prompt,
      maxIterations: 12,
    }, recorder);
  } catch (error) {
    console.error("[Orphan Thread Agent Error]:", error);
    if (!recorder.primaryTicket()) return { action: "error", message: describeError(error) };
    finalText = describeError(error);
  }

  const ticket = recorder.primaryTicket();
  const action = recorder.created.length > 0
    ? "created"
    : recorder.commentedOn.length > 0
      ? "updated"
      : "skipped";
  return { action, ticketId: ticket?.id, ticketIdentifier: ticket?.identifier, message: finalText };
}

// ---------------------------------------------------------------------------
// Follow-up Reply Handling
// ---------------------------------------------------------------------------

export interface ThreadReplyInput {
  replyText: string;
  userId: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  ticketId: string;
  ticketIdentifier: string;
  threadContext: string;
  isDuplicate: boolean;
  isSameReporter: boolean;
  imageUrls?: string[];
}

export async function handleThreadReply(input: ThreadReplyInput): Promise<void> {
  const actionInstruction = input.isSameReporter
    ? "Update the ticket description with this new context (include any images as markdown, and update priority if warranted), then acknowledge in Slack."
    : "Add a comment to the ticket with this follow-up context (include any images as markdown), then reply in Slack.";

  const prompt = `A user replied in a thread about ticket ${input.ticketIdentifier}.

Ticket ID: ${input.ticketId}
User ID: ${input.userId}
Their reply: "${input.replyText}"
Slack Channel: ${input.channel}
Slack Thread TS (for replying): ${input.threadTs}
Reply Message TS (for reactions): ${input.messageTs}
Same reporter as original: ${input.isSameReporter}${imageUrlSection(
    input.imageUrls,
    "Image URLs (already uploaded to Linear CDN - include these using ![Screenshot](url))",
  )}

Thread context (full conversation):
${input.threadContext}

${actionInstruction}`;

  try {
    await runAgent({
      label: "Followup Agent",
      system: input.isSameReporter ? FOLLOWUP_SYSTEM_PROMPT_SAME_REPORTER : FOLLOWUP_SYSTEM_PROMPT_DIFFERENT_PERSON,
      tools: [
        "slack_get_user_info",
        "linear_get_issue",
        "linear_update_issue",
        "linear_add_comment",
        "slack_reply_in_thread",
        "slack_add_reaction",
      ],
      prompt,
      maxIterations: 8,
    }, new RunRecorder());
  } catch (error) {
    console.error("[Followup Agent Error]:", error);
  }
}

// ---------------------------------------------------------------------------
// Deferred Follow-up Handling
// ---------------------------------------------------------------------------

export interface DeferredFollowupInput {
  replyText: string;
  userId: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  threadContext: string;
  originalContext?: string;
  imageUrls?: string[];
}

export interface DeferredFollowupResult {
  action: "created" | "no_action" | "error";
  ticketId?: string;
  ticketIdentifier?: string;
  message: string;
}

export async function handleDeferredFollowup(input: DeferredFollowupInput): Promise<DeferredFollowupResult> {
  const prompt = `A reply was posted in a DEFERRED thread (the original topic related to roadmap features).

Original message that was deferred: "${input.originalContext || "(not available)"}"

New reply:
User ID: ${input.userId}
Reply text: "${input.replyText}"
Slack Channel: ${input.channel}
Slack Thread TS: ${input.threadTs}${imageUrlSection(input.imageUrls, "Image URLs (already uploaded to Linear CDN)")}

Full thread context:
${input.threadContext}

Analyze this reply:
1. First, get the user's info to determine if they're internal or external
2. Decide:
   - No action: team providing context, general discussion (call no other tools)
   - Create a ticket: someone explicitly asked to track this (use the tools, then confirm in Slack)`;

  const recorder = new RunRecorder();
  let finalText: string;
  try {
    finalText = await runAgent({
      label: "Deferred Followup Agent",
      system: DEFERRED_FOLLOWUP_SYSTEM_PROMPT,
      tools: [
        "slack_get_user_info",
        "linear_search_issues",
        "linear_create_issue",
        "linear_add_comment",
        "slack_reply_in_thread",
      ],
      prompt,
      maxIterations: 12,
    }, recorder);
  } catch (error) {
    console.error("[Deferred Followup Agent Error]:", error);
    if (!recorder.primaryTicket()) return { action: "error", message: describeError(error) };
    finalText = describeError(error);
  }

  // Commenting on an existing ticket also moves the thread from deferred to tracked.
  const ticket = recorder.primaryTicket();
  return ticket
    ? { action: "created", ticketId: ticket.id, ticketIdentifier: ticket.identifier, message: finalText }
    : { action: "no_action", message: finalText };
}

// ---------------------------------------------------------------------------
// Direct Command Handling (@mention commands)
// ---------------------------------------------------------------------------

export interface DirectCommandInput {
  commandText: string;
  userId: string;
  channel: string;
  threadTs: string;
  messageTs: string;
  ticketContext: string | null;
  threadContext: string;
  imageUrls?: string[];
}

export interface DirectCommandResult {
  action: "executed" | "error";
  message: string;
}

export async function handleDirectCommand(input: DirectCommandInput): Promise<DirectCommandResult> {
  const ticketContextSection = input.ticketContext
    ? `Ticket Context: This thread is tracked to ticket ${input.ticketContext}. Use this ticket for commands like "close this", "change priority", etc.`
    : `Ticket Context: This thread is NOT tracked to any ticket. If the user says "this" when referring to a ticket, you'll need them to specify a ticket ID, OR search the thread context for Linear ticket links.`;

  const prompt = `You received a direct command via @mention.

User ID: ${input.userId}
Command: "${input.commandText}"
Slack Channel: ${input.channel}
Slack Thread TS (for replying): ${input.threadTs}
${ticketContextSection}${imageUrlSection(input.imageUrls, "Image URLs (already uploaded to Linear CDN)")}

Thread context (for understanding what's being discussed):
${input.threadContext}

Analyze the command and execute it. Remember:
- For "this" references to a ticket, use the ticket context above (${input.ticketContext || "none available"})
- If no ticket context and they say "this", look for Linear ticket links in the thread context above
- Use slack_reply_in_thread to confirm what you did
- For "help" commands, list the available commands in a friendly, readable format`;

  try {
    const finalText = await runAgent({
      label: "Command Agent",
      system: COMMAND_SYSTEM_PROMPT,
      tools: [
        "slack_get_user_info",
        "linear_get_issue",
        "linear_update_issue",
        "linear_add_comment",
        "slack_reply_in_thread",
        "linear_search_issues",
        "linear_create_issue",
        "linear_update_status",
        "linear_add_label",
        "linear_remove_label",
        "linear_assign_issue",
        "linear_close_issue",
        "linear_reopen_issue",
        "linear_link_issues",
        "linear_update_title",
      ],
      prompt,
      maxIterations: 12,
    }, new RunRecorder());
    return { action: "executed", message: finalText };
  } catch (error) {
    console.error("[Command Agent Error]:", error);
    return { action: "error", message: describeError(error) };
  }
}

// ---------------------------------------------------------------------------
// Message Edit Handling
// ---------------------------------------------------------------------------

export interface EditedMessageInput {
  ticketId: string;
  ticketIdentifier: string;
  originalText: string;
  editedText: string;
  userId: string;
  action: TriageAction;
}

export async function handleMessageEdit(input: EditedMessageInput): Promise<void> {
  const prompt = `A user edited their Slack message after triage.

Ticket ID: ${input.ticketId}
Ticket Identifier: ${input.ticketIdentifier}
User ID: ${input.userId}
Original action: ${input.action}

Original message: "${input.originalText}"
Edited message: "${input.editedText}"

Analyze the edit and take appropriate action:
1. Get the current ticket details
2. If the edit adds significant new information:
   - For NEW tickets (action: created): Update the description naturally
   - For DUPLICATE tickets (action: duplicate): Add a clarifying comment with attribution
3. Update priority if warranted by the edit
4. For minor edits (typos), optionally add a brief comment or skip`;

  try {
    await runAgent({
      label: "Edit Agent",
      system: MESSAGE_EDIT_SYSTEM_PROMPT,
      tools: ["slack_get_user_info", "linear_get_issue", "linear_update_issue", "linear_add_comment"],
      prompt,
      maxIterations: 8,
    }, new RunRecorder());
  } catch (error) {
    console.error("[Edit Agent Error]:", error);
  }
}

// ---------------------------------------------------------------------------
// Message Delete Handling
// ---------------------------------------------------------------------------

export interface DeletedMessageInput {
  ticketId: string;
  ticketIdentifier: string;
  messageTs: string;
  action: TriageAction;
}

export async function handleMessageDelete(input: DeletedMessageInput): Promise<void> {
  const prompt = `A user deleted their Slack message after triage.

Ticket ID: ${input.ticketId}
Ticket Identifier: ${input.ticketIdentifier}
Message timestamp: ${input.messageTs}
Original action: ${input.action}

Add a brief, factual note to the ticket that the original Slack message was deleted.`;

  try {
    await runAgent({
      label: "Delete Agent",
      system: MESSAGE_DELETE_SYSTEM_PROMPT,
      tools: ["linear_add_comment"],
      prompt,
      maxIterations: 3,
      effort: "low",
    }, new RunRecorder());
  } catch (error) {
    console.error("[Delete Agent Error]:", error);
  }
}
