// Runs the app headlessly in --smoke mode and checks the exported video.
//   node scripts/smoke.mjs            build the renderer, run with the dev Electron
//   node scripts/smoke.mjs --packaged run release/win-unpacked/Cena.exe as built by electron-builder
//   node scripts/smoke.mjs --portable run the single-file release/Cena-Portatil-<version>.exe
import { spawnSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const packaged = process.argv.includes("--packaged");
const portable = process.argv.includes("--portable");
const label = portable ? " (portable)" : packaged ? " (packaged)" : "";
// The portable launcher swallows stdout, so the app also writes its result here.
const resultFile = join(tmpdir(), `cena-smoke-result-${process.pid}.txt`);
let command;
let args;
if (packaged || portable) {
  command = portable ? `release/Cena-Portatil-${require("../package.json").version}.exe` : "release/win-unpacked/Cena.exe";
  args = ["--smoke"];
  if (!existsSync(command)) {
    console.error(`${command} not found; run npm run dist first`);
    process.exit(1);
  }
} else {
  command = require("electron");
  args = [".", "--smoke"];
  const build = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--logLevel", "warn"], { stdio: "inherit" });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CENA_SMOKE_OUT: resultFile } });
let output = "";
for (const stream of [child.stdout, child.stderr]) {
  stream.on("data", (chunk) => {
    output += chunk;
    process.stdout.write(chunk);
  });
}
child.on("exit", (code) => {
  if (existsSync(resultFile)) {
    output += `\n${readFileSync(resultFile, "utf8")}`;
    rmSync(resultFile);
  }
  const line = output.split(/\r?\n/).find((l) => l.startsWith("SMOKE_RESULT "));
  if (!line) {
    console.error(`no SMOKE_RESULT (exit ${code})`);
    process.exit(1);
  }
  const result = JSON.parse(line.slice("SMOKE_RESULT ".length));
  const v = result.verified;
  const expected = result.checks?.export?.expectedSeconds;
  const durationOk = v && expected && Math.abs(v.duration / 1e6 - expected) < 0.15;
  if (result.ok && v?.hasVideo && v?.hasAudio && durationOk) {
    console.log(`\nSMOKE OK${label}: ${result.output} (${(v.duration / 1e6).toFixed(2)} s, ${v.width}x${v.height}, ${result.frames} frames)`);
    process.exit(0);
  }
  console.error(`\nSMOKE FAILED: ${result.error ?? JSON.stringify(v)}`);
  process.exit(1);
});
