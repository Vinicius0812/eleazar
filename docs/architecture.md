# Arquitetura inicial

## Fluxo

```text
CLI / futura interface
        |
        v
   Orchestrator
        |
        v
      Router ----> diagnostico e pontuacao
        |
  ProviderRegistry ----> descritor + AgentAdapter de cada provedor
        |
        +-------> Codex, Claude Code, Antigravity -> ACP
        |
        +-------> agentes de .eleazar/providers.json -> ACP, politica generica
```

## Responsabilidades

### Orchestrator

Coordena uma execucao e mantem a interface publica independente dos provedores. Neste primeiro marco ele executa um unico agente por tarefa.

### Router

Classifica a tarefa com regras deterministicas e pontua cada provedor. A afinidade vem do descritor de cada provedor. O Automatico so escolhe provedores ativos com autenticacao confirmada, e uma escolha explicita nunca e trocada por outro provedor.

O roteamento deterministico e intencional no inicio: ele e barato, auditavel e pode ser testado sem consumir creditos. Telemetria e avaliacao historica poderao ajustar as pontuacoes no futuro.

### Adapters

Traduzem o contrato interno para a interface oficial de cada agente:

- Codex: ponte ACP oficial sobre o Codex nativo; o SDK fica restrito a revisao cruzada.
- Claude Code: ponte ACP sobre o CLI nativo, so com ferramentas de arquivo.
- Antigravity: servidor ACP nativo do CLI (`agy acp`), com sandbox habilitado e modo `default`.

### Credenciais

Eleazar nao possui um cofre de senhas. Cada adaptador depende da autenticacao oficial do seu CLI/SDK e retorna somente o estado necessario para diagnostico.

## Control Room e projetos compostos

```text
React (DTO JSON sem Node/SQLite)
        |
        | POST /projects { name, directories[] }
        | POST /tasks { projectId, targetDirectoryId, directoryIds, ... }
        v
API loopback
        v
ControlRoomService (validação, seleção e política)
        v
SQLite: projects -> project_directories <- tasks.target_directory_id
```

`project_directories` é uma lista ordenada e contém `id`, `name`, `path`, `createdAt` e `isGitRepository`. `task_directory_scopes` persiste a lista ordenada dos diretórios afetados por cada tarefa. As migrações criam um diretório sintético para cada projeto legado que só possui `projects.path` e vinculam cada tarefa antiga a um escopo de um diretório. O campo `projects.path` permanece como diretório principal apenas para compatibilidade.

Cada tarefa declara um `targetDirectoryId` principal e uma lista `directoryIds` que sempre o inclui. Isso torna explícito que um projeto com vários checkouts não significa que toda tarefa tocará todos eles. Um escopo com mais de um diretório nasce em `waiting_approval`; o operador aprova a transição para `queued` antes de qualquer claim de despacho.

O host local isola em worktree as tarefas cujo escopo inteiro é Git: `GitWorktreeProvisioner` cria uma branch por tarefa e uma worktree por diretório sob `.eleazar/worktrees`, reutilizadas por todos os turnos da tarefa. Pastas comuns rodam no lugar. O claim SQLite funciona como lock por interseção de escopo apenas para tarefas diretas: duas delas não podem ficar em `planning` ou `running` se compartilharem qualquer diretório. Tarefas em worktree não ocupam esse lock.

Uma tarefa tem vários turnos: cada mensagem de continuação gera uma execução nova a partir de `completed` ou `failed`. Commit, push e pull request passam por `OutboundActionService`, que só executa uma ação registrada depois da aprovação do operador.

## Proximos marcos

1. Persistir tarefas, execucoes e metricas em SQLite.
2. Emitir eventos de progresso em streaming.
3. Criar worktrees isoladas por execucao.
4. Adicionar revisao cruzada e fallback seguro.
5. Expor uma API local e um painel visual.
