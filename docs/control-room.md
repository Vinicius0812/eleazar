# Eleazar Control Room

O Control Room e uma interface React + Vite que consome o estado autoritativo do nucleo Eleazar por HTTP local. Ela nao contem banco, acesso a arquivos, SDK de provedor ou codigo Node no bundle do navegador.

## Inicializacao

Use Node.js 22 ou superior. Na raiz do repositorio:

```powershell
npm ci
npm ci --prefix apps/control-room
npm run control-room
```

O comando inicia a API em `127.0.0.1:4317` e o Vite em `127.0.0.1:5173`. A porta da API pode ser alterada somente no host local por `ELEAZAR_CONTROL_ROOM_PORT`; quando ela for alterada, ajuste a configuracao do cliente antes de abrir a UI.

O launcher (`scripts/control-room-dev.ts`) executa a API (via `tsx`) e o Vite como processos Node comuns, sem shell nem `npm`, com argumentos fixos; o Vite usa `--strictPort` (já configurado em `vite.config.ts`), então uma 5173 ocupada falha em vez de mudar de porta. Ctrl+C, SIGTERM, falha de inicialização ou a saída de qualquer um dos dois param os dois e seus descendentes, e o launcher só termina depois de confirmar que cada filho saiu (até 3 s por filho); se algum não sair, o PID é registrado e o código de saída é diferente de zero. Só processos criados pelo próprio launcher são encerrados: não há encerramento por nome ou porta, então uma API que já estivesse rodando antes não é tocada (e a nova API falhará por porta ocupada). Limite: os descendentes de um filho que já havia saído sozinho não são rastreados nem encerrados, e a confirmação vale para cada filho direto, não para cada descendente. O encerramento é forçado (`taskkill /T /F` no Windows; grupo de processos isolado com `SIGKILL` no POSIX, caminho este não exercitado pelos testes feitos no Windows). O mesmo helper encerra as pontes ACP.

## Contratos e fluxo

`src/core/control-room.ts` e a fonte dos contratos de dominio. `apps/control-room/src/services/contracts.ts` e um espelho de transporte JSON: preserva estados (`queued`, `planning`, `running`, `waiting_approval`, `completed`, `failed`, `cancelled`) e prioridades (`low`, `normal`, `high`, `critical`), sem importar codigo do host no navegador.

O cliente HTTP usa um snapshot consistente para leitura e mutacoes confirmadas pelo servidor:

- `GET /api/control-room/snapshot` retorna projetos, tarefas, execucoes e logs persistidos.
- `GET /api/control-room/providers/status` consulta, sob demanda, saúde e capacidade dos provedores. A leitura do Codex usa somente métodos de conta de leitura do App Server; tokens de Antigravity são apenas os reportados por execuções locais.
- `GET /api/control-room/executions/:id` retorna a execução completa sob demanda: saída do agente, logs, arquivos atribuídos e histórico da tarefa. A tela usa a rota local `#/executions/:id` para esse detalhe.
- `POST /projects` e `POST /tasks` registram estado no nucleo. `POST /projects` aceita `isolation` (`worktree`, o padrão, ou `direct`).
- `POST /projects/:id/settings` recebe `{ "isolation": "worktree" | "direct" }` e vale para as próximas execuções. Uma tarefa que já tem worktree continua nela.
- `POST /tasks/:id/transition` aplica uma transicao valida.
- `POST /tasks/:id/execute` é uma ação explícita do operador. Aceita `{ "provider": "auto" | "<id registrado>" }`. `auto` compara os provedores ativos que participam do Automático e só escolhe quem tem autenticação confirmada; um id explícito nunca é trocado por outro provedor. Campos opcionais `model` e `sessionId` valem para provedores ACP. A resposta `202` confirma que a execução foi registrada; a conclusão chega pelo próximo snapshot.
- Tarefas em `waiting_approval` viram aprovacoes no painel. Aprovar as leva para `queued`; rejeitar as leva para `cancelled`.

