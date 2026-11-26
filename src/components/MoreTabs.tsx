import { useState } from "react";
import { useEditor } from "../store";
import { findSegment } from "../model/project";
import { DEFAULT_TEXT } from "../model/project";
import { FILTERS, type Adjust, type Segment, type TextStyle } from "../model/types";
import { FILTER_INFO, lookSwatch } from "../engine/catalog";
import { parseSubtitles, projectToSrt } from "../model/subtitles";
import { shortTime } from "../model/time";
import { TEMPLATES, applyTemplate } from "../templates";
import { CaptionsDialog } from "./CaptionsDialog";
import { Icon } from "./controls";

function groupBy<T>(items: readonly T[], group: (item: T) => string) {
  const out = new Map<string, T[]>();
  for (const item of items) out.set(group(item), [...(out.get(group(item)) ?? []), item]);
  return [...out];
}

/** The selected clip if it shows media (video/image) or is an adjustment layer. */
function useGradableClip(): Segment | null {
  return useEditor((s) => {
    const found = s.selectedId ? findSegment(s.project, s.selectedId) : null;
    if (!found) return null;
    return (found.track.kind === "video" && found.segment.materialId) || found.segment.adjustLayer ? found.segment : null;
  });
}

// --- Legendas ------------------------------------------------------------------------------

const CAPTION_STYLES: { label: string; style: Partial<TextStyle>; y?: number; preview: React.CSSProperties }[] = [
  { label: "Clássica", style: { color: "#ffffff", strokeColor: "#000000", strokeWidth: 5, background: null, bold: true, fontSize: 64 }, preview: { color: "#fff", WebkitTextStroke: "1px #000" } },
  { label: "Amarela", style: { color: "#ffd400", strokeColor: "#000000", strokeWidth: 6, background: null, bold: true, fontSize: 66 }, preview: { color: "#ffd400", WebkitTextStroke: "1px #000" } },
  { label: "Caixa preta", style: { color: "#ffffff", strokeWidth: 0, background: "#000000cc", bold: false, fontSize: 56 }, preview: { color: "#fff", background: "#000" } },
  { label: "Destaque", style: { color: "#111111", strokeWidth: 0, background: "#ffd400", bold: true, fontSize: 60 }, preview: { color: "#111", background: "#ffd400" } },
  { label: "Neon", style: { color: "#38f9ff", strokeColor: "#b400ff", strokeWidth: 4, background: null, bold: true, fontSize: 64 }, preview: { color: "#38f9ff", WebkitTextStroke: "1px #b400ff" } },
  { label: "Impacto", style: { color: "#ffffff", strokeColor: "#000000", strokeWidth: 8, background: null, bold: true, fontSize: 84, fontFamily: "Impact" }, preview: { color: "#fff", WebkitTextStroke: "1px #000", fontFamily: "Impact" } },
  { label: "Minimalista", style: { color: "#ffffff", strokeWidth: 0, background: null, bold: false, fontSize: 48 }, preview: { color: "#fff", fontWeight: 400 } },
  { label: "No topo", style: { color: "#ffffff", strokeColor: "#000000", strokeWidth: 5, background: null, bold: true, fontSize: 60 }, y: -0.72, preview: { color: "#fff", WebkitTextStroke: "1px #000" } },
];

