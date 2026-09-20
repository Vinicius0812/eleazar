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
- `POST /projects` e `POST /tasks` registram estado no nucleo.
- `POST /tasks/:id/transition` aplica uma transicao valida.
- Tarefas em `waiting_approval` viram aprovacoes no painel. Aprovar as leva para `planning`; rejeitar as leva para `cancelled`.

A interface nao inicia provedores nem despacha tarefas automaticamente. O endpoint de dispatch continua sujeito aos limites do dominio: `push`, `merge` e `deploy` sao bloqueados.

Projetos usam `directories[]` no transporte. Cada item contém `name` opcional e `path` absoluto; o servidor devolve o ID, a ordem e a detecção de Git. A UI permite adicionar, remover e reordenar entradas, e exige a escolha de `targetDirectoryId` ao criar uma tarefa. Seus contratos ficam em `apps/control-room/src/services/contracts.ts`, sem import de Node, SQLite ou do núcleo.

O modo sem worktrees é configurado pelo host ao construir `ControlRoomService` com `{ useWorktrees: false }`. Nesse modo, a API não deve enviar `create_worktree`: o núcleo recusa a solicitação e aplica exclusão mútua persistida por diretório-alvo. Uma tarefa v1 tem um único alvo; aprovação adicional é reservada para um futuro pedido que represente escopo multi-diretório real.

## Limite de rede

A API escuta exclusivamente em `127.0.0.1`. Ela exige conexao e Host loopback, restringe Origin quando presente e exige `Content-Type: application/json` para mutacoes. Nao exponha a porta por proxy reverso, tunel ou interface de rede.

## Verificacao

```powershell
npm run check
npm run check --prefix apps/control-room
```

As fixtures existentes ficam apenas nos testes. A aplicacao de producao usa `createHttpControlRoomClient`; nao ha dados, textos ou cliente de demonstracao em memoria.
