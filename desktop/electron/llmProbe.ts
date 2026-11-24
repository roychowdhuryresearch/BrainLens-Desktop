/**
 * Talking to the configured LLM endpoint from the main process: list its models, test the
 * connection, and read token usage back out of the agent runtime.
 *
 * This lives in main rather than the renderer because the API key never leaves main — the renderer
 * only ever sees the results.
 */
import http from 'node:http';
import https from 'node:https';
import { AGENT_CONTRACT_VERSION } from './agentService.js';

export type ProbeResponse = { status: number; ok: boolean; text: string };

function request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, timeoutMs = 15000): Promise<ProbeResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const transport = target.protocol === 'https:' ? https : http;
    const headers: Record<string, string> = { ...init.headers };
    const body = init.body ? Buffer.from(init.body, 'utf8') : undefined;
    if (body) headers['content-length'] = String(body.byteLength);
    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: init.method || 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => resolve({
          status: res.statusCode || 0,
          ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
          text: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    // Unlike the backend calls, these are user-initiated and interactive: a hung endpoint must fail
    // fast enough to report rather than leaving the button spinning.
    const timer = setTimeout(() => req.destroy(new Error(`no response within ${timeoutMs}ms`)), timeoutMs);
    req.on('close', () => clearTimeout(timer));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function authHeaders(apiKey: string): Record<string, string> {
  // Local servers ignore the header, but several reject a request with an EMPTY bearer, so only send
  // one when there is something to send.
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * The models the endpoint says it has. OpenAI-compatible servers answer `GET {base}/models` with
 * `{data: [{id}]}`; Ollama's native API answers `GET {host}/api/tags` with `{models: [{name}]}`, and
 * people do paste the bare host, so both shapes are accepted.
 */
export async function listLlmModels(apiBase: string, apiKey: string): Promise<{ ok: boolean; models: string[]; error?: string }> {
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, models: [], error: 'Set an endpoint first.' };
  const attempts = [`${base}/models`, `${base.replace(/\/v1$/, '')}/api/tags`];
  let lastError = '';
  for (const url of attempts) {
    try {
      const response = await request(url, { headers: authHeaders(apiKey) });
      if (!response.ok) {
        lastError = `HTTP ${response.status}${response.text ? ` — ${response.text.slice(0, 160)}` : ''}`;
        continue;
      }
      const parsed = JSON.parse(response.text || '{}');
      const models: string[] = [
        ...(Array.isArray(parsed?.data) ? parsed.data.map((entry: { id?: string }) => String(entry?.id || '')) : []),
        ...(Array.isArray(parsed?.models) ? parsed.models.map((entry: { name?: string; model?: string }) => String(entry?.name || entry?.model || '')) : []),
      ].filter(Boolean);
      if (models.length) return { ok: true, models: [...new Set(models)].sort() };
      lastError = 'The endpoint listed no models.';
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return { ok: false, models: [], error: lastError || 'Could not reach the endpoint.' };
}

/**
 * A real one-token completion against the configured model — the only test that proves endpoint,
 * key, AND model name are all right together. Listing models would pass with a misspelled model.
 */
export async function testLlmConnection(apiBase: string, apiKey: string, model: string): Promise<{ ok: boolean; latencyMs: number; error?: string; detail?: string; toolCalling?: boolean; checks?: CapabilityCheck[] }> {
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!base) return { ok: false, latencyMs: 0, error: 'Set an endpoint first.' };
  if (!model.trim()) return { ok: false, latencyMs: 0, error: 'Set a model first.' };
  const started = Date.now();
  try {
    const response = await request(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1, stream: false }),
    }, 30000);
    const latencyMs = Date.now() - started;
    if (response.ok) {
      const parsed = JSON.parse(response.text || '{}');
      const replyModel = String(parsed?.model || model);
      // Answering is not enough: this co-pilot drives the workspace through TOOL CALLS, and a model
      // that cannot emit them narrates fake results instead of doing the work. Ask it to call one
      // trivial tool and look for tool_calls in the reply -- the difference between a model that
      // works here and one that only appears to.
      const checks = await probeCapabilities(base, apiKey, model);
      const toolCalling = checks.find((check) => check.id === 'tools')?.ok === true;
      return {
        ok: true,
        latencyMs,
        toolCalling,
        checks: [{ id: 'connection', label: 'Connection', ok: true, detail: `${replyModel} answered in ${latencyMs} ms` }, ...checks],
        detail: `${replyModel} answered in ${latencyMs} ms`,
      };
    }
    let message = `HTTP ${response.status}`;
    try {
      const parsed = JSON.parse(response.text || '{}');
      const detail = parsed?.error?.message || parsed?.message;
      if (detail) message += ` — ${String(detail).slice(0, 200)}`;
    } catch {
      if (response.text) message += ` — ${response.text.slice(0, 200)}`;
    }
    return { ok: false, latencyMs, error: message };
  } catch (error) {
    return { ok: false, latencyMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}

export type CapabilityCheck = { id: string; label: string; ok: boolean; detail: string };

/**
 * What this model can actually do, probed rather than assumed.
 *
 * Editors that host an agent (Cline, Roo, Continue) show capability flags -- tool use, reasoning,
 * context window -- next to the model, read from a catalog. A local endpoint has no catalog: whatever
 * the user pulled is whatever it is. So each capability the co-pilot depends on gets its own request,
 * and the panel reports a checklist instead of a single green tick that hides a model which answers
 * politely and can never do the work.
 */
async function probeCapabilities(base: string, apiKey: string, model: string): Promise<CapabilityCheck[]> {
  const checks: CapabilityCheck[] = [];

  // Tool calling: the one the workspace cannot function without.
  try {
    const response = await request(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Call the ping tool.' }],
        tools: [{ type: 'function', function: { name: 'ping', description: 'Readiness check', parameters: { type: 'object', properties: {} } } }],
        max_tokens: 64,
        stream: false,
      }),
    }, 90000);
    const parsed = response.ok ? JSON.parse(response.text || '{}') : {};
    const calls = parsed?.choices?.[0]?.message?.tool_calls;
    const ok = Array.isArray(calls) && calls.length > 0;
    checks.push({
      id: 'tools', label: 'Tool calling', ok,
      detail: ok ? `called ${calls[0]?.function?.name || 'a tool'}` : 'answered in prose instead of calling the tool',
    });
  } catch (error) {
    checks.push({ id: 'tools', label: 'Tool calling', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  // Reasoning: exposed as a separate field by thinking models (delta.reasoning / reasoning_content).
  try {
    const response = await request(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'A recording is 90 minutes long and scored in 15-second segments. How many segments? Answer with the number only.' }],
        max_tokens: 400,
        stream: false,
      }),
    }, 90000);
    const parsed = response.ok ? JSON.parse(response.text || '{}') : {};
    const message = parsed?.choices?.[0]?.message || {};
    const reasoning = message.reasoning || message.reasoning_content;
    const answered = /360/.test(String(message.content || ''));
    checks.push({
      id: 'reasoning', label: 'Reasoning', ok: Boolean(reasoning) || answered,
      detail: reasoning ? 'emits a separate reasoning channel' : answered ? 'multi-step answer correct' : 'could not work through a two-step question',
    });
  } catch (error) {
    checks.push({ id: 'reasoning', label: 'Reasoning', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  // Streaming: the chat shows replies as they arrive, so an endpoint that cannot stream feels broken.
  try {
    const response = await request(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say ok.' }], max_tokens: 16, stream: true }),
    }, 90000);
    const ok = response.ok && /data:\s*\{/.test(response.text || '');
    checks.push({ id: 'streaming', label: 'Streaming', ok, detail: ok ? 'server-sent deltas' : 'no incremental response' });
  } catch (error) {
    checks.push({ id: 'streaming', label: 'Streaming', ok: false, detail: error instanceof Error ? error.message : String(error) });
  }

  return checks;
}

/** Does this model emit tool_calls? One tiny request with one trivial tool is enough to tell. */
async function probeToolCalling(base: string, apiKey: string, model: string): Promise<boolean> {
  try {
    const response = await request(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Call the ping tool.' }],
        tools: [{
          type: 'function',
          function: { name: 'ping', description: 'Reply to a readiness check', parameters: { type: 'object', properties: {} } },
        }],
        max_tokens: 64,
        stream: false,
      }),
    }, 60000);
    if (!response.ok) return false;
    const parsed = JSON.parse(response.text || '{}');
    const calls = parsed?.choices?.[0]?.message?.tool_calls;
    return Array.isArray(calls) && calls.length > 0;
  } catch {
    return false;
  }
}

