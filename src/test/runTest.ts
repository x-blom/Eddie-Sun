import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

// Create a small git repo with two commits for the integration tests and describe it in a JSON file.
function createFixtureRepo(): { repo: string; fixtureFile: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'eddie-fixture-'));
  const git = (...args: string[]) => cp.execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args
  ], { cwd: repo, encoding: 'utf8' }).trim();

  git('init', '-q');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const first = git('rev-parse', 'HEAD');

  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\nTWO\nthree\n');
  fs.writeFileSync(path.join(repo, 'b.txt'), 'new file\n');
  git('add', '.');
  git('commit', '-q', '-m', 'second\n\nChange-Id: Iabc123');
  const second = git('rev-parse', 'HEAD');

  const fixtureFile = path.join(repo, '..', `${path.basename(repo)}.json`);
  fs.writeFileSync(fixtureFile, JSON.stringify({ repo, first, second }));
  return { repo, fixtureFile };
}

async function main() {
  const { repo, fixtureFile } = createFixtureRepo();
  try {
    // Path to the extension's root folder (where package.json is located)
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');
    // Path to the test runner entry point
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Download VS Code, unzip it and run the integration test inside the fixture repo
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [repo, '--disable-extensions'],
      extensionTestsEnv: { EDDIE_FIXTURE: fixtureFile }
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exitCode = 1;
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(fixtureFile, { force: true });
  }
}

main();
