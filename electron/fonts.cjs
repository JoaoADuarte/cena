// Google Fonts on demand: download a family's Latin WOFF2 files once into userData/fonts so text
// keeps rendering offline and in exports. All Google Fonts are under open licenses (OFL/Apache).
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// Google serves WOFF2 only to browsers it recognizes.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const SUBSETS = new Set(["latin", "latin-ext"]);

/** Families differ in which weights/italics exist; ask for the richest set the family accepts. */
async function fetchCss(family) {
  const name = encodeURIComponent(family).replace(/%20/g, "+");
  const variants = ["ital,wght@0,400;0,700;1,400;1,700", "wght@400;700", ""];
  for (const v of variants) {
    const url = `https://fonts.googleapis.com/css2?family=${name}${v ? `:${v}` : ""}&display=swap`;
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30_000) });
    if (res.ok) return res.text();
  }
  throw new Error(`A fonte "${family}" não foi encontrada no Google Fonts.`);
}

/** @font-face blocks preceded by their subset comment, e.g. "/* latin *\/". */
function parseFaces(css) {
  const faces = [];
  const re = /\/\*\s*([\w-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const body = m[2];
    const get = (prop) => new RegExp(`${prop}:\\s*([^;]+);`).exec(body)?.[1].trim();
    const url = /url\(([^)]+)\)/.exec(body)?.[1];
    if (!url || !SUBSETS.has(m[1])) continue;
    faces.push({ subset: m[1], style: get("font-style") ?? "normal", weight: get("font-weight") ?? "400", unicodeRange: get("unicode-range") ?? null, url });
  }
  return faces;
}

