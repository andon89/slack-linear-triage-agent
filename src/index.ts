import "dotenv/config";
import pkg from "@slack/bolt";
const { App, LogLevel } = pkg;
import { LinearClient } from "@linear/sdk";
import { triageMessage, setDependencies, type ImageAttachment, type TriageImage, uploadImageToLinearCdn, handleThreadReply, triageOrphanThreadReply, handleDeferredFollowup, handleDirectCommand, handleMessageEdit, handleMessageDelete } from "./agent.js";
import appConfig from "./config.js";

// Configuration
const config = {
  slackBotToken: process.env.SLACK_BOT_TOKEN!,
  slackAppToken: process.env.SLACK_APP_TOKEN!,
  slackSigningSecret: process.env.SLACK_SIGNING_SECRET!,
  slackChannelId: process.env.SLACK_CHANNEL_ID!,
  linearApiKey: process.env.LINEAR_API_KEY!,
  linearTeamId: process.env.LINEAR_TEAM_ID!,
  linearProjectId: process.env.LINEAR_PROJECT_ID!,
  nodeEnv: process.env.NODE_ENV ?? "development",
};

// Validate required environment variables
const requiredEnvVars = [
  "ANTHROPIC_API_KEY",
  "SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_SIGNING_SECRET",
  "SLACK_CHANNEL_ID",
  "LINEAR_API_KEY",
  "LINEAR_TEAM_ID",
  "LINEAR_PROJECT_ID",
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`Missing required environment variable: ${envVar}`);
    process.exit(1);
  }
}

const processedMessages = new Set<string>();

// Message queue to ensure sequential processing (prevents shared MCP server conflicts)
type QueuedMessage = {
  type: "new" | "thread_reply" | "orphan_thread" | "deferred_followup" | "direct_command" | "message_edited" | "message_deleted";
  data: Record<string, unknown>;
};
const messageQueue: QueuedMessage[] = [];
let isProcessing = false;

async function processQueue(
  slackApp: InstanceType<typeof pkg.App>,
  processNewMessage: (data: Record<string, unknown>) => Promise<void>,
  processThreadReply: (data: Record<string, unknown>) => Promise<void>,
  processOrphanThread: (data: Record<string, unknown>) => Promise<void>,
  processDeferredFollowup: (data: Record<string, unknown>) => Promise<void>,
  processDirectCommand: (data: Record<string, unknown>) => Promise<void>,
  processEditedMessage: (data: Record<string, unknown>) => Promise<void>,
  processDeletedMessage: (data: Record<string, unknown>) => Promise<void>
): Promise<void> {
  if (isProcessing || messageQueue.length === 0) {
    return;
  }

  isProcessing = true;
  try {
    while (messageQueue.length > 0) {
      const item = messageQueue.shift()!;
      try {
        if (item.type === "new") {
          await processNewMessage(item.data);
        } else if (item.type === "thread_reply") {
          await processThreadReply(item.data);
        } else if (item.type === "orphan_thread") {
          await processOrphanThread(item.data);
        } else if (item.type === "deferred_followup") {
          await processDeferredFollowup(item.data);
        } else if (item.type === "direct_command") {
          await processDirectCommand(item.data);
        } else if (item.type === "message_edited") {
          await processEditedMessage(item.data);
        } else if (item.type === "message_deleted") {
          await processDeletedMessage(item.data);
        }
      } catch (error) {
        console.error(`Error processing queued ${item.type} message:`, error);
      }
    }
  } finally {
    isProcessing = false;
    if (messageQueue.length > 0) {
      setImmediate(() => processQueue(slackApp, processNewMessage, processThreadReply, processOrphanThread, processDeferredFollowup, processDirectCommand, processEditedMessage, processDeletedMessage));
    }
  }
}

// Map thread_ts → ticket info for handling follow-up replies
const threadTicketMap = new Map<string, {
  ticketId: string;
  ticketIdentifier: string;
  createdAt: number;
  isDuplicate: boolean;
  isDeferred: boolean;
  originalContext?: string;
  originalReporterId?: string;
}>();

function cleanupOldThreadMappings(): void {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  for (const [threadTs, info] of threadTicketMap.entries()) {
    if (now - info.createdAt > maxAge) {
      threadTicketMap.delete(threadTs);
    }
  }
}

// Map message_ts → ticket info for handling edits and deletes
const messageTicketMap = new Map<string, {
  ticketId: string;
  ticketIdentifier: string;
  ticketUrl?: string;
  createdAt: number;
  wasTriaged: boolean;
  action: "created" | "duplicate" | "skipped" | "deferred" | "error";
}>();

function cleanupOldMessageMappings(): void {
  const now = Date.now();
  const maxAge = 24 * 60 * 60 * 1000;
  for (const [msgTs, info] of messageTicketMap.entries()) {
    if (now - info.createdAt > maxAge) {
      messageTicketMap.delete(msgTs);
    }
  }
}

