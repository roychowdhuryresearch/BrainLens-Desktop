import path from 'node:path';
import { lstat, readdir, rm, stat } from 'node:fs/promises';

// Detection runs accumulate without bound: every /detections/run writes a full resumable
// checkpoint (the raw signal, its filtered copies, and the per-event feature stack) under
// userData/detection-runs/<stamp>-<biomarker>-<detector>/. Six weeks of ordinary use produced
// 136 runs / 132 GB, while the results a clinician actually revisits — events.csv and
// summary.json — totalled 3.7 MB across all of them.
//
// So retention is tiered rather than uniform: results are kept forever, and only the checkpoint
// is aged out. A pruned run still answers "what did this detector find", it just can no longer be
// reopened as a live session or re-classified without re-running detection.
export const DETECTION_RUNS_DIR = 'detection-runs';
export const PREPARED_RECORDINGS_DIR = 'prepared-recordings';
export const DEFAULT_RUN_CHECKPOINT_KEEP = 5;
export const DEFAULT_PREPARED_RECORDING_KEEP = 10;

// The manifest and its array sidecar are one indivisible unit. load_session_checkpoint
// (pyhfo/src/pyhfo/utils/session_store.py:113-121) reads the manifest and then eagerly np.load()s every
// path it references, with no fallback — so a manifest whose .data dir is gone raises a bare
// FileNotFoundError from inside _decode_value. Deleting only the arrays would be strictly worse
// than deleting nothing: the run still *looks* reopenable and fails deep instead of early.
// Every name here is either a manifest or its matching `${manifest}.data` directory.
const CHECKPOINT_NAMES = new Set([
  'session.pybrain',
  'session.pybrain.data',
  'session.npz',
  'classified_session.pybrain',
  'classified_session.pybrain.data',
  'classified_session.npz'
]);

// Results. Never deleted, at any age — this is the whole point of tiering.
const RESULT_NAMES = new Set(['events.csv', 'events.xlsx', 'summary.json', 'clinical_summary.xlsx']);

export type RetentionSummary = {
  scanned: number;
  pruned: string[];
  freedBytes: number;
  skipped: number;
  errors: string[];
};

const emptySummary = (): RetentionSummary => ({ scanned: 0, pruned: [], freedBytes: 0, skipped: 0, errors: [] });

// Anything created after the process started belongs to the running session, which may still hold
// a session_path pointing into it. Captured at module load so it is fixed for the whole launch.
const PROCESS_START_MS = Date.now();

/**
 * Parses a keep-count override. Mirrors the parse -> range-check -> typed-default shape of
 * configuredStartupTimeoutMs in pythonBackend.ts, except this one never throws: retention is
 * best-effort housekeeping and a typo in an env var must not stop the app from launching.
 * The literal 'off' disables a pass entirely.
 */
export function configuredKeepCount(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  if (value.trim().toLowerCase() === 'off') return Number.POSITIVE_INFINITY;
  const keep = Number(value);
  if (!Number.isInteger(keep) || keep < 1 || keep > 10000) {
    console.warn(`[retention] ignoring invalid keep count ${JSON.stringify(value)}; using ${fallback}`);
    return fallback;
  }
  return keep;
}

async function entrySize(target: string): Promise<number> {
  let total = 0;
  const stack = [target];
  while (stack.length) {
    const current = stack.pop()!;
    const info = await lstat(current);
    if (info.isSymbolicLink()) continue;
    if (!info.isDirectory()) { total += info.size; continue; }
    for (const child of await readdir(current, { withFileTypes: true })) stack.push(path.join(current, child.name));
  }
  return total;
}

/**
 * Removes checkpoint artifacts from one run directory, descending one level into the nested
 * `<stem>-classified` directory chosen by the desktop runs:classify-active handler. That directory
 * holds a second full copy of the signal, so skipping it would leave most of the bytes behind.
 *
 * Only exact CHECKPOINT_NAMES matches are deleted, symlinks are never followed, and recursion is
 * capped at one level — an unrecognised name is always left alone.
 */
