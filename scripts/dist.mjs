// Builds the Windows packages. The portable build unpacks into a folder named after this build: a fixed name
// made a new Cena.exe run the files an older one had left there.
import { spawnSync } from "node:child_process";

const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
const run = (args) => {
  const out = spawnSync("npx", args, { stdio: "inherit", shell: true });
  if (out.status !== 0) process.exit(out.status ?? 1);
};
run(["electron-builder", "--win", "--x64", `-c.portable.unpackDirName=Cena-Portatil-${stamp}`]);
console.log(`Pasta do portátil: Cena-Portatil-${stamp}`);
