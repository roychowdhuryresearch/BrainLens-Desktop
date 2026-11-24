import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packagedAppPath = process.env.PYHFO_PACKAGED_APP
  || fileURLToPath(new URL('../../artifacts/packaged-win/win-unpacked/iEEG.exe', import.meta.url));

export function requiredRecording(...variables) {
  const variable = variables.find((name) => process.env[name]?.trim());
  if (!variable) throw new Error(`Set ${variables.join(' or ')} to a local recording file.`);
  const path = resolve(process.env[variable].trim());
  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Recording file for ${variable} does not exist: ${path}`);
  }
  return path;
}