async function removeCheckpoints(runDir: string, summary: RetentionSummary, depth = 0): Promise<void> {
  for (const entry of await readdir(runDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const target = path.join(runDir, entry.name);
    if (CHECKPOINT_NAMES.has(entry.name)) {
      const bytes = await entrySize(target).catch(() => 0);
      await rm(target, { recursive: true, force: true });
      summary.freedBytes += bytes;
      summary.pruned.push(target);
      continue;
    }
    if (depth === 0 && entry.isDirectory() && entry.name.endsWith('-classified') && !RESULT_NAMES.has(entry.name)) {
      await removeCheckpoints(target, summary, depth + 1);
    }
  }
}

/**
 * Keeps events.csv and summary.json for every run forever; drops the resumable checkpoint from
 * every run outside the newest `keep`. Runs still in flight (no summary.json yet) and runs created
 * during this process's lifetime are never touched.
 */
export async function pruneDetectionRunCheckpoints(
  userDataDir: string,
  options: { keep?: number; nowMs?: number } = {}
): Promise<RetentionSummary> {
  const summary = emptySummary();
  const keep = options.keep ?? DEFAULT_RUN_CHECKPOINT_KEEP;
  if (!Number.isFinite(keep)) return summary;
  const cutoff = options.nowMs ?? PROCESS_START_MS;
  const root = path.join(userDataDir, DETECTION_RUNS_DIR);

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return summary; // never detected on this machine — nothing to prune
  }

  const runs: Array<{ dir: string; mtimeMs: number }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const dir = path.join(root, entry.name);
    try {
      // summary.json is written even for a failed run (pipeline.py:597). Its absence means the run
      // is mid-write or died before finishing, so treat the directory as live and leave it alone.
      await stat(path.join(dir, 'summary.json'));
      runs.push({ dir, mtimeMs: (await stat(dir)).mtimeMs });
    } catch {
      summary.skipped += 1;
    }
  }
  summary.scanned = runs.length;
  runs.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const run of runs.slice(keep)) {
    if (run.mtimeMs >= cutoff) { summary.skipped += 1; continue; }
    try {
      await removeCheckpoints(run.dir, summary);
    } catch (error) {
      summary.errors.push(`${run.dir}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}

/**
 * Prepared recordings are whole-file deletions rather than checkpoint pairs, since a prepared .fif
 * can be regenerated from its source recording.
 *
 * Off by default. A saved project stores recording_path (pyhfo/src/pyhfo/agent_api/sessions.py), which
 * for a prepared recording points into this directory, and project files outlive the process — so
 * an age cutoff cannot tell a referenced .fif from an abandoned one. Enabling this without first
 * pinning project-referenced paths will silently break Open Project for older projects.
 */
export async function prunePreparedRecordings(
  userDataDir: string,
  options: { keep?: number; nowMs?: number } = {}
): Promise<RetentionSummary> {
  const summary = emptySummary();
  const keep = options.keep ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(keep)) return summary;
  const cutoff = options.nowMs ?? PROCESS_START_MS;
  const root = path.join(userDataDir, PREPARED_RECORDINGS_DIR);

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return summary;
  }

  const files: Array<{ file: string; mtimeMs: number; size: number }> = [];
  for (const entry of entries) {
    // Exactly the shape defaultPreparedOutputPath writes (electron/main.ts:183-188); anything else
    // in this directory was not put there by us.
    if (!entry.isFile() || entry.isSymbolicLink() || !entry.name.endsWith('-prepared.fif')) { summary.skipped += 1; continue; }
    const file = path.join(root, entry.name);
    try {
      const info = await stat(file);
      files.push({ file, mtimeMs: info.mtimeMs, size: info.size });
    } catch {
      summary.skipped += 1;
    }
  }
  summary.scanned = files.length;
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const candidate of files.slice(keep)) {
    if (candidate.mtimeMs >= cutoff) { summary.skipped += 1; continue; }
    try {
      await rm(candidate.file, { force: true });
      summary.freedBytes += candidate.size;
      summary.pruned.push(candidate.file);
    } catch (error) {
      summary.errors.push(`${candidate.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return summary;
}

const gib = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

/**
 * Startup deletion is opt-in. Detection checkpoints can still be referenced by a saved project,
 * so an unset or invalid keep count must preserve them until project-reference pinning exists.
 */
export function startupRetentionPolicy(environment: NodeJS.ProcessEnv = process.env): {
  detectionRunCheckpoints: number;
  preparedRecordings: number;
} {
  return {
    detectionRunCheckpoints: configuredKeepCount(
      environment.IEEG_RETENTION_RUN_CHECKPOINTS,
      Number.POSITIVE_INFINITY,
    ),
    preparedRecordings: configuredKeepCount(
      environment.IEEG_RETENTION_PREPARED_RECORDINGS,
      Number.POSITIVE_INFINITY,
    ),
  };
}

/** One best-effort housekeeping pass per launch. Never throws or delays startup. */
export async function runStartupRetention(userDataDir: string): Promise<void> {
  const policy = startupRetentionPolicy();
  const passes: Array<[string, Promise<RetentionSummary>]> = [
    ['detection-runs', pruneDetectionRunCheckpoints(userDataDir, {
      keep: policy.detectionRunCheckpoints,
    })],
    ['prepared-recordings', prunePreparedRecordings(userDataDir, {
      keep: policy.preparedRecordings,
    })]
  ];
  for (const [label, pass] of passes) {
    try {
      const summary = await pass;
      if (summary.pruned.length) {
        console.log(`[retention] ${label}: pruned ${summary.pruned.length} artifact(s), freed ${gib(summary.freedBytes)}`);
      }
      for (const error of summary.errors) console.warn(`[retention] ${label}: ${error}`);
    } catch (error) {
      console.warn(`[retention] ${label} pass failed:`, error instanceof Error ? error.message : String(error));
    }
  }
}
