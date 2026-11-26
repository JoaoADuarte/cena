import { create } from "zustand";
import { useEditor } from "./store";
import { afterEdit, selectedIds, useUi, withGroups, withLinkedForDelete } from "./ui";
import { freezeFrame } from "./clipActions";
import { frameDuration } from "./model/time";
import { projectDuration } from "./model/project";

export interface ShortcutAction {
  id: string;
  label: string;
  group: string;
  defaults: string[];
}

/** Every keyboard action, with its default keys. Combos look like "Ctrl+Shift+Z", "Space", "ArrowLeft". */
export const ACTIONS: ShortcutAction[] = [
  { id: "play", label: "Reproduzir / pausar", group: "Reprodução", defaults: ["Space"] },
  { id: "prevFrame", label: "Quadro anterior", group: "Reprodução", defaults: ["ArrowLeft"] },
  { id: "nextFrame", label: "Próximo quadro", group: "Reprodução", defaults: ["ArrowRight"] },
  { id: "back10", label: "Voltar 10 quadros", group: "Reprodução", defaults: ["Shift+ArrowLeft"] },
  { id: "forward10", label: "Avançar 10 quadros", group: "Reprodução", defaults: ["Shift+ArrowRight"] },
  { id: "home", label: "Ir para o início", group: "Reprodução", defaults: ["Home"] },
  { id: "end", label: "Ir para o fim", group: "Reprodução", defaults: ["End"] },
  { id: "prevMarker", label: "Marcador anterior", group: "Reprodução", defaults: ["Shift+M"] },
  { id: "nextMarker", label: "Próximo marcador", group: "Reprodução", defaults: ["Alt+M"] },
  { id: "split", label: "Dividir na agulha", group: "Edição", defaults: ["S", "Ctrl+B"] },
  { id: "delete", label: "Excluir", group: "Edição", defaults: ["Delete", "Backspace"] },
  { id: "rippleDelete", label: "Excluir em cascata", group: "Edição", defaults: ["Shift+Delete"] },
  { id: "deleteLeft", label: "Excluir à esquerda do cursor", group: "Edição", defaults: ["Q"] },
  { id: "deleteRight", label: "Excluir à direita do cursor", group: "Edição", defaults: ["W"] },
  { id: "blade", label: "Ferramenta lâmina (dividir com clique)", group: "Edição", defaults: ["B"] },
  { id: "freeze", label: "Congelar quadro", group: "Edição", defaults: ["Shift+F"] },
  { id: "mirror", label: "Espelhar", group: "Edição", defaults: [] },
  { id: "rotate", label: "Girar 90°", group: "Edição", defaults: [] },
  { id: "magnet", label: "Ímã da faixa principal", group: "Edição", defaults: ["Shift+N"] },
  { id: "snap", label: "Encaixe automático", group: "Edição", defaults: ["N"] },
  { id: "copy", label: "Copiar clipes", group: "Edição", defaults: ["Ctrl+C"] },
  { id: "paste", label: "Colar no cursor", group: "Edição", defaults: ["Ctrl+V"] },
  { id: "duplicate", label: "Duplicar", group: "Edição", defaults: ["Ctrl+D"] },
  { id: "pasteAttributes", label: "Colar atributos (animação, efeitos…)", group: "Edição", defaults: ["Ctrl+Alt+V"] },
  { id: "detachAudio", label: "Separar áudio", group: "Edição", defaults: ["Ctrl+Shift+D"] },
  { id: "group", label: "Agrupar clipes", group: "Edição", defaults: ["Ctrl+G"] },
  { id: "ungroup", label: "Desagrupar", group: "Edição", defaults: ["Ctrl+Shift+G"] },
  { id: "selectAll", label: "Selecionar todos os clipes", group: "Edição", defaults: ["Ctrl+A"] },
  { id: "text", label: "Adicionar texto", group: "Edição", defaults: ["T"] },
  { id: "marker", label: "Adicionar marcador", group: "Edição", defaults: ["M"] },
  { id: "ripple", label: "Ligar/desligar cascata", group: "Edição", defaults: ["R"] },
  { id: "deselect", label: "Desmarcar / sair do desenho", group: "Edição", defaults: ["Escape"] },
  { id: "undo", label: "Desfazer", group: "Projeto", defaults: ["Ctrl+Z"] },
  { id: "redo", label: "Refazer", group: "Projeto", defaults: ["Ctrl+Y", "Ctrl+Shift+Z"] },
  { id: "save", label: "Salvar", group: "Projeto", defaults: ["Ctrl+S"] },
  { id: "saveAs", label: "Salvar como", group: "Projeto", defaults: ["Ctrl+Shift+S"] },
  { id: "open", label: "Abrir projeto", group: "Projeto", defaults: ["Ctrl+O"] },
  { id: "export", label: "Exportar", group: "Projeto", defaults: ["Ctrl+E"] },
  { id: "shortcuts", label: "Atalhos de teclado", group: "Projeto", defaults: ["Ctrl+K"] },
];

