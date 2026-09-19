# Eleazar

> Uma meta. Varios agentes. Uma execucao coordenada.

Eleazar e um orquestrador local-first de agentes de programacao. Ele classifica uma tarefa, verifica provedores locais e delega a execucao ao agente mais adequado. O **Control Room** e a interface React local para acompanhar os projetos, tarefas, execucoes e decisoes persistidos pelo nucleo em SQLite.

## Requisitos

- Node.js 20.19 ou superior;
- Git;
- Codex CLI autenticado e/ou Antigravity CLI autenticado apenas para `doctor` e `run`.

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

Abra http://127.0.0.1:5173. A API escuta em http://127.0.0.1:4317 e o banco fica em `.eleazar/control-room.sqlite` do diretorio corrente. Ambos os servidores ficam restritos ao loopback; a API tambem rejeita Host, Origin e mutacoes que nao sejam JSON de enderecos nao-loopback.

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

## Control Room local

A UI conversa somente com `GET /api/control-room/snapshot`, `GET/POST /api/control-room/projects`, `GET/POST /api/control-room/tasks`, `POST /api/control-room/tasks/:id/transition` e `POST /api/control-room/tasks/:id/dispatch`. Os DTOs HTTP espelham os contratos de `src/core/control-room.ts`, mas ficam no pacote da UI sem importar Node, SQLite ou SDKs de provedores.

O painel mostra somente estado persistido: projetos e tarefas reais, execucoes registradas e logs. Tarefas em `waiting_approval` aparecem como aprovacoes; aprovar retoma `planning` e rejeitar faz a transicao para `cancelled`. Acoes de `push`, `merge` e `deploy` continuam bloqueadas pelo nucleo.

Consulte [o guia do Control Room](docs/control-room.md) para detalhes do transporte e operacao local.

## Seguranca

- O Eleazar nunca tenta extrair credenciais dos provedores.
- O adaptador Antigravity ativa o sandbox no modo headless.
- O roteador nao envia uma tarefa a um provedor explicitamente nao autenticado.
- Merges, publicacoes e comandos destrutivos exigem uma camada explicita de aprovacao; nao sao executados pelo Control Room.
