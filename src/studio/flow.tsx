/** What the creator says before the agents start: shared by the studio panel and the editor. */

export const BRIEF_EXAMPLES = [
  "Serão 4 vídeos, cada um com 2 corridas",
  "Vídeo de uns 15 minutos, só as melhores partes",
  "Ritmo rápido, com muitos zooms",
  "Sem música de fundo",
  "Legendas de 2 palavras",
  "Jogo mais baixo que a minha voz",
  "Corta do começo até 2:30",
];

export const STOPS: { id: string; label: string }[] = [
  { id: "cut", label: "Parar depois do Corte, para eu conferir e mudar os cortes" },
  { id: "thumbnail", label: "Parar antes da Montagem (a etapa mais demorada), para eu decidir se sigo ou corto mais" },
];

export const AGENT_CHOICES: { id: string; label: string; hint: string }[] = [
  { id: "cut", label: "Corte", hint: "tira pausas, erros e o que você pedir" },
  { id: "audio", label: "Áudio", hint: "separa as faixas e limpa cada uma" },
  { id: "edit", label: "Edição", hint: "legendas, zooms, textos, transições e música" },
  { id: "metadata", label: "Metadados", hint: "título, descrição, tags e capítulos" },
  { id: "thumbnail", label: "Thumbnail", hint: "capas com um quadro do vídeo e texto" },
  { id: "assemble", label: "Montagem", hint: "monta e renderiza o vídeo final" },
];
export const ALL_AGENTS = AGENT_CHOICES.map((a) => a.id);

/** Adds an example to the request, as a new sentence. */
export const withExample = (text: string, example: string) => (text.trim() ? `${text.trim().replace(/[.;]$/, "")}. ${example}.` : `${example}.`);

/**
 * Which agents work on the video. `fromEditor`: the video comes with the creator's own project, which is what gets
 * rendered when the Assembly is left out.
 */
export function AgentsPicker({ value, onChange, fromEditor = false }: { value: string[]; onChange: (next: string[]) => void; fromEditor?: boolean }) {
  const assemble = value.includes("assemble");
  // Without the agents' assembly the creator's project is rendered as it is: their edit and sound stay.
  const idle = (id: string) => fromEditor && !assemble && (id === "edit" || id === "audio");
  return (
    <div className="agents-picker">
      {AGENT_CHOICES.map((a) => (
        <label key={a.id} className={`toggle-row${idle(a.id) ? " idle" : ""}`} title={a.hint}>
          <input type="checkbox" checked={value.includes(a.id) && !idle(a.id)} disabled={idle(a.id)} onChange={(e) => onChange(e.target.checked ? [...value, a.id] : value.filter((x) => x !== a.id))} />
          <span>
            <b>{a.label}</b> · {a.hint}
          </span>
        </label>
      ))}
      <small className="agents-note">
        {!value.includes("cut") && "Sem o Corte, a gravação é só transcrita (para legendas e título) e nada é cortado além do que você já cortou. "}
        {!assemble && (fromEditor ? "Sem a Montagem, o seu projeto é renderizado como está no editor, com o título e a thumbnail dos agentes." : "Sem a Montagem, os agentes só montam o projeto; você abre no editor e exporta.")}
      </small>
    </div>
  );
}
