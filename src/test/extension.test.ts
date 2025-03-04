import * as assert from 'assert';
import * as vscode from 'vscode';
import { GitBlameService } from '../GitBlameService'; // Adjust the path as needed

suite('GitBlameService Test Suite', () => {
  
  test('applyHighlighting should skip git blame if file is not highlighted', async () => {
    const service = new GitBlameService();
    const serviceAny = service as any; // cast to any to access private properties
    const filePath = '/dummy/file.ts';

    // Ensure that _highlightedFiles does not contain filePath
    serviceAny._highlightedFiles.delete(filePath);
    
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

    // Call applyHighlighting with a dummy commit hash.
    await service.applyHighlighting(dummyEditor as vscode.TextEditor, ['dummyHash']);

    // Since the file wasn't marked as highlighted, getBlameInfoForFile should not have been called.
    assert.strictEqual(blameCalled, false);
  });

  test('applyHighlighting should call git blame when file is highlighted', async () => {
    const service = new GitBlameService();
    const serviceAny = service as any; // cast to any to access private properties
    const filePath = '/dummy/file.ts';

    // Mark the file as highlighted by manually adding it to _highlightedFiles.
    serviceAny._highlightedFiles.set(filePath, {
      uri: vscode.Uri.file(filePath),
      highlightCount: 1
    });
    
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

    // Since the file is marked as highlighted, getBlameInfoForFile should be called.
    assert.strictEqual(blameCalled, true);
  });
});
