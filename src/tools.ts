/**
 * tools.ts — Slack and Linear tools the agent can call, built per agent run.
 *
 * Every run gets a fresh set of tools bound to a RunRecorder. Tools write what
 * they actually did (ticket created, comment added, thread deferred) into the
 * recorder, so the caller learns the outcome from the tool calls themselves
 * rather than by parsing the model's prose.
 */

import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import type { LinearClient } from "@linear/sdk";
import type { App } from "@slack/bolt";
import config from "./config.js";

export interface Dependencies {
  slack: App["client"];
  linear: LinearClient;
  linearTeamId: string;
  /** Optional — when empty, tickets are created without a project and search spans the whole team. */
  linearProjectId?: string;
  slackBotToken: string;
}

export interface TicketRef {
  id: string;
  identifier: string;
  url: string;
}

/** What the agent actually did during one run. */
export class RunRecorder {
  created: TicketRef[] = [];
  commentedOn: TicketRef[] = [];
  updated: TicketRef[] = [];
  deferred = false;
  repliedInSlack = false;

  /** The ticket this run most directly acted on, preferring a newly created one. */
  primaryTicket(): TicketRef | undefined {
    return this.created[0] ?? this.commentedOn[0] ?? this.updated[0];
  }
}

let deps: Dependencies | null = null;

export function setDependencies(d: Dependencies): void {
  deps = d;
}

function requireDeps(): Dependencies {
  if (!deps) throw new Error("Dependencies not initialized - call setDependencies() first");
  return deps;
}

async function toTicketRef(issueId: string): Promise<TicketRef> {
  const issue = await requireDeps().linear.issue(issueId);
  return { id: issue.id, identifier: issue.identifier, url: issue.url };
}

/** Find a workflow state on the issue's team: exact name match first, then the first state of `fallbackType`. */
async function findTeamState(issueId: string, name: string, fallbackType?: string) {
  const { linear } = requireDeps();
  const issue = await linear.issue(issueId);
  const team = await issue.team;
  if (!team) throw new Error("Could not find team for issue");
  const states = (await team.states()).nodes;
  const target =
    states.find((s) => s.name.toLowerCase() === name.toLowerCase()) ??
    (fallbackType ? states.find((s) => s.type === fallbackType) : undefined);
  return { issue, states, target };
}

const priority = z.number().int().min(1).max(4).describe("1=Urgent, 2=High, 3=Normal, 4=Low");
const issueIdArg = z.string().describe("Linear issue UUID or identifier (e.g. ENG-123)");

