import { useState } from "react";
import { useEditor } from "../store";
import { selectedIds, useUi } from "../ui";
import { findSegment } from "../model/project";
import { processSound, soundClips } from "../clipActions";
import { clearDucking, detectScenes, duckUnderVoice, findHighlights, mainGameplayClip, punchZoom, removeSilences, verticalGamingLayout } from "../gaming";
import { TEMPLATES, applyTemplate } from "../templates";
import { useAiJob } from "../ai";
import { Icon } from "./controls";

const GAMER_TEMPLATES = ["gg", "kill", "epic"];

/** Gameplay editing in one place: voice, ducking, silence cuts, highlights, scenes, zoom and vertical layout. */
export function GamingTab() {
  // Derived here, not in the selector: a selector must return the same object until the state changes.
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  const selected = selectedId ? findSegment(project, selectedId) : null;
  const multi = useUi((s) => s.multi);
  // Recomputed when the project or the selection changes.
  const voiceTargets = selectedId ? soundClips([selectedId, ...multi]) : [];
  const aiBusy = useAiJob((s) => s.job !== null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [duckLevel, setDuckLevel] = useState(0.25);
  const [minSilence, setMinSilence] = useState(0.7);

  const material = selected?.segment.materialId ? project.materials[selected.segment.materialId] : undefined;
  const hasSound = Boolean(material?.hasAudio);
  const isVideo = Boolean(material?.hasVideo && material.kind !== "image");
  const ducked = project.tracks.flatMap((t) => t.segments).filter((s) => s.keyframes.volume?.length);

  const run = async (label: string, task: () => Promise<string> | string) => {
    setBusy(label);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await task() });
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };
  const disabled = busy !== null || aiBusy;
  const need = (ok: boolean, hint: string) => (ok ? undefined : hint);

  return (
    <div className="library-body gaming">
      <p className="empty-hint">
        Clique num clipe da timeline e use as ferramentas abaixo. Tudo pode ser desfeito com Ctrl+Z. Também dá para pedir na aba IA, por exemplo: "faça 60 segundos com
        os melhores momentos, com a minha voz limpa".
      </p>

      <h4 className="lib-group">Áudio</h4>
      <div className="gaming-actions">
        <button
          disabled={disabled || !voiceTargets.length}
          title={voiceTargets.length ? "Ruído, graves, presença, de-esser, compressor e volume de fala" : "Selecione um ou mais clipes com voz (arraste uma caixa na timeline ou use Ctrl+clique)"}
          onClick={() =>
            run("voz", async () => {
              const r = await processSound(voiceTargets, "voice");
              if (r.cancelled) throw new Error(`Cancelado${r.done ? ` (${r.done} clipe(s) já prontos)` : ""}.`);
              if (r.errors.length) throw new Error(`${r.done} de ${voiceTargets.length} prontos. Erro: ${r.errors[0]}`);
              return r.done > 1 ? `Voz melhorada em ${r.done} clipes.` : "Voz melhorada: ruído, graves, presença, compressor e volume de fala.";
            })
          }
        >
          <Icon name="denoise" /> Melhorar voz{voiceTargets.length > 1 ? ` (${voiceTargets.length} clipes)` : ""}
        </button>
        <div className="gaming-row">
          <button
            disabled={disabled || !hasSound}
            title={need(hasSound, "Selecione o clipe da sua voz")}
            onClick={() =>
              selected &&
              run("ducking", async () => {
                const r = await duckUnderVoice(selected.segment.id, { level: duckLevel });
                return `O resto abaixa para ${Math.round(duckLevel * 100)}% em ${r.phrases} falas (${r.clipsDucked} clipe(s) ajustados).`;
              })
            }
          >
            <Icon name="music" /> Abaixar o jogo quando eu falo
          </button>
          <select value={duckLevel} onChange={(e) => setDuckLevel(Number(e.target.value))} title="Volume do resto enquanto você fala">
            {[0.1, 0.25, 0.4, 0.6].map((v) => (
              <option key={v} value={v}>
                {Math.round(v * 100)}%
              </option>
            ))}
          </select>
        </div>
        {ducked.length > 0 && (
          <button disabled={disabled} onClick={() => run("limpar", () => (clearDucking(ducked.map((s) => s.id)), "Ducking removido."))}>
            Tirar o ducking ({ducked.length} clipe(s))
          </button>
        )}
      </div>
      <p className="hint">
        Para melhorar várias faixas de uma vez, selecione todas (arraste uma caixa na timeline ou Ctrl+clique) e clique em Melhorar voz. Gravou no OBS com o microfone numa faixa separada? Importe normalmente: cada faixa de áudio vira um clipe vinculado ao vídeo. O volume no padrão do YouTube fica na janela
        de exportação.
      </p>

      <h4 className="lib-group">Cortes</h4>
      <div className="gaming-actions">
        <div className="gaming-row">
          <button
            disabled={disabled || !hasSound}
            title={need(hasSound, "Selecione o clipe com a fala")}
            onClick={() =>
              selected &&
              run("silêncios", async () => {
                const r = await removeSilences(selected.segment.id, { minSilence });
                return r.cuts ? `${r.cuts} pausas cortadas (${r.removedSeconds.toFixed(1)} s a menos).` : "Nenhuma pausa longa encontrada.";
              })
            }
          >
            <Icon name="blade" /> Cortar silêncios
          </button>
          <select value={minSilence} onChange={(e) => setMinSilence(Number(e.target.value))} title="Pausa mínima para cortar">
            {[0.4, 0.7, 1, 1.5, 2.5].map((v) => (
              <option key={v} value={v}>
                {v.toLocaleString("pt-BR")} s
              </option>
            ))}
          </select>
        </div>
        <button
          disabled={disabled || (!hasSound && !mainGameplayClip())}
          onClick={() =>
            run("destaques", async () => {
              const r = await findHighlights(hasSound ? selected?.segment.id : undefined);
              return `${r.moments.length} momentos marcados como "Destaque" na timeline.`;
            })
          }
        >
          <Icon name="marker" /> Achar os momentos altos
        </button>
        <div className="gaming-row">
          <button
            disabled={disabled || !isVideo}
            title={need(isVideo, "Selecione um clipe de vídeo")}
            onClick={() => selected && run("cenas", async () => `${(await detectScenes(selected.segment.id)).scenes} cenas marcadas.`)}
          >
            <Icon name="film" /> Marcar cenas
          </button>
          <button
            disabled={disabled || !isVideo}
            title={need(isVideo, "Selecione um clipe de vídeo")}
            onClick={() => selected && run("cenas", async () => `Clipe dividido em ${(await detectScenes(selected.segment.id, { split: true })).scenes} cenas.`)}
          >
            Dividir por cena
          </button>
        </div>
      </div>

      <h4 className="lib-group">Visual</h4>
      <div className="gaming-actions">
        <button
          disabled={disabled || !selected || selected.track.kind !== "video"}
          title="Zoom rápido no ponto do cursor da timeline"
          onClick={() => selected && run("zoom", () => (punchZoom(selected.segment.id, useEditor.getState().playhead), "Zoom de impacto no cursor."))}
        >
          <Icon name="magic" /> Zoom de impacto no cursor
        </button>
        <button
          disabled={disabled || !isVideo}
          title="Selecione a gameplay; com Ctrl+clique, selecione também a webcam"
          onClick={() =>
            run("vertical", () => {
              const [gameplay, facecam] = selectedIds();
              const r = verticalGamingLayout(gameplay, facecam);
              return r.facecam ? "Vertical 1080×1920: webcam em cima, gameplay embaixo." : "Vertical 1080×1920 com fundo desfocado.";
            })
          }
        >
          <Icon name="rotate" /> Vertical (Shorts/TikTok)
        </button>
        <p className="hint">Para webcam em cima e gameplay embaixo: clique na gameplay e depois, com Ctrl, na webcam.</p>
        <div className="gaming-row">
          {GAMER_TEMPLATES.map((id) => {
            const t = TEMPLATES.find((x) => x.id === id)!;
            return (
              <button key={id} disabled={disabled} title={t.description} onClick={() => run("modelo", () => (applyTemplate(t), `"${t.label}" inserido no cursor.`))}>
                {t.label}
              </button>
            );
          })}
        </div>
      </div>

      {busy && <p className="chat-working">Trabalhando…</p>}
      {message && <p className={message.ok ? "ok-text" : "error-text"}>{message.text}</p>}
    </div>
  );
}
