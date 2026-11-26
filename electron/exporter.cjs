// Encodes renderer-composited RGBA frames plus an FFmpeg-mixed audio graph into the chosen format.
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { FFMPEG, run } = require("./media.cjs");

const sec = (micros) => (micros / 1_000_000).toFixed(6);

/** Platform loudness target (YouTube, Spotify): integrated -14 LUFS, true peak under -1 dBTP. */
const LOUDNORM = "loudnorm=I=-14:TP=-1:LRA=11,aresample=48000";

/** atempo accepts 0.5..100 per instance; chain instances for slower speeds. */
function atempoChain(speed) {
  const parts = [];
  let s = speed;
  while (s < 0.5) {
    parts.push("atempo=0.5");
    s /= 0.5;
  }
  if (Math.abs(s - 1) > 1e-6) parts.push(`atempo=${s.toFixed(6)}`);
  return parts;
}

/**
 * Volume filter for a clip: a constant, or a piecewise-linear curve through its keyframes
 * (seconds from the clip's start, which is `t` after trimming and the speed change).
 * The curve is a flat sum of segments, so hundreds of points don't nest expressions.
 */
function volumeFilter(clip) {
  const frames = clip.volumeKeyframes;
  if (!frames?.length) return `volume=${clip.volume.toFixed(3)}`;
  const f = (n) => n.toFixed(4);
  const terms = [`${f(frames[0].value)}*lt(t,${f(frames[0].time)})`];
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i];
    const b = frames[i + 1];
    if (b.time <= a.time) continue;
    const slope = (b.value - a.value) / (b.time - a.time);
    terms.push(`gte(t,${f(a.time)})*lt(t,${f(b.time)})*(${f(a.value)}+${slope.toFixed(6)}*(t-${f(a.time)}))`);
  }
  const last = frames[frames.length - 1];
  terms.push(`${f(last.value)}*gte(t,${f(last.time)})`);
  // Commas would end the filter inside a graph; the quotes keep the expression whole.
  return `volume='${terms.join("+")}':eval=frame`;
}

/**
 * Input arguments and filter graph that mix the timeline's audio clips into `[aout]`, `duration` long.
 * `firstInput` is the FFmpeg input index the first clip gets.
 */
function audioMix(audio, duration, firstInput, { normalize = false } = {}) {
  const inputs = [];
  if (audio.length === 0) {
    inputs.push("-f", "lavfi", "-t", sec(duration), "-i", "anullsrc=r=48000:cl=stereo");
    return { inputs, filters: [`[${firstInput}:a]anull[aout]`] };
  }
  const filters = [];
  const labels = [];
  audio.forEach((clip, i) => {
    inputs.push("-ss", sec(clip.sourceStart), "-t", sec(clip.sourceDuration), "-i", clip.path);
    // atempo keeps the pitch; resampling at a different rate shifts it along with the speed.
    const speedChain =
      clip.keepPitch === false && Math.abs(clip.speed - 1) > 1e-6 ? [`asetrate=${Math.round(48000 * clip.speed)}`, "aresample=48000"] : atempoChain(clip.speed);
    const chain = ["aresample=48000", "aformat=channel_layouts=stereo", ...speedChain, volumeFilter(clip)];
    if (clip.fadeIn > 0) chain.push(`afade=t=in:st=0:d=${sec(clip.fadeIn)}`);
    if (clip.fadeOut > 0) chain.push(`afade=t=out:st=${sec(Math.max(0, clip.duration - clip.fadeOut))}:d=${sec(clip.fadeOut)}`);
    const delayMs = Math.round(clip.start / 1000);
    chain.push(`adelay=${delayMs}:all=1`);
    filters.push(`[${firstInput + i}:a]${chain.join(",")}[a${i}]`);
    labels.push(`[a${i}]`);
  });
  // The limiter only acts when tracks pile up past full scale, which would otherwise clip in the file.
  const master = [`amix=inputs=${labels.length}:normalize=0:duration=longest`, ...(normalize ? [LOUDNORM] : []), "alimiter=limit=0.89:level=false", "apad", `atrim=0:${sec(duration)}`];
  filters.push(`${labels.join("")}${master.join(",")}[aout]`);
  return { inputs, filters };
}

/**
 * The graph goes in a file: volume curves can make it longer than Windows allows on a command line.
 * Returns the arguments and a cleanup function.
 */
function graphArgs(filters) {
  const file = path.join(os.tmpdir(), `cena-graph-${crypto.randomUUID()}.txt`);
  fs.writeFileSync(file, filters.join(";\n"));
  return { args: ["-filter_complex_script", file], cleanup: () => fs.rm(file, { force: true }, () => {}) };
}

