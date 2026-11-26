import { useEffect, useState } from "react";
import { STOPS } from "./Brief";
import { act, call, useStudio, type StudioSettings } from "./store";

const MODELS = [
  { value: "", label: "Padrão (Sonnet)" },
  { value: "opus", label: "Opus (mais capaz)" },
  { value: "sonnet", label: "Sonnet (equilibrado)" },
  { value: "haiku", label: "Haiku (mais rápido)" },
];
const MODEL_AGENTS: { id: keyof StudioSettings["models"]; label: string }[] = [
  { id: "research", label: "Pesquisa" },
  { id: "script", label: "Roteiro" },
  { id: "cut", label: "Corte (avaliação dos takes)" },
  { id: "edit", label: "Edição" },
  { id: "metadata", label: "Metadados" },
  { id: "shorts", label: "Shorts" },
  { id: "thumbnail", label: "Thumbnail" },
  { id: "review", label: "Correções" },
];

const CONSOLE = "https://console.cloud.google.com/apis/";

/** The keys are typed here by the creator and never shown again; only "saved" or "missing" comes back. */
function YouTubeSection() {
  const yt = useStudio((s) => s.state!.youtube);
  const publish = useStudio((s) => s.state!.settings.publish);
  const [apiKey, setApiKey] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const save = async () => {
    const keys: Record<string, string> = {};
    if (apiKey.trim()) keys.apiKey = apiKey;
    if (clientId.trim()) keys.clientId = clientId;
    if (clientSecret.trim()) keys.clientSecret = clientSecret;
    setNote(null);
    try {
      const saved = await window.api.studioCall("setYouTubeKeys", keys);
      const names = [saved?.apiKey && "chave de API", saved?.clientId && "ID do cliente", saved?.clientSecret && "chave secreta"].filter(Boolean);
      setNote(`Salvo: ${names.join(", ")}. Por segurança as chaves não aparecem de novo nos campos; o "salva" ao lado de cada uma confirma.`);
      setApiKey("");
      setClientId("");
      setClientSecret("");
      useStudio.setState({ error: null });
    } catch (err) {
      useStudio.setState({ error: String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, "") });
    }
  };
  const connect = async () => {
    setConnecting(true);
    setNote("O navegador vai abrir a página do Google. Entre com a conta que você pôs como usuário de teste e escolha o canal. Se aparecer \"O Google não verificou este app\", clique em Avançado e em Acessar.");
    await act("connectYouTube");
    setConnecting(false);
  };
  return (
    <section>
      <h3>YouTube</h3>
      <p className="studio-hint">
        As chaves são suas, criadas no Google Cloud, e ficam só neste computador{yt.encrypted ? ", criptografadas pelo Windows" : ""}. O passo a passo está no LEIA-ME do Estúdio.{" "}
        <a href="#" onClick={(e) => (e.preventDefault(), void act("openLink", CONSOLE + "credentials"))}>
          Abrir o Google Cloud
        </a>
      </p>
      <label className="field">
        <span>Chave de API (pesquisa de vídeos) · {yt.apiKey ? "salva" : "falta"}</span>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={yt.apiKey ? "Digite para trocar" : "AIza…"} autoComplete="off" />
      </label>
      <div className="inline">
        <label className="field">
          <span>ID do cliente OAuth (tipo "App para computador") · {yt.clientId ? `salvo (termina em …${yt.clientEnd ?? ""})` : "falta"}</span>
          <input type="password" value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={yt.client ? "Digite para trocar" : "…apps.googleusercontent.com"} autoComplete="off" />
        </label>
        <label className="field">
          <span>Chave secreta do cliente · {yt.clientSecret ? "salva" : "falta"}</span>
          <input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder={yt.client ? "Digite para trocar" : ""} autoComplete="off" />
        </label>
      </div>
      <div className="inline">
        <button disabled={!apiKey.trim() && !clientId.trim() && !clientSecret.trim()} onClick={() => void save()}>
          Salvar chaves
        </button>
        {yt.connected ? (
          <>
            <span>
              Canal conectado: <b>{yt.channel?.title ?? "—"}</b>
            </span>
            <button onClick={() => confirm("Desconectar o canal? Envios em andamento são parados.") && void act("disconnectYouTube")}>Desconectar</button>
          </>
        ) : (
          <button className="primary" disabled={!yt.client || connecting} onClick={() => void connect()} title={yt.client ? "Abre o seu navegador para você entrar na conta do Google e autorizar" : "Salve antes o ID e a chave secreta do cliente OAuth"}>
            {connecting ? "Aguardando você autorizar no navegador…" : "Conectar o canal"}
          </button>
        )}
      </div>
      {note && <p className="studio-hint">{note}</p>}
      <p className="studio-hint">
        Cota de hoje: {yt.quota.units.toLocaleString("pt-BR")} de {yt.quota.limits.units.toLocaleString("pt-BR")} unidades · {yt.quota.searches} de {yt.quota.limits.searches} buscas · {yt.quota.uploads} de {yt.quota.limits.uploads} envios. Sem a chave de API, a Pesquisa continua funcionando pela busca na web, sem números verificados.
      </p>
      <div className="inline">
        <label className="field">
          <span>Vídeo sem data marcada é enviado como</span>
          <select value={publish.privacy} onChange={(e) => void act("setSettings", { publish: { privacy: e.target.value } })}>
            <option value="public">Público</option>
            <option value="unlisted">Não listado</option>
            <option value="private">Privado</option>
          </select>
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={publish.auto} onChange={(e) => void act("setSettings", { publish: { auto: e.target.checked } })} />
          <span>Enviar sozinho assim que eu aprovar (desligado: espera o clique em "Enviar ao YouTube")</span>
        </label>
      </div>
      <p className="studio-hint">Nenhum vídeo é enviado sem a sua aprovação no painel. Se algo mudar depois de aprovado, o envio é recusado.</p>
    </section>
  );
}

