import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { runSmokeTest } from "./smoke";
import { startAgentBridge } from "./agent";
import { startAutosave } from "./autosave";
import { StudioApp } from "./studio/StudioApp";
import "./styles.css";
import "./studio/studio.css";

const mode = window.api?.isStudio ? "studio" : window.api?.isWorker ? "worker" : "editor";
// The studio's worker answers tool calls like the editor does, but keeps no recovery copies of its own.
if (mode !== "studio") startAgentBridge();
if (mode === "editor") startAutosave();
if (mode === "studio") document.title = "Cena Estúdio";

createRoot(document.getElementById("root")!).render(<StrictMode>{mode === "studio" ? <StudioApp /> : mode === "worker" ? <div /> : <App />}</StrictMode>);

if (window.api?.smoke) void runSmokeTest();
