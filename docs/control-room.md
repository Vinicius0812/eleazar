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
- `POST /projects` e `POST /tasks` registram estado no nucleo.
- `POST /tasks/:id/transition` aplica uma transicao valida.
- `POST /tasks/:id/execute` é uma ação explícita do operador. Aceita `{ "provider": "auto" | "codex" | "antigravity" | "claude" }`. Claude requer seleção explícita e autenticação confirmada; `auto` não o escolhe. Campos opcionais `model` e `sessionId` valem para provedores ACP (Codex e Claude). A resposta `202` confirma que a execução foi registrada; a conclusão chega pelo próximo snapshot.
- Tarefas em `waiting_approval` viram aprovacoes no painel. Aprovar as leva para `queued`; rejeitar as leva para `cancelled`.

A interface não inicia provedores automaticamente. O operador precisa clicar em **Executar**, selecionar o roteamento e confirmar. O executor registra a decisão, inicia uma única execução em segundo plano e encerra a tarefa como `completed` ou `failed` na mesma transação que atualiza a execução, a saída completa (limitada a 100.000 caracteres), uso de tokens quando devolvido pelo provedor, o log e os arquivos atribuídos. Para Codex, Claude e Antigravity, o executor coleta o estado Git do escopo autorizado antes e depois da execução. A execução comum do Claude usa ACP; somente a revisão cruzada no terminal usa o modo textual restrito do `ClaudeAdapter`, sem acesso aos arquivos do checkout. Mudanças que já existiam são marcadas como preexistentes e falhas de coleta ficam como aviso no log. O endpoint de dispatch continua sujeito aos limites do domínio: `push`, `merge` e `deploy` são bloqueados.

Projetos usam `directories[]` no transporte. Cada item contém `name` opcional e `path` absoluto; o servidor devolve o ID, a ordem e a detecção de Git (incluindo metadata `.git` como arquivo de worktree). A UI permite adicionar, remover e reordenar entradas, e exige `targetDirectoryId` e `directoryIds` ao criar uma tarefa. O alvo precisa estar no escopo; diretórios repetidos ou de outro projeto são rejeitados. Escopos com mais de um diretório aparecem em `waiting_approval` até que o operador os mova para `queued`.

O host de produção do Control Room cria `ControlRoomService` com `{ useWorktrees: false }` e sem provisionador Git. Nesse modo, a API não deve enviar `create_worktree`: o núcleo recusa a solicitação e aplica exclusão mútua persistida para qualquer interseção de `directoryIds`.

A execução comum do Codex usa o transporte ACP por stdio. `ELEAZAR_CODEX_PATH` pode apontar para um executável nativo do Codex; sem override, o adaptador procura a instalação desktop compatível e depois o binário da dependência ACP. Sem callback, o pedido de permissão é negado. O backend persiste eventos e permissões por execução, e a interface os apresenta por sessão. O Antigravity 1.2.7 permanece no transporte legado; seu ACP ainda não está implementado.

### Interface de sessão ACP

`#/tasks/:id` e `#/executions/:id` compartilham o componente de sessão: mensagem original, texto do agente em Markdown conforme chega, atividade de ferramentas, estado da conexão (com reconexão pelo último `Last-Event-ID`, sem duplicar texto), botões de permissão com título e caminhos, e cancelamento enquanto a execução está ativa. Só `payload.text` é exibido; pensamento do agente não. Execuções legadas sem eventos mostram `output` ou `summary`. Uma permissão ACP pendente aparece em `#/approvals` como link para a sessão, separada da aprovação de escopo (execução em andamento com `dispatchLease` ativo).

No diálogo **Executar**, Codex e Claude Code usam o mesmo fluxo: a UI consulta o catálogo do diretório-alvo da tarefa, mostra o modelo padrão anunciado e a versão e origem do runtime, e só envia um `model` presente no catálogo. Falha de catálogo fica visível e a execução segue com o padrão do provedor. Trocar o provedor descarta o modelo escolhido, e respostas de catálogo atrasadas são ignoradas. A retomada de sessão é opcional, vem desmarcada e só é oferecida quando há uma execução anterior do mesmo provedor ACP, projeto e escopo **e** o catálogo carregado declara `capabilities.loadSession: true`. Se o campo faltar, for `false` ou o catálogo falhar, a opção não aparece. Mesmo oferecida, a API ainda valida a sessão e pode recusar a retomada; a recusa aparece no diálogo.

O Claude usa a ponte ACP `@agentclientprotocol/claude-agent-acp` `0.107.0` e o CLI nativo autenticado, preferindo `~/.local/bin/claude` (`claude.exe` no Windows) antes do `PATH`. A ponte exige Node.js 22 ou superior. O cliente força o modo manual `default`, desativa a herança de configurações de ferramentas do usuário e do projeto e recusa bypass. Expõe somente `Read`, `Glob`, `Grep`, `Edit` e `Write`; não expõe `Bash`, terminal, ferramentas web ou MCP. As regras de arquivos do SDK bloqueiam leituras e escritas fora dos diretórios de trabalho em todos os modos, independentemente do sandbox de shell. Edição e escrita pedem confirmação, e caminhos fora do escopo autorizado são recusados antes de chegar à interface. O sandbox de shell não é exigido neste modo de arquivos; esses limites não equivalem ao sandbox `workspace-write` do Codex.

`GET /api/control-room/providers/:provider/config?directoryId=...` (`codex` ou `claude`) consulta o catálogo de modelos e configurações sem enviar prompt, com cache breve por diretório. A resposta contém `runtime.path/version/source`, `protocolVersion`, `settings`, `models`, `defaultModel` e `capabilities.loadSession` booleano. O cliente usa `getProviderConfig(provider, directoryId)`; `getCodexConfig` e a rota `/providers/codex/config` continuam compatíveis. `POST /tasks/:id/execute` aceita `model` e `sessionId` opcionais para provedores ACP; o modelo deve estar anunciado e a sessão anterior deve pertencer ao mesmo provedor, projeto e escopo. `GET /executions/:id/events` transmite SSE ordenado com replay por `Last-Event-ID`. `POST /executions/:id/permissions/:permissionId` recebe `{ "optionId": "..." }`; `POST /executions/:id/cancel` recebe `{}`. Permissões ACP pausam a execução no mesmo lease e são distintas da aprovação inicial de escopo. Reiniciar o host marca execuções em andamento como falhas, invalida permissões pendentes e exige retry manual.

O adaptador força `workspace-write`, `on-request` e rede de ferramentas desabilitada, sem expor modo full access. `allow_always` e pedidos com indicação explícita de ampliação de raiz, rede ou sandbox são recusados; `allow_once` exige resposta do operador. O sandbox do Codex é o limite efetivo para ações de ferramenta: metadados ACP podem não descrever todos os efeitos de um comando, então o bloqueio de push, merge, deploy e publicação no texto da tarefa e na decisão de despacho não substitui inspeção de cada comando executado.

## Limite de rede

A API escuta exclusivamente em `127.0.0.1`. Ela exige conexão e Host loopback. Quando o navegador envia `Origin`, a API aceita a origem do próprio endpoint ou a interface em `http://127.0.0.1:5173` e `http://localhost:5173`. A prévia do Vite usa os mesmos hosts na porta `4173`. Clientes locais podem fazer requisições sem `Origin`. Mutações exigem `Content-Type: application/json`.

## Verificacao

```powershell
npm run check
npm run check --prefix apps/control-room
```

As fixtures existentes ficam apenas nos testes. A aplicacao de producao usa `createHttpControlRoomClient`; nao ha dados, textos ou cliente de demonstracao em memoria.
