/**
 * Thumbnail agent: a few 1280×720 options made only from the video itself: a frame, the person cut out of it
 * (when there is one) and a short text. No generated images. The creator picks one in the review.
 */
const { BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { FFMPEG } = require("../../media.cjs");
const { ff, sdrFilter, withSdr } = require("../ffmpeg.cjs");
const { sentences, clock } = require("./cut.cjs");
const { keptWords, readWords, timeline, original, mergedCuts } = require("./edit.cjs");
const { artDirect, noFace } = require("./thumbnail-art.cjs");

const ROLE = `You are the Thumbnail agent. You receive the title, the summary and the transcript of a YouTube video (numbered sentences) and propose thumbnail texts.

A good thumbnail text has 2 to 4 words, is read in one second, creates curiosity or promises something, and does NOT repeat the title word for word. Upper case, in the language of the video. No emoji, no quotes, no hashtags.
For each option also choose the sentence whose moment should be the picture behind the text: a moment of strong emotion, reaction or the key subject, never the first 2 seconds.
"accent" is the one word of the text that gets the highlight colour.

Reply with: { "options": [{ "text": "NÃO FAÇA ISSO", "accent": "NÃO", "sentence": 14 }] }
Give exactly the number of options asked, each with a different text and a different sentence.`;

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plain = (text) => String(text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");

/** How much of the cut-out is opaque and where it sits, read from its alpha channel. */
function alphaBox(file) {
  return new Promise((resolve) => {
    execFile(FFMPEG, ["-hide_banner", "-i", file, "-frames:v", "1", "-vf", "alphaextract,signalstats,metadata=print:file=-,bbox=min_val=96", "-f", "null", "-"], { windowsHide: true, timeout: 60_000 }, (err, stdout, stderr) => {
      const cover = Number(/signalstats\.YAVG=([\d.]+)/.exec(String(stdout))?.[1]) / 255;
      const box = /x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+) w:(\d+) h:(\d+)/.exec(String(stderr));
      if (err || !Number.isFinite(cover) || !box) return resolve(null);
      resolve({ cover, x: Number(box[1]), y: Number(box[3]), w: Number(box[5]), h: Number(box[6]), bottom: Number(box[4]) });
    });
  });
}

function page({ frame, person, frameSize, text, accent, layout, colour }) {
  const words = text.split(/\s+/).filter(Boolean);
  const hit = words.findIndex((w) => plain(w) === plain(accent));
  const label = words.map((w, i) => (i === (hit < 0 ? words.length - 1 : hit) ? `<b>${esc(w)}</b>` : esc(w))).join(" ");
  const withPerson = Boolean(person) && layout.startsWith("pessoa");
  const right = layout === "pessoa-direita";
  let figure = "";
  if (withPerson) {
    const scale = Math.min(700 / person.h, 640 / person.w);
    figure = `<div class="who" style="${right ? "right" : "left"}:24px;width:${person.w * scale}px;height:${person.h * scale}px">
      <div style="width:100%;height:100%;overflow:hidden;position:relative"><img src="${esc(person.file)}" style="position:absolute;left:${-person.x * scale}px;top:${-person.y * scale}px;width:${frameSize.w * scale}px"></div></div>`;
  }
  const box = withPerson ? `${right ? "left" : "right"}:44px;width:600px;top:40px;bottom:40px;text-align:${right ? "left" : "right"};align-items:center` : layout === "faixa" ? "left:40px;right:40px;top:28px;height:330px;text-align:center;align-items:flex-start" : "left:48px;right:48px;bottom:30px;height:400px;text-align:left;align-items:flex-end";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:1280px;height:720px;overflow:hidden;background:#000}
.bg{position:absolute;inset:0;background:url("${esc(frame)}") center/cover no-repeat}
.bg.soft{filter:blur(7px) brightness(.6) saturate(1.25);transform:scale(1.08)}
.shade{position:absolute;inset:0;background:${withPerson ? "radial-gradient(ellipse at center, rgba(0,0,0,0) 40%, rgba(0,0,0,.55) 100%)" : layout === "faixa" ? "linear-gradient(to bottom, rgba(0,0,0,.78), rgba(0,0,0,0) 58%)" : "linear-gradient(to top, rgba(0,0,0,.85), rgba(0,0,0,0) 62%)"}}
.who{position:absolute;bottom:0;filter:drop-shadow(6px 0 0 #fff) drop-shadow(-6px 0 0 #fff) drop-shadow(0 -6px 0 #fff) drop-shadow(0 6px 0 #fff) drop-shadow(0 12px 26px rgba(0,0,0,.75))}
.box{position:absolute;display:flex;${box}}
.text{width:100%;font-family:Impact,"Arial Black","Segoe UI Black",sans-serif;font-size:190px;line-height:.98;letter-spacing:1px;text-transform:uppercase;color:#fff;-webkit-text-stroke:16px #000;paint-order:stroke fill;text-shadow:0 10px 0 #000,0 0 34px rgba(0,0,0,.7);transform:rotate(${withPerson ? -3 : 0}deg);overflow-wrap:normal;word-break:keep-all;hyphens:none}
.text b{font-weight:inherit;color:${esc(colour)}}
</style></head><body>
<div class="bg${withPerson ? " soft" : ""}"></div><div class="shade"></div>${figure}
<div class="box"><div class="text" id="t">${label}</div></div>
<script>
window.ready = (async () => {
  await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
  await new Promise((done) => { const i = new Image(); i.onload = i.onerror = done; i.src = ${JSON.stringify(frame)}; });
  await document.fonts.ready;
  const t = document.getElementById("t"), b = t.parentElement;
  let size = 190;
  while (size > 44 && (t.scrollHeight > b.clientHeight || t.scrollWidth > b.clientWidth)) t.style.fontSize = (size -= 6) + "px";
  t.style.webkitTextStroke = Math.max(8, Math.round(size / 11)) + "px #000";
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  return size;
})();
</script></body></html>`;
}

/** Draws one page in a window nobody sees and returns it as a JPEG. */
async function render(htmlFile) {
  const win = new BrowserWindow({ show: false, width: 1280, height: 720, useContentSize: true, frame: false, webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadFile(htmlFile);
    await win.webContents.executeJavaScript("window.ready");
    await new Promise((done) => setTimeout(done, 150));
    let image = await win.webContents.capturePage();
    const size = image.getSize();
    if (!size.width || !size.height) throw new Error("a imagem saiu vazia");
    if (size.width !== 1280 || size.height !== 720) image = image.resize({ width: 1280, height: 720, quality: "best" });
    return image.toJPEG(90);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * ctx: the agent context plus { video, dir, removeBackground(path, outPath) }.
 * `video.data.thumbnailRequest` ({ text }) asks for options around a text the creator wrote.
 */
async function run(ctx) {
  const { video, dir } = ctx;
  const cfg = ctx.settings.thumbnail;
  const count = Math.max(2, Math.min(6, Math.round(cfg.count) || 4));
  const folder = path.join(dir, "thumbs");
  fs.mkdirSync(folder, { recursive: true });
  const words = keptWords(readWords(dir), video.data.cuts);
  const lines = sentences(words);
  const toFinal = timeline(video.data.cuts);
  const duration = video.data.duration;
  const asked = String(video.data.thumbnailRequest?.text ?? "").trim();
  const note = String(video.data.thumbnailRequest?.note ?? "").trim();
  const attached = (video.data.thumbnailRequest?.images ?? []).filter((f) => fs.existsSync(f));

  // --- Texts and moments
  let options = [];
  if (lines.length >= 3) {
    ctx.progress(0.05, "Escolhendo textos e momentos");
    try {
      const { json } = await ctx.llm.ask({
        role: ROLE,
        model: ctx.settings.models.thumbnail,
        signal: ctx.signal,
        prompt: [
          `Title: "${video.title}"`,
          ctx.settings.channel.niche ? `Channel: ${ctx.settings.channel.niche}` : "",
          video.data.summary ? `Summary: ${video.data.summary}` : "",
          asked ? `The creator wants this text on the thumbnail: "${asked}". Use it (fixing only spelling) in every option and vary only the sentence.` : "",
          note ? `The creator asked for these thumbnails (follow it; it beats the rules above): ${note}` : "",
          ctx.brief ? `Creator's instructions for this video (follow only what concerns the thumbnail): ${ctx.brief}` : "",
          ctx.siblings?.length ? `Other videos of the same series already use these thumbnail texts. This one must look different and say something of its own:\n${ctx.siblings.map((t) => `- ${t}`).join("\n")}` : "",
          `Options wanted: ${count}`,
          "\n## Transcript",
          ...lines.map((s) => `${s.id}. [${clock(toFinal(s.start) ?? 0)}] ${s.text}`),
        ]
          .filter(Boolean)
          .join("\n"),
      });
      for (const o of Array.isArray(json.options) ? json.options : []) {
        const line = lines.find((s) => s.id === Number(o.sentence));
        const text = (asked || String(o.text ?? "")).trim().replace(/\s+/g, " ").slice(0, 40);
        if (line && text) options.push({ text, accent: String(o.accent ?? ""), time: Math.min(duration - 0.2, line.start + Math.min(0.8, (line.end - line.start) / 2)) });
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log("warn", `Não consegui pensar nos textos (${err.message}). Usei o título do vídeo.`);
    }
  }
  const fallbackText = (asked || video.title).split(/\s+/).slice(0, 4).join(" ");
  for (let i = 0; options.length < count; i++) {
    if (i > 12) break;
    // Spread over what stays in the video, never over what was cut out.
    const kept = duration - mergedCuts(video.data.cuts).reduce((sum, c) => sum + c.end - c.start, 0);
    const time = original(video.data.cuts)(kept * (0.15 + (0.7 * ((i * 5) % 7)) / 7));
    if (toFinal(time) === null && i < 12) continue;
    options.push({ text: options[i % Math.max(1, options.length)]?.text ?? fallbackText, accent: "", time });
  }
  options = options.slice(0, count);

  // --- Pictures
  for (const old of fs.readdirSync(folder)) fs.rmSync(path.join(folder, old), { force: true });
  const stamp = Date.now().toString(36);
  // Art direction first (frames looked at, zoom, arrow or ring, the creator's face, an image of their folder).
  if (cfg.art !== false || note || attached.length) {
    try {
      const art = await artDirect(ctx, { video, dir, folder, options, count, keep: (t) => toFinal(t) !== null, toFinal, render, stamp, assetFolders: ctx.assetFolders ?? [], note, attached });
      if (art) {
        ctx.log("decision", `${art.made.length} thumbnails desenhadas olhando os quadros: ${art.made.map((t) => `"${t.text}" (${t.layout.replace("arte: ", "")})`).join("; ")}. Escolha uma na revisão.`);
        return { thumbnails: art.made, thumbnail: art.made[0].path, facecam: art.facecam };
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      ctx.log("warn", `A direção de arte não deu certo (${err.message}); faço as thumbnails simples.`);
    }
  }
  const made = [];
  let people = 0;
  for (const [i, option] of options.entries()) {
    const base = 0.12 + (0.86 * i) / options.length;
    const step = 0.86 / options.length;
    ctx.progress(base, `Thumbnail ${i + 1} de ${options.length}`);
    const frame = path.join(folder, `quadro-${i + 1}.jpg`);
    await ff(["-ss", option.time.toFixed(3), "-i", video.source_path, "-frames:v", "1", "-vf", withSdr(await sdrFilter(video.source_path), "scale='min(1920,iw)':-2"), "-q:v", "2", frame], { signal: ctx.signal });
    if (!fs.existsSync(frame)) continue;
    const size = await new Promise((resolve) =>
      execFile(FFMPEG, ["-hide_banner", "-i", frame], { windowsHide: true }, (_e, _o, stderr) => {
        const m = /, (\d{2,5})x(\d{2,5})/.exec(String(stderr));
        resolve(m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1920, h: 1080 });
      }),
    );
    let person = null;
    try {
      const cutout = path.join(folder, `pessoa-${i + 1}.png`);
      await ctx.removeBackground(frame, cutout);
      const box = await alphaBox(cutout);
      // A person fills part of the frame. Almost nothing, or almost everything, means there was nobody to cut out.
      // A body is one solid shape inside its box; loose pieces of scenery spread over a large box are not a person.
      if (box && box.cover >= 0.1 && box.cover <= 0.62 && box.h >= size.h * 0.5 && box.w >= size.w * 0.15 && box.bottom >= size.h * 0.85 && (box.cover * size.w * size.h) / (box.w * box.h) >= 0.42) person = { ...box, file: path.basename(cutout) };
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      if (i === 0) ctx.log("warn", `Recorte da pessoa indisponível (${err.message}). Thumbnails só com quadro e texto.`);
    }
    if (person) people++;
    ctx.progress(base + step * 0.7, `Thumbnail ${i + 1} de ${options.length}`);
    if (person && noFace(note)) person = null;
    const layout = person ? (i % 2 ? "pessoa-esquerda" : "pessoa-direita") : i % 2 ? "faixa" : "quadro";
    const html = path.join(folder, `pagina-${i + 1}.html`);
    fs.writeFileSync(html, page({ frame: path.basename(frame), person, frameSize: size, text: option.text, accent: option.accent, layout, colour: ctx.settings.edit.textColour }));
    try {
      const file = path.join(folder, `thumb-${stamp}-${i + 1}.jpg`);
      fs.writeFileSync(file, await render(html));
      made.push({ path: file, text: option.text, layout, time: +option.time.toFixed(2), person: Boolean(person), design: { text: option.text, accent: option.accent, textAt: layout === "faixa" ? "top" : "bottom", zoom: null, arrow: null, ring: null, frameFile: path.basename(frame), faceFile: null, assetFile: null } });
    } catch (err) {
      ctx.log("warn", `Thumbnail ${i + 1} não saiu: ${err.message}`);
    }
    fs.rmSync(html, { force: true });
  }
  if (!made.length) throw new Error("Nenhuma thumbnail pôde ser gerada.");
  ctx.log("decision", `${made.length} thumbnails prontas (${people} com a pessoa recortada): ${made.map((t) => `"${t.text}"`).join(", ")}. Escolha uma na revisão.`);
  return { thumbnails: made, thumbnail: made[0].path };
}

module.exports = { run, render };
