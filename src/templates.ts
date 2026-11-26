import { useEditor } from "./store";
import { DEFAULT_TEXT, DEFAULT_TRANSFORM } from "./model/project";
import { SECOND } from "./model/time";
import type { Keyframe, Segment, ShapeStyle, TextStyle } from "./model/types";

type Item = Partial<Segment> & { start: number; duration: number };

export interface Template {
  id: string;
  label: string;
  description: string;
  /** Overlay clips relative to the insertion point. */
  build(): Item[];
  /** Optional project changes (e.g. vertical canvas). */
  project?: () => void;
}

const S = SECOND;
const text = (content: string, patch: Partial<TextStyle> = {}): TextStyle => ({ ...DEFAULT_TEXT, content, strokeWidth: 0, ...patch });
const shape = (patch: Partial<ShapeStyle>): ShapeStyle => ({ kind: "rectangle", width: 400, height: 100, fill: "#22c3b5", stroke: "#ffffff", strokeWidth: 0, roundness: 0, sides: 5, ...patch });
const kf = (...pairs: [number, number][]): Keyframe[] => pairs.map(([time, value]) => ({ time, value, easing: "easeOut" as const }));
const at = (x: number, y: number, extra: Partial<Segment["transform"]> = {}) => ({ ...DEFAULT_TRANSFORM, x, y, ...extra });

