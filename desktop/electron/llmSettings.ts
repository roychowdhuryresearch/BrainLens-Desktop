/**
 * Non-secret LLM connection settings: which provider, which model, and which endpoint.
 *
 * Deliberately separate from llmKey.ts. The API key is a credential and lives encrypted in OS secure
 * storage; these three fields are plain configuration and must be readable to decide whether a key is
 * even required — a self-hosted server (Ollama, llama.cpp, LM Studio, vLLM) authenticates nothing, so
 * insisting on a key would make it unconfigurable.
 */
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type LlmSettings = {
  provider: string;
  model: string;
  apiBase: string;
};

// DeepSeek stays the out-of-the-box target so an existing install keeps working untouched.
export const DEFAULT_LLM_SETTINGS: LlmSettings = {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  apiBase: 'https://api.deepseek.com',
};

// Kept in sync with AIServiceFactory.create_service in runtime/services/ai_service.py: anything the
// factory cannot construct must not be offerable here.
export const SUPPORTED_LLM_PROVIDERS = ['deepseek', 'openai', 'openai_compatible', 'zhipu', 'qianwen'] as const;

function settingsFilePath(): string {
  return join(app.getPath('userData'), 'llm-settings.json');
}

/**
 * True when the endpoint needs no API key. Mirrors `is_keyless_endpoint` in runtime/core/config.py —
 * if these two disagree, the UI either demands a key the server ignores or lets a keyless config
 * through that the runtime then rejects.
 */
export function isKeylessLlmEndpoint(settings: LlmSettings): boolean {
  const provider = String(settings.provider || '').trim().toLowerCase();
  if (provider === 'local' || provider === 'openai_compatible') return true;
  const base = String(settings.apiBase || '').trim().toLowerCase();
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:|\/|$)/.test(base);
}

export function getLlmSettings(): LlmSettings {
  try {
    const path = settingsFilePath();
    if (!existsSync(path)) return { ...DEFAULT_LLM_SETTINGS };
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LlmSettings>;
    return {
      provider: String(parsed.provider || DEFAULT_LLM_SETTINGS.provider),
      model: String(parsed.model || DEFAULT_LLM_SETTINGS.model),
      apiBase: String(parsed.apiBase || DEFAULT_LLM_SETTINGS.apiBase),
    };
  } catch {
    // A corrupt settings file must not stop the app booting; the defaults still reach a working
    // provider.
    return { ...DEFAULT_LLM_SETTINGS };
  }
}

export function setLlmSettings(next: Partial<LlmSettings>): LlmSettings {
  const current = getLlmSettings();
  const merged: LlmSettings = {
    provider: String(next.provider ?? current.provider).trim() || DEFAULT_LLM_SETTINGS.provider,
    model: String(next.model ?? current.model).trim() || DEFAULT_LLM_SETTINGS.model,
    apiBase: String(next.apiBase ?? current.apiBase).trim() || DEFAULT_LLM_SETTINGS.apiBase,
  };
  const path = settingsFilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(merged, null, 2), 'utf8');
  return merged;
}

/**
 * Push the stored settings into the environment the agent runtime is spawned with. Called before
 * every spawn rather than once at boot, so a settings change takes effect on the next restart.
 */
export function applyLlmSettingsToEnv(): LlmSettings {
  const settings = getLlmSettings();
  process.env.IEEG_LLM_PROVIDER = settings.provider;
  process.env.IEEG_LLM_MODEL = settings.model;
  process.env.IEEG_LLM_API_BASE = settings.apiBase;
  return settings;
}
