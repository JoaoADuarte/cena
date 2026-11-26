/**
 * Everything the studio says to YouTube goes through here: the official Data and Analytics APIs, nothing scraped.
 * Reading public numbers needs only an API key; anything about the creator's own channel (uploading, analytics)
 * needs them to sign in with Google in their own browser. The studio never sees their password.
 * Keys and tokens are kept encrypted by Windows for this user (Electron safeStorage).
 */
const { safeStorage, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");

// The addresses can be pointed at a local stand-in for automated tests. Nothing else ever changes them.
const HOSTS = {
  api: process.env.CENA_YT_API || "https://www.googleapis.com",
  auth: process.env.CENA_YT_AUTH || "https://accounts.google.com/o/oauth2/v2/auth",
  token: process.env.CENA_YT_TOKEN || "https://oauth2.googleapis.com/token",
  revoke: process.env.CENA_YT_REVOKE || "https://oauth2.googleapis.com/revoke",
  analytics: process.env.CENA_YT_ANALYTICS || "https://youtubeanalytics.googleapis.com",
};
const STAND_IN = Boolean(process.env.CENA_YT_AUTH);

/** The least that does the job: upload, read the own channel, read its analytics. No permission to delete or edit. */
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/yt-analytics.readonly"];

/** Daily allowance of a Google Cloud project (developers.google.com/youtube/v3/determine_quota_cost, read 11/2026). */
const QUOTA = { units: 10_000, searches: 100, uploads: 100 };
const CHUNK = 16 * 1024 * 1024;
const DAY = 24 * 3600_000;

const REASONS = {
  quotaExceeded: "A cota diária da API do YouTube acabou. Ela volta à meia-noite do horário do Pacífico (4h ou 5h da manhã em Brasília).",
  dailyLimitExceeded: "A cota diária da API do YouTube acabou. Ela volta à meia-noite do horário do Pacífico (4h ou 5h da manhã em Brasília).",
  rateLimitExceeded: "O YouTube pediu para ir mais devagar. Tento de novo em instantes.",
  uploadLimitExceeded: "O canal atingiu o limite de envios do YouTube por hoje.",
  keyInvalid: "A chave de API do YouTube não é válida.",
  badRequest: "O YouTube recusou o pedido.",
  forbidden: "O YouTube recusou: esta conta ou este projeto não tem permissão para isso.",
  youtubeSignupRequired: "A conta escolhida na página do Google não tem canal no YouTube. Se o seu canal é de uma conta de marca (tem o nome do canal em vez do seu), conecte de novo e, na página do Google, escolha o canal na lista, não a sua conta pessoal.",
  invalidPublishAt: "O YouTube recusou o horário do agendamento.",
  invalidTitle: "O YouTube recusou o título (vazio ou com mais de 100 caracteres).",
  invalidDescription: "O YouTube recusou a descrição (mais de 5.000 caracteres ou com < e >).",
  invalidTags: "O YouTube recusou as tags (juntas passam de 500 caracteres).",
  accessNotConfigured: "A API do YouTube não está ativada neste projeto do Google Cloud.",
  invalid_grant: "O Google cancelou o acesso ao canal. Conecte o canal de novo nas Configurações. Se isso se repetir a cada 7 dias, o app no Google Cloud está \"Em teste\": em Tela de consentimento OAuth, clique em \"Publicar app\".",
  invalid_client: "O ID ou a chave secreta do cliente OAuth não conferem.",
};

const base64url = (buffer) => buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const pacificDay = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());

/** "PT1H2M3S" → seconds. */
function isoSeconds(text) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(text ?? ""));
  return m ? Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0) : 0;
}

class YouTubeError extends Error {
  constructor(message, { reason = null, status = 0 } = {}) {
    super(message);
    this.reason = reason;
    this.status = status;
    /** Worth trying again later without the creator doing anything. */
    this.temporary = status >= 500 || status === 0 || status === 429 || reason === "rateLimitExceeded";
    this.quota = reason === "quotaExceeded" || reason === "dailyLimitExceeded" || reason === "uploadLimitExceeded";
  }
}