A interface não inicia provedores automaticamente. O operador precisa clicar em **Executar**, selecionar o roteamento e confirmar. O executor registra a decisão, inicia uma única execução em segundo plano e encerra a tarefa como `completed` ou `failed` na mesma transação que atualiza a execução, a saída completa (a resposta do agente, preservada mesmo em falha, com uma linha em branco entre mensagens ACP distintas, e limitada a 100.000 caracteres incluindo o marcador de truncamento; o resumo, de até 4.000 caracteres, traz o motivo legível da falha), uso de tokens quando devolvido pelo provedor, o log e os arquivos atribuídos. Para Codex, Claude e Antigravity, o executor coleta o estado Git do escopo autorizado antes e depois da execução. A execução comum do Claude usa ACP; somente a revisão cruzada no terminal usa o modo textual restrito do `ClaudeAdapter`, sem acesso aos arquivos do checkout. Mudanças que já existiam são marcadas como preexistentes e falhas de coleta ficam como aviso no log. O endpoint de dispatch continua sujeito aos limites do domínio: `push`, `merge` e `deploy` são bloqueados.

Projetos usam `directories[]` no transporte. Cada item contém `name` opcional e `path` absoluto; o servidor devolve o ID, a ordem e a detecção de Git (incluindo metadata `.git` como arquivo de worktree). A UI permite adicionar, remover e reordenar entradas, e exige `targetDirectoryId` e `directoryIds` ao criar uma tarefa. O alvo precisa estar no escopo; diretórios repetidos ou de outro projeto são rejeitados. Escopos com mais de um diretório aparecem em `waiting_approval` até que o operador os mova para `queued`.

O host de produção cria o serviço com `createLocalControlRoomService(store, { worktreeRoot })`, apontando para `.eleazar/worktrees`. O executor pede `create_worktree` somente quando `isolatesTask` é verdadeiro: todo o escopo é Git e a tarefa ainda não rodou direto na pasta. A worktree pertence à tarefa, não à tentativa: `task_worktrees` guarda caminho, branch e commit base por diretório, e os turnos seguintes a reutilizam. Pastas comuns, ou o host iniciado com `ELEAZAR_CONTROL_ROOM_WORKTREES=off`, rodam no lugar com exclusão mútua persistida para qualquer interseção de `directoryIds`; nesse último caso `create_worktree` é recusada.

### Turnos, worktrees e ações de saída

- `POST /tasks/:id/messages` recebe `{ "prompt": "...", "provider"?, "model"? }` e inicia outro turno em uma tarefa `completed` ou `failed`. O claim é atômico a partir desse status, o turno grava a mensagem em `executions.prompt` e retoma a sessão ACP anterior do mesmo provedor quando `capabilities.loadSession` é verdadeiro. Sem provedor informado, usa o do turno anterior.
- `POST /tasks/:id/worktrees/remove` recebe `{}`, remove as worktrees da tarefa com `git worktree remove` (sem `--force`) e mantém a branch.
- `GET /tasks/:id/actions` lista as ações da tarefa; `POST /tasks/:id/actions` recebe `{ "kind": "commit" | "push" | "pull_request", "title"?, "body"? }` e só registra a ação como `pending`, com os alvos inspecionados (arquivos alterados, commits à frente do commit base, remoto sem credenciais).
- `POST /actions/:id/decision` recebe `{ "decision": "approve" | "reject" }`. A aprovação executa a ação no núcleo e grava `completed` ou `failed` com o resultado. Uma ação por tarefa pode estar pendente, nenhuma roda enquanto a tarefa tem `dispatchLease`, e ações `running` encontradas ao reiniciar o host viram `failed`.
- O snapshot inclui `actions` e cada tarefa traz `branch` (nulo no modo direto).

### Pull requests

O host lê o pull request da branch de cada tarefa com `gh pr view <branch> --json number,url,title,state,isDraft,reviewDecision,mergeable,statusCheckRollup` e guarda o último estado em `task_pull_requests`: estado, rascunho, decisão de revisão, conflito e a contagem de checks (com os nomes dos que falharam). A leitura nunca escreve no GitHub.

