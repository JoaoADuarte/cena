import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { create } from "zustand";
import { useEditor } from "../store";
import { useAiJob } from "../ai";
import { enhanceClip, processSound, removeBackground, reverseClip, soundClips } from "../clipActions";
import { comboLabel, keysFor, runAction, type ShortcutContext } from "../shortcuts";
import { selectedIds, useUi, withLinkedForDelete } from "../ui";
import { findSegment } from "../model/project";
import type { Micros } from "../model/types";
import { Icon } from "./controls";

interface MenuAt {
  x: number;
  y: number;
  /** On a clip (acts on the selection) or on empty track space. */
  kind: "clip" | "lane";
  trackId: string;
  /** Timeline time under the pointer. */
  time: Micros;
}

const useMenu = create<{ at: MenuAt | null }>(() => ({ at: null }));

export const openClipMenu = (at: MenuAt) => useMenu.setState({ at });
const close = () => useMenu.setState({ at: null });

/** The menu runs timeline actions only; the App-level ones (save, export) are not offered here. */
const NO_CONTEXT: ShortcutContext = { save() {}, open() {}, exportVideo() {}, showShortcuts() {} };
const act = (id: string) => runAction(id, NO_CONTEXT);
const keyHint = (id: string) => {
  const k = keysFor(id)[0];
  return k ? comboLabel(k) : undefined;
};

interface Item {
  label: string;
  icon?: Parameters<typeof Icon>[0]["name"];
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  run(): void;
}

