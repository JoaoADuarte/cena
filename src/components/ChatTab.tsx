import { useEffect, useRef, useState } from "react";
import { CHAT_MODELS, cancelChat, checkClaude, newConversation, sendChat, setChatModel, useChat } from "../chat";
import { Icon } from "./controls";
import type { Preference } from "../api";
import { create } from "zustand";

/** A request the studio prepared for the assistant ("edit in this style"); the creator reads it and sends it. */
export const useChatPrefill = create<{ text: string | null }>(() => ({ text: null }));
// Listened from the start, so a request sent while the home screen is up waits for the project to open.
window.api?.onChatPrefill?.((text) => useChatPrefill.setState({ text }));

type ActiveStyle = { id: string; name: string; topic: string } | null;

/** The style studied in the studio's Trends tab that the assistant follows, kept current. */
function useActiveStyle(): [ActiveStyle, () => void] {
  const [style, setStyle] = useState<ActiveStyle>(null);
  const load = () => {
    void window.api.studioAvailable().then((ok) => (ok ? window.api.studioCall("activeStyle").then(setStyle) : setStyle(null))).catch(() => setStyle(null));
  };
  useEffect(() => {
    load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);
  return [style, load];
}

/** Saved preferences, kept current when the assistant or the panel changes them. */
function usePreferences(): Preference[] {
  const [items, setItems] = useState<Preference[]>([]);
  useEffect(() => {
    let alive = true;
    void window.api.memoryList().then((list) => alive && setItems(list));
    const off = window.api.onMemoryChanged(setItems);
    return () => {
      alive = false;
      off();
    };
  }, []);
  return items;
}

/** Folders of the user's own media that the assistant may read and edit (memes, sounds, a memes.txt catalog). */
function FoldersPanel() {
  const [folders, setFolders] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void window.api.aiFoldersList().then(setFolders);
  }, []);
  const guard = (p: Promise<string[]>) => p.then((list) => (setFolders(list), setError(null))).catch((e: Error) => setError(e.message));
  return (
    <div className="memory-panel ai-folders">
      <p className="hint">Pastas com seus memes, sons e músicas. A IA pode usar e editar os arquivos delas; se tiver um memes.txt, ela lê antes de escolher um meme.</p>
      <ul>
        {folders.map((f) => (
          <li key={f}>
            <span title={f}>{f}</span>
            <button className="memory-remove" title="Tirar o acesso da IA" onClick={() => void guard(window.api.aiFoldersRemove(f))}>
              <Icon name="close" />
            </button>
          </li>
        ))}
      </ul>
      <button className="load-more" onClick={() => void guard(window.api.aiFoldersAdd())}>
        <Icon name="plus" /> Adicionar pasta
      </button>
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

/** What the assistant remembers between conversations; the user can add, edit and delete. */
function MemoryPanel({ prefs }: { prefs: Preference[] }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const guard = (p: Promise<unknown>) => p.then(() => setError(null)).catch((e: Error) => setError(e.message));
  const add = () => {
    if (!draft.trim()) return;
    void guard(window.api.memoryAdd(draft).then(() => setDraft("")));
  };
  const save = () => {
    if (!editing) return;
    void guard(window.api.memoryUpdate(editing.id, editing.text).then(() => setEditing(null)));
  };
  return (
    <div className="memory-panel">
      <p className="hint">
        O assistente lê esta lista no começo de toda conversa e anota sozinho quando você diz algo como "sempre", "prefiro" ou "meus vídeos são…".
      </p>
      {prefs.length === 0 && <p className="memory-empty">Nada guardado ainda.</p>}
      <ul>
        {prefs.map((p) =>
          editing?.id === p.id ? (
            <li key={p.id}>
              <input
                autoFocus
                value={editing.text}
                onChange={(e) => setEditing({ id: p.id, text: e.target.value })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                  if (e.key === "Escape") setEditing(null);
                }}
                onBlur={save}
              />
            </li>
          ) : (
            <li key={p.id}>
              <span title="Clique para editar" onClick={() => setEditing({ id: p.id, text: p.text })}>
                {p.text}
              </span>
              <button className="memory-remove" title="Esquecer" onClick={() => void guard(window.api.memoryRemove(p.id))}>
                <Icon name="close" />
              </button>
            </li>
          ),
        )}
      </ul>
      <form
        className="memory-add"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input value={draft} placeholder="Ex.: legendas sempre amarelas com contorno preto" onChange={(e) => setDraft(e.target.value)} />
        <button type="submit" disabled={!draft.trim()}>
          <Icon name="plus" />
        </button>
      </form>
      {prefs.length > 1 && (
        <button className="load-more" onClick={() => confirm("Esquecer todas as preferências?") && void guard(window.api.memoryClear())}>
          Esquecer tudo
        </button>
      )}
      {error && <p className="error-text">{error}</p>}
    </div>
  );
}