/** [high, recommended, small] */
const LEVEL = { high: 0, recommended: 1, small: 2 };

const AAC = ["-c:a", "aac", "-b:a", "192k"];
const FASTSTART = ["-movflags", "+faststart"];

/** Graphics-card encoders, in the order they are tried. Numbers are [high, recommended, small]; each codec has its own scale. */
const GPU_VENDORS = [
  {
    label: "NVIDIA NVENC",
    suffix: "nvenc",
    pixFmt: "yuv420p",
    levels: { h264: [19, 24, 30], hevc: [22, 27, 33], av1: [26, 32, 40] },
    args: (n) => ["-preset", "p5", "-tune", "hq", "-rc", "vbr", "-cq", String(n), "-b:v", "0"],
  },
  {
    label: "AMD AMF",
    suffix: "amf",
    pixFmt: "nv12",
    levels: { h264: [19, 24, 30], hevc: [22, 27, 33], av1: [100, 128, 160] },
    args: (n) => ["-quality", "quality", "-rc", "cqp", "-qp_i", String(n), "-qp_p", String(n)],
  },
  {
    label: "Intel Quick Sync",
    suffix: "qsv",
    pixFmt: "nv12",
    levels: { h264: [20, 25, 31], hevc: [22, 27, 33], av1: [26, 32, 40] },
    args: (n) => ["-preset", "medium", "-global_quality", String(n)],
  },
];

const hvcTag = (codec) => (codec === "hevc" ? ["-tag:v", "hvc1"] : []);

function gpuVideo(codec, vendor, quality) {
  return { pixFmt: vendor.pixFmt, args: ["-c:v", `${codec}_${vendor.suffix}`, ...vendor.args(vendor.levels[codec][LEVEL[quality]]), ...hvcTag(codec), "-pix_fmt", vendor.pixFmt] };
}

const crfOf = (list, quality) => String(list[LEVEL[quality]]);

/** How each format is encoded. `video` answers with the pixel format and the encoder's arguments. */
const FORMATS = {
  h264: { audio: () => AAC, extra: FASTSTART, video: (q) => ({ pixFmt: "yuv420p", args: ["-c:v", "libx264", "-preset", "medium", "-crf", crfOf([18, 22, 28], q), "-pix_fmt", "yuv420p"] }) },
  hevc: {
    audio: () => AAC,
    extra: FASTSTART,
    video: (q) => ({ pixFmt: "yuv420p", args: ["-c:v", "libx265", "-preset", "medium", "-crf", crfOf([22, 26, 32], q), "-x265-params", "log-level=error", "-tag:v", "hvc1", "-pix_fmt", "yuv420p"] }),
  },
  av1: { audio: () => AAC, extra: FASTSTART, video: (q) => ({ pixFmt: "yuv420p", args: ["-c:v", "libaom-av1", "-crf", crfOf([26, 32, 40], q), "-b:v", "0", "-cpu-used", "6", "-row-mt", "1", "-pix_fmt", "yuv420p"] }) },
  vp9: {
    audio: () => ["-c:a", "libopus", "-b:a", "160k"],
    extra: [],
    video: (q) => ({ pixFmt: "yuv420p", args: ["-c:v", "libvpx-vp9", "-crf", crfOf([24, 32, 40], q), "-b:v", "0", "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-pix_fmt", "yuv420p"] }),
  },
  prores: { audio: () => ["-c:a", "pcm_s16le"], extra: [], video: (q) => ({ pixFmt: "yuv422p10le", args: ["-c:v", "prores_ks", "-profile:v", crfOf([3, 2, 0], q), "-vendor", "apl0", "-pix_fmt", "yuv422p10le"] }) },
  gif: { gif: { fps: [20, 15, 10], size: [720, 480, 360] } },
  mp3: { audioOnly: (q) => ["-c:a", "libmp3lame", "-b:a", ["320k", "192k", "128k"][LEVEL[q]]] },
  wav: { audioOnly: () => ["-c:a", "pcm_s16le"] },
};

const quiet = ["-hide_banner", "-y", "-loglevel", "error"];

/** Frames leave the canvas as sRGB; written as BT.709 and labeled so, players show the colors of the preview. */
const TO_VIDEO_COLORS = "scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd";
const COLOR_TAGS = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

