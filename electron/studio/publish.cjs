/**
 * Publishing agent. Plain code, no AI: it sends to YouTube exactly what the creator approved, when they asked.
 *
 * The rule that never changes: nothing is published without the creator's approval in the panel.
 * `approvals.verify` runs immediately before every upload attempt (the first, each retry, and after a restart).
 * It checks that the video is approved and that the file, title, description, tags, thumbnail and schedule are
 * byte for byte what was on screen at the click. If anything differs, this refuses and says why.
 */
const fs = require("node:fs");

const MINUTE = 60_000;
const DAY = 24 * 3600_000;
const WEEKDAYS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
/** Waits between attempts after a temporary failure (network down, YouTube busy). */
const BACKOFF = [1, 5, 15, 60, 180, 360].map((m) => m * MINUTE);

/** The next midnight in California, when the API quota comes back, plus a small margin. */
function quotaReset() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" }).formatToParts(new Date()).map((p) => [p.type, Number(p.value)]));
  return Date.now() + (24 * 3600 - (parts.hour * 3600 + parts.minute * 60 + parts.second)) * 1000 + 5 * MINUTE;
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();

function createPublisher({ db, approvals, youtube, running, settings, changed, notify }) {
  let active = null;
  let disposed = false;

  const log = (videoId, level, message) => db.log({ videoId, agent: "publish", level, message });
  const setPublish = (videoId, patch) => {
    const video = db.video(videoId);
    if (video) db.updateVideo(videoId, { data: { publish: patch === null ? null : { ...(video.data.publish ?? {}), ...patch } } });
    changed();
  };

  // An upload cut by closing the app goes back to the line; it continues from where it stopped.
  for (const video of db.videos()) if (video.data.publish?.status === "uploading") db.updateVideo(video.id, { data: { publish: { ...video.data.publish, status: "queued" } } });

  async function send(videoId) {
    const key = `publish:${videoId}`;
    const controller = new AbortController();
    active = videoId;
    running.set(key, { agent: "publish", videoId, controller, resource: "upload" });
    const before = db.video(videoId)?.data.publish ?? {};
    setPublish(videoId, { status: "uploading", progress: before.progress ?? 0, error: null, nextTry: null });
    try {
      // --- The gate. Nothing below this line runs for a video the creator did not approve exactly as it is. ---
      const { video, approval } = await approvals.verify(videoId);
      if (video.data.youtube?.id) throw Object.assign(new Error("Este vídeo já foi enviado ao YouTube."), { final: true });
      const meta = video.data.metadata ?? {};
      const schedule = video.data.schedule ?? {};
      const cfg = settings().publish;
      const later = schedule.at && schedule.at > Date.now() + 10 * MINUTE;
      if (schedule.at && !later) log(videoId, "warn", "O horário agendado já passou: o vídeo é publicado assim que o envio terminar.");
      const privacy = later ? "private" : schedule.privacy ?? cfg.privacy;
      const status = { privacyStatus: privacy, selfDeclaredMadeForKids: false, ...(later ? { publishAt: new Date(schedule.at).toISOString() } : {}) };
      const snippet = { title: meta.title || video.title, description: meta.description ?? "", tags: meta.tags ?? [], categoryId: String(meta.category ?? 22), defaultLanguage: meta.language ?? "pt-BR", defaultAudioLanguage: meta.language ?? "pt-BR" };
      // A half-sent upload is only continued for the same approval; a new approval always starts a new upload.
      const session = before.session && before.approvalId === approval.id ? before.session : null;
      log(videoId, "info", `${session ? "Continuando" : "Iniciando"} o envio de "${snippet.title}" (${Math.round(fs.statSync(video.data.finalPath).size / 1048576)} MB), ${later ? `agendado para ${new Date(schedule.at).toLocaleString("pt-BR")}` : privacy === "public" ? "público assim que terminar" : privacy === "unlisted" ? "não listado" : "privado"}.`);
      let lastWrite = 0;
      const sent = await youtube.upload({
        file: video.data.finalPath,
        snippet,
        status,
        session,
        signal: controller.signal,
        onSession: (url) => setPublish(videoId, { session: url, approvalId: approval.id }),
        onProgress: (fraction) => {
          if (Date.now() - lastWrite < 1000 && fraction < 1) return;
          lastWrite = Date.now();
          setPublish(videoId, { progress: fraction });
        },
      });
      const result = { id: sent.id, url: `https://youtu.be/${sent.id}`, studio: `https://studio.youtube.com/video/${sent.id}/edit`, uploadedAt: Date.now(), privacy, publishAt: later ? schedule.at : null, title: snippet.title, thumbnail: null };
      db.updateVideo(videoId, { data: { youtube: result } });
      if (video.data.thumbnail && fs.existsSync(video.data.thumbnail)) {
        try {
          await youtube.setThumbnail(sent.id, video.data.thumbnail);
          result.thumbnail = true;
        } catch (err) {
          result.thumbnail = err.message;
          log(videoId, "warn", `O vídeo foi enviado, mas a thumbnail não (${err.message}). Canais sem telefone verificado não podem usar thumbnail própria; envie-a pelo YouTube Studio.`);
        }
        db.updateVideo(videoId, { data: { youtube: result } });
      }
      setPublish(videoId, { status: "done", progress: 1, session: null, error: null, attempts: 0 });
      log(videoId, "decision", `Enviado ao YouTube: ${result.url}. ${later ? `Fica privado até ${new Date(schedule.at).toLocaleString("pt-BR")}, quando o próprio YouTube publica.` : privacy === "public" ? "Já está público." : `Está como ${privacy === "unlisted" ? "não listado" : "privado"}.`}`);
      notify(later ? "Vídeo agendado no YouTube" : "Vídeo enviado ao YouTube", snippet.title);
    } catch (err) {
      const stopped = controller.signal.aborted;
      const attempts = (before.attempts ?? 0) + 1;
      if (stopped) setPublish(videoId, { status: disposed ? "queued" : "stopped", error: null });
      else if (err.quota) {
        setPublish(videoId, { status: "waiting", error: err.message, nextTry: quotaReset() });
        log(videoId, "warn", `${err.message} O envio continua sozinho quando a cota voltar.`);
      } else if (err.temporary && attempts <= BACKOFF.length) {
        setPublish(videoId, { status: "waiting", error: err.message, attempts, nextTry: Date.now() + BACKOFF[attempts - 1] });
        log(videoId, "warn", `Envio interrompido (${err.message}). Tento de novo em ${Math.round(BACKOFF[attempts - 1] / MINUTE)} min, continuando de onde parou.`);
      } else {
        setPublish(videoId, { status: "error", error: err.message, attempts: 0 });
        log(videoId, "error", `Não enviado: ${err.message}`);
        notify("O envio ao YouTube falhou", err.message);
      }
    } finally {
      running.delete(key);
      active = null;
      changed();
      setTimeout(pump, 500);
    }
  }

  /** One upload at a time: they share the connection, and the order of the line is the order of the clicks. */
  function pump() {
    if (disposed || active !== null) return;
    const cfg = settings();
    if (cfg.paused || cfg.agentsPaused.publish) return;
    const next = db
      .videos()
      .filter((v) => v.data.publish?.status === "queued" || (v.data.publish?.status === "waiting" && (v.data.publish.nextTry ?? 0) <= Date.now()))
      .sort((a, b) => (a.data.publish.requestedAt ?? 0) - (b.data.publish.requestedAt ?? 0))[0];
    if (next) void send(next.id);
  }
  const timer = setInterval(pump, MINUTE);

  /** The creator's click on "Enviar ao YouTube". The approval is checked here and again right before the upload. */
  async function request(videoId) {
    if (!youtube.connected()) throw new Error("Conecte o canal do YouTube nas Configurações antes de enviar.");
    const { video } = await approvals.verify(videoId);
    if (video.data.youtube?.id) throw new Error("Este vídeo já foi enviado ao YouTube.");
    if (["queued", "uploading", "waiting"].includes(video.data.publish?.status)) return;
    setPublish(videoId, { status: "queued", progress: 0, error: null, attempts: 0, nextTry: null, requestedAt: Date.now() });
    log(videoId, "info", "Entrou na fila de envio ao YouTube.");
    pump();
  }

  function cancel(videoId) {
    for (const [key, entry] of running) if (key === `publish:${videoId}`) entry.controller.abort();
    const video = db.video(videoId);
    if (video?.data.publish && video.data.publish.status !== "done" && active !== videoId) setPublish(videoId, { status: "stopped", error: null });
  }

  // --- When to publish ----------------------------------------------------------------------------
  /**
   * YouTube's API does not say when the audience is online (its analytics go no finer than a day).
   * So the studio looks at what it can measure: how the channel's own videos did by the weekday and hour they
   * went out, then when the well-performing reference videos from the research went out, then a general default.
   */
  async function bestTimes() {
    const days = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
    const hours = Array.from({ length: 24 }, () => ({ sum: 0, n: 0 }));
    let basis = "padrão";
    let detail = "Ainda sem dados do canal: uso 18h, um horário comum para quem assiste depois do trabalho ou da escola. Melhora sozinho conforme o canal publica.";
    let counted = 0;
    if (youtube.connected()) {
      try {
        const rows = (await youtube.myUploads(50)).filter((v) => v.views != null && v.published && v.privacy !== "private" && Date.now() - new Date(v.published).getTime() > 3 * DAY && v.duration > 62);
        const perDay = rows.map((v) => v.views / Math.max(1, (Date.now() - new Date(v.published).getTime()) / DAY)).sort((a, b) => a - b);
        const median = perDay[Math.floor(perDay.length / 2)] || 1;
        for (const v of rows) {
          const when = new Date(v.published);
          // How this video did against the channel's usual, capped so one hit does not decide everything.
          const relative = Math.min(4, v.views / Math.max(1, (Date.now() - when.getTime()) / DAY) / median);
          days[when.getDay()].sum += relative;
          days[when.getDay()].n += 1;
          hours[when.getHours()].sum += relative;
          hours[when.getHours()].n += 1;
        }
        counted = rows.length;
      } catch {
        // No channel data right now: the next source is used.
      }
    }
    if (counted >= 8) {
      basis = "canal";
      detail = `Calculado pelo desempenho dos últimos ${counted} vídeos do canal, por dia da semana e hora em que saíram.`;
    } else {
      const timing = db.scripts().map((s) => s.research?.timing).filter(Boolean);
      const total = timing.reduce((n, t) => n + t.days.reduce((a, b) => a + b, 0), 0);
      if (total >= 10) {
        for (const d of days) Object.assign(d, { sum: 0, n: 0 });
        for (const h of hours) Object.assign(h, { sum: 0, n: 0 });
        // Counted as "videos that did well went out here": more of them is a better sign.
        for (const t of timing) {
          t.days.forEach((count, i) => ((days[i].sum += count * 1.6), (days[i].n += count)));
          t.hours.forEach((count, i) => ((hours[i].sum += count * 1.6), (hours[i].n += count)));
        }
        basis = "referências";
        detail = `O canal ainda tem poucos vídeos para medir. Usei quando saíram ${total} vídeos de referência que foram bem nas suas pesquisas.`;
      }
    }
    // Few samples pull towards "average" (1), so a single lucky video does not crown a slot.
    const score = (bucket) => (bucket.sum + 2) / (bucket.n + 2);
    const dayScores = days.map(score);
    const hourScores = hours.map((h, i) => (basis === "padrão" ? (i === 18 ? 1.2 : 0) : h.n ? score(h) : 0));
    const bestHours = hourScores.map((s, hour) => ({ hour, s })).filter((h) => h.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
    return { basis, detail, dayScores, bestHours, bestDays: dayScores.map((s, day) => ({ day, name: WEEKDAYS[day], s })).sort((a, b) => b.s - a.s) };
  }

  /** The best free moment in the next two weeks: a good slot soon beats a perfect one far away. */
  async function suggest(videoId) {
    const times = await bestTimes();
    const taken = db.videos().filter((v) => v.id !== videoId && v.data.schedule?.at && v.status !== "rejected").map((v) => v.data.schedule.at);
    let best = null;
    for (let ahead = 0; ahead < 14; ahead++) {
      for (const { hour, s } of times.bestHours) {
        const at = new Date();
        at.setDate(at.getDate() + ahead);
        at.setHours(hour, 0, 0, 0);
        if (at.getTime() < Date.now() + 2 * 3600_000 || taken.some((t) => sameDay(t, at))) continue;
        const value = times.dayScores[at.getDay()] * s * (1 - 0.035 * ahead);
        if (!best || value > best.value) best = { at: at.getTime(), value };
      }
    }
    return { at: best?.at ?? null, basis: times.basis, detail: times.detail, bestDays: times.bestDays.slice(0, 3).map((d) => d.name), bestHours: times.bestHours.map((h) => h.hour) };
  }

  /** Numbers for the "Canal" tab. Read at most once an hour (the YouTube client keeps them). */
  async function overview() {
    if (!youtube.connected()) return { connected: false };
    const [channel, uploads, days, times] = await Promise.all([youtube.myChannel(), youtube.myUploads(50), youtube.analytics(28).catch((err) => ({ error: err.message })), bestTimes()]);
    const mine = new Map(db.videos().filter((v) => v.data.youtube?.id).map((v) => [v.data.youtube.id, v.id]));
    return {
      connected: true,
      channel,
      days: Array.isArray(days) ? days : [],
      analyticsError: Array.isArray(days) ? null : days.error,
      uploads: uploads.map((v) => ({ ...v, studioVideo: mine.get(v.id) ?? null, viewsPerDay: v.views == null || !v.published ? null : Math.round((v.views / Math.max(1, (Date.now() - new Date(v.published).getTime()) / DAY)) * 10) / 10 })),
      times: { basis: times.basis, detail: times.detail, bestDays: times.bestDays.map((d) => ({ name: d.name, score: Math.round(d.s * 100) / 100 })), bestHours: times.bestHours.map((h) => h.hour) },
      quota: youtube.status().quota,
    };
  }

  return {
    request,
    cancel,
    pump,
    suggest,
    overview,
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}

module.exports = { createPublisher };
