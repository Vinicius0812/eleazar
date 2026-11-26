# Eleazar

> Uma meta. Varios agentes. Uma execucao coordenada.

Eleazar e um orquestrador local-first de agentes de programacao. Ele classifica uma tarefa, verifica provedores locais e delega a execucao ao agente mais adequado. O **Control Room** e a interface React local para acompanhar os projetos, tarefas, execucoes e decisoes persistidos pelo nucleo em SQLite.

## Requisitos

- Node.js 22 ou superior (a ponte ACP do Claude, versão 0.107.0, exige Node 22; o ambiente de desenvolvimento usa Node 24);
- Git, apenas para os recursos de branch por tarefa, commit, push e pull request. Uma pasta comum do disco, sem repositório, funciona normalmente;
- GitHub CLI (`gh`) autenticado, somente se quiser abrir e acompanhar pull requests pelo painel;
- Codex CLI, Claude Code CLI e/ou Antigravity CLI (`agy` 1.5 ou superior) instalados; autentique o provedor que pretende executar.

Eleazar nao armazena senhas, cookies ou tokens de sessao.

## Desenvolvimento

Instale as dependencias de cada pacote uma vez:

```powershell
npm ci
npm ci --prefix apps/control-room
```

Inicie API e interface com um unico comando:

```powershell
npm run control-room
```

Abra http://127.0.0.1:5173. A API escuta em http://127.0.0.1:4317 e o banco fica em `.eleazar/control-room.sqlite` do diretório corrente. Ambos os servidores ficam restritos ao loopback. A API verifica o Host, permite apenas as origens da interface local e exige JSON para mutações.

Verifique a entrega:

```powershell
npm run check
npm run check --prefix apps/control-room
```

## CLI

Os comandos existentes continuam disponiveis:

```powershell
npm run doctor
npm run dev -- plan "Implemente autenticacao JWT na API"
npm run dev -- run "Revise o tratamento de erros" --cwd C:\caminho\do\projeto
```

Use `--json` em qualquer comando para obter saida legivel por outras ferramentas.

### Claude Code via ACP

