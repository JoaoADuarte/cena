import { useEffect, useMemo, useState } from "react";
import type { RecentProject, RecoverableProject } from "../api";
import { recoverProject } from "../autosave";
import { useEditor } from "../store";
import { projectDuration } from "../model/project";
import { Icon } from "./controls";

const ago = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

function relative(ms: number): string {
  const diff = (ms - Date.now()) / 1000;
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
    ["year", Infinity],
  ];
  let value = diff;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return unit === "second" ? "agora há pouco" : ago.format(Math.round(value), unit);
    value /= size;
  }
  return "";
}

const clock = (seconds: number) => {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
};

const format = (p: { width: number | null; height: number | null }) => {
  if (!p.width || !p.height) return null;
  if (p.width === p.height) return "Quadrado";
  return p.height > p.width ? "Vertical" : "Horizontal";
};

interface Props {
  /** Leave the start screen for the editor. */
  onEnter(): void;
  onOpenFile(): Promise<boolean>;
  onOpenPath(path: string): Promise<boolean>;
}

/** Start screen: create a project, keep editing the current one, or pick one made before. */
export function Home({ onEnter, onOpenFile, onOpenPath }: Props) {
  const [items, setItems] = useState<RecentProject[] | null>(null);
  const [recoverable, setRecoverable] = useState<RecoverableProject[]>([]);
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The card whose name is being typed, and the text so far. */
  const [renaming, setRenaming] = useState<{ path: string; name: string } | null>(null);
  const project = useEditor((s) => s.project);
  const projectPath = useEditor((s) => s.projectPath);
  const dirty = useEditor((s) => s.dirty);
  const hasCurrent = dirty || projectPath !== null || project.tracks.some((t) => t.segments.length > 0);

  const refresh = () =>
    window.api.recentProjects().then(
      (list) => setItems(list),
      () => setItems([]),
    );
  const refreshRecoverable = () =>
    window.api.autosaveList().then(
      (list) => setRecoverable(list),
      () => setRecoverable([]),
    );
  useEffect(() => {
    void refresh();
    void refreshRecoverable();
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q));
  }, [items, query]);

  const discardOk = (path?: string) => {
    const s = useEditor.getState();
    if (!s.dirty || (path && s.projectPath && path.toLowerCase() === s.projectPath.toLowerCase())) return true;
    return confirm(`Descartar as alterações não salvas de "${s.project.name}"?`);
  };

  const create = () => {
    if (!discardOk()) return;
    useEditor.getState().newProject();
    onEnter();
  };

  const open = async (p: RecentProject) => {
    setError(null);
    if (p.missing) {
      if (confirm(`Não encontrei "${p.name}" em\n${p.path}\n\nTirar da lista?`)) {
        await window.api.forgetProject(p.path);
        void refresh();
      }
      return;
    }
    const s = useEditor.getState();
    // The project already open: just go back to it, keeping unsaved changes.
    if (s.projectPath && s.projectPath.toLowerCase() === p.path.toLowerCase()) return onEnter();
    if (!discardOk()) return;
    if (await onOpenPath(p.path)) onEnter();
    else setError(`Não deu para abrir "${p.name}".`);
  };

  const rename = async () => {
    if (!renaming) return;
    const { path, name } = renaming;
    setRenaming(null);
    const before = items?.find((i) => i.path === path);
    if (!name.trim() || name.trim() === before?.name) return;
    setError(null);
    try {
      const kept = await window.api.renameProject(path, name);
      // The project open in the editor takes the new name too, so saving it later keeps it.
      const s = useEditor.getState();
      if (s.projectPath && s.projectPath.toLowerCase() === path.toLowerCase()) s.mutate((p) => void (p.name = kept), { history: false });
      setItems((list) => list?.map((i) => (i.path === path ? { ...i, name: kept } : i)) ?? list);
    } catch (e) {
      setError(`Não deu para renomear: ${(e as Error).message}`);
    }
  };

  const recover = async (r: RecoverableProject) => {
    if (!discardOk()) return;
    setError(null);
    try {
      if (await recoverProject(r.id)) onEnter();
      else setError(`A cópia de "${r.name}" está com problema.`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const discardRecovery = async (r: RecoverableProject) => {
    if (!confirm(`Apagar a cópia automática de "${r.name}"? Esse trabalho não poderá ser recuperado.`)) return;
    await window.api.autosaveDiscard(r.id);
    void refreshRecoverable();
  };

  /** Media dropped on the screen starts a new project with it on the timeline. */
  const dropMedia = async (files: FileList) => {
    const paths = [...files].map((f) => window.api.pathForFile(f)).filter(Boolean);
    if (!paths.length || !discardOk()) return;
    const s = useEditor.getState();
    s.newProject();
    onEnter();
    const materials = await s.importFiles(paths);
    let at = 0;
    for (const m of materials) {
      useEditor.getState().addMaterialToTimeline(m.id, { start: at });
      at = projectDuration(useEditor.getState().project);
    }
  };

  return (
    <div
      className={`home${dragging ? " dragging" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void dropMedia(e.dataTransfer.files);
      }}
    >
      <header className="home-top">
        <div className="brand">Cena</div>
        <div className="grow" />
        <label className="home-search">
          <Icon name="search" />
          <input value={query} placeholder="Procurar projeto" onChange={(e) => setQuery(e.target.value)} />
        </label>
      </header>

      <div className="home-body">
        {recoverable.length > 0 && (
          <section className="home-recover">
            <h2>Trabalho recuperado</h2>
            <p>O Cena fechou sem salvar (queda de luz ou travamento). Estas cópias automáticas estão guardadas:</p>
            {recoverable.map((r) => (
              <div key={r.id} className="home-recover-row">
                <div className="home-recover-info">
                  <b>{r.name}</b>
                  <small>
                    {[`cópia ${relative(r.savedAt)}`, r.clips ? `${r.clips} clipe${r.clips > 1 ? "s" : ""}` : "vazio", r.duration > 0 ? clock(r.duration) : null, r.path ?? "nunca salvo em arquivo"].filter(Boolean).join(" · ")}
                  </small>
                </div>
                <button className="primary" onClick={() => void recover(r)}>
                  Recuperar
                </button>
                <button onClick={() => void discardRecovery(r)}>Descartar</button>
              </div>
            ))}
          </section>
        )}

        <section className="home-start">
          <button className="home-create" onClick={create}>
            <span className="home-create-plus">
              <Icon name="plus" />
            </span>
            <span>
              <b>Criar projeto</b>
              <small>ou arraste vídeos, fotos e músicas para cá</small>
            </span>
          </button>
          <div className="home-side-actions">
            {hasCurrent && (
              <button className="primary" onClick={onEnter} title="Voltar ao projeto aberto, sem perder nada">
                <Icon name="film" /> Continuar “{project.name}”{dirty ? " (não salvo)" : ""}
              </button>
            )}
            <button
              onClick={async () => {
                if (!discardOk()) return;
                if (await onOpenFile()) onEnter();
              }}
            >
              <Icon name="folder" /> Abrir arquivo .cena
            </button>
          </div>
        </section>

        <div className="home-heading">
          <h2>Projetos</h2>
          {items && <span>{items.length}</span>}
        </div>
        {error && <p className="error-text">{error}</p>}

        {items === null ? (
          <p className="home-empty">Carregando…</p>
        ) : shown.length === 0 ? (
          <p className="home-empty">
            {query ? "Nenhum projeto com esse nome." : "Os projetos que você salvar ou abrir aparecem aqui. Crie um projeto para começar."}
          </p>
        ) : (
          <div className="home-grid">
            {shown.map((p) => (
              <article key={p.path} className={`home-card${p.missing ? " missing" : ""}`} onClick={() => void open(p)} title={p.path}>
                <div className="home-cover">
                  {p.cover ? <img src={p.cover} alt="" draggable={false} /> : <Icon name="film" />}
                  {p.duration > 0 && <span className="home-duration">{clock(p.duration)}</span>}
                  <div className="home-card-actions" onClick={(e) => e.stopPropagation()}>
                    {!p.missing && (
                      <button title="Renomear" onClick={() => setRenaming({ path: p.path, name: p.name })}>
                        <Icon name="edit" />
                      </button>
                    )}
                    {!p.missing && (
                      <button title="Mostrar na pasta" onClick={() => void window.api.revealProject(p.path)}>
                        <Icon name="folder" />
                      </button>
                    )}
                    <button
                      title="Tirar da lista (o arquivo continua no computador)"
                      onClick={async () => {
                        await window.api.forgetProject(p.path);
                        void refresh();
                      }}
                    >
                      <Icon name="close" />
                    </button>
                  </div>
                </div>
                <div className="home-card-info">
                  {renaming?.path === p.path ? (
                    <input
                      className="home-rename"
                      autoFocus
                      value={renaming.name}
                      maxLength={120}
                      onClick={(e) => e.stopPropagation()}
                      onFocus={(e) => e.currentTarget.select()}
                      onChange={(e) => setRenaming({ path: p.path, name: e.target.value })}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") void rename();
                        if (e.key === "Escape") setRenaming(null);
                      }}
                      onBlur={() => void rename()}
                    />
                  ) : (
                    <b
                      title="Duplo clique para renomear"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        if (!p.missing) setRenaming({ path: p.path, name: p.name });
                      }}
                    >
                      {p.name}
                    </b>
                  )}
                  <small>
                    {p.missing
                      ? "Arquivo não encontrado"
                      : [relative(p.modified ?? p.opened), format(p), p.clips ? `${p.clips} clipe${p.clips > 1 ? "s" : ""}` : "vazio"].filter(Boolean).join(" · ")}
                  </small>
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
      {dragging && <div className="home-drop">Solte para criar um projeto com estes arquivos</div>}
    </div>
  );
}
