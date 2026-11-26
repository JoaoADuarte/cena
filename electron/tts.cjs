/**
 * AI voice (Piper, a neural voice that runs on the PC, offline). The program and the Brazilian Portuguese voice are
 * downloaded once, only when the creator clicks "Baixar voz de IA", from Piper's official pages, into the user folder.
 */
const { app } = require("electron");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");

const PROGRAM_URL = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
const VOICE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/pt/pt_BR/faber/medium/pt_BR-faber-medium.onnx";
const VOICE = "pt_BR-faber-medium";

const dir = () => path.join(app.getPath("userData"), "voz-ia");
const files = () => ({
  exe: path.join(dir(), "piper", "piper.exe"),
  model: path.join(dir(), `${VOICE}.onnx`),
  config: path.join(dir(), `${VOICE}.json`),
});

function status() {
  const f = files();
  return { installed: process.platform === "win32" && Object.values(f).every((p) => fs.existsSync(p)), voice: "Faber (português do Brasil)", folder: dir() };
}

async function download(url, out, onBytes) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Não consegui baixar (${res.status}).`);
  const total = Number(res.headers.get("content-length")) || 0;
  const tmp = `${out}.baixando`;
  const file = fs.createWriteStream(tmp);
  let got = 0;
  for await (const chunk of res.body) {
    got += chunk.length;
    if (!file.write(chunk)) await new Promise((r) => file.once("drain", r));
    onBytes(got, total);
  }
  await new Promise((r, j) => file.end((e) => (e ? j(e) : r())));
  await fsp.rename(tmp, out);
}

let installing = null;
/** Downloads the program and the voice (about 85 MB). `onProgress(0..1, text)`. */
function install(onProgress = () => {}) {
  if (status().installed) return Promise.resolve(status());
  if (installing) return installing;
  installing = (async () => {
    if (process.platform !== "win32") throw new Error("A voz de IA só funciona no Windows por enquanto.");
    await fsp.mkdir(dir(), { recursive: true });
    const zip = path.join(dir(), "piper.zip");
    await download(PROGRAM_URL, zip, (got, total) => onProgress(0.25 * (total ? got / total : 0), "Baixando o programa da voz"));
    onProgress(0.26, "Abrindo o programa");
    // Windows' own tar opens .zip (another tar on the PATH, like Git's, does not); PowerShell is the fallback.
    const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    const run = (cmd, args) => new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, timeout: 120_000 }, (err) => (err ? reject(err) : resolve())));
    try {
      await run(tar, ["-xf", zip, "-C", dir()]);
    } catch {
      await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dir().replace(/'/g, "''")}' -Force`]).catch(() => {
        throw new Error("Não consegui abrir o arquivo baixado.");
      });
    }
    await fsp.rm(zip, { force: true });
    await download(VOICE_URL, files().model, (got, total) => onProgress(0.27 + 0.68 * (total ? got / total : 0), "Baixando a voz em português"));
    await download(`${VOICE_URL}.json`, `${files().config}.original`, () => {});
    // This build of Piper reads one character per sound; the voice's file lists a few two-character English sounds
    // that Portuguese never uses, and the program refuses the whole file because of them.
    const config = JSON.parse(await fsp.readFile(`${files().config}.original`, "utf8"));
    for (const key of Object.keys(config.phoneme_id_map ?? {})) if ([...key].length !== 1) delete config.phoneme_id_map[key];
    await fsp.writeFile(files().config, JSON.stringify(config));
    onProgress(1, "Pronto");
    return status();
  })().finally(() => (installing = null));
  return installing;
}

/**
 * Speaks `text` into a WAV file and returns its path. `speed` 0.6 to 1.6 (1 = normal).
 */
async function speak(text, { speed = 1, pause = 0.25 } = {}) {
  const clean = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 2000);
  if (!clean) throw new Error("Escreva o que a voz deve falar.");
  if (!status().installed) throw new Error('A voz de IA ainda não foi baixada. Clique em "Baixar voz de IA".');
  const f = files();
  const outDir = path.join(app.getPath("userData"), "recordings");
  await fsp.mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const out = path.join(outDir, `voz-ia-${stamp}-${Math.random().toString(36).slice(2, 6)}.wav`);
  const lengthScale = (1 / Math.min(1.6, Math.max(0.6, Number(speed) || 1))).toFixed(3);
  await new Promise((resolve, reject) => {
    const child = spawn(f.exe, ["-m", f.model, "-c", f.config, "-f", out, "--length_scale", lengthScale, "--sentence_silence", String(pause)], { windowsHide: true, cwd: path.dirname(f.exe) });
    let err = "";
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 && fs.existsSync(out) ? resolve() : reject(new Error(`A voz não saiu: ${err.split("\n").filter((l) => /error/i.test(l)).pop() ?? `código ${code}`}`))));
    child.stdin.end(clean, "utf8");
  });
  return out;
}

module.exports = { status, install, speak };
