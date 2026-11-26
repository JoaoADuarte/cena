/**
 * Art direction for thumbnails, in the style of big gaming channels: the AI looks at candidate frames of the video
 * and designs each thumbnail: which frame, a zoom on the subject, a thick arrow or a ring on the thing that matters,
 * the creator's face from the webcam in a bordered box (the most expressive moment) and a short text with a
 * highlighted word. Every image comes from the video itself: nothing from the internet or from other files.
 */
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { FFMPEG } = require("../../media.cjs");
const { ff, sdrFilter, withSdr } = require("../ffmpeg.cjs");
const { clock } = require("./cut.cjs");

const FONT = ["C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/arial.ttf"].find((f) => fs.existsSync(f)) ?? null;
const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const plain = (text) => String(text ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, fallback) => (Number.isFinite(Number(v)) && v !== null && v !== "" ? Number(v) : fallback);
const label = (text) => (FONT ? `,drawtext=fontfile='${FONT.replace(":", "\\:")}':text='${String(text).replace(/:/g, "\\:")}':x=8:y=8:fontsize=34:fontcolor=yellow:box=1:boxcolor=black@0.75` : "");

const FACE_ROLE = `You look at frames of a gameplay recording. Some recordings show the creator's webcam (facecam) as a small rectangle over the game. Say where it is, as fractions of the frame (x, y of the top-left corner, w, h; 0 to 1), tight around the webcam picture; or null when there is no webcam showing a person.
Reply with JSON only: { "facecam": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 } }`;

const DESIGN_ROLE = `You are the art director of YouTube thumbnails for a gameplay creator who talks over the game (Brazilian Portuguese). Make thumbnails like the big gaming channels: ONE clear subject, big bold text of 2 to 4 words, the creator's face reacting in a bordered box (webcam inset), and a thick arrow or a ring pointing at the key thing (the car, the item, the enemy, the money, the score). High contrast, little clutter, readable on a phone.
You get:
- A sheet of numbered candidate frames (Read it). Each frame has a light grid that splits it in quarters (lines at 0.25, 0.5 and 0.75): use it to give exact coordinates, as fractions of the frame (0 to 1). The arrow tip and the ring centre must sit ON the subject.
- Maybe a sheet of numbered faces of the creator (Read it): pick the most expressive one for each design (surprise, shock, laugh, anger). Do not pick a neutral or eyes-closed face.
- Text ideas already written for this video. Use them or improve them (2 to 4 words, CAPS, Brazilian Portuguese, no emoji, not the title word for word).
Rules: the arrow points from empty space to the subject and must not cover the face box or the text; the ring goes around the subject; "zoom" enlarges the frame around a point (scale 1 to 1.8) to make the subject bigger; keep the text on the side away from the face; every design must use a different frame or a clearly different layout.

Reply with JSON only:
{ "designs": [{ "frame": 1, "zoom": { "x": 0.5, "y": 0.5, "scale": 1.2 }, "text": "FUGA DA POLÍCIA", "accent": "POLÍCIA", "textAt": "top | bottom | left | right", "arrow": { "from": [0.2, 0.2], "to": [0.45, 0.55] }, "ring": { "x": 0.5, "y": 0.6, "r": 0.09 }, "face": 2, "faceAt": "tl | tr | bl | br", "colour": "#ffd400", "why": "short reason in Brazilian Portuguese" }] }
Use null for arrow, ring or face when they do not help. Give exactly the number of designs asked.
When images of the creator are listed, a design may use one: "image": { "file": "exact name", "mode": "sticker | background", "x": 0.75, "y": 0.6, "w": 0.3 } (sticker: centre x, y and width as fractions of the thumbnail; background: the image replaces the frame). Use null otherwise.
The creator's request, when there is one, comes first: it beats every rule above (for example "no webcam" means face null in every design; "use the image x" means that image in every design).`;

