import { useState, type FormEvent } from "react";
import { Copy, PlugZap, RefreshCw } from "lucide-react";

import type { ProviderPreferencesPatch, ProviderStatus } from "../services/contracts.js";
import { AgentGlyph } from "./AgentGlyph.js";

type Tone = "completed" | "failed" | "waiting_approval" | "queued";

/** One word of state for a provider, from the facts the host reported. */
export function providerState(status: ProviderStatus): { label: string; tone: Tone } {
  if (!status.preferences.enabled) return { label: "Desativado", tone: "queued" };
  if (!status.available) return { label: "Não encontrado", tone: "failed" };
  if (status.authenticated === false) return { label: "Falta entrar na conta", tone: "failed" };
  if (status.verification && !status.verification.connected) return { label: "Conexão falhou", tone: "failed" };
  if (status.authenticated === null) return { label: "Login não confirmado", tone: "waiting_approval" };
  return { label: "Pronto", tone: "completed" };
}

const loginText = (value: boolean | null) => value === true ? "Confirmado" : value === false ? "Sem login" : "Não confirmado";
const sources: Record<string, string> = { override: "caminho configurado", user: "instalação do usuário", path: "PATH", desktop: "aplicativo desktop", bundled: "incluído no Eleazar", descriptor: "arquivo de provedores" };

interface Props {
  providers: ProviderStatus[];
  loading: boolean;
  error: string;
  /** Provider whose check or change is running; other cards stay usable only after it ends. */
  pending: string | null;
  onRefresh(): void;
  onVerify(provider: string): void;
  onChange(provider: string, patch: ProviderPreferencesPatch): void;
}

/** Each person connects their own account here: the screen shows the official command and checks the result. */
export function ProvidersPage({ providers, loading, error, pending, onRefresh, onVerify, onChange }: Props) {
  return (
    <section className="providers-page" aria-label="Provedores">
      <div className="providers-intro">
        <p>O Eleazar usa a conta em que você já entrou na CLI de cada provedor. Ele nunca faz login por você nem guarda senhas ou tokens.</p>
        <button className="secondary" onClick={onRefresh} disabled={loading || pending !== null}><RefreshCw size={16} className={loading ? "spinning" : ""} aria-hidden="true" /> Atualizar status</button>
      </div>
      {error && <div className="error" role="alert">{error}</div>}
      {!providers.length && <div className="empty" role="status">{loading ? "Consultando os provedores…" : "Nenhum provedor registrado."}</div>}
      <div className="provider-cards">
        {providers.map((status) => (
          <ProviderCard key={status.provider} status={status} busy={pending !== null || loading} verifying={pending === status.provider} onVerify={onVerify} onChange={onChange} />
        ))}
      </div>
    </section>
  );
}

