const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'zotero-citation-tests-'));
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(temporary, 'profile', 'User'), { recursive: true });
  fs.writeFileSync(path.join(temporary, 'profile', 'User', 'settings.json'), JSON.stringify({
    'workbench.startupEditor': 'none', 'chat.disableAIFeatures': true, 'files.autoSave': 'off',
    'extensions.autoCheckUpdates': false, 'extensions.autoUpdate': false, 'telemetry.telemetryLevel': 'off',
  }));
  const installed = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  try {
    await runTests({
      vscodeExecutablePath: process.env.VSCODE_EXECUTABLE || (fs.existsSync(installed) ? installed : undefined),
      extensionDevelopmentPath: path.resolve(__dirname, '..'),
      extensionTestsPath: path.join(__dirname, 'regression.cjs'),
      extensionTestsEnv: { ZOTERO_TEST_WORKSPACE: workspace },
      launchArgs: [workspace, '--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
        '--user-data-dir', path.join(temporary, 'profile'), '--extensions-dir', path.join(temporary, 'extensions')],
    });
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
