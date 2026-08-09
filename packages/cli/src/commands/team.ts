import { AkgStorage } from "@astrivya/akg-core";
import type { Command } from "commander";
import { apiCall, getBaseUrl, getToken, loadConfig, saveConfig } from "../lib/compat";
import { color, error, getErrorMessage, info, success } from "../lib/output";

/**
 * `astrivya team` — invite teammates, join a team, and run the team-scoped MCP.
 *
 * Everything here talks to generic cloud endpoints (`/api/org`, `/api/team/*`)
 * via `apiCall`; there is no proprietary logic inline. The team knowledge graph
 * lives in the cloud; this command is the client that manages membership.
 */
export function registerTeam(program: Command): void {
  const team = program.command("team").description("Team collaboration: create, invite, join, and run the team MCP");

  team
    .command("create")
    .description("Create a team (organization) for you and your teammates")
    .argument("<name>", "Human-readable team name")
    .option("--slug <slug>", "URL-safe slug (defaults to a slugified name)")
    .action(async (name: string, options: { slug?: string }) => {
      const token = getToken();
      if (!token) {
        error("Not authenticated. Run `astrivya auth login` or set ASTRIVYA_TOKEN first.");
        process.exit(1);
      }
      const slug =
        options.slug ||
        name
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/(^-|-$)/g, "");
      try {
        const res = await apiCall("/api/org", "POST", { name, slug });
        saveConfig({ orgId: res.organization?.id, role: res.role, teamMcpId: res.organization?.mcp_id });
        success(`Created team "${name}" (${res.organization?.id}).`);
        if (res.organization?.mcp_id) {
          info(`Team MCP id: ${res.organization.mcp_id}`);
          info("Run `astrivya team mcp` to start the shared team MCP locally.");
        }
      } catch (err: unknown) {
        error(`Failed to create team: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  team
    .command("status")
    .description("Show your team, members, and knowledge-graph sync state")
    .action(async () => {
      const config = loadConfig();
      try {
        const [ctx, members, stats] = await Promise.allSettled([
          apiCall("/api/team/context", "GET"),
          apiCall("/api/team/members", "GET"),
          (async () => {
            const storage = new AkgStorage();
            await storage.init(process.cwd());
            return storage.getStats();
          })(),
        ]);

        console.log();
        if (ctx.status === "fulfilled") {
          const c = ctx.value;
          console.log(`  Team:    ${c.org?.name ?? "(none)"} (${c.org?.slug ?? "-"})`);
          console.log(`  Meta:    ${(c.members || []).length} members`);
        } else {
          console.log(`  Team:    ${color.yellow("unreachable")} — ${getErrorMessage(ctx.reason)}`);
        }
        if (members.status === "fulfilled") {
          for (const m of members.value.members || []) {
            console.log(`    · ${m.name || m.email || m.id} [${m.role}]`);
          }
        }
        if (stats.status === "fulfilled") {
          console.log(`  Local:   ${stats.value.nodes} nodes, ${stats.value.chunks} chunks`);
        }
        console.log();
      } catch (err: unknown) {
        error(`Team status failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  team
    .command("invite")
    .description("Invite a teammate by email (you must be an org owner/admin)")
    .argument("<email>", "Teammate email address")
    .option("--role <role>", "role to grant: member|admin", "member")
    .action(async (email: string, options: { role: string }) => {
      try {
        const res = await apiCall("/api/team/invites", "POST", { email, role: options.role });
        console.log();
        success(`Invited ${email} (${options.role}).`);
        if (res.invite?.code) {
          console.log(`\n  Join code: ${color.bold(res.invite.code)}`);
          console.log(`  Teammate runs: ${color.cyan(`astrivya team join ${res.invite.code}`)}`);
          console.log(`  Or opens: ${getBaseUrl()}${res.invite.join_path || "/team/join"}?code=${res.invite.code}`);
        }
        console.log();
      } catch (err: unknown) {
        error(`Invite failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  team
    .command("join")
    .description("Accept a team invite by code and join the shared team")
    .argument("<code>", "Invite code from your teammate")
    .action(async (code: string) => {
      try {
        const res = await apiCall(`/api/team/invites/${code}/accept`, "POST", {});
        saveConfig({
          orgId: res.org?.id,
          role: res.role,
          teamMcpId: res.org?.mcp_id,
          teamName: res.org?.name,
        });
        success(`Joined team "${res.org?.name}" as ${res.role}.`);
        if (res.org?.mcp_id) info(`Team MCP id: ${res.org.mcp_id} — run \`astrivya team mcp\`.`);
      } catch (err: unknown) {
        error(`Join failed: ${getErrorMessage(err)}`);
        process.exit(1);
      }
    });

  team
    .command("mcp")
    .description("Print (and hold) the command that runs the team-scoped MCP server")
    .option("--id <mcpId>", "Team MCP id (defaults to the saved one)")
    .action(async (options: { id?: string }) => {
      const config = loadConfig();
      const mcpId = options.id || config.teamMcpId || process.env.ASTRIVYA_TEAM_MCP;
      if (!mcpId) {
        error("No team MCP id set. Create/join a team first (`astrivya team create|join`).");
        process.exit(1);
      }
      if (options.id) saveConfig({ teamMcpId: options.id });
      console.log();
      console.log("  Start the team-scoped MCP server (stdio):");
      console.log(`    ${color.cyan(`npx -y @astrivya/mcp-server --team ${mcpId}`)}`);
      console.log();
      console.log(`  Or as a service, set ${color.bold("ASTRIVYA_TEAM_MCP")} and launch as usual.`);
      console.log();
    });
}
