import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

async function loadClassifierModule() {
  let source = readFileSync(join(root, 'src/features/shell/ClassifierTab.tsx'), 'utf8');
  source = source.replace(/^import\s+\{[^}]*\}\s+from\s+["']react["'];?\s*$/m, '');
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      isolatedModules: true,
    },
  }).outputText;
  return import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);
}

const modulePromise = loadClassifierModule();

test('agent classifier mode normalization keeps ONNX CPU distinct from legacy HF CPU', () => {
  const appSource = readFileSync(join(root, 'src/app/App.tsx'), 'utf8');
  assert.ok(appSource.includes("['ONNX CPU', 'HF CPU', 'HF GPU', 'Custom', 'Review only']"));
  assert.ok(appSource.includes("if (/\\b(onnx|bundled)\\b/.test(normalized)) return 'ONNX CPU';"));
  assert.ok(appSource.includes("if (/\\b(cpu|hf cpu|hfo cpu)\\b/.test(normalized)) return 'HF CPU';"));
});

test('classifier defaults expose ONNX CPU as bundled ONNX without explicit sources', async () => {
  const mod = await modulePromise;
  assert.equal(mod.DEFAULT_CLASSIFIER_STATE.mode, 'ONNX CPU');
  assert.deepEqual(mod.classifierModesForBiomarker('HFO'), ['ONNX CPU', 'HF CPU', 'HF GPU', 'Custom']);
  assert.equal(mod.classifierSourceSummary(mod.DEFAULT_CLASSIFIER_STATE, 'HFO'), 'Bundled ONNX');

  const payload = mod.classifierPayloadFromState({
    ...mod.DEFAULT_CLASSIFIER_STATE,
    localArtifact: '/stale/artifact.onnx',
    hubArtifact: 'roychowdhuryresearch/HFO-artifact',
  }, 'HFO');

  assert.equal(payload.model_type, 'onnx_cpu');
  assert.equal(Object.hasOwn(payload, 'source_preference'), false);
  assert.equal(payload.artifact_onnx, null);
  assert.equal(payload.artifact_path, null);
  assert.equal(payload.artifact_card, null);
});

test('classifier validation accepts .tar and .onnx model sources', async () => {
  const mod = await modulePromise;
  assert.equal(mod.validateLocalClassifierArchive('/models/artifact.tar', 'Artifact Model'), null);
  assert.equal(mod.validateLocalClassifierArchive('/models/artifact.onnx', 'Artifact Model'), null);
  assert.equal(
    mod.validateLocalClassifierArchive('/models/artifact.zip', 'Artifact Model'),
    'Artifact Model must be a .tar archive or .onnx classifier model',
  );
});

test('classifier payload routes ONNX files to *_onnx and archives to legacy *_path', async () => {
  const mod = await modulePromise;
  const payload = mod.classifierPayloadFromState({
    ...mod.DEFAULT_CLASSIFIER_STATE,
    mode: 'Custom',
    localArtifact: '/models/artifact.onnx',
    localSpike: '/models/spike.tar',
    localEhfo: '/models/ehfo.ONNX',
    hubArtifact: '',
    hubSpike: '',
    hubEhfo: '',
  }, 'HFO');

  assert.equal(payload.artifact_onnx, '/models/artifact.onnx');
  assert.equal(payload.artifact_path, null);
  assert.equal(payload.spike_path, '/models/spike.tar');
  assert.equal(payload.spike_onnx, null);
  assert.equal(payload.ehfo_onnx, '/models/ehfo.ONNX');
  assert.equal(payload.ehfo_path, null);
  assert.deepEqual(payload.steps, ['artifact', 'spike', 'ehfo']);
});

test('classifier summaries reflect ONNX, archive, and mixed local sources', async () => {
  const mod = await modulePromise;
  assert.equal(mod.classifierSourceSummary({ ...mod.DEFAULT_CLASSIFIER_STATE, mode: 'Custom', localArtifact: '/models/artifact.onnx' }, 'HFO'), 'Custom local ONNX');
  assert.equal(mod.classifierSourceSummary({ ...mod.DEFAULT_CLASSIFIER_STATE, mode: 'Custom', localArtifact: '/models/artifact.tar' }, 'HFO'), 'Custom local archive');
  assert.equal(mod.classifierSourceSummary({ ...mod.DEFAULT_CLASSIFIER_STATE, mode: 'Custom', localArtifact: '/models/artifact.onnx', localSpike: '/models/spike.tar' }, 'HFO'), 'Custom local mixed');
});

test('eHFO local sources are omitted for non-HFO classifier runs', async () => {
  const mod = await modulePromise;
  const state = {
    ...mod.DEFAULT_CLASSIFIER_STATE,
    mode: 'Custom',
    localArtifact: '/models/artifact.onnx',
    localEhfo: '/models/stale-ehfo.onnx',
    useEhfo: true,
  };
  const payload = mod.classifierPayloadFromState(state, 'Spindle');

  assert.equal(payload.ehfo_onnx, null);
  assert.equal(payload.ehfo_path, null);
  assert.equal(payload.use_ehfo, false);
  assert.deepEqual(payload.steps, ['artifact', 'spike']);
  assert.equal(mod.classifierStepLabels(state, 'Spindle'), 'Artifact → spike-associated');
  assert.equal(mod.classifierSourceSummary(state, 'Spindle'), 'Custom local ONNX');
});
