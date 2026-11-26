/**
 * Local MCP server (Streamable HTTP, JSON responses) that lets an AI client such as Claude Code
 * edit the open project. The tools themselves live in the renderer (src/agentTools.ts), next to
 * the editor state; this file only speaks the protocol and guards the door:
 * off by default, bound to 127.0.0.1, bearer token required, browsers refused.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const DEFAULT_PORT = 47821;
const MAX_BODY = 8 * 1024 * 1024;
/** Tools answer within ~50 s; anything longer comes back as a job (see src/agentTools.ts). */
const RENDERER_TIMEOUT = 120_000;

const INSTRUCTIONS = `Cena is a desktop video editor. These tools edit the project open on the user's screen; every change appears live and the user can press Ctrl+Z.
- All times are in seconds on the timeline, unless a parameter says otherwise. Ids come from get_project.
- Start with get_project. Call list_catalog for valid filters, effects, transitions and templates.
- Look at your work: get_frame returns the rendered frame, so check text placement and color after changing them.
- Each edit tool is one undo step. Use batch to make several edits a single step, and remove_ranges to cut stretches out of the whole timeline.
- To edit by speech, call get_transcript, then remove_ranges or add_captions with its timestamps.
- When the magnet is on (see get_project), the main video track closes gaps by itself, so clip positions can change after deleting, trimming or moving. Re-read them with get_project.
- Long tools (export_video, get_transcript, auto_captions, process_clip) may answer with a jobId; follow it with get_job.
- Gameplay videos: OBS recordings with several audio tracks arrive as the video plus linked audio clips (game, microphone…). Polish the commentary with process_clip enhanceVoice, lower the game under it with duck_audio, cut pauses with remove_silences, find action with find_highlights, mark shots with detect_scenes, add punch_zoom on big plays, and use vertical_gaming_layout for Shorts. Templates gg, kill and epic exist. Export with normalizeLoudness: true.
- AI voice: ai_voice speaks a sentence the creator wrote (Brazilian Portuguese, offline voice). narrated_hook makes the "Olha o que aconteceu quando…" opening: the voice over a slower, muted preview of the scene with the sentence on screen, then the real scene. Use the creator's words for the sentence; if the voice is not downloaded yet, tell them to click IA on the timeline toolbar and then Baixar voz de IA.
- Motion graphics (animated titles, lower thirds, charts, kinetic text) can be made with HyperFrames when its skill is available: write the composition at the project's width, height and fps, render it with \`npx hyperframes render <dir> --format webm --output <absolute path>.webm\` (transparent background), then import_media and add_clip with overlay: true at the right start. Use --format mp4 for full-frame scenes that go on the main track. Look at the result with get_frame.
- Memory: call get_preferences at the start of a conversation and follow the user's saved editing preferences. When the user states a lasting preference ("sempre", "prefiro", "meus vídeos são…"), save it with remember_preference; remove outdated ones with forget_preference.
- Several videos from one long recording (for example "2 races per video"): find where each part starts and ends (detect_scenes, get_frame, get_transcript), then for each part build its own project (new_project, import_media, add_clip, trim and cut it, edit the sound and the picture as you would for one video), save it with save_project and send it with studio_send_project using one series name. The studio's agents write the metadata and the thumbnails (different for each video of the series) and render your project as it is. Plan the releases with studio_schedule when the user says how often. Nothing reaches YouTube until the user approves each video in the studio; never say otherwise.
- Files are never overwritten unless you pass overwrite: true, and unsaved work is not discarded unless you pass discardChanges: true. Ask the user first.`;

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

function sameToken(given, token) {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(body === undefined ? undefined : JSON.stringify(body));
}