- `POST /tasks/:id/pull-requests/refresh` e `POST /pull-requests/refresh` recebem `{}` e devolvem `{ pullRequests, warnings }`. Falha de consulta (gh ausente, sem login, sem rede) vira aviso e preserva o último estado conhecido.
- A varredura geral só consulta tarefas com push ou pull request concluído pelo painel e ainda não mescladas nem fechadas. Ela roda a cada 60 s no host; `ELEAZAR_CONTROL_ROOM_PR_POLL_SECONDS` muda o intervalo (mínimo 15) e `0` desliga.
- Depois de um push ou pull request aprovado, o host relê o pull request da tarefa na mesma requisição.
- O botão **Atualizar** do painel também pede a varredura. O snapshot traz `pullRequests`, e a interface o relê a cada 15 s enquanto houver pull request aberto.

`PullRequestService` (`src/core/pull-requests.ts`) depende da porta `PullRequestInspector`; `GhPullRequestInspector` (`src/adapters/gh-pull-requests.ts`) é o adaptador do GitHub CLI.

`OutboundActionService` (`src/core/outbound-actions.ts`) é a camada de aprovação; `GitRepositoryPublisher` (`src/adapters/git-publisher.ts`) executa `git` e `gh` sem shell, com `GIT_TERMINAL_PROMPT=0`. O commit usa `git add --all` na worktree, portanto a lista de arquivos da prévia é o que entra no commit.

A execução comum do Codex usa o transporte ACP por stdio. `ELEAZAR_CODEX_PATH` pode apontar para um executável nativo do Codex; sem override, o adaptador procura a instalação desktop compatível e depois o binário da dependência ACP. Sem callback, o pedido de permissão é negado. O backend persiste eventos e permissões por execução, e a interface os apresenta por sessão.

A execução comum do Antigravity também usa ACP por stdio, com o servidor nativo `agy acp --sandbox` (sem ponte; `agy` 1.5 ou superior, verificado com a 1.5.9). O adaptador procura a instalação padrão do usuário e depois o `PATH`, exige o modo `default` e, quando o `agy` pede permissão, nega edições fora do escopo ou sem localização informada. **Limitação conhecida:** em testes reais com a 1.5.9, o `agy` pediu permissão para editar dentro de `.eleazar` (onde ficam as worktrees das tarefas), mas editou sem pedir em pastas dentro do diretório temporário do sistema, com e sem `--sandbox`. As configurações do próprio `agy` não são sobrescritas. O turno segue os mesmos limites dos demais provedores ACP (veja **Limite de tempo do turno**). O diagnóstico não abre sessão. O login Google é confirmado por **Verificar conexão** ou pelo roteador: a resposta de `session/new` do agy 1.5.9 traz o plano da conta em `_meta.antigravity.tier`, e só a presença desse campo conta como prova de login.

Ao retomar uma sessão com `session/load`, o protocolo manda o agente reemitir a conversa anterior antes de responder ao load ([session-setup, protocolo v1](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx)). O cliente ACP compartilhado (Codex e Claude) só considera "da execução atual" o que chega durante a janela do turno: ela abre imediatamente antes do `session/prompt` e fecha quando ele termina (com sucesso ou erro), ou antes do cancelamento e da limpeza em caso de timeout, abort ou saída do processo. Fora da janela, mensagens, ferramentas e `usage_update` não entram na resposta nem nos eventos persistidos, e qualquer pedido de permissão é cancelado sem acionar o executor; o agente mantém o contexto anterior no servidor. Atualizações de configuração continuam alimentando a confirmação do modo em qualquer fase. O texto recebido antes de uma falha do turno continua como saída parcial. O `usage` informado no fim do turno não é alterado.

### Limite de tempo do turno

