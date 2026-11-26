/**
 * The assistant's memory: lasting editing preferences ("legendas sempre amarelas", "meus vídeos são
 * verticais"), kept in userData/preferencias.json. Every conversation starts with them, so the
 * assistant edits the user's way without being told again.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_ITEMS = 100;
const MAX_TEXT = 400;

function createMemory(file, onChange = () => {}) {
  const read = () => {
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(data.items) ? data.items.filter((i) => i && typeof i.id === "string" && typeof i.text === "string") : [];
    } catch {
      return [];
    }
  };
  const write = (items) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, items }, null, 2));
    fs.renameSync(tmp, file);
    onChange(items);
    return items;
  };

  return {
    list: read,
    /** Add a preference; one that says the same thing replaces the older one. */
    add(text) {
      const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
      if (!clean) throw new Error("A preferência está vazia.");
      const key = clean.toLowerCase();
      const items = read().filter((i) => i.text.toLowerCase() !== key);
      const item = { id: crypto.randomBytes(4).toString("hex"), text: clean, created: Date.now() };
      return write([...items, item].slice(-MAX_ITEMS));
    },
    update(id, text) {
      const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
      if (!clean) throw new Error("A preferência está vazia.");
      const items = read();
      const item = items.find((i) => i.id === id);
      if (!item) throw new Error(`Não existe a preferência ${id}.`);
      item.text = clean;
      return write(items);
    },
    remove(ids) {
      const drop = new Set(Array.isArray(ids) ? ids : [ids]);
      return write(read().filter((i) => !drop.has(i.id)));
    },
    clear: () => write([]),
    /** The preferences as a block for the assistant's instructions ("" when there are none). */
    prompt() {
      const items = read();
      if (!items.length) return "";
      return `\n\nThe user's saved editing preferences (from earlier conversations). Follow them unless the user asks otherwise in this request:\n${items.map((i) => `- [${i.id}] ${i.text}`).join("\n")}`;
    },
  };
}

module.exports = { createMemory };
