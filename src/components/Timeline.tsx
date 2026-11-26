import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { useAiJob } from "../ai";
import { enhanceClip, processSound, removeBackground, reverseClip } from "../clipActions";
import { runAction, type ShortcutContext } from "../shortcuts";
import { VoiceoverDialog, stopVoiceover } from "./VoiceoverDialog";
import { AiVoiceDialog } from "./AiVoiceDialog";
import { DEFAULT_TRANSITION, MIN_ZOOM, timelineSpan, useEditor, zoomLimit } from "../store";
import type { Marker, MediaPreview, Micros, Project, Segment, Track } from "../model/types";
import { findSegment, nextAdjacent, projectDuration, segmentEnd, transitionWindow, valueAt } from "../model/project";
import { MAX_VOLUME } from "../model/types";
import { afterEdit, selectedIds, useUi, withGroups, withLinked } from "../ui";
import { ClipMenu, openClipMenu } from "./ClipMenu";
import { EFFECT_INFO, TRANSITION_INFO } from "../engine/catalog";
import { SECOND, shortTime } from "../model/time";
import { MATERIAL_DRAG } from "./Library";
import { Icon } from "./controls";
import { SHAPE_LABELS } from "./StickersTab";
import { MarkersPanel, addMarkerHere, openMarkers, useMarkerPanel } from "./Markers";
import { CropDialog, openCrop } from "./CropDialog";

const HEADER_W = 132;
const RULER_H = 26;
const ROW_H: Record<Track["kind"], number> = { video: 62, text: 34, audio: 46 };
const SNAP_PX = 8;
const ZOOM_STEP = 1.6;

/** Which part of the timeline is on screen. Zoomed in, drawing all of it would take millions of pixels. */
const useViewport = create<{ left: number; width: number }>(() => ({ left: 0, width: 1200 }));
/** Screens scrolled, in whole numbers: what is drawn only changes when this does. */
const usePage = () => useViewport((v) => Math.floor(v.left / Math.max(1, v.width)));
/** Lane pixels to draw around the visible part: one screen before it, two after. */
const drawnRange = (page: number, viewport: number) => [(page - 1) * viewport, (page + 3) * viewport] as const;

const toPx = (t: Micros, pps: number) => (t / SECOND) * pps;
const toTime = (px: number, pps: number): Micros => Math.round((px / pps) * SECOND);

