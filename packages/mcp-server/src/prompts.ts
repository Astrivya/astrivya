// MCP native `prompts/list` + `prompts/get` surface. These templates steer an
// agent through the Astrivya loop (digest → search → log) instead of leaving
// it to discover the tools ad-hoc.

export interface PromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

export interface PromptDef {
  name: string;
  description: string;
  arguments?: PromptArgument[];
}

export const PROMPT_DEFINITIONS: PromptDef[] = [
  {
    name: "session_start",
    description:
      "Orient a new agent session on this workspace and team: read the context digest, then search memories around the task before answering. Run this once at session start.",
  },
  {
    name: "remember_after_task",
    description:
      "Persist what this task produced as structured memory. Fills a well-formed log_memory call with a fact summary, the decision (if any), and file context.",
    arguments: [
      { name: "task_summary", description: "One paragraph on what was done and the outcome.", required: true },
      {
        name: "decision",
        description:
          "A decision taken during the task, if any (e.g. 'Adopted RRF over concatenation for search fusion').",
      },
      { name: "file_context", description: "Primary file(s) touched, comma-separated." },
      { name: "visibility", description: "personal | team | org (default personal)." },
    ],
  },
  {
    name: "decision_required",
    description:
      "Record an architecture or design decision so the team dashboard and knowledge graph stay in sync. Produces a log_decision call with the reasoning.",
    arguments: [
      { name: "title", description: "Short decision title.", required: true },
      { name: "reasoning", description: "The trade-offs, context and rationale.", required: true },
      { name: "file_context", description: "Optional file(s) the decision concerns." },
    ],
  },
];

export function buildPromptPrompt(name: string, args: Record<string, unknown> | undefined): string {
  switch (name) {
    case "session_start":
      return [
        "You are starting a session in an Astrivya workspace. Ground yourself before answering:",
        "",
        "1. Call `get_context_digest` for the latest workspace/team context and any action items.",
        "2. If the task involves prior work, call `search_memories` with the task keywords (pass `active_file` when a file is relevant).",
        "3. For a topic you have worked on before, `find_related_knowledge` to reconnect with related concepts.",
        "4. Check `get_workspace_updates` to see what changed since your last session.",
        "5. Join the Agent Mesh: call `identify_agent` with your model/provider/session so other agents and Atlas can tell you apart, then call `mesh_read` to see what other agents are working on.",
        "",
        "Coordination protocol (Agent Mesh):",
        "- Before editing files or running release/tag/CI/git operations, check `mesh_read` for peers working on the same files, branches or repos.",
        "- Announce what you are about to do with `agent_message` (type `code-conflict`, `release`, `tag`, `ci`, `deploy`, `vm`, `git-push`, `review`, `blocker` or `question`; add `files`/`branch` in `context`).",
        "- Reply to peer announcements in the same `thread_id` (set `in_reply_to` to the message id) instead of starting new threads.",
        "- Never edit the same file range simultaneously. On overlap, post a `code-conflict` message and wait for a reply before proceeding.",
        "- Coordinate releases, tags and pushes via `agent_message` — one agent drives, the rest defer.",
        "",
        "Only then answer. If the graph is empty, say so and suggest `astrivya akg init`.",
      ].join("\n");

    case "remember_after_task": {
      const summary = String(args?.task_summary ?? "").trim();
      const decision = String(args?.decision ?? "").trim();
      const fileContext = String(args?.file_context ?? "").trim();
      const visibility = String(args?.visibility ?? "personal").trim();
      const lines = [
        `Task completed. Record the outcome as structured memory (visibility: ${visibility}).`,
        "",
        `Summary: ${summary}`,
      ];
      if (decision) lines.push(`Decision: ${decision} — log it with \`log_decision\` too.`);
      if (fileContext) lines.push(`Files: ${fileContext}`);
      lines.push(
        "",
        'Call `log_memory` with type "insight" (or "decision" when a decision was logged) and concise, reusable phrasing — no timestamps, no filler.',
      );
      return lines.join("\n");
    }

    case "decision_required": {
      const title = String(args?.title ?? "").trim();
      const reasoning = String(args?.reasoning ?? "").trim();
      const fileContext = String(args?.file_context ?? "").trim();
      const lines = [`A decision is required. Record it for the team: "${title}".`, "", `Reasoning: ${reasoning}`];
      if (fileContext) lines.push(`Context: ${fileContext}`);
      lines.push("", "Call `log_decision` with this title and a tight summary of the reasoning.");
      return lines.join("\n");
    }

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
}