const REVIEW_ROLE = `You check finished YouTube thumbnails (numbered) against the original frames they were made from (those have a grid at 0.25, 0.5 and 0.75). For each thumbnail: does the arrow tip touch the subject, and does the ring surround it? Is the subject covered by the text or the face box?
When something misses, give corrected values in FRAME coordinates (fractions of the original frame, 0 to 1), the same format as given: "arrow": { "from": [x, y], "to": [x, y] } or null, "ring": { "x", "y", "r" } or null, "zoom": { "x", "y", "scale" }. Only fix what is wrong.
Reply with JSON only: { "fixes": [{ "n": 1, "ok": true }, { "n": 2, "ok": false, "ring": { "x": 0.6, "y": 0.55, "r": 0.1 } }] }`;

/** Where the opaque part of a cut-out is. */
const alphaBox = (file) =>
  new Promise((resolve) =>
    execFile(FFMPEG, ["-hide_banner", "-i", file, "-frames:v", "1", "-vf", "alphaextract,bbox=min_val=96", "-f", "null", "-"], { windowsHide: true, timeout: 60_000 }, (err, _o, stderr) => {
      const m = /x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+) w:(\d+) h:(\d+)/.exec(String(stderr));
      resolve(err || !m ? null : { x: Number(m[1]), y: Number(m[3]), w: Number(m[5]), h: Number(m[6]) });
    }),
  );

const probeSize = (file) =>
  new Promise((resolve) =>
    execFile(FFMPEG, ["-hide_banner", "-i", file], { windowsHide: true }, (_e, _o, stderr) => {
      const m = /, (\d{2,5})x(\d{2,5})/.exec(String(stderr));
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(String(stderr));
      resolve({ w: m ? Number(m[1]) : 1920, h: m ? Number(m[2]) : 1080, duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0 });
    }),
  );

/** Moments with strong action measured on the picture (when the Cut agent measured it), spread over the video. */
function actionMoments(dir, keep, count) {
  try {
    const visual = JSON.parse(fs.readFileSync(path.join(dir, "visual.json"), "utf8"));
    const score = visual.score ?? [];
    const order = score.map((v, t) => ({ v, t })).sort((a, b) => b.v - a.v);
    const out = [];
    for (const s of order) {
      if (out.length >= count) break;
      if (s.v < 0.6 || !keep(s.t + 0.5) || out.some((t) => Math.abs(t - s.t) < 25)) continue;
      out.push(s.t + 0.5);
    }
    return out;
  } catch {
    return [];
  }
}

/** Image files in the creator's AI folders, by name (the name says what they are). */
function folderImages(folders) {
  const out = [];
  for (const folder of folders) {
    try {
      for (const name of fs.readdirSync(folder)) if (/\.(png|webp|jpe?g)$/i.test(name) && !/^ChatGPT Image/i.test(name)) out.push(path.join(folder, name));
    } catch {
      // A folder that went away.
    }
  }
  return out.slice(0, 80);
}

async function sheet(files, out, cols, tileW, tileH, signal, grid = false) {
  const list = path.join(path.dirname(out), `${path.basename(out, ".jpg")}-%03d.jpg`);
  for (const [i, f] of files.entries()) await ff(["-y", "-i", f.path, "-vf", `scale=${tileW}:${tileH}:force_original_aspect_ratio=decrease,pad=${tileW}:${tileH}:(ow-iw)/2:(oh-ih)/2${grid ? ",drawgrid=w=iw/4:h=ih/4:t=1:c=white@0.45" : ""}${label(f.label)}`, "-q:v", "4", list.replace("%03d", String(i).padStart(3, "0"))], { signal });
  const rows = Math.ceil(files.length / cols);
  await ff(["-y", "-framerate", "1", "-i", list, "-vf", `tile=${cols}x${rows}:color=black`, "-frames:v", "1", "-q:v", "4", out], { signal });
  return out;
}

