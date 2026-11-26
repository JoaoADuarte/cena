import { useState } from "react";
import { configureAgent, useAgent } from "../agent";

const EXAMPLES = [
  "Corte os silêncios e as partes em que eu erro a fala",
  "Gere legendas amarelas e deixe o vídeo vertical para Reels",
  "Coloque uma música calma baixinha e um título de abertura",
  "Crie com o HyperFrames um nome na tela animado e coloque sobre o vídeo aos 5 segundos",
];

function CopyBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="agent-code">
      <code>{text}</code>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copiado" : "Copiar"}
      </button>
    </div>
  );
}

/** Turns on the local MCP server and shows how to connect an AI client to it. */
export function AgentDialog({ onClose }: { onClose: () => void }) {
  const server = useAgent((s) => s.server);
  const log = useAgent((s) => s.log);
  const [port, setPort] = useState(server?.port ?? 0);
  if (!server) return null;

  const command = `claude mcp add --transport http --scope user cena ${server.url} --header "Authorization: Bearer ${server.token}"`;
  const config = JSON.stringify({ mcpServers: { cena: { type: "http", url: server.url, headers: { Authorization: `Bearer ${server.token}` } } } }, null, 2);

  return (
    <div className="modal-backdrop">
      <div className="modal agent-modal">
        <h2>Conectar IA</h2>
        <p className="modal-note">
          Deixa o Claude Code, ou outra IA compatível com MCP, ver e editar o projeto aberto. Cada edição aparece na timeline na hora e pode ser desfeita com Ctrl+Z.
        </p>
        <label className="toggle-row">
          <input type="checkbox" checked={server.enabled} onChange={(e) => void configureAgent({ enabled: e.target.checked })} />
          <span>Permitir que uma IA edite neste computador</span>
        </label>
        {server.error && <p className="error-text">{server.error}</p>}

        {server.running && (
          <div className="agent-body">
            <p className="agent-status">
              <span className="agent-dot" /> {server.client ? `Última conexão: ${server.client}` : "Ligado, aguardando a IA conectar"}
            </p>
            <h4 className="lib-group">1. No terminal, rode este comando uma vez</h4>
            <CopyBlock text={command} />
            <p className="modal-note">
              Se o terminal disser que "claude" não é reconhecido, é porque o seu Claude Code vem dentro do app Claude, que não instala esse comando. Nesse caso,
              cole o comando numa conversa do Claude Code no app e peça: "conecte o Cena com este comando". Depois, abra uma conversa nova.
            </p>
            <h4 className="lib-group">2. Com o Cena aberto, peça ao Claude Code</h4>
            <ul className="agent-examples">
              {EXAMPLES.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>
            <details>
              <summary>Outros clientes MCP</summary>
              <p className="modal-note">Para um arquivo .mcp.json ou a configuração do seu cliente. Servidor HTTP local, com o Cena aberto.</p>
              <CopyBlock text={config} />
            </details>
            <details>
              <summary>Porta e token</summary>
              <p className="modal-note">Quem tem o token consegue editar o projeto e ler ou gravar arquivos pelo Cena. Não o compartilhe. Ao trocar a porta ou o token, rode o comando acima de novo.</p>
              <div className="agent-settings">
                <label>
                  Porta
                  <input type="number" min={1024} max={65535} value={port} onChange={(e) => setPort(Number(e.target.value))} />
                </label>
                <button disabled={port === server.port || port < 1024 || port > 65535} onClick={() => void configureAgent({ port })}>
                  Aplicar
                </button>
                <span className="spacer" />
                <button onClick={() => void configureAgent({ newToken: true })}>Gerar novo token</button>
              </div>
            </details>
            <h4 className="lib-group">Atividade</h4>
            {log.length === 0 && <p className="empty-hint">O que a IA fizer nesta sessão aparece aqui.</p>}
            <ol className="agent-log">
              {log.map((entry) => (
                <li key={entry.id} className={entry.error ? "failed" : undefined}>
                  <time>{new Date(entry.time).toLocaleTimeString("pt-BR")}</time>
                  <span>
                    {entry.label}
                    {entry.error && <small>{entry.error}</small>}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        )}
        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </div>
  );
}