/** `backend`: { version, listTools(), callTool(name, args), onClient(label) }. */
function createServer(token, backend) {
  async function dispatch(message) {
    if (message?.jsonrpc !== "2.0" || typeof message.method !== "string") {
      // A reply to a server request would land here; this server sends none.
      return "result" in (message ?? {}) || "error" in (message ?? {}) ? null : rpcError(message?.id ?? null, -32600, "Invalid request");
    }
    const { id, method, params } = message;
    if (id === undefined) return null; // notification
    try {
      switch (method) {
        case "initialize": {
          const asked = params?.protocolVersion;
          const client = params?.clientInfo;
          if (client?.name) backend.onClient(`${client.name}${client.version ? ` ${client.version}` : ""}`);
          return rpcResult(id, {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: {} },
            serverInfo: { name: "cena", title: "Cena", version: backend.version },
            instructions: INSTRUCTIONS,
          });
        }
        case "ping":
          return rpcResult(id, {});
        case "tools/list":
          return rpcResult(id, { tools: await backend.listTools() });
        case "tools/call": {
          const tools = await backend.listTools();
          if (!tools.some((t) => t.name === params?.name)) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
          try {
            return rpcResult(id, { content: await backend.callTool(params.name, params.arguments ?? {}) });
          } catch (err) {
            return rpcResult(id, { content: [{ type: "text", text: err.message }], isError: true });
          }
        }
        default:
          return rpcError(id, -32601, `Method not found: ${method}`);
      }
    } catch (err) {
      return rpcError(id, -32603, err.message);
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (new URL(req.url, "http://127.0.0.1").pathname !== "/mcp") return sendJson(res, 404, { error: "not found" });
      // Web pages can reach localhost: a foreign Host is DNS rebinding, and any Origin is a browser.
      const { port } = server.address();
      if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host) || req.headers.origin) return sendJson(res, 403, { error: "forbidden" });
      const auth = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
      if (!auth || !sameToken(auth[1], token)) return sendJson(res, 401, { error: "invalid token" }, { "WWW-Authenticate": "Bearer" });
      // No server-initiated messages, so there is no event stream to open.
      if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" }, { Allow: "POST" });
      if (!/^application\/json/i.test(req.headers["content-type"] ?? "")) return sendJson(res, 415, { error: "expected application/json" });

      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return sendJson(res, 400, rpcError(null, -32700, "Parse error"));
      }
      if (Array.isArray(body)) {
        const replies = (await Promise.all(body.map(dispatch))).filter(Boolean);
        return replies.length ? sendJson(res, 200, replies) : sendJson(res, 202);
      }
      const reply = await dispatch(body);
      return reply ? sendJson(res, 200, reply) : sendJson(res, 202);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    }
  });
  return server;
}

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });

const close = (server) =>
  new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });

