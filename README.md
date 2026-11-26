# Cena

Editor de vídeo desktop (Electron + React + TypeScript) com timeline multipista, preview em tempo real e exportação via FFmpeg. Inspirado no fluxo de trabalho do CapCut; todo o código é próprio (veja `../analysis/capcut-architecture.md`).

## Rodar

Requer Node 22.12+ (o projeto usa o Node portátil em `..\.tools\node24`).

```powershell
$env:PATH = "D:\CloneCapCut\.tools\node24;$env:PATH"
npm run dev      # Vite + Electron com recarga automática
npm run smoke    # teste de ponta a ponta: importa, edita e exporta um MP4 sintético
npm run build    # tipagem + build do renderer em dist/
npm start        # Electron usando dist/
npm run dist     # instalador, versão portátil e zip do Windows em release/
npm run smoke:packaged  # roda o teste de ponta a ponta no app empacotado (release/win-unpacked)
npm run smoke:portable  # o mesmo teste no executável portátil
npm run icon     # regera build/icon.ico e build/icon.png
```

### Instalador e versão portátil

`npm run dist` gera três arquivos em `release/`:
- `Cena-Setup-<versão>.exe`: instalador (descrito abaixo).
- `Cena-Portatil-<versão>.exe`: um único executável que roda sem instalar (pendrive, PC sem permissão). A cada abertura ele se descompacta numa pasta temporária, então demora alguns segundos para abrir e não associa arquivos `.cena`.
- `Cena-<versão>-win-x64.zip`: a pasta do app compactada; extraia em qualquer lugar e rode `Cena.exe`. Abre rápido como a versão instalada, sem instalar nada.

O instalador NSIS (x64, por usuário, sem precisar de administrador):
- deixa escolher a pasta de instalação e cria atalhos na área de trabalho e no menu Iniciar;
- associa arquivos `.cena` ao Cena (duplo clique abre o projeto);
- inclui FFmpeg e ffprobe, sem nenhuma dependência externa.

O instalador não é assinado digitalmente, então o Windows SmartScreen mostra "O Windows protegeu o computador" na primeira execução (Mais informações → Executar assim mesmo). Para distribuir publicamente, configure um certificado de assinatura de código no electron-builder (`win.certificateFile` / `CSC_LINK`).

## O que já funciona

