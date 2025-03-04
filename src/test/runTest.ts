import * as path from 'path';
import * as vscodeTest from 'vscode-test';

async function main() {
  try {
    // Path to the extension's root folder (where package.json is located)
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    // Path to the tests (e.g., a folder with your test suite)
    const extensionTestsPath = path.resolve(__dirname, './suite');

    // Download VS Code, unzip it and run the integration test
    await vscodeTest.runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
    });
  } catch (err) {
    console.error('Failed to run tests');
    process.exit(1);
  }
}

main();
