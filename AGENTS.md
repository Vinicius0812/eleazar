# AGENTS.md

## Missao

Eleazar e um orquestrador local-first de agentes de programacao. O nucleo deve permanecer independente de interfaces graficas e de detalhes especificos de cada provedor.

## Comandos de verificacao

Execute antes de concluir qualquer alteracao:

```powershell
npm run check
```

Use o diagnostico sem consumir modelos:

```powershell
npm run doctor
```

## Limites arquiteturais

- Tipos e contratos compartilhados ficam em `src/core`.
- Integracoes de provedores ficam em `src/adapters`.
- O roteador nao deve importar SDKs de provedores.
- Adaptadores nunca devem copiar, persistir ou imprimir tokens e credenciais.
- Testes unitarios nao devem executar chamadas reais de modelos.
- Novos provedores implementam `AgentAdapter` sem adicionar condicionais ao `Orchestrator`.
- Prompts fornecidos pelo usuario nunca devem ser interpolados em comandos de shell.
- Acoes destrutivas, publicacao e merge exigirao uma camada explicita de aprovacao.

## Convencoes

- TypeScript estrito e ESM.
- Imports locais usam extensao `.js` para compatibilidade com `NodeNext`.
- Prefira APIs nativas do Node quando uma dependencia nao trouxer ganho material.
- Saidas para automacao devem oferecer uma variante JSON estavel.
