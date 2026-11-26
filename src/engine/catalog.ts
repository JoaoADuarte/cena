import type { EffectType, FilterType, TransitionShape, TransitionShapeKind, TransitionType } from "../model/types";

export const TRANSITION_INFO: Record<TransitionType, { label: string; group: string }> = {
  fade: { label: "Dissolver", group: "Básicas" },
  fadeBlack: { label: "Passar pelo preto", group: "Básicas" },
  fadeWhite: { label: "Passar pelo branco", group: "Básicas" },
  slideLeft: { label: "Empurrar ←", group: "Movimento" },
  slideRight: { label: "Empurrar →", group: "Movimento" },
  slideUp: { label: "Empurrar ↑", group: "Movimento" },
  slideDown: { label: "Empurrar ↓", group: "Movimento" },
  bounce: { label: "Empurrar elástico", group: "Movimento" },
  wipeLeft: { label: "Cortina ←", group: "Máscara" },
  wipeRight: { label: "Cortina →", group: "Máscara" },
  wipeUp: { label: "Cortina ↑", group: "Máscara" },
  wipeDown: { label: "Cortina ↓", group: "Máscara" },
  wipeDiagonal: { label: "Cortina diagonal", group: "Máscara" },
  circle: { label: "Círculo", group: "Máscara" },
  diamond: { label: "Losango", group: "Máscara" },
  blinds: { label: "Barras", group: "Máscara" },
  zoom: { label: "Zoom", group: "Câmera" },
  zoomIn: { label: "Zoom de entrada", group: "Câmera" },
  zoomOut: { label: "Zoom de saída", group: "Câmera" },
  spin: { label: "Girar", group: "Câmera" },
  blur: { label: "Desfoque", group: "Câmera" },
  motionBlur: { label: "Borrão de movimento", group: "Câmera" },
  glitch: { label: "Glitch", group: "Estilo" },
  flash: { label: "Flash", group: "Estilo" },
  shape: { label: "Forma personalizada", group: "Personalizada" },
};

export const TRANSITION_SHAPE_LABELS: Record<TransitionShapeKind, string> = {
  circle: "Círculo",
  rectangle: "Quadrado",
  diamond: "Losango",
  star: "Estrela",
  heart: "Coração",
  text: "Texto",
};

export const DEFAULT_TRANSITION_SHAPE: TransitionShape = { kind: "star", text: "CENA", direction: "grow", softness: 0.03, rotate: true };

/** A color look at full strength; filter functions are interpolated from neutral by the clip's intensity. */
export interface FilterLook {
  brightness?: number;
  contrast?: number;
  saturate?: number;
  sepia?: number;
  grayscale?: number;
  /** Degrees. */
  hue?: number;
  /** Color washed over the clip with a blend mode. */
  overlay?: { color: string; mode: GlobalCompositeOperation; alpha: number };
}

