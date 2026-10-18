import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    // Path to the extension's root folder (where package.json is located)
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    // Path to the test runner entry point
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Download VS Code, unzip it and run the integration test
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