function buildArgs(job, gpu = null) {
  const { width, height, fps, duration, outPath, audio } = job;
  const quality = job.quality ?? "recommended";
  const format = FORMATS[job.format ?? "h264"];
  if (!format || LEVEL[quality] === undefined) throw new Error(`Formato de exportação desconhecido: ${job.format}/${quality}`);

  if (format.audioOnly) {
    const mix = audioMix(audio, duration, 0, { normalize: job.normalize });
    const graph = graphArgs(mix.filters);
    return { args: [...quiet, "-nostdin", ...mix.inputs, ...graph.args, "-map", "[aout]", ...format.audioOnly(quality), "-t", sec(duration), outPath], cleanup: graph.cleanup };
  }

  const rawInput = ["-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0"];
  if (format.gif) {
    const rate = Math.min(fps, format.gif.fps[LEVEL[quality]]);
    const size = format.gif.size[LEVEL[quality]];
    // One palette for the whole clip keeps colors steady; never scaled up.
    const graph = graphArgs([
      `[0:v]fps=${rate},scale=w='min(iw,${size})':h='min(ih,${size})':force_original_aspect_ratio=decrease:flags=lanczos,split[a][b]`,
      "[a]palettegen=stats_mode=diff[p]",
      "[b][p]paletteuse=dither=bayer:bayer_scale=4[vout]",
    ]);
    return { args: [...quiet, ...rawInput, ...graph.args, "-map", "[vout]", "-an", "-loop", "0", "-t", sec(duration), outPath], cleanup: graph.cleanup };
  }

  const video = gpu ? gpuVideo(job.format ?? "h264", gpu, quality) : format.video(quality);
  const mix = audioMix(audio, duration, 1, { normalize: job.normalize });
  const graph = graphArgs([`[0:v]${TO_VIDEO_COLORS},format=${video.pixFmt}[vout]`, ...mix.filters]);
  const args = [
    ...quiet,
    ...rawInput,
    ...mix.inputs,
    ...graph.args,
    "-map", "[vout]", "-map", "[aout]",
    ...video.args,
    ...COLOR_TAGS,
    ...format.audio(quality),
    "-t", sec(duration),
    ...format.extra,
    outPath,
  ];
  return { args, cleanup: graph.cleanup };
}

// --- Export in pieces (see hybrid.cjs) ---

const HYBRID_FORMATS = { h264: "h264", hevc: "hevc" };

function pieceEncoder(job, gpu) {
  const quality = job.quality ?? "recommended";
  const video = gpu ? gpuVideo(job.format, gpu, quality) : FORMATS[job.format].video(quality);
  // No B-frames: a raw stream's frames are then in display order and joining pieces keeps exact timing.
  return { pixFmt: video.pixFmt, args: [...video.args, "-bf", "0", "-g", String(Math.round(job.fps * 5)), ...COLOR_TAGS, "-f", HYBRID_FORMATS[job.format]] };
}

