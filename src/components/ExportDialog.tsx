import { useEffect, useMemo, useRef, useState } from "react";
import { useEditor, whenAllTracksReady } from "../store";
import { creditsText, exportProject } from "../engine/exporter";
import { projectDuration } from "../model/project";
import { SECOND, timecode } from "../model/time";
import { EXPORT_FORMATS, exportFormat, type ExportFormatId, type ExportQuality } from "../exportFormats";
import { projectFromSelection } from "../engine/exportSelection";
import { selectedIds, withLinked } from "../ui";

const QUALITY: { label: string; id: ExportQuality }[] = [
  { label: "Alta", id: "high" },
  { label: "Recomendada", id: "recommended" },
  { label: "Arquivo menor", id: "small" },
];

const NORMALIZE_KEY = "cena.export.normalize";
const FORMAT_KEY = "cena.export.format";
const GPU_KEY = "cena.export.gpu";

const remembered = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Only a remembered preference.
  }
};

/** Folder and name without extension of a path, on Windows or POSIX separators. */
function splitPath(file: string) {
  const cut = Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/"));
  const name = file.slice(cut + 1);
  const dot = name.lastIndexOf(".");
  return { folder: file.slice(0, cut), base: dot > 0 ? name.slice(0, dot) : name };
}

/** "~45 s", "~12 min", "~1 h 05 min". */
function formatEta(seconds: number) {
  if (seconds < 90) return `~${Math.ceil(seconds)} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  return `~${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

export function ExportDialog({ onClose, selectionFirst = false }: { onClose: () => void; selectionFirst?: boolean }) {
  const whole = useEditor((s) => s.project);
  const [selectedClips] = useState(() => withLinked(selectedIds()));
  // A copy with only those clips: the project on the timeline stays as it is, to keep editing.
  const selection = useMemo(() => projectFromSelection(whole, selectedClips), [whole, selectedClips]);
  const [onlySelection, setOnlySelection] = useState(selectionFirst);
  const project = onlySelection && selection ? selection : whole;
  const fileName = project === whole ? whole.name : `${whole.name} - trecho`;
  const [quality, setQuality] = useState<ExportQuality>("recommended");
  const [normalize, setNormalize] = useState(() => remembered(NORMALIZE_KEY) === "1");
  const [formatId, setFormatId] = useState<ExportFormatId>(() => {
    const saved = remembered(FORMAT_KEY);
    return EXPORT_FORMATS.find((f) => f.id === saved)?.id ?? "h264";
  });
  const format = exportFormat(formatId);
  /** Graphics-card encoder per codec; undefined while it is being measured. */
  const [gpus, setGpus] = useState<Record<string, string | null>>();
  const [useGpu, setUseGpu] = useState(() => remembered(GPU_KEY) === "1");
  const gpuName = format.gpu ? gpus?.[format.id] : null;
  const [outPath, setOutPath] = useState<string | null>(null);
  /** The user picked the file: changing format keeps its folder and name. */
  const chosen = useRef(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [result, setResult] = useState<{ ok: boolean; message: string; path?: string } | null>(null);
  const [finishing, setFinishing] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const started = useRef(0);
  const duration = projectDuration(project);
  const running = progress !== null && result === null;
  const credits = creditsText(project);

  useEffect(() => {
    void window.api.exportGpu().then(setGpus, () => setGpus({}));
  }, []);

  // A file in Videos with the format's extension, so Export works right away; "Escolher…" changes it.
  // Never an existing name: only the save dialog may replace a file.
  useEffect(() => {
    let alive = true;
    const place = chosen.current && outPath ? splitPath(outPath) : { folder: null, base: fileName };
    void window.api.defaultExportPath(place.base, format.ext, place.folder).then((p) => alive && setOutPath(p));
    return () => {
      alive = false;
    };
    // outPath is only read here to keep the user's folder when the format changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileName, format.ext]);

  const pickFormat = (id: ExportFormatId) => {
    setFormatId(id);
    remember(FORMAT_KEY, id);
    setResult(null);
    setProgress(null);
  };

  const choose = async () => {
    const p = await window.api.chooseExportPath(fileName, format.ext, format.label);
    if (p) {
      chosen.current = true;
      setOutPath(p);
    }
  };

  const run = async () => {
    if (!outPath) return;
    useEditor.getState().setPlaying(false);
    abort.current = new AbortController();
    started.current = performance.now();
    setResult(null);
    setFinishing(false);
    setProgress({ done: 0, total: 1 });
    try {
      // A recording's audio tracks still being copied out: wait for them (they would be missing from the file).
      await whenAllTracksReady();
      const ready = onlySelection && selection ? project : useEditor.getState().project;
      const { path } = await exportProject(ready, {
        outPath,
        format: formatId,
        quality,
        gpu: useGpu && Boolean(gpuName),
        normalize,
        signal: abort.current.signal,
        onProgress: (done, total) => setProgress({ done, total }),
        onFinishing: () => setFinishing(true),
      });
      setResult({ ok: true, message: "Exportação concluída.", path });
    } catch (e) {
      const err = e as Error;
      setResult({ ok: false, message: err.name === "AbortError" ? "Exportação cancelada." : err.message });
    }
  };

  const pct = progress ? Math.round((progress.done / progress.total) * 100) : 0;
  const elapsed = (performance.now() - started.current) / 1000;
  const eta = progress && progress.done > 0 ? (elapsed / progress.done) * (progress.total - progress.done) : null;

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Exportar</h2>
        <dl className="export-summary">
          {!format.audioOnly && (
            <>
              <dt>Resolução</dt>
              <dd>
                {project.width}×{project.height}
              </dd>
              <dt>Quadros por segundo</dt>
              <dd>{project.fps}</dd>
            </>
          )}
          <dt>Duração</dt>
          <dd>{timecode(duration, project.fps)}</dd>
        </dl>
        {selection && (
          <label className="field">
            <span>O que exportar</span>
            <select
              value={onlySelection ? "selection" : "all"}
              disabled={running}
              onChange={(e) => {
                setOnlySelection(e.target.value === "selection");
                setResult(null);
                setProgress(null);
              }}
            >
              <option value="all">O projeto inteiro</option>
              <option value="selection">
                Só a seleção ({selectedClips.length} {selectedClips.length === 1 ? "item" : "itens"})
              </option>
            </select>
            {onlySelection && <small className="export-hint">Sai em um arquivo separado, sem o espaço vazio entre os itens. Seu projeto continua como está.</small>}
          </label>
        )}
        <label className="field">
          <span>Formato</span>
          <select value={formatId} disabled={running} onChange={(e) => pickFormat(e.target.value as ExportFormatId)}>
            {[...new Set(EXPORT_FORMATS.map((f) => f.group))].map((group) => (
              <optgroup key={group} label={group}>
                {EXPORT_FORMATS.filter((f) => f.group === group).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <small className="export-hint">{format.hint}</small>
          {format.id === "gif" && duration > 30 * SECOND && <small className="export-hint warn">Um GIF deste tamanho vai ficar muito pesado. Prefira trechos de até 30 segundos.</small>}
        </label>
        {!format.fixedQuality && (
          <label className="field">
            <span>Qualidade</span>
            <select value={quality} disabled={running} onChange={(e) => setQuality(e.target.value as ExportQuality)}>
              {QUALITY.map((q) => (
                <option key={q.id} value={q.id}>
                  {q.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {gpuName && (
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={useGpu}
              disabled={running}
              onChange={(e) => {
                setUseGpu(e.target.checked);
                remember(GPU_KEY, e.target.checked ? "1" : "0");
              }}
            />
            <span>Usar a placa de vídeo ({gpuName}): alivia o processador</span>
          </label>
        )}
        {!format.silent && (
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={normalize}
              disabled={running}
              onChange={(e) => {
                setNormalize(e.target.checked);
                remember(NORMALIZE_KEY, e.target.checked ? "1" : "0");
              }}
            />
            <span>Volume no padrão do YouTube (-14 LUFS): nem baixo nem estourando</span>
          </label>
        )}
        <div className="field">
          <span>Arquivo</span>
          <div className="path-picker">
            <code>{outPath ?? "nenhum arquivo escolhido"}</code>
            <button disabled={running} onClick={choose}>
              Escolher…
            </button>
          </div>
        </div>
        {progress && (
          <div className="progress">
            <div className="progress-bar">
              <div style={{ width: `${pct}%` }} />
            </div>
            <span>
              {finishing && running ? "Juntando o vídeo e o áudio…" : format.audioOnly ? (running ? "Mixando o áudio…" : "100%") : `${pct}% · quadro ${progress.done}/${progress.total}${running && eta !== null ? ` · ${formatEta(eta)} restantes` : ""}`}
            </span>
          </div>
        )}
        {credits && (
          <div className="field">
            <span>Créditos obrigatórios (cole na descrição do vídeo)</span>
            <textarea className="credits-text" readOnly rows={Math.min(6, credits.split("\n").length)} value={credits} />
            <button className="copy-credits" onClick={() => void navigator.clipboard.writeText(credits)}>
              Copiar créditos
            </button>
          </div>
        )}
        {result && <p className={result.ok ? "ok-text" : "error-text"}>{result.message}</p>}
        <div className="modal-actions">
          {result?.ok && result.path && <button onClick={() => window.api.revealFile(result.path!)}>Mostrar na pasta</button>}
          {running ? (
            <button onClick={() => abort.current?.abort()}>Cancelar</button>
          ) : (
            <>
              <button onClick={onClose}>Fechar</button>
              <button className="primary" disabled={!outPath || duration <= 0} onClick={run}>
                Exportar
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
