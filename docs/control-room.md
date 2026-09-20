# Eleazar Control Room

O Control Room e uma interface React + Vite que consome o estado autoritativo do nucleo Eleazar por HTTP local. Ela nao contem banco, acesso a arquivos, SDK de provedor ou codigo Node no bundle do navegador.

## Inicializacao

Na raiz do repositorio:

```powershell
npm ci
npm ci --prefix apps/control-room
npm run control-room
```

O comando inicia a API em `127.0.0.1:4317` e o Vite em `127.0.0.1:5173`. A porta da API pode ser alterada somente no host local por `ELEAZAR_CONTROL_ROOM_PORT`; quando ela for alterada, ajuste a configuracao do cliente antes de abrir a UI.

## Contratos e fluxo

`src/core/control-room.ts` e a fonte dos contratos de dominio. `apps/control-room/src/services/contracts.ts` e um espelho de transporte JSON: preserva estados (`queued`, `planning`, `running`, `waiting_approval`, `completed`, `failed`, `cancelled`) e prioridades (`low`, `normal`, `high`, `critical`), sem importar codigo do host no navegador.

O cliente HTTP usa um snapshot consistente para leitura e mutacoes confirmadas pelo servidor:

- `GET /api/control-room/snapshot` retorna projetos, tarefas, execucoes e logs persistidos.
- `GET /api/control-room/providers/status` consulta, sob demanda, saúde e capacidade dos provedores. A leitura do Codex usa somente métodos de conta de leitura do App Server; tokens de Antigravity são apenas os reportados por execuções locais.
- `GET /api/control-room/executions/:id` retorna a execução completa sob demanda: saída do agente, logs, arquivos atribuídos e histórico da tarefa. A tela usa a rota local `#/executions/:id` para esse detalhe.
- `POST /projects` e `POST /tasks` registram estado no nucleo.
- `POST /tasks/:id/transition` aplica uma transicao valida.
- `POST /tasks/:id/execute` é uma ação explícita do operador. Aceita `{ "provider": "auto" | "codex" | "antigravity" }`, verifica o roteamento e inicia o provedor no diretório-alvo. A resposta `202` confirma que a execução foi registrada; a conclusão chega pelo próximo snapshot.
- Tarefas em `waiting_approval` viram aprovacoes no painel. Aprovar as leva para `queued`; rejeitar as leva para `cancelled`.

A interface não inicia provedores automaticamente. O operador precisa clicar em **Executar**, selecionar o roteamento e confirmar. O executor registra a decisão, inicia uma única execução em segundo plano e encerra a tarefa como `completed` ou `failed` na mesma transação que atualiza a execução, a saída completa (limitada a 100.000 caracteres), uso de tokens quando devolvido pelo provedor, o log e os arquivos atribuídos. Antes e depois da chamada ao provedor, o executor coleta apenas o estado Git do escopo autorizado; mudanças que já existiam são marcadas como preexistentes e falhas de coleta ficam como aviso no log, sem falhar a tarefa. O endpoint de dispatch continua sujeito aos limites do domínio: `push`, `merge` e `deploy` são bloqueados.

Projetos usam `directories[]` no transporte. Cada item contém `name` opcional e `path` absoluto; o servidor devolve o ID, a ordem e a detecção de Git (incluindo metadata `.git` como arquivo de worktree). A UI permite adicionar, remover e reordenar entradas, e exige `targetDirectoryId` e `directoryIds` ao criar uma tarefa. O alvo precisa estar no escopo; diretórios repetidos ou de outro projeto são rejeitados. Escopos com mais de um diretório aparecem em `waiting_approval` até que o operador os mova para `queued`.

O host de produção do Control Room cria `ControlRoomService` com `{ useWorktrees: false }` e sem provisionador Git. Nesse modo, a API não deve enviar `create_worktree`: o núcleo recusa a solicitação e aplica exclusão mútua persistida para qualquer interseção de `directoryIds`.

## Limite de rede

A API escuta exclusivamente em `127.0.0.1`. Ela exige conexao e Host loopback, restringe Origin quando presente e exige `Content-Type: application/json` para mutacoes. Nao exponha a porta por proxy reverso, tunel ou interface de rede.

## Verificacao

```powershell
npm run check
npm run check --prefix apps/control-room
```

As fixtures existentes ficam apenas nos testes. A aplicacao de producao usa `createHttpControlRoomClient`; nao ha dados, textos ou cliente de demonstracao em memoria.
