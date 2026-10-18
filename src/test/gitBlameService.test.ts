import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitBlameService, HIGHLIGHT_COLORS } from '../GitBlameService';

interface Fixture {
  repo: string;
  first: string;
  second: string;
}

type Applied = Map<vscode.TextEditorDecorationType, vscode.DecorationOptions[]>;

// Wrap a real editor so the decorations passed to setDecorations can be inspected.
function spyOn(editor: vscode.TextEditor): { editor: vscode.TextEditor; applied: Applied } {
  const applied: Applied = new Map();
  const spy = {
    document: editor.document,
    setDecorations: (type: vscode.TextEditorDecorationType, decorations: vscode.DecorationOptions[]) => {
      applied.set(type, decorations);
    }
  };
  return { editor: spy as unknown as vscode.TextEditor, applied };
}

// Line numbers decorated per non-empty decoration type, sorted for stable comparison.
function decoratedLines(applied: Applied): number[][] {
  return [...applied.values()]
    .filter(decorations => decorations.length > 0)
    .map(decorations => decorations.map(d => d.range.start.line).sort())
    .sort((a, b) => a[0] - b[0]);
}

suite('GitBlameService git integration', function () {
  this.timeout(20000);
  let fixture: Fixture;
  let service: GitBlameService;
  let editor: vscode.TextEditor;

  suiteSetup(async () => {
    assert.ok(process.env.EDDIE_FIXTURE, 'EDDIE_FIXTURE is set by runTest.ts');
    fixture = JSON.parse(fs.readFileSync(process.env.EDDIE_FIXTURE!, 'utf8'));
    const document = await vscode.workspace.openTextDocument(path.join(fixture.repo, 'a.txt'));
    editor = await vscode.window.showTextDocument(document);
  });

  setup(() => {
    service = new GitBlameService();
  });

  teardown(() => {
    service.dispose();
  });

  test('highlights each commit\'s lines separately', async () => {
    const { editor: spied, applied } = spyOn(editor);
    await service.applyHighlighting(spied, [fixture.first, fixture.second]);
    // "one" and "three" come from the first commit, "TWO" from the second.
    assert.deepStrictEqual(decoratedLines(applied), [[0, 2], [1]]);
  });

  test('matches abbreviated hashes', async () => {
    const { editor: spied, applied } = spyOn(editor);
    await service.applyHighlighting(spied, [fixture.second.slice(0, 7)]);
    assert.deepStrictEqual(decoratedLines(applied), [[1]]);
  });

  test('colour follows the commit\'s position in the list', async () => {
    const forward = spyOn(editor);
    await service.applyHighlighting(forward.editor, [fixture.first, fixture.second]);
    const reversed = spyOn(editor);
    await service.applyHighlighting(reversed.editor, [fixture.second, fixture.first]);

    const typeFor = (applied: Applied, line: number) =>
      [...applied.entries()].find(([, ds]) => ds.some(d => d.range.start.line === line))?.[0];
    // Swapping the order swaps which colour each commit gets.
    assert.strictEqual(typeFor(forward.applied, 1), typeFor(reversed.applied, 0));
    assert.notStrictEqual(typeFor(forward.applied, 1), typeFor(forward.applied, 0));
  });

  test('hover message names the commit', async () => {
    const { editor: spied, applied } = spyOn(editor);
    await service.applyHighlighting(spied, [fixture.second]);
    const [decoration] = [...applied.values()].flat();
    assert.strictEqual(decoration.hoverMessage, `Commit: ${fixture.second}`);
  });

  test('unknown hashes decorate nothing', async () => {
    const { editor: spied, applied } = spyOn(editor);
    await service.applyHighlighting(spied, ['deadbeef']);
    assert.deepStrictEqual(decoratedLines(applied), []);
  });

  test('removing a hash clears its old highlights', async () => {
    const { editor: spied, applied } = spyOn(editor);
    await service.applyHighlighting(spied, [fixture.first]);
    await service.applyHighlighting(spied, [fixture.second]);
    assert.deepStrictEqual(decoratedLines(applied), [[1]]);
  });

  test('wraps colours around after the palette runs out', async () => {
    const hashes = Array.from({ length: HIGHLIGHT_COLORS.length }, (_, i) => `00000${i}`);
    hashes.push(fixture.second);
    const { editor: spied, applied } = spyOn(editor);
    await service.applyHighlighting(spied, hashes);
    // The 13th commit reuses the first colour slot instead of failing.
    assert.deepStrictEqual(decoratedLines(applied), [[1]]);
  });

  test('blame is only run once per file while cached', async () => {
    const calls = new Set<Promise<unknown>>();
    const original = service['_runBlame'].bind(service);
    service['_runBlame'] = (filePath: string) => {
      const result = original(filePath);
      calls.add(result);
      return result;
    };
    await Promise.all([
      service.applyHighlighting(spyOn(editor).editor, [fixture.first]),
      service.applyHighlighting(spyOn(editor).editor, [fixture.second])
    ]);
    assert.strictEqual(calls.size, 1);

    service.clearBlameCache(editor.document.uri.fsPath);
    await service.applyHighlighting(spyOn(editor).editor, [fixture.first]);
    assert.strictEqual(calls.size, 2);
  });

  test('skips editors that are not files on disk', async () => {
    const untitled = await vscode.workspace.openTextDocument({ content: 'hello' });
    let blameCalled = false;
    service['getBlameInfoForFile'] = async () => {
      blameCalled = true;
      return [];
    };
    await service.applyHighlighting({ document: untitled } as vscode.TextEditor, [fixture.first]);
    assert.strictEqual(blameCalled, false);
  });

  test('files outside git produce no highlights and are not cached', async () => {
    const outside = path.join(fixture.repo, 'missing.txt');
    const document = { uri: vscode.Uri.file(outside), lineAt: () => { throw new Error('unexpected'); } };
    const applied: Applied = new Map();
    const spied = {
      document,
      setDecorations: (t: vscode.TextEditorDecorationType, d: vscode.DecorationOptions[]) => applied.set(t, d)
    } as unknown as vscode.TextEditor;

    const shown: string[] = [];
    const originalShow = vscode.window.showErrorMessage;
    (vscode.window as any).showErrorMessage = (message: string) => { shown.push(message); return Promise.resolve(undefined); };
    try {
      await service.applyHighlighting(spied, [fixture.first]);
    } finally {
      (vscode.window as any).showErrorMessage = originalShow;
    }
    assert.deepStrictEqual(decoratedLines(applied), []);
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(service['_blameCache'].has(outside), false);
  });

  test('updateFilesForCommits lists the files each commit touched', async () => {
    await service.updateFilesForCommits([fixture.second]);
    const files = [...service['_commitFiles']].map(f => path.relative(fixture.repo, f)).sort();
    assert.deepStrictEqual(files, ['a.txt', 'b.txt']);

    await service.updateFilesForCommits([fixture.first]);
    const firstFiles = [...service['_commitFiles']].map(f => path.relative(fixture.repo, f)).sort();
    assert.deepStrictEqual(firstFiles, ['a.txt']);
  });

  test('updateFilesForCommits resolves Change-Ids', async () => {
    await service.updateFilesForCommits(['Iabc123']);
    assert.strictEqual(service['_commitFiles'].size, 2);
  });

  test('updateFilesForCommits ignores unresolvable Change-Ids and bad hashes', async () => {
    await service.updateFilesForCommits(['Inotthere', 'not-a-commit']);
    assert.strictEqual(service['_commitFiles'].size, 0);
  });

  test('parent folders of touched files are decorated too', async () => {
    await service.updateFilesForCommits([fixture.second]);
    const decorated: Set<string> = service['_decoratedPaths'];
    assert.ok(decorated.has(path.join(fixture.repo, 'a.txt')));
    assert.ok(decorated.has(fixture.repo));
    assert.ok(!decorated.has(path.join(fixture.repo, 'c.txt')));
  });

  test('a newer update wins over a slower older one', async () => {
    const slow = service.updateFilesForCommits([fixture.first]);
    const fast = service.updateFilesForCommits([fixture.second]);
    await Promise.all([slow, fast]);
    assert.strictEqual(service['_commitFiles'].size, 2);
  });

  test('removing a commit removes its files from the Explorer markers', async () => {
    await service.updateFilesForCommits([fixture.first, fixture.second]);
    assert.ok(service['_decoratedPaths'].has(path.join(fixture.repo, 'b.txt')));

    // Only the first commit remains: b.txt (added by the second) is no longer marked.
    await service.updateFilesForCommits([fixture.first]);
    assert.ok(service['_decoratedPaths'].has(path.join(fixture.repo, 'a.txt')));
    assert.ok(!service['_decoratedPaths'].has(path.join(fixture.repo, 'b.txt')));
  });

  test('highlighting an editor does not leave Explorer markers behind', async () => {
    await service.updateFilesForCommits([fixture.first]);
    await service.applyHighlighting(editor, [fixture.second]);
    await service.updateFilesForCommits([]);
    assert.strictEqual(service['_decoratedPaths'].size, 0);
  });

  test('clearAllHighlights removes Explorer markers and editor decorations', async () => {
    await service.updateFilesForCommits([fixture.second]);
    await service.applyHighlighting(editor, [fixture.second]);
    service.clearAllHighlights();
    assert.strictEqual(service['_commitFiles'].size, 0);
    assert.strictEqual(service['_decoratedPaths'].size, 0);
  });

  test('dispose releases decoration types', async () => {
    await service.applyHighlighting(spyOn(editor).editor, [fixture.first]);
    assert.ok(service['_decorationTypes'].size > 0);
    service.dispose();
    assert.strictEqual(service['_decorationTypes'].size, 0);
  });
});

suite('HIGHLIGHT_COLORS', () => {
  test('are valid and distinct', () => {
    const seen = new Set(HIGHLIGHT_COLORS.map(c => c.join(',')));
    assert.strictEqual(seen.size, HIGHLIGHT_COLORS.length);
    for (const channel of HIGHLIGHT_COLORS.flat()) {
      assert.ok(Number.isInteger(channel) && channel >= 0 && channel <= 255);
    }
  });
});
