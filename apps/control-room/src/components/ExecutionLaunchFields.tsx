import { providerLabels, type ExecutionLaunch } from "./useExecutionLaunch.js";
import type { ExecutionProvider } from "../services/contracts.js";

/** Provider, model and resume fields of the execution dialog; identical for Codex and Claude. */
export function ExecutionLaunchFields({ launch, busy }: { launch: ExecutionLaunch; busy: boolean }) {
  const { acp, config } = launch;
  const name = acp ? providerLabels[acp] : "";
  const defaultName = config?.models.find((item) => item.id === config.defaultModel)?.name ?? config?.defaultModel;
  return (
    <>
      <label>
        Provedor
        <select value={launch.provider} onChange={(event) => launch.setProvider(event.target.value as ExecutionProvider)} disabled={busy}>
          <option value="auto">Automático (recomendado)</option>
          <option value="codex">Codex</option>
          <option value="antigravity">Antigravity</option>
          <option value="claude">Claude Code</option>
        </select>
      </label>
      {acp && (
        <div className="model-picker">
          {launch.status === "loading" && <small role="status">Carregando modelos do {name}…</small>}
          {launch.status === "error" && <div className="error" role="alert">Não foi possível carregar o catálogo de modelos: {launch.error} A execução usará o modelo padrão do {name}.</div>}
          {config && (
            <>
              <label>
                Modelo
                <select value={launch.model} onChange={(event) => launch.setModel(event.target.value)} disabled={busy}>
                  <option value="">{defaultName ? `Padrão anunciado (${defaultName})` : `Padrão do ${name}`}</option>
                  {config.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </label>
              <details className="model-runtime">
                <summary>Detalhes do runtime</summary>
                <dl>
                  <div><dt>Versão</dt><dd>{config.runtime.version}</dd></div>
                  <div><dt>Origem</dt><dd>{config.runtime.source}</dd></div>
                </dl>
              </details>
            </>
          )}
          {launch.resumableRun && (
            <>
              <label className="scope-option">
                <input type="checkbox" checked={launch.resume} disabled={busy} onChange={(event) => launch.setResume(event.target.checked)} />
                Tentar retomar a sessão anterior ({launch.resumableRun.id})
              </label>
              <small>Por padrão, uma sessão nova é criada. O {name} declarou suporte à retomada, mas a API ainda valida a sessão e qualquer recusa aparecerá aqui.</small>
            </>
          )}
        </div>
      )}
      {launch.provider === "claude" ? (
        <small>O Claude Code usa a sua sessão oficial já autenticada e trabalha no escopo aprovado da tarefa. O título e a solicitação são enviados ao provedor; inclua apenas o que você autoriza compartilhar. Pedidos de permissão aparecem na sessão e esperam a sua decisão. Push, merge, deploy, publicação e credenciais são proibidos na instrução enviada.</small>
      ) : (
        <small>O provedor executa no diretório-alvo. Push, merge, deploy, publicação e manipulação de credenciais estão bloqueados neste fluxo.</small>
      )}
    </>
  );
}