export type LlmUsageSummary = {
  ok: boolean;
  turns: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastModel: string | null;
  lastAt: string | null;
  error?: string;
};

/**
 * Token usage, read from the agent runtime's own observability store (it records prompt/completion
 * tokens per span). Summed over the most recent spans rather than all of history, which is what a
 * "how much am I using" readout is actually for.
 */
export async function readLlmUsage(runtimeBaseUrl: string, runtimeToken: string, limit = 200): Promise<LlmUsageSummary> {
  const empty: LlmUsageSummary = { ok: false, turns: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, lastModel: null, lastAt: null };
  try {
    const response = await request(
      `${runtimeBaseUrl.replace(/\/+$/, '')}/internal/agent/v1/observability/turns?limit=${limit}&sort_by=created_at&sort_order=desc`,
      {
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          'X-Contract-Version': AGENT_CONTRACT_VERSION,
        },
      },
    );
    if (!response.ok) return { ...empty, error: `HTTP ${response.status}` };
    const parsed = JSON.parse(response.text || '{}');
    const turns: Array<Record<string, unknown>> = Array.isArray(parsed?.turns) ? parsed.turns : [];
    const summary: LlmUsageSummary = { ...empty, ok: true };
    for (const turn of turns) {
      summary.promptTokens += Number(turn.prompt_tokens || 0);
      summary.completionTokens += Number(turn.completion_tokens || 0);
      summary.totalTokens += Number(turn.total_tokens || 0);
      if (turn.model_used && !summary.lastModel) summary.lastModel = String(turn.model_used);
      if (turn.started_at && !summary.lastAt) summary.lastAt = String(turn.started_at);
    }
    // One turn is one user-visible exchange; spans within it share a turn_id.
    summary.turns = new Set(turns.map((turn) => String(turn.turn_id || turn.id || ''))).size;
    return summary;
  } catch (error) {
    return { ...empty, error: error instanceof Error ? error.message : String(error) };
  }
}
