import { useEffect, useRef, useState } from "react";
import type { LibraryItem } from "../api";
import { useEditor } from "../store";
import { mediaUrl } from "../engine/mediaPool";
import { Icon } from "./controls";

type Category = "music" | "sound_effect" | "builtin";

const SUGGESTIONS: Record<"music" | "sound_effect", string[]> = {
  music: ["lofi", "piano", "acoustic", "electronic", "cinematic", "rock", "ambient", "happy"],
  sound_effect: ["whoosh", "click", "applause", "rain", "laugh", "notification", "explosion", "birds"],
};

function formatDuration(seconds: number | null) {
  if (seconds === null) return "";
  const s = Math.round(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Add a local audio file to the project (with its credit) and drop it on the timeline, at the playhead by default. */
export async function addAudio(path: string, credit?: LibraryItem, start?: number) {
  const { importFiles, mutate, addMaterialToTimeline, playhead } = useEditor.getState();
  const [material] = await importFiles([path]);
  if (!material) return null;
  if (credit) {
    mutate(
      (p) => {
        p.materials[material.id].name = credit.title;
        p.materials[material.id].credit = {
          title: credit.title,
          creator: credit.creator,
          license: credit.license,
          url: credit.landingUrl,
          needsCredit: credit.needsCredit,
        };
      },
      { history: false },
    );
  }
  return addMaterialToTimeline(material.id, { start: start ?? playhead });
}

/** One shared <audio> element so only one preview plays at a time. */
function usePreviewPlayer() {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const toggle = (key: string, src: string) => {
    if (!audio.current) {
      audio.current = new Audio();
      audio.current.onended = () => setPlaying(null);
    }
    const a = audio.current;
    if (playing === key) {
      a.pause();
      setPlaying(null);
      return;
    }
    a.src = src;
    void a.play().catch(() => setPlaying(null));
    setPlaying(key);
  };
  return { playing, toggle };
}

export function SoundsTab() {
  const [category, setCategory] = useState<Category>("music");
  const [query, setQuery] = useState("");
  const [commercial, setCommercial] = useState(true);
  const [state, setState] = useState<{ loading: boolean; error: string | null; results: LibraryItem[]; total: number; page: number; pages: number }>({
    loading: false,
    error: null,
    results: [],
    total: 0,
    page: 1,
    pages: 1,
  });
  const [builtins, setBuiltins] = useState<{ id: string; name: string; path: string }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { playing, toggle } = usePreviewPlayer();
  const searchId = useRef(0);

  const search = async (q: string, page = 1) => {
    if (category === "builtin") return;
    const id = ++searchId.current;
    setState((s) => ({ ...s, loading: true, error: null, ...(page === 1 ? { results: [] } : {}) }));
    try {
      const res = await window.api.librarySearch({ query: q, category, page, commercial });
      if (id !== searchId.current) return;
      setState((s) => ({ loading: false, error: null, results: page === 1 ? res.results : [...s.results, ...res.results], total: res.total, page, pages: res.pages }));
    } catch (e) {
      if (id !== searchId.current) return;
      setState((s) => ({ ...s, loading: false, error: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "") }));
    }
  };

  useEffect(() => {
    if (category === "builtin") {
      if (!builtins) window.api.libraryBuiltins().then(setBuiltins, (e: Error) => setState((s) => ({ ...s, error: e.message })));
      return;
    }
    void search(query);
    // Re-run when the category or license filter changes; typing searches on Enter.
  }, [category, commercial]);

  const add = async (item: LibraryItem) => {
    setBusy(item.id);
    try {
      const path = await window.api.libraryDownload(item);
      await addAudio(path, item);
    } catch (e) {
      useEditor.getState().setStatus(`Falha ao baixar: ${(e as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="library-body sounds">
      <div className="segmented">
        {(
          [
            ["music", "Músicas"],
            ["sound_effect", "Sons"],
            ["builtin", "Prontos"],
          ] as const
        ).map(([value, label]) => (
          <button key={value} className={category === value ? "active" : ""} onClick={() => setCategory(value)}>
            {label}
          </button>
        ))}
      </div>

      {category === "builtin" ? (
        <>
          <p className="empty-hint">Efeitos criados pelo próprio Cena: funcionam offline e podem ser usados livremente.</p>
          <ul className="sound-list">
            {builtins?.map((b) => (
              <li key={b.id} className="sound-item">
                <button className={`icon-btn play-btn${playing === b.id ? " on" : ""}`} title="Ouvir" onClick={() => toggle(b.id, mediaUrl(b.path))}>
                  <Icon name={playing === b.id ? "pause" : "play"} />
                </button>
                <div className="sound-info">
                  <strong>{b.name}</strong>
                </div>
                <button className="sound-add" title="Adicionar na posição do cursor" onClick={() => void addAudio(b.path)}>
                  <Icon name="plus" />
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <>
          <form
            className="sound-search"
            onSubmit={(e) => {
              e.preventDefault();
              void search(query);
            }}
          >
            <input value={query} placeholder={category === "music" ? "Buscar músicas (em inglês funciona melhor)" : "Buscar efeitos (ex.: whoosh)"} onChange={(e) => setQuery(e.target.value)} />
            <button type="submit">Buscar</button>
          </form>
          <div className="sound-suggestions">
            {SUGGESTIONS[category].map((s) => (
              <button
                key={s}
                onClick={() => {
                  setQuery(s);
                  void search(s);
                }}
              >
                {s}
              </button>
            ))}
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={commercial} onChange={(e) => setCommercial(e.target.checked)} />
            <span>Só licenças que permitem uso comercial</span>
          </label>
          {state.error && <p className="error-text">{state.error}</p>}
          {!state.loading && !state.error && state.results.length === 0 && <p className="empty-hint">Nenhum resultado.</p>}
          <ul className="sound-list">
            {state.results.map((r) => (
              <li key={r.id} className="sound-item">
                <button className={`icon-btn play-btn${playing === r.id ? " on" : ""}`} title="Ouvir" onClick={() => toggle(r.id, r.url)}>
                  <Icon name={playing === r.id ? "pause" : "play"} />
                </button>
                <div className="sound-info" title={`${r.title} — ${r.creator}`}>
                  <strong>{r.title}</strong>
                  <small>
                    {r.creator} · {formatDuration(r.duration)} ·{" "}
                    <a
                      href="#"
                      onClick={(e) => {
                        e.preventDefault();
                        if (r.landingUrl) void window.api.openExternal(r.landingUrl);
                      }}
                    >
                      {r.license}
                    </a>
                  </small>
                </div>
                <button className="sound-add" disabled={busy !== null} title="Baixar e adicionar na posição do cursor" onClick={() => void add(r)}>
                  {busy === r.id ? <span className="spinner" /> : <Icon name="plus" />}
                </button>
              </li>
            ))}
          </ul>
          {state.loading && (
            <p className="empty-hint">
              <span className="spinner" /> Buscando no Openverse… A primeira busca de um termo pode levar até um minuto; as seguintes são rápidas.
            </p>
          )}
          {!state.loading && state.page < state.pages && state.results.length > 0 && (
            <button className="load-more" onClick={() => void search(query, state.page + 1)}>
              Carregar mais
            </button>
          )}
          <p className="sound-credit-note">
            Músicas do Jamendo e sons do Freesound via Openverse, sob licenças Creative Commons. Licenças "BY" exigem dar crédito ao
            autor: o Cena guarda o crédito e mostra o texto pronto na exportação.
          </p>
        </>
      )}
    </div>
  );
}
