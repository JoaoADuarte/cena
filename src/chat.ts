import { create } from "zustand";
import type { ChatEvent } from "./api";
import { toolLabel } from "./agentTools";

export type ChatPart = { kind: "text"; text: string } | { kind: "tool"; label: string };

export interface ChatMessage {
  id: number;
  role: "user" | "assistant" | "error";
  parts: ChatPart[];
}

export const CHAT_MODELS = [
  { id: "", label: "Padrão do Claude Code" },
  { id: "sonnet", label: "Sonnet (rápido)" },
  { id: "opus", label: "Opus (mais capaz)" },
  { id: "haiku", label: "Haiku (mais rápido)" },
];

interface ChatState {
  messages: ChatMessage[];
  running: boolean;
  /** Claude Code session, so follow-ups keep the context ("deixe esse texto amarelo"). */
  sessionId: string | null;
  model: string;
  /** Path of Claude Code; null when it is not installed, undefined until checked. */
  claude: string | null | undefined;
}

const MODEL_KEY = "cena.chat.model";
const readModel = () => {
  try {
    return localStorage.getItem(MODEL_KEY) ?? "";
  } catch {
    return "";
  }
};

let nextId = 1;

export const useChat = create<ChatState>(() => ({ messages: [], running: false, sessionId: null, model: readModel(), claude: undefined }));

/** What the assistant is doing, in the user's words. */
function describeTool(tool: string, detail?: string | null): string {
  const named: Record<string, string> = {
    Skill: `Usando a skill ${detail ?? ""}`.trim(),
    Bash: "Rodando o HyperFrames",
    Write: `Escrevendo ${detail ?? "um arquivo"}`,
    Edit: `Editando ${detail ?? "um arquivo"}`,
    Read: `Lendo ${detail ?? "um arquivo"}`,
    Glob: "Procurando arquivos",
    Grep: "Procurando nos arquivos",
  };
  return named[tool] ?? toolLabel(tool);
}

function appendToReply(part: ChatPart) {
  useChat.setState((s) => {
    const messages = [...s.messages];
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") messages[messages.length - 1] = { ...last, parts: [...last.parts, part] };
    else messages.push({ id: nextId++, role: "assistant", parts: [part] });
    return { messages };
  });
}

function onEvent(event: ChatEvent) {
  if (event.type === "start") useChat.setState({ sessionId: event.sessionId });
  else if (event.type === "text") appendToReply({ kind: "text", text: event.text });
  else if (event.type === "tool") appendToReply({ kind: "tool", label: describeTool(event.tool, event.detail) });
}

let subscribed = false;

export async function checkClaude() {
  if (!window.api?.chatStatus) return useChat.setState({ claude: null });
  if (!subscribed) {
    window.api.onChatEvent(onEvent);
    subscribed = true;
  }
  const { claude } = await window.api.chatStatus();
  useChat.setState({ claude });
}

export async function sendChat(text: string) {
  const { running, sessionId, model } = useChat.getState();
  if (running || !text.trim()) return;
  useChat.setState((s) => ({ running: true, messages: [...s.messages, { id: nextId++, role: "user", parts: [{ kind: "text", text }] }] }));
  try {
    const result = await window.api.chatSend({ text, sessionId, model: model || null });
    if (result.sessionId) useChat.setState({ sessionId: result.sessionId });
    const replied = useChat.getState().messages.at(-1)?.role === "assistant";
    if (result.isError) addError(result.text ?? "O assistente não conseguiu terminar.");
    else if (!replied && result.text) appendToReply({ kind: "text", text: result.text });
    if (result.denied.length) addError(`O Claude Code recusou usar: ${[...new Set(result.denied)].join(", ")}.`);
  } catch (err) {
    addError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  } finally {
    useChat.setState({ running: false });
  }
}

function addError(text: string) {
  useChat.setState((s) => ({ messages: [...s.messages, { id: nextId++, role: "error", parts: [{ kind: "text", text }] }] }));
}

export const cancelChat = () => void window.api.chatCancel();

export function newConversation() {
  if (useChat.getState().running) return;
  useChat.setState({ messages: [], sessionId: null });
}

export function setChatModel(model: string) {
  useChat.setState({ model });
  try {
    localStorage.setItem(MODEL_KEY, model);
  } catch {
    // Remembering the choice is only a convenience.
  }
}
