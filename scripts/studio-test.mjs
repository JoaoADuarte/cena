// Drives the real app: opens the studio, feeds it a video and/or a script request, and reports what happens.
// usage: node studio-test.mjs <video|-> [--script] [--keep] [--correct "text"] [--youtube]
// --youtube uses a local stand-in for Google's servers (youtube-mock.mjs): nothing reaches a real channel.
// With --youtube --keep and no video, the newest finished video already in the test profile is used.
import { spawn, spawnSync, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startMock } from "./youtube-mock.mjs";

// Test data (separate app profile, screenshots) lives outside the user's real profile. Override with STUDIO_TEST_DIR.
const scratch = process.env.STUDIO_TEST_DIR ?? "D:/CloneCapCut/.teste-estudio";
const userData = path.join(scratch, "userdata");
fs.mkdirSync(userData, { recursive: true });
fs.writeFileSync(path.join(userData, "agent.json"), JSON.stringify({ enabled: false, port: 47911, token: "token-de-teste-local" }));
const electron = "D:/CloneCapCut/editor/node_modules/electron/dist/electron.exe";
const args = process.argv.slice(2);
const video = args[0] && args[0] !== "-" ? args[0] : null;
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const mock = flag("--youtube") ? await startMock() : null;
if (mock) Object.assign(process.env, mock.env);
const PORT = 9400 + Math.floor(Math.random() * 90);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// STUDIO_TEST_EXE=release/win-unpacked/Cena.exe tests the packaged app instead of the source tree.
const exe = process.env.STUDIO_TEST_EXE;
const child = spawn(exe ?? electron, [...(exe ? [] : ["D:/CloneCapCut/editor"]), `--user-data-dir=${userData}`, `--remote-debugging-port=${PORT}`, "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding", "--disable-features=CalculateNativeWinOcclusion"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let appLog = "";
child.stdout.on("data", (c) => (appLog += c));
child.stderr.on("data", (c) => (appLog += c));
const kill = () => { try { execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} };

async function page(match) {
  for (let i = 0; i < 80; i++) {
    try {
      const target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === "page" && match(t.url));
      if (target) {
        const ws = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((res, rej) => ((ws.onopen = res), (ws.onerror = rej)));
        let id = 0;
        const waiting = new Map();
        ws.onmessage = (m) => { const d = JSON.parse(m.data); waiting.get(d.id)?.(d); };
        const send = (method, params) => { const n = ++id; ws.send(JSON.stringify({ id: n, method, params })); return new Promise((r) => waiting.set(n, r)); };
        const ev = async (expression) => {
          const d = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
          if (d.result?.exceptionDetails) throw new Error(JSON.stringify(d.result.exceptionDetails).slice(0, 600));
          return d.result.result.value;
        };
        const shot = async (name) => fs.writeFileSync(path.join(scratch, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).result.data, "base64"));
        return { send, ev, shot };
      }
    } catch {}
    await sleep(500);
  }
  throw new Error("page not found");
}