/** A piece encoded from the compositor's frames, on stdin. */
function renderPieceArgs(job, gpu, file) {
  const encoder = pieceEncoder(job, gpu);
  return {
    args: [...quiet, "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${job.width}x${job.height}`, "-r", String(job.fps), "-i", "pipe:0", "-vf", `${TO_VIDEO_COLORS},format=${encoder.pixFmt}`, ...encoder.args, file],
    cleanup() {},
  };
}

/**
 * Brightness, contrast and saturation as the compositor's CSS filters apply them, written for a BT.709 video
 * in limited range. Each of the three is a straight line on R, G and B, which on luma and chroma is a straight
 * line too: no conversion to RGB and back, one table per plane.
 */
function gradeFilter(grade) {
  const gain = grade.brightness * grade.contrast;
  const lift = 109.5 * (1 - grade.contrast);
  const chroma = gain * grade.saturation;
  const n = (v) => v.toFixed(5);
  return `lutyuv=y='clip(16+${n(gain)}*(val-16)+${n(lift)},16,235)':u='clip(128+${n(chroma)}*(val-128),16,240)':v='clip(128+${n(chroma)}*(val-128),16,240)'`;
}

/** The source's picture for a direct piece: the project's size, colours and frame rate. */
function directFilters(job, piece, info, pixFmt) {
  const { width: W, height: H, fps } = job;
  // The same frame the compositor would show: the last one that started by each output time (its reader allows
  // 0.1 ms of slack). Rounding to the nearest instead puts a clip cut between two frames one frame ahead.
  const filters = [`fps=${fps}:start_time=${(piece.start + 0.0001).toFixed(6)}:round=up`];
  // HDR tone-mapped and pixels made square first (frameReader's describe).
  if (info.prefilter) filters.push(info.prefilter);
  const untouched = !info.prefilter && info.width === W && info.height === H && info.matrix === "bt709" && !info.fullRange && info.pixFmt === "yuv420p" && !piece.padColor;
  if (!untouched) filters.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease:in_color_matrix=${info.matrix}${info.fullRange ? ":in_range=pc" : ""}:out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd`);
  // The clip is graded, the bars around it are not.
  if (piece.grade) filters.push("format=yuv420p", gradeFilter(piece.grade));
  if (!untouched) filters.push(`pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${piece.padColor ?? "black"}`);
  // A source a little shorter than the clip repeats its last picture, so the frame count always holds.
  filters.push(`format=${pixFmt}`, "tpad=stop_mode=clone:stop=-1");
  return filters;
}

/** The webcam box of a direct piece: its own frames at the same times, cropped, sized, in BT.709. */
function pipFilter(job, pip, info, input) {
  const n = (v) => Number(v).toFixed(6);
  const cw = 1 - pip.crop.left - pip.crop.right;
  const ch = 1 - pip.crop.top - pip.crop.bottom;
  const crop = `crop=w='trunc(iw*${n(cw)}/2)*2':h='trunc(ih*${n(ch)}/2)*2':x='trunc(iw*${n(pip.crop.left)})':y='trunc(ih*${n(pip.crop.top)})'`;
  return [
    `[${input}:v]fps=${job.fps}:start_time=${(pip.start + 0.0001).toFixed(6)}:round=up`,
    ...(info.prefilter ? [info.prefilter] : []),
    crop,
    `scale=${pip.width}:${pip.height}:in_color_matrix=${info.matrix}${info.fullRange ? ":in_range=pc" : ""}:out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd`,
    "format=yuv420p",
    "tpad=stop_mode=clone:stop=-1",
    "setpts=PTS-STARTPTS[pip]",
  ].join(",");
}

const pipInput = (pip) => {
  const from = Math.max(0, pip.start - 1);
  return [...(from > 0 ? ["-ss", from.toFixed(6)] : []), "-copyts", "-i", pip.path];
};

/**
 * A direct piece with texts on top. FFmpeg decodes the footage; stdin brings, for each frame, only the
 * rectangle (`box`) where the compositor drew texts, shapes or stickers, with transparency.
 */
function overlayPieceArgs(job, gpu, piece, info, box, file, pipInfo = null) {
  const encoder = pieceEncoder(job, gpu);
  const from = Math.max(0, piece.start - 1);
  const pip = piece.pip && pipInfo ? piece.pip : null;
  const texts = pip ? 2 : 1;
  const graph = graphArgs([
    `[0:v]${directFilters(job, piece, info, "yuv420p").join(",")},setpts=PTS-STARTPTS[${pip ? "under" : "base"}]`,
    ...(pip ? [pipFilter(job, pip, pipInfo, 1), `[under][pip]overlay=x=${pip.x}:y=${pip.y}:format=yuv420:eof_action=repeat[base]`] : []),
    `[${texts}:v]scale=out_color_matrix=bt709:out_range=tv:flags=bicubic+accurate_rnd,format=yuva420p[top]`,
    `[base][top]overlay=x=${box.x}:y=${box.y}:format=yuv420:eof_action=repeat,format=${encoder.pixFmt}[vout]`,
  ]);
  return {
    args: [
      ...quiet,
      ...(from > 0 ? ["-ss", from.toFixed(6)] : []),
      "-copyts", "-i", piece.path,
      ...(pip ? pipInput(pip) : []),
      "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${box.width}x${box.height}`, "-r", String(job.fps), "-i", "pipe:0",
      ...graph.args,
      "-map", "[vout]", "-an", "-sn", "-dn",
      "-fps_mode", "passthrough",
      "-frames:v", String(piece.frames),
      ...encoder.args,
      file,
    ],
    cleanup: graph.cleanup,
  };
}

