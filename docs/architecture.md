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
        +-------> CodexAdapter -------> @openai/codex-sdk
        |
        +-------> AntigravityAdapter -> agy --output-format json
```

## Responsabilidades

### Orchestrator

Coordena uma execucao e mantem a interface publica independente dos provedores. Neste primeiro marco ele executa um unico agente por tarefa.

### Router

Classifica a tarefa com regras deterministicas e pontua cada provedor. Provedores ausentes ou explicitamente nao autenticados sao removidos da selecao.

O roteamento deterministico e intencional no inicio: ele e barato, auditavel e pode ser testado sem consumir creditos. Telemetria e avaliacao historica poderao ajustar as pontuacoes no futuro.

### Adapters

Traduzem o contrato interno para a interface oficial de cada agente:

- Codex: SDK TypeScript oficial, com threads locais retomaveis.
- Antigravity: CLI headless com envelope JSON e sandbox habilitado.

### Credenciais

Eleazar nao possui um cofre de senhas. Cada adaptador depende da autenticacao oficial do seu CLI/SDK e retorna somente o estado necessario para diagnostico.

## Control Room e projetos compostos

```text
React (DTO JSON sem Node/SQLite)
        |
        | POST /projects { name, directories[] }
        | POST /tasks { projectId, targetDirectoryId, ... }
        v
API loopback
        v
ControlRoomService (validação, seleção e política)
        v
SQLite: projects -> project_directories <- tasks.target_directory_id
```

`project_directories` é uma lista ordenada e contém `id`, `name`, `path`, `createdAt` e `isGitRepository`. A tabela é criada e recebe um diretório sintético para cada projeto legado que só possui `projects.path`; tarefas legadas são então vinculadas a esse diretório. O campo `projects.path` permanece como diretório principal apenas para compatibilidade.

Cada tarefa v1 tem um único `targetDirectoryId`. Isso torna explícito que um projeto com vários checkouts não significa que toda tarefa tocará todos eles. Caso o domínio passe a aceitar vários alvos numa tarefa, esse escopo composto deve transicionar para `waiting_approval` antes de qualquer claim de despacho.

No modo `useWorktrees: false`, o núcleo não invoca nem precisa de `GitWorktreeProvisioner`. O claim SQLite funciona como lock por `targetDirectoryId`: duas tarefas diretas não podem ficar em `planning` ou `running` no mesmo checkout, enquanto diretórios diferentes podem continuar em paralelo. A opção com worktree continua isolando a execução e não ocupa esse lock direto.

## Proximos marcos

1. Persistir tarefas, execucoes e metricas em SQLite.
2. Emitir eventos de progresso em streaming.
3. Criar worktrees isoladas por execucao.
4. Adicionar revisao cruzada e fallback seguro.
5. Expor uma API local e um painel visual.
