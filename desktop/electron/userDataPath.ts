import type { App } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const PRODUCT_NAME = 'BrainLens Desktop';
// Both shipped packages and the development launcher used this Electron name.
const LEGACY_APP_NAME = 'ieeg-electron-desktop';

export function selectUserDataPath(appData: string, legacyExists: boolean): string {
  return join(appData, legacyExists ? LEGACY_APP_NAME : PRODUCT_NAME);
}

export function configureUserDataPaths(app: Pick<App, 'commandLine' | 'getPath' | 'setPath'>): void {
  if (app.commandLine.hasSwitch('user-data-dir')) return;
  const appData = app.getPath('appData');
  const userData = selectUserDataPath(appData, existsSync(join(appData, LEGACY_APP_NAME)));
  mkdirSync(userData, { recursive: true });
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
}