export function CaptionsTab() {
  const [dialog, setDialog] = useState(false);
  const project = useEditor((s) => s.project);
  const captions = project.tracks.filter((t) => t.role === "captions").flatMap((t) => t.segments);
  const { mutate, setPlayhead, select, updateSegment, deleteSegment, setStatus, addCaptions } = useEditor.getState();

  const applyStyle = (preset: (typeof CAPTION_STYLES)[number]) =>
    mutate((p) => {
      for (const t of p.tracks) {
        if (t.role !== "captions") continue;
        for (const s of t.segments) {
          if (!s.text) continue;
          s.text = { ...DEFAULT_TEXT, ...s.text, ...preset.style, content: s.text.content };
          s.transform.y = preset.y ?? 0.72;
        }
      }
    });

  return (
    <div className="library-body">
      <button className="import-btn" onClick={() => setDialog(true)}>
        <Icon name="captions" /> Legendas automáticas
      </button>
      {dialog && <CaptionsDialog onClose={() => setDialog(false)} />}
      <div className="subtitle-io">
        <button
          onClick={async () => {
            const file = await window.api.openSubtitles();
            if (!file) return;
            const n = addCaptions(parseSubtitles(file.name, file.text), false);
            setStatus(n ? `${n} legendas importadas de ${file.name}.` : `Nenhuma legenda encontrada em ${file.name}.`);
          }}
        >
          Importar .srt / .ass
        </button>
        <button
          onClick={async () => {
            const srt = projectToSrt(useEditor.getState().project);
            if (!srt) return setStatus("Não há textos para exportar como legenda.");
            const saved = await window.api.saveSubtitles(project.name, srt);
            if (saved) setStatus(`Legendas salvas em ${saved}.`);
          }}
        >
          Exportar .srt
        </button>
      </div>
      <h4 className="lib-group">Estilo das legendas</h4>
      <div className="caption-styles">
        {CAPTION_STYLES.map((c) => (
          <button key={c.label} disabled={!captions.length} title={captions.length ? "Aplicar a todas as legendas" : "Gere ou importe legendas primeiro"} onClick={() => applyStyle(c)}>
            <span style={{ fontWeight: 700, padding: "0 4px", borderRadius: 3, ...c.preview }}>Aa</span>
            {c.label}
          </button>
        ))}
      </div>
      <h4 className="lib-group">Legendas ({captions.length})</h4>
      {captions.length === 0 && <p className="empty-hint">Gere legendas automáticas ou importe um arquivo .srt/.ass para editá-las aqui.</p>}
      <div className="caption-list">
        {[...captions]
          .sort((a, b) => a.start - b.start)
          .map((s) => (
            <div key={s.id} className="caption-item">
              <button
                className="caption-time"
                title="Ir para esta legenda"
                onClick={() => {
                  setPlayhead(s.start);
                  select(s.id);
                }}
              >
                {shortTime(s.start)}
              </button>
              <textarea
                rows={Math.min(3, (s.text?.content.split("\n").length ?? 1))}
                value={s.text?.content ?? ""}
                onFocus={() => useEditor.getState().checkpoint()}
                onChange={(e) => updateSegment(s.id, (seg) => void (seg.text && (seg.text.content = e.target.value)), { history: false })}
              />
              <button className="icon-btn" title="Excluir legenda" onClick={() => deleteSegment(s.id)}>
                <Icon name="close" />
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

// --- Filtros -------------------------------------------------------------------------------

export function FiltersTab() {
  const clip = useGradableClip();
  const thumb = useEditor((s) => (clip?.materialId ? s.previews[clip.materialId]?.thumbnail : undefined));
  const { updateSegment, mutate } = useEditor.getState();
  return (
    <div className="library-body">
      <p className="empty-hint">{clip ? "Clique para aplicar ao clipe selecionado; a intensidade fica no painel à direita." : "Selecione um clipe de vídeo, imagem ou camada de ajuste."}</p>
      {clip?.filter && (
        <button className="import-btn" onClick={() => updateSegment(clip.id, (s) => void (s.filter = null))}>
          Remover filtro ({FILTER_INFO[clip.filter.type].label})
        </button>
      )}
      {groupBy(FILTERS, (f) => FILTER_INFO[f].group).map(([group, items]) => (
        <div key={group}>
          <h4 className="lib-group">{group}</h4>
          <div className="fx-grid">
            {items.map((type) => {
              const info = FILTER_INFO[type];
              const applied = clip?.filter?.type === type;
              return (
                <button
                  key={type}
                  className={`fx-card${applied ? " applied" : ""}`}
                  disabled={!clip}
                  onClick={() => clip && updateSegment(clip.id, (s) => void (s.filter = applied ? null : { type, intensity: 1 }))}
                >
                  <span className="fx-swatch filter-swatch" style={{ backgroundImage: thumb ? `url(${thumb})` : undefined, filter: lookSwatch(info.look) }}>
                    {info.look.overlay && <span style={{ background: info.look.overlay.color, opacity: info.look.overlay.alpha, mixBlendMode: "soft-light" }} />}
                  </span>
                  <span className="fx-name">{info.label}</span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {clip?.filter && (
        <button
          className="load-more"
          onClick={() =>
            mutate((p) => {
              for (const t of p.tracks) if (t.kind === "video") for (const s of t.segments) if (s.materialId) s.filter = { ...clip.filter! };
            })
          }
        >
          Aplicar este filtro em todos os clipes
        </button>
      )}
    </div>
  );
}

// --- Ajuste --------------------------------------------------------------------------------

const ADJUST_PRESETS: { label: string; patch: Partial<Adjust> }[] = [
  { label: "Mais claro", patch: { brightness: 1.2 } },
  { label: "Mais escuro", patch: { brightness: 0.82 } },
  { label: "Mais contraste", patch: { contrast: 1.3 } },
  { label: "Vibrante", patch: { saturation: 1.45 } },
  { label: "Dessaturado", patch: { saturation: 0.55 } },
  { label: "Quente", patch: { temperature: 0.5 } },
  { label: "Frio", patch: { temperature: -0.5 } },
  { label: "Nítido", patch: { sharpen: 0.6 } },
  { label: "Suave", patch: { contrast: 0.88, blur: 1 } },
  { label: "Magenta", patch: { tint: 0.5 } },
];

export function AdjustTab() {
  const clip = useGradableClip();
  const { addOverlay, updateSegment } = useEditor.getState();
  const apply = (patch: Partial<Adjust>) => {
    // Without a selected clip, the preset goes on a new adjustment layer over everything.
    const id = clip?.id ?? addOverlay({ adjustLayer: true });
    // A new layer was just added with its own undo step; fold the preset into it.
    updateSegment(id, (s) => Object.assign(s.adjust, patch), { history: Boolean(clip) });
  };
  return (
    <div className="library-body">
      <button className="import-btn" onClick={() => addOverlay({ adjustLayer: true })}>
        <Icon name="adjust" /> Adicionar camada de ajuste
      </button>
      <p className="empty-hint">
        A camada de ajuste muda tudo o que está abaixo dela na timeline, enquanto estiver ativa. Ajuste brilho, contraste, saturação, temperatura, matiz,
        nitidez e filtro no painel à direita.
      </p>
      <h4 className="lib-group">Ajustes rápidos {clip ? "(no clipe selecionado)" : "(numa camada de ajuste nova)"}</h4>
      <div className="caption-styles">
        {ADJUST_PRESETS.map((p) => (
          <button key={p.label} onClick={() => apply(p.patch)}>
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// --- Modelos -------------------------------------------------------------------------------

export function TemplatesTab() {
  return (
    <div className="library-body">
      <p className="empty-hint">Modelos prontos e animados, inseridos na posição do cursor. Depois é só trocar textos e cores no painel à direita.</p>
      <div className="template-list">
        {TEMPLATES.map((t) => {
          const items = t.build();
          const length = items.length ? Math.max(...items.map((i) => i.start + i.duration)) : 0;
          return (
            <button key={t.id} className="template-card" onClick={() => applyTemplate(t)}>
              <strong>{t.label}</strong>
              <small>{t.description}</small>
              {length > 0 && <small className="template-meta">{shortTime(length)} · {items.length} camada(s)</small>}
              {length === 0 && <small className="template-meta">ajusta o projeto</small>}
            </button>
          );
        })}
      </div>
      <p className="hint">Dica: depois de inserir, use Ctrl+clique para selecionar todas as camadas do modelo e movê-las juntas.</p>
    </div>
  );
}