async function ensureFont(family, root) {
  if (!/^[\w\s-]{1,80}$/.test(family)) throw new Error("Nome de fonte inválido.");
  const dir = path.join(root, family.replace(/\s+/g, "_"));
  const manifestPath = path.join(dir, "manifest.json");
  if (fs.existsSync(manifestPath)) return JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  const faces = parseFaces(await fetchCss(family));
  if (!faces.length) throw new Error(`A fonte "${family}" não tem arquivos para o alfabeto latino.`);
  await fsp.mkdir(dir, { recursive: true });
  const files = [];
  for (const f of faces) {
    if (!/^https:\/\/fonts\.gstatic\.com\//.test(f.url)) continue;
    const file = path.join(dir, `${f.style}-${f.weight}-${f.subset}.woff2`);
    const res = await fetch(f.url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Falha ao baixar a fonte (HTTP ${res.status}).`);
    await fsp.writeFile(file, Buffer.from(await res.arrayBuffer()));
    files.push({ path: file, weight: f.weight, style: f.style, unicodeRange: f.unicodeRange });
  }
  const manifest = { family, files };
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  return manifest;
}

// --- Google Fonts catalog ------------------------------------------------------------------

const CATALOG_MAX_AGE = 7 * 24 * 3600 * 1000;

/**
 * Every Google Fonts family that covers the Latin alphabet, most popular first. Fetched from the
 * public metadata feed (no API key) and cached for a week; the stale cache is used when offline.
 */
async function catalog(root) {
  const file = path.join(root, "catalog.json");
  let cached = null;
  try {
    const stat = await fsp.stat(file);
    cached = JSON.parse(await fsp.readFile(file, "utf8"));
    if (Date.now() - stat.mtimeMs < CATALOG_MAX_AGE) return cached;
  } catch {
    // No cache yet.
  }
  try {
    const res = await fetch("https://fonts.google.com/metadata/fonts", { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    // The feed starts with an anti-JSON-hijacking prefix on some responses.
    const body = JSON.parse((await res.text()).replace(/^\)\]\}'\s*/, ""));
    const list = (body.familyMetadataList ?? [])
      .filter((f) => (f.subsets ?? []).includes("latin"))
      .map((f) => ({ family: f.family, category: f.category ?? "", popularity: f.popularity ?? 9999 }))
      .sort((a, b) => a.popularity - b.popularity);
    await fsp.mkdir(root, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(list));
    return list;
  } catch (err) {
    if (cached) return cached;
    throw new Error(`Não foi possível carregar o catálogo do Google Fonts (${err.message}).`);
  }
}

// --- Imported font files ---------------------------------------------------------------------

/** Family and style from an OpenType/TrueType `name` table; null for formats it can't read (WOFF/WOFF2). */
function readFontNames(buf) {
  if (buf.length < 12) return null;
  const tag = buf.toString("latin1", 0, 4);
  if (tag !== "\0\x01\0\0" && tag !== "OTTO" && tag !== "true") return null;
  const numTables = buf.readUInt16BE(4);
  let nameOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + 16 * i;
    if (buf.toString("latin1", rec, rec + 4) === "name") nameOffset = buf.readUInt32BE(rec + 8);
  }
  if (nameOffset < 0) return null;
  const count = buf.readUInt16BE(nameOffset + 2);
  const strings = nameOffset + buf.readUInt16BE(nameOffset + 4);
  const names = {};
  const rank = {};
  for (let i = 0; i < count; i++) {
    const rec = nameOffset + 6 + 12 * i;
    const platform = buf.readUInt16BE(rec);
    const language = buf.readUInt16BE(rec + 4);
    const nameId = buf.readUInt16BE(rec + 6);
    const length = buf.readUInt16BE(rec + 8);
    const start = strings + buf.readUInt16BE(rec + 10);
    if (![1, 2, 16, 17].includes(nameId) || start + length > buf.length) continue;
    let text;
    if (platform === 3 || platform === 0) {
      // UTF-16BE.
      const bytes = Buffer.from(buf.subarray(start, start + length));
      bytes.swap16();
      text = bytes.toString("utf16le");
    } else if (platform === 1) text = buf.toString("latin1", start, start + length);
    else continue;
    // Names come in several languages ("Bold" / "Negrito"); prefer US English, then any Windows/Unicode entry.
    const score = (platform === 3 && language === 0x0409) || (platform === 1 && language === 0) ? 2 : platform === 1 ? 0 : 1;
    if (names[nameId] === undefined || score > rank[nameId]) {
      names[nameId] = text;
      rank[nameId] = score;
    }
  }
  const family = names[16] ?? names[1];
  if (!family) return null;
  const sub = names[17] ?? names[2] ?? "Regular";
  return { family: family.trim(), weight: /black|heavy/i.test(sub) ? "900" : /bold/i.test(sub) ? "700" : /light|thin/i.test(sub) ? "300" : "400", style: /italic|oblique/i.test(sub) ? "italic" : "normal" };
}

async function listCustom(root) {
  try {
    return JSON.parse(await fsp.readFile(path.join(root, "custom", "index.json"), "utf8"));
  } catch {
    return [];
  }
}

/** Copy font files into userData/fonts/custom and register them; returns the full list of imported fonts. */
async function importFonts(files, root) {
  const dir = path.join(root, "custom");
  await fsp.mkdir(dir, { recursive: true });
  const list = await listCustom(root);
  for (const file of files) {
    const buf = await fsp.readFile(file);
    const names = readFontNames(buf) ?? {
      // WOFF/WOFF2 are compressed; name them after the file ("Minha-Fonte-Bold.woff2" → "Minha Fonte").
      family: path.basename(file, path.extname(file)).replace(/[-_](regular|bold|italic|light|black|medium|semibold)+$/i, "").replace(/[-_]+/g, " ").trim(),
      weight: /bold/i.test(file) ? "700" : "400",
      style: /italic/i.test(file) ? "italic" : "normal",
    };
    const target = path.join(dir, path.basename(file));
    await fsp.copyFile(file, target);
    const entry = { family: names.family, weight: names.weight, style: names.style, path: target };
    const existing = list.findIndex((f) => f.path === target);
    if (existing >= 0) list[existing] = entry;
    else list.push(entry);
  }
  await fsp.writeFile(path.join(dir, "index.json"), JSON.stringify(list, null, 2));
  return list;
}

module.exports = { ensureFont, catalog, listCustom, importFonts, readFontNames };
