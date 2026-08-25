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
- testes unitarios que nao consomem modelos ou creditos.

O projeto ainda esta em fase inicial. Persistencia, painel visual, worktrees, execucao paralela e revisao cruzada fazem parte das proximas etapas.

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

## Seguranca

- O Eleazar nunca tenta extrair credenciais dos provedores.
- O adaptador Antigravity ativa o sandbox no modo headless.
- O roteador nao envia uma tarefa a um provedor explicitamente nao autenticado.
- Merges, publicacoes e comandos destrutivos nao fazem parte deste primeiro nucleo.

## Referencias de integracao

- [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [Antigravity CLI headless mode](https://antigravity.google/docs/cli/headless/)