const STORAGE_KEY = "cena.shortcuts.v1";

function loadOverrides(): Record<string, string[]> {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** User overrides of the default keys, kept in this computer's app storage. */
export const useShortcuts = create<{ overrides: Record<string, string[]>; set(id: string, keys: string[] | null): void; resetAll(): void }>((set, get) => ({
  overrides: loadOverrides(),
  set(id, keys) {
    const overrides = { ...get().overrides };
    if (keys === null) delete overrides[id];
    else overrides[id] = keys;
    set({ overrides });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {
      // Storage unavailable: the change lasts for this session only.
    }
  },
  resetAll() {
    set({ overrides: {} });
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  },
}));

export const keysFor = (id: string) => useShortcuts.getState().overrides[id] ?? ACTIONS.find((a) => a.id === id)?.defaults ?? [];

/** Normalized combo for a key event, or null for a lone modifier. */
export function comboOf(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return null;
  const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return [e.ctrlKey || e.metaKey ? "Ctrl" : "", e.altKey ? "Alt" : "", e.shiftKey ? "Shift" : "", key].filter(Boolean).join("+");
}

/** Pretty label for a combo ("Ctrl+Shift+Z" → "Ctrl + Shift + Z"). */
export const comboLabel = (combo: string) =>
  combo
    .replace("ArrowLeft", "←")
    .replace("ArrowRight", "→")
    .replace("ArrowUp", "↑")
    .replace("ArrowDown", "↓")
    .replace("Space", "Espaço")
    .replace("Escape", "Esc")
    .split("+")
    .join(" + ");

/** App-level actions the runner needs from the App component. */
export interface ShortcutContext {
  save(saveAs: boolean): void;
  open(): void;
  exportVideo(): void;
  showShortcuts(): void;
}

export function runAction(id: string, ctx: ShortcutContext): boolean {
  const s = useEditor.getState();
  const ui = useUi.getState();
  const step = frameDuration(s.project.fps);
  switch (id) {
    case "play":
      s.setPlaying(!s.playing);
      break;
    case "prevFrame":
      s.setPlayhead(s.playhead - step);
      break;
    case "nextFrame":
      s.setPlayhead(s.playhead + step);
      break;
    case "back10":
      s.setPlayhead(s.playhead - step * 10);
      break;
    case "forward10":
      s.setPlayhead(s.playhead + step * 10);
      break;
    case "home":
      s.setPlayhead(0);
      break;
    case "end":
      s.setPlayhead(projectDuration(s.project));
      break;
    case "nextMarker": {
      const after = s.project.markers.find((m) => m.time > s.playhead + step / 2);
      const target = after ?? s.project.markers[0];
      if (target) s.setPlayhead(target.time);
      break;
    }
    case "prevMarker": {
      const before = [...s.project.markers].reverse().find((m) => m.time < s.playhead - step / 2);
      const target = before ?? s.project.markers[s.project.markers.length - 1];
      if (target) s.setPlayhead(target.time);
      break;
    }
    case "split":
      s.splitAt(s.playhead);
      break;
    case "delete":
    case "rippleDelete":
      if (!s.selectedId) return false;
      s.deleteSegments(withLinkedForDelete(selectedIds()), id === "rippleDelete" || ui.ripple, ui.magnet);
      afterEdit();
      break;
    case "deleteLeft":
    case "deleteRight":
      if (!s.selectedId || !s.deleteToPlayhead(s.selectedId, id === "deleteLeft" ? "left" : "right", ui.magnet)) return false;
      afterEdit();
      break;
    case "blade":
      ui.set({ tool: ui.tool === "blade" ? "select" : "blade" });
      break;
    case "freeze":
      if (!s.selectedId) return false;
      void freezeFrame(s.selectedId);
      break;
    case "mirror":
      if (!s.selectedId) return false;
      s.flip(selectedIds(), "x");
      break;
    case "rotate":
      if (!s.selectedId) return false;
      s.rotate90(selectedIds());
      break;
    case "magnet":
      ui.set({ magnet: !ui.magnet });
      if (!ui.magnet) s.compactMainTrack();
      break;
    case "snap":
      ui.set({ snap: !ui.snap });
      break;
    case "copy": {
      const n = s.copySegments(selectedIds());
      if (n) s.setStatus(`${n} clipe(s) copiado(s).`);
      break;
    }
    case "paste":
      s.pasteSegments(s.playhead);
      break;
    case "duplicate": {
      const ids = selectedIds();
      if (!ids.length) return false;
      s.copySegments(ids);
      const end = Math.max(...ids.map((x) => s.project.tracks.flatMap((t) => t.segments).find((seg) => seg.id === x)!).map((seg) => seg.start + seg.duration));
      s.pasteSegments(end);
      break;
    }
    case "pasteAttributes": {
      const n = s.pasteAttributes(selectedIds());
      s.setStatus(n ? `Atributos colados em ${n} clipe(s).` : "Copie um clipe (Ctrl+C) e selecione outro para colar os atributos.");
      break;
    }
    case "detachAudio":
      if (!s.selectedId || !s.detachAudio(s.selectedId)) return false;
      break;
    case "group": {
      const ids = selectedIds();
      if (ids.length < 2) {
        s.setStatus("Selecione dois ou mais clipes para agrupar (arraste uma caixa ou use Ctrl+clique).");
        return false;
      }
      s.groupSegments(ids);
      s.setStatus(`${withGroups(ids).length} clipes agrupados. Ctrl+Shift+G desagrupa.`);
      break;
    }
    case "ungroup": {
      const n = s.ungroupSegments(selectedIds());
      if (!n) return false;
      s.setStatus(`Grupo desfeito (${n} clipes).`);
      break;
    }
    case "selectAll": {
      const ids = s.project.tracks.filter((t) => !t.locked).flatMap((t) => t.segments.map((x) => x.id));
      if (!ids.length) return false;
      s.selectMany(ids);
      break;
    }
    case "text":
      s.addText();
      break;
    case "marker":
      s.addMarker(s.playhead);
      break;
    case "ripple":
      ui.set({ ripple: !ui.ripple });
      s.setStatus(`Edição em cascata ${ui.ripple ? "desligada" : "ligada"}.`);
      break;
    case "deselect":
      if (ui.maskDrawing) ui.set({ maskDrawing: null });
      else s.select(null);
      break;
    case "undo":
      s.undo();
      break;
    case "redo":
      s.redo();
      break;
    case "save":
      ctx.save(false);
      break;
    case "saveAs":
      ctx.save(true);
      break;
    case "open":
      ctx.open();
      break;
    case "export":
      ctx.exportVideo();
      break;
    case "shortcuts":
      ctx.showShortcuts();
      break;
    default:
      return false;
  }
  return true;
}

/** Action bound to a key event, honoring user overrides. */
export function actionFor(e: KeyboardEvent): string | null {
  const combo = comboOf(e);
  if (!combo) return null;
  return ACTIONS.find((a) => keysFor(a.id).includes(combo))?.id ?? null;
}
