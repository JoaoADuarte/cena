import { useEffect, useRef, useState } from "react";
import { useEditor } from "./store";
import { Library } from "./components/Library";
import { Preview } from "./components/Preview";
import { Inspector } from "./components/Inspector";
import { Timeline } from "./components/Timeline";
import { ExportDialog } from "./components/ExportDialog";
import { useUi } from "./ui";
import { AiJobBar } from "./components/AiJobBar";
import { ShortcutsDialog } from "./components/ShortcutsDialog";
import { AgentDialog } from "./components/AgentDialog";
import { SendToStudioDialog } from "./components/SendToStudio";
import { PublishDialog } from "./components/PublishDialog";
import { useAgent } from "./agent";
import { actionFor, runAction, type ShortcutContext } from "./shortcuts";
import { loadCustomFonts } from "./fonts";
import { Icon } from "./components/controls";
import { Home } from "./components/Home";
import { useAutosave } from "./autosave";
import type { Project } from "./model/types";

/** Returns where it was saved, or null when the user cancelled the dialog. */
async function saveProject(saveAs = false): Promise<string | null> {
  const { project, projectPath, markSaved, setStatus } = useEditor.getState();
  const path = await window.api.saveProject(project, saveAs ? null : projectPath);
  if (path) {
    markSaved(path);
    setStatus("Projeto salvo.");
    setTimeout(() => useEditor.getState().setStatus(null), 2000);
  }
  return path;
}

function loadProjectFile(res: { path: string; data: Project }): boolean {
  const { loadProject, setStatus } = useEditor.getState();
  const data = res.data;
  if (data?.version !== 1 || !Array.isArray(data.tracks)) {
    setStatus("Arquivo de projeto inválido.");
    return false;
  }
  loadProject(data, res.path);
  return true;
}

/** `confirmed`: the caller already asked about unsaved changes. */
async function openProject(confirmed = false): Promise<boolean> {
  if (!confirmed && useEditor.getState().dirty && !confirm("Descartar as alterações do projeto atual?")) return false;
  const res = await window.api.openProject();
  return res ? loadProjectFile(res) : false;
}

async function openProjectPath(path: string): Promise<boolean> {
  try {
    return loadProjectFile(await window.api.readProject(path));
  } catch {
    return false;
  }
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") return !["range", "checkbox", "color", "button"].includes((el as HTMLInputElement).type);
  return false;
}