/** Ready-made overlays (titles, lower thirds, calls to action…) inserted at the playhead with animation. */
export const TEMPLATES: Template[] = [
  {
    id: "title",
    label: "Título de abertura",
    description: "Título grande com subtítulo, surgindo com zoom suave.",
    build: () => [
      { start: 0, duration: 4 * S, text: text("SEU TÍTULO", { fontSize: 150, fontFamily: "Arial Black" }), transform: at(0, -0.08), fadeOut: 0.5 * S, keyframes: { scale: kf([0, 0.7], [0.6 * S, 1]), opacity: kf([0, 0], [0.5 * S, 1]) } },
      { start: 0.4 * S, duration: 3.6 * S, text: text("subtítulo do vídeo", { fontSize: 56, bold: false, color: "#d8d8d8" }), transform: at(0, 0.16), fadeIn: 0.5 * S, fadeOut: 0.5 * S },
    ],
  },
  {
    id: "lowerThird",
    label: "Nome na tela (lower third)",
    description: "Faixa com nome e função que entra pela esquerda.",
    build: () => [
      { start: 0, duration: 5 * S, shape: shape({ width: 760, height: 150, roundness: 0.15, fill: "#111111" }), transform: at(-0.52, 0.7), fadeOut: 0.4 * S, keyframes: { x: kf([0, -1.6], [0.5 * S, -0.52]) } },
      { start: 0, duration: 5 * S, shape: shape({ width: 12, height: 150, fill: "#22c3b5" }), transform: at(-0.92, 0.7), fadeOut: 0.4 * S, keyframes: { x: kf([0, -2], [0.5 * S, -0.92]) } },
      { start: 0.25 * S, duration: 4.75 * S, text: text("Nome Sobrenome", { fontSize: 58, align: "left" }), transform: at(-0.52, 0.66), fadeOut: 0.4 * S, keyframes: { x: kf([0, -1.6], [0.5 * S, -0.52]) } },
      { start: 0.35 * S, duration: 4.65 * S, text: text("Função ou cargo", { fontSize: 38, bold: false, color: "#22c3b5", align: "left" }), transform: at(-0.52, 0.76), fadeOut: 0.4 * S, keyframes: { x: kf([0, -1.6], [0.5 * S, -0.52]) } },
    ],
  },
  {
    id: "countdown",
    label: "Contagem regressiva",
    description: "3, 2, 1 com pulso de escala, um segundo cada.",
    build: () =>
      ["3", "2", "1"].map((n, i) => ({
        start: i * S,
        duration: S,
        text: text(n, { fontSize: 320, fontFamily: "Arial Black", strokeWidth: 8 }),
        transform: at(0, 0),
        keyframes: { scale: kf([0, 1.6], [0.35 * S, 1]), opacity: kf([0, 0], [0.2 * S, 1], [0.8 * S, 1], [S, 0]) },
      })),
  },
  {
    id: "subscribe",
    label: "Inscreva-se",
    description: "Botão vermelho com sininho, entrando com elástico.",
    build: () => [
      { start: 0, duration: 4 * S, shape: shape({ width: 620, height: 130, roundness: 1, fill: "#e62117" }), transform: at(0, 0.62), fadeOut: 0.4 * S, keyframes: { scale: kf([0, 0], [0.25 * S, 1.15], [0.45 * S, 1]) } },
      { start: 0.1 * S, duration: 3.9 * S, text: text("INSCREVA-SE", { fontSize: 64, fontFamily: "Arial Black" }), transform: at(0, 0.62), fadeOut: 0.4 * S, keyframes: { scale: kf([0, 0], [0.3 * S, 1.15], [0.5 * S, 1]) } },
      { start: 0.6 * S, duration: 3.4 * S, sticker: { emoji: "🔔", size: 150 }, transform: at(0.41, 0.62), fadeOut: 0.4 * S, keyframes: { rotation: kf([0, -20], [0.15 * S, 20], [0.3 * S, -15], [0.45 * S, 10], [0.6 * S, 0]) } },
    ],
  },
  {
    id: "quote",
    label: "Citação",
    description: "Frase entre aspas em caixa escura, com fade.",
    build: () => [
      { start: 0, duration: 5 * S, text: text("“Uma frase marcante\naqui no meio do vídeo.”", { fontSize: 72, italic: true, background: "#000000cc" }), transform: at(0, 0), fadeIn: 0.6 * S, fadeOut: 0.6 * S },
      { start: 0.5 * S, duration: 4.5 * S, text: text("— Autor", { fontSize: 40, bold: false, color: "#cfcfcf" }), transform: at(0.3, 0.3), fadeIn: 0.6 * S, fadeOut: 0.6 * S },
    ],
  },
  {
    id: "arrow",
    label: "Destaque com seta",
    description: "Seta que aponta e um rótulo, para chamar atenção.",
    build: () => [
      { start: 0, duration: 3 * S, shape: shape({ kind: "arrow", width: 300, height: 110, fill: "#ffd400" }), transform: at(-0.25, 0, { rotation: 20 }), keyframes: { x: kf([0, -0.45], [0.4 * S, -0.25]) }, fadeOut: 0.3 * S },
      { start: 0, duration: 3 * S, text: text("OLHA ISSO!", { fontSize: 80, fontFamily: "Impact", color: "#ffd400", strokeWidth: 6, strokeColor: "#000000" }), transform: at(-0.55, -0.2), fadeIn: 0.3 * S, fadeOut: 0.3 * S },
    ],
  },
  {
    id: "ending",
    label: "Encerramento",
    description: "“Obrigado por assistir!” com escurecimento até o preto.",
    build: () => [
      { start: 0, duration: 4 * S, shape: shape({ width: 6000, height: 6000, fill: "#000000" }), transform: at(0, 0), keyframes: { opacity: kf([0, 0], [1.2 * S, 0.85]) } },
      { start: 0.6 * S, duration: 3.4 * S, text: text("Obrigado por assistir!", { fontSize: 110 }), transform: at(0, 0), fadeIn: 0.6 * S, keyframes: { scale: kf([0, 0.9], [S, 1]) } },
    ],
  },
  {
    id: "gg",
    label: "GG",
    description: "“GG” gigante batendo na tela, para o fim da partida.",
    build: () => [
      { start: 0, duration: 2.2 * S, text: text("GG", { fontSize: 380, fontFamily: "Impact", color: "#ffd400", strokeColor: "#000000", strokeWidth: 12 }), transform: at(0, 0), fadeOut: 0.3 * S, keyframes: { scale: kf([0, 2.4], [0.18 * S, 0.92], [0.3 * S, 1]), rotation: kf([0, -12], [0.18 * S, 4], [0.3 * S, 0]) } },
    ],
  },
  {
    id: "kill",
    label: "Eliminação",
    description: "Aviso “+1 ELIMINAÇÃO” que entra pela direita, estilo feed de kill.",
    build: () => [
      { start: 0, duration: 2.5 * S, shape: shape({ width: 620, height: 110, roundness: 0.2, fill: "#d7263d" }), transform: at(0.55, -0.62), fadeOut: 0.3 * S, keyframes: { x: kf([0, 1.6], [0.25 * S, 0.55]) } },
      { start: 0.05 * S, duration: 2.45 * S, text: text("+1 ELIMINAÇÃO", { fontSize: 64, fontFamily: "Impact" }), transform: at(0.55, -0.62), fadeOut: 0.3 * S, keyframes: { x: kf([0, 1.6], [0.25 * S, 0.55]) } },
      { start: 0.2 * S, duration: 2.3 * S, sticker: { emoji: "💀", size: 120 }, transform: at(0.16, -0.62), fadeOut: 0.3 * S, keyframes: { scale: kf([0, 0], [0.2 * S, 1.2], [0.35 * S, 1]) } },
    ],
  },
  {
    id: "epic",
    label: "Momento épico",
    description: "Faixa amarela “MOMENTO ÉPICO” com fogo, para as melhores jogadas.",
    build: () => [
      { start: 0, duration: 3 * S, text: text("MOMENTO ÉPICO", { fontSize: 110, fontFamily: "Impact", color: "#111111", background: "#ffd400" }), transform: at(0, -0.7, { rotation: -4 }), fadeOut: 0.3 * S, keyframes: { scale: kf([0, 0], [0.2 * S, 1.15], [0.35 * S, 1]) } },
      { start: 0.15 * S, duration: 2.85 * S, sticker: { emoji: "🔥", size: 170 }, transform: at(-0.62, -0.72), fadeOut: 0.3 * S, keyframes: { scale: kf([0, 0], [0.25 * S, 1.2], [0.4 * S, 1]) } },
      { start: 0.15 * S, duration: 2.85 * S, sticker: { emoji: "🔥", size: 170 }, transform: at(0.62, -0.72), fadeOut: 0.3 * S, keyframes: { scale: kf([0, 0], [0.25 * S, 1.2], [0.4 * S, 1]) } },
    ],
  },
  {
    id: "vertical",
    label: "Vertical para Reels/TikTok",
    description: "Muda o projeto para 1080×1920 com fundo desfocado e guias de área segura.",
    build: () => [],
    project: () =>
      useEditor.getState().mutate((p) => {
        p.width = 1080;
        p.height = 1920;
        p.backgroundMode = "blur";
      }),
  },
];

export function applyTemplate(t: Template) {
  t.project?.();
  const { playhead, insertOverlays } = useEditor.getState();
  const items = t.build();
  if (items.length) insertOverlays(items.map((i) => ({ ...i, start: playhead + i.start })));
}
