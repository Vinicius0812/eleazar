import type { ProviderStatus } from "../services/contracts.js";
import type { ExecutionLaunch } from "./useExecutionLaunch.js";

function choiceLabel({ label, available, authenticated }: ProviderStatus): string {
  if (!available) return `${label} (não encontrado)`;
  return authenticated === false ? `${label} (falta entrar na conta)` : label;
}

/** Provider, model and resume fields of the execution dialog; identical for every ACP provider. */
export function ExecutionLaunchFields({ launch, busy }: { launch: ExecutionLaunch; busy: boolean }) {
  const { acp, config, choices, chosen } = launch;
  const name = chosen?.label ?? "";
  const automatic = choices.filter((item) => item.preferences.automatic && item.usage.quota?.state !== "exhausted");
  const exhausted = choices.filter((item) => item.preferences.automatic && item.usage.quota?.state === "exhausted");
  const modelName = (id: string | null | undefined) => config?.models.find((item) => item.id === id)?.name;
  const saved = modelName(chosen?.preferences.defaultModel);
  const announced = modelName(config?.defaultModel) ?? config?.defaultModel;
  const defaultText = saved ? `Seu padrão (${saved})` : announced ? `Padrão anunciado (${announced})` : `Padrão do ${name}`;
  return (
    <>
      <label>
        Provedor
        <select value={launch.provider} onChange={(event) => launch.setProvider(event.target.value)} disabled={busy}>
          <option value="auto">Automático (recomendado)</option>
          {choices.map((item) => <option key={item.provider} value={item.provider} disabled={!item.available || item.authenticated === false}>{choiceLabel(item)}</option>)}
        </select>
      </label>
      {launch.provider === "auto" && choices.length > 0 && (
        <small>{automatic.length
          ? `Escolhe entre ${automatic.map((item) => item.label).join(", ")} conforme o tipo da tarefa e a cota disponível, e só usa quem tiver o login confirmado.`
          : exhausted.length ? "Todos os provedores do Automático estão com a cota esgotada hoje. Escolha um acima ou ajuste o orçamento na tela Provedores."
          : "Nenhum provedor participa do Automático. Ajuste na tela Provedores ou escolha um acima."}
          {automatic.length > 0 && exhausted.length > 0 && ` ${exhausted.map((item) => item.label).join(", ")} ${exhausted.length === 1 ? "está" : "estão"} fora por cota esgotada.`}</small>
      )}
      {acp && (
        <div className="model-picker">
          {launch.status === "loading" && <small role="status">Carregando modelos do {name}…</small>}
          {launch.status === "error" && <div className="error" role="alert">Não foi possível carregar o catálogo de modelos: {launch.error} A execução usará o modelo padrão do {name}.</div>}
          {config && (
            <>
              <label>
                Modelo
                <select value={launch.model} onChange={(event) => launch.setModel(event.target.value)} disabled={busy}>
                  <option value="">{defaultText}</option>
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
      {chosen ? (
        <small>O {name} usa a sua sessão oficial já autenticada e trabalha no escopo aprovado da tarefa. O título e a solicitação são enviados ao provedor; inclua apenas o que você autoriza compartilhar. Pedidos de permissão aparecem na sessão e esperam a sua decisão. Push, merge, deploy, publicação e credenciais são proibidos na instrução enviada.</small>
      ) : (
        <small>O provedor executa no diretório-alvo. Push, merge, deploy, publicação e manipulação de credenciais estão bloqueados neste fluxo.</small>
      )}
    </>
  );
}