/** Reassurance next to the project name, and a warning if copies stop working. */
function AutosaveNote() {
  const { savedAt, failed } = useAutosave();
  if (failed) return <span className="autosave-note failed">Falha no salvamento automático</span>;
  if (savedAt === null) return null;
  const time = new Date(savedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return (
    <span className="autosave-note" title="Se a luz cair ou o app travar, o Cena oferece recuperar este trabalho ao abrir. Ctrl+S grava no arquivo do projeto.">
      Cópia automática às {time}
    </span>
  );
}

export function App() {
  const [exporting, setExporting] = useState(false);
  const exportSelection = useUi((s) => s.exportSelection);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showAgent, setShowAgent] = useState(false);
  const [sendingToStudio, setSendingToStudio] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const agentOn = useAgent((s) => s.server?.running ?? false);
  const name = useEditor((s) => s.project.name);
  const dirty = useEditor((s) => s.dirty);
  const status = useEditor((s) => s.status);
  // The start screen shows first, unless a .cena file was double-clicked (or the self test runs).
  const [home, setHome] = useState(() => !window.api?.smoke);
  const homeRef = useRef(home);
  homeRef.current = home;

  useEffect(() => {
    const ctx: ShortcutContext = {
      save: (saveAs) => void saveProject(saveAs),
      open: () => void openProject(),
      exportVideo: () => setExporting(true),
      showShortcuts: () => setShowShortcuts(true),
    };
    const onKey = (e: KeyboardEvent) => {
      if (homeRef.current || isTyping(e.target) || document.querySelector(".modal-backdrop")) return;
      const action = actionFor(e);
      if (action && runAction(action, ctx)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    document.title = `${dirty ? "• " : ""}${name} — Cena`;
    window.api?.reportState?.({ dirty, name });
  }, [name, dirty]);

  useEffect(
    () =>
      // "Salvar e fechar" in the close confirmation: save (asking where for a new project), then close.
      window.api?.onSaveAndClose?.(async () => {
        if (await saveProject()) void window.api.closeNow();
      }),
    [],
  );

  useEffect(() => {
    const show = () => setHome(false);
    window.addEventListener("cena:project-opened", show);
    return () => window.removeEventListener("cena:project-opened", show);
  }, []);

  useEffect(() => {
    // Imported fonts are registered up front so text using them renders right away.
    void loadCustomFonts().catch(() => []);
  }, []);

  useEffect(() => {
    // Opened by double-clicking a .cena file.
    window.api?.initialProject?.().then(
      async (res) => {
        if (!res || !loadProjectFile(res)) return;
        // Work waiting to be recovered is offered on the start screen first.
        if (!(await window.api.autosaveList()).length) setHome(false);
      },
      (e: Error) => useEditor.getState().setStatus(`Falha ao abrir projeto: ${e.message}`),
    );
  }, []);

  if (home) return <Home onEnter={() => setHome(false)} onOpenFile={() => openProject(true)} onOpenPath={openProjectPath} />;

  return (
    <div className="app">
      <header className="topbar">
        <button className="brand home-btn" onClick={() => setHome(true)} title="Início: todos os projetos">
          <Icon name="home" /> Cena
        </button>
        <button
          onClick={() => {
            const s = useEditor.getState();
            if (!s.dirty || confirm("Descartar as alterações do projeto atual?")) s.newProject();
          }}
          title="Novo projeto"
        >
          <Icon name="file" /> Novo
        </button>
        <button onClick={() => void openProject()} title="Abrir (Ctrl+O)">
          <Icon name="folder" /> Abrir
        </button>
        <button onClick={() => saveProject()} title="Salvar (Ctrl+S)">
          <Icon name="save" /> Salvar
        </button>
        <div className="project-name">
          {name}
          {dirty && <span className="dirty-dot" title="Alterações não salvas" />}
          <AutosaveNote />
        </div>
        {status && <div className="status">{status}</div>}
        <AiJobBar />
        <button className="icon-only" onClick={() => setShowShortcuts(true)} title="Atalhos de teclado (Ctrl+K)">
          <Icon name="keyboard" />
        </button>
        <button onClick={() => void window.api.openStudio()} title="Estúdio: agentes de IA que cortam, limpam o áudio e preparam os vídeos para você aprovar">
          <Icon name="film" /> Estúdio
        </button>
        <button onClick={() => setSendingToStudio(true)} title="Mandar este projeto para os agentes do Estúdio, dizendo como você quer a edição">
          <Icon name="sparkle" /> Enviar ao Estúdio
        </button>
        <button onClick={() => setPublishing(true)} title="Publicar no YouTube como está aqui: exporta, manda para o Estúdio com título, descrição e data, e aparece no Calendário. Sobe depois da sua aprovação no Estúdio.">
          <Icon name="export" /> Publicar
        </button>
        <button className="agent-btn" onClick={() => setShowAgent(true)} title="Deixar o Claude Code ou outra IA editar o projeto">
          <Icon name="sparkle" /> Conectar IA
          {agentOn && <span className="agent-dot" title="Conexão de IA ligada" />}
        </button>
        <button className="primary export-btn" onClick={() => setExporting(true)} title="Exportar (Ctrl+E)">
          <Icon name="export" /> Exportar
        </button>
      </header>
      <main className="workspace">
        <Library />
        <Preview />
        <Inspector />
      </main>
      <Timeline />
      {(exporting || exportSelection) && (
        <ExportDialog
          selectionFirst={exportSelection}
          onClose={() => {
            setExporting(false);
            useUi.getState().set({ exportSelection: false });
          }}
        />
      )}
      {showShortcuts && <ShortcutsDialog onClose={() => setShowShortcuts(false)} />}
      {showAgent && <AgentDialog onClose={() => setShowAgent(false)} />}
      {sendingToStudio && <SendToStudioDialog onClose={() => setSendingToStudio(false)} />}
      {publishing && <PublishDialog onClose={() => setPublishing(false)} />}
    </div>
  );
}
