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

Claude exige seleção explícita na CLI e na Control Room. No painel, qualquer tipo de tarefa pode selecioná-lo ao confirmar a execução, no escopo aprovado da tarefa. O título e a solicitação são enviados ao provedor, e os pedidos de permissão aparecem na sessão e esperam a decisão do operador. O modo **Automático** nunca escolhe o Claude por conta própria. A **revisão cruzada** continua usando o modo textual restrito do `ClaudeAdapter`, sem ferramentas nem acesso ao checkout.

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

Defina `ELEAZAR_CONTROL_ROOM_WORKTREES=off` antes de `npm run control-room` para rodar sempre direto na pasta.

### Continuar a mesma tarefa

Quando um turno termina (`completed` ou `failed`), a tela da tarefa mostra **Nova mensagem para o agente**. O novo turno roda na mesma pasta ou worktree. Com Codex e Claude Code, a sessão ACP anterior é retomada quando o agente anuncia suporte; caso contrário o pedido original segue junto com a nova mensagem.

### Commit, push e pull request com aprovação

Tarefas com branch própria mostram o painel **Publicação**. Cada ação tem duas etapas: você a solicita, o painel registra exatamente o que será feito (arquivos, branch, remoto) e nada roda até **Aprovar e executar**. O commit e o push usam o seu `git`; o pull request usa o `gh`. O Eleazar não lê tokens e remove credenciais embutidas em URLs antes de exibir ou gravar. O agente continua proibido de fazer push, e merge e deploy não são oferecidos. **Remover worktree** apaga a pasta isolada e mantém a branch; o Git recusa se houver trabalho sem commit.

### Quadro e pull requests

A fila de tarefas abre como um quadro em que cada tarefa se posiciona sozinha: Na fila, Trabalhando, Precisa de você, Para revisar, Em revisão e Pronto para merge. Depois que a branch é enviada, o host consulta o pull request com o `gh` a cada 60 s e o cartão acompanha CI, conflitos e revisões. O merge é sempre seu, no GitHub. Detalhes em [docs/control-room.md](docs/control-room.md).

## Seguranca

- O Eleazar nunca tenta extrair credenciais dos provedores.
- O adaptador Antigravity inicia `agy acp --sandbox` no modo `default` e nunca usa `--dangerously-skip-permissions`. **Limitacao conhecida:** em um teste real com a 1.5.9, o `agy` editou um arquivo da pasta de trabalho nesse modo sem pedir permissao; a causa ainda nao foi identificada. Prefira executar o Antigravity em worktree isolada.
- O roteador nao envia uma tarefa a um provedor explicitamente nao autenticado.
- Commit, push e pull request so rodam depois da aprovacao explicita do operador no painel Publicacao. Merge, deploy e comandos destrutivos nao sao executados pelo Control Room.