/** All tools, keyed by name. Each agent flow picks the subset it needs. */
export function createTools(recorder: RunRecorder) {
  const { issueTemplate } = config;

  const slack_get_user_info = betaZodTool({
    name: "slack_get_user_info",
    description: "Get a Slack user's real name and email from their user ID.",
    inputSchema: z.object({ userId: z.string().describe("Slack user ID, e.g. U0123ABCD") }),
    run: async ({ userId }) => {
      const result = await requireDeps().slack.users.info({ user: userId });
      if (!result.user) throw new Error("User not found");
      return JSON.stringify({
        id: result.user.id,
        name: result.user.name,
        realName: result.user.real_name,
        email: result.user.profile?.email,
      });
    },
  });

  const linear_search_issues = betaZodTool({
    name: "linear_search_issues",
    description:
      "Search existing Linear issues for potential duplicates. Issues matching ANY keyword (title or description) are returned, so pass the literal terms plus synonyms in one call.",
    inputSchema: z.object({
      keywords: z.array(z.string()).min(1).describe("Search keywords, OR-ed together"),
    }),
    run: async ({ keywords }) => {
      const { linear, linearTeamId, linearProjectId } = requireDeps();
      const issues = await linear.issues({
        filter: {
          ...(linearProjectId
            ? { project: { id: { eq: linearProjectId } } }
            : { team: { id: { eq: linearTeamId } } }),
          or: keywords.flatMap((keyword) => [
            { title: { containsIgnoreCase: keyword } },
            { description: { containsIgnoreCase: keyword } },
          ]),
        },
        first: 15,
      });
      const results = await Promise.all(
        issues.nodes.map(async (issue) => ({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          state: (await issue.state)?.name,
        })),
      );
      return JSON.stringify({ issues: results, searchedKeywords: keywords });
    },
  });

  const linear_create_issue = betaZodTool({
    name: "linear_create_issue",
    description: issueTemplate.titlePrefix
      ? `Create a new Linear issue. The "${issueTemplate.titlePrefix}" title prefix is added automatically.`
      : "Create a new Linear issue.",
    inputSchema: z.object({
      title: z.string().describe(
        issueTemplate.titlePrefix
          ? `Issue title without the "${issueTemplate.titlePrefix}" prefix, max 80 chars`
          : "Issue title, max 80 chars",
      ),
      description: z.string().describe("Issue description in Markdown"),
      priority,
      reporterInfo: z.string().describe('Reporter attribution, e.g. "Jane Doe (jane@example.com)"'),
    }),
    run: async ({ title, description, priority, reporterInfo }) => {
      const { linear, linearTeamId, linearProjectId } = requireDeps();
      const payload = await linear.createIssue({
        teamId: linearTeamId,
        ...(linearProjectId && { projectId: linearProjectId }),
        title: `${issueTemplate.titlePrefix}${title}`,
        description: `${description}\n\n---\n**Reported via Slack by:** ${reporterInfo}`,
        priority,
        ...(issueTemplate.labelIds.length > 0 && { labelIds: issueTemplate.labelIds }),
        ...(issueTemplate.stateId && { stateId: issueTemplate.stateId }),
      });
      const issue = await payload.issue;
      if (!issue) throw new Error("Issue creation failed");
      const ref = { id: issue.id, identifier: issue.identifier, url: issue.url };
      recorder.created.push(ref);
      return JSON.stringify(ref);
    },
  });

  const linear_add_comment = betaZodTool({
    name: "linear_add_comment",
    description: "Add a comment to an existing Linear issue (for duplicates and follow-up context).",
    inputSchema: z.object({
      issueId: issueIdArg,
      body: z.string().describe("Comment body in Markdown"),
    }),
    run: async ({ issueId, body }) => {
      const ref = await toTicketRef(issueId);
      await requireDeps().linear.createComment({ issueId: ref.id, body });
      recorder.commentedOn.push(ref);
      return JSON.stringify({ success: true, ...ref });
    },
  });

  const linear_get_issue = betaZodTool({
    name: "linear_get_issue",
    description: "Get a Linear issue's current title, description, priority, and status.",
    inputSchema: z.object({ issueId: issueIdArg }),
    run: async ({ issueId }) => {
      const issue = await requireDeps().linear.issue(issueId);
      return JSON.stringify({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        status: (await issue.state)?.name,
        url: issue.url,
      });
    },
  });

  const linear_update_issue = betaZodTool({
    name: "linear_update_issue",
    description:
      "Update a Linear issue's description and/or priority. The description replaces the existing one, so include the original content plus the new information.",
    inputSchema: z.object({
      issueId: issueIdArg,
      description: z.string().optional().describe("Full replacement description in Markdown"),
      priority: priority.optional(),
    }),
    run: async ({ issueId, description, priority }) => {
      const ref = await toTicketRef(issueId);
      await requireDeps().linear.updateIssue(ref.id, {
        ...(description !== undefined && { description }),
        ...(priority !== undefined && { priority }),
      });
      recorder.updated.push(ref);
      return JSON.stringify({ success: true, ...ref });
    },
  });

  const slack_reply_in_thread = betaZodTool({
    name: "slack_reply_in_thread",
    description: "Post a reply in the Slack thread. Use Slack mrkdwn (*bold*, _italic_), not Markdown.",
    inputSchema: z.object({
      text: z.string().describe("Message text"),
      channel: z.string().describe("Slack channel ID (given in the prompt)"),
      threadTs: z.string().describe("Thread timestamp to reply to (given in the prompt)"),
    }),
    run: async ({ text, channel, threadTs }) => {
      await requireDeps().slack.chat.postMessage({ channel, thread_ts: threadTs, text });
      recorder.repliedInSlack = true;
      return JSON.stringify({ success: true });
    },
  });

  const slack_defer_to_team = betaZodTool({
    name: "slack_defer_to_team",
    description:
      "Reply in the thread and hand the topic to the team WITHOUT creating a ticket. Use this (instead of slack_reply_in_thread) whenever you decide to DEFER. The thread is then watched for follow-ups.",
    inputSchema: z.object({
      text: z.string().describe("Helpful context, ending with a hand-off to the team. Slack mrkdwn."),
      channel: z.string().describe("Slack channel ID (given in the prompt)"),
      threadTs: z.string().describe("Thread timestamp to reply to (given in the prompt)"),
    }),
    run: async ({ text, channel, threadTs }) => {
      await requireDeps().slack.chat.postMessage({ channel, thread_ts: threadTs, text });
      recorder.deferred = true;
      recorder.repliedInSlack = true;
      return JSON.stringify({ success: true, deferred: true });
    },
  });

  const slack_add_reaction = betaZodTool({
    name: "slack_add_reaction",
    description: "Add an emoji reaction to a Slack message - a quieter acknowledgment than a reply.",
    inputSchema: z.object({
      channel: z.string().describe("Slack channel ID"),
      messageTs: z.string().describe("Timestamp of the message to react to (the reply's ts, not the thread ts)"),
      emoji: z.string().describe("Emoji name without colons, e.g. thumbsup"),
    }),
    run: async ({ channel, messageTs, emoji }) => {
      await requireDeps().slack.reactions.add({ channel, timestamp: messageTs, name: emoji });
      return JSON.stringify({ success: true });
    },
  });

  // --- Command tools (for @mention commands) ---

  const linear_update_status = betaZodTool({
    name: "linear_update_status",
    description: "Set a Linear issue's workflow status by name (e.g. Triage, Todo, In Progress, Done, Canceled).",
    inputSchema: z.object({ issueId: issueIdArg, statusName: z.string() }),
    run: async ({ issueId, statusName }) => {
      const { issue, states, target } = await findTeamState(issueId, statusName);
      if (!target) {
        throw new Error(`Status "${statusName}" not found. Available: ${states.map((s) => s.name).join(", ")}`);
      }
      await requireDeps().linear.updateIssue(issue.id, { stateId: target.id });
      recorder.updated.push({ id: issue.id, identifier: issue.identifier, url: issue.url });
      return JSON.stringify({ success: true, newStatus: target.name });
    },
  });

  const linear_close_issue = betaZodTool({
    name: "linear_close_issue",
    description: "Close a Linear issue as done (completed) or canceled (won't do).",
    inputSchema: z.object({
      issueId: issueIdArg,
      reason: z.enum(["done", "canceled"]).default("done"),
    }),
    run: async ({ issueId, reason }) => {
      const [name, type] = reason === "canceled" ? ["Canceled", "canceled"] : ["Done", "completed"];
      const { issue, target } = await findTeamState(issueId, name, type);
      if (!target) throw new Error(`No ${name} status found for this team`);
      await requireDeps().linear.updateIssue(issue.id, { stateId: target.id });
      recorder.updated.push({ id: issue.id, identifier: issue.identifier, url: issue.url });
      return JSON.stringify({ success: true, newStatus: target.name });
    },
  });

  const linear_reopen_issue = betaZodTool({
    name: "linear_reopen_issue",
    description: "Reopen a closed Linear issue by moving it back to Triage (default) or Todo.",
    inputSchema: z.object({
      issueId: issueIdArg,
      status: z.enum(["triage", "todo"]).default("triage"),
    }),
    run: async ({ issueId, status }) => {
      const [name, type] = status === "todo" ? ["Todo", "unstarted"] : ["Triage", "triage"];
      const { issue, target } = await findTeamState(issueId, name, type);
      if (!target) throw new Error(`No ${name} status found for this team`);
      await requireDeps().linear.updateIssue(issue.id, { stateId: target.id });
      recorder.updated.push({ id: issue.id, identifier: issue.identifier, url: issue.url });
      return JSON.stringify({ success: true, newStatus: target.name });
    },
  });

  const linear_add_label = betaZodTool({
    name: "linear_add_label",
    description: "Add a label (by name) to a Linear issue.",
    inputSchema: z.object({ issueId: issueIdArg, labelName: z.string() }),
    run: async ({ issueId, labelName }) => {
      const { linear } = requireDeps();
      const issue = await linear.issue(issueId);
      const team = await issue.team;
      if (!team) throw new Error("Could not find team for issue");
      const labels = (await team.labels()).nodes;
      const target = labels.find((l) => l.name.toLowerCase() === labelName.toLowerCase());
      if (!target) {
        throw new Error(`Label "${labelName}" not found. Available: ${labels.map((l) => l.name).join(", ")}`);
      }
      // addedLabelIds/removedLabelIds are atomic, so parallel label calls in one turn don't overwrite each other.
      await linear.updateIssue(issue.id, { addedLabelIds: [target.id] });
      recorder.updated.push({ id: issue.id, identifier: issue.identifier, url: issue.url });
      return JSON.stringify({ success: true, label: target.name });
    },
  });

  const linear_remove_label = betaZodTool({
    name: "linear_remove_label",
    description: "Remove a label (by name) from a Linear issue.",
    inputSchema: z.object({ issueId: issueIdArg, labelName: z.string() }),
    run: async ({ issueId, labelName }) => {
      const { linear } = requireDeps();
      const issue = await linear.issue(issueId);
      const current = (await issue.labels()).nodes;
      const target = current.find((l) => l.name.toLowerCase() === labelName.toLowerCase());
      if (!target) return JSON.stringify({ success: true, message: "Label was not on the issue" });
      await linear.updateIssue(issue.id, { removedLabelIds: [target.id] });
      recorder.updated.push({ id: issue.id, identifier: issue.identifier, url: issue.url });
      return JSON.stringify({ success: true, removedLabel: target.name });
    },
  });

  const linear_assign_issue = betaZodTool({
    name: "linear_assign_issue",
    description: "Assign a Linear issue to a user, matched by name or email.",
    inputSchema: z.object({ issueId: issueIdArg, userName: z.string().describe("Name or email") }),
    run: async ({ issueId, userName }) => {
      const { linear } = requireDeps();
      const needle = userName.toLowerCase();
      const users = await linear.users({
        filter: { or: [{ name: { containsIgnoreCase: needle } }, { email: { containsIgnoreCase: needle } }] },
        first: 5,
      });
      const target = users.nodes[0];
      if (!target) throw new Error(`User "${userName}" not found`);
      const issue = await linear.issue(issueId);
      await linear.updateIssue(issue.id, { assigneeId: target.id });
      recorder.updated.push({ id: issue.id, identifier: issue.identifier, url: issue.url });
      return JSON.stringify({ success: true, assignedTo: target.name });
    },
  });

  const linear_link_issues = betaZodTool({
    name: "linear_link_issues",
    description: "Create a relation between two Linear issues.",
    inputSchema: z.object({
      issueId: issueIdArg,
      relatedIssueId: issueIdArg,
      relationType: z.enum(["blocks", "blocked_by", "related", "duplicate"]),
    }),
    run: async ({ issueId, relatedIssueId, relationType }) => {
      const { linear } = requireDeps();
      const [issue, related] = await Promise.all([linear.issue(issueId), linear.issue(relatedIssueId)]);
      const [source, target] = relationType === "blocked_by" ? [related, issue] : [issue, related];
      await linear.createIssueRelation({
        issueId: source.id,
        relatedIssueId: target.id,
        type: (relationType === "blocked_by" ? "blocks" : relationType) as never,
      });
      return JSON.stringify({ success: true, relation: `${issue.identifier} ${relationType} ${related.identifier}` });
    },
  });

  const linear_update_title = betaZodTool({
    name: "linear_update_title",
    description: "Change a Linear issue's title.",
    inputSchema: z.object({ issueId: issueIdArg, title: z.string() }),
    run: async ({ issueId, title }) => {
      const ref = await toTicketRef(issueId);
      await requireDeps().linear.updateIssue(ref.id, { title });
      recorder.updated.push(ref);
      return JSON.stringify({ success: true, newTitle: title });
    },
  });

  return {
    slack_get_user_info,
    linear_search_issues,
    linear_create_issue,
    linear_add_comment,
    linear_get_issue,
    linear_update_issue,
    slack_reply_in_thread,
    slack_defer_to_team,
    slack_add_reaction,
    linear_update_status,
    linear_close_issue,
    linear_reopen_issue,
    linear_add_label,
    linear_remove_label,
    linear_assign_issue,
    linear_link_issues,
    linear_update_title,
  } satisfies Record<string, BetaRunnableTool<any>>;
}