/** The page for one design, 1280×720. Frame coordinates are mapped through the zoom. */
function designPage({ frame, design, face, faceSize, asset, colour, extras = null }) {
  const W = 1280;
  const H = 720;
  const scale = clamp(num(design.zoom?.scale, 1), 1, 1.8);
  const bw = W * scale;
  const bh = H * scale;
  const left = clamp(W / 2 - num(design.zoom?.x, 0.5) * bw, W - bw, 0);
  const top = clamp(H / 2 - num(design.zoom?.y, 0.5) * bh, H - bh, 0);
  const at = (p) => [left + clamp(num(p?.[0], 0.5), 0, 1) * bw, top + clamp(num(p?.[1], 0.5), 0, 1) * bh];
  const tint = /^#[0-9a-f]{6}$/i.test(String(design.colour ?? "")) ? design.colour : colour;
  const words = String(design.text).split(/\s+/).filter(Boolean);
  const hit = words.findIndex((w) => plain(w) === plain(design.accent));
  const text = words.map((w, i) => (i === (hit < 0 ? words.length - 1 : hit) ? `<b>${esc(w)}</b>` : esc(w))).join(" ");
  const corner = ["tl", "tr", "bl", "br"].includes(design.faceAt) ? design.faceAt : "tl";
  const faceW = face ? Math.round(clamp((faceSize.w / faceSize.h) * 300, 240, 440)) : 0;
  const faceH = face ? Math.round(faceW * (faceSize.h / faceSize.w)) : 0;
  const side = ["top", "bottom", "left", "right"].includes(design.textAt) ? design.textAt : "bottom";
  // The text keeps clear of the face box.
  const faceTop = corner[0] === "t";
  const faceLeft = corner[1] === "l";
  let box;
  if (side === "top" || side === "bottom") {
    const sameRow = face && (side === "top") === faceTop;
    box = `${side}:26px;height:300px;left:${sameRow && faceLeft ? faceW + 70 : 40}px;right:${sameRow && !faceLeft ? faceW + 70 : 40}px;align-items:${side === "top" ? "flex-start" : "flex-end"};text-align:center`;
  } else {
    const sameSide = face && (side === "left") === faceLeft;
    box = `${side}:36px;width:560px;top:${sameSide && faceTop ? faceH + 60 : 36}px;bottom:${sameSide && !faceTop ? faceH + 60 : 36}px;align-items:center;text-align:${side}`;
  }
  const shade = { top: "to bottom", bottom: "to top", left: "to right", right: "to left" }[side];
  let svg = "";
  if (design.arrow?.from && design.arrow?.to) {
    const [x1, y1] = at(design.arrow.from);
    const [x2, y2] = at(design.arrow.to);
    const len = Math.hypot(x2 - x1, y2 - y1);
    if (len > 60) {
      // The line stops at the base of the head, so the tip is sharp.
      const ux = (x2 - x1) / len;
      const uy = (y2 - y1) / len;
      const head = 64;
      const bx = x2 - ux * head;
      const by = y2 - uy * head;
      const px = -uy * 44;
      const py = ux * 44;
      const tri = `${x2},${y2} ${bx + px},${by + py} ${bx - px},${by - py}`;
      svg += `<line x1="${x1}" y1="${y1}" x2="${bx}" y2="${by}" stroke="#000" stroke-width="40" stroke-linecap="round"/><polygon points="${tri}" fill="#000" stroke="#000" stroke-width="14" stroke-linejoin="round"/>`;
      svg += `<line x1="${x1}" y1="${y1}" x2="${bx}" y2="${by}" stroke="${esc(tint)}" stroke-width="26" stroke-linecap="round"/><polygon points="${tri}" fill="${esc(tint)}"/>`;
    }
  }
  if (design.ring) {
    const [cx, cy] = at([design.ring.x, design.ring.y]);
    const r = clamp(num(design.ring.r, 0.08), 0.03, 0.3) * bw;
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#000" stroke-width="22"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${esc(tint)}" stroke-width="12" filter="url(#glow)"/>`;
  }
  const imageTag = asset && design.image?.mode !== "background"
    ? `<img class="asset" src="${esc(asset)}" style="left:${clamp(num(design.image.x, 0.75), 0, 1) * W}px;top:${clamp(num(design.image.y, 0.6), 0, 1) * H}px;width:${clamp(num(design.image.w, 0.3), 0.08, 0.7) * W}px">`
    : "";
  const facePos = `${faceTop ? "top" : "bottom"}:28px;${faceLeft ? "left" : "right"}:28px`;
  // Texts and images the creator added in the editor: centre x, y as fractions; size in pixels of the 1280 wide picture.
  const extraTags = [
    ...(extras?.images ?? []).map((m) => `<img class="xi" src="${esc(m.file)}" style="left:${clamp(num(m.x, 0.5), 0, 1) * W}px;top:${clamp(num(m.y, 0.5), 0, 1) * H}px;width:${clamp(num(m.w, 0.3), 0.03, 1.5) * W}px">`),
    ...(extras?.texts ?? []).map((x) => {
      const size = clamp(num(x.size, 90), 16, 400);
      return `<div class="xt" style="left:${clamp(num(x.x, 0.5), 0, 1) * W}px;top:${clamp(num(x.y, 0.5), 0, 1) * H}px;font-size:${size}px;color:${esc(/^#[0-9a-f]{6}$/i.test(String(x.colour ?? "")) ? x.colour : "#ffffff")};-webkit-text-stroke:${Math.max(4, Math.round(size / 11))}px #000;text-shadow:0 ${Math.round(size / 18)}px 0 #000,0 0 ${Math.round(size / 5)}px rgba(0,0,0,.7)">${esc(String(x.text ?? "")).replace(/\n/g, "<br>")}</div>`;
    }),
  ].join("");
  const hasText = words.length > 0;
  const plainBg = Boolean(design.plain);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;overflow:hidden;background:#000}
.bg{position:absolute;left:${left}px;top:${top}px;width:${bw}px;height:${bh}px;object-fit:cover;${plainBg ? "" : "filter:saturate(1.3) contrast(1.12) brightness(1.04)"}}
.xi{position:absolute;transform:translate(-50%,-50%);filter:drop-shadow(0 8px 16px rgba(0,0,0,.6))}
.xt{position:absolute;transform:translate(-50%,-50%);font-family:Impact,"Arial Black","Segoe UI Black",sans-serif;line-height:.98;letter-spacing:1px;text-transform:uppercase;paint-order:stroke fill;white-space:nowrap;text-align:center}
.shade{position:absolute;inset:0;${hasText ? "" : "display:none;"}background:linear-gradient(${shade}, rgba(0,0,0,.72), rgba(0,0,0,0) 48%), radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,.45) 100%)}
svg{position:absolute;inset:0}
.asset{position:absolute;transform:translate(-50%,-50%) rotate(-4deg);filter:drop-shadow(0 0 6px #fff) drop-shadow(0 10px 18px rgba(0,0,0,.7))}
.face{position:absolute;${facePos};width:${faceW}px;height:${faceH}px;border:8px solid #fff;border-radius:16px;overflow:hidden;box-shadow:0 14px 34px rgba(0,0,0,.75);transform:rotate(${faceLeft ? -2 : 2}deg)}
.face img{width:100%;height:100%;object-fit:cover}
.box{position:absolute;display:flex;${box}}
.text{width:100%;font-family:Impact,"Arial Black","Segoe UI Black",sans-serif;font-size:170px;line-height:.98;letter-spacing:1px;text-transform:uppercase;color:#fff;paint-order:stroke fill;text-shadow:0 10px 0 #000,0 0 34px rgba(0,0,0,.7);overflow-wrap:normal;word-break:keep-all}
.text b{font-weight:inherit;color:${esc(tint)}}
</style></head><body>
<img class="bg" src="${esc(asset && design.image?.mode === "background" ? asset : frame)}"><div class="shade"></div>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><defs><filter id="glow"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>${svg}</svg>
${imageTag}${face ? `<div class="face"><img src="${esc(face)}"></div>` : ""}
<div class="box"${hasText ? "" : ' style="display:none"'}><div class="text" id="t">${text}</div></div>${extraTags}
<script>
window.ready = (async () => {
  await Promise.all([...document.images].map((i) => i.decode().catch(() => {})));
  await document.fonts.ready;
  const t = document.getElementById("t"), b = t.parentElement;
  let size = 170;
  while (size > 44 && b.clientHeight && (t.scrollHeight > b.clientHeight || t.scrollWidth > b.clientWidth)) t.style.fontSize = (size -= 6) + "px";
  t.style.webkitTextStroke = Math.max(8, Math.round(size / 11)) + "px #000";
  await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  return size;
})();
</script></body></html>`;
}

/**
 * Draws a kept design again with the creator's changes (the editor). Every file it uses is in `folder`;
 * `extras.images[].file` are names of copies already put there.
 */
async function redraw({ folder, design, extras, out, render, colour }) {
  const face = design.faceFile && fs.existsSync(path.join(folder, design.faceFile)) ? design.faceFile : null;
  const faceSize = face ? await probeSize(path.join(folder, face)) : null;
  const asset = design.assetFile && fs.existsSync(path.join(folder, design.assetFile)) ? design.assetFile : null;
  const html = path.join(folder, `editar-${Date.now().toString(36)}.html`);
  fs.writeFileSync(html, designPage({ frame: design.frameFile, design: { ...design, text: String(design.text ?? "").trim().slice(0, 60) }, face, faceSize, asset, colour, extras }));
  try {
    fs.writeFileSync(out, await render(html));
  } finally {
    fs.rmSync(html, { force: true });
  }
  return out;
}

/**
 * Designs and renders thumbnails. Returns { made: [...], facecam } or null when it could not (the caller then makes
 * the simple ones). `options`: text ideas with their moments; `render(htmlFile)` gives the JPEG.
 */
async function artDirect(ctx, { video, dir, folder, options, count, keep, toFinal, render, stamp, assetFolders = [], note = "", attached = [] }) {
  if (!ctx.llm?.available?.()) return null;
  const source = video.source_path;
  // Candidate frames: the moments of the text ideas plus the strongest action measured on the picture.
  const times = [];
  for (const t of [...options.map((o) => o.time), ...actionMoments(dir, keep, 4)]) if (!times.some((x) => Math.abs(x - t) < 4)) times.push(t);
  const frames = [];
  for (const [i, t] of times.slice(0, 8).entries()) {
    const file = path.join(folder, `cand-${i + 1}.jpg`);
    await ff(["-y", "-ss", t.toFixed(3), "-i", source, "-frames:v", "1", "-vf", withSdr(await sdrFilter(source), "scale='min(1920,iw)':-2"), "-q:v", "2", file], { signal: ctx.signal });
    if (fs.existsSync(file)) frames.push({ path: file, label: String(frames.length + 1), time: t });
  }
  if (frames.length < 2) return null;
  ctx.progress(0.2, "Olhando os quadros");
  const candidates = await sheet(frames, path.join(folder, "candidatos.jpg"), 4, 480, 270, ctx.signal, true);
  const size = await probeSize(frames[0].path);

  // The creator's face: a webcam inside the recording (found once and kept), or a webcam clip of the editor project.
  let facecam = video.data.facecam;
  const skipFace = noFace(note);
  if (facecam === undefined && !skipFace) {
    facecam = null;
    try {
      const project = video.data.fromEditor?.copy && fs.existsSync(video.data.fromEditor.copy) ? JSON.parse(fs.readFileSync(video.data.fromEditor.copy, "utf8")) : null;
      const other = project && Object.values(project.materials ?? {}).find((m) => m?.hasVideo && m.kind !== "image" && m.path && path.resolve(m.path).toLowerCase() !== path.resolve(source).toLowerCase() && fs.existsSync(m.path));
      if (other) facecam = { file: other.path };
      else {
        const { json } = await ctx.llm.ask({ role: FACE_ROLE, model: ctx.settings.models.thumbnail, tools: ["Read"], signal: ctx.signal, prompt: `Open this image with the Read tool: ${candidates}` });
        const b = json.facecam;
        if (b && [b.x, b.y, b.w, b.h].every((v) => Number.isFinite(Number(v))) && b.w > 0.05 && b.h > 0.05 && b.w < 0.7) facecam = { box: { x: clamp(+b.x, 0, 1), y: clamp(+b.y, 0, 1), w: clamp(+b.w, 0.05, 1), h: clamp(+b.h, 0.05, 1) } };
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
    }
  }
  const faces = [];
  if (skipFace) {
    // The creator asked for no webcam: no faces are offered at all.
  } else if (facecam?.box) {
    const { x, y, w, h } = facecam.box;
    for (const [i, f] of frames.entries()) {
      const file = path.join(folder, `rosto-${i + 1}.jpg`);
      await ff(["-y", "-i", f.path, "-vf", `crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)}`, "-q:v", "2", file], { signal: ctx.signal }).catch(() => {});
      if (fs.existsSync(file)) faces.push({ path: file, label: `R${i + 1}` });
    }
  } else if (facecam?.file) {
    const cam = await probeSize(facecam.file);
    for (let i = 0; i < 8 && cam.duration; i++) {
      const file = path.join(folder, `rosto-${i + 1}.jpg`);
      await ff(["-y", "-ss", (cam.duration * (0.06 + 0.11 * i)).toFixed(2), "-i", facecam.file, "-frames:v", "1", "-vf", withSdr(await sdrFilter(facecam.file), "scale='min(960,iw)':-2"), "-q:v", "2", file], { signal: ctx.signal }).catch(() => {});
      if (fs.existsSync(file)) faces.push({ path: file, label: `R${i + 1}` });
    }
  }
  const faceSheet = faces.length ? await sheet(faces, path.join(folder, "rostos.jpg"), 4, 320, 240, ctx.signal) : null;
  // Images: the ones the creator attached, and (only when the request mentions an image) those in their folders.
  const images = [...attached];
  if (note && /imag|foto|logo|png|jpe?g|webp|arquivo|pasta/i.test(note)) for (const f of folderImages(assetFolders)) if (!images.some((x) => path.basename(x).toLowerCase() === path.basename(f).toLowerCase())) images.push(f);

  ctx.progress(0.35, "Desenhando as thumbnails");
  const { json } = await ctx.llm.ask({
    role: DESIGN_ROLE,
    model: ctx.settings.models.thumbnail,
    tools: ["Read"],
    signal: ctx.signal,
    prompt: [
      `Title: "${video.title}"`,
      ctx.settings.channel?.niche ? `Channel: ${ctx.settings.channel.niche}` : "",
      video.data.summary ? `Summary: ${video.data.summary}` : "",
      ctx.brief ? `Creator's instructions (follow what concerns the thumbnail): ${ctx.brief}` : "",
      note ? `\nTHE CREATOR'S REQUEST FOR THESE THUMBNAILS (comes first, follow it in every design): ${note}\n` : "",
      ctx.siblings?.length ? `Other videos of the same series already use: ${ctx.siblings.join(" | ")}. Look different.` : "",
      `Designs wanted: ${count}`,
      "",
      `Candidate frames (numbered 1 to ${frames.length}), open with Read: ${candidates}`,
      ...frames.map((f) => `${f.label}. at ${clock(toFinal(f.time) ?? f.time)} of the video`),
      faceSheet ? `\nFaces of the creator (R1 to R${faces.length}), open with Read: ${faceSheet}. "face" is the number after R.` : skipFace ? "\nThe creator does not want the webcam: use face null." : "\nNo webcam in this video: use face null.",
      images.length
        ? `\nImages of the creator (give "file" exactly as written; you may open them with Read). ${attached.length ? "The ones marked ATTACHED were chosen by the creator for these thumbnails: use them. " : ""}Use the others only if the request names them:\n${images.map((f) => `- ${path.basename(f)}${attached.includes(f) ? " (ATTACHED)" : ""}: ${f}`).join("\n")}`
        : "",
      "\nText ideas:",
      ...options.map((o) => `- ${o.text}${o.accent ? ` (highlight ${o.accent})` : ""}`),
    ]
      .filter(Boolean)
      .join("\n"),
  });
  const designs = (Array.isArray(json.designs) ? json.designs : []).filter((d) => d && frames[Number(d.frame) - 1] && String(d.text ?? "").trim()).slice(0, count);
  if (!designs.length) return null;
  // The face, close: head and shoulders found with the person cut-out, the webcam's own background kept around them.
  const closeFaces = new Map();
  const closeFace = async (n) => {
    const face = faces[n - 1];
    if (!face) return null;
    if (closeFaces.has(n)) return closeFaces.get(n);
    let out = face;
    try {
      const size = await probeSize(face.path);
      const cut = path.join(folder, `rosto-recorte-${n}.png`);
      await ctx.removeBackground?.(face.path, cut);
      const box = fs.existsSync(cut) ? await alphaBox(cut) : null;
      if (box && box.w > size.w * 0.08 && box.h > size.h * 0.15) {
        const w = Math.min(size.w, Math.round(box.w * 1.35));
        const h = Math.min(size.h, Math.round(Math.min(box.h, box.w * 1.15) * 1.2));
        const x = clamp(Math.round(box.x + box.w / 2 - w / 2), 0, size.w - w);
        const y = clamp(Math.round(box.y - h * 0.08), 0, size.h - h);
        const file = path.join(folder, `rosto-perto-${n}.jpg`);
        await ff(["-y", "-i", face.path, "-vf", `crop=${w}:${h}:${x}:${y}`, "-q:v", "2", file], { signal: ctx.signal });
        if (fs.existsSync(file)) out = { path: file, label: face.label };
      }
    } catch (err) {
      if (ctx.signal.aborted) throw err;
    }
    closeFaces.set(n, out);
    return out;
  };

  const draw = async (d, i) => {
    const frame = frames[Number(d.frame) - 1];
    const face = !skipFace && Number(d.face) ? await closeFace(Number(d.face)) : null;
    const faceSize = face ? await probeSize(face.path) : null;
    // The chosen image is copied next to the page; the creator's file is only read.
    let asset = null;
    const picked = d.image?.file && images.find((f) => path.basename(f).toLowerCase() === path.basename(String(d.image.file)).toLowerCase());
    if (picked) {
      asset = `imagem-${images.indexOf(picked) + 1}${path.extname(picked).toLowerCase()}`;
      if (!fs.existsSync(path.join(folder, asset))) fs.copyFileSync(picked, path.join(folder, asset));
    }
    const html = path.join(folder, `arte-${i + 1}.html`);
    fs.writeFileSync(html, designPage({ frame: path.basename(frame.path), design: { ...d, text: String(d.text).trim().slice(0, 40) }, face: face ? path.basename(face.path) : null, faceSize, asset, colour: ctx.settings.edit.textColour || "#ffd400" }));
    try {
      const file = path.join(folder, `thumb-${stamp}-${i + 1}.jpg`);
      fs.writeFileSync(file, await render(html));
      return { file, frame, face, asset };
    } finally {
      fs.rmSync(html, { force: true });
    }
  };

  let drawn = [];
  for (const [i, d] of designs.entries()) {
    ctx.progress(0.45 + (0.3 * i) / designs.length, `Thumbnail ${i + 1} de ${designs.length}`);
    try {
      drawn.push({ d, i, ...(await draw(d, i)) });
    } catch (err) {
      ctx.log("warn", `Thumbnail ${i + 1} não saiu: ${err.message}`);
    }
  }
  if (!drawn.length) return null;

  // A second look at the finished pictures: arrows and rings that missed their subject are put right.
  ctx.progress(0.8, "Conferindo as thumbnails");
  try {
    const review = await sheet(drawn.map((x, k) => ({ path: x.file, label: String(k + 1) })), path.join(folder, "revisao.jpg"), 2, 640, 360, ctx.signal);
    const { json: fix } = await ctx.llm.ask({
      role: REVIEW_ROLE,
      model: ctx.settings.models.thumbnail,
      tools: ["Read"],
      signal: ctx.signal,
      prompt: [`Open the finished thumbnails with Read: ${review}`, `And the original frames (with the quarter grid) they came from: ${candidates}`, "", ...drawn.map((x, k) => `${k + 1}. frame ${x.d.frame}: ${JSON.stringify({ zoom: x.d.zoom ?? null, arrow: x.d.arrow ?? null, ring: x.d.ring ?? null, textAt: x.d.textAt, faceAt: x.d.faceAt, subject: x.d.why ?? "" })}`)].join("\n"),
    });
    let fixed = 0;
    for (const item of Array.isArray(fix.fixes) ? fix.fixes : []) {
      const x = drawn[Number(item?.n) - 1];
      if (!x || item.ok === true) continue;
      const d = { ...x.d };
      if (item.arrow !== undefined) d.arrow = item.arrow;
      if (item.ring !== undefined) d.ring = item.ring;
      if (item.zoom !== undefined && item.zoom) d.zoom = item.zoom;
      try {
        const again = await draw(d, x.i);
        Object.assign(x, { d, ...again });
        fixed++;
      } catch (err) {
        if (ctx.signal.aborted) throw err;
      }
    }
    if (fixed) ctx.log("info", `Conferi as thumbnails prontas e acertei a seta ou o destaque de ${fixed}.`);
  } catch (err) {
    if (ctx.signal.aborted) throw err;
    ctx.log("warn", `Não consegui conferir as thumbnails (${err.message}); ficam como saíram.`);
  }

  const made = drawn.map(({ d, file, frame, face, asset }) => {
    const parts = [d.arrow ? "seta" : "", d.ring ? "destaque" : "", face ? "rosto" : "", num(d.zoom?.scale, 1) > 1.05 ? "zoom" : "", d.image?.file ? `imagem ${path.basename(String(d.image.file))}` : ""].filter(Boolean);
    // What it was drawn from, so the creator can change it later in the thumbnail editor.
    const design = { text: String(d.text).trim(), accent: d.accent ?? "", textAt: d.textAt, colour: d.colour, zoom: d.zoom ?? null, arrow: d.arrow ?? null, ring: d.ring ?? null, faceAt: d.faceAt, image: d.image ?? null, frameFile: path.basename(frame.path), faceFile: face ? path.basename(face.path) : null, assetFile: asset ?? null };
    return { path: file, text: String(d.text).trim(), layout: `arte: ${parts.join(", ") || "quadro e texto"}`, time: +frame.time.toFixed(2), person: Boolean(face), why: String(d.why ?? ""), design };
  });
  return made.length ? { made, facecam, size } : null;
}

/** "sem webcam", "não coloque a webcam", "tira meu rosto"…: the creator does not want their face on the thumbnail. */
const noFace = (note) => /(sem|n[aã]o|nada de|tir[ae]|remov[ae]|esconde)\b[^.;,]{0,30}\b(webcam|cam|c[aâ]mera|rosto|cara|face|facecam)/i.test(String(note ?? ""));

module.exports = { artDirect, noFace, redraw };