// Parse a Slack message URL to extract channel ID and thread timestamp
function parseSlackUrl(url: string): { channelId: string; messageTs: string; threadTs?: string } | null {
  try {
    const match = url.match(/\/archives\/([A-Z0-9]+)\/p(\d+)/i);
    if (!match) return null;

    const channelId = match[1];
    const rawTs = match[2];
    const messageTs = rawTs.length > 6
      ? `${rawTs.slice(0, -6)}.${rawTs.slice(-6)}`
      : rawTs;

    const urlObj = new URL(url);
    const threadTs = urlObj.searchParams.get("thread_ts") || undefined;

    return { channelId, messageTs, threadTs };
  } catch {
    return null;
  }
}

// Fetch thread messages from a channel (for forwarded message context)
async function fetchThreadContext(
  app: InstanceType<typeof pkg.App>,
  channelId: string,
  threadTs: string,
  limit = 30
): Promise<{ messages: string[]; success: boolean; error?: string }> {
  try {
    const result = await app.client.conversations.replies({
      channel: channelId,
      ts: threadTs,
      limit,
    });

    if (!result.messages || result.messages.length === 0) {
      return { messages: [], success: true };
    }

    const messages = result.messages.map((m) => {
      const isBot = !!(m as { bot_id?: string }).bot_id;
      const user = isBot ? "Bot" : (m as { user?: string }).user || "Unknown";
      return `[${user}]: ${m.text || "(no text)"}`;
    });

    return { messages, success: true };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : "Unknown error";
    console.log(`Could not fetch thread context from ${channelId}: ${errorMsg}`);
    return { messages: [], success: false, error: errorMsg };
  }
}

// Extract Linear ticket info from thread messages (look for bot messages with ticket links)
function extractTicketFromThread(messages: Array<{ text?: string; bot_id?: string }>): {
  ticketId?: string;
  ticketIdentifier?: string;
  ticketUrl?: string;
} | null {
  // Build regex dynamically from config's Linear organization
  const linearOrgPattern = appConfig.linearOrganization.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const urlRegex = new RegExp(`https:\\/\\/linear\\.app\\/${linearOrgPattern}\\/issue\\/([A-Z]+-\\d+)(?:\\/[^\\s|>)]+)?`);

  for (const msg of messages) {
    if (!msg.text) continue;

    const urlMatch = msg.text.match(urlRegex);
    if (urlMatch) {
      const ticketIdentifier = urlMatch[1];
      const ticketUrl = urlMatch[0].replace(/[|>]+$/, '');
      return {
        ticketIdentifier,
        ticketUrl,
      };
    }
  }
  return null;
}

// Check if a message has the robot_face reaction (from history response data)
function hasRobotReaction(msg: { reactions?: Array<{ name: string }> }): boolean {
  return (msg.reactions || []).some((r) => r.name === "robot_face");
}

// Check if a message should be processed (filters out bots, thread replies, system messages)
function isProcessableMessage(msg: {
  text?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  ts?: string;
  files?: unknown[];
  attachments?: unknown[];
}): boolean {
  if (msg.bot_id || msg.subtype === "bot_message") return false;
  if (msg.thread_ts && msg.thread_ts !== msg.ts) return false;

  const hasContent = msg.text || (msg.files && msg.files.length > 0) || (msg.attachments && (msg.attachments as unknown[]).length > 0);
  if (!hasContent) return false;

  const skipSubtypes = ["channel_join", "channel_leave", "channel_topic", "channel_purpose"];
  if (msg.subtype && skipSubtypes.includes(msg.subtype)) return false;
  if (msg.subtype && msg.subtype !== "file_share") return false;

  return true;
}

// Global state for connection management
let slackApp: InstanceType<typeof pkg.App> | null = null;
let isShuttingDown = false;
let signalHandlersRegistered = false;

process.on("uncaughtException", (error) => {
  if (error.message?.includes("server explicit disconnect") ||
      error.message?.includes("too_many_websockets")) {
    console.error("[Recoverable] Slack websocket error - will retry in 30s:", error.message);
  } else {
    console.error("Uncaught exception:", error);
    process.exit(1);
  }
});