function ShortcutButton() {
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="inline">
      <button
        onClick={async () => {
          setError(null);
          try {
            await call<string>("studioShortcut");
            setDone("Pronto: o ícone \"Cena Estúdio\" está na Área de Trabalho. Ele abre só o Estúdio.");
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        Criar ícone "Cena Estúdio" na Área de Trabalho
      </button>
      {done && <span className="studio-hint">{done}</span>}
      {error && <span className="card-error">{error}</span>}
    </div>
  );
}

export function Settings() {
  const state = useStudio((s) => s.state!);
  const cfg = state.settings;
  const [voice, setVoice] = useState(state.voice.text);
  const [installing, setInstalling] = useState(false);
  useEffect(() => setVoice(state.voice.text), [state.voice.text]);
  const set = (patch: Record<string, unknown>) => void act("setSettings", patch);

  const pickFolder = async () => {
    const folder = await call<string | null>("pickFolder");
    if (folder) set({ watch: { folder, enabled: true } });
  };

  return (
    <div className="studio-settings">
      <section>
        <h3>Fluxo dos vídeos</h3>
        <label className="field">
          <span>Pedido padrão: como você quer a edição quando não disser nada (vale também para a pasta monitorada)</span>
          <textarea rows={3} defaultValue={cfg.flow.brief} onBlur={(e) => set({ flow: { brief: e.target.value.trim() } })} placeholder="Ex.: ritmo rápido, legendas de 3 palavras, sem música nos primeiros segundos" />
        </label>
        {STOPS.map((stop) => (
          <label key={stop.id} className="toggle-row">
            <input type="checkbox" checked={cfg.flow.stops.includes(stop.id)} onChange={(e) => set({ flow: { stops: e.target.checked ? [...cfg.flow.stops, stop.id] : cfg.flow.stops.filter((s) => s !== stop.id) } })} />
            <span>{stop.label}</span>
          </label>
        ))}
        <p className="studio-hint">Ao adicionar um vídeo no Painel você pode mudar o pedido e as paradas só para ele.</p>
      </section>
      <section>
        <h3>Canal</h3>
        <label className="field">
          <span>Nicho ou tema do canal</span>
          <input defaultValue={cfg.channel.niche} onBlur={(e) => set({ channel: { niche: e.target.value } })} placeholder="Ex.: gameplay de jogos de sobrevivência e automação, com humor" />
        </label>
        <label className="field">
          <span>
            Perfil de voz do canal{state.voice.samples ? ` · aprendido com ${state.voice.samples} gravação(ões), ${state.voice.wpm} palavras por minuto` : " · ainda vazio"}
          </span>
          <textarea rows={6} value={voice} onChange={(e) => setVoice(e.target.value)} placeholder="Preenchido sozinho a cada vídeo que passa pelo Corte. Você pode escrever ou corrigir à mão." />
        </label>
        <div className="inline">
          <button disabled={voice === state.voice.text} onClick={() => void act("setVoice", voice)}>
            Salvar perfil
          </button>
          <label className="toggle-row">
            <input type="checkbox" checked={cfg.voice.learn} onChange={(e) => set({ voice: { learn: e.target.checked } })} />
            <span>Aprender com cada gravação nova</span>
          </label>
        </div>
      </section>

      <section>
        <h3>Agente de Corte</h3>
        <label className="field">
          <span>Tipo de vídeo</span>
          <select value={cfg.cut.style} onChange={(e) => set({ cut: { style: e.target.value } })}>
            <option value="auto">Decidir pelo quanto há de fala</option>
            <option value="falado">Falado para a câmera: toda pausa longa sai</option>
            <option value="gameplay">Gameplay com comentário: trechos sem fala ficam</option>
          </select>
        </label>
        <div className="inline">
          <label className="field">
            <span>Pausa mínima para cortar (s)</span>
            <input type="number" min={0.3} max={5} step={0.1} defaultValue={cfg.cut.minPause} onBlur={(e) => set({ cut: { minPause: Math.max(0.3, Number(e.target.value) || 0.7) } })} />
          </label>
          <label className="field">
            <span>Transcrição</span>
            <select value={cfg.cut.quality} onChange={(e) => set({ cut: { quality: e.target.value } })}>
              <option value="fast">Rápida</option>
              <option value="accurate">Precisa</option>
              <option value="max">Máxima (mais lenta, baixa 1,6 GB)</option>
            </select>
          </label>
          <label className="field">
            <span>Idioma</span>
            <select value={cfg.cut.language} onChange={(e) => set({ cut: { language: e.target.value } })}>
              <option value="pt">Português</option>
              <option value="en">Inglês</option>
              <option value="es">Espanhol</option>
              <option value="">Detectar</option>
            </select>
          </label>
        </div>
        <label className="toggle-row">
          <input type="checkbox" checked={cfg.cut.removeStill} onChange={(e) => set({ cut: { removeStill: e.target.checked } })} />
          <span>Cortar trechos com a imagem parada e sem fala</span>
        </label>
      </section>

      <section>
        <h3>Agente de Áudio</h3>
        <div className="inline">
          <label className="field">
            <span>Preset</span>
            <select value={cfg.audio.preset} onChange={(e) => set({ audio: { preset: e.target.value } })}>
              <option value="auto">Escolher sozinho</option>
              <option value="voz">Voz: limpeza completa</option>
              <option value="misto">Jogo e voz na mesma faixa</option>
              <option value="leve">Leve: só volume</option>
            </select>
          </label>
          <label className="field">
            <span>Redução de ruído ({cfg.audio.noise})</span>
            <input type="range" min={0} max={30} value={cfg.audio.noise} onChange={(e) => set({ audio: { noise: Number(e.target.value) } })} />
          </label>
          <label className="field">
            <span>Som do jogo ({cfg.audio.gameLevel ?? -10} dB em relação à sua voz)</span>
            <input type="range" min={-30} max={0} value={cfg.audio.gameLevel ?? -10} onChange={(e) => set({ audio: { gameLevel: Number(e.target.value) } })} />
          </label>
          <label className="field">
            <span>Conversa do Discord ({cfg.audio.chatLevel ?? -2} dB em relação à sua voz)</span>
            <input type="range" min={-30} max={6} value={cfg.audio.chatLevel ?? -2} onChange={(e) => set({ audio: { chatLevel: Number(e.target.value) } })} />
          </label>
        </div>
        <div className="inline">
          {[0, 1, 2, 3].map((i) => (
            <label className="field" key={i}>
              <span>Faixa {i + 1} das gravações</span>
              <select
                value={cfg.audio.tracks?.[i] ?? "auto"}
                onChange={(e) => {
                  const tracks = [0, 1, 2, 3].map((k) => cfg.audio.tracks?.[k] ?? "auto");
                  tracks[i] = e.target.value;
                  set({ audio: { tracks } });
                }}
              >
                <option value="auto">Descobrir sozinho</option>
                <option value="voz">Minha voz (microfone)</option>
                <option value="conversa">Conversa (Discord)</option>
                <option value="jogo">Jogo</option>
                <option value="fora">Não usar</option>
              </select>
            </label>
          ))}
        </div>
        <p className="studio-hint">Gravações do OBS com várias faixas: o Estúdio ouve cada uma. A faixa com uma voz só é a sua, a que tem várias vozes é a conversa, e a que quase nunca fica quieta é o jogo. Cada uma é tratada sozinha e fica na sua própria faixa do projeto. Fixe aqui só se ele errar; vale a partir da Ingestão.</p>
        <p className="studio-hint">O volume final é sempre medido e levado a -14 LUFS, o padrão do YouTube.</p>
        <div className="inline">
          <label className="toggle-row">
            <input type="checkbox" checked={cfg.audio.deepFilter} onChange={(e) => set({ audio: { deepFilter: e.target.checked } })} />
            <span>Usar o DeepFilterNet para ruído e eco de sala {state.deepFilter ? "(instalado)" : "(não instalado)"}</span>
          </label>
          {!state.deepFilter && (
            <button
              disabled={installing}
              onClick={async () => {
                if (!confirm("Baixar o DeepFilterNet (programa de código aberto, cerca de 40 MB) da página oficial do projeto no GitHub?")) return;
                setInstalling(true);
                await act("installDeepFilter");
                setInstalling(false);
              }}
            >
              {installing ? "Baixando…" : "Baixar DeepFilterNet"}
            </button>
          )}
        </div>
      </section>

      <section>
        <h3>Agente de Edição</h3>
        <div className="inline">
          <label className="field">
            <span>Intensidade</span>
            <select value={cfg.edit.intensity} onChange={(e) => set({ edit: { intensity: e.target.value } })}>
              <option value="leve">Leve: poucos efeitos, discretos</option>
              <option value="media">Média</option>
              <option value="intensa">Intensa: ritmo rápido, muitos zooms e textos</option>
            </select>
          </label>
          <label className="field">
            <span>Palavras por legenda</span>
            <input type="number" min={1} max={8} defaultValue={cfg.edit.captionWords} onBlur={(e) => set({ edit: { captionWords: Math.max(1, Math.min(8, Math.round(Number(e.target.value)) || 4)) } })} />
          </label>
          <label className="field">
            <span>Transição entre assuntos</span>
            <select value={cfg.edit.transition} onChange={(e) => set({ edit: { transition: e.target.value } })}>
              <option value="fade">Fusão</option>
              <option value="fadeBlack">Passar pelo preto</option>
              <option value="fadeWhite">Clarão branco</option>
              <option value="slideLeft">Deslizar</option>
            </select>
          </label>
          <label className="field">
            <span>Cor de destaque</span>
            <input type="color" value={cfg.edit.textColour} onChange={(e) => set({ edit: { textColour: e.target.value } })} />
          </label>
        </div>
        <div className="edit-flags">
          {(
            [
              ["captions", "Legendas automáticas"],
              ["captionPop", "Legendas com animação"],
              ["zooms", "Zooms nos momentos de ênfase"],
              ["texts", "Textos na tela"],
              ["transitions", "Transições entre assuntos"],
              ["colour", "Correção de cor medida no vídeo"],
              ["music", "Música de fundo (abaixa sozinha quando há fala)"],
              ["broll", "Imagens de apoio (fotos livres da internet)"],
              ["stabilize", "Estabilizar a imagem (lento; feito numa cópia)"],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className="toggle-row">
              <input type="checkbox" checked={cfg.edit[key]} onChange={(e) => set({ edit: { [key]: e.target.checked } })} />
              <span>{label}</span>
            </label>
          ))}
        </div>
        <div className="inline">
          <label className="field">
            <span>Volume da música ({Math.round(cfg.edit.musicVolume * 100)}%)</span>
            <input type="range" min={2} max={40} value={Math.round(cfg.edit.musicVolume * 100)} onChange={(e) => set({ edit: { musicVolume: Number(e.target.value) / 100 } })} />
          </label>
          <label className="field">
            <span>Estilo de música fixo (em inglês; vazio = o agente escolhe)</span>
            <input defaultValue={cfg.edit.musicQuery} onBlur={(e) => set({ edit: { musicQuery: e.target.value.trim() } })} placeholder="Ex.: upbeat funk instrumental" />
          </label>
        </div>
        <p className="studio-hint">Música e imagens vêm do Openverse, só com licença que permite uso comercial; quando a licença pede crédito, ele aparece na revisão para ir na descrição. Cada vídeo pode ligar e desligar esses itens na revisão.</p>
      </section>

      <section>
        <h3>Agente de Thumbnail</h3>
        <div className="inline">
          <label className="field">
            <span>Opções por vídeo</span>
            <input type="number" min={2} max={6} defaultValue={cfg.thumbnail.count} onBlur={(e) => set({ thumbnail: { count: Math.max(2, Math.min(6, Math.round(Number(e.target.value)) || 4)) } })} />
          </label>
        </div>
        <p className="studio-hint">Feitas com um quadro do vídeo, a pessoa recortada (quando há uma) e um texto curto. Nenhuma imagem é gerada por IA.</p>
      </section>

      <section>
        <h3>Montagem e renderização</h3>
        <div className="inline">
          <label className="field">
            <span>Vídeos ao mesmo tempo</span>
            <select value={cfg.parallel ?? 2} onChange={(e) => set({ parallel: Number(e.target.value) })}>
              <option value={1}>1 (um de cada vez)</option>
              <option value={2}>2</option>
              <option value={3}>3</option>
            </select>
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={cfg.render.gpu} onChange={(e) => set({ render: { gpu: e.target.checked } })} />
            <span>Usar a placa de vídeo</span>
          </label>
          <label className="field">
            <span>Qualidade</span>
            <select value={cfg.render.quality} onChange={(e) => set({ render: { quality: e.target.value } })}>
              <option value="high">Alta</option>
              <option value="recommended">Recomendada</option>
              <option value="small">Arquivo menor</option>
            </select>
          </label>
        </div>
        <p className="studio-hint">Com 2 ou 3, cada vídeo tem a sua mesa de montagem: transcrição, thumbnail e renderização andam juntas. Usa mais memória e placa de vídeo; se o PC ficar lento, volte para 1.</p>
      </section>

      <YouTubeSection />

      <section>
        <h3>Modelos de IA</h3>
        <div className="inline">
          {MODEL_AGENTS.map((a) => (
            <label key={a.id} className="field">
              <span>{a.label}</span>
              <select value={cfg.models[a.id] ?? ""} onChange={(e) => set({ models: { [a.id]: e.target.value || null } })}>
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <p className="studio-hint">Os agentes usam o Claude Code com o seu login. A transcrição (Whisper) roda neste computador.</p>
      </section>

      <section>
        <h3>Estúdio separado</h3>
        <p className="studio-hint">
          O Estúdio já roda numa janela própria e continua trabalhando com o editor fechado (fica na bandeja, ao lado do relógio). Você pode abrir 2 ou 3
          editores ao mesmo tempo (abra o Cena de novo) e mandar cada vídeo para cá; com "Vídeos ao mesmo tempo" em 2 ou 3, eles andam juntos.
        </p>
        <ShortcutButton />
      </section>
      <section>
        <h3>Pasta monitorada e avisos</h3>
        <div className="inline">
          <label className="toggle-row">
            <input type="checkbox" checked={cfg.watch.enabled} disabled={!cfg.watch.folder} onChange={(e) => set({ watch: { enabled: e.target.checked } })} />
            <span>Começar sozinho quando um vídeo novo chegar em</span>
          </label>
          <code>{cfg.watch.folder || "nenhuma pasta escolhida"}</code>
          <button onClick={() => void pickFolder()}>Escolher pasta…</button>
        </div>
        <p className="studio-hint">Só entram os vídeos que chegarem depois de a pasta ser escolhida. Com a pasta ligada, o Estúdio continua no canto da barra de tarefas quando as janelas são fechadas.</p>
        <label className="toggle-row">
          <input type="checkbox" checked={cfg.notify} onChange={(e) => set({ notify: e.target.checked })} />
          <span>Avisar no Windows quando um vídeo ou roteiro estiver pronto para revisão</span>
        </label>
        <p className="studio-hint">Os arquivos do Estúdio ficam em {state.root}</p>
      </section>
    </div>
  );
}
