/**
 * Encrypted provider-profile storage for the desktop Agent.
 *
 * Provider, endpoint, model, and secret are stored together inside one safeStorage ciphertext so a
 * key can never be re-used with whichever provider happened to be active in user_config.yaml. The
 * old single-key file remains readable as a legacy fallback until the user saves a provider profile.
 */
import { app, safeStorage } from 'electron';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  LLM_PROVIDER_PRESETS,
  canReuseStoredProfileKey,
  isLlmProviderId,
  matchesStoredProfileEndpoint,
  normalizeLlmProfile,
  type LlmProfile,
  type LlmProfileInput,
  type LlmProfileSummary,
  type LlmProviderId,
} from './llmProfile.js';

type LlmProfileStore = {
  version: 1;
  activeProvider?: LlmProviderId;
  profiles: Partial<Record<LlmProviderId, LlmProfile>>;
  legacy: boolean;
};

export type LlmProfileStatus = {
  activeProvider?: LlmProviderId;
  hasKey: boolean;
  activeHasKey: boolean;
  legacy: boolean;
  profiles: LlmProfileSummary[];
  providers: typeof LLM_PROVIDER_PRESETS;
};

function legacyKeyFilePath(): string {
  return join(app.getPath('userData'), 'llm-api-key.bin');
}

function legacyKeyFilePaths(): string[] {
  const current = legacyKeyFilePath();
  return [
    join(app.getPath('appData'), 'ieeg-electron-desktop', 'llm-api-key.bin'),
    join(app.getPath('appData'), 'ieeg-electron-desktop-packaged', 'llm-api-key.bin'),
  ].filter((candidate, index, all) => candidate !== current && all.indexOf(candidate) === index);
}

/** Preserve encrypted credentials across historical desktop package names without decrypting them. */
function migrateLegacyStoredLlmKey(): void {
  const current = legacyKeyFilePath();
  if (existsSync(current)) return;
  for (const legacyPath of legacyKeyFilePaths()) {
    try {
      if (!existsSync(legacyPath)) continue;
      mkdirSync(dirname(current), { recursive: true });
      copyFileSync(legacyPath, current);
      return;
    } catch {
      // Best effort: Settings remains the recovery path for an unreadable legacy ciphertext.
    }
  }
}

function profileFilePath(): string {
  return join(app.getPath('userData'), 'llm-api-profiles.bin');
}

function emptyStore(): LlmProfileStore {
  return { version: 1, profiles: {}, legacy: false };
}

async function writeEncryptedFile(path: string, plaintext: string): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  const encrypted = await safeStorage.encryptStringAsync(plaintext);
  writeFileSync(temporaryPath, encrypted, { mode: 0o600 });
  renameSync(temporaryPath, path);
}

async function decryptFile(path: string): Promise<string> {
  if (!existsSync(path) || !(await safeStorage.isAsyncEncryptionAvailable())) return '';
  const decrypted = await safeStorage.decryptStringAsync(readFileSync(path));
  const plaintext = decrypted.result.trim();
  if (decrypted.shouldReEncrypt && plaintext) {
    await writeEncryptedFile(path, plaintext);
  }
  return plaintext;
}

async function readProfileStore(): Promise<LlmProfileStore> {
  try {
    const serialized = await decryptFile(profileFilePath());
    if (serialized) {
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      const profiles: Partial<Record<LlmProviderId, LlmProfile>> = {};
      const candidates = parsed.profiles && typeof parsed.profiles === 'object'
        ? parsed.profiles as Record<string, unknown>
        : {};
      for (const [provider, value] of Object.entries(candidates)) {
        if (!isLlmProviderId(provider) || !value || typeof value !== 'object') continue;
        const candidate = value as Record<string, unknown>;
        const apiKey = String(candidate.apiKey ?? '').trim();
        const apiBase = String(candidate.apiBase ?? '').trim();
        const model = String(candidate.model ?? '').trim();
        if (!apiKey || !apiBase || !model) continue;
        profiles[provider] = { provider, apiKey, apiBase, model };
      }
      const requestedActive = parsed.activeProvider;
      const activeProvider = isLlmProviderId(requestedActive) && profiles[requestedActive]
        ? requestedActive
        : undefined;
      return { version: 1, profiles, activeProvider, legacy: false };
    }

    migrateLegacyStoredLlmKey();
    const legacyKey = await decryptFile(legacyKeyFilePath());
    if (legacyKey) {
      return {
        version: 1,
        profiles: { custom: { provider: 'custom', apiBase: '', model: '', apiKey: legacyKey } },
        legacy: true,
      };
    }
  } catch {
    return emptyStore();
  }
  return emptyStore();
}

