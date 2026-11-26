import { useState } from "react";
import { DEFAULT_TRANSITION, useEditor } from "../store";
import { useUi } from "../ui";
import { useAiJob } from "../ai";
import { adoptDerived, denoiseClip, enhanceClip, removeBackground, reverseClip } from "../clipActions";
import { InpaintDialog } from "./InpaintDialog";
import { openCrop } from "./CropDialog";
import { FontPicker } from "./FontPicker";
import { BLEND_LABELS, EasingSection, MaskSection, ShapeSection } from "./InspectorExtras";
import type { AnimatableProp, EffectType, Material, Project, Segment, TextStyle, Track, TransitionType } from "../model/types";
import { BLEND_MODES, EFFECTS, FILTERS, MAX_VOLUME, TRANSITIONS, TRANSITION_SHAPES, type BlendMode, type FilterType, type TransitionShape } from "../model/types";
import {
  DEFAULT_ADJUST,
  DEFAULT_CROP,
  DEFAULT_EFFECT_INTENSITY,
  DEFAULT_TEXT,
  DEFAULT_TRANSFORM,
  cropToAspect,
  findSegment,
  keyframeNear,
  maxTransitionDuration,
  nextAdjacent,
  valueAt,
} from "../model/project";
import { SECOND, fromSeconds, toSeconds } from "../model/time";
import { DEFAULT_TRANSITION_SHAPE, EFFECT_INFO, FILTER_INFO, TRANSITION_INFO, TRANSITION_SHAPE_LABELS } from "../engine/catalog";
import { Icon, Section, SliderRow, Toggle } from "./controls";

export function Inspector() {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  const found = selectedId ? findSegment(project, selectedId) : null;
  return (
    <aside className="panel inspector">
      {found ? <SegmentInspector project={project} segment={found.segment} track={found.track} index={found.index} /> : <ProjectInspector project={project} />}
    </aside>
  );
}

const TRANSFORM_PROPS: AnimatableProp[] = ["x", "y", "scale", "rotation", "opacity"];

const RESOLUTIONS = [
  { label: "16:9 · 1920×1080", w: 1920, h: 1080 },
  { label: "9:16 · 1080×1920", w: 1080, h: 1920 },
  { label: "1:1 · 1080×1080", w: 1080, h: 1080 },
  { label: "4:5 · 1080×1350", w: 1080, h: 1350 },
  { label: "16:9 · 1280×720", w: 1280, h: 720 },
  { label: "4K · 3840×2160", w: 3840, h: 2160 },
];