Use o [CLI nativo do Claude Code](https://code.claude.com/docs/en/cli-reference) já instalado e autenticado. O adaptador procura primeiro `~/.local/bin/claude` (`claude.exe` no Windows) e depois o `PATH`. `npm run doctor` verifica o runtime e a autenticação sem consultar modelos.

```powershell
npm run dev -- plan "Planeje a arquitetura a partir deste resumo aprovado: ..." --provider claude
npm run dev -- run "Revise este trecho aprovado: ..." --provider claude
```

`plan` mostra a decisão de roteamento. `run` envia o texto informado ao Claude, por isso inclua somente o contexto que você aprova compartilhar com o provedor. A execução comum usa a ponte Claude ACP `0.107.0`, com sessões retomáveis quando anunciadas pelo agente, eventos parciais e pedidos de permissão. As ferramentas expostas são `Read`, `Glob`, `Grep`, `Edit` e `Write`; `Bash`, terminal, ferramentas web e MCP não são expostos. As regras de arquivos do SDK bloqueiam leituras e escritas fora dos diretórios de trabalho, enquanto `Edit` e `Write` exigem confirmação e o cliente verifica os caminhos reais antes de aceitar uma permissão. Esse modo de arquivos não exige o sandbox de shell do Claude e não equivale ao sandbox `workspace-write` do Codex.

No painel, qualquer tipo de tarefa pode selecionar o Claude ao confirmar a execução, no escopo aprovado da tarefa. O título e a solicitação são enviados ao provedor, e os pedidos de permissão aparecem na sessão e esperam a decisão do operador. A **revisão cruzada** continua usando o modo textual restrito do `ClaudeAdapter`, sem ferramentas nem acesso ao checkout.

### Provedores e modo Automático

Cada pessoa usa a própria conta, já conectada na CLI de cada provedor. A tela **Provedores** do Control Room mostra versão, executável, login e conexão ACP, e quando falta o login exibe o comando oficial para rodar no seu terminal. O Eleazar nunca faz login nem lê credenciais. **Verificar conexão** abre e fecha uma sessão do agente, sem enviar prompt.

Na mesma tela você ativa ou desativa um provedor, escolhe o modelo padrão, aponta outro executável e decide quem participa do **Automático**. O Automático compara os participantes pela afinidade com o tipo da tarefa e só usa quem tem o login confirmado. Quando você escolhe um provedor, a tarefa nunca é desviada para outro.

Um agente que já fala ACP entra sem mudar o código, em `.eleazar/providers.json` na pasta onde o Eleazar roda (o host lê o arquivo ao iniciar):

```json
{
  "providers": [{
    "id": "meu-agente",
    "label": "Meu agente",
    "executable": "meu-agente",
    "args": ["acp"],
    "requiredMode": "default",
    "loginCommand": "meu-agente login",
    "loginHint": "Entre com a sua conta no Meu agente.",
    "affinity": { "implementation": 70 }
  }]
}
```

Esses agentes usam a política genérica: binário nativo sem shell, argumentos fixos, sem variáveis de credenciais, modo de permissão obrigatório e edições limitadas às pastas da tarefa. Argumentos que pulam permissões são recusados. Eles ficam fora do Automático até você ativá-los. Os campos opcionais estão em [docs/control-room.md](docs/control-room.md).

### Revisão cruzada no terminal

```powershell
npm run dev -- cross-review "Simplifique o tratamento de erros" --cwd "C:\Projetos\repo" --file src/servico.ts --file src/validacao.ts
```

O comando requer um terminal interativo, Codex e Claude Code autenticados e um checkout Git inicialmente limpo. Repita `--file` para indicar cada arquivo regular já rastreado, com o caminho relativo exato e barras `/`. O Codex implementa localmente em sandbox `workspace-write`, com pedidos de elevação, busca web e rede das ferramentas desabilitados. O verificador Git limita o material que pode sair do checkout. A orientação de editar só os arquivos listados não equivale a uma restrição de escrita por arquivo. Mudanças fora do escopo, alterações preparadas no índice, inclusões, exclusões, renomes, diffs binários e diffs acima de 32 KiB interrompem o envio.

Após cada implementação, confira o objetivo e o diff exibidos no terminal. A prévia dobra barras invertidas e mostra controles como escapes visíveis. Só digite `SIM` se autorizar o compartilhamento desse material com o Claude. Os achados são dados do revisor e exigem uma segunda confirmação antes de uma rodada de correção. O fluxo termina após no máximo duas rodadas e deixa as alterações locais disponíveis para inspeção, inclusive se a revisão for recusada ou falhar. Arquivos ignorados pelo Git ficam fora do relatório.

Com `--json`, o resultado final sai no stdout. Progresso, prévias e confirmações ficam no stderr, que deve continuar conectado ao terminal.

## Control Room local

A UI conversa somente com a API HTTP local em `/api/control-room` (projetos, tarefas, execuções, status e catálogo de provedores, eventos SSE, cancelamento e permissões de sessão); a lista completa de rotas e contratos está em [docs/control-room.md](docs/control-room.md). Os DTOs HTTP espelham os contratos de `src/core/control-room.ts`, mas ficam no pacote da UI sem importar Node, SQLite ou SDKs de provedores.

O painel mostra somente estado persistido: projetos e tarefas reais, execucoes registradas e logs. Tarefas em `waiting_approval` aparecem como aprovacoes; aprovar retorna a tarefa para `queued` e rejeitar faz a transicao para `cancelled`. Para uma tarefa em `queued`, use **Executar** e confirme o provedor. Codex, Claude Code e Antigravity usam sessões ACP com modelo selecionável (somente entre os anunciados pelo catálogo do provedor), texto do agente em streaming, atividade de ferramentas, decisões de permissão e cancelamento. A API verifica a disponibilidade e persiste o resultado, duração, tokens quando fornecidos e logs; o painel atualiza enquanto houver execução ativa. A visão geral mostra limites e reset do Codex apenas quando a sessão oficial os disponibiliza, e tokens observados do Antigravity sem estimar saldo. Ao abrir uma execução concluída ou com falha, a URL `#/executions/:id` mostra o retorno Markdown, tentativas anteriores e o resumo dos arquivos atribuídos àquela execução. Acoes de `push`, `merge` e `deploy` continuam bloqueadas pelo núcleo e a instrução enviada ao provedor também proíbe login, logout e acesso a credenciais.

Consulte [o guia do Control Room](docs/control-room.md) para detalhes do transporte e operacao local.

## Projetos com vários diretórios

Um projeto pode agrupar checkouts locais relacionados, em uma ordem explícita. Cada entrada tem ID, rótulo, caminho absoluto, instante de cadastro e indicação de Git. Cadastros antigos com apenas `path` são migrados automaticamente para um único diretório, sem perder tarefas: a tarefa passa a apontar para esse diretório.

Pela API, o novo formato é:

```json
{
  "name": "Produto",
  "directories": [
    { "name": "API", "path": "C:\\Projetos\\produto-api" },
    { "name": "Web", "path": "C:\\Projetos\\produto-web" }
  ]
}
```

Ao criar uma tarefa, envie `targetDirectoryId` e `directoryIds`. O alvo principal sempre integra o escopo. Tarefas de um diretório entram na fila; tarefas que selecionam mais de um checkout são persistidas em `waiting_approval` e só voltam a `queued` após a aprovação do operador. Projetos antigos continuam com um escopo de um diretório após a migração.

### Pasta comum ou repositório Git

O Eleazar não exige um repositório. O modo de execução é decidido por tarefa:

- **Pasta comum** (ou escopo em que algum diretório não é Git): o agente trabalha direto na pasta. A persistência impede dois despachos simultâneos cujos escopos tenham qualquer diretório em comum; escopos disjuntos continuam independentes.
- **Repositório Git** (todo o escopo): na primeira execução o Eleazar cria a branch `eleazar/<titulo>-<id>` e uma worktree por diretório em `.eleazar/worktrees/<tarefa>/`, fora dos repositórios. O agente trabalha só nessa worktree, o seu checkout não é tocado e várias tarefas rodam em paralelo no mesmo repositório. A worktree parte do último commit: alterações ainda sem commit no seu checkout não entram nela. Um repositório sem nenhum commit precisa de um commit inicial.

Cada projeto Git escolhe, na tela **Projetos**, entre **Worktree por tarefa** e **Direto na pasta**. No modo direto o agente altera os arquivos do seu checkout, sem branch própria: uma tarefa por vez em cada pasta, e commit e push ficam com você, em qualquer servidor Git. Enquanto a worktree é criada, a execução aparece como **Preparando** e pode ser cancelada; se o Git falhar, o motivo aparece na tela.

Defina `ELEAZAR_CONTROL_ROOM_WORKTREES=off` antes de `npm run control-room` para rodar sempre direto na pasta.

### Limite de tempo do turno

Um turno de agente (Codex, Claude Code ou Antigravity) termina quando o agente fica **10 minutos sem enviar nada** ou quando chega ao teto de **60 minutos**. O tempo de inatividade não corre enquanto uma ferramenta ainda está em execução (um build ou uma suíte de testes longa) nem enquanto uma permissão espera a sua resposta. Para projetos grandes, ajuste antes de `npm run control-room`:

```powershell
$env:ELEAZAR_AGENT_TURN_TIMEOUT_MINUTES = "120"   # teto do turno; 0 desliga
$env:ELEAZAR_AGENT_IDLE_TIMEOUT_MINUTES = "15"    # inatividade; 0 desliga
```

### Navegação

O menu lateral separa **Trabalho** (Visão geral, Fila de tarefas, Aprovações), **Histórico** (Execuções, Logs) e **Configuração** (Projetos, Provedores). Abaixo dele, cada projeto lista as tarefas ativas: clicar no nome do projeto abre o quadro já filtrado e a seta recolhe o projeto (a escolha fica salva no navegador). O topo mostra onde você está, como Tarefas › Projeto › Tarefa › Arquivos, e cada nível é um link. **Ctrl+K** (ou **Buscar ou ir para…**) abre a paleta para ir a qualquer tarefa, projeto ou tela, cadastrar um projeto ou trocar o tema.

### Explorar arquivos e diff

O botão **Explorar arquivos** (na tarefa e no resultado da execução) abre a pasta em que o agente trabalha, seja a worktree da tarefa ou a pasta do projeto no modo direto, com a lista de alterações, a árvore completa e o diff de cada arquivo. Funciona com qualquer servidor Git (GitHub, Gogs ou nenhum) porque só lê o repositório local.

### Continuar a mesma tarefa

Quando um turno termina (`completed` ou `failed`), a tela da tarefa mostra **Nova mensagem para o agente**. O novo turno roda na mesma pasta ou worktree. Com Codex e Claude Code, a sessão ACP anterior é retomada quando o agente anuncia suporte; caso contrário o pedido original segue junto com a nova mensagem.

### Commit, push e pull request com aprovação

Tarefas com branch própria mostram o painel **Publicação**. Cada ação tem duas etapas: você a solicita, o painel registra exatamente o que será feito (arquivos, branch, remoto) e nada roda até **Aprovar e executar**. O commit e o push usam o seu `git`; o pull request usa o `gh`. O Eleazar não lê tokens e remove credenciais embutidas em URLs antes de exibir ou gravar. O agente continua proibido de fazer push, e merge e deploy não são oferecidos. **Remover worktree** apaga a pasta isolada e mantém a branch; o Git recusa se houver trabalho sem commit.

### Quadro e pull requests

A fila de tarefas abre como um quadro em que cada tarefa se posiciona sozinha: Na fila, Trabalhando, Precisa de você, Para revisar, Em revisão e Pronto para merge. Depois que a branch é enviada, o host consulta o pull request com o `gh` a cada 60 s e o cartão acompanha CI, conflitos e revisões. O merge é sempre seu, no GitHub. Detalhes em [docs/control-room.md](docs/control-room.md).

## Seguranca

- O Eleazar nunca tenta extrair credenciais dos provedores.
- O adaptador Antigravity inicia `agy acp --sandbox` no modo `default` e nunca usa `--dangerously-skip-permissions`. **Limitacao conhecida:** em testes reais com a 1.5.9, o `agy` pediu permissao para editar dentro de `.eleazar` neste repositorio, mas nao pediu em pastas dentro do diretorio temporario do sistema. Nao use o Antigravity em projetos guardados no diretorio temporario.
- O roteador nao envia uma tarefa a um provedor explicitamente nao autenticado.
- Commit, push e pull request so rodam depois da aprovacao explicita do operador no painel Publicacao. Merge, deploy e comandos destrutivos nao sao executados pelo Control Room.
