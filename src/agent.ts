import { query, createSdkMcpServer, tool, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { LinearClient } from "@linear/sdk";
import pkg from "@slack/bolt";
type App = InstanceType<typeof pkg.App>;
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

// Dependencies that will be injected
let slackApp: App | null = null;
let linearClient: LinearClient | null = null;
let linearConfig: { teamId: string; projectId: string } | null = null;

export function setDependencies(
  app: App,
  client: LinearClient,
  cfg: { teamId: string; projectId: string }
): void {
  slackApp = app;
  linearClient = client;
  linearConfig = cfg;
}

// Define tools using the SDK's tool() helper
const getUserInfo = tool(
  "slack_get_user_info",
  "Get information about a Slack user including their real name and email",
  { userId: z.string().describe("The Slack user ID") },
  async ({ userId }) => {
    if (!slackApp) throw new Error("Slack app not initialized");
    try {
      const result = await slackApp.client.users.info({ user: userId });
      if (!result.user) {
        return { content: [{ type: "text" as const, text: "User not found" }], isError: true };
      }
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            id: result.user.id,
            name: result.user.name,
            realName: result.user.real_name,
            email: result.user.profile?.email,
          }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const searchIssues = tool(
  "linear_search_issues",
  "Search for existing Linear issues to find potential duplicates. Pass multiple keywords to search for any of them (OR logic). For best results, include semantic synonyms.",
  {
    keywords: z.array(z.string()).describe("Array of search keywords - issues matching ANY keyword will be returned")
  },
  async ({ keywords }) => {
    if (!linearClient || !linearConfig) throw new Error("Linear not initialized");
    try {
      // Build OR conditions for each keyword across title and description
      const orConditions = keywords.flatMap(keyword => [
        { title: { containsIgnoreCase: keyword } },
        { description: { containsIgnoreCase: keyword } },
      ]);

      const issues = await linearClient.issues({
        filter: {
          project: { id: { eq: linearConfig.projectId } },
          or: orConditions,
        },
        first: 10,
      });
      const results = await Promise.all(
        issues.nodes.map(async (issue) => {
          const state = await issue.state;
          return { id: issue.id, identifier: issue.identifier, title: issue.title, url: issue.url, state: state?.name };
        })
      );
      return { content: [{ type: "text" as const, text: JSON.stringify({ issues: results, searchedKeywords: keywords }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const createIssueToolDescription = config.issueTemplate.titlePrefix
  ? `Create a new Linear issue. The "${config.issueTemplate.titlePrefix}" prefix is added automatically to the title.`
  : "Create a new Linear issue in the configured project.";

const createIssue = tool(
  "linear_create_issue",
  createIssueToolDescription,
  {
    title: z.string().describe(
      config.issueTemplate.titlePrefix
        ? `Issue title (without prefix - the '${config.issueTemplate.titlePrefix}' prefix is added automatically)`
        : "Issue title"
    ),
    description: z.string().describe("Detailed issue description"),
    priority: z.number().min(1).max(4).describe("1=Urgent, 2=High, 3=Normal, 4=Low"),
    reporterInfo: z.string().describe("Reporter info for attribution"),
  },
  async ({ title, description, priority, reporterInfo }) => {
    if (!linearClient || !linearConfig) throw new Error("Linear not initialized");
    try {
      const fullDescription = `${description}\n\n---\n**Reported via Slack by:** ${reporterInfo}`;
      const payload = await linearClient.createIssue({
        teamId: linearConfig.teamId,
        projectId: linearConfig.projectId,
        title: config.issueTemplate.titlePrefix ? `${config.issueTemplate.titlePrefix}${title}` : title,
        description: fullDescription,
        priority,
        ...(config.issueTemplate.labelIds.length > 0 && { labelIds: config.issueTemplate.labelIds }),
        ...(config.issueTemplate.stateId && { stateId: config.issueTemplate.stateId }),
      });
      const issue = await payload.issue;
      if (!issue) return { content: [{ type: "text" as const, text: "Issue creation failed" }], isError: true };
      return { content: [{ type: "text" as const, text: JSON.stringify({ id: issue.id, identifier: issue.identifier, url: issue.url }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const addComment = tool(
  "linear_add_comment",
  "Add a comment to an existing Linear issue (use for duplicates or follow-up info)",
  {
    issueId: z.string().describe("The Linear issue ID"),
    body: z.string().describe("Comment body in Markdown"),
  },
  async ({ issueId, body }) => {
    if (!linearClient) throw new Error("Linear not initialized");
    try {
      await linearClient.createComment({ issueId, body });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const updateIssue = tool(
  "linear_update_issue",
  "Update an existing Linear issue's description or priority based on new information",
  {
    issueId: z.string().describe("The Linear issue ID"),
    description: z.string().optional().describe("New description (replaces existing). Include all original content plus new info."),
    priority: z.number().min(1).max(4).optional().describe("New priority: 1=Urgent, 2=High, 3=Normal, 4=Low"),
  },
  async ({ issueId, description, priority }) => {
    if (!linearClient) throw new Error("Linear not initialized");
    try {
      const updateData: { description?: string; priority?: number } = {};
      if (description) updateData.description = description;
      if (priority) updateData.priority = priority;

      await linearClient.updateIssue(issueId, updateData);
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const getIssue = tool(
  "linear_get_issue",
  "Get the current details of a Linear issue including its description and priority",
  {
    issueId: z.string().describe("The Linear issue ID"),
  },
  async ({ issueId }) => {
    if (!linearClient) throw new Error("Linear not initialized");
    try {
      const issue = await linearClient.issue(issueId);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            description: issue.description,
            priority: issue.priority,
            url: issue.url,
          }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const uploadImageToLinear = tool(
  "upload_slack_image_to_linear",
  "Download an image from Slack and upload it to Linear's CDN. Returns a public URL that can be embedded in ticket descriptions.",
  {
    slackPrivateUrl: z.string().describe("The Slack url_private or url_private_download URL for the image"),
    filename: z.string().describe("The filename for the image (e.g., 'screenshot.png')"),
    contentType: z.string().describe("The MIME type (e.g., 'image/png')"),
  },
  async ({ slackPrivateUrl, filename, contentType }) => {
    if (!slackApp || !linearClient) throw new Error("Clients not initialized");
    try {
      const slackResponse = await fetch(slackPrivateUrl, {
        headers: {
          Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
        },
      });
      if (!slackResponse.ok) {
        return { content: [{ type: "text" as const, text: `Failed to download from Slack: ${slackResponse.status}` }], isError: true };
      }
      const imageBuffer = Buffer.from(await slackResponse.arrayBuffer());
      const imageSize = imageBuffer.length;

      const uploadPayload = await linearClient.fileUpload(contentType, filename, imageSize);
      if (!uploadPayload.success || !uploadPayload.uploadFile) {
        return { content: [{ type: "text" as const, text: "Failed to get Linear upload URL" }], isError: true };
      }

      const { uploadUrl, assetUrl, headers: uploadHeaders } = uploadPayload.uploadFile;

      const headerObj: Record<string, string> = {};
      if (uploadHeaders) {
        for (const h of uploadHeaders) {
          headerObj[h.key] = h.value;
        }
      }
      headerObj["Content-Type"] = contentType;
      headerObj["Cache-Control"] = "public, max-age=31536000";

      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: headerObj,
        body: imageBuffer,
      });

      if (!uploadResponse.ok) {
        return { content: [{ type: "text" as const, text: `Failed to upload to Linear: ${uploadResponse.status}` }], isError: true };
      }

      return { content: [{ type: "text" as const, text: JSON.stringify({ url: assetUrl }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

// Result type for image upload - includes both URL and buffer for vision
export interface ImageUploadResult {
  url: string;
  buffer: Buffer;
  contentType: string;
}

// Direct function to upload image (not a tool - called before agent runs)
export async function uploadImageToLinearCdn(
  slackPrivateUrl: string,
  filename: string,
  contentType: string
): Promise<ImageUploadResult | null> {
  if (!linearClient) throw new Error("Linear client not initialized");
  try {
    const slackResponse = await fetch(slackPrivateUrl, {
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`,
      },
    });
    if (!slackResponse.ok) {
      console.error(`Failed to download from Slack: ${slackResponse.status}`);
      return null;
    }

    const arrayBuffer = await slackResponse.arrayBuffer();
    const imageBuffer = Buffer.from(arrayBuffer);
    const imageSize = imageBuffer.length;
    console.log(`Downloaded ${imageSize} bytes from Slack`);

    const uploadPayload = await linearClient.fileUpload(contentType, filename, imageSize);
    if (!uploadPayload.success || !uploadPayload.uploadFile) {
      console.error("Failed to get Linear upload URL");
      return null;
    }

    const { uploadUrl, assetUrl, headers: uploadHeaders } = uploadPayload.uploadFile;

    const headerObj: Record<string, string> = {};
    headerObj["Content-Type"] = contentType;
    headerObj["Cache-Control"] = "public, max-age=31536000";

    if (uploadHeaders) {
      for (const h of uploadHeaders) {
        headerObj[h.key] = h.value;
      }
    }

    const uploadResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: headerObj,
      body: imageBuffer,
    });

    if (!uploadResponse.ok) {
      const responseText = await uploadResponse.text();
      console.error(`Failed to upload to Linear: ${uploadResponse.status} - ${responseText}`);
      return null;
    }

    console.log(`Image uploaded to Linear CDN: ${assetUrl}`);
    await new Promise(resolve => setTimeout(resolve, 500));

    return { url: assetUrl, buffer: imageBuffer, contentType };
  } catch (e) {
    console.error(`Error uploading image:`, e);
    return null;
  }
}

const replyInThread = tool(
  "slack_reply_in_thread",
  "Reply to the Slack message with the ticket link",
  {
    text: z.string().describe("Message to send"),
    channel: z.string().describe("The Slack channel ID (provided in the prompt)"),
    threadTs: z.string().describe("The thread timestamp to reply to (provided in the prompt)"),
  },
  async ({ text, channel, threadTs }) => {
    if (!slackApp) throw new Error("Slack not initialized");
    try {
      await slackApp.client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const addReaction = tool(
  "slack_add_reaction",
  "Add an emoji reaction to a Slack message (e.g., thumbsup). Use this instead of a full reply for simple acknowledgments.",
  {
    channel: z.string().describe("The Slack channel ID"),
    messageTs: z.string().describe("The timestamp of the message to react to (the reply's ts, NOT the thread ts)"),
    emoji: z.string().describe("The emoji name without colons (e.g., 'thumbsup', '+1', 'white_check_mark')"),
  },
  async ({ channel, messageTs, emoji }) => {
    if (!slackApp) throw new Error("Slack not initialized");
    try {
      await slackApp.client.reactions.add({
        channel,
        timestamp: messageTs,
        name: emoji,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

// --- Command Tools (for @mention commands) ---

const updateIssueStatus = tool(
  "linear_update_status",
  "Update the status of a Linear issue",
  {
    issueId: z.string().describe("The Linear issue ID or identifier (e.g., WOR-123)"),
    statusName: z.string().describe("The new status name (e.g., 'Triage', 'Todo', 'In Progress', 'Done', 'Canceled')"),
  },
  async ({ issueId, statusName }) => {
    if (!linearClient || !linearConfig) throw new Error("Linear not initialized");
    try {
      const issue = await linearClient.issue(issueId);
      const team = await issue.team;
      if (!team) {
        return { content: [{ type: "text" as const, text: "Could not find team for issue" }], isError: true };
      }

      const states = await team.states();
      const targetState = states.nodes.find(
        (s) => s.name.toLowerCase() === statusName.toLowerCase()
      );
      if (!targetState) {
        const availableStates = states.nodes.map((s) => s.name).join(", ");
        return {
          content: [{
            type: "text" as const,
            text: `Status "${statusName}" not found. Available statuses: ${availableStates}`,
          }],
          isError: true,
        };
      }

      await linearClient.updateIssue(issue.id, { stateId: targetState.id });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, newStatus: targetState.name }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const addLabel = tool(
  "linear_add_label",
  "Add a label to a Linear issue",
  {
    issueId: z.string().describe("The Linear issue ID or identifier"),
    labelName: z.string().describe("The label name to add"),
  },
  async ({ issueId, labelName }) => {
    if (!linearClient || !linearConfig) throw new Error("Linear not initialized");
    try {
      const issue = await linearClient.issue(issueId);
      const team = await issue.team;
      if (!team) {
        return { content: [{ type: "text" as const, text: "Could not find team for issue" }], isError: true };
      }

      const labels = await team.labels();
      const targetLabel = labels.nodes.find(
        (l) => l.name.toLowerCase() === labelName.toLowerCase()
      );
      if (!targetLabel) {
        const availableLabels = labels.nodes.map((l) => l.name).join(", ");
        return {
          content: [{
            type: "text" as const,
            text: `Label "${labelName}" not found. Available labels: ${availableLabels}`,
          }],
          isError: true,
        };
      }

      const currentLabels = await issue.labels();
      const currentLabelIds = currentLabels.nodes.map((l) => l.id);
      if (currentLabelIds.includes(targetLabel.id)) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Label already exists on issue" }) }] };
      }

      await linearClient.updateIssue(issue.id, { labelIds: [...currentLabelIds, targetLabel.id] });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, addedLabel: targetLabel.name }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const removeLabel = tool(
  "linear_remove_label",
  "Remove a label from a Linear issue",
  {
    issueId: z.string().describe("The Linear issue ID or identifier"),
    labelName: z.string().describe("The label name to remove"),
  },
  async ({ issueId, labelName }) => {
    if (!linearClient) throw new Error("Linear not initialized");
    try {
      const issue = await linearClient.issue(issueId);
      const currentLabels = await issue.labels();
      const labelToRemove = currentLabels.nodes.find(
        (l) => l.name.toLowerCase() === labelName.toLowerCase()
      );
      if (!labelToRemove) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, message: "Label not on issue" }) }] };
      }

      const newLabelIds = currentLabels.nodes
        .filter((l) => l.id !== labelToRemove.id)
        .map((l) => l.id);
      await linearClient.updateIssue(issue.id, { labelIds: newLabelIds });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, removedLabel: labelToRemove.name }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const assignIssue = tool(
  "linear_assign_issue",
  "Assign a Linear issue to a user",
  {
    issueId: z.string().describe("The Linear issue ID or identifier"),
    userName: z.string().describe("The user's name or email to assign to"),
  },
  async ({ issueId, userName }) => {
    if (!linearClient) throw new Error("Linear not initialized");
    try {
      const users = await linearClient.users();
      const targetUser = users.nodes.find(
        (u) =>
          u.name.toLowerCase().includes(userName.toLowerCase()) ||
          u.email?.toLowerCase().includes(userName.toLowerCase())
      );
      if (!targetUser) {
        return {
          content: [{
            type: "text" as const,
            text: `User "${userName}" not found`,
          }],
          isError: true,
        };
      }

      const issue = await linearClient.issue(issueId);
      await linearClient.updateIssue(issue.id, { assigneeId: targetUser.id });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, assignedTo: targetUser.name }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const closeIssue = tool(
  "linear_close_issue",
  "Close/complete a Linear issue by setting it to Done or Canceled status",
  {
    issueId: z.string().describe("The Linear issue ID or identifier"),
    reason: z.enum(["done", "canceled"]).optional().describe("Close reason: 'done' (completed) or 'canceled' (won't do). Defaults to 'done'"),
  },
  async ({ issueId, reason = "done" }) => {
    if (!linearClient) throw new Error("Linear not initialized");
    try {
      const issue = await linearClient.issue(issueId);
      const team = await issue.team;
      if (!team) {
        return { content: [{ type: "text" as const, text: "Could not find team for issue" }], isError: true };
      }

      const states = await team.states();
      const targetStateName = reason === "canceled" ? "Canceled" : "Done";
      const targetState = states.nodes.find(
        (s) => s.name.toLowerCase() === targetStateName.toLowerCase() || s.type === (reason === "canceled" ? "canceled" : "completed")
      );
      if (!targetState) {
        return { content: [{ type: "text" as const, text: `Could not find ${targetStateName} status` }], isError: true };
      }

      await linearClient.updateIssue(issue.id, { stateId: targetState.id });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, newStatus: targetState.name }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const reopenIssue = tool(
  "linear_reopen_issue",
  "Reopen a closed Linear issue by setting it back to Triage or Todo",
  {
    issueId: z.string().describe("The Linear issue ID or identifier"),
    status: z.enum(["triage", "todo"]).optional().describe("Status to set: 'triage' or 'todo'. Defaults to 'triage'"),
  },
  async ({ issueId, status = "triage" }) => {
    if (!linearClient) throw new Error("Linear not initialized");
    try {
      const issue = await linearClient.issue(issueId);
      const team = await issue.team;
      if (!team) {
        return { content: [{ type: "text" as const, text: "Could not find team for issue" }], isError: true };
      }

      const states = await team.states();
      const targetStateName = status === "todo" ? "Todo" : "Triage";
      const targetState = states.nodes.find(
        (s) => s.name.toLowerCase() === targetStateName.toLowerCase()
      );
      if (!targetState) {
        return { content: [{ type: "text" as const, text: `Could not find ${targetStateName} status` }], isError: true };
      }

      await linearClient.updateIssue(issue.id, { stateId: targetState.id });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, newStatus: targetState.name }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const linkIssues = tool(
  "linear_link_issues",
  "Create a relation/link between two Linear issues",
  {
    issueId: z.string().describe("The source issue ID or identifier"),
    relatedIssueId: z.string().describe("The target issue ID or identifier to link to"),
    relationType: z.enum(["blocks", "blocked_by", "related", "duplicate"]).describe("Type of relation: 'blocks', 'blocked_by', 'related', or 'duplicate'"),
  },
  async ({ issueId, relatedIssueId, relationType }) => {
    if (!linearClient) throw new Error("Linear not initialized");
    try {
      const issue = await linearClient.issue(issueId);
      const relatedIssue = await linearClient.issue(relatedIssueId);

      const sourceId = relationType === "blocked_by" ? relatedIssue.id : issue.id;
      const targetId = relationType === "blocked_by" ? issue.id : relatedIssue.id;
      const typeValue = relationType === "blocked_by" ? "blocks" : relationType;

      await linearClient.createIssueRelation({
        issueId: sourceId,
        relatedIssueId: targetId,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        type: typeValue as any,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            success: true,
            relation: `${issue.identifier} ${relationType} ${relatedIssue.identifier}`,
          }),
        }],
      };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

const updateTitle = tool(
  "linear_update_title",
  "Update the title of a Linear issue",
  {
    issueId: z.string().describe("The Linear issue ID or identifier"),
    title: z.string().describe("The new title for the issue"),
  },
  async ({ issueId, title }) => {
    if (!linearClient) throw new Error("Linear not initialized");
    try {
      const issue = await linearClient.issue(issueId);
      await linearClient.updateIssue(issue.id, { title });
      return { content: [{ type: "text" as const, text: JSON.stringify({ success: true, newTitle: title }) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Error: ${e}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// MCP Servers
// ---------------------------------------------------------------------------

const triageServer = createSdkMcpServer({
  name: "triage-tools",
  version: "1.0.0",
  tools: [getUserInfo, searchIssues, createIssue, addComment, replyInThread, uploadImageToLinear],
});

const commandServer = createSdkMcpServer({
  name: "command-tools",
  version: "1.0.0",
  tools: [
    getUserInfo,
    getIssue,
    updateIssue,
    addComment,
    replyInThread,
    searchIssues,
    createIssue,
    updateIssueStatus,
    addLabel,
    removeLabel,
    assignIssue,
    closeIssue,
    reopenIssue,
    linkIssues,
    updateTitle,
  ],
});

const followupServer = createSdkMcpServer({
  name: "followup-tools",
  version: "1.0.0",
  tools: [getUserInfo, getIssue, updateIssue, addComment, replyInThread, addReaction],
});

const deferredFollowupServer = createSdkMcpServer({
  name: "deferred-tools",
  version: "1.0.0",
  tools: [getUserInfo, searchIssues, createIssue, addComment, replyInThread],
});

const editHandlerServer = createSdkMcpServer({
  name: "edit-handler-tools",
  version: "1.0.0",
  tools: [getUserInfo, getIssue, updateIssue, addComment],
});

const deleteHandlerServer = createSdkMcpServer({
  name: "delete-handler-tools",
  version: "1.0.0",
  tools: [addComment],
});

// ---------------------------------------------------------------------------
// Build system prompts from config
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = buildTriageSystemPrompt(config);
const COMMAND_SYSTEM_PROMPT = buildCommandSystemPrompt(config);
const ORPHAN_THREAD_SYSTEM_PROMPT = buildOrphanThreadPrompt(config);
const FOLLOWUP_SYSTEM_PROMPT_SAME_REPORTER = buildFollowupSameReporterPrompt(config);
const FOLLOWUP_SYSTEM_PROMPT_DIFFERENT_PERSON = buildFollowupDifferentPersonPrompt(config);
const DEFERRED_FOLLOWUP_SYSTEM_PROMPT = buildDeferredFollowupPrompt(config);
const MESSAGE_EDIT_SYSTEM_PROMPT = buildEditHandlerPrompt(config);
const MESSAGE_DELETE_SYSTEM_PROMPT = buildDeleteHandlerPrompt(config);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageAttachment {
  url_private: string;
  filename: string;
  mimetype: string;
}

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

export interface TriageResult {
  action: "created" | "duplicate" | "skipped" | "deferred" | "error";
  ticketId?: string;
  ticketUrl?: string;
  ticketIdentifier?: string;
  message: string;
}

// Content block types for multi-modal prompts (Anthropic API format)
type TextBlock = { type: "text"; text: string };
type ImageBlock = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};
type ContentBlock = TextBlock | ImageBlock;

// Helper to create async iterable for multi-modal prompts
async function* createMultiModalPrompt(
  textPrompt: string,
  images: TriageImage[]
): AsyncGenerator<SDKUserMessage> {
  const content: ContentBlock[] = [{ type: "text", text: textPrompt }];

  for (const img of images) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: img.contentType,
        data: img.base64,
      },
    });
  }

  yield {
    type: "user",
    message: {
      role: "user",
      content,
    },
    parent_tool_use_id: null,
    session_id: "",
  };
}

// ---------------------------------------------------------------------------
// Triage Message
// ---------------------------------------------------------------------------

export async function triageMessage(input: TriageInput): Promise<TriageResult> {
  const imageUrlSection = input.images && input.images.length > 0
    ? `\nImage URLs (already uploaded to Linear CDN - use these URLs in ticket description with markdown ![Screenshot](url)):\n${input.images.map((img, i) => `  ${i + 1}. ${img.url}`).join("\n")}`
    : "";

  let forwardedSection = "";
  if (input.forwardedMessage) {
    let threadContextSection = "";
    if (input.forwardedMessage.threadContext && input.forwardedMessage.threadContext.length > 0) {
      threadContextSection = `

### Full Thread Context (from source channel)
The forwarded message was part of a thread. Here is the full conversation:
${input.forwardedMessage.threadContext.join("\n")}

Use this full context to understand the complete discussion and create a more comprehensive ticket.`;
    } else if (input.forwardedMessage.threadContextError) {
      threadContextSection = `

Note: Could not fetch full thread context (bot may not have access to the source channel). Only the forwarded message text is available.`;
    }

    forwardedSection = `

## FORWARDED MESSAGE
This message was FORWARDED/SHARED to the feedback channel. The original feedback is below:
Original Message: "${input.forwardedMessage.text}"
Original Author ID: ${input.forwardedMessage.originalAuthorId || "unknown"}
Original Author Name: ${input.forwardedMessage.originalAuthorName || "unknown"}
Original Message URL: ${input.forwardedMessage.sourceUrl || "not available"}
${threadContextSection}

The forwarder (User ID: ${input.userId}) added this context: "${input.messageText}"

IMPORTANT: For forwarded messages:
- Get user info for the ORIGINAL AUTHOR (${input.forwardedMessage.originalAuthorId || "if available"}) to attribute the ticket
- The original message content is the primary feedback to triage
- If full thread context is available, use ALL messages to understand the complete discussion
- Include the forwarder's context in the ticket description
- Note in the description that this was forwarded feedback`;
  }

  const textPrompt = `New message in ${config.slackChannelName}:
User ID: ${input.userId}
Message: "${input.messageText}"
Slack Message Link: ${input.slackMessageUrl}
Slack Channel: ${input.channel}
Slack Thread TS: ${input.threadTs}${imageUrlSection}${forwardedSection}

${input.images && input.images.length > 0 ? "I've attached the screenshot(s) below - analyze them to understand what the user is showing." : ""}

Analyze and take action. If it's actionable feedback, create a ticket (include the Slack link in description, and if image URLs are provided above, include them as markdown images in the description). If not actionable (casual chat, thanks, etc), just say SKIPPED.
When replying in Slack, use the channel and thread_ts provided above.`;

  const prompt = input.images && input.images.length > 0
    ? createMultiModalPrompt(textPrompt, input.images)
    : textPrompt;

  try {
    console.log("[Agent] Starting triage...");

    const result = query({
      prompt,
      options: {
        model: config.model,
        systemPrompt: SYSTEM_PROMPT,
        maxTurns: 10,
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
        mcpServers: {
          "triage-tools": triageServer,
        },
        allowedTools: [
          "mcp__triage-tools__slack_get_user_info",
          "mcp__triage-tools__linear_search_issues",
          "mcp__triage-tools__linear_create_issue",
          "mcp__triage-tools__linear_add_comment",
          "mcp__triage-tools__slack_reply_in_thread",
        ],
        stderr: (data: string) => {
          console.error("[Claude stderr]:", data);
        },
      },
    });

    let finalResult: TriageResult = { action: "skipped", message: "No action taken" };
    let capturedTicketId: string | undefined;
    let capturedTicketUrl: string | undefined;
    let capturedTicketIdentifier: string | undefined;
    let linkedToExisting = false;
    let isDeferred = false;

    for await (const message of result) {
      if (message.type === "assistant") {
        const text = typeof message.message === "string" ? message.message : JSON.stringify(message.message);
        console.log("[Agent]:", text.substring(0, 200));

        if (text.includes('"model":"<synthetic>"') || text.includes('"input_tokens":0')) {
          console.log("[Agent] Skipping synthetic/error response");
          continue;
        }

        const idMatch = text.match(/"id"\s*:\s*"([^"]+)"/);
        if (idMatch && !capturedTicketId) {
          capturedTicketId = idMatch[1];
          console.log("[Agent] Captured ticket ID:", capturedTicketId);
        }

        const urlMatch = text.match(/https:\/\/linear\.app\/[^\s)>\]"]+/);
        if (urlMatch && !capturedTicketUrl) {
          capturedTicketUrl = urlMatch[0];
          console.log("[Agent] Captured ticket URL:", capturedTicketUrl);
        }
        const identifierMatch = text.match(/([A-Z]+-\d+)/);
        if (identifierMatch && !capturedTicketIdentifier) {
          capturedTicketIdentifier = identifierMatch[1];
          console.log("[Agent] Captured ticket identifier:", capturedTicketIdentifier);
        }

        if (text.toLowerCase().includes("existing ticket") ||
            text.toLowerCase().includes("duplicate") ||
            text.toLowerCase().includes("already tracking") ||
            text.toLowerCase().includes("added your report to")) {
          linkedToExisting = true;
          console.log("[Agent] Detected link to existing ticket");
        }

        if ((text.toLowerCase().includes("let the team") ||
            text.toLowerCase().includes("defer") ||
            text.toLowerCase().includes("team can share") ||
            text.toLowerCase().includes("team chime in") ||
            text.toLowerCase().includes("roadmap")) &&
            !capturedTicketId && !capturedTicketUrl) {
          isDeferred = true;
          console.log("[Agent] Detected DEFER to team");
        }
      }

      if (message.type === "result") {
        console.log("[Agent Complete] Cost:", message.total_cost_usd);
        if ("result" in message) {
          const resultText = message.result;
          const urlMatch = resultText.match(/https:\/\/linear\.app\/[^\s)>\]"]+/);
          if (urlMatch && !capturedTicketUrl) {
            capturedTicketUrl = urlMatch[0];
          }
          const identifierMatch = resultText.match(/([A-Z]+-\d+)/);
          if (identifierMatch && !capturedTicketIdentifier) {
            capturedTicketIdentifier = identifierMatch[1];
          }

          if (capturedTicketUrl || capturedTicketIdentifier) {
            finalResult = {
              action: linkedToExisting ? "duplicate" : "created",
              ticketId: capturedTicketId,
              ticketUrl: capturedTicketUrl,
              ticketIdentifier: capturedTicketIdentifier,
              message: resultText,
            };
          } else if (isDeferred) {
            finalResult = { action: "deferred", message: resultText };
          } else if (resultText.toLowerCase().includes("skip") || resultText.includes("SKIPPED")) {
            finalResult = { action: "skipped", message: resultText };
          } else {
            finalResult = { action: "skipped", message: resultText };
          }
        }
      }
    }

    return finalResult;
  } catch (error) {
    console.error("[Agent Error]:", error);
    return { action: "error", message: error instanceof Error ? error.message : "Unknown error" };
  }
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
  const imageSection = input.imageUrls && input.imageUrls.length > 0
    ? `\nImage URLs (already uploaded to Linear CDN - include these in ticket description using markdown ![Screenshot](url)):\n${input.imageUrls.map((url, i) => `  ${i + 1}. ${url}`).join("\n")}`
    : "";

  const prompt = `Analyze this thread reply and decide what to do:

User ID: ${input.userId}
Latest Reply: "${input.replyText}"
Slack Message Link: ${input.slackMessageUrl}
Slack Channel: ${input.channel}
Slack Thread TS (for replying): ${input.threadTs}${imageSection}

Full Thread Context:
${input.threadContext}

Based on the thread context and the latest reply, decide:
1. SKIP if not actionable (just say "SKIPPED" and nothing else)
2. Search for existing tickets and UPDATE if this relates to a known issue
3. CREATE a new ticket if this is new actionable feedback

If you take action (update or create), reply in Slack using the channel and thread_ts above.`;

  try {
    console.log("[Orphan Thread Agent] Analyzing thread reply...");

    const result = query({
      prompt,
      options: {
        model: config.model,
        systemPrompt: ORPHAN_THREAD_SYSTEM_PROMPT,
        maxTurns: 10,
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
        mcpServers: {
          "triage-tools": triageServer,
        },
        allowedTools: [
          "mcp__triage-tools__slack_get_user_info",
          "mcp__triage-tools__linear_search_issues",
          "mcp__triage-tools__linear_create_issue",
          "mcp__triage-tools__linear_add_comment",
          "mcp__triage-tools__slack_reply_in_thread",
        ],
        stderr: (data: string) => {
          console.error("[Orphan Thread stderr]:", data);
        },
      },
    });

    let finalResult: OrphanThreadResult = { action: "skipped", message: "No action taken" };
    let capturedTicketId: string | undefined;
    let capturedTicketUrl: string | undefined;
    let capturedTicketIdentifier: string | undefined;
    let addedComment = false;

    for await (const message of result) {
      if (message.type === "assistant") {
        const text = typeof message.message === "string" ? message.message : JSON.stringify(message.message);
        console.log("[Orphan Thread Agent]:", text.substring(0, 200));

        if (text.includes('"model":"<synthetic>"') || text.includes('"input_tokens":0')) {
          console.log("[Orphan Thread Agent] Skipping synthetic/error response");
          continue;
        }

        if (text.includes("linear_add_comment") || text.toLowerCase().includes("added") && text.toLowerCase().includes("comment")) {
          addedComment = true;
        }

        const idMatch = text.match(/"id"\s*:\s*"([^"]+)"/);
        if (idMatch && !capturedTicketId) {
          capturedTicketId = idMatch[1];
        }
        const urlMatch = text.match(/https:\/\/linear\.app\/[^\s)>\]"]+/);
        if (urlMatch && !capturedTicketUrl) {
          capturedTicketUrl = urlMatch[0];
        }
        const identifierMatch = text.match(/([A-Z]+-\d+)/);
        if (identifierMatch && !capturedTicketIdentifier) {
          capturedTicketIdentifier = identifierMatch[1];
        }
      }

      if (message.type === "result") {
        console.log("[Orphan Thread Agent Complete] Cost:", message.total_cost_usd);
        if ("result" in message) {
          const resultText = message.result;

          if (resultText.toLowerCase().includes("skip") || resultText.includes("SKIPPED")) {
            finalResult = { action: "skipped", message: resultText };
          } else if (capturedTicketUrl || capturedTicketIdentifier) {
            finalResult = {
              action: addedComment ? "updated" : "created",
              ticketId: capturedTicketId,
              ticketIdentifier: capturedTicketIdentifier,
              message: resultText,
            };
          } else {
            finalResult = { action: "skipped", message: resultText };
          }
        }
      }
    }

    return finalResult;
  } catch (error) {
    console.error("[Orphan Thread Agent Error]:", error);
    return { action: "error", message: error instanceof Error ? error.message : "Unknown error" };
  }
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
  const systemPrompt = input.isSameReporter
    ? FOLLOWUP_SYSTEM_PROMPT_SAME_REPORTER
    : FOLLOWUP_SYSTEM_PROMPT_DIFFERENT_PERSON;

  const actionInstruction = input.isSameReporter
    ? "Update the ticket description with this new context (include any images as markdown, and update priority if warranted), then reply in Slack."
    : "Add a comment to the ticket with this follow-up context (include any images as markdown), then reply in Slack.";

  const imageSection = input.imageUrls && input.imageUrls.length > 0
    ? `\nImage URLs (already uploaded to Linear CDN - include these using markdown ![Screenshot](url)):\n${input.imageUrls.map((url, i) => `  ${i + 1}. ${url}`).join("\n")}`
    : "";

  const prompt = `A user replied in a thread about ticket ${input.ticketIdentifier}.

Ticket ID: ${input.ticketId}
User ID: ${input.userId}
Their reply: "${input.replyText}"
Slack Channel: ${input.channel}
Slack Thread TS (for replying): ${input.threadTs}
Reply Message TS (for reactions): ${input.messageTs}
Same reporter as original: ${input.isSameReporter}${imageSection}

Thread context (full conversation):
${input.threadContext}

${actionInstruction}`;

  try {
    console.log(`[Followup Agent] Processing thread reply (sameReporter: ${input.isSameReporter}, isDuplicate: ${input.isDuplicate})...`);

    const result = query({
      prompt,
      options: {
        model: config.model,
        systemPrompt,
        maxTurns: 8,
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
        mcpServers: {
          "followup-tools": followupServer,
        },
        allowedTools: [
          "mcp__followup-tools__slack_get_user_info",
          "mcp__followup-tools__linear_get_issue",
          "mcp__followup-tools__linear_update_issue",
          "mcp__followup-tools__linear_add_comment",
          "mcp__followup-tools__slack_reply_in_thread",
          "mcp__followup-tools__slack_add_reaction",
        ],
        stderr: (data: string) => {
          console.error("[Followup Claude stderr]:", data);
        },
      },
    });

    for await (const message of result) {
      if (message.type === "assistant") {
        const text = typeof message.message === "string" ? message.message : JSON.stringify(message.message);
        console.log("[Followup Agent]:", text.substring(0, 200));

        if (text.includes('"model":"<synthetic>"') || text.includes('"input_tokens":0')) {
          console.log("[Followup Agent] Skipping synthetic/error response");
          continue;
        }
      }
      if (message.type === "result") {
        console.log("[Followup Agent Complete] Cost:", message.total_cost_usd);
      }
    }
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
  const imageSection = input.imageUrls && input.imageUrls.length > 0
    ? `\nImage URLs (already uploaded to Linear CDN):\n${input.imageUrls.map((url, i) => `  ${i + 1}. ${url}`).join("\n")}`
    : "";

  const prompt = `A reply was posted in a DEFERRED thread (the original topic related to roadmap features).

Original message that was deferred: "${input.originalContext || "(not available)"}"

New reply:
User ID: ${input.userId}
Reply text: "${input.replyText}"
Slack Channel: ${input.channel}
Slack Thread TS: ${input.threadTs}${imageSection}

Full thread context:
${input.threadContext}

Analyze this reply:
1. First, get the user's info to determine if they're internal or external
2. Decide:
   - NO_ACTION: Team providing context, general discussion, no action needed (respond with "NO_ACTION")
   - CREATE_TICKET: Someone explicitly requested to track this (use tools, then confirm)

Remember: If this is just a team member providing context/answering, respond with "NO_ACTION" and nothing else.`;

  try {
    console.log(`[Deferred Followup Agent] Processing reply...`);

    const result = query({
      prompt,
      options: {
        model: config.model,
        systemPrompt: DEFERRED_FOLLOWUP_SYSTEM_PROMPT,
        maxTurns: 10,
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
        mcpServers: {
          "deferred-tools": deferredFollowupServer,
        },
        allowedTools: [
          "mcp__deferred-tools__slack_get_user_info",
          "mcp__deferred-tools__linear_search_issues",
          "mcp__deferred-tools__linear_create_issue",
          "mcp__deferred-tools__linear_add_comment",
          "mcp__deferred-tools__slack_reply_in_thread",
        ],
        stderr: (data: string) => {
          console.error("[Deferred Followup stderr]:", data);
        },
      },
    });

    let finalResult: DeferredFollowupResult = { action: "no_action", message: "No action taken" };
    let capturedTicketId: string | undefined;
    let capturedTicketIdentifier: string | undefined;

    for await (const message of result) {
      if (message.type === "assistant") {
        const text = typeof message.message === "string" ? message.message : JSON.stringify(message.message);
        console.log("[Deferred Followup Agent]:", text.substring(0, 200));

        if (text.includes('"model":"<synthetic>"') || text.includes('"input_tokens":0')) {
          console.log("[Deferred Followup Agent] Skipping synthetic/error response");
          continue;
        }

        const idMatch = text.match(/"id"\s*:\s*"([^"]+)"/);
        if (idMatch && !capturedTicketId) {
          capturedTicketId = idMatch[1];
        }
        const identifierMatch = text.match(/([A-Z]+-\d+)/);
        if (identifierMatch && !capturedTicketIdentifier) {
          capturedTicketIdentifier = identifierMatch[1];
        }
      }

      if (message.type === "result") {
        console.log("[Deferred Followup Agent Complete] Cost:", message.total_cost_usd);
        if ("result" in message) {
          const resultText = message.result;

          if (resultText.includes("NO_ACTION") || resultText.toLowerCase().includes("no action")) {
            finalResult = { action: "no_action", message: resultText };
          } else if (capturedTicketId || capturedTicketIdentifier) {
            finalResult = {
              action: "created",
              ticketId: capturedTicketId,
              ticketIdentifier: capturedTicketIdentifier,
              message: resultText,
            };
          } else {
            finalResult = { action: "no_action", message: resultText };
          }
        }
      }
    }

    return finalResult;
  } catch (error) {
    console.error("[Deferred Followup Agent Error]:", error);
    return { action: "error", message: error instanceof Error ? error.message : "Unknown error" };
  }
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
  action: "executed" | "help" | "error" | "clarification";
  message: string;
}

export async function handleDirectCommand(input: DirectCommandInput): Promise<DirectCommandResult> {
  const imageSection = input.imageUrls && input.imageUrls.length > 0
    ? `\nImage URLs (already uploaded to Linear CDN):\n${input.imageUrls.map((url, i) => `  ${i + 1}. ${url}`).join("\n")}`
    : "";

  const ticketContextSection = input.ticketContext
    ? `Ticket Context: This thread is tracked to ticket ${input.ticketContext}. Use this ticket for commands like "close this", "change priority", etc.`
    : `Ticket Context: This thread is NOT tracked to any ticket. If the user says "this" when referring to a ticket, you'll need them to specify a ticket ID, OR search the thread context for Linear ticket links.`;

  const prompt = `You received a direct command via @mention.

User ID: ${input.userId}
Command: "${input.commandText}"
Slack Channel: ${input.channel}
Slack Thread TS (for replying): ${input.threadTs}
${ticketContextSection}${imageSection}

Thread context (for understanding what's being discussed):
${input.threadContext}

Analyze the command and execute it. Remember:
- For "this" references to a ticket, use the ticket context above (${input.ticketContext || "none available"})
- If no ticket context and they say "this", look for Linear ticket links in the thread context above
- Use slack_reply_in_thread to confirm what you did
- For "help" commands, list the available commands in a friendly, readable format`;

  try {
    console.log(`[Command Agent] Processing command: ${input.commandText.substring(0, 100)}`);

    const result = query({
      prompt,
      options: {
        model: config.model,
        systemPrompt: COMMAND_SYSTEM_PROMPT,
        maxTurns: 10,
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
        mcpServers: {
          "command-tools": commandServer,
        },
        allowedTools: [
          "mcp__command-tools__slack_get_user_info",
          "mcp__command-tools__linear_get_issue",
          "mcp__command-tools__linear_update_issue",
          "mcp__command-tools__linear_add_comment",
          "mcp__command-tools__slack_reply_in_thread",
          "mcp__command-tools__linear_search_issues",
          "mcp__command-tools__linear_create_issue",
          "mcp__command-tools__linear_update_status",
          "mcp__command-tools__linear_add_label",
          "mcp__command-tools__linear_remove_label",
          "mcp__command-tools__linear_assign_issue",
          "mcp__command-tools__linear_close_issue",
          "mcp__command-tools__linear_reopen_issue",
          "mcp__command-tools__linear_link_issues",
          "mcp__command-tools__linear_update_title",
        ],
        stderr: (data: string) => {
          console.error("[Command Agent stderr]:", data);
        },
      },
    });

    let finalResult: DirectCommandResult = { action: "executed", message: "Command processed" };

    for await (const message of result) {
      if (message.type === "assistant") {
        const text = typeof message.message === "string" ? message.message : JSON.stringify(message.message);
        console.log("[Command Agent]:", text.substring(0, 200));

        if (text.includes('"model":"<synthetic>"') || text.includes('"input_tokens":0')) {
          console.log("[Command Agent] Skipping synthetic/error response");
          continue;
        }

        if (text.toLowerCase().includes("available commands") || text.toLowerCase().includes("what can you do") || text.toLowerCase().includes("here's what i can")) {
          finalResult = { action: "help", message: text };
        }
      }

      if (message.type === "result") {
        console.log("[Command Agent Complete] Cost:", message.total_cost_usd);
        if ("result" in message) {
          const resultText = message.result;

          if (resultText.toLowerCase().includes("could you") ||
              resultText.toLowerCase().includes("please specify") ||
              resultText.toLowerCase().includes("which ticket") ||
              resultText.toLowerCase().includes("i need")) {
            finalResult = { action: "clarification", message: resultText };
          } else if (finalResult.action !== "help") {
            finalResult = { action: "executed", message: resultText };
          }
        }
      }
    }

    return finalResult;
  } catch (error) {
    console.error("[Command Agent Error]:", error);
    return { action: "error", message: error instanceof Error ? error.message : "Unknown error" };
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
  action: "created" | "duplicate" | "skipped" | "deferred" | "error";
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
    console.log(`[Edit Agent] Analyzing edit significance...`);

    const result = query({
      prompt,
      options: {
        model: config.model,
        systemPrompt: MESSAGE_EDIT_SYSTEM_PROMPT,
        maxTurns: 8,
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
        mcpServers: {
          "edit-handler-tools": editHandlerServer,
        },
        allowedTools: [
          "mcp__edit-handler-tools__slack_get_user_info",
          "mcp__edit-handler-tools__linear_get_issue",
          "mcp__edit-handler-tools__linear_update_issue",
          "mcp__edit-handler-tools__linear_add_comment",
        ],
        stderr: (data: string) => {
          console.error("[Edit Agent stderr]:", data);
        },
      },
    });

    for await (const message of result) {
      if (message.type === "assistant") {
        const text = typeof message.message === "string" ? message.message : JSON.stringify(message.message);
        console.log("[Edit Agent]:", text.substring(0, 200));

        if (text.includes('"model":"<synthetic>"') || text.includes('"input_tokens":0')) {
          console.log("[Edit Agent] Skipping synthetic/error response");
          continue;
        }
      }
      if (message.type === "result") {
        console.log("[Edit Agent Complete] Cost:", message.total_cost_usd);
      }
    }
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
  action: "created" | "duplicate" | "skipped" | "deferred" | "error";
}

export async function handleMessageDelete(input: DeletedMessageInput): Promise<void> {
  const prompt = `A user deleted their Slack message after triage.

Ticket ID: ${input.ticketId}
Ticket Identifier: ${input.ticketIdentifier}
Message timestamp: ${input.messageTs}
Original action: ${input.action}

Add a brief, factual note to the ticket that the original Slack message was deleted.`;

  try {
    console.log(`[Delete Agent] Adding deletion note...`);

    const result = query({
      prompt,
      options: {
        model: config.model,
        systemPrompt: MESSAGE_DELETE_SYSTEM_PROMPT,
        maxTurns: 3,
        permissionMode: "bypassPermissions",
        cwd: process.cwd(),
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
        mcpServers: {
          "delete-handler-tools": deleteHandlerServer,
        },
        allowedTools: [
          "mcp__delete-handler-tools__linear_add_comment",
        ],
        stderr: (data: string) => {
          console.error("[Delete Agent stderr]:", data);
        },
      },
    });

    for await (const message of result) {
      if (message.type === "assistant") {
        const text = typeof message.message === "string" ? message.message : JSON.stringify(message.message);
        console.log("[Delete Agent]:", text.substring(0, 200));

        if (text.includes('"model":"<synthetic>"') || text.includes('"input_tokens":0')) {
          console.log("[Delete Agent] Skipping synthetic/error response");
          continue;
        }
      }
      if (message.type === "result") {
        console.log("[Delete Agent Complete] Cost:", message.total_cost_usd);
      }
    }
  } catch (error) {
    console.error("[Delete Agent Error]:", error);
  }
}
