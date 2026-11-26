import { useEffect, useRef, useState } from "react";
import type { CapcutDraftEntry } from "../api";
import { useEditor } from "../store";
import { mediaUrl } from "../engine/mediaPool";
import { drawTransition } from "../engine/compositor";
import { DEFAULT_TRANSITION_SHAPE, EFFECT_INFO, TRANSITION_INFO } from "../engine/catalog";
import { EFFECTS, TRANSITIONS, type TransitionType } from "../model/types";
import { findSegment } from "../model/project";
import { convertCapcutDraft } from "../importers/capcut";
import { shortTime } from "../model/time";
import { Icon } from "./controls";
import { SoundsTab } from "./SoundsTab";
import { StickersTab } from "./StickersTab";
import { AdjustTab, CaptionsTab, FiltersTab, TemplatesTab } from "./MoreTabs";
import { ChatTab, useChatPrefill } from "./ChatTab";
import { GamingTab } from "./GamingTab";

type Tab = "media" | "sounds" | "text" | "stickers" | "effects" | "transitions" | "captions" | "filters" | "adjust" | "templates" | "capcut" | "gaming" | "assistant";

/** Library tabs in CapCut's order. */
const TABS: { id: Tab; label: string; icon: Parameters<typeof Icon>[0]["name"] }[] = [
  { id: "media", label: "Mídia", icon: "film" },
  { id: "sounds", label: "Áudio", icon: "music" },
  { id: "text", label: "Texto", icon: "text" },
  { id: "stickers", label: "Stickers", icon: "sticker" },
  { id: "effects", label: "Efeitos", icon: "magic" },
  { id: "transitions", label: "Transições", icon: "transition" },
  { id: "captions", label: "Legendas", icon: "captions" },
  { id: "filters", label: "Filtros", icon: "filter" },
  { id: "adjust", label: "Ajuste", icon: "adjust" },
  { id: "templates", label: "Modelos", icon: "template" },
  { id: "capcut", label: "CapCut", icon: "folder" },
  { id: "gaming", label: "Jogos", icon: "gamepad" },
  { id: "assistant", label: "IA", icon: "sparkle" },
];

export const MATERIAL_DRAG = "application/x-cena-material";

export function Library() {
  // The studio's "Aplicar no editor" opens the assistant with the request written (also when it came on the home screen).
  const pending = useChatPrefill((s) => s.text);
  const [tab, setTab] = useState<Tab>(() => (pending !== null ? "assistant" : "media"));
  useEffect(() => {
    if (pending !== null) setTab("assistant");
  }, [pending]);
  return (
    <aside className="panel library">
      <nav className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            <Icon name={t.icon} /> {t.label}
          </button>
        ))}
      </nav>
      {tab === "media" && <MediaTab />}
      {tab === "sounds" && <SoundsTab />}
      {tab === "text" && <TextTab />}
      {tab === "stickers" && <StickersTab />}
      {tab === "effects" && <EffectsTab />}
      {tab === "transitions" && <TransitionsTab />}
      {tab === "captions" && <CaptionsTab />}
      {tab === "filters" && <FiltersTab />}
      {tab === "adjust" && <AdjustTab />}
      {tab === "templates" && <TemplatesTab />}
      {tab === "capcut" && <CapcutTab />}
      {tab === "gaming" && <GamingTab />}
      {tab === "assistant" && <ChatTab />}
    </aside>
  );
}

/** Remove a media file from the project; when the timeline uses it, those clips go too, after asking. */
function removeMedia(id: string, name: string) {
  const { project, removeMaterials, setStatus } = useEditor.getState();
  const uses = project.tracks.reduce((n, t) => n + t.segments.filter((s) => s.materialId === id).length, 0);
  if (uses && !confirm(`"${name}" está em ${uses} clipe(s) da timeline. Remover a mídia e esses clipes?\n\nO arquivo no computador não é apagado, e Ctrl+Z desfaz.`)) return;
  removeMaterials([id]);
  setStatus(`"${name}" removido do projeto.`);
  setTimeout(() => useEditor.getState().setStatus(null), 3000);
}

