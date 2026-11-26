// Utility-process entry point: runs one AI task per message and streams progress back.
import { TASKS } from "./tasks.mjs";

const port = process.parentPort;

port.on("message", async ({ data }) => {
  const { id, task, params } = data;
  try {
    if (!TASKS[task]) throw new Error(`Tarefa desconhecida: ${task}`);
    let last = 0;
    const result = await TASKS[task](params, (progress) => {
      // Per-frame reports would flood IPC; a few per second is plenty for a progress bar.
      const now = Date.now();
      if (now - last < 150 && progress.stage === "work" && progress.done !== progress.total) return;
      last = now;
      port.postMessage({ id, progress });
    });
    port.postMessage({ id, result });
  } catch (err) {
    port.postMessage({ id, error: err?.message ?? String(err) });
  }
});