function ProjectInspector({ project }: { project: Project }) {
  const mutate = useEditor((s) => s.mutate);
  const current = `${project.width}x${project.height}`;
  return (
    <>
      <h2 className="panel-title">Projeto</h2>
      <Section title="Geral">
        <label className="field">
          <span>Nome</span>
          <input value={project.name} onChange={(e) => mutate((p) => void (p.name = e.target.value), { history: false })} />
        </label>
        <label className="field">
          <span>Proporção</span>
          <select
            value={current}
            onChange={(e) => {
              const [w, h] = e.target.value.split("x").map(Number);
              mutate((p) => {
                p.width = w;
                p.height = h;
              });
            }}
          >
            {!RESOLUTIONS.some((r) => `${r.w}x${r.h}` === current) && <option value={current}>Original · {project.width}×{project.height}</option>}
            {RESOLUTIONS.map((r) => (
              <option key={r.label} value={`${r.w}x${r.h}`}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Taxa de quadros</span>
          <select value={project.fps} onChange={(e) => mutate((p) => void (p.fps = Number(e.target.value)))}>
            {[24, 25, 30, 50, 60].map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </label>
      </Section>
      <Section title="Tela de fundo">
        <div className="segmented">
          <button className={project.backgroundMode === "color" ? "active" : ""} onClick={() => mutate((p) => void (p.backgroundMode = "color"))}>
            Cor
          </button>
          <button className={project.backgroundMode === "blur" ? "active" : ""} onClick={() => mutate((p) => void (p.backgroundMode = "blur"))}>
            Desfoque
          </button>
        </div>
        {project.backgroundMode === "color" ? (
          <label className="field">
            <span>Cor</span>
            <input type="color" value={project.background} onChange={(e) => mutate((p) => void (p.background = e.target.value), { history: false })} />
          </label>
        ) : (
          <>
            <SliderRow
              label="Desfoque"
              min={5}
              max={120}
              step={1}
              unit="px"
              value={project.backgroundBlur}
              defaultValue={40}
              onChange={(v, o) => mutate((p) => void (p.backgroundBlur = v), o)}
            />
            <p className="hint">Preenche as bordas com o próprio vídeo desfocado, útil para pôr vídeo horizontal num projeto vertical.</p>
          </>
        )}
      </Section>
      <p className="empty-hint">Selecione um clipe na timeline para editar.</p>
    </>
  );
}

/**
 * Jumps between the clip's keyframes (all properties) and deletes the ones under the playhead.
 * Shown while the clip has any keyframe.
 */
function KeyframeNav({ segment, local, fps }: { segment: Segment; local: number; fps: number }) {
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const removeKeyframesAt = useEditor((s) => s.removeKeyframesAt);
  const times = [...new Set(Object.values(segment.keyframes).flatMap((frames) => (frames ?? []).map((k) => k.time)))].sort((a, b) => a - b);
  if (!times.length) return null;
  const tolerance = SECOND / fps / 2;
  const prev = [...times].reverse().find((x) => x < local - tolerance);
  const next = times.find((x) => x > local + tolerance);
  const here = times.some((x) => Math.abs(x - local) <= tolerance);
  return (
    <div className="kf-nav">
      <button disabled={prev === undefined} onClick={() => prev !== undefined && setPlayhead(segment.start + prev)} title="Ir ao keyframe anterior">
        ◀
      </button>
      <span className={here ? "on" : ""}>◆ {here ? "No cursor" : `${times.length} keyframe${times.length > 1 ? "s" : ""}`}</span>
      <button disabled={next === undefined} onClick={() => next !== undefined && setPlayhead(segment.start + next)} title="Ir ao próximo keyframe">
        ▶
      </button>
      {here && (
        <button className="kf-del" onClick={() => removeKeyframesAt(segment.id, local)} title="Apaga os keyframes deste ponto (todas as propriedades)">
          Apagar
        </button>
      )}
    </div>
  );
}

function SegmentInspector({ project, segment, track, index }: { project: Project; segment: Segment; track: Track; index: number }) {
  const kind = track.kind;
  const playhead = useEditor((s) => s.playhead);
  const setAnimated = useEditor((s) => s.setAnimated);
  const toggleKeyframe = useEditor((s) => s.toggleKeyframe);
  const resetAnimated = useEditor((s) => s.resetAnimated);
  const updateSegment = useEditor((s) => s.updateSegment);
  const material = segment.materialId ? project.materials[segment.materialId] : undefined;
  const local = Math.min(Math.max(0, playhead - segment.start), segment.duration);
  const inside = playhead >= segment.start && playhead <= segment.start + segment.duration;
  const isVisual = kind !== "audio";
  // Clips whose pixels can be color-graded: video/image media.
  const gradable = kind === "video" && Boolean(material && (material.kind === "image" || material.hasVideo));
  const hasAudio = kind === "audio" || Boolean(material?.hasAudio);
  const update = (fn: (s: Segment) => void, history: boolean) => updateSegment(segment.id, fn, { history });
  // Keyframes count as a change even when the static value is still the default.
  const changed = (prop: AnimatableProp) => Boolean(segment.keyframes[prop]?.length) || Math.abs(segment.transform[prop] - DEFAULT_TRANSFORM[prop]) > 1e-6;
  const fadeChanged = segment.fadeIn > 0 || segment.fadeOut > 0;
  const hasKeyframeAt = Object.values(segment.keyframes).some((frames) => keyframeNear(frames, local, project.fps));
  const adjustChanged = (Object.keys(DEFAULT_ADJUST) as (keyof typeof DEFAULT_ADJUST)[]).some((k) => segment.adjust[k] !== DEFAULT_ADJUST[k]);

  const animated = (prop: AnimatableProp, label: string, min: number, max: number, step: number, unit?: string) => (
    <SliderRow
      key={prop}
      label={label}
      min={min}
      max={max}
      step={step}
      unit={unit}
      value={valueAt(segment, prop, local)}
      onChange={(v, o) => setAnimated(segment.id, prop, v, o)}
      defaultValue={DEFAULT_TRANSFORM[prop]}
      modified={changed(prop)}
      onReset={() => resetAnimated(segment.id, [prop])}
      keyframe={
        inside
          ? {
              active: Boolean(keyframeNear(segment.keyframes[prop], local, project.fps)),
              hasAny: Boolean(segment.keyframes[prop]?.length),
              onToggle: () => toggleKeyframe(segment.id, prop),
            }
          : undefined
      }
    />
  );

  return (
    <>
      <h2 className="panel-title">{segment.adjustLayer ? "Camada de ajuste" : segment.text ? "Texto" : material?.name ?? "Clipe"}</h2>
      <KeyframeNav segment={segment} local={local} fps={project.fps} />
      {segment.text && <TextSection text={segment.text} onChange={(patch, history) => update((s) => s.text && Object.assign(s.text, patch), history)} />}
      {segment.adjustLayer && (
        <Section title="Camada de ajuste">
          <p className="hint">Muda tudo o que está abaixo dela na timeline enquanto estiver ativa. Estique ou encurte o clipe para escolher o trecho.</p>
          {animated("opacity", "Intensidade", 0, 1, 0.01)}
        </Section>
      )}
      {isVisual && !segment.adjustLayer && (
        <Section title="Transformação" reset={{ visible: TRANSFORM_PROPS.some(changed), onClick: () => resetAnimated(segment.id, TRANSFORM_PROPS) }}>
          {animated("x", "Posição X", -2, 2, 0.001)}
          {animated("y", "Posição Y", -2, 2, 0.001)}
          {animated("scale", "Escala", 0.05, 5, 0.01, "×")}
          {animated("rotation", "Rotação", -180, 180, 0.5, "°")}
          {animated("opacity", "Opacidade", 0, 1, 0.01)}
          <label className="field inline-select">
            <span>Mesclagem</span>
            <select value={segment.blend} onChange={(e) => update((s) => void (s.blend = e.target.value as BlendMode), true)}>
              {BLEND_MODES.map((b) => (
                <option key={b} value={b}>
                  {BLEND_LABELS[b]}
                </option>
              ))}
            </select>
          </label>
          {!inside && <p className="hint">Mova o cursor para dentro do clipe para criar keyframes.</p>}
        </Section>
      )}
      {inside && hasKeyframeAt && <EasingSection segment={segment} local={local} fps={project.fps} />}
      {segment.shape && <ShapeSection shape={segment.shape} onChange={(patch, history) => update((s) => s.shape && Object.assign(s.shape, patch), history)} />}
      {segment.sticker && (
        <Section title="Sticker">
          <SliderRow label="Tamanho" min={20} max={800} step={1} value={segment.sticker.size} defaultValue={240} onChange={(v, o) => update((s) => void (s.sticker && (s.sticker.size = v)), o.history)} />
        </Section>
      )}
      {material && kind === "video" && (material.kind === "image" || material.hasVideo) && <MaskSection segment={segment} update={update} />}
      {material && kind === "video" && (material.kind === "image" || material.hasVideo) && <AiSection project={project} segment={segment} material={material} />}
      {material && (material.kind === "image" || material.hasVideo) && <CropSection segment={segment} material={material} update={update} />}
      {material && material.kind !== "image" && (
        <Section title="Velocidade">
          <SliderRow
            label="Velocidade"
            min={0.1}
            max={8}
            step={0.05}
            unit="×"
            value={segment.speed}
            defaultValue={1}
            onChange={(v, o) => {
              // Same part of the media; what comes after on the track stays glued to the clip's end.
              const { magnet, link } = useUi.getState();
              useEditor.getState().setSpeed(segment.id, v, { magnet, link }, { history: o.history });
            }}
          />
          {material.hasAudio && <Toggle label="Manter o tom da voz" checked={segment.keepPitch} onChange={(v) => update((s) => void (s.keepPitch = v), true)} />}
        </Section>
      )}
      {material?.kind === "image" && (
        <Section title="Duração">
          <SliderRow
            label="Segundos"
            min={0.1}
            max={60}
            step={0.1}
            value={toSeconds(segment.duration)}
            defaultValue={toSeconds(material.duration)}
            onChange={(v, o) => update((s) => void (s.duration = fromSeconds(v)), o.history)}
          />
        </Section>
      )}
      {hasAudio && (
        <Section title="Áudio">
          <SliderRow
            label="Volume"
            min={0}
            max={MAX_VOLUME}
            step={0.01}
            format={(v) => `${Math.round(v * 100)}%`}
            value={valueAt(segment, "volume", local)}
            defaultValue={1}
            modified={Boolean(segment.keyframes.volume?.length) || Math.abs(segment.volume - 1) > 0.005}
            onReset={() =>
              update((s) => {
                delete s.keyframes.volume;
                s.volume = 1;
              }, true)
            }
            onChange={(v, o) => setAnimated(segment.id, "volume", v, o)}
            keyframe={
              inside
                ? {
                    active: Boolean(keyframeNear(segment.keyframes.volume, local, project.fps)),
                    hasAny: Boolean(segment.keyframes.volume?.length),
                    onToggle: () => toggleKeyframe(segment.id, "volume"),
                  }
                : undefined
            }
          />
          {valueAt(segment, "volume", local) > 1 && <p className="hint">Acima de 100% o som pode distorcer nos picos.</p>}
          {segment.keyframes.volume?.length ? (
            <div className="hint-row">
              <span className="hint">O volume muda ao longo do clipe ({segment.keyframes.volume.length} keyframes). A linha amarela no clipe mostra como.</span>
              <button onClick={() => update((s) => void delete s.keyframes.volume, true)}>Remover</button>
            </div>
          ) : (
            <p className="hint">Para o som começar alto e ir abaixando: cursor no começo, clique em ◆; leve o cursor mais adiante e baixe o volume (o keyframe é criado sozinho).</p>
          )}
        </Section>
      )}
      <Section
        title="Fade"
        reset={{
          visible: fadeChanged,
          onClick: () =>
            update((s) => {
              s.fadeIn = 0;
              s.fadeOut = 0;
            }, true),
        }}
      >
        <SliderRow
          label="Entrada"
          min={0}
          max={Math.min(5, toSeconds(segment.duration))}
          step={0.05}
          unit="s"
          value={toSeconds(segment.fadeIn)}
          defaultValue={0}
          onChange={(v, o) => update((s) => void (s.fadeIn = fromSeconds(v)), o.history)}
        />
        <SliderRow
          label="Saída"
          min={0}
          max={Math.min(5, toSeconds(segment.duration))}
          step={0.05}
          unit="s"
          value={toSeconds(segment.fadeOut)}
          defaultValue={0}
          onChange={(v, o) => update((s) => void (s.fadeOut = fromSeconds(v)), o.history)}
        />
      </Section>
      {kind === "video" && material && <EffectsSection segment={segment} local={local} inside={inside} fps={project.fps} />}
      {kind === "video" && material && <TransitionSection segment={segment} next={nextAdjacent(track, index)} />}
      {(gradable || segment.adjustLayer) && <FilterSection segment={segment} update={update} />}
      {(gradable || segment.adjustLayer) && (
        <Section title="Ajustes" reset={{ visible: adjustChanged, onClick: () => update((s) => void (s.adjust = { ...DEFAULT_ADJUST }), true) }}>
          {(
            [
              ["brightness", "Brilho", 0, 2, 0.01, undefined],
              ["contrast", "Contraste", 0, 2, 0.01, undefined],
              ["saturation", "Saturação", 0, 3, 0.01, undefined],
              ["temperature", "Temperatura", -1, 1, 0.01, undefined],
              ["tint", "Matiz", -1, 1, 0.01, undefined],
              ["sharpen", "Nitidez", 0, 1, 0.01, undefined],
              ["blur", "Desfoque", 0, 40, 0.5, "px"],
            ] as const
          ).map(([key, label, min, max, step, unit]) => (
            <SliderRow
              key={key}
              label={label}
              min={min}
              max={max}
              step={step}
              unit={unit}
              value={segment.adjust[key]}
              defaultValue={DEFAULT_ADJUST[key]}
              onChange={(v, o) => update((s) => void (s.adjust[key] = v), o.history)}
            />
          ))}
        </Section>
      )}
    </>
  );
}

/** Background and object removal; both swap the clip's media for a processed copy that can be restored. */
function AiSection({ project, segment, material }: { project: Project; segment: Segment; material: Material }) {
  const busy = useAiJob((s) => s.job !== null);
  const [inpainting, setInpainting] = useState(false);
  const { restoreOriginal } = useEditor.getState();
  const isImage = material.kind === "image";
  const original = material.derived ? project.materials[material.derived.from] : undefined;

  return (
    <Section title="Inteligência artificial e processamento">
      <div className="ai-actions">
        <button disabled={busy} onClick={() => void removeBackground(segment.id)} title="Deixa só as pessoas e torna o resto transparente">
          <Icon name="person" /> Remover fundo
        </button>
        {isImage && (
          <button disabled={busy} onClick={() => setInpainting(true)} title="Pinte e apague objetos da foto">
            <Icon name="eraser" /> Remover objetos
          </button>
        )}
        {!isImage && (
          <>
            <button disabled={busy} onClick={() => void enhanceClip(segment.id)} title="Limpa, dá nitidez e dobra resoluções baixas (até 4K)">
              <Icon name="hd" /> Melhorar qualidade
            </button>
            <button disabled={busy} onClick={() => void reverseClip(segment.id)} title="Reproduz o trecho de trás para frente">
              <Icon name="reverse" /> Inverter
            </button>
            {material.hasAudio && (
              <button disabled={busy} onClick={() => void denoiseClip(segment.id)} title="Separa o som num clipe de áudio e remove chiado, zumbido e ventilador">
                <Icon name="denoise" /> Reduzir ruído
              </button>
            )}
          </>
        )}
        {original && (
          <button disabled={busy} onClick={() => restoreOriginal(segment.id)} title={`Volta para "${original.name}"`}>
            <Icon name="reset" /> Restaurar original
          </button>
        )}
      </div>
      <p className="hint">
        {isImage ? "Roda neste computador; os modelos são baixados na primeira vez." : "Processa só o trecho usado do vídeo. O detector é feito para pessoas."}
      </p>
      {inpainting && (
        <InpaintDialog
          material={material}
          onClose={() => setInpainting(false)}
          onApply={(path) => {
            setInpainting(false);
            void adoptDerived(segment, material, path, "removeObjects");
          }}
        />
      )}
    </Section>
  );
}

const CROP_ASPECTS: { label: string; value: number | null }[] = [
  { label: "Livre", value: null },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
  { label: "1:1", value: 1 },
  { label: "4:5", value: 4 / 5 },
];
const CROP_SIDES = [
  ["left", "right", "Esquerda"],
  ["right", "left", "Direita"],
  ["top", "bottom", "Cima"],
  ["bottom", "top", "Baixo"],
] as const;

function CropSection({ segment, material, update }: { segment: Segment; material: Material; update: (fn: (s: Segment) => void, history: boolean) => void }) {
  const crop = segment.crop;
  const cropped = CROP_SIDES.some(([side]) => crop[side] > 0);
  const w = material.width ?? 0;
  const h = material.height ?? 0;
  const matches = (aspect: number | null) => {
    const c = cropToAspect(w, h, aspect);
    return CROP_SIDES.every(([side]) => Math.abs(c[side] - crop[side]) < 0.002);
  };
  return (
    <Section title="Recortar" reset={{ visible: cropped, onClick: () => update((s) => void (s.crop = { ...DEFAULT_CROP }), true) }}>
      <button className="crop-open" onClick={() => openCrop(segment.id)} title="Abre a imagem inteira com uma caixa para arrastar">
        Recortar na imagem…
      </button>
      {w > 0 && h > 0 && (
        <div className="segmented crop-presets">
          {CROP_ASPECTS.map((a) => (
            <button key={a.label} className={a.value !== null && matches(a.value) ? "active" : ""} onClick={() => update((s) => void (s.crop = cropToAspect(w, h, a.value)), true)}>
              {a.label}
            </button>
          ))}
        </div>
      )}
      {CROP_SIDES.map(([side, opposite, label]) => (
        <SliderRow
          key={side}
          label={label}
          min={0}
          max={90}
          step={0.5}
          unit="%"
          value={crop[side] * 100}
          defaultValue={0}
          // Always leave at least 5% of the frame visible.
          onChange={(v, o) => update((s) => void (s.crop[side] = Math.min(v / 100, 0.95 - s.crop[opposite])), o.history)}
        />
      ))}
    </Section>
  );
}

function EffectsSection({ segment, local, inside, fps }: { segment: Segment; local: number; inside: boolean; fps: number }) {
  const addEffect = useEditor((s) => s.addEffect);
  const setAnimated = useEditor((s) => s.setAnimated);
  const toggleKeyframe = useEditor((s) => s.toggleKeyframe);
  const removeEffect = useEditor((s) => s.removeEffect);
  const updateSegment = useEditor((s) => s.updateSegment);
  const available = EFFECTS.filter((t) => !segment.effects.some((e) => e.type === t));
  return (
    <Section title="Efeitos" reset={{ visible: segment.effects.length > 0, label: "Remover todos", onClick: () => updateSegment(segment.id, (s) => void (s.effects = [])) }}>
      {segment.effects.map((e) => (
        <div key={e.id} className="effect-row">
          <SliderRow
            label={EFFECT_INFO[e.type].label}
            min={0}
            max={1}
            step={0.01}
            value={valueAt(segment, `fx:${e.id}`, local)}
            defaultValue={DEFAULT_EFFECT_INTENSITY}
            modified={Boolean(segment.keyframes[`fx:${e.id}`]?.length) || e.intensity !== DEFAULT_EFFECT_INTENSITY}
            onReset={() =>
              useEditor.getState().updateSegment(segment.id, (s) => {
                delete s.keyframes[`fx:${e.id}`];
                const fx = s.effects.find((x) => x.id === e.id);
                if (fx) fx.intensity = DEFAULT_EFFECT_INTENSITY;
              })
            }
            onChange={(v, o) => setAnimated(segment.id, `fx:${e.id}`, v, o)}
            keyframe={
              inside
                ? {
                    active: Boolean(keyframeNear(segment.keyframes[`fx:${e.id}`], local, fps)),
                    hasAny: Boolean(segment.keyframes[`fx:${e.id}`]?.length),
                    onToggle: () => toggleKeyframe(segment.id, `fx:${e.id}`),
                  }
                : undefined
            }
          />
          <button className="icon-btn" title="Remover efeito" onClick={() => removeEffect(segment.id, e.id)}>
            <Icon name="close" />
          </button>
        </div>
      ))}
      {available.length > 0 && (
        <select className="add-select" value="" onChange={(ev) => ev.target.value && addEffect(segment.id, ev.target.value as EffectType)}>
          <option value="">+ Adicionar efeito…</option>
          {available.map((t) => (
            <option key={t} value={t}>
              {EFFECT_INFO[t].label}
            </option>
          ))}
        </select>
      )}
    </Section>
  );
}

function TransitionSection({ segment, next }: { segment: Segment; next: Segment | null }) {
  const setTransition = useEditor((s) => s.setTransition);
  const updateSegment = useEditor((s) => s.updateSegment);
  if (!next) {
    return (
      <Section title="Transição de saída">
        <p className="hint">Encoste outro clipe logo depois deste, na mesma faixa, para usar uma transição.</p>
      </Section>
    );
  }
  const max = Math.min(2 * SECOND, maxTransitionDuration(segment, next));
  const tr = segment.transition;
  return (
    <Section title="Transição de saída">
      <select
        className="add-select"
        value={tr?.type ?? ""}
        onChange={(e) => {
          const type = e.target.value as TransitionType | "";
          const shape = type === "shape" ? { shape: tr?.shape ?? { ...DEFAULT_TRANSITION_SHAPE } } : {};
          setTransition(segment.id, type ? { type, duration: Math.min(tr?.duration ?? DEFAULT_TRANSITION, max), ...shape } : null);
        }}
      >
        <option value="">Nenhuma</option>
        {TRANSITIONS.map((t) => (
          <option key={t} value={t}>
            {TRANSITION_INFO[t].label}
          </option>
        ))}
      </select>
      {tr && (
        <SliderRow
          label="Duração"
          min={0.1}
          max={toSeconds(max)}
          step={0.05}
          unit="s"
          value={Math.min(toSeconds(tr.duration), toSeconds(max))}
          defaultValue={toSeconds(Math.min(DEFAULT_TRANSITION, max))}
          onChange={(v, o) => updateSegment(segment.id, (s) => s.transition && (s.transition.duration = fromSeconds(v)), o)}
        />
      )}
      {tr?.type === "shape" && tr.shape && (
        <TransitionShapeEditor shape={tr.shape} onChange={(patch, history) => updateSegment(segment.id, (s) => s.transition?.shape && Object.assign(s.transition.shape, patch), { history })} />
      )}
    </Section>
  );
}

/** The clip's color filter (look) and its strength. */
function FilterSection({ segment, update }: { segment: Segment; update: (fn: (s: Segment) => void, history: boolean) => void }) {
  const f = segment.filter;
  return (
    <Section title="Filtro" reset={{ visible: Boolean(f), label: "Remover", onClick: () => update((s) => void (s.filter = null), true) }}>
      <select className="add-select" value={f?.type ?? ""} onChange={(e) => update((s) => void (s.filter = e.target.value ? { type: e.target.value as FilterType, intensity: f?.intensity ?? 1 } : null), true)}>
        <option value="">Nenhum</option>
        {FILTERS.map((t) => (
          <option key={t} value={t}>
            {FILTER_INFO[t].label}
          </option>
        ))}
      </select>
      {f && (
        <SliderRow
          label="Intensidade"
          min={0}
          max={1}
          step={0.01}
          value={f.intensity}
          defaultValue={1}
          onChange={(v, o) => update((s) => void (s.filter && (s.filter.intensity = v)), o.history)}
        />
      )}
    </Section>
  );
}

/** Options of the custom shape transition. */
function TransitionShapeEditor({ shape, onChange }: { shape: TransitionShape; onChange: (patch: Partial<TransitionShape>, history: boolean) => void }) {
  return (
    <>
      <div className="mask-grid">
        {TRANSITION_SHAPES.map((k) => (
          <button key={k} className={shape.kind === k ? "active" : ""} onClick={() => onChange({ kind: k }, true)}>
            {TRANSITION_SHAPE_LABELS[k]}
          </button>
        ))}
      </div>
      {shape.kind === "text" && (
        <label className="field">
          <span>Texto</span>
          <input value={shape.text} onChange={(e) => onChange({ text: e.target.value }, false)} />
        </label>
      )}
      <div className="segmented">
        <button className={shape.direction === "grow" ? "active" : ""} onClick={() => onChange({ direction: "grow" }, true)}>
          Próximo clipe cresce
        </button>
        <button className={shape.direction === "shrink" ? "active" : ""} onClick={() => onChange({ direction: "shrink" }, true)}>
          Clipe atual encolhe
        </button>
      </div>
      <SliderRow label="Suavizar" min={0} max={0.3} step={0.005} value={shape.softness} defaultValue={DEFAULT_TRANSITION_SHAPE.softness} onChange={(v, o) => onChange({ softness: v }, o.history)} />
      <Toggle label="Girar enquanto cresce" checked={shape.rotate} onChange={(v) => onChange({ rotate: v }, true)} />
    </>
  );
}

function TextSection({ text, onChange }: { text: TextStyle; onChange: (patch: Partial<TextStyle>, history: boolean) => void }) {
  const checkpoint = useEditor((s) => s.checkpoint);
  const { content: _content, ...defaultStyle } = DEFAULT_TEXT;
  const styleChanged = (Object.keys(defaultStyle) as (keyof typeof defaultStyle)[]).some((k) => text[k] !== defaultStyle[k]);
  return (
    <Section title="Texto" reset={{ visible: styleChanged, label: "Redefinir estilo", onClick: () => onChange({ ...defaultStyle, fontSource: undefined }, true) }}>
      <textarea className="text-input" rows={3} value={text.content} onFocus={checkpoint} onChange={(e) => onChange({ content: e.target.value }, false)} />
      {/* A div, not a label: clicks inside the picker's list must not re-trigger its button. */}
      <div className="field">
        <span>Fonte</span>
        <FontPicker family={text.fontFamily} onChange={(fontFamily, fontSource) => onChange({ fontFamily, fontSource }, true)} />
      </div>
      <SliderRow label="Tamanho" min={10} max={400} step={1} value={text.fontSize} defaultValue={DEFAULT_TEXT.fontSize} onChange={(v, o) => onChange({ fontSize: v }, o.history)} />
      <div className="inline-fields">
        <label className="field compact">
          <span>Cor</span>
          <input type="color" value={text.color} onFocus={checkpoint} onChange={(e) => onChange({ color: e.target.value }, false)} />
        </label>
        <Toggle label="Negrito" checked={text.bold} onChange={(v) => onChange({ bold: v }, true)} />
        <Toggle label="Itálico" checked={text.italic} onChange={(v) => onChange({ italic: v }, true)} />
      </div>
      <div className="segmented">
        {(["left", "center", "right"] as const).map((a) => (
          <button key={a} className={text.align === a ? "active" : ""} onClick={() => onChange({ align: a }, true)}>
            {{ left: "Esquerda", center: "Centro", right: "Direita" }[a]}
          </button>
        ))}
      </div>
      <div className="inline-fields">
        <label className="field compact">
          <span>Contorno</span>
          <input type="color" value={text.strokeColor} onFocus={checkpoint} onChange={(e) => onChange({ strokeColor: e.target.value }, false)} />
        </label>
        <SliderRow label="Espessura" min={0} max={20} step={0.5} value={text.strokeWidth} defaultValue={DEFAULT_TEXT.strokeWidth} onChange={(v, o) => onChange({ strokeWidth: v }, o.history)} />
      </div>
      <div className="inline-fields">
        <Toggle label="Fundo" checked={text.background !== null} onChange={(v) => onChange({ background: v ? "#000000" : null }, true)} />
        {text.background !== null && (
          <input type="color" value={text.background} onFocus={checkpoint} onChange={(e) => onChange({ background: e.target.value }, false)} />
        )}
      </div>
    </Section>
  );
}
