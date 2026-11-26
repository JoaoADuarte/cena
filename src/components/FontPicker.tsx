import { useEffect, useMemo, useRef, useState } from "react";
import type { CustomFont } from "../api";
import type { TextStyle } from "../model/types";
import { useEditor } from "../store";
import { GOOGLE_FONTS, SYSTEM_FONTS, googleCatalog, installedFonts, loadCustomFonts, loadGoogleFont } from "../fonts";

type Source = TextStyle["fontSource"];
interface Item {
  family: string;
  source: Source;
  note?: string;
}

const MAX_RESULTS = 80;
const CATEGORY_LABELS: Record<string, string> = {
  "Sans Serif": "Sem serifa",
  Serif: "Serifa",
  Display: "Decorativa",
  Handwriting: "Manuscrita",
  Monospace: "Monoespaçada",
};

/**
 * Searchable font list: fonts imported into Cena, fonts installed on this PC, and the whole
 * Google Fonts catalog (downloaded on first use).
 */
export function FontPicker({ family, onChange }: { family: string; onChange: (family: string, source: Source) => void }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [custom, setCustom] = useState<CustomFont[]>([]);
  const [local, setLocal] = useState<string[]>([]);
  const [google, setGoogle] = useState<{ family: string; category: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // Called from the click that opened the picker, which the Local Font Access API requires.
    installedFonts().then(setLocal, () => setLocal([]));
    loadCustomFonts().then(setCustom, () => setCustom([]));
    googleCatalog().then(setGoogle, (e: Error) => setError(e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")));
    const close = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const q = query.trim().toLowerCase();
  const sections = useMemo(() => {
    const match = (f: string) => !q || f.toLowerCase().includes(q);
    const customFamilies = [...new Set(custom.map((f) => f.family))];
    const builtIn = new Set([...SYSTEM_FONTS, ...customFamilies]);
    const out: { title: string; items: Item[] }[] = [];
    const imported = customFamilies.filter(match).map((f) => ({ family: f, source: "custom" as const }));
    if (imported.length) out.push({ title: "Importadas", items: imported });
    if (!q) out.push({ title: "Do Windows", items: SYSTEM_FONTS.map((f) => ({ family: f, source: undefined })) });
    const pc = local.filter((f) => !builtIn.has(f) && match(f));
    if (pc.length) out.push({ title: q ? "Instaladas no PC" : `Instaladas no PC (${pc.length})`, items: pc.slice(0, q ? MAX_RESULTS : 30).map((f) => ({ family: f, source: "installed" as const })) });
    const g = (google.length ? google : GOOGLE_FONTS.map((f) => ({ family: f, category: "" }))).filter((f) => match(f.family) && (!category || f.category === category));
    out.push({
      title: q || category ? `Google Fonts (${g.length})` : `Google Fonts — mais populares (de ${google.length || GOOGLE_FONTS.length})`,
      items: g.slice(0, q || category ? MAX_RESULTS : 40).map((f) => ({ family: f.family, source: "google" as const, note: CATEGORY_LABELS[f.category] ?? f.category })),
    });
    return out;
  }, [q, category, custom, local, google]);

  const choose = async (item: Item) => {
    setError(null);
    if (item.source === "google") {
      setBusy(item.family);
      try {
        await loadGoogleFont(item.family);
      } catch (e) {
        setError(`Não foi possível baixar "${item.family}": ${(e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "")}`);
        setBusy(null);
        return;
      }
      setBusy(null);
    }
    onChange(item.family, item.source);
    setOpen(false);
  };

  const importFiles = async () => {
    const list = await window.api.importFonts();
    if (!list) return;
    setCustom(await loadCustomFonts(true));
    useEditor.getState().setStatus(`${list.length} fonte(s) importada(s) no total.`);
  };

  return (
    <div className="font-picker" ref={root}>
      <button className="font-picker-button" style={{ fontFamily: `"${family}", "Segoe UI"` }} onClick={() => setOpen(!open)}>
        {family}
        <span className="caret">▾</span>
      </button>
      {open && (
        <div className="font-picker-pop">
          <div className="font-picker-search">
            <input autoFocus value={query} placeholder="Buscar fonte…" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)} />
            <select value={category} onChange={(e) => setCategory(e.target.value)} title="Estilo (Google Fonts)">
              <option value="">Todos os estilos</option>
              {Object.entries(CATEGORY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {error && <p className="error-text">{error}</p>}
          <div className="font-picker-list">
            {sections.map((s) => (
              <div key={s.title}>
                <h4 className="lib-group">{s.title}</h4>
                {s.items.map((item) => (
                  <button
                    key={`${item.source}-${item.family}`}
                    className={`font-item${item.family === family ? " active" : ""}`}
                    // Installed and imported fonts can preview in their own face; Google ones only once downloaded.
                    style={item.source !== "google" ? { fontFamily: `"${item.family}", "Segoe UI"` } : undefined}
                    onClick={() => void choose(item)}
                  >
                    <span>{item.family}</span>
                    {busy === item.family ? <span className="spinner" /> : item.note && <small>{item.note}</small>}
                  </button>
                ))}
                {s.items.length === 0 && <p className="hint">Nada encontrado.</p>}
              </div>
            ))}
          </div>
          <div className="font-picker-footer">
            <button onClick={() => void importFiles()}>Importar arquivo de fonte (.ttf, .otf, .woff2)…</button>
            {local.length === 0 && <span className="hint">As fontes instaladas no PC aparecem aqui quando o Windows permite listá-las.</span>}
          </div>
        </div>
      )}
    </div>
  );
}
