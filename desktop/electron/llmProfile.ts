export const LLM_PROVIDER_IDS = ['deepseek', 'openai', 'qianwen', 'zhipu', 'custom'] as const;

export type LlmProviderId = typeof LLM_PROVIDER_IDS[number];

export type LlmProviderPreset = {
  id: LlmProviderId;
  label: string;
  apiBase: string;
  defaultModel: string;
  editableApiBase: boolean;
};

export type LlmProfileInput = {
  provider?: unknown;
  apiBase?: unknown;
  model?: unknown;
  apiKey?: unknown;
};

export type LlmProfile = {
  provider: LlmProviderId;
  apiBase: string;
  model: string;
  apiKey: string;
};

export type LlmProfileSummary = Omit<LlmProfile, 'apiKey'> & { hasKey: boolean };

export const LLM_PROVIDER_PRESETS: readonly LlmProviderPreset[] = [
  { id: 'deepseek', label: 'DeepSeek', apiBase: 'https://api.deepseek.com', defaultModel: 'deepseek-v4-flash', editableApiBase: false },
  { id: 'openai', label: 'OpenAI', apiBase: 'https://api.openai.com/v1', defaultModel: 'gpt-4.1-mini', editableApiBase: false },
  { id: 'qianwen', label: 'Qwen / DashScope', apiBase: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen3.5-plus', editableApiBase: false },
  { id: 'zhipu', label: 'Zhipu / BigModel', apiBase: 'https://open.bigmodel.cn/api/paas/v4', defaultModel: 'glm-5', editableApiBase: false },
  { id: 'custom', label: 'Custom OpenAI-compatible', apiBase: '', defaultModel: '', editableApiBase: true },
] as const;

export function isLlmProviderId(value: unknown): value is LlmProviderId {
  return typeof value === 'string' && (LLM_PROVIDER_IDS as readonly string[]).includes(value);
}

export function providerPreset(provider: LlmProviderId): LlmProviderPreset {
  return LLM_PROVIDER_PRESETS.find((candidate) => candidate.id === provider)!;
}

function isPrivateHttpHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1' || normalized.endsWith('.local')) return true;
  if (/^127\./.test(normalized) || /^10\./.test(normalized) || /^192\.168\./.test(normalized)) return true;
  const match = /^172\.(\d{1,3})\./.exec(normalized);
  return Boolean(match && Number(match[1]) >= 16 && Number(match[1]) <= 31);
}

export function normalizeLlmApiBase(value: unknown): string {
  const raw = String(value ?? '').trim().replace(/\/+$/, '');
  if (!raw) throw new Error('API base is required.');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('API base must be a valid http(s) URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error('API base must be an http(s) URL without embedded credentials.');
  }
  if (parsed.protocol === 'http:' && !isPrivateHttpHost(parsed.hostname)) {
    throw new Error('Plain HTTP API bases are allowed only on loopback or private-network hosts.');
  }
  return raw;
}

export function normalizeLlmProfile(input: LlmProfileInput, existingKey = ''): LlmProfile {
  if (!isLlmProviderId(input.provider)) throw new Error('Choose a supported API provider.');
  const preset = providerPreset(input.provider);
  const model = String(input.model ?? preset.defaultModel).trim();
  if (!model) throw new Error('Model is required.');
  if (model.length > 128) throw new Error('Model must be 128 characters or fewer.');
  const apiKey = String(input.apiKey ?? '').trim() || existingKey.trim();
  if (!apiKey) throw new Error('API key is required.');
  if (apiKey.length > 4096) throw new Error('API key is too long.');
  return {
    provider: input.provider,
    apiBase: normalizeLlmApiBase(preset.editableApiBase ? input.apiBase : preset.apiBase),
    model,
    apiKey,
  };
}

export function canReuseStoredProfileKey(stored: LlmProfile | undefined, input: LlmProfileInput): boolean {
  if (!stored || !isLlmProviderId(input.provider) || stored.provider !== input.provider) return false;
  return stored.provider !== 'custom' || matchesStoredProfileEndpoint(stored, input.apiBase);
}

export function matchesStoredProfileEndpoint(stored: LlmProfile, apiBase: unknown): boolean {
  try {
    return Boolean(stored.apiBase) && normalizeLlmApiBase(apiBase) === stored.apiBase;
  } catch {
    return false;
  }
}

export function chatCompletionsUrl(apiBase: string): string {
  return `${apiBase.replace(/\/+$/, '')}/chat/completions`;
}

function safeProviderError(value: string, apiKey: string): string {
  return value.replaceAll(apiKey, '[redacted]').replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]').slice(0, 600);
}

export async function testLlmProfileConnection(
  profile: LlmProfile,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 15000,
): Promise<{ ok: boolean; status?: number; message: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(chatCompletionsUrl(profile.apiBase), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${profile.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: profile.model,
        messages: [{ role: 'user', content: 'Reply with OK.' }],
        max_tokens: 2,
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = safeProviderError(await response.text(), profile.apiKey);
      return { ok: false, status: response.status, message: detail || `Provider returned HTTP ${response.status}.` };
    }
    return { ok: true, status: response.status, message: `Connected to ${profile.model}.` };
  } catch (error) {
    const message = error instanceof Error && error.name === 'AbortError'
      ? `Connection test timed out after ${timeoutMs}ms.`
      : error instanceof Error ? error.message : String(error);
    return { ok: false, message: safeProviderError(message, profile.apiKey) };
  } finally {
    clearTimeout(timeout);
  }
}
