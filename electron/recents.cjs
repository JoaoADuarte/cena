/**
 * Projects the user opened or saved, newest first, for the start screen. Kept in userData/recentes.json;
 * each entry is described from its .cena file (name, length, format, cover) when the screen asks.
 */
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const MAX_ENTRIES = 60;
const SECOND = 1_000_000;

function createRecents(file, { thumbnail }) {
  /** Covers by "path|mtime", so the screen does not run FFmpeg again for unchanged projects. */
  const covers = new Map();

  const read = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data.items) ? data.items.filter((i) => i && typeof i.path === "string") : [];
    } catch {
      return [];
    }
  };
  const write = (items) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items: items.slice(0, MAX_ENTRIES) }, null, 2));
    fs.renameSync(tmp, file);
  };
  const same = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

  /** The project was just opened or saved: move it to the top. */
  function touch(projectPath) {
    if (!projectPath) return;
    const items = read().filter((i) => !same(i.path, projectPath));
    write([{ path: path.resolve(projectPath), opened: Date.now() }, ...items]);
  }

  function remove(projectPath) {
    write(read().filter((i) => !same(i.path, projectPath)));
  }

  /** First picture of the project: the earliest visual clip on the main (bottom) video track, else any. */
  async function coverOf(project, key) {
    if (covers.has(key)) return covers.get(key);
    let cover = null;
    try {
      const video = (project.tracks ?? []).filter((t) => t.kind === "video");
      const ordered = [...video].reverse();
      const pick = ordered
        .flatMap((t) => [...(t.segments ?? [])].sort((a, b) => a.start - b.start))
        .find((s) => s.materialId && project.materials?.[s.materialId] && project.materials[s.materialId].kind !== "audio" && fs.existsSync(project.materials[s.materialId].path));
      if (pick) cover = await thumbnail(project.materials[pick.materialId].path, (pick.sourceStart ?? 0) / SECOND + 0.05);
    } catch {
      cover = null;
    }
    covers.set(key, cover);
    return cover;
  }

  async function describe(entry) {
    try {
      const stat = await fsp.stat(entry.path);
      const project = JSON.parse(await fsp.readFile(entry.path, "utf8"));
      let end = 0;
      let clips = 0;
      for (const t of project.tracks ?? [])
        for (const s of t.segments ?? []) {
          end = Math.max(end, (s.start ?? 0) + (s.duration ?? 0));
          clips++;
        }
      return {
        path: entry.path,
        name: project.name || path.basename(entry.path, ".cena"),
        opened: entry.opened,
        modified: stat.mtimeMs,
        duration: end / SECOND,
        width: project.width ?? null,
        height: project.height ?? null,
        clips,
        cover: await coverOf(project, `${entry.path}|${stat.mtimeMs}`),
        missing: false,
      };
    } catch {
      return { path: entry.path, name: path.basename(entry.path, ".cena"), opened: entry.opened, modified: null, duration: 0, width: null, height: null, clips: 0, cover: null, missing: true };
    }
  }

  return {
    touch,
    remove,
    list: () => Promise.all(read().map(describe)),
  };
}

module.exports = { createRecents };