function ProviderCard({ status, busy, verifying, onVerify, onChange }: { status: ProviderStatus; busy: boolean; verifying: boolean } & Pick<Props, "onVerify" | "onChange">) {
  const { provider, label, preferences, verification } = status;
  const state = providerState(status);
  const needsLogin = preferences.enabled && status.available && status.authenticated !== true;
  const models = verification?.models ?? [];
  const savedModel = preferences.defaultModel;
  return (
    <article className="panel provider-card" aria-labelledby={`provider-${provider}`}>
      <header>
        <AgentGlyph provider={provider} size={22} />
        <h2 id={`provider-${provider}`}>{label}</h2>
        <span className={`status ${state.tone}`}>{state.label}</span>
      </header>

      <dl className="provider-facts">
        <div><dt>Versão</dt><dd>{status.version ?? "Não informada"}</dd></div>
        <div><dt>Login</dt><dd>{loginText(status.authenticated)}</dd></div>
        <div><dt>Conexão ACP</dt><dd>{!verification ? "Não verificada" : verification.connected ? `Responde · ${new Date(verification.checkedAt).toLocaleTimeString("pt-BR")}` : "Falhou"}</dd></div>
        <div><dt>Uso</dt><dd>{usageText(status)}</dd></div>
        <div className="wide"><dt>Executável</dt><dd>{status.executable ? <><code>{status.executable.path}</code> ({sources[status.executable.source] ?? status.executable.source})</> : "Não encontrado"}</dd></div>
      </dl>
      {(verification && !verification.connected || !status.available) && <p className="provider-problem">{verification && !verification.connected ? verification.detail : status.detail}</p>}

      {needsLogin && <LoginHelp status={status} />}

      <div className="provider-options">
        <label className="scope-option">
          <input type="checkbox" checked={preferences.enabled} disabled={busy} onChange={(event) => onChange(provider, { enabled: event.target.checked })} />
          Ativo
        </label>
        <label className="scope-option">
          <input type="checkbox" checked={preferences.automatic} disabled={busy || !preferences.enabled} onChange={(event) => onChange(provider, { automatic: event.target.checked })} />
          Participa do Automático
        </label>
        <button className="secondary" disabled={busy || !preferences.enabled} onClick={() => onVerify(provider)}><PlugZap size={16} aria-hidden="true" /> {verifying ? "Aguarde…" : "Verificar conexão"}</button>
      </div>

      <details className="provider-settings">
        <summary>Modelo e executável</summary>
        <label>
          Modelo padrão
          <select value={savedModel ?? ""} disabled={busy || (!models.length && !savedModel)} onChange={(event) => onChange(provider, { defaultModel: event.target.value || null })}>
            <option value="">Padrão do provedor</option>
            {savedModel && !models.some((model) => model.id === savedModel) && <option value={savedModel}>{savedModel}</option>}
            {models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
          </select>
        </label>
        {!models.length && <small>Verifique a conexão para carregar os modelos desta conta.</small>}
        <ExecutableForm key={preferences.executablePath ?? ""} status={status} busy={busy} onChange={onChange} />
      </details>
    </article>
  );
}

function LoginHelp({ status }: { status: ProviderStatus }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(status.login.command); setCopied(true); } catch { setCopied(false); }
  }
  return (
    <div className="provider-login">
      <strong>{status.authenticated === false ? "Conecte a sua conta" : "Se ainda não entrou na conta"}</strong>
      <p>{status.login.hint} Rode no seu terminal e depois use Verificar conexão:</p>
      <div className="provider-command">
        <code>{status.login.command}</code>
        <button className="text-button" type="button" onClick={() => void copy()}><Copy size={14} aria-hidden="true" /> {copied ? "Copiado" : "Copiar"}</button>
      </div>
    </div>
  );
}

function ExecutableForm({ status, busy, onChange }: { status: ProviderStatus; busy: boolean } & Pick<Props, "onChange">) {
  const saved = status.preferences.executablePath;
  const [path, setPath] = useState(saved ?? "");
  function submit(event: FormEvent) {
    event.preventDefault();
    onChange(status.provider, { executablePath: path.trim() || null });
  }
  return (
    <form onSubmit={submit}>
      <label>
        Caminho do executável
        <input value={path} maxLength={500} disabled={busy} placeholder="Detecção automática" onChange={(event) => setPath(event.target.value)} />
      </label>
      <div className="provider-command">
        <button className="secondary" disabled={busy || path.trim() === (saved ?? "")}>Salvar caminho</button>
        {saved && <button className="text-button" type="button" disabled={busy} onClick={() => onChange(status.provider, { executablePath: null })}>Usar detecção automática</button>}
      </div>
    </form>
  );
}

function usageText({ usage }: ProviderStatus): string {
  if (usage.usedPercent !== null) return `${usage.usedPercent}% do limite${usage.resetAt ? `, renova em ${new Date(usage.resetAt).toLocaleString("pt-BR")}` : ""}`;
  return usage.totalTokens !== null ? `${usage.totalTokens.toLocaleString("pt-BR")} tokens no Eleazar` : "Não informado";
}
