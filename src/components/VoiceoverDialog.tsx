import { useEffect, useRef, useState } from "react";
import { useEditor } from "../store";
import { useUi } from "../ui";
import { timecode } from "../model/time";

const COUNTDOWN = 3;

/** The toolbar mic button calls this while recording: stop and insert (or cancel the countdown). */
let stopRequest: (() => void) | null = null;
export const stopVoiceover = () => stopRequest?.();

/**
 * Records a voiceover from the microphone while the timeline plays (muted by default so the speakers don't leak
 * into the mic). The creator picks the mic, then a 3 second countdown; while recording only a small bar stays on
 * screen, so the video can be watched. The same mic button (or the bar) stops and inserts the voice where recording
 * began.
 */
export function VoiceoverDialog({ onClose }: { onClose: () => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState(() => {
    try {
      return localStorage.getItem("cena.voiceover.mic") ?? "";
    } catch {
      return "";
    }
  });
  const [muteProject, setMuteProject] = useState(true);
  const phase = useUi((s) => s.voiceover);
  const [count, setCount] = useState(COUNTDOWN);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const startedAt = useRef(0);
  const countdown = useRef<ReturnType<typeof setInterval> | null>(null);
  const fps = useEditor((s) => s.project.fps);
  const setPhase = (voiceover: "off" | "countdown" | "recording" | "saving") => useUi.getState().set({ voiceover });

  // Open the microphone for the level meter; recording starts on demand.
  useEffect(() => {
    let raf = 0;
    let audioCtx: AudioContext | null = null;
    let live = true;
    (async () => {
      try {
        stream.current?.getTracks().forEach((t) => t.stop());
        const s = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
        if (!live) return s.getTracks().forEach((t) => t.stop());
        stream.current = s;
        setError(null);
        setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput"));
        audioCtx = new AudioContext();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 512;
        audioCtx.createMediaStreamSource(s).connect(analyser);
        const data = new Uint8Array(analyser.fftSize);
        const meter = () => {
          analyser.getByteTimeDomainData(data);
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
          setLevel(peak);
          raf = requestAnimationFrame(meter);
        };
        meter();
      } catch (err) {
        setError(`Não foi possível abrir o microfone: ${(err as Error).message}`);
      }
    })();
    return () => {
      live = false;
      cancelAnimationFrame(raf);
      void audioCtx?.close();
    };
  }, [deviceId]);

  useEffect(
    () => () => {
      if (countdown.current) clearInterval(countdown.current);
      stopRequest = null;
      stream.current?.getTracks().forEach((t) => t.stop());
      useUi.getState().set({ muteProject: false, voiceover: "off" });
    },
    [],
  );

  useEffect(() => {
    if (phase !== "recording") return;
    const timer = setInterval(() => setElapsed(performance.now() - startedAt.current), 100);
    return () => clearInterval(timer);
  }, [phase]);

  const record = () => {
    if (!stream.current) return;
    const { playhead, setPlaying } = useEditor.getState();
    const at = playhead;
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(stream.current, { mimeType: "audio/webm;codecs=opus" });
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = async () => {
      setPhase("saving");
      useEditor.getState().setPlaying(false);
      useUi.getState().set({ muteProject: false });
      try {
        const bytes = new Uint8Array(await new Blob(chunks, { type: "audio/webm" }).arrayBuffer());
        // Saved as WAV with its real length (the browser's WebM has none).
        const path = await window.api.saveRecording(bytes, "webm");
        const { importFiles, addMaterialToTimeline, mutate } = useEditor.getState();
        const [material] = await importFiles([path]);
        if (material) {
          mutate((p) => void (p.materials[material.id].name = `Narração ${new Date().toLocaleTimeString("pt-BR")}`), { history: false });
          addMaterialToTimeline(material.id, { start: at });
        }
      } catch (err) {
        useEditor.getState().setStatus(`A narração não foi salva: ${(err as Error).message}`);
      }
      onClose();
    };
    recorder.current = rec;
    rec.start(250);
    startedAt.current = performance.now();
    setElapsed(0);
    setPhase("recording");
    setPlaying(true);
  };

  const start = () => {
    if (!stream.current) return;
    try {
      localStorage.setItem("cena.voiceover.mic", deviceId);
    } catch {
      // Only a convenience.
    }
    useUi.getState().set({ muteProject });
    useEditor.getState().setPlaying(false);
    setCount(COUNTDOWN);
    setPhase("countdown");
    let left = COUNTDOWN;
    countdown.current = setInterval(() => {
      left -= 1;
      if (left > 0) return setCount(left);
      clearInterval(countdown.current!);
      countdown.current = null;
      record();
    }, 1000);
  };

  const stop = () => {
    if (countdown.current) {
      // Stopped during the countdown: nothing was recorded.
      clearInterval(countdown.current);
      countdown.current = null;
      onClose();
      return;
    }
    if (recorder.current?.state === "recording") recorder.current.stop();
  };
  stopRequest = stop;

  if (phase === "countdown" || phase === "recording" || phase === "saving") {
    return (
      <>
        {phase === "countdown" && <div className="voiceover-count">{count}</div>}
        <div className="voiceover-bar">
          <span className="voiceover-level">
            <span style={{ height: `${Math.min(100, level * 140)}%` }} />
          </span>
          {phase === "countdown" && <span>Começa em {count}…</span>}
          {phase === "recording" && <span className="recording-time">● {timecode(Math.round(elapsed * 1000), fps)}</span>}
          {phase === "saving" && <span>Salvando a narração…</span>}
          {phase !== "saving" && (
            <button className="primary" onClick={stop} title="Também pelo botão do microfone na barra da linha do tempo">
              {phase === "countdown" ? "Cancelar" : "■ Parar e inserir"}
            </button>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h2>Gravar narração</h2>
        <p className="modal-note">
          Depois de uma contagem de 3 segundos a linha do tempo toca e a gravação começa; esta janela some e fica só uma barrinha, para você ver o vídeo. Para parar, clique de novo no
          microfone (ou em "Parar e inserir" na barrinha). O áudio entra numa faixa de áudio a partir do ponto onde a gravação começou.
        </p>
        {error && <p className="error-text">{error}</p>}
        <label className="field">
          <span>Microfone</span>
          <select value={deviceId} onChange={(e) => setDeviceId(e.target.value)}>
            <option value="">Padrão do sistema</option>
            {devices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || "Microfone"}
              </option>
            ))}
          </select>
        </label>
        <div className="mic-meter">
          <div style={{ width: `${Math.min(100, level * 140)}%` }} />
        </div>
        <label className="toggle-row">
          <input type="checkbox" checked={muteProject} onChange={(e) => setMuteProject(e.target.checked)} />
          <span>Silenciar o projeto durante a gravação (evita eco)</span>
        </label>
        <div className="modal-actions">
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" disabled={Boolean(error)} onClick={start}>
            Começar a gravar
          </button>
        </div>
      </div>
    </div>
  );
}