- Importar vídeo, áudio e imagem (botão ou arrastar do Explorer); miniatura e forma de onda.
- Timeline: faixas de vídeo, áudio e texto; mover entre faixas, aparar, dividir (S), excluir, snap, zoom (Ctrl+roda), ocultar/silenciar/bloquear faixa.
- Preview em tempo real com áudio; arrastar o clipe selecionado no preview move a posição.
- Inspetor: posição, escala, rotação, opacidade com keyframes (◆), velocidade, volume, fade de entrada/saída, brilho/contraste/saturação/desfoque, texto (fonte, tamanho, cor, contorno, fundo, alinhamento).
- Voltar ao padrão: o ↺ ao lado de cada controle alterado (ou duplo clique no nome) restaura o valor original; "Redefinir" no título de cada seção restaura a seção inteira, inclusive keyframes, e "Remover todos" tira os efeitos do clipe.
- Desfazer/refazer (Ctrl+Z / Ctrl+Y), salvar/abrir projeto `.cena` (Ctrl+S / Ctrl+O).
- Transições (aba Transições, botão no corte da timeline ou inspetor), 25 no total: dissolver, passar pelo preto/branco, empurrar nas 4 direções, empurrar elástico, cortinas (←, →, ↑, ↓ e diagonal), círculo, losango, barras, zoom, zoom de entrada/saída, girar, desfoque, borrão de movimento, glitch, flash e **forma personalizada** (círculo, quadrado, losango, estrela, coração ou um texto que cresce ou encolhe, com suavização e giro). Ficam centradas no corte e usam os quadros de sobra da fonte quando existem.
- Efeitos por clipe com intensidade (aba Efeitos ou inspetor): preto e branco, sépia, vintage, quente, frio, dramático, negativo, girar matiz, vinheta, brilho suave, pixelizar, granulado, flash e tremor.
- Recortar (inspetor → Recortar): corta as bordas de vídeo ou imagem por lado, ou numa proporção pronta (16:9, 9:16, 1:1, 4:5).
- Legendas automáticas (aba Texto): transcreve o áudio da timeline com o Whisper e cria uma faixa "Legendas" com textos editáveis. Idioma (português, inglês, espanhol ou automático), qualidade rápida (~140 MB) ou precisa (~500 MB) e palavras por legenda.
- Remover fundo (inspetor → Inteligência artificial): deixa só as pessoas com o MODNet; vídeo vira WebM com transparência (só o trecho usado), foto vira PNG. "Restaurar original" desfaz.
- Remover objetos (inspetor → Inteligência artificial, em fotos): pinte o que quer apagar e o LaMa preenche com o fundo; dá para repetir e desfazer antes de aplicar.
- Áudio (aba Áudio): músicas do Jamendo e sons do Freesound buscados via Openverse (licenças Creative Commons, sem chave) e 10 efeitos prontos gerados pelo próprio Cena, que funcionam offline. Créditos exigidos pela licença aparecem prontos para copiar na exportação.
- Máscaras (inspetor → Máscara): retângulo, elipse, losango, estrela, coração, divisão, faixas de cinema, texto e desenho livre (clique no preview para marcar os cantos), com posição, tamanho, rotação, suavização e inversão. Acompanham a transformação do clipe.
- Modos de mesclagem (inspetor → Transformação → Mesclagem): 17 modos (Multiplicar, Tela, Sobrepor, Luz suave, Diferença…), em clipes, textos, formas e stickers.
- Curvas de animação (inspetor → Curva da animação, com o cursor sobre um keyframe): Linear, Entrada suave, Saída suave, Suave, Constante ou uma curva própria arrastando as alças. Intensidade dos efeitos também aceita keyframes (◆).
- Tela de fundo com desfoque (propriedades do projeto): preenche as bordas com o próprio vídeo desfocado.
- Stickers (aba Stickers): formas (retângulo, elipse, triângulo, estrela, polígono, coração, seta, linha) com preenchimento e contorno, e emojis.
- Timeline: seleção múltipla (Ctrl/Shift+clique) e mover em grupo, edição em cascata (botão Cascata ou R), marcadores (M; duplo clique renomeia, botão direito remove), copiar/colar (Ctrl+C/V), duplicar (Ctrl+D), colar atributos (Ctrl+Alt+V) e separar áudio do vídeo.
- Legendas em arquivo (aba Texto): importar .srt/.ass e exportar .srt. Legendas automáticas também com o modelo large-v3-turbo (~1 GB).
- Guias no preview: regra dos terços, grade, centro e áreas seguras de TikTok, Reels e Shorts.
- Fontes (seletor com busca no inspetor de texto): as fontes do Windows, todas as instaladas no PC, arquivos importados (.ttf, .otf, .woff, .woff2, guardados em `%APPDATA%\Cena\fonts\custom`) e o catálogo completo do Google Fonts (~1.800 famílias com alfabeto latino, filtráveis por estilo), baixadas na primeira vez e guardadas no PC.
- Filtros (aba Filtros): 16 looks prontos (Vívido, Natural+, Impacto, Pastel, Cinema, Teal & Orange, Sombrio, Noir, Retrô, Polaroid, Desbotado, Dourado, Pôr do sol, Azul frio, Floresta, Neon) com intensidade, um por clipe, e "aplicar em todos os clipes".
- Ajuste (aba Ajuste e inspetor): brilho, contraste, saturação, temperatura, matiz, nitidez e desfoque; ajustes rápidos de um clique e **camada de ajuste**, que muda tudo o que está abaixo dela na timeline.
- Legendas (aba Legendas): legendas automáticas, importar/exportar .srt/.ass, 8 estilos aplicados a todas de uma vez e lista editável com salto para cada legenda.
- Modelos (aba Modelos): título de abertura, terço inferior, contagem regressiva, botão "inscreva-se", citação, seta animada, encerramento e formato vertical 9:16, inseridos no cursor.
- Barra da timeline: ferramenta de seleção ou lâmina (B, corta onde clicar), desfazer/refazer, dividir, excluir à esquerda/direita do cursor (Q/W), excluir, marcador, congelar quadro (Shift+F, cria uma foto de 3 s), inverter vídeo, espelhar, girar 90°, recortar, remover fundo, reduzir ruído do áudio, melhorar qualidade (HD), separar áudio, texto, gravar narração pelo microfone, ímã da faixa principal (Shift+N, fecha buracos), encaixe automático (N), vínculo vídeo/áudio separado, eixo de pré-visualização (o preview acompanha o mouse) e zoom.
- Velocidade com ou sem manter o tom da voz.
- Atalhos de teclado personalizáveis (ícone de teclado no topo ou Ctrl+K).
- Exportar MP4 (H.264 + AAC) com o mesmo compositor do preview; o áudio é mixado pelo FFmpeg.
- Abrir rascunhos do CapCut desta máquina (aba CapCut): vídeo, áudio, texto, cortes, velocidade, posição e transições (como dissolver).