O cliente ACP compartilhado encerra o turno por dois limites, lidos do ambiente do host: o teto total (`ELEAZAR_AGENT_TURN_TIMEOUT_MINUTES`, padrão 60) e a inatividade (`ELEAZAR_AGENT_IDLE_TIMEOUT_MINUTES`, padrão 10); `0` desliga cada um. Conta como atividade qualquer notificação ACP e qualquer saída de erro do processo do agente. A inatividade fica pausada enquanto há uma chamada de ferramenta iniciada e não concluída (um comando longo não reporta nada até terminar) e enquanto uma permissão espera o operador. O motivo do encerramento informa qual limite estourou. A verificação de conexão continua com 45 s. Antes, todo turno tinha um limite fixo de 5 minutos (16 no Antigravity), que estourava em repositórios grandes. A coleta Git em volta da execução também passou de 5 s para 60 s por comando.

### Interface de sessão ACP

`#/tasks/:id` e `#/executions/:id` compartilham o componente de sessão: a conversa com o agente em ordem cronológica (mensagens em Markdown conforme chegam, intercaladas com as chamadas de ferramenta), o plano mais recente quando o agente publica um, estado da conexão (com reconexão pelo último `Last-Event-ID`, sem duplicar texto), botões de permissão com título e caminhos, e cancelamento enquanto a execução está ativa. Durante o turno, a conversa acompanha o texto novo até o operador rolar para cima; **Ir para o fim** volta a acompanhar. Em `#/tasks/:id`, **Turnos anteriores** lista os turnos já encerrados e carrega a conversa de cada um quando aberta. Do texto do agente, só `payload.text` é exibido; pensamento do agente não é gravado nem exibido. O evento `plan` guarda até 50 itens de 500 caracteres, só com texto e estado. Execuções legadas sem eventos mostram `output` ou `summary`. Uma permissão ACP pendente aparece em `#/approvals` como link para a sessão, separada da aprovação de escopo (execução em andamento com `dispatchLease` ativo).

No diálogo **Executar**, a lista vem dos provedores registrados e ativos, e todos usam o mesmo fluxo: a UI consulta o catálogo do diretório-alvo da tarefa, mostra o modelo padrão anunciado e a versão e origem do runtime, e só envia um `model` presente no catálogo. Falha de catálogo fica visível e a execução segue com o padrão do provedor. Trocar o provedor descarta o modelo escolhido, e respostas de catálogo atrasadas são ignoradas. A retomada de sessão é opcional, vem desmarcada e só é oferecida quando há uma execução anterior do mesmo provedor ACP, projeto e escopo **e** o catálogo carregado declara `capabilities.loadSession: true`. Se o campo faltar, for `false` ou o catálogo falhar, a opção não aparece. Mesmo oferecida, a API ainda valida a sessão e pode recusar a retomada; a recusa aparece no diálogo.

O Claude usa a ponte ACP `@agentclientprotocol/claude-agent-acp` `0.107.0` e o CLI nativo autenticado, preferindo `~/.local/bin/claude` (`claude.exe` no Windows) antes do `PATH`. A ponte exige Node.js 22 ou superior. O cliente força o modo manual `default`, desativa a herança de configurações de ferramentas do usuário e do projeto e recusa bypass. Expõe somente `Read`, `Glob`, `Grep`, `Edit` e `Write`; não expõe `Bash`, terminal, ferramentas web ou MCP. As regras de arquivos do SDK bloqueiam leituras e escritas fora dos diretórios de trabalho em todos os modos, independentemente do sandbox de shell. Edição e escrita pedem confirmação, e caminhos fora do escopo autorizado são recusados antes de chegar à interface. O sandbox de shell não é exigido neste modo de arquivos; esses limites não equivalem ao sandbox `workspace-write` do Codex.

