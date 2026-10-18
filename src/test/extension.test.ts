import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitBlameService } from '../GitBlameService'; // Adjust the path as needed

suite('GitBlameService Test Suite', () => {
  
  test('applyHighlighting should skip git blame if there are no commit hashes', async () => {
    const service = new GitBlameService();
    const filePath = '/dummy/file.ts';

    let blameCalled = false;
    // Monkey-patch getBlameInfoForFile to track its invocation
    service['getBlameInfoForFile'] = async (path: string) => {
      blameCalled = true;
      return []; // Return empty blame info for testing purposes.
    };

    // Create a dummy editor with a minimal document and stubbed lineAt method.
    const dummyEditor: Partial<vscode.TextEditor> = {
      document: {
        uri: { fsPath: filePath } as vscode.Uri,
        lineAt: (line: number) => {
          // Create a dummy range for the line.
          return { range: new vscode.Range(line, 0, line, 10) } as vscode.TextLine;
        }
      } as vscode.TextDocument,
      setDecorations: (_: vscode.TextEditorDecorationType, _decoration: vscode.DecorationOptions[]) => {
        /* dummy implementation */
      }
    };

    // Call applyHighlighting with no commit hashes.
    await service.applyHighlighting(dummyEditor as vscode.TextEditor, []);

    // Since there is nothing to highlight, getBlameInfoForFile should not have been called.
    assert.strictEqual(blameCalled, false);
  });

  test('applyHighlighting should call git blame when there are commit hashes', async () => {
    const service = new GitBlameService();
    const filePath = '/dummy/file.ts';

    let blameCalled = false;
    // Monkey-patch getBlameInfoForFile to track its invocation.
    service['getBlameInfoForFile'] = async (path: string) => {
      blameCalled = true;
      return []; // For this test, return empty blame info.
    };

    // Create a dummy editor with a minimal document and stubbed lineAt method.
    const dummyEditor: Partial<vscode.TextEditor> = {
      document: {
        uri: { fsPath: filePath } as vscode.Uri,
        lineAt: (line: number) => {
          return { range: new vscode.Range(line, 0, line, 10) } as vscode.TextLine;
        }
      } as vscode.TextDocument,
      setDecorations: (_: vscode.TextEditorDecorationType, _decoration: vscode.DecorationOptions[]) => {
        /* dummy implementation */
      }
    };

    // Call applyHighlighting with a dummy commit hash.
    await service.applyHighlighting(dummyEditor as vscode.TextEditor, ['dummyHash']);

    // Since there is a hash to highlight, getBlameInfoForFile should be called.
    assert.strictEqual(blameCalled, true);
  });
});
