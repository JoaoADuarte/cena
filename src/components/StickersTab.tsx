import { useEditor } from "../store";
import type { ShapeKind, ShapeStyle } from "../model/types";
import { SHAPE_KINDS } from "../model/types";

export const SHAPE_LABELS: Record<ShapeKind, string> = {
  rectangle: "Retângulo",
  ellipse: "Elipse",
  triangle: "Triângulo",
  star: "Estrela",
  polygon: "Polígono",
  heart: "Coração",
  arrow: "Seta",
  line: "Linha",
};

function defaultShape(kind: ShapeKind): ShapeStyle {
  const square = ["ellipse", "triangle", "star", "polygon", "heart"].includes(kind);
  return {
    kind,
    width: kind === "line" ? 500 : kind === "arrow" ? 420 : square ? 300 : 480,
    height: kind === "line" ? 0 : kind === "arrow" ? 160 : square ? 300 : 270,
    fill: kind === "line" ? null : "#22c3b5",
    stroke: "#ffffff",
    strokeWidth: kind === "line" ? 10 : 0,
    roundness: 0,
    sides: kind === "polygon" ? 6 : 5,
  };
}

/** Small SVG previews matching the compositor's shape outlines. */
const SHAPE_ICONS: Record<ShapeKind, string> = {
  rectangle: "M4 7h16v10H4z",
  ellipse: "M12 6c4.4 0 8 2.7 8 6s-3.6 6-8 6-8-2.7-8-6 3.6-6 8-6z",
  triangle: "M12 4l8 15H4z",
  star: "M12 3l2.6 5.6 6.1.6-4.6 4.1 1.3 6L12 16.3 6.6 19.3l1.3-6L3.3 9.2l6.1-.6z",
  polygon: "M7.5 4.2h9L21 12l-4.5 7.8h-9L3 12z",
  heart: "M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z",
  arrow: "M3 10h11V6l7 6-7 6v-4H3z",
  line: "M3 11h18v2H3z",
};

const EMOJI_GROUPS: { label: string; items: string[] }[] = [
  { label: "Reações", items: ["😂", "😍", "😎", "🤯", "😱", "🥳", "😭", "🤔", "👀", "🙌", "👏", "👍", "👎", "🙏", "💪", "🤝"] },
  { label: "Destaques", items: ["🔥", "✨", "⭐", "💥", "💯", "❤️", "💔", "⚡", "🎉", "🎯", "✅", "❌", "⚠️", "❓", "❗", "💡"] },
  { label: "Setas e sinais", items: ["👉", "👈", "👆", "👇", "⬆️", "⬇️", "➡️", "⬅️", "🔴", "🟢", "🔵", "🟡", "📍", "🔔", "🔊", "⏰"] },
  { label: "Objetos", items: ["🎬", "🎵", "📸", "🎮", "💻", "📱", "💰", "🛒", "🎁", "🏆", "🚀", "🍕", "☕", "🌎", "☀️", "🌙"] },
];

export function StickersTab() {
  const addOverlay = useEditor((s) => s.addOverlay);
  return (
    <div className="library-body">
      <p className="empty-hint">Clique para pôr na posição do cursor. Tamanho, cor e animação ficam no painel à direita.</p>
      <h4 className="lib-group">Formas</h4>
      <div className="shape-grid">
        {SHAPE_KINDS.map((kind) => (
          <button key={kind} className="shape-card" title={SHAPE_LABELS[kind]} onClick={() => addOverlay({ shape: defaultShape(kind) })}>
            <svg viewBox="0 0 24 24">
              <path d={SHAPE_ICONS[kind]} />
            </svg>
            <span>{SHAPE_LABELS[kind]}</span>
          </button>
        ))}
      </div>
      {EMOJI_GROUPS.map((g) => (
        <div key={g.label}>
          <h4 className="lib-group">{g.label}</h4>
          <div className="emoji-grid">
            {g.items.map((emoji) => (
              <button key={emoji} className="emoji-card" onClick={() => addOverlay({ sticker: { emoji, size: 240 } })}>
                {emoji}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