/** Wire the server to settings and to the renderer. Call once, before the window loads. */
function registerAgent({ app, ipcMain, BrowserWindow, editorWindow }) {
  const file = path.join(app.getPath("userData"), "agent.json");
  const newToken = () => crypto.randomBytes(32).toString("base64url");
  let settings = { enabled: false, port: DEFAULT_PORT, token: newToken() };
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(file, "utf8")) };
  } catch {
    // First run: the defaults are saved when the user turns the server on.
  }
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), { mode: 0o600 });
  };

  // The studio adds windows of its own, so "the first window" is no longer the editor.
  const mainWindow = () => editorWindow?.() ?? BrowserWindow.getAllWindows()[0] ?? null;

  /** Run one tool in a given window (the studio's hidden worker) and get its JSON answer. */
  function callToolIn(win, name, args, timeout = RENDERER_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (!win || win.isDestroyed()) return reject(new Error("A janela de trabalho do Estúdio está fechada."));
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`O Cena não respondeu a tempo (${name}).`));
      }, timeout);
      pending.set(id, {
        timer,
        reject,
        resolve: (content) => {
          try {
            resolve(JSON.parse(content.find((part) => part.type === "text")?.text ?? "null"));
          } catch (err) {
            reject(err);
          }
        },
      });
      win.webContents.send("agent:call", { id, name, args });
    });
  }
  const pending = new Map();
  let server = null;
  let running = false;
  let error = null;
  let client = null;
  let tools = null;
  let toolWaiters = [];

  const state = () => ({
    enabled: settings.enabled,
    running,
    port: settings.port,
    token: settings.token,
    url: `http://127.0.0.1:${settings.port}/mcp`,
    error,
    client,
  });
  const publish = () => mainWindow()?.webContents.send("agent:state", state());

  const backend = {
    version: app.getVersion(),
    onClient(label) {
      client = label;
      publish();
    },
    listTools() {
      if (tools) return tools;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("O Cena ainda está abrindo.")), 15_000);
        toolWaiters.push((list) => {
          clearTimeout(timer);
          resolve(list);
        });
      });
    },
    callTool(name, args) {
      const win = mainWindow();
      if (!win) throw new Error("A janela do Cena está fechada.");
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("O Cena não respondeu a tempo."));
        }, RENDERER_TIMEOUT);
        pending.set(id, { resolve, reject, timer });
        win.webContents.send("agent:call", { id, name, args });
      });
    },
  };

  /** A private endpoint for Cena's own assistant: random port and token, independent of the user's switch. */
  let internal = null;
  async function internalEndpoint() {
    if (!internal) {
      const token = newToken();
      const srv = createServer(token, { ...backend, onClient() {} });
      internal = listen(srv, 0).then((port) => ({ server: srv, url: `http://127.0.0.1:${port}/mcp`, token }));
      internal.catch(() => (internal = null));
    }
    const { url, token } = await internal;
    return { url, token };
  }

  /** On quit: the user's server and the assistant's. */
  async function dispose() {
    await stop();
    if (internal) {
      const { server: srv } = await internal.catch(() => ({}));
      internal = null;
      if (srv) await close(srv);
    }
  }

  async function stop() {
    const current = server;
    server = null;
    running = false;
    if (current) await close(current);
  }

  async function start() {
    await stop();
    error = null;
    if (!settings.enabled) return;
    const next = createServer(settings.token, backend);
    try {
      await listen(next, settings.port);
      server = next;
      running = true;
    } catch (err) {
      error = err.code === "EADDRINUSE" ? `A porta ${settings.port} já está em uso. Escolha outra.` : err.message;
    }
  }

  ipcMain.handle("agent:state", state);
  ipcMain.handle("agent:configure", async (_e, patch) => {
    if (patch.enabled !== undefined) settings.enabled = patch.enabled;
    if (patch.port !== undefined) settings.port = patch.port;
    if (patch.newToken) settings.token = newToken();
    save();
    if (patch.enabled !== undefined) client = null;
    await start();
    return state();
  });
  ipcMain.handle("agent:tools", (_e, list) => {
    tools = list;
    for (const waiter of toolWaiters) waiter(list);
    toolWaiters = [];
  });
  ipcMain.on("agent:result", (_e, { id, ok, content, error: message }) => {
    const call = pending.get(id);
    if (!call) return;
    pending.delete(id);
    clearTimeout(call.timer);
    if (ok) call.resolve(content);
    else call.reject(new Error(message));
  });

  /** Runs the real protocol against a throwaway server, for the end-to-end self test. */
  async function smokeCheck() {
    const token = newToken();
    const test = createServer(token, backend);
    const port = await listen(test, 0);
    const post = (message, headers = {}) =>
      new Promise((resolve, reject) => {
        const data = JSON.stringify(message);
        const req = http.request(
          { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers } },
          (res) => {
            let text = "";
            res.setEncoding("utf8");
            res.on("data", (c) => (text += c));
            res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }));
          },
        );
        req.on("error", reject);
        req.end(data);
      });
    const rpc = (id, method, params) => post({ jsonrpc: "2.0", id, method, params });
    try {
      const init = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
      const notify = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
      const list = await rpc(2, "tools/list");
      const project = await rpc(3, "tools/call", { name: "get_project", arguments: {} });
      const unknownTool = await rpc(4, "tools/call", { name: "nope", arguments: {} });
      const badClip = await rpc(5, "tools/call", { name: "delete_clips", arguments: { clipIds: ["missing"] } });
      return {
        version: init.body.result.protocolVersion,
        hasInstructions: Boolean(init.body.result.instructions),
        notificationStatus: notify.status,
        tools: list.body.result.tools.length,
        projectText: project.body.result.content[0].text,
        unknownToolCode: unknownTool.body.error.code,
        toolErrorFlag: badClip.body.result.isError,
        wrongToken: (await post({}, { Authorization: "Bearer wrong" })).status,
        noToken: (await post({}, { Authorization: "" })).status,
        fromBrowser: (await post({}, { Origin: "https://example.com" })).status,
        rebinding: (await post({}, { Host: "evil.example" })).status,
      };
    } finally {
      await close(test);
    }
  }

  return { start, dispose, smokeCheck, internalEndpoint, callToolIn };
}

module.exports = { registerAgent };