const SUGGESTIONS = [
  "Corte os silêncios do vídeo",
  "Gere legendas amarelas",
  "Deixe o vídeo vertical para Reels",
  "Crie com o HyperFrames um título animado no começo",
];

/** The assistant: type a request, Claude Code edits the project while you watch. */
export function ChatTab() {
  const { messages, running, model, claude } = useChat();
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const prefs = usePreferences();
  const [showMemory, setShowMemory] = useState(false);
  const [style, reloadStyle] = useActiveStyle();
  const prefill = useChatPrefill((s) => s.text);

  useEffect(() => {
    if (claude === undefined) void checkClaude();
  }, [claude]);

  useEffect(() => {
    if (prefill === null) return;
    setDraft(prefill);
    useChatPrefill.setState({ text: null });
    reloadStyle();
  }, [prefill]);

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight });
  }, [messages, running]);

  const send = (text: string) => {
    if (!text.trim() || running) return;
    setDraft("");
    void sendChat(text.trim());
  };

  if (claude === null) {
    return (
      <div className="library-body">
        <p className="empty-hint">
          O assistente usa o Claude Code deste computador, com o seu login, e não encontrei ele aqui. Instale o app Claude (que traz o Claude Code) ou o Claude Code
          de terminal, entre na sua conta e volte a esta aba.
        </p>
        <button className="import-btn" onClick={() => void window.api.openExternal("https://claude.com/download")}>
          Baixar o Claude
        </button>
        <button className="load-more" onClick={() => void checkClaude()}>
          Procurar de novo
        </button>
      </div>
    );
  }

  return (
    <div className="library-body chat">
      <div className="chat-head">
        <select value={model} onChange={(e) => setChatModel(e.target.value)} disabled={running} title="Modelo do Claude">
          {CHAT_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button className={showMemory ? "toggle-on" : ""} onClick={() => setShowMemory(!showMemory)} title="O que o assistente lembra sobre o seu jeito de editar">
          <Icon name="memory" /> {prefs.length || ""}
        </button>
        <button onClick={newConversation} disabled={running || messages.length === 0} title="Começar uma conversa do zero">
          Nova conversa
        </button>
      </div>
      {style ? (
        <div className="chat-style" title={`O assistente segue este estilo quando você pede para editar "no estilo". Ele foi estudado dos vídeos mais vistos sobre "${style.topic}".`}>
          <Icon name="sparkle" /> Estilo: <b>{style.name}</b>
          <button onClick={() => void window.api.openStudio("trends")}>Ver</button>
          <button onClick={() => void window.api.studioCall("setActiveStyle", null).then(reloadStyle)} title="Parar de seguir este estilo">
            Desligar
          </button>
        </div>
      ) : (
        <button className="chat-style-open" onClick={() => void window.api.openStudio("trends")} title="Pesquise os vídeos mais vistos de um assunto e copie o estilo de edição e roteiro">
          <Icon name="sparkle" /> Tendências: copiar o estilo dos vídeos mais vistos
        </button>
      )}
      {showMemory && <MemoryPanel prefs={prefs} />}
      {showMemory && <FoldersPanel />}
      <div className="chat-messages" ref={list}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Peça uma edição e acompanhe a timeline mudando. Tudo pode ser desfeito com Ctrl+Z.</p>
            {SUGGESTIONS.map((s) => (
              <button key={s} onClick={() => send(s)} disabled={running || claude === undefined}>
                {s}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`chat-msg ${m.role}`}>
            {m.parts.map((p, i) =>
              p.kind === "text" ? (
                <p key={i}>{p.text}</p>
              ) : (
                <span key={i} className="chat-tool">
                  <Icon name="sparkle" /> {p.label}
                </span>
              ),
            )}
          </div>
        ))}
        {running && <div className="chat-working">Trabalhando…</div>}
      </div>
      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(draft);
        }}
      >
        <textarea
          rows={3}
          value={draft}
          placeholder="Ex.: corte de 0:12 a 0:18 e coloque uma música calma"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send(draft);
            }
          }}
        />
        {running ? (
          <button type="button" onClick={cancelChat}>
            Parar
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!draft.trim() || claude === undefined}>
            Enviar
          </button>
        )}
      </form>
    </div>
  );
}
