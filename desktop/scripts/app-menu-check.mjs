#!/usr/bin/env node
// The File menu must exist, carry the standard project actions with their accelerators, and actually
// drive the app — a menu that looks right but sends nothing is worse than no menu.
process.env.IEEG_DISABLE_CLOSE_GUARD ||= '1';
delete process.env.ELECTRON_RUN_AS_NODE;
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _electron as electron } from 'playwright';
import { packagedAppPath, requiredRecording } from './lib/qa-paths.mjs';

const RECORDING = requiredRecording('MENU_CHECK_RECORDING', 'PYHFO_ELECTRON_REAL_FIXTURE_RECORDING');

const results = [];
const check = (name, pass, detail = '') => {
  results.push(pass);
  console.log(`${pass ? '[PASS]' : '[FAIL]'} ${name}${detail ? ` -- ${detail}` : ''}`);
};

const app = await electron.launch({
  executablePath: packagedAppPath,
  args: [`--user-data-dir=${join(tmpdir(), `ieeg-menu-${process.pid}`)}`],
  env: { ...process.env, PYHFO_BACKEND_STARTUP_TIMEOUT_MS: '180000' },
  timeout: 180000,
});
const page = await app.firstWindow({ timeout: 180000 });
await page.waitForLoadState('domcontentloaded');
await page.waitForTimeout(4000);

const menu = await app.evaluate(async ({ Menu }) => {
  const applicationMenu = Menu.getApplicationMenu();
  if (!applicationMenu) return null;
  return applicationMenu.items.map((item) => ({
    label: item.label,
    submenu: (item.submenu?.items || []).map((entry) => ({
      label: entry.label,
      accelerator: entry.accelerator || null,
      role: entry.role || null,
      type: entry.type,
    })),
  }));
});
console.log('MENU', JSON.stringify(menu, null, 1).slice(0, 1400));

const top = (menu || []).map((item) => item.label);
check('menu bar leads with File', top[0]?.replace('&', '') === 'File', top.join(' | '));

const file = (menu || [])[0]?.submenu || [];
const labelled = (needle) => file.find((entry) => (entry.label || '').toLowerCase().startsWith(needle));
check('File has New Project (Ctrl+N)', labelled('new project')?.accelerator === 'CmdOrCtrl+N', JSON.stringify(labelled('new project')));
check('File has Open Project (Ctrl+O)', labelled('open project')?.accelerator === 'CmdOrCtrl+O', JSON.stringify(labelled('open project')));
check('File has Save Project (Ctrl+S)', labelled('save project')?.accelerator === 'CmdOrCtrl+S', JSON.stringify(labelled('save project')));
check('File has Open Recording', Boolean(labelled('open recording')), JSON.stringify(labelled('open recording')));
check('File ends with Exit', file[file.length - 1]?.role === 'quit', JSON.stringify(file[file.length - 1]));
check('Edit menu supplies the clipboard roles',
  ((menu || [])[1]?.submenu || []).some((entry) => entry.role === 'selectall' || entry.role === 'selectAll'),
  ((menu || [])[1]?.submenu || []).map((entry) => entry.role).join(','));

// A menu that does nothing is the failure mode worth testing: drive Open Recording and see the app load.
await app.evaluate(async ({ dialog }, filePath) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
}, RECORDING);
await app.evaluate(async ({ Menu }) => {
  const file = Menu.getApplicationMenu().items[0];
  const item = file.submenu.items.find((entry) => (entry.label || '').toLowerCase().startsWith('open recording'));
  item.click();
});
await page.getByTestId('pyqt-waveform_right_sidebar').waitFor({ state: 'visible', timeout: 180000 });
const loaded = await page.evaluate(() => document.querySelector('.pyqt-workspace-shell')?.getAttribute('data-loaded'));
check('File > Open Recording actually loads a recording', loaded === 'true', `data-loaded=${loaded}`);

console.log(`${results.filter(Boolean).length}/${results.length} checks passed`);
await app.close();
