# Cena Estúdio (LEIA-ME)

O Estúdio é uma segunda janela do Cena onde agentes preparam os seus vídeos para o YouTube: pesquisam o tema, escrevem o roteiro, cortam a gravação, limpam o áudio, editam, criam thumbnails, escrevem título e descrição e enviam ao canal.

**Regra que nunca muda: nenhum vídeo é enviado ao YouTube sem a sua aprovação no painel.** O envio confere, na hora, se o arquivo, o título, a descrição, as tags, a thumbnail e a data são exatamente os que você aprovou. Se qualquer coisa mudou, ele recusa e o vídeo volta para a revisão.

## 1. O que precisa estar instalado

- **Cena** (este app). Abra o Estúdio pelo botão "Estúdio" na tela inicial.
- **Claude Code**, com o seu login. Os agentes de Pesquisa, Roteiro, Corte, Edição, Metadados e Correções pensam por ele. Não é usada chave de API da Anthropic. Sem o Claude Code, cortes de silêncio, áudio e montagem continuam funcionando.
- Mais nada. FFmpeg, banco de dados e transcrição (Whisper) já vêm no Cena e rodam neste computador.

Os dados do Estúdio ficam em `%APPDATA%\Cena\estudio\`. Os seus vídeos originais nunca são alterados: o Estúdio trabalha em cópias.

## 2. Caminho de um vídeo

0. **Crescer**: clique em **Analisar e sugerir**. O agente de Crescimento compara os seus vídeos entre si quando o canal está conectado (visualizações por dia contra a mediana, Shorts contra vídeos longos). Ele também olha as gravações que estão no Estúdio e o que você pesquisou em Tendências. Depois traz um diagnóstico, dicas com o motivo e o como fazer, o ritmo de postagem, vídeos para gravar (cada um com **Criar roteiro**), gravações que valem Shorts agora (botão **Gerar Shorts**) e assuntos para pesquisar em Tendências. Ele só sugere e nada é feito sem você clicar. Leva de 1 a 2 minutos e gasta uns 20 mil tokens.
0. **Tendências**: pesquise um assunto e um período ("GTA RP polícia", último mês). Aparecem os vídeos mais vistos, com números exatos da YouTube Data API: visualizações, visualizações por dia, quantas vezes o vídeo passou o tamanho do canal. Também aparece o que eles têm em comum: termos em alta nos títulos, duração, jeito dos títulos e dia e hora em que saíram. Cada pesquisa gasta 2 das 100 buscas diárias da API. Marque os vídeos que você quer imitar e clique em **Estudar estilo e sugerir vídeos**. A IA lê os números, títulos, descrições e capas e escreve um guia: como o vídeo começa, a estrutura do roteiro, o estilo de edição, as fórmulas de título, as capas e o que está crescendo. Ela também traz ideias de vídeos para você gravar, e cada ideia vira um roteiro com **Criar roteiro**. A IA não assiste vídeos do YouTube. Para copiar o ritmo de edição de verdade, adicione **vídeos de referência do seu PC**: o Cena mede cortes por minuto, duração dos planos, movimento e fala, e a IA olha 6 quadros e lê a transcrição dos primeiros 5 minutos. Sem eles, a edição aparece marcada como "deduzida". **Aplicar no editor** abre o editor com o pedido pronto no chat da IA, e você só clica em Enviar. **Usar como padrão** faz a IA do editor e os agentes de Edição e Roteiro seguirem o estilo. No chat do editor, o estilo em uso aparece no alto, com o botão **Desligar**.
1. **Roteiros**: digite o tema. O agente de Pesquisa procura vídeos que deram certo e o agente de Roteiro escreve (3 ganchos, marcações, duração estimada). Você ajusta em linguagem natural, aprova e grava com o teleprompter.
2. **Painel**: arraste a gravação (ou use a pasta monitorada). Antes de começar, uma janela pergunta **como você quer a edição** ("vídeo de uns 20 minutos, só as melhores partes, sem música, legendas de 2 palavras, corta do começo até 2:30") e **onde o fluxo para** e espera você. Depois as etapas correm sozinhas: Ingestão, Corte, Áudio, Edição, Metadados, Thumbnail e Montagem. Na mesma janela você escolhe **quais agentes trabalham** (Corte, Áudio, Edição, Metadados, Thumbnail, Montagem): sem o Corte a gravação é só transcrita e nada é cortado; sem a Montagem os agentes só montam o projeto, para você exportar no editor. O botão **Pedido** de cada cartão muda o pedido e os agentes depois; **Pausar** para o vídeo a qualquer momento.
   - **Do editor**: com um projeto aberto, o botão **Enviar ao Estúdio** (barra de cima) manda a gravação da faixa principal e os cortes que você já fez nela, com o pedido, os agentes e as paradas. O seu projeto fica guardado como estava. Sem a Montagem dos agentes, no fim é o **seu** projeto que é renderizado, com o título e a thumbnail que os agentes fizeram. Se a faixa principal repetir um trecho (um destaque no começo, por exemplo), mudar a ordem, acelerar um trecho ou juntar várias gravações, o Estúdio avisa onde e oferece **Enviar na ordem do editor**: ele cria um arquivo novo com a faixa principal exatamente nessa ordem, cada faixa de som separada, e os agentes trabalham em cima dele. Ocupa perto de 11 GB por hora de vídeo (apagado junto com o vídeo) e leva uns 18 minutos para 2 horas.
   - **Vários vídeos de uma gravação**: escreva no pedido, por exemplo "serão 4 vídeos, cada um com 2 corridas". Depois do Áudio, o Diretor olha folhas com um quadro a cada poucos segundos (menus, telas de resultado e de carregamento marcam onde uma corrida acaba) e o que foi falado, e propõe as partes. O fluxo **sempre para** aqui: na aba Cortes você confere cada parte (título, início, fim e quanto dura com os cortes), muda os tempos, tira ou põe uma parte, ou pede ao Diretor ("faz 3 em vez de 4"). **Criar os vídeos** transforma cada parte num vídeo do Painel, que segue da Edição em diante, com a transcrição, os cortes e o som já prontos. **Seguir como um vídeo só** ignora a divisão.
3. **Cortes**: é onde você decide o que fica no vídeo, com o fluxo parado (ou pausado). Dá para tocar a gravação pulando o que está cortado, ligar e desligar cortes, cortar um trecho digitando início e fim, pedir por escrito ("corta do minuto 10 ao 25", "deixa só as melhores partes, uns 20 minutos") ou clicar em **Abrir no editor**: a gravação abre no editor do Cena com os cortes feitos, você corta lá, salva com Ctrl+S e o Estúdio aproveita. No meio do fluxo só os cortes são aproveitados; efeitos e trocas de ordem ficam para a revisão final. **Continuar o fluxo** manda os outros agentes seguirem com o vídeo como ele estiver.
   - **Ação na tela**: no Corte, o seu PC mede a cada segundo quanto a imagem se mexe, as trocas de cena, as telas paradas (menu, carregamento, resultado) e o volume da faixa do jogo, sem gastar tokens (uns 8 minutos para 2 horas, guardado em `visual.json` ao lado da transcrição). A faixa **ação** embaixo da linha dos cortes mostra isso: laranja é ação forte, listrado é tela parada. Um corte em cima de ação forte fica desligado, mesmo sem ninguém falar, com o motivo "mantido: tem ação na tela"; só um trecho que você pediu pelo tempo ("corta de 10:00 a 12:00") passa por cima. Os cortes longos e duvidosos (8 s ou mais, ação média) a IA confere olhando 4 quadros de cada um (até 18 cortes, poucos milhares de tokens). Trechos sem fala com ação nem viram sugestão. O pedido por escrito também sabe onde há ação e tela parada ("tira os menus", "só a ação").
   - **Pela IA principal do editor** (Claude Code conectado em "Conectar IA"): peça a ela, por exemplo, "desse vídeo de 2 horas, faz vídeos com 2 corridas cada, edição animada". Ela acha onde cada corrida começa e termina olhando os quadros, monta e edita cada vídeo no editor (som, cortes, zooms, textos) e manda cada um ao Estúdio com `studio_send_project`, numa mesma **série**. No Estúdio só os agentes de Metadados e Thumbnail trabalham, e o projeto dela é renderizado como está. As thumbnails de uma série são feitas diferentes entre si. Ela também pode programar os lançamentos (`studio_schedule`) e ver como os vídeos estão (`studio_videos`).
4. **Aguardando aprovação**: **Abrir no editor** abre o projeto que os agentes montaram. Mudou e salvou lá? A revisão mostra duas saídas: **Renderizar como está no editor** (o vídeo final passa a ser o seu projeto, com tudo que você mexeu) ou **Voltar ao início com os cortes de lá** (os cortes do editor voltam para o começo e os agentes refazem a edição). **Voltar ao início** também existe sem passar pelo editor: o vídeo para antes da Edição, como a parada depois do Corte, você muda cortes e pedido e clica em Continuar; transcrição, som, título e thumbnails ficam. Assista ao vídeo final ao lado do original, ligue ou desligue cortes, escolha a thumbnail, corrija título, descrição, tags e capítulos, escolha a data e peça correções por escrito se quiser. Depois clique em **Aprovar**.
5. **Enviar ao YouTube**: o botão só funciona em vídeo aprovado. Com data marcada, o vídeo sobe como privado e o próprio YouTube publica na hora escolhida.
6. **Shorts**: o **agente de Shorts no automático** (ligado por padrão, na barra do alto da aba) trabalha sozinho quando um vídeo fica pronto, mesmo sem o agente de Corte. Ele acha os momentos cruzando a fala com a ação medida na tela e no som do jogo, depois olha 5 quadros de cada candidato para dar nota e acertar onde começa e termina. Um momento de ação sem fala também entra. Depois ele gera os melhores momentos (por padrão 3, com nota 70 ou mais) e **1 Story de divulgação**. O Story é um vídeo vertical de até 30 s com o melhor momento e "VÍDEO NOVO NO CANAL!" no alto, para postar pelo celular no Instagram, no WhatsApp ou no TikTok; ele nunca vai ao YouTube. Tudo espera a sua aprovação. A aba lista os momentos que o agente de Corte sugeriu em cada gravação (com nota e motivo). Marque os que quiser e clique em "Gerar selecionados": cada um vira um vídeo vertical 1080×1920 com legendas grandes. Em cada cartão dá para mudar título, início e fim, enquadramento (quadrado, tela cheia ou vídeo inteiro), foco, texto no alto e legendas. Assista, clique em **Aprovar** e depois em **Enviar ao YouTube**. Mudou algo depois de aprovar? Ele gera de novo e pede aprovação de novo. À direita fica o painel de IA: escreva o que quer ("ache mais 3 momentos engraçados", "o short 2 começa 3 segundos antes", "tira a legenda do primeiro"). O agente lê só o que foi falado; ele não vê a imagem.
   **Programar lançamentos** (botão no Painel): marque os vídeos na ordem em que devem sair, escolha o primeiro dia, a frequência (todo dia, dia sim dia não, a cada 3 dias, uma vez por semana) e o horário (o melhor do canal ou um fixo). Com **Enviar sozinho assim que eu aprovar** ligado, cada vídeo aprovado sobe como privado e o YouTube publica na data. **Aprovar os N prontos** aprova de uma vez os vídeos prontos da lista, depois de mostrar cada um com a data; a aprovação continua sendo sua.
7. **Calendário**: mostra o mês. Arraste um vídeo para outro dia para mudar a data (se já estava aprovado, ele pede nova aprovação).
8. **Canal**: números do canal nos últimos 28 dias, últimos vídeos e melhor horário para publicar.

- **Thumbnails com direção de arte**: o agente olha até 8 quadros do vídeo (os momentos falados e os de mais ação) e desenha cada opção no estilo dos canais grandes. Ele dá zoom no assunto, põe uma seta grossa ou um anel no que importa, coloca o seu rosto da webcam num quadro com borda, escolhendo a cara mais expressiva, e escreve um texto curto com uma palavra destacada. Depois ele confere as thumbnails prontas e acerta setas e anéis que erraram o alvo. O rosto vem da webcam que aparece na gravação ou do clipe de webcam do seu projeto no editor. Só usa imagens do próprio vídeo, nada da internet nem de outras pastas. Gasta uns 30 mil tokens por vídeo.

## 3. Conectar o YouTube (feito uma vez, por você)

As chaves são suas. Você as cria no Google Cloud e digita em **Configurações → YouTube**. Elas ficam só neste computador, criptografadas pelo Windows, e o painel nunca as mostra de novo.

### 3.1 Criar o projeto e ativar as APIs

1. Entre em <https://console.cloud.google.com/> com a conta do Google dona do canal.
2. No topo, **Selecionar projeto → Novo projeto**. Dê um nome (por exemplo "Cena Estúdio") e crie.
3. Em **APIs e serviços → Biblioteca**, procure e clique em **Ativar** em cada uma:
   - **YouTube Data API v3**
   - **YouTube Analytics API**

### 3.2 Chave de API (para a Pesquisa)

1. **APIs e serviços → Credenciais → Criar credenciais → Chave de API**.
2. Recomendado: em "Restrições da API", limite a chave à **YouTube Data API v3**.

Ao salvar, os campos ficam vazios de propósito: as chaves não aparecem de novo. Ao lado de cada campo fica "salva"; o ID do cliente mostra os últimos caracteres para você conferir. Chave colada no campo errado é recusada com aviso. A chave secreta só aparece uma vez no Google: se perder, crie outra em Clientes → o cliente → Chaves secretas → Add secret.
3. Copie a chave e cole em **Configurações → YouTube → Chave de API**.

Sem essa chave a Pesquisa continua funcionando pela busca na web, mas sem números verificados.

### 3.3 Cliente OAuth (para enviar vídeos e ler o canal)

1. **APIs e serviços → Tela de permissão OAuth** (ou "Google Auth Platform"): tipo de usuário **Externo**, preencha o nome do app e o seu e-mail.
2. Em **Público-alvo → Usuários de teste**, adicione o e-mail da conta do canal.
3. **Credenciais → Criar credenciais → ID do cliente OAuth → Tipo: App para computador**.
4. Copie o **ID do cliente** e a **Chave secreta** e cole em **Configurações → YouTube**. Clique em **Salvar chaves**.
5. Clique em **Conectar o canal**. O seu navegador abre a página do Google: entre na conta, escolha o canal e permita. O Cena pede três permissões: enviar vídeos, ler o canal e ler as estatísticas.

Para desconectar: **Configurações → YouTube → Desconectar**, ou em <https://myaccount.google.com/permissions>.

### 3.4 Três avisos importantes do Google

- **Vídeos travados como privados.** Em projetos do Google Cloud que ainda não passaram pela auditoria do YouTube, todo vídeo enviado pela API fica **privado** e não pode ser tornado público. Faça um envio de teste: se o vídeo ficar preso em privado, peça a auditoria no formulário "YouTube API Services - Audit and Quota Extension Form" (gratuito, leva alguns dias ou semanas). Enquanto isso, publique o vídeo pelo YouTube Studio.
- **App em "Teste" expira o acesso em 7 dias.** Enquanto a tela de permissão estiver em modo de teste, o Google derruba a conexão toda semana e é preciso clicar em "Conectar o canal" de novo. Para evitar, publique o app na tela de permissão ("Em produção").
- **Thumbnail própria exige canal com telefone verificado** (<https://www.youtube.com/verify>). Sem isso o vídeo sobe, a thumbnail não, e o painel avisa.

### 3.5 Cota diária

O Google dá uma cota por dia, que volta à meia-noite da Califórnia (4h ou 5h em Brasília). O Estúdio conta o uso e mostra em Configurações e na aba Canal. Cada roteiro pesquisado usa 2 buscas; as respostas ficam guardadas para não pagar duas vezes pela mesma pergunta. Se a cota acabar no meio de um envio, ele espera e continua sozinho quando ela voltar.

## 4. Como o envio se protege

- Só começa com o seu clique em "Enviar ao YouTube" (ou sozinho logo após a aprovação, se você ligar essa opção em Configurações; vem desligada).
- Antes de cada tentativa, confere a aprovação. Mudou um corte, o título, a thumbnail ou a data depois de aprovar? Recusa.
- Se a internet cair, continua de onde parou, inclusive depois de fechar e abrir o Cena.
- Depois de enviado, título, data e thumbnail só mudam pelo YouTube Studio (o painel tem o link).
- Os agentes de IA não têm nenhuma ferramenta de envio: quem envia é um código simples, sem IA.

## 5. Melhor horário

A API do YouTube não informa em que hora o público está online. O Estúdio calcula com o que dá para medir: o desempenho dos vídeos do seu canal pelo dia e hora em que saíram; se o canal ainda tem poucos vídeos, usa os horários dos vídeos de referência da Pesquisa; na falta dos dois, um padrão geral. A tela sempre diz qual base foi usada.

## 6. Configurações úteis

- **Som das gravações com várias faixas (OBS)**: na Ingestão o Estúdio ouve cada faixa. A que quase nunca fica quieta é o **jogo**; entre as que têm fala, a que tem **uma voz só** (o timbre quase não muda de uma fala para outra) é a **sua** e as outras são a **conversa** (Discord). Cada faixa é tratada sozinha: a sua voz ganha limpeza leve e compressão, a conversa só é nivelada, o jogo só tem o volume acertado (conversa 2 dB e jogo 10 dB abaixo da sua voz; ajustável, ou no pedido: "jogo mais baixo"). O agente grava um arquivo por faixa (`som-1-minha-voz.flac`, `som-2-jogo.flac`, `som-3-conversa.flac`) e a Montagem põe cada um na sua própria faixa do projeto, como o editor faz: abrindo o projeto no Cena dá para mexer em cada uma. Transcrição, cortes e legendas ouvem só as vozes. O conjunto sai em −14 LUFS por ganho medido e limitador. Em gameplay não entra música de fundo, a não ser que o pedido peça. Se ele errar uma faixa, fixe em Configurações → Agente de Áudio e refaça a Ingestão.
- **Tokens**: dividir uma gravação em partes manda ao Claude de 1 a 9 folhas de quadros (cerca de 1.500 tokens cada) e a transcrição, uma vez. Os agentes usam o Sonnet, a não ser que você escolha outro modelo, e cada chamada registra no log quantos tokens leu e escreveu.
- **Agente de Corte / Áudio / Edição / Thumbnail**: estilo, intensidade, legendas, música, quantidade de thumbnails.
- **Modelos de IA**: qual modelo do Claude cada agente usa.
- **Pasta monitorada**: toda gravação nova nessa pasta entra na fila.
- **Fluxo dos vídeos**: o pedido padrão e as paradas padrão, usados quando você não diz nada (e pela pasta monitorada).
- **Pausar a fila**: o que está rodando termina, nada novo começa (vale também para envios).

### Montagem rápida

Os trechos em que o vídeo aparece como foi gravado (com correção de cor e com legendas ou textos por cima) vão direto pelo FFmpeg e pela placa de vídeo. Só passam quadro a quadro pelo compositor os trechos com zoom, transição, imagem de apoio ou efeito. O registro da Montagem diz quanto do vídeo foi por cada caminho e a velocidade.

## 7. Para quem mexe no código

```
node scripts/studio-test.mjs <video|-> [--script] [--adjust] [--keep] [--correct "texto"] [--settings] [--youtube] [--shorts] [--flow]
```

`--youtube` usa um servidor falso do Google (`scripts/youtube-mock.mjs`): testa conexão, pesquisa, recusas, envio com queda e retomada, thumbnail e a aba Canal sem tocar em nenhum canal de verdade. `--flow` monta o mesmo projeto pelos dois caminhos (compositor e rápido) e compara imagem e número de quadros; depois passa uma cópia pelo fluxo com pedido, parada depois do Corte, corte à mão, por pedido e pelo editor. Os dados de teste ficam em `D:\CloneCapCut\.teste-estudio`.

Arquivos: `electron/studio/` (`index.cjs` orquestrador, `approval.cjs` trava, `youtube.cjs` cliente da API, `publish.cjs` envio, `agents/*.cjs`, com `director.cjs` lendo o pedido) e `src/studio/` (telas). A montagem rápida fica em `src/engine/exportPlan.ts`, `electron/hybrid.cjs` e `electron/exporter.cjs`.
