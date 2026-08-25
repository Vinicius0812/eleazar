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

## Proximos marcos

1. Persistir tarefas, execucoes e metricas em SQLite.
2. Emitir eventos de progresso em streaming.
3. Criar worktrees isoladas por execucao.
4. Adicionar revisao cruzada e fallback seguro.
5. Expor uma API local e um painel visual.
