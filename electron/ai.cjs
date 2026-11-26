// Main-process side of the AI tasks: owns a utility process, one job at a time.
const { app, utilityProcess } = require("electron");
const path = require("node:path");

/** One worker process with its own queue of one. The editor and the studio each keep theirs, so neither blocks the other. */
function createAi(serviceName = "Cena IA") {
  let child = null;
  let current = null;
  let seq = 0;

  function onMessage(msg) {
    if (!current || msg.id !== current.id) return;
    if (msg.progress) {
      // A broken progress callback must never take down the main process.
      try {
        current.onProgress(msg.progress);
      } catch (err) {
        console.error("[ia] erro no callback de progresso:", err);
      }
    } else {
      const job = current;
      current = null;
      if (msg.error) job.reject(new Error(msg.error));
      else job.resolve(msg.result);
    }
  }

  function ensureChild() {
    if (child) return child;
    child = utilityProcess.fork(path.join(__dirname, "ai", "worker.mjs"), [], {
      serviceName,
      stdio: "pipe",
      env: { ...process.env, CENA_MODELS: path.join(app.getPath("userData"), "models") },
    });
    child.stdout?.on("data", (c) => process.stdout.write(`[ia] ${c}`));
    child.stderr?.on("data", (c) => process.stderr.write(`[ia] ${c}`));
    child.on("message", onMessage);
    child.on("exit", (code) => {
      child = null;
      if (current) {
        const job = current;
        current = null;
        job.reject(new Error(job.cancelled ? "Cancelado." : `O processo de IA parou inesperadamente (código ${code}).`));
      }
    });
    return child;
  }

  function run(task, params, onProgress = () => {}) {
    if (current) return Promise.reject(new Error("Já existe uma tarefa de IA em andamento."));
    const worker = ensureChild();
    return new Promise((resolve, reject) => {
      current = { id: ++seq, resolve, reject, onProgress, cancelled: false };
      worker.postMessage({ id: current.id, task, params });
    });
  }

  /** Killing the process is the only way to stop an inference mid-run; the next job starts a new one. */
  function cancel() {
    if (!current || !child) return;
    current.cancelled = true;
    child.kill();
  }

  function dispose() {
    child?.kill();
  }

  return { run, cancel, dispose, busy: () => current !== null };
}

module.exports = { ...createAi(), createAi };
