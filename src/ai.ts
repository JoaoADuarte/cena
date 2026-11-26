import { create } from "zustand";
import type { AiProgress, AiTasks } from "./api";

export interface AiJob {
  title: string;
  progress: AiProgress | null;
}

/** The single AI job in flight (the utility process runs one at a time), shown in the top bar. */
export const useAiJob = create<{ job: AiJob | null }>(() => ({ job: null }));

export function isAiBusy() {
  return useAiJob.getState().job !== null;
}

/** Run an AI task with progress shown in the top bar. Rejects with "Cancelado." when the user cancels. */
export async function runAiTask<T extends keyof AiTasks>(title: string, task: T, params: AiTasks[T]["params"]): Promise<AiTasks[T]["result"]> {
  if (isAiBusy()) throw new Error("Já existe uma tarefa de IA em andamento.");
  useAiJob.setState({ job: { title, progress: null } });
  const unsubscribe = window.api.onAiProgress((progress) => useAiJob.setState({ job: { title, progress } }));
  try {
    return await window.api.aiRun(task, params);
  } finally {
    unsubscribe();
    useAiJob.setState({ job: null });
  }
}

/** "Baixando Whisper · 45%" style description of a progress event. */
export function describeProgress(p: AiProgress | null): { text: string; fraction: number | null } {
  if (!p) return { text: "Iniciando…", fraction: null };
  if (p.stage === "download") {
    const fraction = p.total ? (p.loaded ?? 0) / p.total : null;
    const mb = p.total ? ` (${Math.round((p.loaded ?? 0) / 1e6)} de ${Math.round(p.total / 1e6)} MB)` : "";
    return { text: `Baixando o modelo ${p.label}${mb} — só na primeira vez`, fraction };
  }
  if (p.stage === "work" && p.total) return { text: p.label, fraction: (p.done ?? 0) / p.total };
  return { text: p.label, fraction: null };
}

/** Error text for the status bar; cancellation is not an error. */
export function aiErrorMessage(err: unknown): string | null {
  const message = (err as Error)?.message ?? String(err);
  if (/Cancelado/.test(message)) return null;
  // Electron prefixes IPC errors with the channel name.
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");
}
