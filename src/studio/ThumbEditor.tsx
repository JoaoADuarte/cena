import { useEffect, useRef, useState } from "react";
import { mediaUrl } from "../engine/mediaPool";
import { act, type StudioVideo } from "./store";

type Thumb = NonNullable<StudioVideo["data"]["thumbnails"]>[number];
type ExtraText = { kind: "text"; id: number; text: string; x: number; y: number; size: number; colour: string };
type ExtraImage = { kind: "image"; id: number; path: string; x: number; y: number; w: number };
type Extra = ExtraText | ExtraImage;

let nextId = 1;

/**
 * Changes one thumbnail: its main text, colour and position, takes out the arrow, ring, face, zoom or image, and adds
 * texts and images that are dragged on the picture. Saving makes a new option (the original stays) and chooses it.
 */
export function ThumbEditor({ video, index, onClose }: { video: StudioVideo; index: number; onClose: () => void }) {
  const t = video.data.thumbnails![index] as Thumb;
  const d = t.design;
  const plain = !d || Boolean(d.plain);
  const [text, setText] = useState(d?.text ?? "");
  const [accent, setAccent] = useState(d?.accent ?? "");
  const [colour, setColour] = useState<string>(d?.colour && /^#[0-9a-f]{6}$/i.test(d.colour) ? d.colour : "#ffd400");
  const [textAt, setTextAt] = useState(d?.textAt ?? "bottom");
  const [arrow, setArrow] = useState(Boolean(d?.arrow));
  const [ring, setRing] = useState(Boolean(d?.ring));
  const [face, setFace] = useState(Boolean(d?.faceFile));
  const [faceAt, setFaceAt] = useState(d?.faceAt ?? "tl");
  const [asset, setAsset] = useState(Boolean(d?.assetFile));
  const [zoom, setZoom] = useState(Number(d?.zoom?.scale ?? 1));
  const [extras, setExtras] = useState<Extra[]>(() => [
    ...(d?.extras?.texts ?? []).map((x) => ({ kind: "text" as const, id: nextId++, text: x.text, x: x.x, y: x.y, size: x.size, colour: x.colour ?? "#ffffff" })),
    ...(d?.extras?.images ?? []).map((m) => ({ kind: "image" as const, id: nextId++, path: m.path, x: m.x, y: m.y, w: m.w })),
  ]);
  const [selected, setSelected] = useState<number | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);

  const design = () => ({
    text,
    accent,
    colour,
    textAt,
    arrow: arrow ? (d?.arrow ?? null) : null,
    ring: ring ? (d?.ring ?? null) : null,
    zoom: d?.zoom ? { ...d.zoom, scale: zoom } : zoom > 1.01 ? { x: 0.5, y: 0.5, scale: zoom } : null,
    faceAt,
    ...(face ? {} : { faceFile: null }),
    ...(asset ? {} : { assetFile: null }),
  });
  const payload = () => ({
    design: design(),
    extras: {
      texts: extras.filter((e): e is ExtraText => e.kind === "text").map(({ text, x, y, size, colour }) => ({ text, x, y, size, colour })),
      images: extras.filter((e): e is ExtraImage => e.kind === "image").map(({ path, x, y, w }) => ({ path, x, y, w })),
    },
  });

  // The picture under the extras is drawn again a moment after a change.
  const key = JSON.stringify(design());
  useEffect(() => {
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const file = await window.api.studioCall("editThumbnail", video.id, index, { design: design() }, false);
        if (live) (setPreview(file as string), setError(null));
      } catch (e) {
        if (live) setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      }
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.closest("input, textarea, select");
      if (e.key === "Escape") onClose();
      else if ((e.key === "Delete" || e.key === "Backspace") && !typing && selected !== null) {
        setExtras((l) => l.filter((x) => x.id !== selected));
        setSelected(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, onClose]);

  const k = width / 1280;
  const change = (id: number, patch: Partial<ExtraText> & Partial<ExtraImage>) => setExtras((l) => l.map((x) => (x.id === id ? ({ ...x, ...patch } as Extra) : x)));
  const drag = (e: React.PointerEvent, item: Extra) => {
    e.preventDefault();
    e.stopPropagation();
    setSelected(item.id);
    const box = stage.current!.getBoundingClientRect();
    const dx = e.clientX - (box.left + item.x * box.width);
    const dy = e.clientY - (box.top + item.y * box.height);
    const move = (ev: PointerEvent) => change(item.id, { x: Math.min(1, Math.max(0, (ev.clientX - dx - box.left) / box.width)), y: Math.min(1, Math.max(0, (ev.clientY - dy - box.top) / box.height)) });
    const up = () => (window.removeEventListener("pointermove", move), window.removeEventListener("pointerup", up));
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const addText = () => {
    const item: ExtraText = { kind: "text", id: nextId++, text: "TEXTO", x: 0.5, y: 0.5, size: 110, colour: "#ffffff" };
    setExtras((l) => [...l, item]);
    setSelected(item.id);
  };
  const addImages = async () => {
    const picked = ((await act("pickImages")) as string[] | undefined) ?? [];
    const made = picked.map((p, i) => ({ kind: "image" as const, id: nextId++, path: p, x: 0.72 + i * 0.03, y: 0.55 + i * 0.03, w: 0.3 }));
    if (made.length) (setExtras((l) => [...l, ...made]), setSelected(made[made.length - 1].id));
  };
  const save = async () => {
    setWorking(true);
    try {
      await window.api.studioCall("editThumbnail", video.id, index, payload(), true);
      onClose();
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
    } finally {
      setWorking(false);
    }
  };
  const sel = extras.find((x) => x.id === selected) ?? null;
  const words = text.split(/\s+/).filter(Boolean);

  return (
    <div className="thumb-editor" onPointerDown={() => setSelected(null)}>
      <div className="thumb-editor-main">
        <div className="thumb-stage" ref={stage}>
          {preview ? <img className="thumb-base" src={mediaUrl(preview)} alt="" draggable={false} /> : <div className="thumb-base thumb-wait">Desenhando…</div>}
          {extras.map((x) =>
            x.kind === "text" ? (
              <div
                key={x.id}
                className={`thumb-x thumb-xt${x.id === selected ? " on" : ""}`}
                style={{ left: `${x.x * 100}%`, top: `${x.y * 100}%`, fontSize: x.size * k, color: x.colour, WebkitTextStroke: `${Math.max(4, Math.round(x.size / 11)) * k}px #000`, textShadow: `0 ${Math.round(x.size / 18) * k}px 0 #000` }}
                onPointerDown={(e) => drag(e, x)}
              >
                {x.text.split("\n").map((line, i) => (
                  <div key={i}>{line || " "}</div>
                ))}
              </div>
            ) : (
              <img key={x.id} className={`thumb-x thumb-xi${x.id === selected ? " on" : ""}`} src={mediaUrl(x.path)} alt="" draggable={false} style={{ left: `${x.x * 100}%`, top: `${x.y * 100}%`, width: `${x.w * 100}%` }} onPointerDown={(e) => drag(e, x)} />
            ),
          )}
        </div>
        <p className="studio-hint">Arraste os textos e imagens que você adicionou. Delete apaga o selecionado. Salvar cria uma opção nova e a escolhe; a original continua lá.</p>
      </div>

      <aside className="thumb-editor-side" onPointerDown={(e) => e.stopPropagation()}>
        <h3>Editar thumbnail</h3>
        {plain && <p className="studio-hint">Esta thumb foi feita antes do editor: dá para adicionar textos e imagens por cima, mas não tirar o que já está nela.</p>}
        {!plain && (
          <>
            <label>
              Texto principal
              <input value={text} maxLength={60} onChange={(e) => setText(e.target.value)} placeholder="(vazio = sem texto)" />
            </label>
            {words.length > 1 && (
              <label>
                Palavra em destaque
                <select value={words.some((w) => w.toUpperCase() === accent.toUpperCase()) ? words.find((w) => w.toUpperCase() === accent.toUpperCase()) : ""} onChange={(e) => setAccent(e.target.value)}>
                  <option value="">Última</option>
                  {words.map((w, i) => (
                    <option key={i} value={w}>
                      {w}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="inline">
              <label>
                Cor
                <input type="color" value={colour} onChange={(e) => setColour(e.target.value)} />
              </label>
              <label>
                Posição
                <select value={textAt} onChange={(e) => setTextAt(e.target.value)}>
                  <option value="top">Em cima</option>
                  <option value="bottom">Embaixo</option>
                  <option value="left">Esquerda</option>
                  <option value="right">Direita</option>
                </select>
              </label>
            </div>
            <h4>O que aparece</h4>
            <label className="check">
              <input type="checkbox" checked={arrow} disabled={!d?.arrow} onChange={(e) => setArrow(e.target.checked)} /> Seta
            </label>
            <label className="check">
              <input type="checkbox" checked={ring} disabled={!d?.ring} onChange={(e) => setRing(e.target.checked)} /> Círculo de destaque
            </label>
            <label className="check">
              <input type="checkbox" checked={face} disabled={!d?.faceFile && !d?.originalFace} onChange={(e) => setFace(e.target.checked)} /> Rosto (webcam)
              {face && (
                <select value={faceAt} onChange={(e) => setFaceAt(e.target.value)}>
                  <option value="tl">canto sup. esq.</option>
                  <option value="tr">canto sup. dir.</option>
                  <option value="bl">canto inf. esq.</option>
                  <option value="br">canto inf. dir.</option>
                </select>
              )}
            </label>
            <label className="check">
              <input type="checkbox" checked={asset} disabled={!d?.assetFile && !d?.originalAsset} onChange={(e) => setAsset(e.target.checked)} /> Imagem do agente
            </label>
            <label>
              Zoom no quadro: {zoom.toFixed(2)}×
              <input type="range" min={1} max={1.8} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
            </label>
          </>
        )}

        <h4>Adicionar</h4>
        <div className="inline">
          <button onClick={addText}>+ Texto</button>
          <button onClick={() => void addImages()}>+ Imagem</button>
        </div>
        {sel?.kind === "text" && (
          <div className="thumb-sel">
            <textarea rows={2} value={sel.text} onChange={(e) => change(sel.id, { text: e.target.value })} />
            <label>
              Tamanho
              <input type="range" min={24} max={300} value={sel.size} onChange={(e) => change(sel.id, { size: Number(e.target.value) })} />
            </label>
            <div className="inline">
              <input type="color" value={sel.colour} onChange={(e) => change(sel.id, { colour: e.target.value })} />
              <button onClick={() => (setExtras((l) => l.filter((x) => x.id !== sel.id)), setSelected(null))}>Remover texto</button>
            </div>
          </div>
        )}
        {sel?.kind === "image" && (
          <div className="thumb-sel">
            <span className="studio-hint">{sel.path.split(/[\\/]/).pop()}</span>
            <label>
              Tamanho
              <input type="range" min={0.05} max={1.2} step={0.01} value={sel.w} onChange={(e) => change(sel.id, { w: Number(e.target.value) })} />
            </label>
            <button onClick={() => (setExtras((l) => l.filter((x) => x.id !== sel.id)), setSelected(null))}>Remover imagem</button>
          </div>
        )}

        {error && <p className="card-error">{error}</p>}
        <div className="thumb-editor-actions">
          <button className="primary" disabled={working || !preview} onClick={() => void save()}>
            {working ? "Salvando…" : "Salvar e usar esta"}
          </button>
          <button onClick={onClose}>Cancelar</button>
        </div>
      </aside>
    </div>
  );
}