async function writeProfileStore(store: LlmProfileStore): Promise<void> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('OS secure storage is unavailable; refusing to store API credentials in plaintext.');
  }
  await writeEncryptedFile(profileFilePath(), JSON.stringify({
    version: 1,
    activeProvider: store.activeProvider,
    profiles: store.profiles,
  }));
  rmSync(legacyKeyFilePath(), { force: true });
}

export async function getActiveStoredLlmProfile(): Promise<LlmProfile | undefined> {
  const store = await readProfileStore();
  if (store.legacy) return undefined;
  return store.activeProvider ? store.profiles[store.activeProvider] : undefined;
}

export async function getStoredLlmProfileStatus(): Promise<LlmProfileStatus> {
  const store = await readProfileStore();
  const profiles = Object.values(store.profiles)
    .filter((profile): profile is LlmProfile => Boolean(profile))
    .map(({ provider, apiBase, model, apiKey }) => ({ provider, apiBase, model, hasKey: Boolean(apiKey) }));
  return {
    activeProvider: store.activeProvider,
    hasKey: profiles.some((profile) => profile.hasKey),
    activeHasKey: Boolean(store.activeProvider && store.profiles[store.activeProvider]?.apiKey),
    legacy: store.legacy,
    profiles,
    providers: LLM_PROVIDER_PRESETS,
  };
}

export async function resolveStoredLlmProfile(input: LlmProfileInput): Promise<LlmProfile> {
  const provider = input.provider;
  if (!isLlmProviderId(provider)) throw new Error('Choose a supported API provider.');
  const store = await readProfileStore();
  const storedProfile = store.legacy ? undefined : store.profiles[provider];
  const existingKey = canReuseStoredProfileKey(storedProfile, input) ? storedProfile?.apiKey || '' : '';
  return normalizeLlmProfile(input, existingKey);
}

export async function saveStoredLlmProfile(input: LlmProfileInput): Promise<LlmProfileSummary> {
  const profile = await resolveStoredLlmProfile(input);
  const provider = profile.provider;
  const store = await readProfileStore();
  if (store.legacy && provider !== 'custom') delete store.profiles.custom;
  store.profiles[provider] = profile;
  store.activeProvider = provider;
  store.legacy = false;
  await writeProfileStore(store);
  return { provider, apiBase: profile.apiBase, model: profile.model, hasKey: true };
}

export async function clearStoredLlmProfile(provider: unknown): Promise<void> {
  if (!isLlmProviderId(provider)) throw new Error('Choose a supported API provider.');
  const store = await readProfileStore();
  delete store.profiles[provider];
  if (store.activeProvider === provider) {
    store.activeProvider = undefined;
  }
  store.legacy = false;
  if (!Object.keys(store.profiles).length) {
    rmSync(profileFilePath(), { force: true });
    rmSync(legacyKeyFilePath(), { force: true });
    return;
  }
  await writeProfileStore(store);
}

/** Older connection probes supply only the destination endpoint. */
export async function getStoredLlmKey(apiBase: string): Promise<string> {
  const active = await getActiveStoredLlmProfile();
  return active && matchesStoredProfileEndpoint(active, apiBase) ? active.apiKey : '';
}

/** Compatibility writer: update the active profile, or preserve the old single-key format. */
export async function setStoredLlmKey(key: string): Promise<void> {
  const trimmed = String(key || '').trim();
  if (!trimmed) {
    await clearStoredLlmKey();
    return;
  }
  const active = await getActiveStoredLlmProfile();
  if (active?.apiBase && active.model) {
    await saveStoredLlmProfile({ ...active, apiKey: trimmed });
    return;
  }
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error('OS secure storage is unavailable; refusing to store the API key in plaintext.');
  }
  await writeEncryptedFile(legacyKeyFilePath(), trimmed);
}

export async function clearStoredLlmKey(): Promise<void> {
  rmSync(profileFilePath(), { force: true });
  rmSync(legacyKeyFilePath(), { force: true });
}

export async function hasStoredLlmKey(): Promise<boolean> {
  return (await getStoredLlmProfileStatus()).hasKey;
}
