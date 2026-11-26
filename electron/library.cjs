// Sound and music library: Creative Commons search through Openverse (Jamendo music, Freesound
// effects) plus a small set of sound effects synthesized locally, which work offline.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { FFMPEG, run } = require("./media.cjs");

const OPENVERSE = "https://api.openverse.org/v1/audio/";

const LICENSE_NAMES = {
  cc0: "CC0 (domínio público)",
  pdm: "Domínio público",
  by: "CC BY",
  "by-sa": "CC BY-SA",
  "by-nd": "CC BY-ND",
  "by-nc": "CC BY-NC",
  "by-nc-sa": "CC BY-NC-SA",
  "by-nc-nd": "CC BY-NC-ND",
  sampling: "Sampling+",
  "sampling+": "Sampling+",
};

/** params: { query, category: "music" | "sound_effect", page, commercial } */
async function search({ query, category, page = 1, commercial = true }) {
  const url = new URL(OPENVERSE);
  // Searches without a term often fail upstream, so fall back to a broad one.
  url.searchParams.set("q", query?.trim() || (category === "music" ? "music" : "sound"));
  // Filtering by source is far faster upstream than by category (and Freesound items carry no
  // category at all): Jamendo is all music, Freesound is sound effects.
  url.searchParams.set("source", category === "music" ? "jamendo" : "freesound");
  url.searchParams.set("page_size", "20");
  url.searchParams.set("page", String(page));
  url.searchParams.set("mature", "false");
  if (commercial) url.searchParams.set("license_type", "commercial");
  let res;
  // Openverse answers 500/502/504 now and then; one retry clears most of them.
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(90_000) });
    if (res.ok || res.status < 500) break;
  }
  if (!res.ok) throw new Error(`O serviço de busca (Openverse) não respondeu (HTTP ${res.status}). Tente de novo em instantes.`);
  const body = await res.json();
  return {
    total: body.result_count ?? 0,
    pages: body.page_count ?? 1,
    results: (body.results ?? [])
      .filter((r) => typeof r.url === "string" && /^https:\/\//.test(r.url))
      .map((r) => ({
        id: String(r.id),
        title: r.title || "Sem título",
        creator: r.creator || "Autor desconhecido",
        license: LICENSE_NAMES[r.license] ?? String(r.license ?? "").toUpperCase(),
        // CC0 and public domain need no credit; everything else asks for attribution.
        needsCredit: !["cc0", "pdm"].includes(r.license),
        licenseUrl: r.license_url ?? null,
        landingUrl: r.foreign_landing_url ?? null,
        url: r.url,
        filetype: r.filetype ?? null,
        duration: typeof r.duration === "number" ? r.duration / 1000 : null,
        source: r.source ?? r.provider ?? "",
      })),
  };
}

const EXT = new Set([".mp3", ".wav", ".ogg", ".oga", ".flac", ".m4a", ".aac", ".opus"]);

/** Save a search result into the library folder; returns the local path (cached by id). */
async function download(item, dir) {
  if (!/^https:\/\//.test(item.url)) throw new Error("Endereço de áudio inválido.");
  await fsp.mkdir(dir, { recursive: true });
  let ext = path.extname(new URL(item.url).pathname).toLowerCase();
  // Jamendo URLs carry no extension and report MP3 as "mp32".
  if (!EXT.has(ext)) ext = `.${String(item.filetype ?? "mp3").replace(/^mp3\d*$/, "mp3")}`;
  if (!EXT.has(ext)) ext = ".mp3";
  const safeId = String(item.id).replace(/[^\w-]/g, "");
  const file = path.join(dir, `${item.source || "audio"}-${safeId}${ext}`);
  if (fs.existsSync(file)) return file;
  const res = await fetch(item.url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`O download falhou (HTTP ${res.status}).`);
  const tmp = `${file}.part`;
  await fsp.writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await fsp.rename(tmp, file);
  return file;
}

// Each effect is an FFmpeg lavfi graph; they are rendered once into the library folder.
const BUILTINS = [
  { id: "whoosh", name: "Whoosh", graph: "anoisesrc=d=0.9:c=pink:a=0.7,highpass=f=250,lowpass=f=2800,afade=t=in:d=0.4,afade=t=out:st=0.4:d=0.5" },
  { id: "pop", name: "Pop", graph: "aevalsrc='0.8*sin(2*PI*(300+1800*exp(-40*t))*t)*exp(-22*t)':d=0.3" },
  { id: "click", name: "Clique", graph: "aevalsrc='0.9*sin(2*PI*2400*t)*exp(-110*t)':d=0.1" },
  { id: "ding", name: "Ding", graph: "aevalsrc='0.5*sin(2*PI*1320*t)*exp(-4*t)+0.3*sin(2*PI*2640*t)*exp(-6*t)+0.15*sin(2*PI*3960*t)*exp(-9*t)':d=1.6" },
  { id: "beep", name: "Bipe", graph: "sine=f=1000:d=0.35,afade=t=out:st=0.28:d=0.07" },
  { id: "impact", name: "Impacto", graph: "aevalsrc='0.9*sin(2*PI*(45+110*exp(-10*t))*t)*exp(-4.5*t)':d=1.4" },
  { id: "riser", name: "Subida", graph: "aevalsrc='0.35*sin(2*PI*(180*t+260*t*t))+0.12*sin(2*PI*(360*t+520*t*t))':d=2.2,afade=t=in:d=2,afade=t=out:st=2.1:d=0.1" },
  { id: "glitch", name: "Glitch", graph: "anoisesrc=d=0.45:c=white:a=0.5,acrusher=bits=4:mode=log:aa=1,tremolo=f=28:d=1,afade=t=out:st=0.35:d=0.1" },
  { id: "coin", name: "Moeda", graph: "aevalsrc='0.45*sin(2*PI*988*t)*lt(t,0.08)+0.45*sin(2*PI*1319*t)*gte(t,0.08)*exp(-7*(t-0.08))':d=0.7" },
  { id: "swipe", name: "Deslizar", graph: "anoisesrc=d=0.35:c=white:a=0.5,bandpass=f=4000:w=3000,afade=t=in:d=0.12,afade=t=out:st=0.15:d=0.2" },
];

async function builtins(dir) {
  await fsp.mkdir(dir, { recursive: true });
  const list = [];
  for (const b of BUILTINS) {
    const file = path.join(dir, `cena-${b.id}.wav`);
    if (!fs.existsSync(file)) {
      await run(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", b.graph, "-ac", "2", "-ar", "48000", file]);
    }
    list.push({ id: b.id, name: b.name, path: file });
  }
  return list;
}

module.exports = { search, download, builtins };
