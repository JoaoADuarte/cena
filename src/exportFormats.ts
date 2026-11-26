/** What the export dialog and the AI tool offer. How each one is encoded lives in electron/exporter.cjs. */
export type ExportFormatId = "h264" | "hevc" | "av1" | "vp9" | "prores" | "gif" | "mp3" | "wav";
export type ExportQuality = "high" | "recommended" | "small";

export interface ExportFormat {
  id: ExportFormatId;
  label: string;
  ext: string;
  group: "Vídeo" | "Web e edição" | "Animação" | "Só áudio";
  hint: string;
  audioOnly?: boolean;
  /** The result carries no sound. */
  silent?: boolean;
  /** Can use the graphics card's encoder. */
  gpu?: boolean;
  /** One fixed quality: no choice to offer. */
  fixedQuality?: boolean;
}

export const EXPORT_FORMATS: ExportFormat[] = [
  { id: "h264", label: "MP4 (H.264)", ext: "mp4", group: "Vídeo", gpu: true, hint: "Toca em qualquer lugar. A melhor escolha para YouTube, TikTok e Instagram." },
  { id: "hevc", label: "MP4 (H.265/HEVC)", ext: "mp4", group: "Vídeo", gpu: true, hint: "Mesma qualidade em cerca de metade do tamanho. Alguns aparelhos antigos não tocam." },
  { id: "av1", label: "MP4 (AV1)", ext: "mp4", group: "Vídeo", gpu: true, hint: "O menor arquivo de todos. Sem placa de vídeo compatível, a exportação é bem lenta." },
  { id: "vp9", label: "WebM (VP9)", ext: "webm", group: "Web e edição", hint: "Para páginas da web. A exportação é mais lenta que a do MP4." },
  { id: "prores", label: "MOV (ProRes)", ext: "mov", group: "Web e edição", hint: "Para continuar editando em outro programa. Os arquivos ficam enormes." },
  { id: "gif", label: "GIF animado", ext: "gif", group: "Animação", silent: true, hint: "Sem som e com poucas cores. Bom para trechos de poucos segundos." },
  { id: "mp3", label: "MP3", ext: "mp3", group: "Só áudio", audioOnly: true, hint: "Só o som da timeline, para podcast ou trilha." },
  { id: "wav", label: "WAV (sem perdas)", ext: "wav", group: "Só áudio", audioOnly: true, fixedQuality: true, hint: "Só o som da timeline, sem compressão. Arquivo grande." },
];

export const exportFormat = (id: ExportFormatId) => EXPORT_FORMATS.find((f) => f.id === id)!;
