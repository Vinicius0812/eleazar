# Eleazar Control Room

Interface local React + Vite + TypeScript em `apps/control-room`. Os comandos e dependências do núcleo permanecem intactos. Não há persistência, acesso a arquivos locais, consultas aos provedores ou execução de comandos pela UI.

## Iniciar

Requisito da interface: Node.js 20.19+ (ou 22.12+). Na raiz desta worktree:

```powershell
npm ci --prefix apps/control-room
npm run dev --prefix apps/control-room
```

Abra http://127.0.0.1:5173. O servidor escuta somente no loopback. O mock está identificado na interface; recarregar restaura os exemplos. Atualizar consulta novamente o cliente em memória, mantendo as alterações da sessão.

```powershell
npm run check --prefix apps/control-room
npm run build --prefix apps/control-room
npm run preview --prefix apps/control-room
```

Para validar o núcleo separadamente, continue usando `npm ci` e `npm run check` na raiz. Não são necessárias credenciais para desenvolver ou testar a UI.

## Fluxos disponíveis

- Cadastro com nome e caminho absoluto; aceita Windows, UNC, macOS e Linux. O mock rejeita caminhos relativos e duplicados, sem verificar o disco.
- Criação de tarefa com projeto, título, prompt e prioridade. Atualiza a fila, o resumo e os logs; os filtros passam a mostrar o projeto da tarefa criada.
- Busca por título/ID, filtro de projeto (também pelas cartas) e detalhes do prompt.
- Revisão de contexto antes de aprovar/rejeitar. Aprovar devolve a tarefa à fila; rejeitar a bloqueia. A decisão remove a aprovação e atualiza logs/alertas; nenhum merge ou comando é executado.
- Execuções e disponibilidade dos provedores são exemplos estáticos. Logs podem ser filtrados por nível.
- Estados de carregamento, vazio, falha e nova tentativa. Se uma mutação concluir e a leitura seguinte falhar, a UI fecha o formulário e pede atualização; não repete a mutação.

## Fronteira para integração

`src/services/contracts.ts` contém DTOs de transporte e `ControlRoomClient`. São contratos exclusivos da interface, sem dependência do domínio. Se a integração compartilhar contratos com o núcleo, mova a definição compartilhada para `src/core`, conforme AGENTS.md, e mantenha o transporte separado dos modelos internos.

A única composição está em `src/main.tsx`: substitua `createMockControlRoomClient()` por um cliente da API local ou bridge IPC desktop que implemente:

| Método                         | Responsabilidade da integração                                                                |
| ------------------------------ | --------------------------------------------------------------------------------------------- |
| `getSnapshot()`                | Retornar projetos, tarefas, execuções, provedores, alertas, aprovações e logs do estado atual |
| `registerProject(input)`       | Validar o caminho no host e registrar o projeto                                               |
| `createTask(input)`            | Validar projeto/prompt/prioridade e incluir a tarefa no estado autoritativo                   |
| `decideApproval(id, decision)` | Registrar a decisão e aplicar autorização/política de aprovação na API                        |

Promises rejeitadas devem produzir mensagens adequadas ao operador. Resolva mutações apenas após confirmação no servidor. Datas são ISO-8601; progresso varia de 0 a 100. Os componentes aceitam um cliente por props, portanto testes e integração podem substituí-lo sem alterar o layout. Não há endpoints ou protocolo HTTP presumidos nesta entrega.

Persistência, agendamento, execução, autorização, concorrência e revisão de ações pertencem à integração. Para transporte com repetição automática, acrescente chave de idempotência no contrato antes de permitir retries de mutações. Para atividade ao vivo, implemente assinatura/eventos na fronteira; atualmente a UI lê no início, após mutações e por Atualizar. Nunca envie tokens ou credenciais nos DTOs/logs.

Vite usa `base: './'`, assets locais e APIs de navegador. Não há fontes externas, CDN, imports de Node, provider SDKs ou dependência do CLI na interface. Isso prepara os assets para empacotamento desktop futuro; nenhum shell desktop foi implementado.

## Acessibilidade e validação

Layout responsivo com navegação horizontal em telas pequenas, tabela com rolagem própria, landmarks, títulos associados às regiões, labels, mensagens anunciadas, estados textuais e foco visível. Diálogos nativos bloqueiam o fundo, contêm o foco e aceitam Escape; foco inicial no primeiro campo e retorno ao acionador. Animações respeitam preferência por movimento reduzido.

Vitest + Testing Library cobrem cadastro/criação, validação, filtros, detalhes, aprovações, ausência de projetos, recuperação de falha e mutação concluída com leitura falha. Testes do mock cobrem isolamento, paths, prompts como texto, ausência de execução e decisões repetidas. jsdom usa shims para dialog/scroll; o comportamento nativo deve ser conferido no navegador.

## Package e integração

Novo `apps/control-room/package.json` e lockfile próprios. Dependências de runtime: React, React DOM, Lucide React. Desenvolvimento: Vite, plugin React, TypeScript, tipos React, Vitest, jsdom e Testing Library. O `package.json`, lockfile, scripts e configuração de testes da raiz não mudaram.

A integração deverá conciliar este pacote com sua decisão de monorepo/workspaces: manter o pacote independente ou incorporar seus scripts/dependências ao workspace, regenerando os locks conforme essa decisão. O check raiz não descobre testes da UI: execute ambos os checks na CI. O build da UI fica em `apps/control-room/dist`, já ignorado pelo `.gitignore` existente.

## Verificações desta entrega

- `npm run check` na raiz: typecheck, 7 testes e build do núcleo aprovados.
- `npm run check --prefix apps/control-room`: 16 testes, typecheck e build de produção aprovados.
- `npm audit --prefix apps/control-room`: sem vulnerabilidades no pacote da UI.
- Revisão no navegador: desktop e viewport móvel de 390px; criação visível na fila/logs, revisão/aprovação, diálogo nativo, Escape e retorno de foco. Sem rolagem horizontal da página; tabela e navegação têm rolagem própria.
- `npm run doctor` não foi executado: o adaptador existente chama `codex login status`, que consulta autenticação. A instrução desta tarefa proíbe acesso a credenciais; o núcleo foi validado por testes sem modelos.

Nenhum push, merge, alteração de remoto ou arquivo do checkout principal faz parte desta entrega.