export function Timeline() {
  const project = useEditor((s) => s.project);
  const selectedId = useEditor((s) => s.selectedId);
  const pps = useEditor((s) => s.pxPerSecond);
  const previews = useEditor((s) => s.previews);
  const pastLen = useEditor((s) => s.past.length);
  const futureLen = useEditor((s) => s.future.length);
  const { undo, redo, splitAt, addText, setZoom } = useEditor.getState();
  const ripple = useUi((s) => s.ripple);
  const multi = useUi((s) => s.multi);
  const setUi = useUi((s) => s.set);
  const selectedSet = new Set(selectedId ? [selectedId, ...multi] : []);
  const selectedFound = selectedId ? findSegment(project, selectedId) : null;
  const canDetach = Boolean(
    selectedFound?.track.kind === "video" && selectedFound.segment.materialId && project.materials[selectedFound.segment.materialId]?.hasAudio && selectedFound.segment.volume > 0,
  );
  const { tool, magnet, snap: snapOn, link, previewAxis } = useUi();
  const busy = useAiJob((s) => s.job !== null);
  const [recording, setRecording] = useState(false);
  const [aiVoice, setAiVoice] = useState(false);
  const voiceover = useUi((s) => s.voiceover);
  const capturing = voiceover === "countdown" || voiceover === "recording";
  const material = selectedFound?.segment.materialId ? project.materials[selectedFound.segment.materialId] : undefined;
  const media = Boolean(material);
  const isImage = material?.kind === "image";
  const isVideo = Boolean(material?.hasVideo && !isImage && selectedFound?.track.kind === "video");
  const visual = Boolean(selectedFound && selectedFound.track.kind !== "audio");
  const hasAudio = Boolean(material?.hasAudio && selectedFound && selectedFound.segment.volume > 0);
  const act = (id: string) => runAction(id, NO_CONTEXT);
  const markersOpen = useMarkerPanel((s) => s.open);
  // Crop on the picture: a box to drag over the whole frame of the selected clip.
  const focusCrop = () => openCrop(selectedId);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null);

  /**
   * Drag on empty timeline space: a box selects every clip it touches, like on the Windows desktop.
   * Ctrl/Shift adds to the current selection. Near the edges the timeline scrolls along.
   */
  const startMarquee = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const content = contentRef.current!;
    const scroll = scrollRef.current!;
    const local = (x: number, y: number) => {
      const r = content.getBoundingClientRect();
      return { x: x - r.left, y: y - r.top };
    };
    const origin = local(e.clientX, e.clientY);
    const additive = e.ctrlKey || e.shiftKey || e.metaKey;
    const base = additive ? selectedIds() : [];
    let pointer = { x: e.clientX, y: e.clientY };
    let moved = false;
    let last = "";
    let frame = 0;
    const update = () => {
      const p = local(pointer.x, pointer.y);
      const rect = { left: Math.min(origin.x, p.x), top: Math.min(origin.y, p.y), width: Math.abs(p.x - origin.x), height: Math.abs(p.y - origin.y) };
      setBox(rect);
      const cr = content.getBoundingClientRect();
      const hits = [...content.querySelectorAll<HTMLElement>(".segment[data-id]:not([data-locked])")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const l = r.left - cr.left;
          const t = r.top - cr.top;
          return l < rect.left + rect.width && l + r.width > rect.left && t < rect.top + rect.height && t + r.height > rect.top;
        })
        .map((el) => el.dataset.id!);
      const next = withGroups([...base, ...hits]);
      const key = next.join(",");
      if (key !== last) {
        last = key;
        useEditor.getState().selectMany(next);
      }
    };
    const tick = () => {
      // Keep scrolling while the pointer rests near an edge.
      const r = scroll.getBoundingClientRect();
      const edge = 28;
      let dx = 0;
      let dy = 0;
      if (pointer.x > r.right - edge) dx = 14;
      else if (pointer.x < r.left + HEADER_W + edge && scroll.scrollLeft > 0) dx = -14;
      if (pointer.y > r.bottom - edge) dy = 10;
      else if (pointer.y < r.top + edge && scroll.scrollTop > 0) dy = -10;
      if (dx || dy) {
        scroll.scrollLeft += dx;
        scroll.scrollTop += dy;
        update();
      }
      frame = requestAnimationFrame(tick);
    };
    const move = (ev: PointerEvent) => {
      pointer = { x: ev.clientX, y: ev.clientY };
      if (!moved) {
        if (Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
        moved = true;
        frame = requestAnimationFrame(tick);
      }
      update();
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      cancelAnimationFrame(frame);
      setBox(null);
      // A plain click on empty space clears the selection.
      if (!moved && !additive) useEditor.getState().select(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const duration = projectDuration(project);
  const viewportWidth = useViewport((v) => v.width);
  // Zoomed far out the content still fills the panel, so there is room to click and drag a box.
  const width = Math.max(toPx(timelineSpan(project), pps), viewportWidth - HEADER_W);
  const maxZoom = zoomLimit(project);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => useViewport.setState({ width: el.clientWidth, left: el.scrollLeft });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // The project grew past what this zoom can lay out.
  useEffect(() => {
    if (pps > maxZoom) setZoom(pps);
  }, [pps, maxZoom, setZoom]);

  /** Timeline time under a viewport x coordinate. */
  const timeAt = (clientX: number) => {
    const rect = contentRef.current!.getBoundingClientRect();
    return Math.max(0, toTime(clientX - rect.left - HEADER_W, pps));
  };

  // However the zoom changes, the playhead holds its place on screen; if it was out of view it comes to the middle.
  const zoomedFrom = useRef(pps);
  useLayoutEffect(() => {
    const before = zoomedFrom.current;
    zoomedFrom.current = pps;
    const scroll = scrollRef.current;
    if (!scroll || before === pps) return;
    const time = useEditor.getState().playhead;
    const lanes = scroll.clientWidth - HEADER_W;
    const onScreen = toPx(time, before) - scroll.scrollLeft;
    scroll.scrollLeft = toPx(time, pps) - (onScreen >= 0 && onScreen <= lanes ? onScreen : lanes / 2);
  }, [pps]);

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(pps * (e.deltaY < 0 ? 1.3 : 1 / 1.3));
  };

  const fitZoom = () => {
    const visible = (scrollRef.current?.clientWidth ?? 800) - HEADER_W - 40;
    setZoom(duration > 0 ? visible / (duration / SECOND) : 80);
  };

  return (
    <section className="panel timeline">
      <CropDialog />
      <MarkersPanel />
      <div className="timeline-toolbar">
        <div className="tool-switch" title="Ferramenta">
          <button className={tool === "select" ? "toggle-on" : ""} onClick={() => setUi({ tool: "select" })} title="Selecionar e mover">
            <Icon name="cursor" />
          </button>
          <button className={tool === "blade" ? "toggle-on" : ""} onClick={() => setUi({ tool: "blade" })} title="Lâmina: clique num clipe para dividir ali; perto da agulha, divide exatamente na agulha (B)">
            <Icon name="blade" />
          </button>
        </div>
        <span className="sep" />
        <button onClick={undo} disabled={!pastLen} title="Desfazer (Ctrl+Z)">
          <Icon name="undo" />
        </button>
        <button onClick={redo} disabled={!futureLen} title="Refazer (Ctrl+Y)">
          <Icon name="redo" />
        </button>
        <span className="sep" />
        <button onClick={() => splitAt(useEditor.getState().playhead)} title="Dividir na agulha (S ou Ctrl+B): corta todos os clipes sob a agulha, ou só o selecionado">
          <Icon name="split" />
        </button>
        <button onClick={() => act("deleteLeft")} disabled={!media} title="Excluir à esquerda do cursor (Q)">
          <Icon name="deleteLeft" />
        </button>
        <button onClick={() => act("deleteRight")} disabled={!media} title="Excluir à direita do cursor (W)">
          <Icon name="deleteRight" />
        </button>
        <button onClick={() => act("delete")} disabled={!selectedId} title="Excluir (Delete)">
          <Icon name="trash" />
        </button>
        <button data-markers-button onClick={(e) => addMarkerHere(e.currentTarget)} title="Marcar este ponto para voltar depois (M)">
          <Icon name="marker" />
        </button>
        <button
          data-markers-button
          className={`markers-count${markersOpen ? " toggle-on" : ""}`}
          onClick={(e) => (markersOpen ? useMarkerPanel.getState().set({ open: false, editing: null }) : openMarkers(e.currentTarget))}
          title="Lista de marcadores: ir, renomear, anotar o motivo"
        >
          {project.markers.length}
        </button>
        <span className="sep" />
        <button onClick={() => act("freeze")} disabled={!isVideo} title="Congelar quadro: insere 3 s da imagem sob o cursor (Shift+F)">
          <Icon name="freeze" />
        </button>
        <button onClick={() => selectedId && void reverseClip(selectedId)} disabled={!media || isImage || busy} title="Inverter (tocar de trás para frente)">
          <Icon name="reverse" />
        </button>
        <button onClick={() => act("mirror")} disabled={!visual} title="Espelhar">
          <Icon name="mirror" />
        </button>
        <button onClick={() => act("rotate")} disabled={!visual} title="Girar 90°">
          <Icon name="rotate" />
        </button>
        <button onClick={focusCrop} disabled={!visual || !media} title="Recortar o vídeo (deixar só uma parte da imagem, por exemplo a webcam sem o fundo)">
          <Icon name="crop" />
        </button>
        <span className="sep" />
        <button onClick={() => selectedId && void removeBackground(selectedId)} disabled={!visual || !media || busy} title="Remover fundo (pessoas)">
          <Icon name="person" />
        </button>
        <button onClick={() => void processSound(selectedIds(), "denoise")} disabled={!hasAudio || busy} title="Reduzir ruído do áudio (todos os clipes selecionados)">
          <Icon name="denoise" />
        </button>
        <button onClick={() => selectedId && void enhanceClip(selectedId)} disabled={!isVideo || busy} title="Melhorar qualidade (nitidez e resolução)">
          <Icon name="hd" />
        </button>
        <button onClick={() => selectedId && useEditor.getState().detachAudio(selectedId)} disabled={!canDetach} title="Separar áudio do vídeo (Ctrl+Shift+D)">
          <Icon name="detach" />
        </button>
        <button onClick={() => addText()} title="Adicionar texto (T)">
          <Icon name="text" />
        </button>
        <div className="grow" />
        <button
          className={capturing ? "recording-on" : ""}
          disabled={voiceover === "saving"}
          onClick={() => (capturing ? stopVoiceover() : setRecording(true))}
          title={capturing ? "Parar e inserir a narração" : "Gravar narração"}
        >
          <Icon name="mic" />
        </button>
        <button className="ai-voice-button" onClick={() => setAiVoice(true)} title="Voz de IA: a IA fala o que você escrever (narração ou gancho com prévia de fundo)">
          IA
        </button>
        <span className="sep" />
        <button className={magnet ? "toggle-on" : ""} onClick={() => act("magnet")} title="Ímã da faixa principal: os clipes da faixa de baixo ficam sempre colados (Shift+N)">
          <Icon name="magnet" />
        </button>
        <button className={snapOn ? "toggle-on" : ""} onClick={() => act("snap")} title="Encaixe automático (N)">
          <Icon name="snap" />
        </button>
        <button className={link ? "toggle-on" : ""} onClick={() => setUi({ link: !link })} title="Vínculo: vídeo e áudio separado andam juntos">
          <Icon name="link" />
        </button>
        <button className={previewAxis ? "toggle-on" : ""} onClick={() => setUi({ previewAxis: !previewAxis, skim: null })} title="Eixo de pré-visualização: passe o mouse na timeline para ver aquele momento">
          <Icon name="previewAxis" />
        </button>
        <button className={ripple ? "toggle-on" : ""} onClick={() => setUi({ ripple: !ripple })} title="Edição em cascata: excluir ou encurtar um clipe puxa os seguintes da mesma faixa (R)">
          <Icon name="ripple" />
        </button>
        <span className="sep" />
        <button onClick={fitZoom} title="Ajustar à janela">
          Ajustar
        </button>
        <button className="zoom-step" onClick={() => setZoom(pps / ZOOM_STEP)} disabled={pps <= MIN_ZOOM} title="Menos zoom (Ctrl + rolar o mouse)">
          −
        </button>
        <input type="range" min={Math.log(MIN_ZOOM)} max={Math.log(maxZoom)} step={0.01} value={Math.log(pps)} onChange={(e) => setZoom(Math.exp(Number(e.target.value)))} title="Zoom da timeline" />
        <button className="zoom-step" onClick={() => setZoom(pps * ZOOM_STEP)} disabled={pps >= maxZoom} title="Mais zoom (Ctrl + rolar o mouse)">
          +
        </button>
      </div>
      <div
        className={`timeline-scroll${tool === "blade" ? " blade-mode" : ""}`}
        ref={scrollRef}
        onWheel={onWheel}
        onScroll={(e) => useViewport.setState({ left: e.currentTarget.scrollLeft })}
        onPointerMove={(e) => {
          if (previewAxis && !e.buttons && contentRef.current) useUi.getState().set({ skim: timeAt(e.clientX) });
        }}
        onPointerLeave={() => previewAxis && useUi.getState().set({ skim: null })}
      >
        <div
          className="timeline-content"
          ref={contentRef}
          style={{ width: width + HEADER_W }}
          onPointerDown={(e) => {
            // The free area under the tracks also starts a selection box.
            const el = e.target as HTMLElement;
            if (el === e.currentTarget || el.closest(".new-track-zone")) startMarquee(e);
          }}
        >
          <Ruler width={width} pps={pps} timeAt={timeAt} markers={project.markers} scrollRef={scrollRef} />
          {project.tracks.map((track) => (
            <TrackRow key={track.id} track={track} project={project} previews={previews} pps={pps} selected={selectedSet} timeAt={timeAt} onEmptyPointerDown={startMarquee} />
          ))}
          {project.markers.map((m) => (
            <div key={m.id} className="marker-line" style={{ left: HEADER_W + toPx(m.time, pps), borderColor: m.color }} />
          ))}
          <NewTrackDropZone timeAt={timeAt} />
          <Playhead pps={pps} scrollRef={scrollRef} />
          {previewAxis && <SkimLine pps={pps} />}
          {box && <div className="marquee" style={box} />}
        </div>
      </div>
      <ClipMenu />
      {recording && <VoiceoverDialog onClose={() => setRecording(false)} />}
      {aiVoice && <AiVoiceDialog onClose={() => setAiVoice(false)} />}
    </section>
  );
}

/** Thin line where the preview axis is pointing. */
function SkimLine({ pps }: { pps: number }) {
  const skim = useUi((s) => s.skim);
  if (skim === null) return null;
  return <div className="skim-line" style={{ left: HEADER_W + toPx(skim, pps) }} />;
}

/** Toolbar actions never need the App-level callbacks (save/open/export). */
const NO_CONTEXT: ShortcutContext = { save() {}, open() {}, exportVideo() {}, showShortcuts() {} };

/** "1:05", or "1:05.25" where the marks are closer than a second. */
function rulerLabel(seconds: number, major: number) {
  const whole = Math.round(seconds);
  const exact = Math.abs(seconds - whole) < 1e-6;
  const base = exact ? whole : Math.floor(seconds);
  const minutes = Math.floor(base / 60);
  const secs = String(base - minutes * 60).padStart(2, "0");
  if (exact) return `${minutes}:${secs}`;
  return `${minutes}:${secs}.${(seconds - base).toFixed(major === 0.1 || major === 0.5 ? 1 : 2).slice(2)}`;
}

function Ruler({ width, pps, timeAt, markers, scrollRef }: { width: number; pps: number; timeAt: (x: number) => Micros; markers: Marker[]; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const { removeMarker } = useEditor.getState();
  // Pick a label interval that keeps labels ~80px apart.
  const steps = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];
  const major = steps.find((s) => s * pps >= 80) ?? 7200;
  const minor = major / 5;
  const page = usePage();
  const viewport = useViewport((v) => v.width);
  const ticks = useMemo(() => {
    const out: { i: number; x: number; label?: string }[] = [];
    const [from, to] = drawnRange(page, viewport);
    const step = minor * pps;
    const first = Math.max(0, Math.floor(from / step));
    const last = Math.ceil(Math.min(to, width) / step);
    for (let i = first; i <= last; i++) {
      const sec = i * minor;
      out.push({ i, x: sec * pps, label: i % 5 === 0 ? rulerLabel(sec, major) : undefined });
    }
    return out;
  }, [width, pps, minor, major, page, viewport]);

  const scrub = (e: React.PointerEvent) => {
    useEditor.getState().setPlaying(false);
    // With snapping on, the playhead catches clip starts and ends (and markers) when it comes close.
    const { project } = useEditor.getState();
    const edges = useUi.getState().snap ? [0, ...project.markers.map((m) => m.time), ...project.tracks.flatMap((t) => t.segments.flatMap((s) => [s.start, segmentEnd(s)]))] : [];
    const near = toTime(PLAYHEAD_SNAP_PX, pps);
    const at = (x: number) => {
      const t = timeAt(x);
      return edges.length ? snap(t, edges, near).value : t;
    };
    setPlayhead(at(e.clientX));
    const scroll = scrollRef.current!;
    const edge = 40;
    let pointer = e.clientX;
    let frame = 0;
    /** The playhead follows the pointer only inside the track area; at its edges the timeline scrolls instead. */
    const update = () => {
      const r = scroll.getBoundingClientRect();
      const left = r.left + HEADER_W;
      const right = r.left + scroll.clientWidth;
      const depth = pointer < left + edge ? pointer - (left + edge) : pointer > right - edge ? pointer - (right - edge) : 0;
      if (depth) scroll.scrollLeft += Math.sign(depth) * Math.min(60, 4 + Math.abs(depth) / 3);
      setPlayhead(at(Math.max(left, Math.min(right - 1, pointer))));
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    const move = (ev: PointerEvent) => {
      pointer = ev.clientX;
    };
    const up = () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div className="ruler-row" style={{ height: RULER_H }}>
      <div className="track-header ruler-corner" style={{ width: HEADER_W }}>
        <AddTrackButton />
      </div>
      <div className="ruler" style={{ width }} onPointerDown={scrub}>
        {ticks.map((t) => (
          <div key={t.i} className={`tick${t.label ? " major" : ""}`} style={{ left: t.x }}>
            {t.label && <span>{t.label}</span>}
          </div>
        ))}
        {markers.map((m) => (
          <div
            key={m.id}
            className="marker-flag"
            style={{ left: toPx(m.time, pps), background: m.color }}
            title={`${m.label}${m.note ? `\n${m.note}` : ""}\nClique para ir, duplo clique para editar, botão direito para apagar`}
            onPointerDown={(e) => {
              e.stopPropagation();
              setPlayhead(m.time);
            }}
            onDoubleClick={(e) => openMarkers(e.currentTarget, m.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              removeMarker(m.id);
            }}
          >
            <span>{m.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Playhead({ pps, scrollRef }: { pps: number; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const x = HEADER_W + toPx(playhead, pps);
  // Subscribed so it redraws on scroll; the position itself is read live, the store trails by a frame while scrolling.
  useViewport((v) => v.left);
  const viewport = useViewport((v) => v.width);
  const scrolled = scrollRef.current?.scrollLeft ?? 0;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !playing) return;
    // While playing, the timeline scrolls under the playhead and keeps it in the middle of the track area
    // (from the start it walks to the middle first; near the end the timeline runs out and it walks on).
    const centred = x - HEADER_W - (el.clientWidth - HEADER_W) / 2;
    const outside = x < el.scrollLeft + HEADER_W || x > el.scrollLeft + el.clientWidth;
    if (useUi.getState().playReverse) {
      if (outside || centred < el.scrollLeft) el.scrollLeft = Math.max(0, centred);
    } else if (outside || centred > el.scrollLeft) el.scrollLeft = Math.max(0, centred);
  }, [x, playing, scrollRef]);
  // Scrolled out of view it would slide over the track names.
  if (x < scrolled + HEADER_W - 1 || x > scrolled + viewport + 1) return null;
  return <div className="playhead" style={{ left: x }} />;
}

/** Set while a track header is being dragged, so the click that ends the drag does not select the track. */
let trackDragged = false;

/** Drag a track header up or down: a line shows where it lands, the track moves on release. */
function beginTrackDrag(e: React.PointerEvent, trackId: string) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
  const header = e.currentTarget as HTMLElement;
  const list = header.closest(".track-row")?.parentElement;
  if (!list) return;
  const startY = e.clientY;
  let target = -1;
  let line: HTMLDivElement | null = null;
  trackDragged = false;
  const rows = () => [...list.querySelectorAll<HTMLElement>(":scope > .track-row")];
  const move = (ev: PointerEvent) => {
    if (!trackDragged && Math.abs(ev.clientY - startY) < 6) return;
    if (!trackDragged) {
      trackDragged = true;
      header.closest(".track-row")?.classList.add("track-dragging");
      line = document.createElement("div");
      line.className = "track-drop-line";
      list.appendChild(line);
    }
    const all = rows();
    target = all.length;
    for (const [i, row] of all.entries()) {
      const r = row.getBoundingClientRect();
      if (ev.clientY < r.top + r.height / 2) {
        target = i;
        break;
      }
    }
    const ref = all[Math.min(target, all.length - 1)];
    if (line && ref) line.style.top = `${(target < all.length ? ref.offsetTop : ref.offsetTop + ref.offsetHeight) - 1}px`;
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    line?.remove();
    header.closest(".track-row")?.classList.remove("track-dragging");
    if (trackDragged && target >= 0) {
      const { project, moveTrack } = useEditor.getState();
      const from = project.tracks.findIndex((t) => t.id === trackId);
      // Removing it first shifts the rows below it up by one.
      if (from >= 0 && target !== from && target !== from + 1) moveTrack(trackId, target > from ? target - 1 : target);
    }
    // The click event comes right after pointerup.
    setTimeout(() => (trackDragged = false), 0);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

interface RowProps {
  track: Track;
  project: Project;
  previews: Record<string, MediaPreview>;
  pps: number;
  selected: Set<string>;
  timeAt: (clientX: number) => Micros;
  onEmptyPointerDown: (e: React.PointerEvent) => void;
}

function TrackRow({ track, project, previews, pps, selected, timeAt, onEmptyPointerDown }: RowProps) {
  const { updateTrack, addMaterialToTimeline, removeTrack } = useEditor.getState();
  const isMain = [...project.tracks].reverse().find((t) => t.kind === "video") === track;
  const height = ROW_H[track.kind];
  return (
    <div className={`track-row kind-${track.kind}${track.hidden ? " is-hidden" : ""}`} style={{ height }}>
      <div
        className="track-header"
        style={{ width: HEADER_W }}
        title="Clique para selecionar a faixa inteira (Ctrl+clique soma à seleção). Arraste para cima ou para baixo para mudar a ordem."
        onPointerDown={(e) => beginTrackDrag(e, track.id)}
        onClick={(e) => {
          if ((e.target as HTMLElement).closest("button") || trackDragged) return;
          const ids = track.segments.map((s) => s.id);
          if (!ids.length) return;
          const st = useEditor.getState();
          st.selectMany(e.ctrlKey || e.shiftKey || e.metaKey ? [...new Set([...selectedIds(), ...ids])] : ids);
        }}
      >
        <span className="track-name">{track.name}</span>
        <div className="track-buttons">
          {track.kind !== "audio" && (
            <button onClick={() => updateTrack(track.id, { hidden: !track.hidden })} title={track.hidden ? "Mostrar" : "Ocultar"}>
              <Icon name={track.hidden ? "eyeOff" : "eye"} />
            </button>
          )}
          {track.kind !== "text" && (
            <button onClick={() => updateTrack(track.id, { muted: !track.muted })} title={track.muted ? "Ativar som" : "Silenciar"}>
              <Icon name={track.muted ? "mute" : "volume"} />
            </button>
          )}
          <button onClick={() => updateTrack(track.id, { locked: !track.locked })} title={track.locked ? "Desbloquear" : "Bloquear"}>
            <Icon name={track.locked ? "lock" : "unlock"} />
          </button>
          {!isMain && !track.locked && (
            <button
              className="track-delete"
              onClick={() => (!track.segments.length || confirm(`Excluir a faixa "${track.name}" com ${track.segments.length} clipe(s)? Os outros clipes não mudam. Ctrl+Z desfaz.`)) && removeTrack(track.id)}
              title="Excluir esta faixa (só ela; o vídeo e as outras faixas ficam)"
            >
              <Icon name="trash" />
            </button>
          )}
        </div>
      </div>
      <div
        className="lane"
        data-track-id={track.id}
        onPointerDown={(e) => {
          if (e.target === e.currentTarget) onEmptyPointerDown(e);
        }}
        onContextMenu={(e) => {
          if (e.target !== e.currentTarget) return;
          e.preventDefault();
          openClipMenu({ x: e.clientX, y: e.clientY, kind: "lane", trackId: track.id, time: timeAt(e.clientX) });
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(MATERIAL_DRAG)) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
          }
        }}
        onDrop={(e) => {
          const id = e.dataTransfer.getData(MATERIAL_DRAG);
          if (!id) return;
          e.preventDefault();
          addMaterialToTimeline(id, { trackId: track.id, start: timeAt(e.clientX) });
        }}
      >
        {track.segments.map((s) => (
          <SegmentBlock key={s.id} segment={s} track={track} project={project} preview={s.materialId ? previews[s.materialId] : undefined} pps={pps} selected={selected.has(s.id)} timeAt={timeAt} />
        ))}
        {track.kind === "video" && <CutMarkers track={track} pps={pps} />}
      </div>
    </div>
  );
}

/** A button on every cut between touching clips: adds a dissolve, or selects the existing transition. */
function CutMarkers({ track, pps }: { track: Track; pps: number }) {
  const { setTransition, select } = useEditor.getState();
  return (
    <>
      {track.segments.map((s, i) => {
        if (!nextAdjacent(track, i)) return null;
        const w = transitionWindow(track, i);
        const cutX = toPx(segmentEnd(s), pps);
        return (
          <div key={`cut-${s.id}`}>
            {w && <div className="transition-band" style={{ left: toPx(w.start, pps), width: toPx(w.end - w.start, pps) }} />}
            <button
              className={`cut-marker${w ? " has-transition" : ""}`}
              style={{ left: cutX }}
              title={w ? `${TRANSITION_INFO[s.transition!.type].label} · ${shortTime(w.end - w.start)}` : "Adicionar transição"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                if (!track.locked && !s.transition) setTransition(s.id, { type: "fade", duration: DEFAULT_TRANSITION });
                select(s.id);
              }}
            >
              <Icon name="transition" />
            </button>
          </div>
        );
      })}
    </>
  );
}

function NewTrackDropZone({ timeAt }: { timeAt: (x: number) => Micros }) {
  const addMaterialToTimeline = useEditor((s) => s.addMaterialToTimeline);
  return (
    <div
      className="new-track-zone"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(MATERIAL_DRAG)) e.preventDefault();
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData(MATERIAL_DRAG);
        if (!id) return;
        e.preventDefault();
        addMaterialToTimeline(id, { start: timeAt(e.clientX), newTrack: true });
      }}
    >
      <div style={{ width: HEADER_W }} />
      <span>Solte aqui um clipe ou uma mídia para criar uma nova faixa (empilhar)</span>
    </div>
  );
}

/** How close (on screen) the playhead has to come to a clip edge to catch it. */
const PLAYHEAD_SNAP_PX = 8;

/** "+ Faixa": an empty video, audio or text track, made whenever the creator wants one. */
function AddTrackButton() {
  const [open, setOpen] = useState(false);
  const add = (kind: "video" | "audio" | "text") => {
    useEditor.getState().addTrack(kind);
    setOpen(false);
  };
  return (
    <div className="add-track">
      <button className="add-track-btn" onClick={() => setOpen(!open)} title="Criar uma faixa nova (fica mesmo vazia; arraste clipes para ela)">
        <Icon name="plus" /> Faixa
      </button>
      {open && (
        <>
          <div className="add-track-shade" onClick={() => setOpen(false)} />
          <div className="add-track-menu">
            <button onClick={() => add("video")}>Faixa de vídeo</button>
            <button onClick={() => add("audio")}>Faixa de áudio</button>
            <button onClick={() => add("text")}>Faixa de texto</button>
          </div>
        </>
      )}
    </div>
  );
}

function snapPoints(project: Project, ignore: Set<string>): Micros[] {
  const pts = [0, useEditor.getState().playhead, ...project.markers.map((m) => m.time)];
  for (const t of project.tracks) for (const s of t.segments) if (!ignore.has(s.id)) pts.push(s.start, segmentEnd(s));
  return pts;
}

function snap(value: Micros, points: Micros[], threshold: Micros): { value: Micros; snapped: boolean } {
  let best = value;
  let dist = threshold;
  for (const p of points) {
    const d = Math.abs(p - value);
    if (d < dist) {
      dist = d;
      best = p;
    }
  }
  return { value: best, snapped: best !== value || dist === 0 };
}

interface BlockProps {
  segment: Segment;
  track: Track;
  project: Project;
  preview?: MediaPreview;
  pps: number;
  selected: boolean;
  timeAt: (clientX: number) => Micros;
}

function SegmentBlock({ segment, track, project, preview, pps, selected, timeAt }: BlockProps) {
  const material = segment.materialId ? project.materials[segment.materialId] : undefined;
  const left = toPx(segment.start, pps);
  const width = Math.max(4, toPx(segment.duration, pps));

  const beginGesture = (e: React.PointerEvent, mode: "move" | "start" | "end") => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const state = useEditor.getState();
    const ui = useUi.getState();
    // Ctrl/Shift+click adds or removes a clip (with its group) from the selection without dragging.
    if ((e.ctrlKey || e.shiftKey || e.metaKey) && mode === "move") {
      const current = selectedIds();
      const members = withGroups([segment.id]);
      const all = members.every((id) => current.includes(id));
      state.selectMany(all ? current.filter((id) => !members.includes(id)) : [...current, ...members]);
      return;
    }
    // Blade tool: a click splits the clip where it lands.
    if (ui.tool === "blade" && mode === "move") {
      if (!track.locked) {
        const at = timeAt(e.clientX);
        const head = state.playhead;
        state.splitAt(Math.abs(at - head) <= toTime(12, pps) ? head : at, segment.id);
      }
      return;
    }
    let selection = selectedIds();
    const selectedGroup = selection.length > 1 && selection.includes(segment.id);
    if (!selectedGroup) {
      // A grouped clip brings its whole group into the selection.
      selection = withGroups([segment.id]);
      state.selectMany(selection);
    }
    if (track.locked) return;
    // A selection, or a clip with its linked partner, moves together in time.
    const group = withLinked(selection);
    const inGroup = group.length > 1;
    const grabOffset = timeAt(e.clientX) - segment.start;
    // An edge follows the pointer from where it was grabbed: the handle sits a few pixels inside the clip, and
    // jumping to the pointer used to cut the clip short (and drop its last keyframe) on the first move.
    const edgeGrab = mode === "end" ? timeAt(e.clientX) - segmentEnd(segment) : mode === "start" ? grabOffset : 0;
    const base = { start: segment.start, keyframes: structuredClone(segment.keyframes) };
    const points = snapPoints(state.project, new Set(inGroup && mode === "move" ? group : [segment.id]));
    const threshold = ui.snap ? toTime(SNAP_PX, pps) : 0;
    const originX = e.clientX;
    const originY = e.clientY;
    let started = false;
    /** The track this drag created (dropping on the new-track zone), so it is made once. */
    let created: string | null = null;
    let dropAt: Micros | null = null;

    const move = (ev: PointerEvent) => {
      if (!started) {
        if (Math.abs(ev.clientX - originX) < 3 && Math.abs(ev.clientY - originY) < 3 && mode === "move") return;
        started = true;
        useEditor.getState().checkpoint();
      }
      const t = timeAt(ev.clientX);
      const st = useEditor.getState();
      if (mode === "move") {
        const under = document.elementsFromPoint(ev.clientX, ev.clientY) as HTMLElement[];
        const lane = under.find((el) => el.dataset?.trackId);
        // Over "Solte aqui para criar uma nova faixa": the clip goes to a track of its own (stacked over the others).
        const overNew = under.some((el) => el.classList?.contains("new-track-zone"));
        const current = st.project.tracks.find((tr) => tr.segments.some((s) => s.id === segment.id));
        const dur = current?.segments.find((s) => s.id === segment.id)?.duration ?? segment.duration;
        let start = t - grabOffset;
        const a = snap(start, points, threshold);
        const b = snap(start + dur, points, threshold);
        if (a.snapped && (!b.snapped || Math.abs(a.value - start) <= Math.abs(b.value - start - dur))) start = a.value;
        else if (b.snapped) start = b.value - dur;
        dropAt = start;
        // The clip under the pointer can change track; its linked audio and the rest of the selection follow in time.
        const target = overNew ? (created ?? "new") : (lane?.dataset.trackId ?? current?.id ?? track.id);
        const mainId = [...st.project.tracks].reverse().find((tr) => tr.kind === "video")?.id;
        const stack = !(useUi.getState().magnet && target === mainId);
        const landed = st.moveClip(segment.id, start, target, inGroup ? group : [], { stack });
        if (target === "new" && landed) created = landed;
      } else {
        const ui = useUi.getState();
        // On the main track with the magnet the clip stays glued: its start edge stays put while more of the media
        // comes in, so it follows how far the pointer moved (it can go past 0) and doesn't snap.
        const glued = ui.magnet && [...st.project.tracks].reverse().find((tr) => tr.kind === "video")?.id === track.id;
        const at = mode === "start" ? segment.start + toTime(ev.clientX - originX, pps) : t - edgeGrab;
        st.trimSegment(segment.id, mode, glued && mode === "start" ? at : snap(at, points, threshold).value, ui.ripple, base, { magnet: ui.magnet, link: ui.link });
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (started && mode === "move") {
        const st = useEditor.getState();
        // With the magnet the main track stays glued: a clip dropped on it takes the place where it was let go.
        const main = [...st.project.tracks].reverse().find((tr) => tr.kind === "video");
        const moved = new Set(inGroup ? group : [segment.id]);
        const onMain = main ? main.segments.filter((s) => moved.has(s.id)) : [];
        // Dropped in empty space (nothing of the main track under it): it stays exactly there, black around it if
        // that is what the creator wants. Only the hole it left behind closes.
        // The clip really is where the pointer let it go (over another clip the move is refused and the order changes instead).
        const here = main?.segments.find((s) => s.id === segment.id);
        const free = onMain.length > 0 && here !== undefined && dropAt !== null && Math.abs(here.start - dropAt) < SECOND / 20;
        if (free) {
          st.dropEmptyTracks();
          afterEdit(onMain.map((s) => s.id));
          return;
        }
        if (useUi.getState().magnet && main && dropAt !== null && main.segments.some((s) => s.id === segment.id)) {
          const others = main.segments.filter((s) => s.id !== segment.id).sort((x, y) => x.start - y.start);
          const centre = dropAt + segment.duration / 2;
          const at = others.filter((s) => s.start + s.duration / 2 < centre).length;
          const order = [...others.slice(0, at).map((s) => s.id), segment.id, ...others.slice(at).map((s) => s.id)];
          const now = [...main.segments].sort((x, y) => x.start - y.start).map((s) => s.id);
          if (order.join() !== now.join()) st.reorderClips(main.id, order);
        }
        st.dropEmptyTracks();
      }
      if (started || mode !== "move") afterEdit();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  // Keyframe diamonds: click puts the playhead on them, drag moves them in time, double click deletes them.
  const grabKeyframe = (e: React.PointerEvent, time: Micros) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const st = useEditor.getState();
    if (!selectedIds().includes(segment.id)) st.selectMany(withGroups([segment.id]));
    const originX = e.clientX;
    let at = time;
    let started = false;
    const move = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - originX) < 3) return;
      if (!started) {
        started = true;
        useEditor.getState().checkpoint();
      }
      const next = time + timeAt(ev.clientX) - timeAt(originX);
      at = useEditor.getState().moveKeyframes(segment.id, at, next, { history: false });
      useEditor.getState().setPlayhead(segment.start + at);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (started) afterEdit();
      else useEditor.getState().setPlayhead(segment.start + time);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const keyframeTimes = useMemo(() => {
    const set = new Set<number>();
    for (const frames of Object.values(segment.keyframes)) for (const k of frames ?? []) set.add(k.time);
    return [...set];
  }, [segment.keyframes]);

  const label = segment.adjustLayer
    ? "Camada de ajuste"
    : segment.text
    ? segment.text.content.split("\n")[0]
    : segment.sticker
      ? `Sticker ${segment.sticker.emoji}`
      : segment.shape
        ? `Forma · ${SHAPE_LABELS[segment.shape.kind]}`
        : material?.name ?? "mídia ausente";
  const overlay = Boolean(segment.text || segment.shape || segment.sticker || segment.adjustLayer);
  const style: React.CSSProperties = { left, width };
  if (track.kind === "video" && preview?.thumbnail) style.backgroundImage = `url(${preview.thumbnail})`;

  return (
    <div
      className={`segment kind-${track.kind}${selected ? " selected" : ""}${segment.groupId ? " grouped" : ""}${material || overlay ? "" : " missing"}${material?.pending ? " pending" : ""}`}
      style={style}
      data-id={segment.id}
      data-locked={track.locked ? "" : undefined}
      onPointerDown={(e) => beginGesture(e, "move")}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!selectedIds().includes(segment.id)) useEditor.getState().selectMany(withGroups([segment.id]));
        openClipMenu({ x: e.clientX, y: e.clientY, kind: "clip", trackId: track.id, time: timeAt(e.clientX) });
      }}
      title={`${label} · ${shortTime(segment.duration)}${segment.speed !== 1 ? ` · ${segment.speed}×` : ""}`}
    >
      {track.kind === "audio" || (track.kind === "video" && material?.hasAudio && width > 60) ? (
        <Waveform segment={segment} preview={preview} width={width} left={left} compact={track.kind === "video"} />
      ) : null}
      <span className="segment-label">
        {segment.groupId && (
          <i className="group-badge" title="Agrupado (Ctrl+Shift+G desagrupa)">
            <Icon name="group" />
          </i>
        )}
        {segment.effects.length > 0 && <i className="fx-badge" title={segment.effects.map((e) => EFFECT_INFO[e.type].label).join(", ")}>fx</i>}
        {segment.speed !== 1 && <b>{segment.speed}× </b>}
        {label}
        {material?.pending && <em className="segment-pending"> · preparando…</em>}
      </span>
      {segment.keyframes.volume && segment.keyframes.volume.length > 0 && <VolumeLine segment={segment} width={width} pps={pps} />}
      {keyframeTimes.map((t) => (
        <span
          key={t}
          className="kf-marker"
          style={{ left: toPx(t, pps) }}
          title="Keyframe · clique para ir até ele, arraste para mudar o tempo, duplo clique apaga"
          onPointerDown={(e) => grabKeyframe(e, t)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            useEditor.getState().removeKeyframesAt(segment.id, t);
            afterEdit();
          }}
        />
      ))}
      {(segment.fadeIn > 0 || segment.fadeOut > 0) && (
        <>
          {segment.fadeIn > 0 && <FadeMark at={0} width={Math.min(width, toPx(segment.fadeIn, pps))} rising />}
          {segment.fadeOut > 0 && <FadeMark at={width - Math.min(width, toPx(segment.fadeOut, pps))} width={Math.min(width, toPx(segment.fadeOut, pps))} />}
        </>
      )}
      <div className="handle left" onPointerDown={(e) => beginGesture(e, "start")} />
      <div className="handle right" onPointerDown={(e) => beginGesture(e, "end")} />
    </div>
  );
}