async function failure(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    // Not JSON: the status is all there is.
  }
  const reason = body?.error?.errors?.[0]?.reason ?? (typeof body?.error === "string" ? body.error : null);
  const detail = body?.error?.message ?? body?.error_description ?? `HTTP ${res.status}`;
  return new YouTubeError(REASONS[reason] ?? `O YouTube respondeu com erro: ${detail}`, { reason, status: res.status });
}

function createYouTube({ db, cacheFile }) {
  // --- Keys and tokens ----------------------------------------------------------------------------
  const seal = (value) => (safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(JSON.stringify(value)).toString("base64") } : { plain: value });
  const open = (stored) => {
    try {
      if (stored?.enc) return JSON.parse(safeStorage.decryptString(Buffer.from(stored.enc, "base64")));
    } catch {
      return {};
    }
    return stored?.plain ?? {};
  };
  const secrets = () => open(db.setting("youtube", null));
  const saveSecrets = (patch) => db.setSetting("youtube", seal({ ...secrets(), ...patch }));

  // --- Quota: counted here so the studio stops before YouTube refuses --------------------------------
  function quota() {
    const stored = db.setting("youtubeQuota", null);
    return stored?.day === pacificDay() ? stored : { day: pacificDay(), units: 0, searches: 0, uploads: 0 };
  }
  function spend(kind, amount = 1) {
    const q = quota();
    q[kind] += amount;
    db.setSetting("youtubeQuota", q);
  }
  function room(kind, amount = 1) {
    if (quota()[kind] + amount > QUOTA[kind]) throw new YouTubeError(REASONS.quotaExceeded, { reason: "quotaExceeded", status: 403 });
  }

  // --- Cache: the same question is not paid for twice ------------------------------------------------
  let cache = null;
  function cached(key, maxAge) {
    if (!cache) {
      try {
        cache = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      } catch {
        cache = {};
      }
    }
    const hit = cache[key];
    return hit && Date.now() - hit.at < maxAge ? hit.value : undefined;
  }
  function remember(key, value) {
    cached(key, 0);
    cache[key] = { at: Date.now(), value };
    for (const [k, v] of Object.entries(cache)) if (Date.now() - v.at > 7 * DAY) delete cache[k];
    fs.writeFile(cacheFile, JSON.stringify(cache), () => {});
  }

  // --- Signing in ------------------------------------------------------------------------------------
  async function tokenRequest(params) {
    const res = await fetch(HOSTS.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params) });
    if (!res.ok) throw await failure(res);
    return res.json();
  }

  async function accessToken() {
    const s = secrets();
    if (!s.refreshToken) throw new YouTubeError("O canal do YouTube não está conectado. Conecte-o nas Configurações.", { reason: "notConnected", status: 401 });
    if (s.accessToken && s.expiresAt - 60_000 > Date.now()) return s.accessToken;
    let fresh;
    try {
      fresh = await tokenRequest({ client_id: s.clientId, client_secret: s.clientSecret, refresh_token: s.refreshToken, grant_type: "refresh_token" });
    } catch (err) {
      // Google took the permission back (revoked, or the 7 days of an app still "em teste" ran out): the studio
      // stops saying "conectado", so Configurações shows the button to connect again.
      if (err.reason === "invalid_grant") saveSecrets({ refreshToken: null, accessToken: null, expiresAt: 0 });
      throw err;
    }
    saveSecrets({ accessToken: fresh.access_token, expiresAt: Date.now() + fresh.expires_in * 1000 });
    return fresh.access_token;
  }

  let connecting = null;
  /** Opens Google's own consent page in the creator's browser and waits for them to allow or refuse. */
  function connect() {
    if (connecting) return connecting;
    const { clientId, clientSecret } = secrets();
    if (!clientId || !clientSecret) throw new Error("Informe antes o ID e a chave secreta do cliente OAuth.");
    connecting = (async () => {
      const verifier = base64url(crypto.randomBytes(48));
      const state = base64url(crypto.randomBytes(16));
      const server = http.createServer();
      await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
      const redirect = `http://127.0.0.1:${server.address().port}`;
      try {
        const code = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("A autorização não foi concluída em 5 minutos.")), 5 * 60_000);
          server.on("request", (req, res) => {
            const url = new URL(req.url, redirect);
            if (url.searchParams.get("state") !== state) {
              res.writeHead(400).end();
              return;
            }
            const refused = url.searchParams.get("error");
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(`<body style="font:16px system-ui;background:#141417;color:#eee;padding:48px"><h2>Cena Estúdio</h2><p>${refused ? "A autorização foi recusada." : "Canal conectado."} Pode fechar esta aba.</p></body>`);
            clearTimeout(timer);
            if (refused) reject(new Error("Você recusou a autorização no Google."));
            else resolve(url.searchParams.get("code"));
          });
          const url = `${HOSTS.auth}?${new URLSearchParams({
            client_id: clientId,
            redirect_uri: redirect,
            response_type: "code",
            scope: SCOPES.join(" "),
            access_type: "offline",
            prompt: "consent",
            code_challenge: base64url(crypto.createHash("sha256").update(verifier).digest()),
            code_challenge_method: "S256",
            state,
          })}`;
          if (STAND_IN) void fetch(url).catch(reject);
          else void shell.openExternal(url);
        });
        const tokens = await tokenRequest({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, grant_type: "authorization_code", code_verifier: verifier });
        if (!tokens.refresh_token) throw new Error("O Google não devolveu a permissão permanente. Tente conectar de novo.");
        saveSecrets({ refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiresAt: Date.now() + tokens.expires_in * 1000, channel: null });
        const channel = await myChannel(true);
        saveSecrets({ channel: { id: channel.id, title: channel.title, thumb: channel.thumb } });
        return channel;
      } finally {
        server.close();
        connecting = null;
      }
    })();
    return connecting;
  }

  async function disconnect() {
    const { refreshToken } = secrets();
    if (refreshToken) await fetch(`${HOSTS.revoke}?token=${encodeURIComponent(refreshToken)}`, { method: "POST" }).catch(() => {});
    saveSecrets({ refreshToken: null, accessToken: null, expiresAt: 0, channel: null });
    // What was read belongs to the channel that just left.
    cached("mine", 0);
    for (const key of Object.keys(cache)) if (!key.startsWith("search:")) delete cache[key];
    fs.writeFile(cacheFile, JSON.stringify(cache), () => {});
  }

  // --- Reading -----------------------------------------------------------------------------------------
  /** One read of the Data API. Public data uses the API key when there is one; "mine" always uses the sign-in. */
  async function get(resource, params, { mine = false, cost = 1, kind = "units", host = `${HOSTS.api}/youtube/v3/` } = {}) {
    room(kind, cost);
    const s = secrets();
    const headers = {};
    const query = new URLSearchParams(params);
    if (!mine && s.apiKey) query.set("key", s.apiKey);
    else headers.Authorization = `Bearer ${await accessToken()}`;
    const res = await fetch(`${host}${resource}?${query}`, { headers });
    if (!res.ok) throw await failure(res);
    spend(kind, cost);
    return res.json();
  }

  const number = (value) => (value == null ? null : Number(value));
  const videoRow = (v) => ({
    id: v.id,
    url: `https://www.youtube.com/watch?v=${v.id}`,
    title: v.snippet?.title ?? "",
    description: (v.snippet?.description ?? "").slice(0, 600),
    channelId: v.snippet?.channelId ?? null,
    channel: v.snippet?.channelTitle ?? "",
    published: v.snippet?.publishedAt ?? null,
    tags: (v.snippet?.tags ?? []).slice(0, 20),
    thumb: v.snippet?.thumbnails?.medium?.url ?? v.snippet?.thumbnails?.default?.url ?? null,
    language: v.snippet?.defaultAudioLanguage ?? v.snippet?.defaultLanguage ?? null,
    duration: isoSeconds(v.contentDetails?.duration),
    views: number(v.statistics?.viewCount),
    likes: number(v.statistics?.likeCount),
    comments: number(v.statistics?.commentCount),
    privacy: v.status?.privacyStatus ?? null,
    publishAt: v.status?.publishAt ?? null,
  });

  async function videos(ids, { mine = false } = {}) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const page = await get("videos", { part: mine ? "snippet,statistics,contentDetails,status" : "snippet,statistics,contentDetails", id: ids.slice(i, i + 50).join(","), maxResults: "50" }, { mine });
      out.push(...(page.items ?? []).map(videoRow));
    }
    return out;
  }

  async function channels(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const page = await get("channels", { part: "snippet,statistics", id: ids.slice(i, i + 50).join(","), maxResults: "50" });
      out.push(...(page.items ?? []).map((c) => ({ id: c.id, title: c.snippet?.title ?? "", subscribers: c.statistics?.hiddenSubscriberCount ? null : number(c.statistics?.subscriberCount), videos: number(c.statistics?.videoCount) })));
    }
    return out;
  }

  /** Videos about a subject, with their numbers and their channels' size. One search is one of the 100 a day. */
  async function search({ query, order = "relevance", publishedAfter = null, language = "pt", region = "BR", max = 25, short = false }) {
    const key = `search:${JSON.stringify([query, order, publishedAfter?.slice(0, 10) ?? null, language, region, max, short])}`;
    const hit = cached(key, DAY);
    if (hit) return hit;
    const found = await get(
      "search",
      { part: "snippet", type: "video", q: query, order, maxResults: String(max), relevanceLanguage: language, regionCode: region, ...(short ? { videoDuration: "short" } : {}), ...(publishedAfter ? { publishedAfter } : {}) },
      { kind: "searches" },
    );
    const ids = (found.items ?? []).map((i) => i.id?.videoId).filter(Boolean);
    const rows = ids.length ? await videos(ids) : [];
    const owners = rows.length ? await channels([...new Set(rows.map((r) => r.channelId).filter(Boolean))]) : [];
    const result = rows.map((r) => ({ ...r, subscribers: owners.find((o) => o.id === r.channelId)?.subscribers ?? null }));
    remember(key, result);
    return result;
  }

  async function myChannel(fresh = false) {
    const hit = fresh ? undefined : cached("mine", 3600_000);
    if (hit) return hit;
    const page = await get("channels", { part: "snippet,statistics,contentDetails", mine: "true" }, { mine: true });
    const c = page.items?.[0];
    if (!c) throw new YouTubeError(REASONS.youtubeSignupRequired, { reason: "youtubeSignupRequired", status: 404 });
    const channel = {
      id: c.id,
      title: c.snippet?.title ?? "",
      thumb: c.snippet?.thumbnails?.default?.url ?? null,
      subscribers: c.statistics?.hiddenSubscriberCount ? null : number(c.statistics?.subscriberCount),
      views: number(c.statistics?.viewCount),
      videos: number(c.statistics?.videoCount),
      uploads: c.contentDetails?.relatedPlaylists?.uploads ?? null,
    };
    remember("mine", channel);
    return channel;
  }

  /** The channel's latest uploads with their numbers (2 or 3 units, kept for an hour). */
  async function myUploads(max = 50) {
    const hit = cached(`uploads:${max}`, 3600_000);
    if (hit) return hit;
    const channel = await myChannel();
    if (!channel.uploads) return [];
    const page = await get("playlistItems", { part: "contentDetails", playlistId: channel.uploads, maxResults: String(Math.min(50, max)) }, { mine: true });
    const ids = (page.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean);
    const rows = ids.length ? await videos(ids, { mine: true }) : [];
    remember(`uploads:${max}`, rows);
    return rows;
  }

  /** Day by day for the last `days` days. The Analytics API has no hour of day and no "audience online". */
  async function analytics(days = 28) {
    const hit = cached(`analytics:${days}`, 3600_000);
    if (hit) return hit;
    const day = (offset) => new Date(Date.now() - offset * DAY).toISOString().slice(0, 10);
    const report = await get(
      "reports",
      { ids: "channel==MINE", startDate: day(days), endDate: day(1), metrics: "views,estimatedMinutesWatched,averageViewDuration,subscribersGained,subscribersLost,likes,comments", dimensions: "day", sort: "day" },
      { mine: true, cost: 0, host: `${HOSTS.analytics}/v2/` },
    );
    const names = (report.columnHeaders ?? []).map((h) => h.name);
    const rows = (report.rows ?? []).map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
    remember(`analytics:${days}`, rows);
    return rows;
  }

  // --- Uploading -----------------------------------------------------------------------------------------
  const pause = (ms, signal) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("Interrompido."))), { once: true });
    });

  /**
   * Sends the file in pieces, so a dropped connection continues from where it stopped instead of starting over.
   * `session` (kept by the caller through `onSession`) continues an upload begun before, even after a restart.
   * Callers must have checked the creator's approval before calling this: see publish.cjs.
   */
  async function upload({ file, snippet, status, session = null, onSession = () => {}, onProgress = () => {}, signal }) {
    const total = fs.statSync(file).size;
    let offset = 0;
    /** Ask YouTube how much it already has. Returns the finished video when it has everything. */
    const where = async () => {
      const res = await fetch(session, { method: "PUT", headers: { "Content-Range": `bytes */${total}` }, signal });
      if (res.status === 308) {
        const range = /bytes=0-(\d+)/.exec(res.headers.get("range") ?? "");
        offset = range ? Number(range[1]) + 1 : 0;
        return null;
      }
      if (res.ok) return res.json();
      if (res.status === 404 || res.status === 410) {
        session = null;
        offset = 0;
        return null;
      }
      throw await failure(res);
    };
    if (session) {
      const done = await where().catch((err) => {
        if (signal?.aborted) throw err;
        session = null;
        return null;
      });
      if (done) return videoRow(done);
    }
    if (!session) {
      room("uploads");
      const res = await fetch(`${HOSTS.api}/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status&notifySubscribers=true`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json; charset=UTF-8", "X-Upload-Content-Length": String(total), "X-Upload-Content-Type": "video/mp4" },
        body: JSON.stringify({ snippet, status }),
        signal,
      });
      if (!res.ok) throw await failure(res);
      spend("uploads");
      session = res.headers.get("location");
      if (!session) throw new YouTubeError("O YouTube não abriu o envio.");
      offset = 0;
      onSession(session);
    }
    const handle = fs.openSync(file, "r");
    try {
      let failures = 0;
      while (true) {
        if (signal?.aborted) throw new Error("Interrompido.");
        const size = Math.min(CHUNK, total - offset);
        const chunk = Buffer.alloc(size);
        fs.readSync(handle, chunk, 0, size, offset);
        try {
          const res = await fetch(session, { method: "PUT", headers: { "Content-Range": `bytes ${offset}-${offset + size - 1}/${total}`, "Content-Type": "video/mp4" }, body: chunk, signal });
          if (res.status === 308) {
            const range = /bytes=0-(\d+)/.exec(res.headers.get("range") ?? "");
            offset = range ? Number(range[1]) + 1 : offset + size;
          } else if (res.ok) {
            onProgress(1);
            return videoRow(await res.json());
          } else {
            const err = await failure(res);
            if (!err.temporary) throw err;
            throw Object.assign(err, { retry: true });
          }
          failures = 0;
          onProgress(offset / total);
        } catch (err) {
          if (signal?.aborted) throw new Error("Interrompido.");
          if (err instanceof YouTubeError && !err.retry) throw err;
          if (++failures > 8) throw new YouTubeError(`O envio caiu várias vezes seguidas (${err.message}).`, { status: 0 });
          await pause(Math.min(60_000, 1500 * 2 ** failures), signal);
          const done = await where().catch(() => null);
          if (done) return videoRow(done);
          if (!session) throw new YouTubeError("O YouTube encerrou este envio. Começo de novo na próxima tentativa.", { status: 0 });
        }
      }
    } finally {
      fs.closeSync(handle);
    }
  }

  /** Custom thumbnails need a channel with a verified phone number; YouTube answers 403 otherwise. */
  async function setThumbnail(videoId, file) {
    room("units", 50);
    const res = await fetch(`${HOSTS.api}/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": /\.png$/i.test(file) ? "image/png" : "image/jpeg" },
      body: fs.readFileSync(file),
    });
    if (!res.ok) throw await failure(res);
    spend("units", 50);
  }

  return {
    /** What the panel may know: never the keys themselves. */
    status() {
      const s = secrets();
      // The client ID is not a secret (it travels in every sign-in link): its ending lets the creator check it.
      return { apiKey: Boolean(s.apiKey), client: Boolean(s.clientId && s.clientSecret), clientId: Boolean(s.clientId), clientSecret: Boolean(s.clientSecret), clientEnd: s.clientId ? s.clientId.split(".")[0].slice(-6) : null, connected: Boolean(s.refreshToken), channel: s.channel ?? null, quota: { ...quota(), limits: QUOTA }, encrypted: safeStorage.isEncryptionAvailable() };
    },
    /**
     * Keys pasted in the wrong box are the usual reason the connection fails: their shapes are checked here.
     * Returns where each one went, so the panel can say what was saved.
     */
    setKeys({ apiKey, clientId, clientSecret }) {
      const patch = {};
      const clean = (v) => String(v ?? "").replace(/\s+/g, "");
      let id = typeof clientId === "string" ? clean(clientId) : null;
      let secret = typeof clientSecret === "string" ? clean(clientSecret) : null;
      const isId = (v) => /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/i.test(v);
      // Swapped boxes are put right.
      if (id && secret && !isId(id) && isId(secret)) [id, secret] = [secret, id];
      if (id && !isId(id)) throw new Error("O ID do cliente não parece certo: ele tem um número, um traço e termina em .apps.googleusercontent.com. Confira se não colou a chave secreta no lugar dele.");
      if (secret && isId(secret)) throw new Error("No campo da chave secreta foi colado o ID do cliente. A chave secreta costuma começar com GOCSPX-.");
      if (typeof apiKey === "string") {
        const key = clean(apiKey);
        if (key && (isId(key) || /^GOCSPX-/i.test(key))) throw new Error("No campo da chave de API foi colado o ID ou a chave secreta do cliente. A chave de API costuma começar com AIza.");
        patch.apiKey = key || null;
      }
      if (id !== null) patch.clientId = id || null;
      if (secret !== null) patch.clientSecret = secret || null;
      // New client keys: the old permission belonged to the old client.
      if (patch.clientId || patch.clientSecret) Object.assign(patch, { refreshToken: null, accessToken: null, expiresAt: 0 });
      saveSecrets(patch);
      return { apiKey: Boolean(patch.apiKey), clientId: Boolean(patch.clientId), clientSecret: Boolean(patch.clientSecret) };
    },
    canRead: () => Boolean(secrets().apiKey || secrets().refreshToken),
    connected: () => Boolean(secrets().refreshToken),
    connect,
    disconnect,
    search,
    videos,
    myChannel,
    myUploads,
    analytics,
    upload,
    setThumbnail,
    quota,
  };
}

module.exports = { createYouTube, YouTubeError, SCOPES };