function MediaTab() {
  const materials = useEditor((s) => s.project.materials);
  const previews = useEditor((s) => s.previews);
  const importFiles = useEditor((s) => s.importFiles);
  const addToTimeline = useEditor((s) => s.addMaterialToTimeline);
  const [hover, setHover] = useState(false);
  const list = Object.values(materials);

  const importDialog = async () => {
    const paths = await window.api.openMediaDialog();
    if (paths.length) await importFiles(paths);
  };

  return (
    <div
      className={`library-body${hover ? " drop-hover" : ""}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setHover(true);
        }
      }}
      onDragLeave={() => setHover(false)}
      onDrop={async (e) => {
        e.preventDefault();
        setHover(false);
        const paths = [...e.dataTransfer.files].map((f) => window.api.pathForFile(f)).filter(Boolean);
        if (paths.length) await importFiles(paths);
      }}
    >
      <button className="import-btn" onClick={importDialog}>
        <Icon name="plus" /> Importar mídia
      </button>
      {list.length === 0 ? (
        <p className="empty-hint">Arraste vídeos, áudios ou imagens para cá.</p>
      ) : (
        <div className="media-grid">
          {list.map((m) => {
            const thumb = previews[m.id]?.thumbnail;
            return (
              <div
                key={m.id}
                className="media-card"
                draggable
                title={m.path}
                onDragStart={(e) => {
                  e.dataTransfer.setData(MATERIAL_DRAG, m.id);
                  e.dataTransfer.effectAllowed = "copy";
                }}
                onDoubleClick={() => addToTimeline(m.id, { newTrack: true })}
              >
                <div className="media-thumb">
                  {thumb ? <img src={thumb} alt="" /> : <Icon name={m.kind === "audio" ? "music" : m.kind === "image" ? "image" : "film"} />}
                  {m.kind !== "image" && <span className="media-duration">{shortTime(m.duration)}</span>}
                </div>
                <div className="media-info">
                  <div className="media-name">{m.name}</div>
                  <div className="media-meta">
                    {{ video: "Vídeo", audio: "Áudio", image: "Imagem" }[m.kind]}
                    {m.width && m.height ? ` · ${m.width}×${m.height}` : ""}
                  </div>
                  {m.pending ? (
                    <div className="media-meta media-busy">Preparando…</div>
                  ) : previews[m.id]?.separating ? (
                    <div className="media-meta media-busy">Separando {(m.audioTracks ?? 2) - 1} faixa(s) de áudio…</div>
                  ) : m.audioCompanions?.length ? (
                    <div className="media-meta">{m.audioCompanions.length + 1} faixas de áudio</div>
                  ) : null}
                </div>
                <div className="media-actions">
                  <button className="media-add" title="Adicionar à timeline (numa faixa nova, na agulha)" onClick={() => addToTimeline(m.id, { newTrack: true })}>
                    <Icon name="plus" />
                  </button>
                  <button className="media-remove" title="Remover do projeto" onClick={() => removeMedia(m.id, m.name)}>
                    <Icon name="trash" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const TEXT_PRESETS = [
  { label: "Título", patch: { content: "Título", fontSize: 140, bold: true, strokeWidth: 0 } },
  { label: "Legenda", patch: { content: "Legenda", fontSize: 64, bold: true, strokeWidth: 5 }, y: 0.75 },
  { label: "Destaque", patch: { content: "DESTAQUE", fontSize: 110, bold: true, color: "#111111", background: "#ffd400", strokeWidth: 0 } },
  { label: "Simples", patch: { content: "Texto simples", fontSize: 80, bold: false, strokeWidth: 0 } },
];

function TextTab() {
  const addText = useEditor((s) => s.addText);
  const updateSegment = useEditor((s) => s.updateSegment);
  return (
    <div className="library-body">
      <div className="text-presets">
        {TEXT_PRESETS.map((p) => (
          <button
            key={p.label}
            className="text-preset"
            onClick={() => {
              const id = addText();
              updateSegment(
                id,
                (s) => {
                  if (s.text) Object.assign(s.text, p.patch);
                  if (p.y) s.transform.y = p.y;
                },
                { history: false },
              );
            }}
          >
            <span style={{ fontWeight: p.patch.bold ? 700 : 400, background: p.patch.background, color: p.patch.color }}>{p.label}</span>
          </button>
        ))}
      </div>
      <p className="empty-hint">O texto entra na posição do cursor da timeline.</p>
    </div>
  );
}

/** The selected clip if it is a video/image clip that can take effects. */
function useSelectedVisualClip() {
  return useEditor((s) => {
    const found = s.selectedId ? findSegment(s.project, s.selectedId) : null;
    if (!found || found.track.kind !== "video" || !found.segment.materialId) return null;
    return found.segment;
  });
}

function groupBy<T extends string>(items: readonly T[], group: (item: T) => string) {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(group(item), [...(out.get(group(item)) ?? []), item]);
  return [...out];
}

function EffectsTab() {
  const clip = useSelectedVisualClip();
  const thumb = useEditor((s) => (clip?.materialId ? s.previews[clip.materialId]?.thumbnail : undefined));
  const addEffect = useEditor((s) => s.addEffect);
  const removeEffect = useEditor((s) => s.removeEffect);
  return (
    <div className="library-body">
      <p className="empty-hint">{clip ? "Clique para aplicar ao clipe selecionado. Ajuste a intensidade no painel à direita." : "Selecione um clipe de vídeo ou imagem na timeline para aplicar efeitos."}</p>
      {groupBy(EFFECTS, (e) => EFFECT_INFO[e].group).map(([group, items]) => (
        <div key={group}>
          <h4 className="lib-group">{group}</h4>
          <div className="fx-grid">
            {items.map((type) => {
              const applied = clip?.effects.find((e) => e.type === type);
              return (
                <button
                  key={type}
                  className={`fx-card${applied ? " applied" : ""}`}
                  disabled={!clip}
                  title={applied ? "Clique para remover" : "Aplicar"}
                  onClick={() => clip && (applied ? removeEffect(clip.id, applied.id) : addEffect(clip.id, type))}
                >
                  <span className="fx-swatch" style={{ backgroundImage: thumb ? `url(${thumb})` : undefined, filter: EFFECT_INFO[type].swatch }} />
                  <span className="fx-name">{EFFECT_INFO[type].label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Two solid layers blended by the real compositor; animates while hovered. */
function TransitionThumb({ type }: { type: TransitionType }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    const make = (fill: string, label: string) => {
      const c = document.createElement("canvas");
      c.width = canvas.width;
      c.height = canvas.height;
      const g = c.getContext("2d")!;
      g.fillStyle = fill;
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = "rgba(255,255,255,0.9)";
      g.font = "bold 26px Segoe UI";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(label, c.width / 2, c.height / 2);
      return { canvas: c, opacity: 1 };
    };
    const a = make("#2c5f8a", "A");
    const b = make("#b5652a", "B");
    let raf = 0;
    const started = performance.now();
    const paint = () => {
      const p = hover ? ((performance.now() - started) / 1200) % 1 : 0.45;
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // drawTransition tints layers in place, so hand it fresh copies each frame.
      drawTransition(ctx, type, p, copy(a), copy(b), DEFAULT_TRANSITION_SHAPE);
      if (hover) raf = requestAnimationFrame(paint);
    };
    paint();
    return () => cancelAnimationFrame(raf);
  }, [type, hover]);
  return <canvas ref={ref} width={128} height={72} className="tr-thumb" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)} />;
}

function copy(l: { canvas: HTMLCanvasElement; opacity: number }) {
  const c = document.createElement("canvas");
  c.width = l.canvas.width;
  c.height = l.canvas.height;
  c.getContext("2d")!.drawImage(l.canvas, 0, 0);
  return { canvas: c, opacity: l.opacity };
}

function TransitionsTab() {
  const applyTransition = useEditor((s) => s.applyTransition);
  const setStatus = useEditor((s) => s.setStatus);
  return (
    <div className="library-body">
      <p className="empty-hint">Aplica no corte do clipe selecionado ou, sem seleção, no corte mais próximo do cursor. Os dois clipes precisam estar encostados na mesma faixa.</p>
      {groupBy(TRANSITIONS, (t) => TRANSITION_INFO[t].group).map(([group, items]) => (
        <div key={group}>
          <h4 className="lib-group">{group}</h4>
          <div className="fx-grid">
            {items.map((type) => (
              <button
                key={type}
                className="fx-card"
                onClick={() => {
                  if (!applyTransition(type)) setStatus("Não há corte entre dois clipes encostados numa faixa de vídeo.");
                  else setStatus(null);
                }}
              >
                <TransitionThumb type={type} />
                <span className="fx-name">{TRANSITION_INFO[type].label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CapcutTab() {
  const [state, setState] = useState<{ root: string; drafts: CapcutDraftEntry[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<string[] | null>(null);
  const loadProject = useEditor((s) => s.loadProject);
  const dirty = useEditor((s) => s.dirty);

  useEffect(() => {
    window.api.listCapcutDrafts().then(setState, (e: Error) => setError(e.message));
  }, []);

  const importDraft = async (d: CapcutDraftEntry) => {
    if (dirty && !confirm("Descartar as alterações do projeto atual?")) return;
    try {
      const { data } = await window.api.readCapcutDraft(d.dir);
      const { project, warnings } = convertCapcutDraft(data, d.dir, d.name);
      loadProject(project, null);
      setReport(warnings.length ? warnings : ["Importado sem avisos."]);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="library-body">
      <p className="empty-hint">Abre rascunhos do CapCut desta máquina como projeto novo. Vídeo, áudio, texto, cortes, velocidade e posição são convertidos.</p>
      {error && <p className="error-text">{error}</p>}
      {report && (
        <ul className="import-report">
          {report.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
      {state && state.drafts.length === 0 && <p className="empty-hint">Nenhum rascunho em {state.root}</p>}
      <div className="draft-list">
        {state?.drafts.map((d) => (
          <button key={d.dir} className="draft-item" onClick={() => importDraft(d)}>
            {d.cover ? <img src={mediaUrl(d.cover)} alt="" /> : <div className="draft-cover-empty"><Icon name="film" /></div>}
            <div>
              <strong>{d.name}</strong>
              <small>{new Date(d.modified).toLocaleString("pt-BR")}</small>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