`GET /api/control-room/providers/:provider/config?directoryId=...` (qualquer provedor ACP registrado) consulta o catálogo de modelos e configurações sem enviar prompt, com cache breve por diretório. A resposta contém `runtime.path/version/source`, `protocolVersion`, `settings`, `models`, `defaultModel` e `capabilities.loadSession` booleano. O cliente usa `getProviderConfig(provider, directoryId)`; `getCodexConfig` e a rota `/providers/codex/config` continuam compatíveis. `POST /tasks/:id/execute` aceita `model` e `sessionId` opcionais para provedores ACP; o modelo deve estar anunciado e a sessão anterior deve pertencer ao mesmo provedor, projeto e escopo. `GET /executions/:id/events` transmite SSE ordenado com replay por `Last-Event-ID`. `POST /executions/:id/permissions/:permissionId` recebe `{ "optionId": "..." }`; `POST /executions/:id/cancel` recebe `{}`. Permissões ACP pausam a execução no mesmo lease e são distintas da aprovação inicial de escopo. Reiniciar o host marca execuções em andamento como falhas e invalida permissões pendentes; a tarefa pode ser retomada com `POST /tasks/:id/resume`.

O adaptador força `workspace-write`, `on-request` e rede de ferramentas desabilitada, sem expor modo full access. `allow_always` e pedidos com indicação explícita de ampliação de raiz, rede ou sandbox são recusados; `allow_once` exige resposta do operador. O sandbox do Codex é o limite efetivo para ações de ferramenta: metadados ACP podem não descrever todos os efeitos de um comando, então o bloqueio de push, merge, deploy e publicação no texto da tarefa e na decisão de despacho não substitui inspeção de cada comando executado.

### Provedores

`ProviderRegistry` (`src/core/provider-registry.ts`) é a única lista de provedores. Cada registro junta um descritor (id, rótulo, transporte, papéis, afinidade, comando de login) e um `AgentAdapter`. Roteador, executor, rotas e interface leem o registro. Codex, Claude e Antigravity estão em `src/adapters/built-in-providers.ts`; `AcpAgentAdapter` dá a qualquer um deles a verificação de conexão e o catálogo.

- `GET /providers/status` devolve, por provedor, saúde, executável e origem, login, última verificação, preferências e uso.
- `POST /providers/:id/verify` recebe `{}`, abre e fecha uma sessão em uma pasta temporária vazia, sem prompt, e devolve a lista atualizada com os modelos anunciados. Login confirmado vale por 10 minutos para o mesmo executável e versão; qualquer outro resultado é refeito depois de 30 segundos, e um turno que falha descarta a confirmação.
- `POST /providers/:id/settings` recebe `enabled`, `automatic`, `executablePath` e `defaultModel` (os dois últimos aceitam `null`). O executável precisa ser um caminho local absoluto, existir e ter o nome do programa do provedor. O modelo precisa ter sido anunciado na última verificação. As escolhas ficam em `provider_settings`, sem segredos.
- O modelo padrão só vale para sessões novas e enquanto o provedor o anunciar.
- `POST /tasks/:id/dispatch` não aceita provedor: só `execute` confirma o login.

A CLI (`plan`, `run`, `doctor`) lê as mesmas preferências e o mesmo `.eleazar/providers.json` da pasta atual, sem gravar no banco.

Campos de `.eleazar/providers.json`: `id`, `label`, `executable` (comando do PATH ou caminho absoluto), `requiredMode`, `loginCommand` e `loginHint` são obrigatórios. Opcionais: `args`, `versionArgs` (padrão `["--version"]`), `minimumVersion`, `affinity` (0 a 100 por tipo de tarefa), `roles` e `sessionConfirmsLogin`. Use `sessionConfirmsLogin: true` somente para agentes que recusam `session/new` sem login; sem ele o login fica não confirmado e o agente só roda por escolha explícita. Entradas inválidas são ignoradas com aviso no terminal do host.

### Explorador de arquivos

`#/tasks/:id/files` abre o explorador da tarefa (botão **Explorar arquivos** na tarefa e no resultado da execução; cada arquivo afetado no resultado abre direto o seu diff). Ele mostra a pasta em que o agente trabalha: a worktree da tarefa ou, no modo **Direto na pasta**, a própria pasta do projeto. A aba **Alterações** lista o que mudou com contagem de linhas; **Todos os arquivos** navega a árvore completa sob demanda (uma pasta por vez, até 2.000 itens por pasta, sem `.git`). O arquivo abre em **Diff** (com números de linha antigos e novos) ou **Conteúdo**. Enquanto a tarefa roda, a lista e o arquivo aberto são relidos a cada 5 s.

