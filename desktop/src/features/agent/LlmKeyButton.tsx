import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { backendClient } from '../../api/backendClient';

type LlmSettings = { provider: string; model: string; apiBase: string };
type KeyStatus = {
  hasKey: boolean;
  anyStoredKey?: boolean;
  encryptionAvailable: boolean;
  agentUp?: boolean;
  activeProvider?: string;
  legacy?: boolean;
  profiles?: Array<{ provider: string; apiBase: string; model: string; hasKey: boolean }>;
  settings?: LlmSettings;
  providers?: string[];
  keyless?: boolean;
};

function profileProvider(provider: string): string {
  return provider === 'openai_compatible' ? 'custom' : provider;
}
type UsageSummary = {
  ok?: boolean;
  turns?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  lastModel?: string | null;
  error?: string;
};

// Labels only; the values are the provider ids AIServiceFactory understands.
const PROVIDER_LABELS: Record<string, string> = {
  deepseek: 'DeepSeek',
  openai: 'OpenAI',
  openai_compatible: 'Local / OpenAI-compatible',
  zhipu: 'Zhipu',
  qianwen: 'Qianwen',
};

// Where each hosted provider lives, so choosing one fills in its endpoint instead of leaving
// whatever was there before. Kept in sync with the defaults in runtime/core/config.py.
const PROVIDER_DEFAULTS: Record<string, { apiBase: string; model: string }> = {
  deepseek: { apiBase: 'https://api.deepseek.com', model: 'deepseek-v4-flash' },
  openai: { apiBase: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  zhipu: { apiBase: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
  qianwen: { apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  openai_compatible: { apiBase: 'http://localhost:11434/v1', model: '' },
};

// Starting points for the self-hosted servers people actually run. Each speaks OpenAI's
// /chat/completions, which is the only thing the runtime requires.
const LOCAL_PRESETS: Array<{ label: string; apiBase: string; model: string }> = [
  { label: 'Ollama', apiBase: 'http://localhost:11434/v1', model: 'llama3.1' },
  { label: 'LM Studio', apiBase: 'http://localhost:1234/v1', model: 'local-model' },
  { label: 'llama.cpp', apiBase: 'http://localhost:8080/v1', model: 'local-model' },
  { label: 'vLLM', apiBase: 'http://localhost:8000/v1', model: 'local-model' },
];

const ENDPOINT_SUGGESTIONS = [
  'https://api.deepseek.com',
  'https://api.openai.com/v1',
  'https://open.bigmodel.cn/api/paas/v4',
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://openrouter.ai/api/v1',
  'http://localhost:11434/v1',
  'http://localhost:1234/v1',
  'http://localhost:8080/v1',
  'http://localhost:8000/v1',
];

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/**
 * Co-pilot connection settings: provider, endpoint, key, and model in ONE block, because they are
 * one decision — a key means nothing without the endpoint it belongs to. The model is a combobox
 * fed by the endpoint's own /models list but still free-text, since a local server may host
 * something it does not advertise. Test before Save, so a wrong value is caught without a restart.
 */
export function LlmKeyButton() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<KeyStatus>({ hasKey: false, encryptionAvailable: true });
  const [settings, setSettings] = useState<LlmSettings>({ provider: 'deepseek', model: '', apiBase: '' });
  const [keyInput, setKeyInput] = useState('');
  const [models, setModels] = useState<string[]>([]);
  // A typed-in model is a separate mode from picking a listed one, so the dropdown can show every
  // model the endpoint offers instead of only those matching what is already in the box.
  const [customModel, setCustomModel] = useState(false);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  // Capability results from the last Verify, shown as a checklist: which of the things the co-pilot
  // actually needs this model can do.
  const [checks, setChecks] = useState<Array<{ id: string; label: string; ok: boolean; detail: string }>>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [messageTone, setMessageTone] = useState<'info' | 'ok' | 'error'>('info');
  const buttonRef = useRef<HTMLButtonElement>(null);
  // The panel anchors to the button via fixed coordinates so it escapes the header's
  // `overflow:hidden` clip (it drops BELOW the 44px header, which would otherwise crop it).
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  const keyless = Boolean(status.keyless);
  const selectedProfileProvider = profileProvider(settings.provider);
  const selectedStoredProfile = status.profiles?.find((profile) => (
    profile.provider === selectedProfileProvider
    && (
      selectedProfileProvider !== 'custom'
      || profile.apiBase.replace(/\/+$/, '') === settings.apiBase.replace(/\/+$/, '')
    )
  ));
  const selectedProfileHasKey = Boolean(selectedStoredProfile?.hasKey);
  // Whatever the endpoint listed, plus the currently configured model even when it was not in that
  // list -- otherwise opening the panel would silently drop the model already in use.
  const modelOptions = [...new Set([...models, ...(settings.model && !customModel ? [settings.model] : [])])].sort();

  function draft() {
    return {
      provider: profileProvider(settings.provider),
      apiBase: settings.apiBase,
      model: settings.model,
      apiKey: keyInput.trim() || (keyless ? 'local' : ''),
    };
  }

  function say(text: string, tone: 'info' | 'ok' | 'error' = 'info') {
    setMessage(text);
    setMessageTone(tone);
  }

  function toggleOpen() {
    setOpen((value) => {
      const next = !value;
      if (next && buttonRef.current) {
        const rect = buttonRef.current.getBoundingClientRect();
        setAnchor({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
        void refresh();
        void refreshUsage();
      }
      return next;
    });
  }

  async function refresh() {
    try {
      const next = (await backendClient.llmKeyStatus()) as KeyStatus;
      setStatus({
        hasKey: Boolean(next?.hasKey),
        anyStoredKey: Boolean(next?.anyStoredKey),
        encryptionAvailable: next?.encryptionAvailable !== false,
        agentUp: next?.agentUp,
        activeProvider: next?.activeProvider,
        legacy: next?.legacy,
        profiles: Array.isArray(next?.profiles) ? next.profiles : [],
        settings: next?.settings,
        providers: next?.providers,
        keyless: next?.keyless,
      });
      if (next?.settings) setSettings(next.settings);
    } catch {
      /* browser-preview bridge — leave defaults */
    }
  }
  useEffect(() => { void refresh(); }, []);

  async function refreshUsage() {
    try {
      setUsage((await backendClient.llmUsageSummary()) as UsageSummary);
    } catch {
      setUsage(null);
    }
  }

  async function fetchModels() {
    setBusy('models');
    say('Asking the endpoint what it has…');
    try {
      const result = (await backendClient.listLlmModels(draft())) as { ok?: boolean; models?: string[]; error?: string };
      if (result?.ok && result.models?.length) {
        setModels(result.models);
        say(`${result.models.length} model(s) available.`, 'ok');
      } else {
        setModels([]);
        say(result?.error || 'The endpoint returned no models.', 'error');
      }
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy('');
    }
  }

  async function testConnection() {
    setBusy('test');
    setChecks([]);
    say('Testing…');
    try {
      const result = (await backendClient.testLlmProfile(draft())) as { ok?: boolean; latencyMs?: number; detail?: string; message?: string; error?: string; toolCalling?: boolean; checks?: Array<{ id: string; label: string; ok: boolean; detail: string }> };
      // A model that answers but cannot call tools will look fine here and then invent results in
      // the chat, so this is a warning, not a success.
      setChecks(result?.checks || []);
      if (result?.ok) say(result.detail || `Connected in ${result.latencyMs} ms.`, result.toolCalling === false ? 'error' : 'ok');
      else say(result?.error || result?.message || 'The endpoint did not answer.', 'error');
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy('');
    }
  }

  /**
   * One Save for the whole block. Provider/model/endpoint travel with every turn now, so they
   * apply to the NEXT MESSAGE with no restart; only a new API key costs one, because the key is
   * handed to the runtime through its environment at spawn.
   */
  async function saveAll() {
    setBusy('save');
    say(keyInput.trim() ? 'Saving the key and restarting the agent (~30s)…' : 'Saving…');
    try {
      const result = (await backendClient.saveLlmProfile(draft())) as { ok?: boolean; error?: string };
      if (result?.ok) {
        setKeyInput('');
        say('Saved. The next message uses this model.', 'ok');
        await refresh();
        await refreshUsage();
        // A save that leaves the dialog sitting there reads as if it did not take. The message
        // survives in state, so reopening shows what happened.
        setOpen(false);
      }
      else say(result?.error || 'Failed to save the connection.', 'error');
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy('');
    }
  }

  async function clearKey() {
    setBusy('clear');
    say('Clearing…');
    try {
      await backendClient.clearLlmProfile(profileProvider(settings.provider));
      say('Key cleared.', 'ok');
      await refresh();
    } catch (error) {
      say(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy('');
    }
  }

  /**
   * Switching provider carries its endpoint with it. Leaving the previous one behind means picking
   * OpenAI while still pointed at localhost:11434 -- a configuration that cannot work and does not
   * announce itself.
   */
  function changeProvider(provider: string) {
    const defaults = PROVIDER_DEFAULTS[provider];
    setSettings((current) => ({
      provider,
      apiBase: defaults ? defaults.apiBase : current.apiBase,
      model: defaults && defaults.model ? defaults.model : '',
    }));
    // The old endpoint's model list says nothing about the new one.
    setModels([]);
    setCustomModel(false);
    say(defaults ? `Endpoint set to ${defaults.apiBase}` : 'Set the endpoint for this provider.');
  }

  function applyPreset(preset: { apiBase: string; model: string }) {
    setSettings({ provider: 'openai_compatible', apiBase: preset.apiBase, model: preset.model });
    setCustomModel(false);
    setModels([]);
    say(`${preset.apiBase} — fetch models to see what it is serving.`);
  }

  const panelStyle = {
    '--agent-llm-key-panel-top': `${anchor?.top ?? 50}px`,
    '--agent-llm-key-panel-right': `${anchor?.right ?? 8}px`
  } as CSSProperties;

  const panel = open ? (
    <div
      className="agent-llm-key-panel"
      data-testid="agent-llm-key-panel"
      role="dialog"
      aria-label="Co-pilot model settings"
      style={panelStyle}
    >
      <p className="agent-llm-key-title">Co-pilot model</p>

      <div className="agent-llm-connection">
        <label>
          <span>Provider</span>
          <select
            data-testid="agent-llm-provider"
            value={settings.provider}
            onChange={(event) => changeProvider(event.target.value)}
          >
            {(status.providers || ['deepseek', 'openai', 'openai_compatible', 'zhipu', 'qianwen']).map((provider) => (
              <option key={provider} value={provider}>{PROVIDER_LABELS[provider] || provider}</option>
            ))}
          </select>
        </label>

        <label>
          <span>Endpoint</span>
          <input
            data-testid="agent-llm-api-base"
            list="agent-llm-endpoint-options"
            value={settings.apiBase}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            onChange={(event) => setSettings((current) => ({ ...current, apiBase: event.target.value }))}
          />
        </label>

        {/* Suggestions rather than a fixed list: a gateway, a proxy, or a regional base is still a
            valid endpoint for a hosted provider, so the field stays free text. */}
        <datalist id="agent-llm-endpoint-options">
          {ENDPOINT_SUGGESTIONS.map((endpoint) => <option key={endpoint} value={endpoint} />)}
        </datalist>

        <label>
          <span>API key</span>
          <input
            data-testid="agent-llm-key-input"
            className="agent-llm-key-field"
            type="password"
            value={keyInput}
            placeholder={keyless ? 'Not needed for a local endpoint' : selectedProfileHasKey ? '•••••••• stored — type to replace' : 'Paste API key'}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setKeyInput(event.target.value)}
          />
        </label>
        {/* State the credential boundary plainly on a clinical workstation. */}
        {!keyless && (
          <p className="helper-copy agent-llm-key-scope">
            Credentials are encrypted at rest using OS secure storage and bound to this provider and endpoint.
          </p>
        )}
        {!status.activeProvider && !status.legacy && (
          <p className="helper-copy agent-llm-key-scope">The Agent uses runtime defaults until you choose Save.</p>
        )}
        {status.legacy && (
          <p className="agent-llm-key-warning" data-testid="agent-llm-legacy-key-warning">
            A legacy encrypted key is present but is not bound to a provider. Re-enter it and choose Save to migrate it safely.
          </p>
        )}

        {/* A real <select>, not an input+datalist: a datalist FILTERS its options against whatever
            is already typed, so a box pre-filled with 'deepseek-v4-flash' shows an empty dropdown
            next to an endpoint serving llama3.1. 'Custom…' keeps free text available, because a
            server can serve a model it does not advertise. */}
        <label>
          <span>Model</span>
          <span className="agent-llm-model-row">
            <select
              data-testid="agent-llm-model-select"
              value={customModel ? '__custom__' : settings.model}
              onChange={(event) => {
                const value = event.target.value;
                if (value === '__custom__') { setCustomModel(true); return; }
                setCustomModel(false);
                setSettings((current) => ({ ...current, model: value }));
              }}
            >
              {modelOptions.length === 0 && <option value="">— press Fetch, or choose Custom —</option>}
              {modelOptions.map((model) => <option key={model} value={model}>{model}</option>)}
              <option value="__custom__">Custom…</option>
            </select>
            <button
              type="button"
              className="agent-llm-fetch"
              data-testid="agent-llm-fetch-models"
              disabled={Boolean(busy)}
              title="List the models this endpoint is serving"
              onClick={() => void fetchModels()}
            >
              {busy === 'models' ? '…' : 'Fetch'}
            </button>
          </span>
        </label>
        {customModel && (
          <label>
            <span>Model name</span>
            <input
              data-testid="agent-llm-model"
              value={settings.model}
              placeholder="model name"
              spellCheck={false}
              autoFocus
              onChange={(event) => setSettings((current) => ({ ...current, model: event.target.value }))}
            />
          </label>
        )}
        {models.length > 0 && (
          <p className="agent-llm-model-count" data-testid="agent-llm-model-count">{models.length} model(s) from this endpoint</p>
        )}

        <div className="agent-llm-presets">
          <span>Local servers:</span>
          {LOCAL_PRESETS.map((preset) => (
            <button
              key={preset.label}
              type="button"
              className="agent-llm-preset"
              data-testid={`agent-llm-preset-${preset.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              onClick={() => applyPreset(preset)}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      <div className="agent-llm-key-actions">
        <button className="agent-llm-key-action" type="button" data-testid="agent-llm-key-test" disabled={Boolean(busy)} onClick={() => void testConnection()}>
          {busy === 'test' ? 'Verifying…' : 'Verify connection'}
        </button>
        <button className="agent-llm-key-action agent-llm-key-primary" type="button" data-testid="agent-llm-key-save" disabled={Boolean(busy)} onClick={() => void saveAll()}>
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
        {selectedProfileHasKey && (
          <button className="agent-llm-key-action" type="button" data-testid="agent-llm-key-clear" disabled={Boolean(busy)} onClick={() => void clearKey()}>Clear key</button>
        )}
        <button className="agent-llm-key-action agent-llm-key-close" type="button" onClick={() => setOpen(false)}>Close</button>
      </div>

      {/* Usage comes from the agent runtime's own per-span token accounting, so it counts what the
          co-pilot actually spent rather than what the chat window happens to show. */}
      {checks.length > 0 && (
        <ul className="agent-llm-checks" data-testid="agent-llm-checks">
          {checks.map((check) => (
            <li key={check.id} data-ok={check.ok ? "true" : "false"}>
              <span className="agent-llm-check-mark" aria-hidden="true">{check.ok ? "✓" : "✗"}</span>
              <span className="agent-llm-check-label">{check.label}</span>
              <span className="agent-llm-check-detail">{check.detail}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="agent-llm-usage" data-testid="agent-llm-usage">
        <p className="agent-llm-usage-head">
          Recent usage
          <button type="button" className="agent-llm-usage-refresh" data-testid="agent-llm-usage-refresh" onClick={() => void refreshUsage()}>Refresh</button>
        </p>
        {usage?.ok ? (
          <dl className="agent-llm-usage-grid">
            <div><dt>Turns</dt><dd>{usage.turns ?? 0}</dd></div>
            <div><dt>Prompt</dt><dd>{formatTokens(usage.promptTokens ?? 0)}</dd></div>
            <div><dt>Output</dt><dd>{formatTokens(usage.completionTokens ?? 0)}</dd></div>
            <div><dt>Total</dt><dd>{formatTokens(usage.totalTokens ?? 0)}</dd></div>
          </dl>
        ) : (
          <p className="agent-llm-key-copy">{usage?.error || 'No usage recorded yet.'}</p>
        )}
        {usage?.ok && usage.lastModel && <p className="agent-llm-key-copy">Last model: {usage.lastModel}</p>}
      </div>

      {!status.encryptionAvailable && (
        <p className="agent-llm-key-warning">OS secure storage unavailable — can&apos;t store the key securely here.</p>
      )}
      {message && <p className={`agent-llm-key-message agent-llm-key-message-${messageTone}`} data-testid="agent-llm-key-message">{message}</p>}
    </div>
  ) : null;

  return (
    <span className="agent-llm-key" style={{ position: 'relative' }}>
      <button
        ref={buttonRef}
        type="button"
        data-testid="agent-llm-key-button"
        aria-label="Co-pilot model settings"
        title={status.hasKey ? 'Co-pilot model (key set)' : 'Co-pilot model settings'}
        onClick={toggleOpen}
      >
        <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>
        {status.hasKey && <span className="agent-llm-key-state" aria-hidden="true" />}
      </button>
      {panel && typeof document !== 'undefined' ? createPortal(panel, document.body) : panel}
    </span>
  );
}