export const FILTER_INFO: Record<FilterType, { label: string; group: string; look: FilterLook }> = {
  vivid: { label: "Vívido", group: "Cor", look: { saturate: 1.45, contrast: 1.1 } },
  natural: { label: "Natural+", group: "Cor", look: { saturate: 1.15, contrast: 1.05, brightness: 1.03 } },
  punch: { label: "Impacto", group: "Cor", look: { contrast: 1.35, saturate: 1.25, brightness: 0.97 } },
  pastel: { label: "Pastel", group: "Cor", look: { saturate: 0.7, brightness: 1.12, contrast: 0.85, overlay: { color: "#ffd6e7", mode: "soft-light", alpha: 0.35 } } },
  cinema: { label: "Cinema", group: "Cinema", look: { contrast: 1.2, saturate: 0.85, brightness: 0.95, overlay: { color: "#1c3a52", mode: "soft-light", alpha: 0.4 } } },
  tealOrange: { label: "Teal & Orange", group: "Cinema", look: { contrast: 1.15, saturate: 1.2, overlay: { color: "#ff7a2a", mode: "soft-light", alpha: 0.3 }, hue: -6 } },
  moody: { label: "Sombrio", group: "Cinema", look: { brightness: 0.85, contrast: 1.25, saturate: 0.75, overlay: { color: "#24304a", mode: "soft-light", alpha: 0.45 } } },
  noir: { label: "Noir", group: "Cinema", look: { grayscale: 1, contrast: 1.4, brightness: 0.95 } },
  retro: { label: "Retrô", group: "Vintage", look: { sepia: 0.45, contrast: 1.1, saturate: 0.85, overlay: { color: "#e8a35a", mode: "soft-light", alpha: 0.3 } } },
  polaroid: { label: "Polaroid", group: "Vintage", look: { sepia: 0.2, contrast: 0.9, brightness: 1.08, saturate: 1.1, overlay: { color: "#7fd3c0", mode: "soft-light", alpha: 0.25 } } },
  faded: { label: "Desbotado", group: "Vintage", look: { contrast: 0.78, saturate: 0.7, brightness: 1.1 } },
  golden: { label: "Dourado", group: "Vintage", look: { sepia: 0.3, saturate: 1.2, overlay: { color: "#ffb300", mode: "soft-light", alpha: 0.35 } } },
  sunset: { label: "Pôr do sol", group: "Clima", look: { saturate: 1.25, overlay: { color: "#ff5e3a", mode: "soft-light", alpha: 0.4 } } },
  coldBlue: { label: "Azul frio", group: "Clima", look: { saturate: 0.9, overlay: { color: "#2a7bff", mode: "soft-light", alpha: 0.4 } } },
  forest: { label: "Floresta", group: "Clima", look: { saturate: 1.1, hue: 12, overlay: { color: "#2f8f4e", mode: "soft-light", alpha: 0.3 } } },
  neon: { label: "Neon", group: "Clima", look: { saturate: 1.6, contrast: 1.2, hue: -15, overlay: { color: "#b400ff", mode: "soft-light", alpha: 0.35 } } },
};

/** CSS filter functions of a look at intensity `i` (0..1). */
export function lookFilter(look: FilterLook, i: number): string[] {
  const mix = (target: number | undefined, neutral: number) => (target === undefined ? neutral : neutral + (target - neutral) * i);
  const out: string[] = [];
  if (look.brightness !== undefined) out.push(`brightness(${mix(look.brightness, 1)})`);
  if (look.contrast !== undefined) out.push(`contrast(${mix(look.contrast, 1)})`);
  if (look.saturate !== undefined) out.push(`saturate(${mix(look.saturate, 1)})`);
  if (look.sepia !== undefined) out.push(`sepia(${mix(look.sepia, 0)})`);
  if (look.grayscale !== undefined) out.push(`grayscale(${mix(look.grayscale, 0)})`);
  if (look.hue !== undefined) out.push(`hue-rotate(${mix(look.hue, 0)}deg)`);
  return out;
}

/** CSS preview of a look for library swatches (overlays approximated by sepia/hue). */
export const lookSwatch = (look: FilterLook) => lookFilter(look, 1).join(" ") || "none";

export const EFFECT_INFO: Record<EffectType, { label: string; group: string; swatch: string }> = {
  bw: { label: "Preto e branco", group: "Cor", swatch: "grayscale(1)" },
  sepia: { label: "Sépia", group: "Cor", swatch: "sepia(1)" },
  vintage: { label: "Vintage", group: "Cor", swatch: "sepia(0.6) contrast(1.15) saturate(0.7)" },
  warm: { label: "Quente", group: "Cor", swatch: "sepia(0.25) saturate(1.3) hue-rotate(-8deg)" },
  cool: { label: "Frio", group: "Cor", swatch: "hue-rotate(15deg) saturate(0.9) brightness(1.03)" },
  dramatic: { label: "Dramático", group: "Cor", swatch: "contrast(1.5) saturate(1.2) brightness(0.95)" },
  invert: { label: "Negativo", group: "Cor", swatch: "invert(1)" },
  hue: { label: "Girar matiz", group: "Cor", swatch: "hue-rotate(120deg)" },
  vignette: { label: "Vinheta", group: "Estilo", swatch: "brightness(0.8)" },
  glow: { label: "Brilho suave", group: "Estilo", swatch: "brightness(1.2) blur(0.5px)" },
  pixelate: { label: "Pixelizar", group: "Estilo", swatch: "contrast(1.1)" },
  grain: { label: "Granulado", group: "Estilo", swatch: "contrast(1.1) saturate(0.9)" },
  flash: { label: "Flash", group: "Dinâmico", swatch: "brightness(1.5)" },
  shake: { label: "Tremor", group: "Dinâmico", swatch: "none" },
};
