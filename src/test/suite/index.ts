import * as fs from 'fs';
import * as path from 'path';
import * as Mocha from 'mocha';

export async function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'tdd', color: true });
  const testsRoot = path.resolve(__dirname, '..');

  for (const file of fs.readdirSync(testsRoot)) {
    if (file.endsWith('.test.js')) {
      mocha.addFile(path.resolve(testsRoot, file));
    }
  }

  await new Promise<void>((resolve, reject) => {
    mocha.run((failures: number) => {
      if (failures > 0) {
        reject(new Error(`${failures} tests failed.`));
      } else {
        resolve();
      }
    });
  });
}