A comparação é feita contra o commit em que a branch da tarefa começou (`task_worktrees.baseCommit`), então continua visível depois do commit pelo painel; no modo direto, contra o `HEAD`, o que inclui alterações que já existiam antes da tarefa; essas aparecem marcadas como "já alterado antes da tarefa", a partir do que a primeira execução registrou como preexistente. Arquivos novos não rastreados aparecem como **U**, e arquivos removidos continuam na árvore para que o diff possa ser aberto. Pastas sem Git são exploradas normalmente, sem diff. Tudo é local e somente leitura (Git, Gogs ou qualquer remoto: nada é consultado fora da máquina).

- `GET /tasks/:id/files/roots` devolve, por diretório do escopo, o caminho efetivo, o modo (`worktree` ou `direct`), a branch e a base.
- `GET /tasks/:id/files?directoryId=…&path=…` lista uma pasta, com a alteração de cada arquivo e quantos arquivos mudaram abaixo de cada subpasta.
- `GET /tasks/:id/changes?directoryId=…` devolve as alterações (`added`, `modified`, `deleted`, `renamed`, `untracked`) com linhas adicionadas e removidas.
- `GET /tasks/:id/files/search?directoryId=…&q=…` procura pelo nome ou trecho do caminho no projeto inteiro (arquivos do Git mais os não rastreados e não ignorados; em pastas sem Git, uma varredura que pula `node_modules`, `dist`, `build` e similares), com até 200 resultados, nomes que contêm o termo primeiro.
- `GET /tasks/:id/files/content?directoryId=…&path=…` devolve o texto (até 512 KB; binários não são enviados) e o diff unificado (até 400.000 caracteres).

O caminho é sempre relativo à pasta da tarefa, aceita `/` ou `\`, e é recusado se tiver `..`, for absoluto, apontar para `.git` ou, por link simbólico ou junção, sair da pasta. O Git roda sem shell, com `core.longpaths` no Windows e limite de 60 s por comando, e o estado é guardado por 2 s para que expandir várias pastas seguidas não repita o `git status` em repositórios grandes.

### Quadro de tarefas

Em `#/tasks`, o alternador **Quadro | Lista** (lembrado em `localStorage`, padrão Quadro) troca a tabela por um quadro de seis raias. Ninguém move cartões: `placeTask` (`apps/control-room/src/services/board.ts`) decide a raia a partir do snapshot.

- **Na fila**: tarefa `queued`.
- **Trabalhando**: `planning` ou `running`.
- **Precisa de você**: permissão ACP ou aprovação de escopo pendente, execução com falha, e commit, push ou pull request aguardando aprovação ou que falhou.
- **Para revisar**: turno concluído sem pull request, ou pull request fechado sem merge.
- **Em revisão**: pull request aberto em rascunho, com checks em execução ou com revisão pendente.
- **Pronto para merge**: pull request aprovado com os checks verdes; em repositórios sem revisão obrigatória, bastam os checks verdes.

Com pull request aberto, CI com falha, conflito de merge e alterações solicitadas levam o cartão para **Precisa de você**. Pull request mesclado vai para o Arquivo. Quando a tarefa tem pull requests em vários repositórios, vale o mais urgente. O merge continua manual: o cartão e o painel Publicação abrem o pull request no GitHub.

Tarefas canceladas ficam no **Arquivo**, recolhido abaixo do quadro. Cada cartão mostra o agente, o título, a branch da tarefa (ou a pasta, no modo direto), o fato que definiu a raia e há quanto tempo. A barra lateral lista os projetos com as tarefas ativas de cada um, marcadas com a cor da raia.

Os ícones em `apps/control-room/src/assets/icons` (marca do Eleazar e glifos dos agentes) são SVGs próprios; os glifos são genéricos e não reproduzem logotipos dos provedores.

