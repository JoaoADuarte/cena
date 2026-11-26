import { create } from "zustand";
import { useEditor } from "./store";
import type { Project } from "./model/types";

/** After a change settles; and at the latest this long after the first unsaved change. */
const QUIET_MS = 2000;
const MAX_WAIT_MS = 10000;

export const useAutosave = create<{ savedAt: number | null; failed: boolean }>(() => ({ savedAt: null, failed: false }));

let timer: ReturnType<typeof setTimeout> | null = null;
let firstChange = 0;
let writing: Promise<void> | null = null;
let changedWhileWriting = false;

function cancelPending() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  firstChange = 0;
}

function schedule() {
  const now = Date.now();
  firstChange ||= now;
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => void write(), Math.max(0, Math.min(QUIET_MS, firstChange + MAX_WAIT_MS - now)));
}

function write(): Promise<void> {
  cancelPending();
  if (writing) {
    changedWhileWriting = true;
    return writing;
  }
  const { project, projectPath, dirty } = useEditor.getState();
  if (!dirty) return Promise.resolve();
  writing = window.api
    .autosaveWrite(project, projectPath)
    .then(
      (savedAt) => {
        if (savedAt !== null) useAutosave.setState({ savedAt, failed: false });
      },
      () => useAutosave.setState({ failed: true }),
    )
    .finally(() => {
      writing = null;
      if (changedWhileWriting) {
        changedWhileWriting = false;
        schedule();
      }
    });
  return writing;
}

/** Write what is pending now and wait until it is on disk. */
export async function flushAutosave() {
  if (writing) await writing;
  await write();
  if (writing) await writing;
}

export function startAutosave() {
  if (!window.api?.autosaveWrite) return;
  useEditor.subscribe((state, prev) => {
    if (!state.dirty) {
      // Saved, or replaced by another project after the user agreed to drop it.
      if (prev.dirty) {
        cancelPending();
        useAutosave.setState({ savedAt: null, failed: false });
        void window.api.autosaveClear();
      }
      return;
    }
    if (state.project !== prev.project || !prev.dirty) schedule();
  });
}

/** Bring back a copy found at startup. It stays unsaved until the user saves it; its old file goes once the new copy is safe. */
export async function recoverProject(id: string): Promise<boolean> {
  const copy = await window.api.autosaveRead(id);
  const data: Project = copy.data;
  if (data?.version !== 1 || !Array.isArray(data.tracks)) return false;
  useEditor.getState().loadProject(data, copy.path);
  useEditor.setState({ dirty: true });
  await flushAutosave();
  if (useAutosave.getState().failed) throw new Error("Não consegui guardar a cópia recuperada.");
  await window.api.autosaveDiscard(id);
  useEditor.getState().setStatus("Projeto recuperado. Salve com Ctrl+S para guardar no arquivo.");
  return true;
}
