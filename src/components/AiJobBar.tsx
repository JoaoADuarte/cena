import { describeProgress, useAiJob } from "../ai";

/** Progress of the running AI task, shown in the top bar. */
export function AiJobBar() {
  const job = useAiJob((s) => s.job);
  if (!job) return null;
  const { text, fraction } = describeProgress(job.progress);
  return (
    <div className="ai-job" title={text}>
      <span className="ai-job-title">{job.title}</span>
      <div className={`ai-job-bar${fraction === null ? " indeterminate" : ""}`}>
        <div style={{ width: fraction === null ? undefined : `${Math.round(fraction * 100)}%` }} />
      </div>
      <span className="ai-job-text">{fraction === null ? text : `${text} · ${Math.round(fraction * 100)}%`}</span>
      <button className="ai-job-cancel" onClick={() => void window.api.aiCancel()}>
        Cancelar
      </button>
    </div>
  );
}