/** Quick actions on right click, for the selected clips or for a spot on a track. */
export function ClipMenu() {
  const at = useMenu((s) => s.at);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!at) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close);
    };
  }, [at]);

  // Keep the menu inside the window.
  useLayoutEffect(() => {
    if (!at || !ref.current) return setPos(null);
    const r = ref.current.getBoundingClientRect();
    setPos({ left: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) });
  }, [at]);

  if (!at) return null;
  const sections = at.kind === "clip" ? clipItems(at) : laneItems(at);
  return (
    <div className="clip-menu" ref={ref} role="menu" style={pos ?? { left: at.x, top: at.y, visibility: "hidden" }} onContextMenu={(e) => e.preventDefault()}>
      {sections.map((items, i) => (
        <div key={i} className="clip-menu-section">
          {items.map((item) => (
            <button
              key={item.label}
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.run();
              }}
            >
              {item.icon ? <Icon name={item.icon} /> : <span className="icon" />}
              <span className="clip-menu-label">{item.label}</span>
              {item.hint && <kbd>{item.hint}</kbd>}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function clipItems(at: MenuAt): Item[][] {
  const s = useEditor.getState();
  const ids = selectedIds();
  const n = ids.length;
  const found = s.selectedId ? findSegment(s.project, s.selectedId) : null;
  const material = found?.segment.materialId ? s.project.materials[found.segment.materialId] : undefined;
  const busy = useAiJob.getState().job !== null;
  const all = s.project.tracks.flatMap((t) => t.segments);
  const grouped = all.some((x) => ids.includes(x.id) && x.groupId);
  const sound = soundClips(ids).length;
  const visual = found ? found.track.kind !== "audio" : false;
  const isVideo = Boolean(material?.hasVideo && material.kind !== "image" && found?.track.kind === "video");
  const underCursor = found ? s.playhead > found.segment.start && s.playhead < found.segment.start + found.segment.duration : false;
  const many = (label: string) => (n > 1 ? `${label} (${n})` : label);
  const soundLabel = (label: string) => (sound > 1 ? `${label} (${sound} clipes)` : label);

  return [
    [
      { label: "Dividir no cursor", icon: "split", hint: keyHint("split"), disabled: !underCursor, run: () => s.splitAt(s.playhead, s.selectedId ?? undefined) },
      { label: "Dividir aqui", icon: "blade", disabled: !found, run: () => found && s.splitAt(at.time, found.segment.id) },
    ],
    [
      { label: many("Copiar"), icon: "copy", hint: keyHint("copy"), run: () => act("copy") },
      { label: "Colar no cursor", icon: "paste", hint: keyHint("paste"), run: () => act("paste") },
      { label: many("Duplicar"), hint: keyHint("duplicate"), run: () => act("duplicate") },
      { label: "Colar atributos", hint: keyHint("pasteAttributes"), run: () => act("pasteAttributes") },
    ],
    [{ label: many("Exportar só a seleção"), icon: "export", disabled: !n, run: () => useUi.getState().set({ exportSelection: true }) }],
    [
      { label: many("Agrupar"), icon: "group", hint: keyHint("group"), disabled: n < 2, run: () => act("group") },
      { label: "Desagrupar", icon: "ungroup", hint: keyHint("ungroup"), disabled: !grouped, run: () => act("ungroup") },
      { label: "Selecionar a faixa toda", run: () => s.selectMany(s.project.tracks.find((t) => t.id === at.trackId)?.segments.map((x) => x.id) ?? []) },
    ],
    [
      { label: soundLabel("Melhorar voz"), icon: "mic", disabled: !sound || busy, run: () => void processSound(ids, "voice") },
      { label: soundLabel("Reduzir ruído"), icon: "denoise", disabled: !sound || busy, run: () => void processSound(ids, "denoise") },
      {
        label: "Separar áudio",
        icon: "detach",
        hint: keyHint("detachAudio"),
        disabled: !(found?.track.kind === "video" && material?.hasAudio && found.segment.volume > 0),
        run: () => act("detachAudio"),
      },
    ],
    [
      { label: "Espelhar", icon: "mirror", disabled: !visual, run: () => act("mirror") },
      { label: "Girar 90°", icon: "rotate", disabled: !visual, run: () => act("rotate") },
      { label: "Congelar quadro", icon: "freeze", hint: keyHint("freeze"), disabled: !isVideo || !underCursor, run: () => act("freeze") },
      { label: "Inverter", icon: "reverse", disabled: !material || material.kind === "image" || busy, run: () => s.selectedId && void reverseClip(s.selectedId) },
      { label: "Remover fundo", icon: "person", disabled: !visual || !material || busy, run: () => s.selectedId && void removeBackground(s.selectedId) },
      { label: "Melhorar qualidade", icon: "hd", disabled: !isVideo || busy, run: () => s.selectedId && void enhanceClip(s.selectedId) },
    ],
    [
      { label: many("Excluir"), icon: "trash", hint: keyHint("delete"), danger: true, run: () => act("delete") },
      {
        label: "Excluir e fechar o espaço",
        hint: keyHint("rippleDelete"),
        danger: true,
        run: () => {
          s.deleteSegments(withLinkedForDelete(selectedIds()), true, useUi.getState().magnet);
          if (useUi.getState().magnet) s.compactMainTrack();
        },
      },
    ],
  ];
}

function laneItems(at: MenuAt): Item[][] {
  const s = useEditor.getState();
  const track = s.project.tracks.find((t) => t.id === at.trackId);
  const go = (fn: () => void) => () => {
    s.setPlayhead(at.time);
    fn();
  };
  return [
    [
      { label: "Colar aqui", icon: "paste", hint: keyHint("paste"), run: () => s.pasteSegments(at.time) },
      { label: "Adicionar texto aqui", icon: "text", run: go(() => s.addText(at.time)) },
      { label: "Adicionar marcador aqui", icon: "marker", run: () => s.addMarker(at.time) },
      { label: "Mover o cursor para cá", run: () => s.setPlayhead(at.time) },
    ],
    [
      { label: "Selecionar a faixa toda", disabled: !track?.segments.length, run: () => s.selectMany(track?.segments.map((x) => x.id) ?? []) },
      { label: "Selecionar tudo", hint: keyHint("selectAll"), run: () => act("selectAll") },
    ],
  ];
}
