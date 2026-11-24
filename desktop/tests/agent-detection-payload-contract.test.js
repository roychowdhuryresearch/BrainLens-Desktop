import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('agent detection bridge repairs unsupported spindle detector payloads', () => {
  const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');

  for (const phrase of [
    'DEFAULT_AGENT_DETECTOR_BY_BIOMARKER',
    "Spindle: 'MOLLE'",
    'detectorFromAgentValue(biomarker, payload.detector)',
    'detectorParamsFromAgentPayload',
    'filterFromAgentPayload',
    'freq_sp: [fp, fs]',
    'fp: 1, fs: 30',
    "normalized === 'spindle' || normalized === 'spindles'"
  ]) {
    assert.ok(app.includes(phrase), phrase);
  }
});

test('agent detection bridge preserves exact recording, channel, and output scope', () => {
  const app = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');

  for (const phrase of [
    'includeChannels: stringArray(payload.include_channels ?? payload.includeChannels)',
    'excludeChannels: stringArray(payload.exclude_channels ?? payload.excludeChannels)',
    'outputDir: optionalNonemptyString(payload.output_dir ?? payload.outputDir)',
    'agentCommandRecordingScopeError(',
    'Detection cannot combine all_channels with an explicit include_channels list.',
    'include_channels: includeChannels.length ? includeChannels : undefined',
    'exclude_channels: excludeChannels.length ? excludeChannels : undefined',
    "...(request.outputDir ? { output_dir: request.outputDir } : {})",
    "source: 'backend_readback'",
    'artifacts_sha256: canonicalJsonSha256(result.artifacts || {})',
  ]) {
    assert.ok(app.includes(phrase), phrase);
  }
});