export type ToolName = keyof ReturnType<typeof createTools>;

// ---------------------------------------------------------------------------
// Image upload (runs before the agent, not a tool)
// ---------------------------------------------------------------------------

export interface UploadedImage {
  url: string;
  buffer: Buffer;
  contentType: string;
}

/** Download a Slack-hosted image and re-host it on Linear's CDN so tickets can embed it. */
export async function uploadImageToLinearCdn(
  slackPrivateUrl: string,
  filename: string,
  contentType: string,
): Promise<UploadedImage | null> {
  const { linear, slackBotToken } = requireDeps();
  try {
    const slackResponse = await fetch(slackPrivateUrl, {
      headers: { Authorization: `Bearer ${slackBotToken}` },
    });
    if (!slackResponse.ok) {
      console.error(`Failed to download from Slack: ${slackResponse.status}`);
      return null;
    }
    const buffer = Buffer.from(await slackResponse.arrayBuffer());

    const uploadPayload = await linear.fileUpload(contentType, filename, buffer.length);
    if (!uploadPayload.success || !uploadPayload.uploadFile) {
      console.error("Failed to get Linear upload URL");
      return null;
    }
    const { uploadUrl, assetUrl, headers } = uploadPayload.uploadFile;

    const uploadHeaders: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=31536000",
    };
    for (const h of headers ?? []) uploadHeaders[h.key] = h.value;

    const uploadResponse = await fetch(uploadUrl, { method: "PUT", headers: uploadHeaders, body: buffer });
    if (!uploadResponse.ok) {
      console.error(`Failed to upload to Linear: ${uploadResponse.status} - ${await uploadResponse.text()}`);
      return null;
    }
    console.log(`Image uploaded to Linear CDN: ${assetUrl}`);
    return { url: assetUrl, buffer, contentType };
  } catch (e) {
    console.error("Error uploading image:", e);
    return null;
  }
}
