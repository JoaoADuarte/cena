/**
 * Automatic copies of the unsaved project, so a power cut or crash loses seconds of work at most.
 * Each launch writes one file in the autosave folder and never touches the user's .cena file.
 * The file goes away when the project is saved or discarded; one still there at startup, whose
 * owner is gone, is work to recover.
 *
 * Every copy is flushed to disk before it replaces the previous one, and that previous one is kept
 * until the next copy lands: a cut in the middle of a write leaves at least one whole file.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const SECOND = 1_000_000;
const EXTENSIONS = [".json", ".bak", ".tmp"];

/** Write and flush, so the data survives a power cut once this returns. */
async function durableWrite(file, text) {
  const handle = await fsp.open(file, "w");
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Antivirus and search indexers can hold a just-written file for a moment on Windows. */
async function renameRetrying(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fsp.rename(from, to);
    } catch (err) {
      if (attempt >= 4 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, 60 * (attempt + 1)));
    }
  }
}

const bootTime = () => Date.now() - os.uptime() * 1000;

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** Another Cena still running owns this copy; after a restart of the computer no old process counts. */
const ownerRunning = (copy) => Math.abs((copy.boot ?? 0) - bootTime()) < 120_000 && Number.isInteger(copy.pid) && processAlive(copy.pid);

const validCopy = (copy) => copy?.version === 1 && copy.project?.version === 1 && Array.isArray(copy.project.tracks) && Number.isFinite(copy.savedAt);

function createAutosave(dir) {
  const run = crypto.randomUUID();
  let queue = Promise.resolve();
  let closed = false;
  /** One operation at a time: a clear can never be overtaken by a write that started before it. */
  const enqueue = (task) => {
    const result = queue.then(task, task);
    queue = result.catch(() => {});
    return result;
  };
  const fileOf = (id, ext) => path.join(dir, `${id}${ext}`);

  const removeFiles = (id) => Promise.all(EXTENSIONS.map((ext) => fsp.rm(fileOf(id, ext), { force: true })));

  function write(project, projectPath) {
    return enqueue(async () => {
      if (closed) return null;
      await fsp.mkdir(dir, { recursive: true });
      const savedAt = Date.now();
      const tmp = fileOf(run, ".tmp");
      const main = fileOf(run, ".json");
      await durableWrite(tmp, JSON.stringify({ version: 1, savedAt, pid: process.pid, boot: bootTime(), path: projectPath ?? null, project }));
      if (fs.existsSync(main)) await renameRetrying(main, fileOf(run, ".bak"));
      await renameRetrying(tmp, main);
      return savedAt;
    });
  }

  /** The newest whole copy of a session, whichever of its files survived. */
  async function bestCopy(id) {
    let best = null;
    for (const ext of EXTENSIONS) {
      try {
        const copy = JSON.parse(await fsp.readFile(fileOf(id, ext), "utf8"));
        if (validCopy(copy) && (!best || copy.savedAt > best.savedAt)) best = copy;
      } catch {
        // Missing or cut short; another file of the session may be whole.
      }
    }
    return best;
  }

  async function list() {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return [];
    }
    const ids = [...new Set(names.filter((n) => EXTENSIONS.includes(path.extname(n))).map((n) => path.basename(n, path.extname(n))))].filter((id) => id !== run);
    const found = [];
    for (const id of ids) {
      const copy = await bestCopy(id);
      if (!copy || ownerRunning(copy)) continue;
      let end = 0;
      let clips = 0;
      for (const t of copy.project.tracks)
        for (const s of t.segments ?? []) {
          end = Math.max(end, (s.start ?? 0) + (s.duration ?? 0));
          clips++;
        }
      found.push({ id, name: copy.project.name || "Projeto sem nome", path: copy.path, savedAt: copy.savedAt, duration: end / SECOND, clips });
    }
    return found.sort((a, b) => b.savedAt - a.savedAt);
  }

  async function read(id) {
    const copy = await bestCopy(id);
    if (!copy) throw new Error("A cópia automática não pôde ser lida.");
    return { path: copy.path, data: copy.project, savedAt: copy.savedAt };
  }

  return {
    write,
    list,
    read,
    /** Delete a copy found at startup. */
    discard: (id) => enqueue(() => removeFiles(id)),
    /** The project was saved or dropped: this launch has nothing to recover. */
    clear: () => enqueue(() => removeFiles(run)),
    /** The window is closing on the user's decision; nothing written after this. */
    close() {
      closed = true;
      return enqueue(() => removeFiles(run));
    },
  };
}

module.exports = { createAutosave, durableWrite };
