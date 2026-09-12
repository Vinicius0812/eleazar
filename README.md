# Eleazar

> Uma meta. Varios agentes. Uma execucao coordenada.

Eleazar e um orquestrador local-first de agentes de programacao. Ele recebe uma tarefa, classifica o trabalho, verifica quais provedores estao disponiveis e delega a execucao ao agente mais adequado.

O nome homenageia o maestro brasileiro Eleazar de Carvalho.

## Estado atual

Este repositorio contem o primeiro nucleo funcional:

- CLI com comandos `doctor`, `plan` e `run`;
- roteamento deterministico por tipo de tarefa;
- adaptador Codex pelo SDK oficial;
- adaptador Antigravity pelo modo headless JSON;
- diagnostico de instalacao e autenticacao;
- testes unitarios que nao consomem modelos ou creditos;
- fundacao local do **Control Room**: projetos, tarefas, execucoes, logs, transicoes e decisoes de delegacao persistidos em SQLite.

O painel visual e a execucao paralela ainda sao proximas etapas. A camada de dominio atual e independente de React e de provedores, pronta para ser consumida por uma interface local.

## Requisitos

- Node.js 20 ou superior;
- Git;
- Codex CLI autenticado e/ou Antigravity CLI autenticado.

As credenciais continuam sob responsabilidade dos CLIs oficiais. Eleazar nao armazena senhas, cookies ou tokens de sessao.

## Desenvolvimento

```powershell
npm install
npm run check
npm run doctor
```

## Uso

Verifique os provedores locais:

```powershell
npm run dev -- doctor
```

Veja como uma tarefa seria roteada sem executa-la:

```powershell
npm run dev -- plan "Implemente autenticacao JWT na API"
```

Execute uma tarefa com roteamento automatico:

```powershell
npm run dev -- run "Revise o tratamento de erros" --cwd C:\caminho\do\projeto
```

Force um provedor:

```powershell
npm run dev -- run "Pesquise alternativas" --provider antigravity
```

Use `--json` em qualquer comando para obter saida legivel por outras ferramentas.

## Control Room local

A API e a persistencia podem ser compostas por uma aplicacao local, sem inicializar provedores ou modelos:

```ts
import { createControlRoomServer, ControlRoomService, GitWorktreeProvisioner, SqliteControlRoomStore } from "eleazar";

const store = new SqliteControlRoomStore("C:/meu-projeto/.eleazar/control-room.sqlite");
const service = new ControlRoomService(store, new GitWorktreeProvisioner());
createControlRoomServer(service).listen(4317, "127.0.0.1");
```

Rotas JSON locais: `GET/POST /api/control-room/projects`, `GET/POST /api/control-room/tasks`, `POST /api/control-room/tasks/:id/transition` e `POST /api/control-room/tasks/:id/dispatch`. Mutacoes aceitam somente conexoes, `Host` e (quando presente) `Origin` loopback, com `Content-Type: application/json`.

Tarefas que solicitam `create_worktree` recebem uma worktree isolada em `.eleazar/worktrees/<id>`, independentemente da classificacao textual. Cada despacho recebe um lease persistido: uma tentativa antiga nao pode gravar conclusao ou falha depois que a tarefa e reenfileirada. Se uma worktree marcada por lease antigo impedir uma nova tentativa, o provisionador a remove somente depois de confirmar que ela e uma worktree registrada do mesmo projeto e que sua marca pertence ao mesmo task com lease diferente; destinos ativos ou nao verificaveis permanecem intactos para recuperacao manual. O subprocesso Git usa um `core.hooksPath` temporario e vazio, portanto hooks fornecidos pelo projeto nao executam durante o provisionamento. O banco e as worktrees ficam em `.eleazar/`, ja ignorado pelo Git. O despacho permite apenas leitura, criacao de worktree e testes; `push`, `merge` e `deploy` sao bloqueados pela camada de dominio e exigem um fluxo de aprovacao futuro.

## Seguranca

- O Eleazar nunca tenta extrair credenciais dos provedores.
- O adaptador Antigravity ativa o sandbox no modo headless.
- O roteador nao envia uma tarefa a um provedor explicitamente nao autenticado.
- Merges, publicacoes e comandos destrutivos nao fazem parte deste primeiro nucleo.

## Referencias de integracao

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Antigravity CLI headless mode](https://antigravity.google/docs/cli/headless/)
