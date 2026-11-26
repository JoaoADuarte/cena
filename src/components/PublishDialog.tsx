import { useEffect, useState } from "react";
import { useEditor, whenAllTracksReady } from "../store";
import { exportProject } from "../engine/exporter";
import { projectDuration } from "../model/project";

const message = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

type Link = { kind: "short" | "video"; parentId: number | null; shortId: number | null; rowId: number | null; title: string; body: string; schedule: number | null; sent: boolean } | null;

/** "2026-11-21T18:00" in local time, for the date field. */
function localInput(ms: number) {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Publicar: the video as it is in the editor goes to the studio ready to publish, with its title, description and
 * date, and shows up in the calendar. Nothing reaches YouTube until the creator approves it in the studio.
 */
export function PublishDialog({ onClose }: { onClose: () => void }) {
  const project = useEditor((s) => s.project);
  const projectPath = useEditor((s) => s.projectPath);
  const [link, setLink] = useState<Link>(null);
  const [title, setTitle] = useState(project.name === "Novo projeto" ? "" : project.name);
  const [body, setBody] = useState("");
  const [when, setWhen] = useState<"date" | "approve">("date");
  const [at, setAt] = useState(() => {
    const d = new Date(Date.now() + 24 * 3600_000);
    d.setHours(18, 0, 0, 0);
    return localInput(d.getTime());
  });
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const vertical = project.height > project.width;
  // Vertical projects are Shorts unless the creator says otherwise; a Short of a recording is always one.
  const [kind, setKind] = useState<"short" | "video">(vertical ? "short" : "video");
  const fromRecording = Boolean(link?.parentId);

  useEffect(() => {
    void window.api.studioAvailable().then((ok) => {
      if (!ok) return;
      void window.api.studioCall("shortForProject", projectPath).then((l: Link) => {
        setLink(l);
        if (l) {
          setKind(l.parentId ? "short" : l.kind);
          setTitle(l.title || title);
          setBody(l.body || "");
          if (l.schedule) setAt(localInput(l.schedule));
        }
      });
    });
  }, [projectPath]);

  const go = async () => {
    setError(null);
    const time = when === "date" ? new Date(at).getTime() : null;
    if (time !== null && (!Number.isFinite(time) || time < Date.now() + 15 * 60_000)) return setError("Escolha um horário pelo menos 15 minutos à frente.");
    if (!title.trim()) return setError("Escreva o título.");
    if (projectDuration(project) <= 0) return setError("A timeline está vazia.");
    try {
      if (!(await window.api.studioAvailable())) {
        await window.api.openStudio();
        throw new Error("Abri o Estúdio. Clique em Publicar de novo quando ele aparecer.");
      }
      setProgress(0);
      const file: string = await window.api.studioCall("exportTarget", title);
      useEditor.getState().setPlaying(false);
      await whenAllTracksReady();
      // GPU when it can, loudness at the YouTube level: the same as the studio's own renders.
      await exportProject(useEditor.getState().project, { outPath: file, format: "h264", quality: "recommended", gpu: true, normalize: true, pieces: true, onProgress: (d, t) => setProgress(t ? d / t : 0) });
      setProgress(1);
      await window.api.studioCall("publishFromEditor", { projectPath, file, title: title.trim(), body, at: time, kind });
      setDone(true);
    } catch (err) {
      setProgress(null);
      setError(message(err));
    }
  };

  const busy = progress !== null && !done;
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal publish-modal">
        <h2>Publicar no YouTube</h2>
        {done ? (
          <>
            <p className="modal-note">
              Pronto. {kind === "short" ? 'O Short ficou na aba Shorts, em "Editados por mim"' : "O vídeo ficou em Aguardando aprovação"}
              {when === "date" ? `, agendado para ${new Date(at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}, e aparece no Calendário` : ""}. Falta só você aprovar no Estúdio: depois da aprovação ele sobe
              {when === "date" ? " como privado e o YouTube publica na hora marcada." : " quando você clicar em Enviar ao YouTube."}
            </p>
            <div className="modal-actions">
              <button onClick={onClose}>Fechar</button>
              <span className="spacer" />
              <button className="primary" onClick={() => void window.api.openStudio(kind === "short" ? "shorts" : "review").then(onClose)}>
                Abrir o Estúdio para aprovar
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="modal-note">
              {fromRecording ? "Este é um Short do Estúdio. A versão que você editou aqui toma o lugar da versão dos agentes." : "O vídeo vai para o Estúdio exatamente como está aqui, sem nenhum agente mexer nele."}{" "}
              Primeiro ele é exportado e depois espera a sua aprovação no Estúdio.
            </p>
            {!fromRecording && (
              <div className="publish-kind">
                <label className="toggle-row">
                  <input type="radio" checked={kind === "short"} disabled={busy} onChange={() => setKind("short")} />
                  <span>Short (vertical, até 3 minutos){!vertical ? " — atenção: este projeto não está na vertical" : ""}</span>
                </label>
                <label className="toggle-row">
                  <input type="radio" checked={kind === "video"} disabled={busy} onChange={() => setKind("video")} />
                  <span>Vídeo</span>
                </label>
              </div>
            )}
            {link && !fromRecording && <p className="modal-note">Este projeto já foi mandado antes: a versão nova toma o lugar da anterior no Estúdio.</p>}
            <label className="send-field">
              <span>Título</span>
              <input value={title} maxLength={100} disabled={busy} onChange={(e) => setTitle(e.target.value)} placeholder="Ex.: Fugi da polícia logo no início do GTA 6!" />
            </label>
            <label className="send-field">
              <span>Descrição</span>
              <textarea rows={3} value={body} disabled={busy} onChange={(e) => setBody(e.target.value)} placeholder={vertical ? "A hashtag #shorts entra sozinha" : ""} />
            </label>
            <h4>Quando publicar</h4>
            <label className="toggle-row">
              <input type="radio" checked={when === "date"} disabled={busy} onChange={() => setWhen("date")} />
              <span>Agendar:</span>
              <input type="datetime-local" value={at} disabled={busy || when !== "date"} onChange={(e) => setAt(e.target.value)} />
            </label>
            <label className="toggle-row">
              <input type="radio" checked={when === "approve"} disabled={busy} onChange={() => setWhen("approve")} />
              <span>Sem data: eu envio quando aprovar</span>
            </label>
            {progress !== null && (
              <div className="publish-progress">
                <i style={{ width: `${Math.round(progress * 100)}%` }} />
                <span>{progress < 1 ? `Exportando ${Math.round(progress * 100)}%` : "Mandando para o Estúdio…"}</span>
              </div>
            )}
            {error && <p className="send-error">{error}</p>}
            <div className="modal-actions">
              <button onClick={onClose} disabled={busy}>
                Cancelar
              </button>
              <span className="spacer" />
              <button className="primary" disabled={busy} onClick={() => void go()}>
                {busy ? "Exportando…" : "Exportar e mandar para o Estúdio"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