/** The volume over the clip when it follows keyframes: high at the top of the clip, silent at the bottom. */
function VolumeLine({ segment, width, pps }: { segment: Segment; width: number; pps: number }) {
  const frames = segment.keyframes.volume!;
  const steps = Math.max(2, Math.min(400, Math.round(width / 4)));
  const points: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const local = (segment.duration * i) / steps;
    const v = Math.min(MAX_VOLUME, Math.max(0, valueAt(segment, "volume", local)));
    points.push(`${toPx(local, pps).toFixed(1)},${(100 - (v / MAX_VOLUME) * 100).toFixed(1)}`);
  }
  const top = Math.max(...frames.map((k) => k.value)) * 100;
  return (
    <svg className="volume-line" width={width} viewBox={`0 0 ${width} 100`} preserveAspectRatio="none">
      <title>{`Volume com keyframes (até ${Math.round(top)}%)`}</title>
      <polyline points={points.join(" ")} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function FadeMark({ at, width, rising }: { at: number; width: number; rising?: boolean }) {
  return (
    <svg className="fade-overlay" style={{ left: at, right: "auto", width }} height="100%" preserveAspectRatio="none" viewBox={`0 0 ${width} 10`}>
      <polygon points={rising ? `0,10 0,0 ${width},0` : `${width},10 ${width},0 0,0`} />
    </svg>
  );
}

function Waveform({ segment, preview, width, left, compact }: { segment: Segment; preview?: MediaPreview; width: number; left: number; compact: boolean }) {
  const wf = preview?.waveform;
  const page = usePage();
  const viewport = useViewport((v) => v.width);
  // Only the bars near the screen: a long clip zoomed in is far wider than an SVG can be.
  const [from, to] = drawnRange(page, viewport);
  const firstBar = Math.max(0, Math.floor((from - left) / 3));
  const lastBar = Math.min(Math.floor(width / 3), Math.ceil((to - left) / 3));
  const shownBars = lastBar - firstBar;
  const path = useMemo(() => {
    if (!wf) return "";
    const bars = Math.max(1, Math.floor(width / 3));
    const startIdx = (segment.sourceStart / SECOND) * wf.perSecond;
    const span = ((segment.duration * segment.speed) / SECOND) * wf.perSecond;
    let d = "";
    for (let i = firstBar; i < lastBar; i++) {
      const a = Math.floor(startIdx + (span * i) / bars);
      const b = Math.max(a + 1, Math.floor(startIdx + (span * (i + 1)) / bars));
      let peak = 0;
      for (let j = a; j < b && j < wf.peaks.length; j++) peak = Math.max(peak, wf.peaks[j]);
      const h = Math.max(0.5, peak * 10 * segment.volume);
      d += `M${(i - firstBar) * 3 + 1},${10 - h}V10`;
    }
    return d;
  }, [wf, width, firstBar, lastBar, segment.sourceStart, segment.duration, segment.speed, segment.volume]);
  if (!wf || shownBars <= 0) return null;
  return (
    <svg className={`waveform${compact ? " compact" : ""}`} style={{ left: firstBar * 3 }} width={shownBars * 3} viewBox={`0 0 ${shownBars * 3} 10`} preserveAspectRatio="none">
      <path d={path} />
    </svg>
  );
}