## Atalhos

Padrões (todos podem ser trocados em Atalhos de teclado, Ctrl+K): Espaço reproduzir · S dividir · B lâmina · Q/W excluir à esquerda/direita · Shift+F congelar quadro · N encaixe · Shift+N ímã · T texto · M marcador · R cascata · Delete excluir (Shift+Delete em cascata) · Ctrl+C/V copiar/colar · Ctrl+D duplicar · Ctrl+Alt+V colar atributos · Ctrl+Shift+D separar áudio · ←/→ quadro (Shift = 10) · Home/End início/fim · Esc desmarcar · Ctrl+E exportar

## Estrutura

- `electron/` processo principal: protocolo `media://` com Range, ffprobe/miniatura/forma de onda, sessão de exportação.
- `src/model/` modelo do projeto (tempo em microssegundos, como no CapCut), interpolação de keyframes.
- `src/store.ts` estado (zustand) e todas as operações de edição com histórico.
- `src/engine/` compositor Canvas 2D, sincronização do preview, exportação quadro a quadro.
- `src/importers/capcut.ts` conversão de `draft_content.json`.
- `electron/mcp.cjs` servidor MCP local; `src/agentTools.ts` as ferramentas, executadas na janela sobre a mesma store da interface.

## Inteligência artificial

Os modelos rodam neste computador, num processo separado (`electron/ai/`), com o ONNX Runtime. Cada um é baixado do Hugging Face no primeiro uso e fica em `%APPDATA%\Cena\models`; depois funciona offline. Todos têm licença Apache-2.0:

| Função | Modelo | Download |
|---|---|---|
| Legendas (rápida / precisa) | `onnx-community/whisper-base` / `whisper-small` | ~140 MB / ~500 MB |
| Remover fundo | `Xenova/modnet` | ~25 MB |
| Remover objetos | `Carve/LaMa-ONNX` (`lama_fp32.onnx`) | ~200 MB |

Arquivos gerados (vídeos sem fundo, fotos editadas) ficam em `%APPDATA%\Cena\processed`; sons baixados em `%APPDATA%\Cena\library`.

`CENA_SMOKE_AI=1 npm run smoke` (opcionalmente com `CENA_SMOKE_SPEECH=<arquivo de fala .wav>`) inclui no teste de ponta a ponta a remoção de fundo, a de objetos, a transcrição e a busca de sons.

## Vídeos de jogos (aba Jogos)

- **Faixas do OBS**: gravações com várias faixas de áudio (jogo, microfone, Discord) entram com cada faixa extra como um clipe de áudio vinculado ao vídeo. As faixas ficam em `%APPDATA%\Cena\processed` e não são extraídas de novo se você importar o mesmo arquivo.
- **Melhorar voz**: redução de ruído, corte de graves, menos "embolado", mais presença, de-esser, compressor e volume de fala (-16 LUFS), num clipe novo que pode ser desfeito com "Restaurar original".
- **Abaixar o jogo quando eu falo** (ducking): mede onde a voz fala e cria curvas de volume nos outros clipes (jogo, música), que descem até 10–60% e voltam nas pausas.
- **Volume**: até 200%, com automação por keyframes (canal `volume`). Na exportação, a opção "Volume no padrão do YouTube" normaliza a mistura final para -14 LUFS.
- **Cortar silêncios**: corta as pausas mais longas que 0,4–2,5 s a partir do volume do áudio, sem transcrever, e mantém todas as faixas sincronizadas.
- **Achar os momentos altos**: marca os trechos mais intensos do áudio (tiroteio, explosão, grito) com marcadores "Destaque".
- **Cenas**: marca ou divide o clipe em cada troca de cena.
- **Zoom de impacto** no cursor, **layout vertical** para Shorts e TikTok (webcam em cima e gameplay embaixo, ou só a gameplay sobre fundo desfocado) e os modelos **GG**, **Eliminação** e **Momento épico**.
- A IA usa as mesmas ferramentas: `process_clip` com `enhanceVoice`, `duck_audio`, `clear_ducking`, `remove_silences`, `find_highlights`, `detect_scenes`, `punch_zoom`, `vertical_gaming_layout` e `export_video` com `normalizeLoudness`.

## Assistente dentro do app (aba IA)

Na aba **IA** da biblioteca você escreve o pedido ("corte os silêncios", "deixe esse texto amarelo") e acompanha a timeline mudando enquanto o assistente trabalha. Ele lembra a conversa, mostra cada passo e tem um botão para parar. Tudo pode ser desfeito com Ctrl+Z.

