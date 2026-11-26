import { create } from "zustand";
import type { AgentServerState } from "./api";
import { callTool, isQuietTool, toolInfo, toolLabel } from "./agentTools";
import { useEditor } from "./store";

export interface AgentLogEntry {
  id: number;
  time: number;
  label: string;
  error: string | null;
}

interface AgentState {
  server: AgentServerState | null;
  /** Latest calls first. */
  log: AgentLogEntry[];
}

const LOG_SIZE = 40;
let nextEntry = 1;

/** The AI connection as the interface sees it. */
export const useAgent = create<AgentState>(() => ({ server: null, log: [] }));

function record(name: string, error: string | null) {
  const label = toolLabel(name);
  useAgent.setState((s) => ({ log: [{ id: nextEntry++, time: Date.now(), label, error }, ...s.log].slice(0, LOG_SIZE) }));
  if (error || isQuietTool(name)) return;
  // Edits appear on the timeline by themselves; the status bar says who made them.
  const text = `IA: ${label}`;
  const { setStatus } = useEditor.getState();
  setStatus(text);
  setTimeout(() => useEditor.getState().status === text && setStatus(null), 3000);
}

/** Answer the main process's tool calls. Runs once, before the window shows anything to connect to. */
export function startAgentBridge() {
  if (!window.api?.agentState) return;
  window.api.onAgentState((server) => useAgent.setState({ server }));
  window.api.onAgentCall(async ({ id, name, args }) => {
    try {
      const content = await callTool(name, args);
      record(name, null);
      window.api.agentReply({ id, ok: true, content });
    } catch (err) {
      const error = (err as Error).message;
      record(name, error);
      window.api.agentReply({ id, ok: false, error });
    }
  });
  void window.api.agentRegisterTools(toolInfo());
  void window.api.agentState().then((server) => useAgent.setState({ server }));
}

export async function configureAgent(patch: Parameters<typeof window.api.agentConfigure>[0]) {
  useAgent.setState({ server: await window.api.agentConfigure(patch) });
}
