/**
 * Smoke test: runs the triage agent against the real Claude API with in-memory
 * fake Slack and Linear clients, and checks the recorded outcome of each case.
 *
 *   ANTHROPIC_API_KEY=... npm run smoke
 *
 * Makes a handful of real model calls (a few cents). Nothing is posted to Slack
 * or written to Linear.
 */
import "../src/env.js";
import { setDependencies, triageMessage, type TriageAction } from "../src/agent.js";
import type { Dependencies } from "../src/tools.js";

const existingIssues = [
  {
    id: "issue-1",
    identifier: "TRI-1",
    title: "CSV export fails with a timeout for large tables",
    description: "Exporting a table with more than 10k rows to CSV times out after 30 seconds.",
    url: "https://linear.app/example/issue/TRI-1",
  },
];
let nextId = 100;

const fakeSlack = {
  users: {
    info: async ({ user }: { user: string }) => ({
      user: { id: user, name: "jdoe", real_name: "Jane Doe", profile: { email: "jane@example.com" } },
    }),
  },
  chat: {
    postMessage: async ({ text }: { text: string }) => {
      console.log(`    [slack reply] ${text.replace(/\n/g, " ").substring(0, 160)}`);
      return { ok: true };
    },
  },
  reactions: { add: async () => ({ ok: true }) },
};

type Filter = { or?: Array<{ title?: { containsIgnoreCase: string }; description?: { containsIgnoreCase: string } }> };

const fakeLinear = {
  issues: async ({ filter }: { filter: Filter }) => {
    const needles = (filter.or ?? []).map((c) => (c.title ?? c.description)!.containsIgnoreCase.toLowerCase());
    const nodes = existingIssues
      .filter((i) => needles.some((n) => `${i.title} ${i.description}`.toLowerCase().includes(n)))
      .map((i) => ({ ...i, state: Promise.resolve({ name: "Triage" }) }));
    return { nodes };
  },
  issue: async (id: string) => {
    const found = existingIssues.find((i) => i.id === id || i.identifier === id);
    if (!found) throw new Error(`Issue ${id} not found`);
    return found;
  },
  createIssue: async (input: { title: string; description: string }) => {
    const issue = {
      id: `issue-${nextId}`,
      identifier: `TRI-${nextId++}`,
      title: input.title,
      description: input.description,
      url: "https://linear.app/example/issue/new",
    };
    existingIssues.push(issue);
    console.log(`    [linear create] ${issue.identifier}: ${input.title}`);
    return { issue: Promise.resolve(issue) };
  },
  createComment: async ({ issueId }: { issueId: string }) => {
    console.log(`    [linear comment] on ${issueId}`);
    return { success: true };
  },
};

setDependencies({
  slack: fakeSlack as unknown as Dependencies["slack"],
  linear: fakeLinear as unknown as Dependencies["linear"],
  linearTeamId: "team-1",
  slackBotToken: "xoxb-fake",
});

const cases: Array<{ name: string; text: string; expect: TriageAction }> = [
  {
    name: "new bug",
    text: "The date picker in the sidebar shows the wrong month after I switch timezones in settings - it jumps back to January every time.",
    expect: "created",
  },
  {
    name: "duplicate of TRI-1",
    text: "Tried to export our orders table (about 50k rows) to CSV and it just spins and then times out.",
    expect: "duplicate",
  },
  {
    name: "roadmap question",
    text: "Is there a plan to support SSO login for the admin panel? Any idea when that might land?",
    expect: "deferred",
  },
  { name: "chit-chat", text: "thanks everyone, great session today!", expect: "skipped" },
];

let failures = 0;
for (const [i, c] of cases.entries()) {
  console.log(`\n=== ${c.name}`);
  const result = await triageMessage({
    messageText: c.text,
    userId: "U0SMOKE",
    channel: "C0SMOKE",
    threadTs: `1700000000.00000${i}`,
    slackMessageUrl: `https://slack.com/archives/C0SMOKE/p170000000000000${i}`,
  });
  const ok = result.action === c.expect;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${c.name}: expected ${c.expect}, got ${result.action}${result.ticketIdentifier ? ` (${result.ticketIdentifier})` : ""}`);
}

console.log(`\n${cases.length - failures}/${cases.length} passed`);
process.exit(failures > 0 ? 1 : 0);
