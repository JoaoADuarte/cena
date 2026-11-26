import { useEffect, useState } from "react";
import { AGENT_NAMES, call, useStudio, type LogLine } from "./store";

const LEVEL_MARK: Record<LogLine["level"], string> = { info: "·", decision: "✓", warn: "!", error: "✕" };

/** What the agents did and why, newest at the bottom. */
export function Logs({ videoId, scriptId, limit = 200 }: { videoId?: number; scriptId?: number; limit?: number }) {
  const tick = useStudio((s) => s.tick);
  const [lines, setLines] = useState<LogLine[]>([]);
  useEffect(() => {
    let alive = true;
    void call<LogLine[]>("logs", { videoId, scriptId, limit }).then((l) => alive && setLines(l));
    return () => {
      alive = false;
    };
  }, [videoId, scriptId, limit, tick]);
  if (!lines.length) return <p className="studio-empty">Nada registrado ainda.</p>;
  return (
    <ol className="studio-logs">
      {lines.map((l) => (
        <li key={l.id} className={`log-${l.level}`}>
          <time>{new Date(l.time).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
          <b>{AGENT_NAMES[l.agent] ?? l.agent}</b>
          <span className="log-mark">{LEVEL_MARK[l.level]}</span>
          <span className="log-text">{l.message}</span>
        </li>
      ))}
    </ol>
  );
}
