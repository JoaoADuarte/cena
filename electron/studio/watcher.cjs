/**
 * Watched folder: a raw video dropped there starts the pipeline by itself.
 * Node's own watcher plus a size check is enough here, and adds no dependency: a file only counts
 * once it stopped growing, so a recording still being copied or written is left alone.
 */
const fs = require("node:fs");
const path = require("node:path");

const VIDEO_EXT = /\.(mp4|mov|mkv|m4v|webm)$/i;
const SETTLE_MS = 4000;

function createWatcher(onVideo) {
  let watcher = null;
  let folder = null;
  let scanTimer = null;
  let ignored = "";
  /** file → { size, since } */
  const growing = new Map();
  const reported = new Set();

  function check() {
    if (!folder) return;
    let names = [];
    try {
      names = fs.readdirSync(folder);
    } catch {
      return;
    }
    for (const name of names) {
      if (!VIDEO_EXT.test(name)) continue;
      const file = path.join(folder, name);
      if (reported.has(file)) continue;
      let size;
      try {
        size = fs.statSync(file).size;
      } catch {
        continue;
      }
      const seen = growing.get(file);
      if (!seen || seen.size !== size) growing.set(file, { size, since: Date.now() });
      else if (size > 0 && Date.now() - seen.since >= SETTLE_MS) {
        growing.delete(file);
        reported.add(file);
        onVideo(file);
      }
    }
  }

  function close() {
    watcher?.close();
    watcher = null;
    clearInterval(scanTimer);
    scanTimer = null;
    folder = null;
    growing.clear();
  }

  function apply({ enabled, folder: wanted, ignore = [] }) {
    if (!enabled || !wanted || !fs.existsSync(wanted)) return close();
    const key = ignore.join("|");
    if (folder === wanted && ignored === key) return;
    close();
    folder = wanted;
    ignored = key;
    reported.clear();
    for (const name of ignore) reported.add(path.join(folder, name));
    try {
      watcher = fs.watch(folder, () => check());
      watcher.on("error", () => {});
    } catch {
      // Network drives may refuse; the timer below still finds new files.
    }
    scanTimer = setInterval(check, 2000);
    check();
  }

  return { apply, close };
}

module.exports = { createWatcher, VIDEO_EXT };