async function main(): Promise<void> {
  if (isShuttingDown) {
    console.log("Shutdown in progress, not starting new instance");
    return;
  }

  console.log(`Starting ${appConfig.productName} Triage Agent...`);

  slackApp = new App({
    token: config.slackBotToken,
    appToken: config.slackAppToken,
    signingSecret: config.slackSigningSecret,
    socketMode: true,
    logLevel: config.nodeEnv === "production" ? LogLevel.INFO : LogLevel.DEBUG,
  });

  const app = slackApp;

  app.error(async (error) => {
    console.error("[Slack Error]:", error);
  });

  const linearClient = new LinearClient({ apiKey: config.linearApiKey });

  const authResult = await app.client.auth.test();
  const botUserId = authResult.user_id;
  console.log(`Bot user ID: ${botUserId}`);

  setDependencies(app, linearClient, {
    teamId: config.linearTeamId,
    projectId: config.linearProjectId,
  });

  async function connectToLinearWithRetry(maxRetries = 5, initialDelayMs = 2000): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const viewer = await linearClient.viewer;
        console.log(`Linear connected as: ${viewer.name}`);
        return;
      } catch (error) {
        const isNetworkError = error instanceof Error &&
          (error.message.includes("fetch failed") ||
           error.message.includes("ETIMEDOUT") ||
           error.message.includes("ECONNREFUSED") ||
           error.message.includes("ENOTFOUND"));

        if (isNetworkError && attempt < maxRetries) {
          const delay = initialDelayMs * Math.pow(2, attempt - 1);
          console.log(`Linear connection failed (attempt ${attempt}/${maxRetries}), retrying in ${delay / 1000}s...`);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          console.error(`Failed to connect to Linear after ${attempt} attempts:`, error);
          process.exit(1);
        }
      }
    }
  }

  await connectToLinearWithRetry();

  // Recover missed messages from downtime (stateless - uses robot_face emoji as marker)
  async function recoverMissedMessages(): Promise<void> {
    console.log("Checking for missed messages...");

    const sevenDaysAgo = (Date.now() / 1000) - (7 * 24 * 60 * 60);
    const missedMessages: Array<{
      text?: string;
      user?: string;
      ts?: string;
      channel?: string;
      files?: unknown[];
      attachments?: unknown[];
    }> = [];
    let cursor: string | undefined;
    let foundLastProcessed = false;

    outer: do {
      const result = await app.client.conversations.history({
        channel: config.slackChannelId,
        oldest: sevenDaysAgo.toString(),
        limit: 100,
        cursor,
      });

      for (const msg of result.messages || []) {
        if (hasRobotReaction(msg as { reactions?: Array<{ name: string }> })) {
          foundLastProcessed = true;
          break outer;
        }

        if (!isProcessableMessage(msg as Parameters<typeof isProcessableMessage>[0])) continue;

        missedMessages.push(msg as typeof missedMessages[0]);
      }

      cursor = result.response_metadata?.next_cursor;
      if (cursor) await new Promise((r) => setTimeout(r, 200));
    } while (cursor);

    if (!foundLastProcessed && missedMessages.length > 0) {
      console.log("First run detected - skipping historical recovery to avoid flooding");
      return;
    }

    if (missedMessages.length === 0) {
      console.log("No missed messages to recover");
      return;
    }

    missedMessages.reverse();
    for (const msg of missedMessages) {
      messageQueue.push({
        type: "new",
        data: {
          text: msg.text,
          user: msg.user,
          ts: msg.ts,
          channel: msg.channel || config.slackChannelId,
          files: msg.files,
          attachments: msg.attachments,
        },
      });
    }

    console.log(`Recovered ${missedMessages.length} missed messages - queued for processing`);
  }

  // Handler for processing new messages (called from queue)
  async function processNewMessage(data: Record<string, unknown>): Promise<void> {
    const msg = data as {
      text: string;
      user: string;
      ts: string;
      channel: string;
      files?: Array<{
        id: string;
        name: string;
        mimetype: string;
        url_private: string;
        permalink: string;
      }>;
      attachments?: Array<{
        text?: string;
        author_name?: string;
        author_id?: string;
        from_url?: string;
        footer?: string;
        ts?: string;
      }>;
    };

    app.client.reactions.add({
      channel: msg.channel,
      timestamp: msg.ts,
      name: "robot_face",
    }).catch((e) => {
      if (!e.message?.includes("already_reacted")) {
        console.log("Could not add reaction:", e.message);
      }
    });

    const slackMessageUrl = `https://slack.com/archives/${msg.channel}/p${msg.ts.replace(".", "")}`;

    let forwardedMessage: {
      text: string;
      originalAuthorId?: string;
      originalAuthorName?: string;
      sourceUrl?: string;
      threadContext?: string[];
      threadContextError?: string;
    } | undefined;

    if (msg.attachments && msg.attachments.length > 0) {
      const firstAttachment = msg.attachments[0];
      if (firstAttachment.text) {
        forwardedMessage = {
          text: firstAttachment.text,
          originalAuthorId: firstAttachment.author_id,
          originalAuthorName: firstAttachment.author_name,
          sourceUrl: firstAttachment.from_url,
        };
        console.log(`Detected forwarded message from ${firstAttachment.author_name || firstAttachment.author_id || "unknown"}`);

        if (firstAttachment.from_url) {
          const parsed = parseSlackUrl(firstAttachment.from_url);
          if (parsed) {
            const threadTs = parsed.threadTs || parsed.messageTs;
            console.log(`Attempting to fetch thread context from channel ${parsed.channelId}, thread ${threadTs}`);

            const threadResult = await fetchThreadContext(app, parsed.channelId, threadTs);
            if (threadResult.success && threadResult.messages.length > 0) {
              forwardedMessage.threadContext = threadResult.messages;
              console.log(`Fetched ${threadResult.messages.length} messages from source thread`);
            } else if (!threadResult.success) {
              forwardedMessage.threadContextError = threadResult.error;
              console.log(`Could not fetch thread context: ${threadResult.error}`);
            }
          }
        }
      }
    }

    const images: TriageImage[] = [];
    if (msg.files && msg.files.length > 0) {
      for (const file of msg.files) {
        if (file.mimetype?.startsWith("image/")) {
          console.log(`Uploading image to Linear CDN: ${file.name}`);
          const result = await uploadImageToLinearCdn(
            file.url_private,
            file.name,
            file.mimetype
          );
          if (result) {
            images.push({
              url: result.url,
              base64: result.buffer.toString("base64"),
              contentType: result.contentType,
            });
          }
        }
      }
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Processing message from ${msg.user}: ${msg.text ? msg.text.substring(0, 100) : "(no text - forwarded message)"}`);
    console.log(`Link: ${slackMessageUrl}`);
    if (forwardedMessage) {
      console.log(`Forwarded message from: ${forwardedMessage.originalAuthorName || forwardedMessage.originalAuthorId || "unknown"}`);
      console.log(`Forwarded content: ${forwardedMessage.text.substring(0, 100)}`);
      if (forwardedMessage.threadContext) {
        console.log(`Thread context: ${forwardedMessage.threadContext.length} messages from source thread`);
      } else if (forwardedMessage.threadContextError) {
        console.log(`Thread context unavailable: ${forwardedMessage.threadContextError}`);
      }
    }
    if (images.length > 0) {
      console.log(`Images uploaded to Linear CDN (with vision): ${images.length}`);
    }
    console.log("=".repeat(60));

    const result = await triageMessage({
      messageText: msg.text,
      userId: msg.user,
      channel: msg.channel,
      threadTs: msg.ts,
      slackMessageUrl,
      images,
      forwardedMessage,
    });

    console.log(`\nTriage result: ${result.action}`);
    if (result.ticketIdentifier) {
      console.log(`Ticket: ${result.ticketIdentifier} - ${result.ticketUrl}`);
    }
    console.log(`Message: ${result.message.substring(0, 200)}`);

    if ((result.action === "created" || result.action === "duplicate") && (result.ticketId || result.ticketIdentifier)) {
      threadTicketMap.set(msg.ts, {
        ticketId: result.ticketId || result.ticketIdentifier!,
        ticketIdentifier: result.ticketIdentifier || result.ticketId!,
        createdAt: Date.now(),
        isDuplicate: result.action === "duplicate",
        isDeferred: false,
        originalReporterId: msg.user,
      });
      console.log(`Tracking thread ${msg.ts} for ticket ${result.ticketIdentifier || result.ticketId} (${result.action}, isDuplicate: ${result.action === "duplicate"}, reporter: ${msg.user})`);
      cleanupOldThreadMappings();
    } else if (result.action === "deferred") {
      threadTicketMap.set(msg.ts, {
        ticketId: "",
        ticketIdentifier: "",
        createdAt: Date.now(),
        isDuplicate: false,
        isDeferred: true,
        originalContext: msg.text,
        originalReporterId: msg.user,
      });
      console.log(`Tracking DEFERRED thread ${msg.ts} for later follow-up`);
      cleanupOldThreadMappings();
    }

    messageTicketMap.set(msg.ts, {
      ticketId: result.ticketId || "",
      ticketIdentifier: result.ticketIdentifier || "",
      ticketUrl: result.ticketUrl,
      createdAt: Date.now(),
      wasTriaged: result.action === "created" || result.action === "duplicate",
      action: result.action,
    });
    cleanupOldMessageMappings();
  }

  // Handler for processing thread replies (called from queue)
  async function processThreadReplyHandler(data: Record<string, unknown>): Promise<void> {
    const { replyText, userId, channel, threadTs, messageTs, ticketId, ticketIdentifier, isDuplicate, isSameReporter, files } = data as {
      replyText: string;
      userId: string;
      channel: string;
      threadTs: string;
      messageTs: string;
      ticketId: string;
      ticketIdentifier: string;
      isDuplicate: boolean;
      isSameReporter: boolean;
      files?: Array<{
        id: string;
        name: string;
        mimetype: string;
        url_private: string;
        permalink: string;
      }>;
    };

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Processing thread reply (cached ticket: ${ticketIdentifier}, isDuplicate: ${isDuplicate}, sameReporter: ${isSameReporter})`);
    console.log(`From: ${userId}`);
    console.log(`Reply: ${replyText?.substring(0, 100) || "(no text)"}`);
    console.log("=".repeat(60));

    const imageUrls: string[] = [];
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.mimetype?.startsWith("image/")) {
          console.log(`Uploading thread reply image to Linear CDN: ${file.name}`);
          const result = await uploadImageToLinearCdn(
            file.url_private,
            file.name,
            file.mimetype
          );
          if (result) {
            imageUrls.push(result.url);
          }
        }
      }
      if (imageUrls.length > 0) {
        console.log(`Uploaded ${imageUrls.length} images from thread reply`);
      }
    }

    const threadResult = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20,
    });

    const extractedTicket = extractTicketFromThread(
      (threadResult.messages || []) as Array<{ text?: string; bot_id?: string }>
    );

    const effectiveTicketId = extractedTicket?.ticketIdentifier || ticketId;
    const effectiveTicketIdentifier = extractedTicket?.ticketIdentifier || ticketIdentifier;

    if (extractedTicket && extractedTicket.ticketIdentifier !== ticketIdentifier) {
      console.log(`[Thread] Found ticket in thread (${extractedTicket.ticketIdentifier}) differs from cached (${ticketIdentifier}) - using thread ticket`);
    }
    console.log(`[Thread] Using ticket: ${effectiveTicketIdentifier}`);

    const threadContext = (threadResult.messages || [])
      .map((m) => {
        const isBot = !!(m as { bot_id?: string }).bot_id;
        return `[${isBot ? "Bot" : "User"}]: ${m.text || "(no text)"}`;
      })
      .join("\n");

    await handleThreadReply({
      replyText: replyText || "",
      userId,
      channel,
      threadTs,
      messageTs,
      ticketId: effectiveTicketId,
      ticketIdentifier: effectiveTicketIdentifier,
      threadContext,
      isDuplicate,
      isSameReporter,
      imageUrls,
    });
  }

  // Handler for orphan thread replies (no tracked ticket - let agent decide)
  async function processOrphanThreadHandler(data: Record<string, unknown>): Promise<void> {
    const { replyText, userId, channel, threadTs, messageTs, files } = data as {
      replyText: string;
      userId: string;
      channel: string;
      threadTs: string;
      messageTs: string;
      files?: Array<{
        id: string;
        name: string;
        mimetype: string;
        url_private: string;
        permalink: string;
      }>;
    };

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Processing orphan thread reply (no tracked ticket)`);
    console.log(`From: ${userId}`);
    console.log(`Reply: ${replyText?.substring(0, 100) || "(no text)"}`);
    console.log("=".repeat(60));

    const imageUrls: string[] = [];
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.mimetype?.startsWith("image/")) {
          console.log(`Uploading orphan thread image to Linear CDN: ${file.name}`);
          const result = await uploadImageToLinearCdn(
            file.url_private,
            file.name,
            file.mimetype
          );
          if (result) {
            imageUrls.push(result.url);
          }
        }
      }
      if (imageUrls.length > 0) {
        console.log(`Uploaded ${imageUrls.length} images from orphan thread`);
      }
    }

    const threadResult = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 20,
    });

    const threadContext = (threadResult.messages || [])
      .map((m) => {
        const isBot = !!(m as { bot_id?: string }).bot_id;
        return `[${isBot ? "Bot" : "User"}]: ${m.text || "(no text)"}`;
      })
      .join("\n");

    const slackMessageUrl = `https://slack.com/archives/${channel}/p${messageTs.replace(".", "")}?thread_ts=${threadTs}&cid=${channel}`;

    const result = await triageOrphanThreadReply({
      replyText: replyText || "",
      userId,
      channel,
      threadTs,
      messageTs,
      slackMessageUrl,
      threadContext,
      imageUrls,
    });

    console.log(`\nOrphan thread triage result: ${result.action}`);
    if (result.ticketIdentifier) {
      console.log(`Ticket: ${result.ticketIdentifier}`);
    }

    if ((result.action === "created" || result.action === "updated") && result.ticketId) {
      threadTicketMap.set(threadTs, {
        ticketId: result.ticketId,
        ticketIdentifier: result.ticketIdentifier || result.ticketId,
        createdAt: Date.now(),
        isDuplicate: result.action === "updated",
        isDeferred: false,
        originalReporterId: userId,
      });
      console.log(`Now tracking thread ${threadTs} for ticket ${result.ticketIdentifier}`);
    }
  }

  // Handler for deferred thread follow-ups
  async function processDeferredFollowupHandler(data: Record<string, unknown>): Promise<void> {
    const { replyText, userId, channel, threadTs, messageTs, files, originalContext } = data as {
      replyText: string;
      userId: string;
      channel: string;
      threadTs: string;
      messageTs: string;
      files?: Array<{
        id: string;
        name: string;
        mimetype: string;
        url_private: string;
        permalink: string;
      }>;
      originalContext?: string;
    };

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Processing deferred thread follow-up`);
    console.log(`From: ${userId}`);
    console.log(`Reply: ${replyText?.substring(0, 100) || "(no text)"}`);
    console.log("=".repeat(60));

    const imageUrls: string[] = [];
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.mimetype?.startsWith("image/")) {
          const result = await uploadImageToLinearCdn(
            file.url_private,
            file.name,
            file.mimetype
          );
          if (result) {
            imageUrls.push(result.url);
          }
        }
      }
    }

    const threadResult = await app.client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 30,
    });

    const threadContext = (threadResult.messages || [])
      .map((m) => {
        const isBot = !!(m as { bot_id?: string }).bot_id;
        return `[${isBot ? "Bot" : "User"}]: ${m.text || "(no text)"}`;
      })
      .join("\n");

    const result = await handleDeferredFollowup({
      replyText: replyText || "",
      userId,
      channel,
      threadTs,
      messageTs,
      threadContext,
      originalContext,
      imageUrls,
    });

    console.log(`\nDeferred follow-up result: ${result.action}`);

    if (result.action === "created" && result.ticketId) {
      const existing = threadTicketMap.get(threadTs);
      if (existing) {
        threadTicketMap.set(threadTs, {
          ...existing,
          ticketId: result.ticketId,
          ticketIdentifier: result.ticketIdentifier || result.ticketId,
          isDeferred: false,
        });
        console.log(`Thread ${threadTs} upgraded from DEFERRED to TRACKED (ticket: ${result.ticketIdentifier})`);
      }
    }
  }

  // Handler for direct commands (@mention)
  async function processDirectCommandHandler(data: Record<string, unknown>): Promise<void> {
    const { commandText, userId, channel, threadTs, messageTs, ticketContext, files } = data as {
      commandText: string;
      userId: string;
      channel: string;
      threadTs: string;
      messageTs: string;
      ticketContext: string | null;
      files?: Array<{
        id: string;
        name: string;
        mimetype: string;
        url_private: string;
        permalink: string;
      }>;
    };

    console.log(`\n${"=".repeat(60)}`);
    console.log(`Processing direct command (@mention)`);
    console.log(`From: ${userId}`);
    console.log(`Command: ${commandText?.substring(0, 100) || "(no text)"}`);
    console.log(`Ticket context: ${ticketContext || "none"}`);
    console.log("=".repeat(60));

    const imageUrls: string[] = [];
    if (files && files.length > 0) {
      for (const file of files) {
        if (file.mimetype?.startsWith("image/")) {
          const result = await uploadImageToLinearCdn(
            file.url_private,
            file.name,
            file.mimetype
          );
          if (result) {
            imageUrls.push(result.url);
          }
        }
      }
    }

    let threadContext = "";
    if (threadTs && threadTs !== messageTs) {
      const threadResult = await app.client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 30,
      });
      threadContext = (threadResult.messages || [])
        .map((m) => {
          const isBot = !!(m as { bot_id?: string }).bot_id;
          return `[${isBot ? "Bot" : "User"}]: ${m.text || "(no text)"}`;
        })
        .join("\n");
    }

    const result = await handleDirectCommand({
      commandText: commandText || "",
      userId,
      channel,
      threadTs,
      messageTs,
      ticketContext,
      threadContext,
      imageUrls,
    });

    console.log(`\nDirect command result: ${result.action}`);
    if (result.message) {
      console.log(`Response: ${result.message.substring(0, 200)}`);
    }
  }

  // Handler for processing edited messages (called from queue)
  async function processEditedMessageHandler(data: Record<string, unknown>): Promise<void> {
    const { messageTs, newText, previousText, userId } = data as {
      messageTs: string;
      newText: string;
      previousText: string;
      userId: string;
    };

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[Edit Handler] Processing edit for message ${messageTs}`);
    console.log(`From: ${userId}`);
    console.log(`Previous: ${previousText.substring(0, 100)}`);
    console.log(`New: ${newText.substring(0, 100)}`);
    console.log("=".repeat(60));

    const ticketInfo = messageTicketMap.get(messageTs);

    if (!ticketInfo) {
      console.log(`[Edit] Message not tracked (expired or never triaged) - skipping`);
      return;
    }

    if (!ticketInfo.wasTriaged) {
      console.log(`[Edit] Message was skipped/deferred originally - not re-triaging`);
      return;
    }

    const normalizedOld = previousText.trim().replace(/\s+/g, " ");
    const normalizedNew = newText.trim().replace(/\s+/g, " ");
    if (normalizedOld === normalizedNew) {
      console.log(`[Edit] No meaningful text change (whitespace only) - skipping`);
      return;
    }

    console.log(`[Edit] Message tracked: ticketId=${ticketInfo.ticketId}, action=${ticketInfo.action}`);

    await handleMessageEdit({
      ticketId: ticketInfo.ticketId,
      ticketIdentifier: ticketInfo.ticketIdentifier,
      originalText: previousText,
      editedText: newText,
      userId,
      action: ticketInfo.action,
    });
  }

  // Handler for processing deleted messages (called from queue)
  async function processDeletedMessageHandler(data: Record<string, unknown>): Promise<void> {
    const { messageTs, channel: _channel, threadTs } = data as {
      messageTs: string;
      channel: string;
      threadTs?: string;
    };

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[Delete Handler] Processing deletion for message ${messageTs}`);
    console.log("=".repeat(60));

    const ticketInfo = messageTicketMap.get(messageTs);

    if (!ticketInfo) {
      console.log(`[Delete] Message not tracked (expired or never triaged) - skipping`);
      return;
    }

    if (!ticketInfo.wasTriaged) {
      console.log(`[Delete] Message was skipped/deferred originally - no ticket to update`);
      return;
    }

    console.log(`[Delete] Message was linked to ticket ${ticketInfo.ticketIdentifier}`);

    await handleMessageDelete({
      ticketId: ticketInfo.ticketId,
      ticketIdentifier: ticketInfo.ticketIdentifier,
      messageTs,
      action: ticketInfo.action,
    });

    messageTicketMap.delete(messageTs);
    if (threadTs) {
      threadTicketMap.delete(threadTs);
    }
    console.log(`[Delete] Cleaned up tracking for message ${messageTs}`);
  }

  // Listen for messages - queue them for sequential processing
  app.message(async ({ message }) => {
    try {
      const msg = message as {
        text?: string;
        user?: string;
        ts?: string;
        channel?: string;
        thread_ts?: string;
        bot_id?: string;
        subtype?: string;
        files?: Array<{
          id: string;
          name: string;
          mimetype: string;
          url_private: string;
          permalink: string;
        }>;
        attachments?: Array<{
          text?: string;
          author_name?: string;
          author_id?: string;
          from_url?: string;
          footer?: string;
          ts?: string;
        }>;
      };

      const hasContent = msg.text || (msg.attachments && msg.attachments.length > 0) || (msg.files && msg.files.length > 0);
      if (!hasContent || !msg.user || !msg.ts || !msg.channel) return;
      if (msg.channel !== config.slackChannelId) return;
      if (msg.bot_id) return;
      if (msg.subtype && msg.subtype !== "file_share") return;

      const isBotMentioned = msg.text?.includes(`<@${botUserId}>`);

      if (isBotMentioned) {
        const ticketInfo = msg.thread_ts ? threadTicketMap.get(msg.thread_ts) : null;

        console.log(`Bot @mentioned - queuing direct command (queue size: ${messageQueue.length + 1})`);
        messageQueue.push({
          type: "direct_command",
          data: {
            commandText: msg.text,
            userId: msg.user,
            channel: msg.channel,
            threadTs: msg.thread_ts || msg.ts,
            messageTs: msg.ts,
            ticketContext: ticketInfo?.ticketIdentifier || null,
            files: msg.files,
          },
        });
        processQueue(app, processNewMessage, processThreadReplyHandler, processOrphanThreadHandler, processDeferredFollowupHandler, processDirectCommandHandler, processEditedMessageHandler, processDeletedMessageHandler);
        return;
      }

      if (msg.thread_ts && msg.thread_ts !== msg.ts) {
        const ticketInfo = threadTicketMap.get(msg.thread_ts);

        if (ticketInfo) {
          if (ticketInfo.isDeferred) {
            console.log(`Queuing deferred thread reply for smart handling (queue size: ${messageQueue.length + 1})`);
            messageQueue.push({
              type: "deferred_followup",
              data: {
                replyText: msg.text,
                userId: msg.user,
                channel: msg.channel,
                threadTs: msg.thread_ts,
                messageTs: msg.ts,
                files: msg.files,
                originalContext: ticketInfo.originalContext,
              },
            });
          } else {
            const isSameReporter = ticketInfo.originalReporterId === msg.user;
            console.log(`Queuing thread reply for ticket ${ticketInfo.ticketIdentifier} (isDuplicate: ${ticketInfo.isDuplicate}, sameReporter: ${isSameReporter}, queue size: ${messageQueue.length + 1})`);
            messageQueue.push({
              type: "thread_reply",
              data: {
                replyText: msg.text,
                userId: msg.user,
                channel: msg.channel,
                threadTs: msg.thread_ts,
                messageTs: msg.ts,
                ticketId: ticketInfo.ticketId,
                ticketIdentifier: ticketInfo.ticketIdentifier,
                isDuplicate: ticketInfo.isDuplicate,
                isSameReporter,
                files: msg.files,
              },
            });
          }
        } else {
          console.log(`Queuing orphan thread reply for triage (queue size: ${messageQueue.length + 1})`);
          messageQueue.push({
            type: "orphan_thread",
            data: {
              replyText: msg.text,
              userId: msg.user,
              channel: msg.channel,
              threadTs: msg.thread_ts,
              messageTs: msg.ts,
              files: msg.files,
            },
          });
        }
        processQueue(app, processNewMessage, processThreadReplyHandler, processOrphanThreadHandler, processDeferredFollowupHandler, processDirectCommandHandler, processEditedMessageHandler, processDeletedMessageHandler);
        return;
      }

      if (processedMessages.has(msg.ts)) {
        console.log("Skipping already processed message");
        return;
      }

      processedMessages.add(msg.ts);
      if (processedMessages.size > 1000) {
        const entries = Array.from(processedMessages);
        entries.slice(0, 500).forEach((ts) => processedMessages.delete(ts));
      }

      messageQueue.push({
        type: "new",
        data: {
          text: msg.text,
          user: msg.user,
          ts: msg.ts,
          channel: msg.channel,
          files: msg.files,
          attachments: msg.attachments,
        },
      });
      processQueue(app, processNewMessage, processThreadReplyHandler, processOrphanThreadHandler, processDeferredFollowupHandler, processDirectCommandHandler, processEditedMessageHandler, processDeletedMessageHandler);

    } catch (error) {
      console.error("Error queuing message:", error);
    }
  });

  // Listen for message edits
  app.event("message", async ({ event }) => {
    try {
      const msg = event as {
        subtype?: string;
        channel?: string;
        message?: {
          ts?: string;
          text?: string;
          user?: string;
          bot_id?: string;
        };
        previous_message?: {
          ts?: string;
          text?: string;
          thread_ts?: string;
        };
      };

      if (msg.subtype !== "message_changed") return;
      if (!msg.message || !msg.previous_message) return;
      if (!msg.message.user || !msg.message.ts) return;
      if (!msg.channel || msg.channel !== config.slackChannelId) return;
      if (msg.message.bot_id) return;

      console.log(`[Edit Event] Detected edit for message ${msg.message.ts}`);
      messageQueue.push({
        type: "message_edited",
        data: {
          messageTs: msg.message.ts,
          newText: msg.message.text || "",
          previousText: msg.previous_message.text || "",
          userId: msg.message.user,
          channel: msg.channel,
        },
      });
      processQueue(app, processNewMessage, processThreadReplyHandler, processOrphanThreadHandler, processDeferredFollowupHandler, processDirectCommandHandler, processEditedMessageHandler, processDeletedMessageHandler);
    } catch (error) {
      console.error("Error queuing message edit:", error);
    }
  });

  // Listen for message deletes
  app.event("message", async ({ event }) => {
    try {
      const msg = event as {
        subtype?: string;
        channel?: string;
        deleted_ts?: string;
        previous_message?: {
          ts?: string;
          thread_ts?: string;
        };
      };

      if (msg.subtype !== "message_deleted") return;
      if (!msg.deleted_ts || !msg.channel) return;
      if (msg.channel !== config.slackChannelId) return;

      console.log(`[Delete Event] Detected deletion of message ${msg.deleted_ts}`);
      messageQueue.push({
        type: "message_deleted",
        data: {
          messageTs: msg.deleted_ts,
          channel: msg.channel,
          threadTs: msg.previous_message?.thread_ts,
        },
      });
      processQueue(app, processNewMessage, processThreadReplyHandler, processOrphanThreadHandler, processDeferredFollowupHandler, processDirectCommandHandler, processEditedMessageHandler, processDeletedMessageHandler);
    } catch (error) {
      console.error("Error queuing message delete:", error);
    }
  });

  await recoverMissedMessages();

  if (messageQueue.length > 0) {
    console.log(`Processing ${messageQueue.length} recovered messages...`);
    await processQueue(app, processNewMessage, processThreadReplyHandler, processOrphanThreadHandler, processDeferredFollowupHandler, processDirectCommandHandler, processEditedMessageHandler, processDeletedMessageHandler);
  }

  await app.start();
  console.log(`\n${appConfig.productName} Triage Agent is running!`);
  console.log(`Listening for messages in channel: ${config.slackChannelId}`);

  if (!signalHandlersRegistered) {
    signalHandlersRegistered = true;
    const shutdown = async (signal: string): Promise<void> => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`\nReceived ${signal}, shutting down...`);
      if (slackApp) {
        await slackApp.stop();
      }
      process.exit(0);
    };

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