/** A piece encoded straight from the source file. Progress goes to stdout. */
function directPieceArgs(job, gpu, piece, info, file, pipInfo = null) {
  const encoder = pieceEncoder(job, gpu);
  const from = Math.max(0, piece.start - 1);
  if (piece.pip && pipInfo) {
    const pip = piece.pip;
    const graph = [
      `[0:v]${directFilters(job, piece, info, "yuv420p").join(",")},setpts=PTS-STARTPTS[base]`,
      pipFilter(job, pip, pipInfo, 1),
      `[base][pip]overlay=x=${pip.x}:y=${pip.y}:format=yuv420:eof_action=repeat,format=${encoder.pixFmt}[vout]`,
    ].join(";");
    return [
      "-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
      ...(from > 0 ? ["-ss", from.toFixed(6)] : []),
      "-copyts", "-i", piece.path,
      ...pipInput(pip),
      "-filter_complex", graph,
      "-map", "[vout]", "-an", "-sn", "-dn",
      "-fps_mode", "passthrough",
      "-frames:v", String(piece.frames),
      ...encoder.args,
      file,
    ];
  }
  const filters = directFilters(job, piece, info, encoder.pixFmt);
  return [
    "-hide_banner", "-y", "-nostdin", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
    ...(from > 0 ? ["-ss", from.toFixed(6)] : []),
    "-copyts", "-i", piece.path,
    "-map", "0:v:0", "-an", "-sn", "-dn",
    "-vf", filters.join(","),
    "-fps_mode", "passthrough",
    "-frames:v", String(piece.frames),
    ...encoder.args,
    file,
  ];
}

/** The joined pieces, on stdin, plus the timeline's sound. */
function muxArgs(job) {
  const format = FORMATS[job.format];
  const mix = audioMix(job.audio, job.duration, 1, { normalize: job.normalize });
  const graph = graphArgs(mix.filters);
  return {
    args: [
      ...quiet,
      "-framerate", String(job.fps), "-f", HYBRID_FORMATS[job.format], "-i", "pipe:0",
      ...mix.inputs,
      ...graph.args,
      "-map", "0:v", "-map", "[aout]",
      "-c:v", "copy", ...hvcTag(job.format),
      ...format.audio(job.quality ?? "recommended"),
      "-t", sec(job.duration),
      ...format.extra,
      job.outPath,
    ],
    cleanup: graph.cleanup,
  };
}

/** A vendor is listed by FFmpeg even without its hardware, so each one has to really encode a few frames. */
async function vendorWorks(codec, vendor) {
  try {
    await Promise.race([
      run(FFMPEG, [...quiet, "-nostdin", "-f", "lavfi", "-i", "color=c=gray:s=640x360:r=30:d=0.2", ...gpuVideo(codec, vendor, "recommended").args, "-f", "null", "-"]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 15000)),
    ]);
    return true;
  } catch {
    return false;
  }
}

let gpuCheck = null;

/** The working graphics-card encoder for each codec (measured once per launch). */
function gpuEncoders() {
  gpuCheck ??= (async () => {
    const found = {};
    await Promise.all(
      ["h264", "hevc", "av1"].map(async (codec) => {
        found[codec] = null;
        for (const vendor of GPU_VENDORS) {
          if (await vendorWorks(codec, vendor)) {
            found[codec] = vendor;
            return;
          }
        }
      }),
    );
    return found;
  })();
  return gpuCheck;
}

async function gpuLabels() {
  const found = await gpuEncoders();
  return Object.fromEntries(Object.entries(found).map(([codec, vendor]) => [codec, vendor?.label ?? null]));
}

class ExportSession {
  /** `gpu`: a vendor from gpuEncoders(), or null for the CPU encoder. */
  constructor(job, gpu = null, built = null) {
    this.job = job;
    this.stderr = "";
    const { args, cleanup } = built ?? buildArgs(job, gpu);
    this.child = spawn(FFMPEG, args, { windowsHide: true });
    this.child.stderr.on("data", (c) => (this.stderr = (this.stderr + c).slice(-8000)));
    this.child.stdin.on("error", () => {}); // surfaced through the exit code instead
    this.exited = false;
    this.done = new Promise((resolve) => {
      this.child.on("close", (code) => {
        this.exited = true;
        cleanup();
        resolve(code);
      });
      this.child.on("error", (err) => {
        this.exited = true;
        this.stderr += String(err);
        cleanup();
        resolve(-1);
      });
    });
  }

  async writeFrame(bytes) {
    // An encoder that already left would never ask for more: say so instead of waiting for ever.
    if (this.exited) throw new Error(`ffmpeg parou antes do fim: ${this.stderr.trim()}`);
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!this.child.stdin.write(buf)) {
      await Promise.race([new Promise((resolve) => this.child.stdin.once("drain", resolve)), this.done]);
    }
  }

  async finish() {
    this.child.stdin.end();
    const code = await this.done;
    if (code !== 0) throw new Error(`ffmpeg saiu com código ${code}: ${this.stderr.trim()}`);
    return this.job.outPath;
  }

  cancel() {
    this.child.stdin.destroy();
    this.child.kill();
  }
}

module.exports = { ExportSession, buildArgs, audioMix, graphArgs, sec, gpuEncoders, gpuLabels, renderPieceArgs, directPieceArgs, overlayPieceArgs, muxArgs };