- Usa o **Claude Code deste computador** com o seu login, sem chave de API: o de terminal ou o que vem com o app Claude para desktop (`electron/chat.cjs` procura os dois). Plugins e skills instalados, como o HyperFrames, também funcionam.
- Ele roda sem tela e se conecta só a um canal interno do Cena, com porta e token temporários, então não depende do botão "Conectar IA". As ferramentas liberadas são as do editor, os arquivos da pasta `%APPDATA%\Cena\assistente` e os comandos `npx hyperframes`. Qualquer outra coisa é recusada e avisada na conversa.
- O modelo pode ser escolhido na aba: o padrão do seu Claude Code, Sonnet, Opus ou Haiku. Cada pedido usa o seu plano do Claude.

## Editar com uma IA (Claude Code e outros clientes MCP)

O botão **Conectar IA** liga um servidor [MCP](https://modelcontextprotocol.io) local que deixa uma IA ver e editar o projeto aberto. Ele vem desligado. Depois de ligar, rode uma vez o comando mostrado na janela, que tem esta forma:

```bash
claude mcp add --transport http --scope user cena http://127.0.0.1:47821/mcp --header "Authorization: Bearer SEU_TOKEN"
```

Com o Cena aberto, é só pedir no Claude Code: "corte os silêncios", "gere legendas amarelas", "deixe vertical para Reels". As edições aparecem na timeline na hora, cada comando é uma etapa de Ctrl+Z e a janela mostra a atividade da IA.

- 40 ferramentas (`src/agentTools.ts`): ler o projeto, ver quadros renderizados, importar, adicionar clipes, textos, formas, legendas e modelos, alterar qualquer propriedade, keyframes, dividir, aparar, mover, reordenar, cortar trechos da timeline inteira, transições, efeitos, transcrever a fala, legendas automáticas, remover fundo, reduzir ruído, buscar e adicionar sons, salvar, abrir e exportar.
- Tarefas longas respondem com um `jobId`, acompanhado por `get_job`, para não estourar o tempo limite do cliente.
- Segurança: só aceita conexões deste computador (127.0.0.1), exige o token (em `%APPDATA%\Cena\agent.json`, com troca pela janela) e recusa pedidos vindos de páginas web. A IA não substitui arquivos nem descarta alterações sem um parâmetro explícito.
- **HyperFrames**: com a skill do [HyperFrames](https://github.com/heygen-com/hyperframes) instalada no Claude Code, a IA cria gráficos animados em HTML (títulos, nome na tela, gráficos, texto cinético), renderiza com `npx hyperframes render <pasta> --format webm --output <arquivo>.webm` (fundo transparente) e coloca o resultado sobre o vídeo com `add_clip` e `overlay: true`. As instruções do servidor já ensinam esse caminho à IA. O HyperFrames precisa de Node.js 22 ou mais novo e do FFmpeg instalados no PC.
- Quem tem o token pode ler e gravar arquivos pelo Cena, com as permissões do seu usuário. O servidor só funciona com o Cena aberto.

## Limitações conhecidas

- Remover fundo é feito para pessoas (MODNet); objetos e animais podem sair mal recortados. Em vídeo, cada quadro leva ~0,1–0,2 s.
- Remover objetos só funciona em fotos; em vídeo exigiria acompanhar o objeto quadro a quadro.
- Inverter vídeo aceita trechos de até 3 minutos (o FFmpeg guarda os quadros na memória). Melhorar qualidade é um aumento de resolução clássico (Lanczos + nitidez + redução de ruído), não IA.
- Avatar de IA não existe.
- A busca de sons depende do Openverse, que às vezes é lento (a primeira busca de um termo pode levar até um minuto) ou fica fora do ar; os efeitos prontos funcionam sempre.

- A detecção de fala do ducking e do corte de silêncios usa volume, não reconhecimento de voz: funciona bem com a voz numa faixa própria. Com jogo e voz misturados na mesma faixa, o som alto do jogo também conta como "fala".
- Separar a voz de um áudio já misturado (jogo e voz juntos) não existe. Grave o microfone numa faixa separada no OBS.
- Na importação do CapCut, cada transição vira "Dissolver"; efeitos, filtros, stickers e animações são ignorados.
- Transições só existem em faixas de vídeo e não fazem crossfade de áudio (o som corta no ponto do corte).
- A exportação busca cada quadro com seek; é correta, mas mais lenta que tempo real em vídeos longos.
- Instalador sem assinatura digital e sem atualização automática.
