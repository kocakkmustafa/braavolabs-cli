/**
 * Wires the board to the local daemon with the endpoints the CLI already uses (`braavo company`, `braavo chat`).
 * Nothing new is called: approvals go through the same decide route as `braavo company approve`, "stop all" is the
 * same agent pause as `braavo company set <agent> --pause`, a chat message is the same streamed turn as `braavo chat`.
 * The daemon token is read per call by `ensureToken` and never shown.
 */
import { runningDaemon, daemonPaths, ensureToken } from "../../daemon/lifecycle";
import { DaemonClient, DaemonRequestError } from "../daemon-client";
import { statusText, t } from "../locale";
import type { BoardAction, BoardData, BoardMessage } from "./board";
import { runBoard } from "./run";

interface PanelReply { company: { id: string; name: string; monthlyBudgetUsd: number | null }; agents: BoardData["agents"]; month: { usd: number } }

export async function launchBoard(opts: { loggedIn: boolean }): Promise<void> {
  const paths = daemonPaths();
  let companyId: string | null = null;
  const connect = (): DaemonClient => {
    const live = runningDaemon(paths);
    if (!live) throw new Error(t("The daemon is not running. Start it: braavo daemon start"));
    return new DaemonClient({ port: live.port, token: ensureToken(paths) });
  };
  const wrap = async <T,>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) { if (error instanceof DaemonRequestError) throw new Error(error.message); throw error; }
  };

  await runBoard({
    input: process.stdin, output: process.stdout, loggedIn: opts.loggedIn,
    load: () => wrap(async (): Promise<BoardData> => {
      const client = connect();
      const { conversations } = await client.json<{ conversations: BoardData["conversations"] }>("GET", "/conversations?limit=50");
      const { companies } = await client.json<{ companies: Array<{ id: string }> }>("GET", "/companies");
      companyId = companies[0]?.id ?? null;
      if (!companyId) return { company: null, agents: [], tasks: [], approvals: [], conversations };
      const panel = await client.json<PanelReply>("GET", `/companies/${companyId}/panel`);
      const { tasks } = await client.json<{ tasks: BoardData["tasks"] }>("GET", `/companies/${companyId}/tasks`);
      const { approvals } = await client.json<{ approvals: BoardData["approvals"] }>("GET", `/companies/${companyId}/approvals?status=pending`);
      return { company: { ...panel.company, monthUsd: panel.month.usd }, agents: panel.agents, tasks, approvals, conversations };
    }),
    loadMessages: (id) => wrap(async (): Promise<BoardMessage[]> => {
      const data = await connect().json<{ messages: BoardMessage[] }>("GET", `/conversations/${encodeURIComponent(id)}`);
      return data.messages.map(m => ({ role: m.role, content: m.content }));
    }),
    act: (action: BoardAction) => wrap(async (): Promise<string> => {
      const client = connect();
      switch (action.type) {
        case "approval": {
          const { approval } = await client.json<{ approval: { title: string; status: string } }>("POST", `/approvals/${encodeURIComponent(action.id)}`, { decision: action.decision });
          return t("Approval {0}: {1}", approval.title, statusText(approval.status));
        }
        case "pause-all": {
          let paused = 0;
          for (const id of action.agentIds) { await client.json("PATCH", `/agents/${encodeURIComponent(id)}`, { status: "paused" }); paused += 1; }
          return t("Paused {0} agents", paused);
        }
        case "task-add": {
          if (!companyId) throw new Error(t("No company yet. Create one: braavo company init <name>"));
          const { task } = await client.json<{ task: { title: string } }>("POST", `/companies/${companyId}/tasks`, { title: action.title, assignee: action.agentId });
          return t("Task added: {0}", task.title);
        }
        case "send": {
          let failure = "";
          await client.turn(action.conversationId, action.text, ev => { if (ev.type === "error") failure = ev.error; });
          if (failure) throw new Error(failure);
          return "";
        }
        default: return "";
      }
    }),
  });
}