### Navegação da tarefa e "Precisa de você"

- Cada tarefa tem três abas, cada uma com rota própria: **Conversa** (`#/tasks/:id`), **Arquivos** (`#/tasks/:id/files`) e **Publicação** (`#/tasks/:id/publish`, commit, push e pull request).
- `#/inbox` reúne tudo o que espera o operador em todos os projetos (permissão do agente, publicação, escopo, falha, pull request), a partir dos mesmos fatos da raia **Precisa de você**; o menu mostra a contagem e a visão geral, os primeiros itens.
- Atalhos (`?` lista todos): `N` nova tarefa, `/` ou `Ctrl K` busca, `G` + `I/O/T/E/P/V` para as telas, `1`/`2`/`3` para as abas da tarefa. Teclas simples não agem dentro de campos de texto.
- Notificações do navegador são opcionais (botão na barra lateral ou na paleta). Com a aba em segundo plano, avisam quando algo novo passa a precisar do operador ou quando um turno termina.

### Comparação entre agentes

- `POST /comparisons` recebe os campos de `POST /tasks` mais `providers` (dois ou três ids) e responde `202` com `{ comparisonId, tasks, errors }`. Cria uma tarefa por agente com o mesmo `comparisonId`, cada uma na própria branch e worktree, e inicia uma depois da outra. Exige repositório Git com worktree por tarefa e um único diretório; uma tentativa que não começa fica na fila e aparece em `errors`.
- `GET /comparisons/:id` lista as tentativas; `POST /comparisons/:id/choose` recebe `{ "taskId": "..." }` e cancela as outras tentativas já encerradas, mantendo as branches. Por isso uma tarefa `completed` pode passar a `cancelled`.
- A tela `#/comparisons/:id` mostra o resumo de cada agente, a tabela de arquivos alterados por tentativa e, para o arquivo escolhido, os diffs lado a lado.

### Cota e Automático

- `POST /providers/:id/settings` também aceita `dailyTokenBudget` (inteiro positivo ou `null`), salvo em `provider_settings.daily_token_budget`.
- `usage.quota` em `GET /providers/status` traz `{ usedPercent, source, dailyTokenBudget, todayTokens, state }`: o limite da conta quando o provedor o informa (Codex), ou os tokens das execuções encerradas hoje contra o orçamento, valendo o mais apertado.
- O roteador lê a cota sem abrir processos: a partir de 80% o provedor perde 40 pontos e, com 100%, o Automático deixa de escolhê-lo. A escolha explícita de um provedor continua valendo.

### Retomada e modelos

- `POST /tasks/:id/resume` recebe `{}` e continua uma tarefa `failed` (inclusive a interrompida por reinício do host) com o mesmo provedor. Com `capabilities.loadSession`, a sessão ACP anterior é recarregada e a mensagem é curta; sem ela, a mensagem leva o pedido original e o que foi gravado do turno perdido: a mensagem que o iniciou, o plano, as últimas ferramentas e as últimas falas do agente.
- `GET /templates`, `POST /templates` (`{ name, prompt, title?, kind?, priority?, projectId? }`) e `POST /templates/:id/delete` mantêm os modelos de tarefa em `task_templates`. No editor, "Começar de um modelo" preenche os campos e "Salvar como modelo" guarda o pedido atual.

## Limite de rede

A API escuta exclusivamente em `127.0.0.1`. Ela exige conexão e Host loopback. Quando o navegador envia `Origin`, a API aceita a origem do próprio endpoint ou a interface em `http://127.0.0.1:5173` e `http://localhost:5173`. A prévia do Vite usa os mesmos hosts na porta `4173`. Clientes locais podem fazer requisições sem `Origin`. Mutações exigem `Content-Type: application/json`.

## Verificacao

```powershell
npm run check
npm run check --prefix apps/control-room
```

As fixtures existentes ficam apenas nos testes. A aplicacao de producao usa `createHttpControlRoomClient`; nao ha dados, textos ou cliente de demonstracao em memoria.
