// A stand-in for Google's servers, for tests only. It answers the few calls the studio makes and records
// what it was sent, so a test can prove what would have gone to YouTube without touching a real channel.
import http from "node:http";

const DAY = 24 * 3600_000;
const iso = (daysAgo, hour = 18) => {
  const d = new Date(Date.now() - daysAgo * DAY);
  d.setUTCHours(hour + 3, 0, 0, 0); // hour in Brasília
  return d.toISOString();
};

const CHANNELS = [
  { id: "UCmine", title: "Canal de Teste", subs: 12400, views: 1_830_000, videos: 96 },
  { id: "UCa", title: "Sobrevive Aí", subs: 48000, views: 9_000_000, videos: 210 },
  { id: "UCb", title: "Base Automática", subs: 310000, views: 60_000_000, videos: 540 },
  { id: "UCc", title: "Jogando Errado", subs: 5200, views: 400_000, videos: 44 },
];
const video = (id, title, channel, daysAgo, hour, views, likes, comments, minutes, extra = {}) => ({
  id,
  snippet: { title, description: `Descrição de ${title}`, channelId: channel.id, channelTitle: channel.title, publishedAt: iso(daysAgo, hour), tags: ["sobrevivência", "iniciante", "dicas"], thumbnails: { medium: { url: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` } }, defaultAudioLanguage: "pt-BR" },
  statistics: { viewCount: String(views), likeCount: String(likes), commentCount: String(comments) },
  contentDetails: { duration: `PT${minutes}M10S` },
  status: { privacyStatus: "public", ...extra },
});
const [MINE, A, B, C] = CHANNELS;
const VIDEOS = [
  video("ref00000001", "7 erros de iniciante que acabam com a sua base", A, 40, 18, 310000, 21000, 1400, 11),
  video("ref00000002", "Eu joguei 100 dias errado (não faça isso)", C, 25, 19, 96000, 8800, 900, 14),
  video("ref00000003", "Guia completo de sobrevivência para iniciantes", B, 200, 12, 420000, 15000, 600, 22),
  video("ref00000004", "O erro que todo iniciante comete na primeira noite", C, 12, 18, 61000, 5900, 720, 9),
  video("ref00000005", "Parei de morrer depois de aprender isso", A, 90, 20, 150000, 9000, 500, 10),
  video("ref00000006", "5 dicas que eu queria saber antes de começar", B, 300, 17, 380000, 12000, 450, 13),
  video("mine0000001", "Minha base automática ficou absurda", MINE, 3, 18, 8200, 700, 64, 12),
  video("mine0000002", "Testei a pior estratégia do jogo", MINE, 10, 19, 15400, 1300, 110, 15),
  video("mine0000003", "Começando do zero no modo difícil", MINE, 17, 12, 4100, 300, 25, 18),
  video("mine0000004", "O farm que ninguém usa", MINE, 24, 18, 22800, 1900, 170, 11),
  video("mine0000005", "Erros que eu cometi em 500 horas", MINE, 31, 20, 9700, 800, 71, 14),
];

export async function startMock({ failFirstChunk = true } = {}) {
  const seen = { calls: [], auth: 0, tokens: [], uploads: [], thumbnails: [], dropped: 0, noAuth: [] };
  const sessions = new Map();
  let base = "";
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, base);
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const json = (status, data, headers = {}) => (res.writeHead(status, { "Content-Type": "application/json", ...headers }), res.end(JSON.stringify(data)));
    const p = url.pathname;
    const q = url.searchParams;
    seen.calls.push(`${req.method} ${p}`);
    const signedIn = req.headers.authorization === "Bearer acesso-de-teste";

    if (p === "/auth") {
      seen.auth += 1;
      seen.scope = q.get("scope");
      seen.pkce = q.get("code_challenge_method");
      res.writeHead(302, { Location: `${q.get("redirect_uri")}?code=codigo-de-teste&state=${encodeURIComponent(q.get("state"))}` });
      return res.end();
    }
    if (p === "/token") {
      const form = new URLSearchParams(body.toString());
      seen.tokens.push(form.get("grant_type"));
      return json(200, { access_token: "acesso-de-teste", expires_in: 3600, ...(form.get("grant_type") === "authorization_code" ? { refresh_token: "permanente-de-teste" } : {}) });
    }
    if (p === "/revoke") return json(200, {});

    if (p === "/youtube/v3/channels") {
      if (q.get("mine")) {
        if (!signedIn) return json(401, { error: { errors: [{ reason: "authError" }] } });
        return json(200, { items: [{ id: MINE.id, snippet: { title: MINE.title, thumbnails: {} }, statistics: { subscriberCount: String(MINE.subs), viewCount: String(MINE.views), videoCount: String(MINE.videos) }, contentDetails: { relatedPlaylists: { uploads: "UUmine" } } }] });
      }
      const ids = q.get("id").split(",");
      return json(200, { items: CHANNELS.filter((c) => ids.includes(c.id)).map((c) => ({ id: c.id, snippet: { title: c.title }, statistics: { subscriberCount: String(c.subs), videoCount: String(c.videos) } })) });
    }
    if (p === "/youtube/v3/search") {
      seen.searchKey = q.get("key");
      seen.searches = (seen.searches ?? 0) + 1;
      return json(200, { items: VIDEOS.filter((v) => v.id.startsWith("ref")).map((v) => ({ id: { videoId: v.id } })) });
    }
    if (p === "/youtube/v3/videos") {
      const ids = q.get("id").split(",");
      return json(200, { items: [...VIDEOS, ...seen.uploads.filter((u) => u.done).map((u) => u.resource)].filter((v) => ids.includes(v.id)) });
    }
    if (p === "/youtube/v3/playlistItems") return json(200, { items: VIDEOS.filter((v) => v.id.startsWith("mine")).map((v) => ({ contentDetails: { videoId: v.id } })) });
    if (p === "/v2/reports") {
      const rows = Array.from({ length: 28 }, (_, i) => {
        const day = new Date(Date.now() - (28 - i) * DAY).toISOString().slice(0, 10);
        const views = 900 + Math.round(600 * Math.sin(i / 2) ** 2) + i * 20;
        return [day, views, views * 4, 240, 12 + (i % 5), 2, Math.round(views / 12), Math.round(views / 90)];
      });
      return json(200, { columnHeaders: ["day", "views", "estimatedMinutesWatched", "averageViewDuration", "subscribersGained", "subscribersLost", "likes", "comments"].map((name) => ({ name })), rows });
    }

    if (p === "/upload/youtube/v3/videos" && req.method === "POST") {
      if (!signedIn) {
        seen.noAuth.push(p);
        return json(401, { error: { errors: [{ reason: "authError" }] } });
      }
      const id = `sess${sessions.size + 1}`;
      const upload = { meta: JSON.parse(body.toString()), total: Number(req.headers["x-upload-content-length"]), received: 0, done: false, puts: 0 };
      sessions.set(id, upload);
      seen.uploads.push(upload);
      res.writeHead(200, { Location: `${base}/session/${id}` });
      return res.end();
    }
    if (p.startsWith("/session/") && req.method === "PUT") {
      const upload = sessions.get(p.split("/")[2]);
      if (!upload) return json(404, {});
      const range = /bytes (\*|(\d+)-(\d+))\/(\d+)/.exec(req.headers["content-range"] ?? "");
      if (range && range[1] !== "*") {
        upload.puts += 1;
        // One dropped piece, to prove the upload picks up where it stopped instead of failing.
        if (failFirstChunk && upload.puts === 1) {
          seen.dropped += 1;
          return json(503, { error: { errors: [{ reason: "backendError" }] } });
        }
        if (Number(range[2]) !== upload.received) return json(400, { error: { errors: [{ reason: "badRange" }] } });
        upload.received += body.length;
      }
      if (upload.received >= upload.total) {
        upload.done = true;
        upload.resource = { id: `enviado${seen.uploads.indexOf(upload) + 1}`, snippet: { ...upload.meta.snippet, channelId: MINE.id, channelTitle: MINE.title, publishedAt: new Date().toISOString() }, statistics: { viewCount: "0" }, contentDetails: { duration: "PT2M" }, status: upload.meta.status };
        return json(200, upload.resource);
      }
      res.writeHead(308, upload.received ? { Range: `bytes=0-${upload.received - 1}` } : {});
      return res.end();
    }
    if (p === "/upload/youtube/v3/thumbnails/set") {
      seen.thumbnails.push({ videoId: q.get("videoId"), bytes: body.length, type: req.headers["content-type"] });
      return json(200, {});
    }
    json(404, { error: { errors: [{ reason: "notFound" }] } });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  return {
    seen,
    env: { CENA_YT_API: base, CENA_YT_AUTH: `${base}/auth`, CENA_YT_TOKEN: `${base}/token`, CENA_YT_REVOKE: `${base}/revoke`, CENA_YT_ANALYTICS: base },
    close: () => server.close(),
  };
}