let failed = false;
try {
  const editor = await page((u) => !u.includes("#"));
  for (let i = 0; i < 60 && !(await editor.ev("!!document.querySelector('.home')").catch(() => false)); i++) await sleep(250);
  console.log("studio available:", await editor.ev("window.api.studioAvailable()"));
  await editor.ev("window.api.openStudio()");
  const studio = await page((u) => u.includes("#estudio"));
  for (let i = 0; i < 60 && !(await studio.ev("!!document.querySelector('.studio')").catch(() => false)); i++) await sleep(250);
  const call = (method, ...a) => studio.ev(`window.api.studioCall(${JSON.stringify(method)}, ...${JSON.stringify(a)}).then(r => JSON.stringify(r ?? null))`).then(JSON.parse);
  const state = () => call("state");
  if (!flag("--keep")) {
    for (const v of (await state()).videos.sort((a, b) => Number(Boolean(b.data.partOf)) - Number(Boolean(a.data.partOf)))) await call("removeVideo", v.id);
    for (const s of (await state()).scripts) await call("removeScript", s.id);
  }
  const first = await state();
  console.log("claude:", first.claude, "deepFilter:", first.deepFilter, "agents:", first.agents.map((a) => `${a.label}=${a.status}`).join(" "));

  let seen = 0;
  const printLogs = async () => {
    const logs = await call("logs", { limit: 400 });
    for (const l of logs.filter((x) => x.id > seen)) console.log(`  [${l.agent}/${l.level}] ${l.message}`);
    seen = Math.max(seen, ...logs.map((l) => l.id));
  };
  seen = Math.max(0, ...(await call("logs", { limit: 400 })).map((l) => l.id));

  const refusal = (method, ...a) => studio.ev(`window.api.studioCall(${JSON.stringify(method)}, ...${JSON.stringify(a)}).then(() => "ACEITOU?!", (e) => "recusou: " + e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""))`);
  const tab = async (name, shot) => {
    await studio.ev(`[...document.querySelectorAll('.studio-top nav button')].find(b => b.innerText.includes(${JSON.stringify(name)})).click()`);
    await sleep(1200);
    if (shot) await studio.shot(shot);
  };
  if (mock) {
    console.log("--- YouTube (servidor de teste) ---");
    if ((await state()).youtube.connected) await call("disconnectYouTube");
    console.log("publish without a channel:", await refusal("publish", 1));
    await call("setYouTubeKeys", { apiKey: "chave-de-teste", clientId: "123456-abcdef.apps.googleusercontent.com", clientSecret: "GOCSPX-segredo-de-teste" });
    const channel = await call("connectYouTube");
    const yt = (await state()).youtube;
    console.log("connected:", yt.connected, "| channel:", channel.title, "| scope:", mock.seen.scope, "| pkce:", mock.seen.pkce, "| keys visible in state:", /teste/.test(JSON.stringify(yt)) ? "YES (BAD)" : "no");
  }

  if (flag("--script")) {
    const id = await call("createScript", { topic: value("--topic") ?? "5 erros que todo iniciante comete em jogos de sobrevivência", tone: "70% engraçado, 30% educativo", durationTarget: 120, format: "long" });
    const t0 = Date.now();
    let s;
    for (;;) {
      await sleep(4000);
      s = (await state()).scripts.find((x) => x.id === id);
      await printLogs();
      if (["review", "error", "approved"].includes(s.status)) break;
      if (Date.now() - t0 > 12 * 60_000) throw new Error("script timeout");
    }
    console.log("script status:", s.status, s.error ?? "", "in", Math.round((Date.now() - t0) / 1000), "s");
    if (s.content) {
      console.log("hooks:", s.content.hooks.length, "| est:", s.content.estimated_seconds, "s | body chars:", s.content.body.length, "| retention:", s.content.retention.length);
      console.log("hook 1:", s.content.hooks[0].slice(0, 200));
      console.log("body start:", s.content.body.slice(0, 500).replace(/\n/g, " ⏎ "));
      console.log("research refs:", s.research?.references?.length ?? 0, "confidence:", s.research?.confidence, "| source:", s.research?.source, "| verified:", (s.research?.references ?? []).filter((r) => r.verified).length);
      if (mock) console.log("searches on the API:", mock.seen.searches, "| key sent:", mock.seen.searchKey === "chave-de-teste", "| first ref:", JSON.stringify((s.research?.references ?? [])[0] ?? null).slice(0, 300));
      const tp = await call("teleprompter", id);
      console.log("teleprompter has marks:", /\[[A-ZÊ-]/.test(tp.text), "| start:", tp.text.slice(0, 160).replace(/\n/g, " ⏎ "));
      await studio.ev("[...document.querySelectorAll('.studio-top nav button')].find(b => b.innerText.includes('Roteiros')).click()");
      await sleep(400);
      await studio.ev("document.querySelector('.script-list li')?.click()");
      await sleep(600);
      await studio.shot("studio-script.png");
      await studio.ev("[...document.querySelectorAll('.script-editor header button')].find(b => b.innerText.includes('Teleprompter'))?.click()");
      await sleep(600);
      await studio.shot("studio-teleprompter.png");
      await studio.ev("document.querySelector('.tp-bar .primary')?.click()");
      await sleep(2500);
      console.log("teleprompter scrolled px in 2.5 s:", await studio.ev("Math.round(document.querySelector('.tp-scroll')?.scrollTop ?? -1)"));
      await studio.ev("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
      if (flag("--adjust")) {
        await call("adjustScript", id, "deixa o final mais emocionante e corta uns 20 segundos");
        for (let i = 0; i < 90; i++) {
          await sleep(4000);
          s = (await state()).scripts.find((x) => x.id === id);
          if (s.status === "review" && !s.pending_instruction && s.version > 1) break;
        }
        await printLogs();
        console.log("after adjust: version", s.version, "est", s.content.estimated_seconds, "s");
      }
      await call("approveScript", id);
      console.log("approved:", (await state()).scripts.find((x) => x.id === id).status);
    }
  }

  if ((video && !flag("--parts") && !flag("--order") && !flag("--series")) || (mock && flag("--keep") && !flag("--shorts"))) {
    const t0 = Date.now();
    const [id] = video ? await call("addVideos", [video]) : [(await state()).videos.filter((x) => x.data.finalPath && !x.data.youtube && ["review", "approved"].includes(x.status)).pop()?.id];
    if (!id) throw new Error("video not added (already there?)");
    let v;
    let lastStage = "";
    for (;;) {
      await sleep(3000);
      v = (await state()).videos.find((x) => x.id === id);
      const running = v.stages.find((s) => s.status === "running");
      const label = running ? `${running.name} ${Math.round(running.progress * 100)}% ${running.message ?? ""}` : v.status;
      if (running?.name !== lastStage) {
        lastStage = running?.name ?? "";
        console.log(`t+${Math.round((Date.now() - t0) / 1000)}s`, label);
      }
      await printLogs();
      if (["review", "error"].includes(v.status)) break;
      if (Date.now() - t0 > 40 * 60_000) throw new Error("video timeout");
    }
    console.log("video status:", v.status, v.error ?? "", "total", Math.round((Date.now() - t0) / 1000), "s");
    console.log("stages:", v.stages.map((s) => `${s.name}=${s.status}`).join(" "));
    if (v.status === "review") {
      const cuts = v.data.cuts;
      console.log("duration", v.data.duration, "→ final", v.data.finalDuration, "| cuts on", cuts.filter((c) => c.enabled).length, "off", cuts.filter((c) => !c.enabled).length, "| shorts", v.data.shorts.length);
      console.log("expected final:", (v.data.duration - cuts.filter((c) => c.enabled).reduce((s, c) => s + c.end - c.start, 0)).toFixed(2));
      console.log("sample cuts:", cuts.slice(0, 8).map((c) => `${c.start.toFixed(1)}-${c.end.toFixed(1)} ${c.kind}${c.enabled ? "" : "(off)"}`).join(" | "));
      console.log("summary:", v.data.summary);
      console.log("files:", fs.existsSync(v.data.finalPath), fs.existsSync(v.data.projectPath), (fs.statSync(v.data.finalPath).size / 1048576).toFixed(1), "MB");
      await studio.ev("[...document.querySelectorAll('.studio-top nav button')].find(b => b.innerText.includes('Painel')).click()");
      await sleep(500);
      await studio.shot("studio-dashboard.png");
      await studio.ev("[...document.querySelectorAll('.studio-top nav button')].find(b => b.innerText.includes('Aguardando')).click()");
      await sleep(1500);
      await studio.shot("studio-review.png");
      console.log("player:", await studio.ev("(() => { const el = document.querySelector('.players video'); return el ? { ready: el.readyState, d: +el.duration.toFixed(2), err: el.error?.message ?? null } : null })()"));

      const m = v.data.metadata;
      console.log("metadata:", m ? `"${m.title}" | ${m.titles.length} titles | ${m.tags.length} tags | ${m.hashtags.join(" ")} | chapters ${m.chapters.length} → ${m.chapterLines.length} lines | category ${m.category}` : "MISSING");
      if (m) console.log("description:\n" + m.description.split("\n").map((l) => "    " + l).join("\n"));
      console.log("thumbnails:", (v.data.thumbnails ?? []).map((t) => `${t.layout}/${t.person ? "pessoa" : "quadro"} "${t.text}"`).join(" | "));
      console.log("music:", JSON.stringify(v.data.editDone?.music ?? null), "| credits:", (v.data.credits ?? []).length);

      if (value("--correct")) {
        const out = await call("correct", id, value("--correct"));
        console.log("correction:", JSON.stringify(out));
        for (let i = 0; i < 200; i++) {
          await sleep(3000);
          v = (await state()).videos.find((x) => x.id === id);
          if (["review", "error"].includes(v.status) && !v.stages.some((s) => s.status === "running" || s.status === "pending")) break;
        }
        await printLogs();
        console.log("after correction:", v.status, "final", v.data.finalDuration, "cuts on", v.data.cuts.filter((c) => c.enabled).length);
      }
      if (mock) {
        const get = async () => (await state()).videos.find((x) => x.id === id);
        const waitPublish = async () => {
          for (let i = 0; i < 120; i++) {
            await sleep(1000);
            const now = await get();
            if (now.data.youtube || ["error", "stopped", "waiting"].includes(now.data.publish?.status)) return now;
          }
          throw new Error("upload timeout");
        };
        if (v.status === "approved") await call("setMetadata", id, { title: v.data.metadata.title + " " });
        console.log("1. publish before approval:", await refusal("publish", id));
        const at = Date.now() + 2 * 24 * 3600_000;
        console.log("   suggestion:", JSON.stringify(await call("suggestSchedule", id)).slice(0, 400));
        await call("setSchedule", id, { at });
        await call("approve", id);
        console.log("2. approved:", (await get()).status);
        await call("setMetadata", id, { title: "Título mudado depois de aprovar" });
        v = await get();
        console.log("3. after changing the title: status", v.status, "| approval", v.approval, "|", await refusal("publish", id));
        await call("approve", id);
        await call("setSchedule", id, { at: at + 3600_000 });
        v = await get();
        console.log("4. after changing the date: status", v.status, "|", await refusal("publish", id));
        await call("approve", id);
        // The file itself: one byte more than what was approved must be refused, at the click and at the upload.
        const file = (await get()).data.finalPath;
        const original = fs.readFileSync(file);
        fs.appendFileSync(file, "x");
        console.log("5. file changed after approval:", await refusal("publish", id));
        fs.writeFileSync(file, original);
        console.log("   uploads that reached the server so far:", mock.seen.uploads.length, "(must be 0)");
        await call("publish", id);
        await sleep(700);
        await tab("Aguardando", "studio-publish-sending.png");
        v = await waitPublish();
        await printLogs();
        const up = mock.seen.uploads[0];
        console.log("6. sent:", JSON.stringify(v.data.youtube), "| publish:", v.data.publish?.status, v.data.publish?.error ?? "");
        console.log("   server got:", up?.received, "of", original.length, "bytes | complete:", up?.received === original.length, "| dropped pieces recovered:", mock.seen.dropped, "| sessions:", mock.seen.uploads.length);
        console.log("   title ok:", up?.meta.snippet.title === v.data.metadata.title, "| description ok:", up?.meta.snippet.description === v.data.metadata.description, "| tags:", up?.meta.snippet.tags.length, "| status:", JSON.stringify(up?.meta.status));
        console.log("   publishAt ok:", up?.meta.status.publishAt === new Date(at + 3600_000).toISOString(), "| thumbnail:", JSON.stringify(mock.seen.thumbnails));
        console.log("7. sending again:", await refusal("publish", id), "| edit after sending:", await refusal("setMetadata", id, { title: "x" }), "| reschedule after sending:", await refusal("setSchedule", id, { at: at + 7200_000 }));
        const overview = await call("channel");
        console.log("8. channel:", JSON.stringify(overview.channel), "| days:", overview.days?.length, "| uploads:", overview.uploads?.length, "| times:", JSON.stringify(overview.times).slice(0, 300), "| analyticsError:", overview.analyticsError ?? null);
        console.log("   quota:", JSON.stringify((await state()).youtube.quota));
        await tab("Aguardando", "studio-publish-done.png");
        await studio.send("Emulation.setDeviceMetricsOverride", { width: 1364, height: 3200, deviceScaleFactor: 1, mobile: false });
        await sleep(600);
        await studio.shot("studio-review-full.png");
        await studio.send("Emulation.clearDeviceMetricsOverride", {});
        await tab("Calendário", "studio-calendar.png");
        await tab("Canal", "studio-channel.png");
        await tab("Configurações");
        await studio.ev("[...document.querySelectorAll('.studio-settings h3')].find(h => h.innerText.toLowerCase() === 'youtube')?.scrollIntoView()");
        await sleep(400);
        await studio.shot("studio-settings-youtube.png");
        console.log("   calls without sign-in refused by server:", mock.seen.noAuth.length, "| token grants:", mock.seen.tokens.join(","));
      }
      // The gate: approving, then changing something, must drop the approval.
      if (!mock) await call("approve", id);
      v = (await state()).videos.find((x) => x.id === id);
      console.log("approved:", v.status, Boolean(v.approval));
      if (!mock && v.data.cuts.length) {
        await call("setCut", id, v.data.cuts[0].id, !v.data.cuts[0].enabled);
        v = (await state()).videos.find((x) => x.id === id);
        console.log("after a change: status", v.status, "approval", v.approval, "dirty", v.data.dirty);
        const refused = await studio.ev(`window.api.studioCall("approve", ${id}).then(() => "APPROVED?!", (e) => e.message)`);
        console.log("approve while dirty:", refused.slice(-90));
        await call("setCut", id, v.data.cuts[0].id, !v.data.cuts[0].enabled);
      }
    }
  }
  // --shorts: makes Shorts from the newest recording that has suggestions, and checks the same approval gate.
  if (flag("--shorts")) {
    console.log("--- Shorts ---");
    const all = async () => (await state()).videos;
    const parent = (await all()).filter((v) => v.data.kind !== "short" && (v.data.shorts ?? []).length).pop();
    if (!parent) throw new Error("no recording with Shorts suggestions in the test profile");
    for (const old of (await all()).filter((v) => v.data.kind === "short" && v.data.parentId === parent.id && !v.data.youtube)) await call("removeVideo", old.id);
    const ideas = (await all()).find((v) => v.id === parent.id).data.shorts;
    console.log("parent:", parent.id, parent.title, "| suggestions:", ideas.map((i) => `#${i.id} ${i.start}-${i.end} "${i.title}"`).join(" | "));
    const free = ideas.filter((i) => !(parent.data.shortsSent ?? []).includes(i.id));
    const [a, b] = free;
    await call("setShort", parent.id, a.id, { hook: "OLHA ISSO", frame: "square" });
    if (b) await call("setShort", parent.id, b.id, { frame: "fill", captions: true });
    const rows = await call("makeShorts", parent.id, [a.id, ...(b ? [b.id] : [])]);
    console.log("rows created:", rows);
    const row = async (id) => (await all()).find((v) => v.id === id);
    const waitReady = async (id) => {
      for (let i = 0; i < 240; i++) {
        await sleep(1000);
        const r = await row(id);
        if (["review", "error"].includes(r.status)) return r;
      }
      throw new Error("short render timeout");
    };
    await sleep(1500);
    await tab("Shorts", "studio-shorts-rendering.png");
    const t0 = Date.now();
    let first = await waitReady(rows[0]);
    console.log("short 1:", first.status, first.error ?? "", "| duration", first.data.duration, "| file", first.data.finalPath && fs.existsSync(first.data.finalPath) ? Math.round(fs.statSync(first.data.finalPath).size / 1024) + " kB" : "MISSING", "| render s:", Math.round((Date.now() - t0) / 1000));
    if (rows[1]) {
      const second = await waitReady(rows[1]);
      console.log("short 2:", second.status, second.error ?? "", "| duration", second.data.duration, "| frame", second.data.frame);
    }
    await printLogs();
    console.log("metadata:", JSON.stringify({ title: first.data.metadata?.title, hashtags: first.data.metadata?.hashtags, description: first.data.metadata?.description }));
    console.log("S1. publish before approval:", await refusal("publish", rows[0]));
    await call("approve", rows[0]);
    console.log("S2. approved:", (await row(rows[0])).status);
    await call("setShort", parent.id, a.id, { end: a.end - 1 });
    first = await row(rows[0]);
    console.log("S3. after trimming 1 s: status", first.status, "| approval", first.approval, "|", await refusal("publish", rows[0]));
    first = await waitReady(rows[0]);
    console.log("    rendered again:", first.status, "duration", first.data.duration);
    await call("approve", rows[0]);
    await call("setMetadata", rows[0], { body: "Descrição mudada depois de aprovar" });
    console.log("S4. after changing the description:", (await row(rows[0])).status, "|", await refusal("publish", rows[0]));
    await call("approve", rows[0]);
    if (mock) {
      const before = mock.seen.uploads.length;
      await call("publish", rows[0]);
      for (let i = 0; i < 90; i++) {
        await sleep(1000);
        first = await row(rows[0]);
        if (first.data.youtube || ["error", "stopped"].includes(first.data.publish?.status)) break;
      }
      const up = mock.seen.uploads[before];
      console.log("S5. sent:", JSON.stringify(first.data.youtube), "| bytes ok:", up?.received === fs.statSync(first.data.finalPath).size, "| title:", up?.meta.snippet.title, "| has #shorts:", /#shorts/.test(up?.meta.snippet.description ?? ""), "| status:", JSON.stringify(up?.meta.status));
      console.log("S6. change after sending:", await refusal("setShort", parent.id, a.id, { end: a.end - 2 }), "| remove after sending:", await refusal("removeShort", parent.id, a.id));
    }
    if (value("--ask")) {
      const out = await call("askShorts", parent.id, value("--ask"));
      console.log("ask:", JSON.stringify(out));
      console.log("suggestions now:", (await row(parent.id)).data.shorts.map((i) => `#${i.id} ${i.start}-${i.end} "${i.title}" ${i.source ?? ""} hook="${i.hook ?? ""}" frame=${i.frame ?? "-"}`).join(" | "));
    }
    await printLogs();
    await tab("Painel", "studio-dashboard.png");
    await tab("Shorts");
    await studio.send("Emulation.setDeviceMetricsOverride", { width: 1500, height: 1500, deviceScaleFactor: 1, mobile: false });
    await sleep(900);
    await studio.shot("studio-shorts.png");
    await studio.send("Emulation.clearDeviceMetricsOverride", {});
  }
  // --flow: the fast render against the slow one, then a recording with a request, a stop after the cuts,
  // cuts by hand, by prompt and from the editor, and the rest of the flow.
  if (flag("--flow")) {
    console.log("--- Fluxo ---");
    const ffmpeg = "D:/CloneCapCut/editor/node_modules/ffmpeg-static/ffmpeg.exe";
    const all = async () => (await state()).videos;
    const row = async (id) => (await all()).find((v) => v.id === id);
    const waitFor = async (id, statuses, minutes = 40) => {
      const t0 = Date.now();
      let last = "";
      for (;;) {
        await sleep(2000);
        const r = await row(id);
        const running = r.stages.find((s) => s.status === "running");
        if (running && running.name !== last) console.log(`  t+${Math.round((Date.now() - t0) / 1000)}s ${(last = running.name)}`);
        await printLogs();
        if (statuses.includes(r.status)) return r;
        if (Date.now() - t0 > minutes * 60_000) throw new Error("flow timeout waiting for " + statuses.join("/"));
      }
    };
    const ff = (list, cwd = scratch) => {
      const out = spawnSync(ffmpeg, ["-hide_banner", ...list], { encoding: "utf8", maxBuffer: 1e9, cwd });
      return String(out.stdout ?? "") + String(out.stderr ?? "");
    };
    const lastFrames = (file) => Number([...ff(["-i", file, "-map", "0:v:0", "-c", "copy", "-f", "null", "-"]).matchAll(/frame=\s*(\d+)/g)].pop()?.[1] ?? -1);

    if (!flag("--no-compare")) {
      const old = (await all()).filter((v) => v.data.kind !== "short" && v.data.finalPath && !v.data.youtube && v.stages.every((s) => ["done", "skipped"].includes(s.status))).pop();
      if (!old) console.log("F0. no finished video in the test profile to compare renders with");
      else {
        const slow = path.join(scratch, "final-lento.mp4");
        const timed = async (direct) => {
          await call("setSettings", { render: { direct } });
          const t0 = Date.now();
          await call("redo", old.id, "assemble");
          const done = await waitFor(old.id, ["review", "error"]);
          return { done, seconds: Math.round((Date.now() - t0) / 1000) };
        };
        const a = await timed(false);
        fs.copyFileSync(a.done.data.finalPath, slow);
        const b = await timed(true);
        console.log(`F1. same project rendered twice: compositor only ${a.seconds} s | fast path ${b.seconds} s | video ${b.done.data.finalDuration} s | status ${a.done.status}/${b.done.status}`);
        // Frame against frame by number, on small grey copies: the two files do not share a time base.
        const grey = (file, out) => ff(["-loglevel", "error", "-y", "-i", file, "-vf", "scale=160:90,format=gray", "-fps_mode", "passthrough", "-f", "rawvideo", out]);
        grey(slow, "lento.raw");
        grey(b.done.data.finalPath, "rapido.raw");
        const one = fs.readFileSync(path.join(scratch, "lento.raw"));
        const two = fs.readFileSync(path.join(scratch, "rapido.raw"));
        const size = 160 * 90;
        const differ = [];
        let sum = 0;
        for (let i = 0; i < Math.min(one.length, two.length) / size; i++) {
          let error = 0;
          for (let k = i * size; k < (i + 1) * size; k++) error += (one[k] - two[k]) ** 2;
          sum += error / size;
          if (error / size > 60) differ.push(i);
        }
        console.log("F2. frames:", one.length / size, "vs", two.length / size, "| frames that differ:", differ.length, differ.slice(0, 20).join(" "), "| mean squared error:", (sum / (one.length / size)).toFixed(2));
        fs.rmSync(path.join(scratch, "lento.raw"));
        fs.rmSync(path.join(scratch, "rapido.raw"));
        const tone = (file) => {
          const out = ff(["-i", file, "-vf", "fps=1,scale=160:90,signalstats,metadata=print:file=-", "-f", "null", "-"]);
          const avg = (key) => {
            const values = [...out.matchAll(new RegExp(`signalstats\\.${key}=([\\d.]+)`, "g"))].map((m) => Number(m[1]));
            return values.length ? (values.reduce((s, v) => s + v, 0) / values.length).toFixed(2) : "?";
          };
          return `Y ${avg("YAVG")} U ${avg("UAVG")} V ${avg("VAVG")} sat ${avg("SATAVG")}`;
        };
        console.log("F5. average tone: compositor", tone(slow), "| fast", tone(b.done.data.finalPath));
      }
    }

    if (!flag("--only-compare")) {
    const sample = path.join(scratch, "amostra-3min.mp4");
    const copy = path.join(scratch, "amostra-fluxo.mp4");
    if (!fs.existsSync(copy)) fs.copyFileSync(sample, copy);
    for (const before of (await all()).filter((v) => v.source_path.replace(/\\/g, "/") === copy.replace(/\\/g, "/"))) await call("removeVideo", before.id);
    const brief = { text: value("--brief") ?? "Sem música de fundo. Legendas de 2 palavras. Corta do começo até 0:08. Quero conferir os cortes antes de seguir.", stops: [] };
    const [id] = await call("addVideos", [copy], null, brief);
    let v = await waitFor(id, ["hold", "review", "error"]);
    console.log("W1. after the Cut agent:", v.status, "| hold:", JSON.stringify(v.data.hold), "| stages:", v.stages.map((s) => `${s.name}=${s.status}`).join(" "));
    console.log("W2. request read:", JSON.stringify(v.data.brief), "| overrides:", JSON.stringify(v.data.overrides));
    const length = (r) => +(r.data.duration - mergedLength(r.data.cuts)).toFixed(2);
    const mergedLength = (cuts) => {
      let total = 0;
      let end = -1;
      for (const c of cuts.filter((x) => x.enabled).sort((x, y) => x.start - y.start)) {
        total += Math.max(0, c.end - Math.max(c.start, end));
        end = Math.max(end, c.end);
      }
      return total;
    };
    console.log("W3. cuts:", v.data.cuts.length, "| asked by the request:", v.data.cuts.filter((c) => c.kind === "pedido").map((c) => `${c.start}-${c.end} ${c.enabled ? "ON" : "off"} "${c.reason}"`).join(" | ") || "none", "| video would have", length(v), "s of", v.data.duration);
    await tab("Cortes", "studio-cuts.png");
    console.log("W4. cuts tab:", await studio.ev("(() => { const el = document.querySelector('.cuts-player video'); return { state: document.querySelector('.cuts-state')?.innerText.slice(0, 90), rows: document.querySelectorAll('.cuts-list li').length, player: el ? { ready: el.readyState, d: +el.duration.toFixed(1), err: el.error?.message ?? null } : null } })()"));
    const before = length(v);
    const added = await call("addCut", id, { start: 100, end: 112.5, reason: "teste" });
    v = await row(id);
    console.log("W5. cut by hand 100–112.5:", before, "→", length(v), "(api says", added.duration.toFixed(2) + ")", "| manual:", v.data.cuts.filter((c) => c.kind === "manual").length);
    console.log("W6. bad cut:", await refusal("addCut", id, { start: 50, end: 40 }), "|", await refusal("addCut", id, { start: 10, end: 99999 }));
    if (first.claude) {
      const asked = await call("askCuts", id, value("--ask-cuts") ?? "corta de 2:00 até 2:15 e não corta nada entre 0:30 e 0:45");
      v = await row(id);
      console.log("W7. request about cuts:", JSON.stringify(asked), "| cuts inside 30–45 still ON:", v.data.cuts.filter((c) => c.enabled && c.start < 45 && c.end > 30).length, "| 120–135 covered:", v.data.cuts.some((c) => c.enabled && c.start <= 120.5 && c.end >= 134.5));
    }
    const beforeEditor = length(v);
    const opened = await call("openCutsInEditor", id);
    await sleep(1500);
    console.log("W8. editor:", opened.path, "| editor shows:", await editor.ev("document.title + ' | ' + (document.querySelector('.timeline, .tracks') ? 'timeline' : 'no timeline')"));
    // What the creator would do in the editor: trim 3 s off the end of a long clip, then save.
    const project = JSON.parse(fs.readFileSync(opened.path, "utf8"));
    const track = project.tracks.find((t) => t.kind === "video");
    const clip = track.segments.find((s) => s.duration > 8e6);
    console.log("   clips in the cut project:", track.segments.length, "| trimming the one at source", (clip.sourceStart / 1e6).toFixed(2), "s, long", (clip.duration / 1e6).toFixed(2), "s");
    clip.duration -= 3e6;
    await sleep(1200);
    fs.writeFileSync(opened.path, JSON.stringify(project));
    console.log("W9. cuts with nothing new to bring? no:", JSON.stringify(await call("importEditorCuts", id)));
    v = await row(id);
    console.log("    after the editor:", beforeEditor, "→", length(v), "| manual cuts:", v.data.cuts.filter((c) => c.kind === "manual").map((c) => `${c.start}-${c.end}`).join(" "));
    await tab("Cortes", "studio-cuts-after.png");
    await tab("Painel", "studio-dashboard-hold.png");
    await studio.ev("[...document.querySelectorAll('.video-card')].find(c => c.innerText.includes('amostra-fluxo'))?.querySelector('.card-actions button:nth-of-type(3)')?.click()");
    await sleep(700);
    await studio.shot("studio-brief.png");
    await studio.ev("document.querySelector('.modal-actions button')?.click()");
    const expected = length(v);
    const t0 = Date.now();
    await call("continueVideo", id);
    v = await waitFor(id, ["review", "error", "hold"]);
    console.log("W10. after Continue:", v.status, v.error ?? "", "in", Math.round((Date.now() - t0) / 1000), "s | final", v.data.finalDuration, "expected", expected, "| music:", JSON.stringify(v.data.editDone?.music ?? null), "| captions:", v.data.editDone?.captions);
    if (v.data.projectPath && fs.existsSync(v.data.projectPath)) {
      const made = JSON.parse(fs.readFileSync(v.data.projectPath, "utf8"));
      const captions = made.tracks.find((t) => t.role === "captions")?.segments ?? [];
      const words = captions.map((s) => s.text.content.trim().split(/\s+/).length);
      console.log("W11. captions:", captions.length, "| most words in one:", Math.max(0, ...words), "| music clips:", made.tracks.filter((t) => t.kind === "audio").flatMap((t) => t.segments).filter((s) => /jamendo|library/i.test(made.materials[s.materialId]?.path ?? "")).length);
    }
    await tab("Painel", "studio-dashboard.png");
    }
  }
  // --parts: a project sent from the editor (one cut made in it), with a request for several videos and only some
  // agents; the parts are made, one goes back to the start, and one is changed in the editor and rendered as it is.
  if (flag("--parts")) {
    console.log("--- Do editor, em partes ---");
    const ffprobe = "D:/CloneCapCut/editor/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe";
    const probe = (f) => Number(spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.trim());
    const all = async () => (await state()).videos;
    const row = async (id) => (await all()).find((v) => v.id === id);
    const waitFor = async (id, statuses, minutes = 40) => {
      const t0 = Date.now();
      let last = "";
      for (;;) {
        await sleep(2000);
        const r = await row(id);
        const running = r.stages.find((s) => s.status === "running");
        if (running && running.name !== last) console.log(`  [${id}] t+${Math.round((Date.now() - t0) / 1000)}s ${(last = running.name)}`);
        await printLogs();
        if (statuses.includes(r.status)) return r;
        if (Date.now() - t0 > minutes * 60_000) throw new Error("timeout waiting for " + statuses.join("/"));
      }
    };
    const total = probe(video);
    const S = 1_000_000;
    // The editor's project: the recording on the main track with 10 s cut out at 0:20, and a text on top.
    const project = {
      version: 1, id: "teste", name: "Teste do editor", width: 1920, height: 1080, fps: 60, background: "#000000", backgroundMode: "color", backgroundBlur: 0, markers: [],
      materials: { m1: { id: "m1", kind: "video", path: video, name: "rec", duration: Math.round(total * S), width: 1920, height: 1080, hasVideo: true, hasAudio: true } },
      tracks: [
        { id: "t0", kind: "text", name: "Texto", segments: [{ id: "x1", materialId: null, start: 2 * S, duration: 3 * S, text: { content: "oi" } }] },
        { id: "t1", kind: "video", name: "Principal", segments: [
          { id: "s1", materialId: "m1", start: 0, duration: 20 * S, sourceStart: 0, speed: 1 },
          { id: "s2", materialId: "m1", start: 20 * S, duration: Math.round((total - 30) * S), sourceStart: 30 * S, speed: 1 },
        ] },
      ],
    };
    const agents = ["cut", "audio", "edit", "metadata", "assemble"];
    const id = await call("sendFromEditor", { project, projectPath: null, brief: { text: "Serão 2 vídeos, cada um com metade da gravação. Sem música. Legendas de 3 palavras.", stops: [], agents } });
    let v = await waitFor(id, ["hold", "review", "error"]);
    console.log("P1. status:", v.status, v.error ?? "", "| hold after:", v.data.hold?.after, "| split read:", JSON.stringify(v.data.brief?.split), "| thumbnail stage:", v.stages.find((s) => s.name === "thumbnail")?.status, "| editor cut:", JSON.stringify((v.data.cuts ?? []).filter((c) => c.kind === "manual").map((c) => [c.start, c.end])));
    console.log("P2. parts:", JSON.stringify(v.data.parts), "| reply:", v.data.partsReply);
    await tab("Cortes");
    await studio.ev(`[...document.querySelectorAll('.cuts-videos li, .cuts-list-videos li, aside li')].find(li => li.innerText.includes('Teste do editor'))?.click()`).catch(() => {});
    await sleep(800);
    await studio.shot("studio-parts.png");
    if (v.status !== "hold" || !v.data.parts?.length) throw new Error("no parts to make");
    const children = await call("makeParts", id);
    console.log("P3. children:", JSON.stringify(children), "| parent:", (await row(id)).status);
    const done = [];
    for (const c of children) done.push(await waitFor(c, ["review", "error", "hold"], 30));
    for (const c of done) {
      const kept = (c.data.duration ?? 0) - (c.data.cuts ?? []).filter((x) => x.enabled).reduce((s, x) => s + x.end - x.start, 0);
      console.log(`P4. ${c.title}: ${c.status} ${c.error ?? ""} | part ${c.data.partOf?.start}–${c.data.partOf?.end} | final ${c.data.finalPath ? probe(c.data.finalPath).toFixed(2) : "-"} s (cuts say ${kept.toFixed(2)}) | thumbnail: ${c.stages.find((s) => s.name === "thumbnail")?.status} | music: ${JSON.stringify(c.data.editDone?.music ?? null)}`);
    }
    const first = done[0];
    // Back to the start: a cut by hand, then on again.
    await call("backToStart", first.id, { fromEditor: false });
    let b = await row(first.id);
    console.log("P5. back to start:", b.status, b.data.hold?.after, "| edit:", b.stages.find((s) => s.name === "edit")?.status, "| assemble:", b.stages.find((s) => s.name === "assemble")?.status);
    const at = first.data.partOf.start + 5;
    await call("addCut", first.id, { start: at, end: at + 4, reason: "teste" });
    await call("continueVideo", first.id);
    b = await waitFor(first.id, ["review", "error", "hold"], 30);
    console.log("P6. after continue:", b.status, b.error ?? "", "| final", b.data.finalPath ? probe(b.data.finalPath).toFixed(2) : "-", "s (was", probe(first.data.finalPath).toFixed(2), "- 4 expected)");
    // Changed in the editor: the project gets a new name and loses its captions, then is rendered as it is.
    const second = done[1] ?? done[0];
    const proj = JSON.parse(fs.readFileSync(second.data.projectPath, "utf8"));
    proj.tracks = proj.tracks.filter((t) => t.role !== "captions");
    await sleep(1200);
    fs.writeFileSync(second.data.projectPath, JSON.stringify(proj));
    let c2 = await row(second.id);
    console.log("P7. project changed seen:", c2.projectChanged);
    await call("renderAsEdited", second.id);
    c2 = await waitFor(second.id, ["review", "error"], 30);
    const rendered = JSON.parse(fs.readFileSync(c2.data.projectPath, "utf8"));
    console.log("P8. rendered as edited:", c2.status, c2.error ?? "", "| captions in project:", rendered.tracks.filter((t) => t.role === "captions").length, "| changed flag now:", c2.projectChanged, "| final", probe(c2.data.finalPath).toFixed(2), "s");
    console.log("P9. remove parent while parts exist:", await refusal("removeVideo", id));
    await tab("Aguardando");
    await sleep(600);
    await studio.shot("studio-review-parts.png");
    await tab("Painel", "studio-dashboard-parts.png");
  }
  // --order: a project whose main track repeats a highlight at the start, swaps two stretches and speeds one up.
  // Sent as it is, it is refused with where the problem is; sent "in the editor's order", a new recording is made.
  if (flag("--order")) {
    console.log("--- Na ordem do editor ---");
    const ffmpeg = "D:/CloneCapCut/editor/node_modules/ffmpeg-static/ffmpeg.exe";
    const ffprobe = "D:/CloneCapCut/editor/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe";
    const probe = (f) => Number(spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.trim());
    const audioCount = (f) => spawnSync(ffprobe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.trim().split(/\s+/).filter(Boolean).length;
    const grey = (f, t) => spawnSync(ffmpeg, ["-v", "error", "-ss", String(t), "-i", f, "-frames:v", "1", "-vf", "scale=160:90,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1e8 }).stdout;
    const diff = (a, b) => { let s = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) s += Math.abs(a[i] - b[i]); return s / Math.max(1, Math.min(a.length, b.length)); };
    const all = async () => (await state()).videos;
    const row = async (id) => (await all()).find((v) => v.id === id);
    const waitFor = async (id, statuses, minutes = 30) => {
      const t0 = Date.now();
      let last = "";
      for (;;) {
        await sleep(2000);
        const r = await row(id);
        const running = r.stages.find((s) => s.status === "running");
        if (running && `${running.name}${running.message ?? ""}`.slice(0, 40) !== last) console.log(`  t+${Math.round((Date.now() - t0) / 1000)}s ${(last = `${running.name} ${running.message ?? ""}`.slice(0, 40))}`);
        await printLogs();
        if (statuses.includes(r.status)) return r;
        if (Date.now() - t0 > minutes * 60_000) throw new Error("timeout waiting for " + statuses.join("/"));
      }
    };
    const S = 1_000_000;
    // Timeline: 0:00 highlight (source 120–130), source 0–40, source 60–90 at 2x (15 s), source 40–60.
    const parts = [
      { from: 120, len: 10, speed: 1 },
      { from: 0, len: 40, speed: 1 },
      { from: 60, len: 15, speed: 2 },
      { from: 40, len: 20, speed: 1 },
    ];
    let at = 0;
    const segments = parts.map((p, i) => {
      const s = { id: `s${i}`, materialId: "m1", start: at * S, duration: p.len * S, sourceStart: p.from * S, speed: p.speed };
      at += p.len;
      return s;
    });
    const project = {
      version: 1, id: "ordem", name: "Teste da ordem", width: 1920, height: 1080, fps: 60, background: "#000000", backgroundMode: "color", backgroundBlur: 0, markers: [],
      materials: { m1: { id: "m1", kind: "video", path: video, name: "rec", duration: Math.round(probe(video) * S), width: 1920, height: 1080, hasVideo: true, hasAudio: true } },
      tracks: [{ id: "t1", kind: "video", name: "Principal", segments }],
    };
    console.log("O1. sent as it is:", await refusal("sendFromEditor", { project, brief: { text: "", stops: [], agents: ["cut", "audio", "edit", "assemble"] } }));
    const steady = { ...project, tracks: [{ ...project.tracks[0], segments: project.tracks[0].segments.map((s) => ({ ...s, speed: 1 })) }] };
    console.log("O1b. without the speed-up:", await refusal("sendFromEditor", { project: steady, brief: { text: "", stops: [], agents: ["cut"] } }));
    const t0 = Date.now();
    const id = await call("sendFromEditor", { project, brief: { text: "Sem música.", stops: [], agents: ["cut", "audio", "edit", "assemble"] }, order: true });
    const v = await waitFor(id, ["review", "error", "hold"]);
    const made = v.source_path;
    console.log("O2.", v.status, v.error ?? "", "in", Math.round((Date.now() - t0) / 1000), "s | new recording:", made, probe(made).toFixed(2), "s (expected", at, ") | sound tracks:", audioCount(made), "(source", audioCount(video), ")");
    const checks = [
      ["highlight 0:01", grey(made, 1), grey(video, 121)],
      ["second stretch 0:15", grey(made, 15), grey(video, 5)],
      ["sped up 0:55", grey(made, 55), grey(video, 70)],
      ["last stretch 1:10", grey(made, 70), grey(video, 50)],
      ["wrong place (control)", grey(made, 1), grey(video, 5)],
    ];
    for (const [label, a, b] of checks) console.log(`O3. ${label}: mean diff ${diff(a, b).toFixed(1)}`);
    console.log("O4. tracks seen:", JSON.stringify((v.data.tracks ?? []).map((t) => t.role)), "| final", v.data.finalPath ? probe(v.data.finalPath).toFixed(2) : "-", "s");
  }
  // --series: what the editor's AI does with a long recording: two projects of its own (one of them out of the
  // recording's order) sent as one series with only Metadata and Thumbnail, planned every other day, approved,
  // and sent to the stand-in YouTube (with --youtube).
  if (flag("--series")) {
    console.log("--- Série da IA principal ---");
    const ffprobe = "D:/CloneCapCut/editor/node_modules/ffprobe-static/bin/win32/x64/ffprobe.exe";
    const probe = (f) => Number(spawnSync(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f], { encoding: "utf8" }).stdout.trim());
    const all = async () => (await state()).videos;
    const row = async (id) => (await all()).find((v) => v.id === id);
    const waitFor = async (id, statuses, minutes = 30) => {
      const t0 = Date.now();
      for (;;) {
        await sleep(2500);
        const r = await row(id);
        await printLogs();
        if (statuses.includes(r.status)) return r;
        if (Date.now() - t0 > minutes * 60_000) throw new Error("timeout waiting for " + statuses.join("/"));
      }
    };
    const S = 1_000_000;
    const total = probe(video);
    const projectOf = (name, parts) => {
      let at = 0;
      const segments = parts.map(([from, len], i) => {
        const s = { id: `s${i}`, materialId: "m1", start: at * S, duration: len * S, sourceStart: from * S, speed: 1 };
        at += len;
        return s;
      });
      return {
        version: 1, id: name, name, width: 1920, height: 1080, fps: 60, background: "#000000", backgroundMode: "color", backgroundBlur: 0, markers: [],
        materials: { m1: { id: "m1", kind: "video", path: video, name: "rec", duration: Math.round(total * S), width: 1920, height: 1080, hasVideo: true, hasAudio: true } },
        tracks: [{ id: "t1", kind: "video", name: "Principal", segments }],
      };
    };
    const dir = path.join(scratch, "serie");
    fs.mkdirSync(dir, { recursive: true });
    const one = projectOf("Corrida 1", [[0, 60]]);
    // A highlight first: the order of the recording does not matter when the project is rendered as it is.
    const two = projectOf("Corrida 2", [[150, 8], [90, 70]]);
    const ids = [];
    for (const [p, file] of [[one, "corrida-1.cena"], [two, "corrida-2.cena"]]) {
      fs.writeFileSync(path.join(dir, file), JSON.stringify(p));
      ids.push(await call("sendFromEditor", { project: p, projectPath: path.join(dir, file), series: "GTA teste", title: p.name, brief: { text: "Corrida de caminhões no GTA com os amigos.", stops: [], agents: ["metadata", "thumbnail"] } }));
    }
    console.log("S1. sent:", JSON.stringify(ids));
    const done = [];
    for (const id of ids) done.push(await waitFor(id, ["review", "error"]));
    for (const v of done) console.log(`S2. ${v.title}: ${v.status} ${v.error ?? ""} | stages ${v.stages.map((s) => `${s.name}:${s.status}`).join(" ")} | final ${v.data.finalPath ? probe(v.data.finalPath).toFixed(2) : "-"} s | title "${v.data.metadata?.title ?? ""}" | thumbs ${JSON.stringify((v.data.thumbnails ?? []).map((t) => t.text))}`);
    const overview = await call("overviewForAgent");
    console.log("S3. overview for the AI:", JSON.stringify(overview.filter((o) => ids.includes(o.id)).map((o) => ({ id: o.id, series: o.series, status: o.status }))));
    const start = new Date(Date.now() + 2 * 86_400_000);
    const day = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-${String(start.getDate()).padStart(2, "0")}`;
    const planned = await call("scheduleSeries", ids, { start: day, everyDays: 2, time: "20:30" });
    console.log("S4. planned:", planned.map((p) => `${p.title} ${new Date(p.at).toLocaleString("pt-BR")}`).join(" | "));
    console.log("S5. upload before approval:", await refusal("publish", ids[0]));
    if (mock) {
      await call("setSettings", { publish: { auto: true } });
      for (const id of ids) await call("approve", id);
      for (let i = 0; i < 40; i++) {
        await sleep(2000);
        const rows = await Promise.all(ids.map(row));
        if (rows.every((r) => r.data.youtube?.id || r.data.publish?.status === "error")) break;
      }
      for (const id of ids) {
        const r = await row(id);
        console.log(`S6. ${r.title}: youtube ${r.data.youtube?.id ?? "-"} publishAt ${r.data.youtube?.publishAt ? new Date(r.data.youtube.publishAt).toLocaleString("pt-BR") : "-"} | publish ${JSON.stringify(r.data.publish ?? null).slice(0, 120)}`);
      }
      await call("setSettings", { publish: { auto: false } });
    }
    await tab("Painel");
    await studio.ev("[...document.querySelectorAll('.kanban-head button')].find(b => b.innerText.includes('Programar')).click()");
    await sleep(800);
    await studio.shot("studio-release-plan.png");
  }
  // --send-dialog: the editor's "Enviar ao Estúdio" window, opened from a new project.
  if (flag("--send-dialog")) {
    await editor.ev("document.querySelector('.home-create')?.click()");
    await sleep(1200);
    await editor.ev("[...document.querySelectorAll('.topbar button')].find(b => b.innerText.includes('Enviar ao Estúdio')).click()");
    await sleep(1000);
    await editor.ev("[...document.querySelectorAll('.send-examples button')][0].click()");
    await editor.ev("[...document.querySelectorAll('.agents-picker input')].at(-1).click()");
    await sleep(500);
    await editor.shot("editor-send.png");
    await editor.ev("[...document.querySelectorAll('.send-studio-modal .modal-actions button')].at(-1).click()");
    await sleep(1500);
    console.log("send with an empty project:", await editor.ev("document.querySelector('.send-error')?.innerText ?? 'sem erro'"));
    await editor.shot("editor-send-error.png");
  }
  if (flag("--settings")) {
    await studio.ev("[...document.querySelectorAll('.studio-top nav button')].find(b => b.innerText.includes('Configurações')).click()");
    await sleep(800);
    await studio.shot("studio-settings.png");
    await studio.send("Emulation.setDeviceMetricsOverride", { width: 1364, height: 3600, deviceScaleFactor: 1, mobile: false });
    await sleep(500);
    await studio.shot("studio-settings-full.png");
  }
} catch (err) {
  failed = true;
  console.error("FAILED:", err.message);
  console.error(appLog.slice(-3000));
} finally {
  kill();
  mock?.close();
  await sleep(800);
  fs.rmSync(path.join(userData, "autosave"), { recursive: true, force: true });
}
console.log(failed ? "DONE WITH FAILURE" : "DONE");
