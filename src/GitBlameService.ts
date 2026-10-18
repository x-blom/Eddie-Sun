import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as util from 'util';

// Interface for storing blame information
interface BlameInfo {
  hash: string;
  lines: number[];
}

// Interface for tracking highlighted files
interface HighlightedFileInfo {
  uri: vscode.Uri;
  highlightCount: number;
}

// One RGB colour per commit; commits beyond the palette size wrap around.
export const HIGHLIGHT_COLORS: [number, number, number][] = [
  [255, 193, 7],
  [33, 150, 243],
  [76, 175, 80],
  [233, 30, 99],
  [156, 39, 176],
  [255, 87, 34],
  [0, 188, 212],
  [139, 195, 74],
  [121, 85, 72],
  [63, 81, 181],
  [255, 235, 59],
  [244, 67, 54]
];

export class GitBlameService {
  private _decorationTypes: Map<number, vscode.TextEditorDecorationType> = new Map();
  private _blameCache: Map<string, BlameInfo[]> = new Map();
  private _highlightedFiles: Map<string, HighlightedFileInfo> = new Map();
  private _fileDecorationProviderDisposable: vscode.Disposable | undefined;
  private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>;

  constructor() {
    // Create an event emitter for file decoration changes
    this._onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();

    // Register the FileDecorationProvider to update Explorer icons/labels
    this._fileDecorationProviderDisposable = vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: this._onDidChangeFileDecorations.event,
      provideFileDecoration: (uri: vscode.Uri): vscode.FileDecoration | undefined => {
        const fileKey = uri.fsPath;
        if (this._isFileOrChildHighlighted(fileKey)) {
          return new vscode.FileDecoration(
            'H', // badge (optional)
            'Contains highlighted commit code', // tooltip
            new vscode.ThemeColor('gitDecoration.modifiedResourceForeground')
          );
        }
        return undefined;
      }
    });
  }

  // Get (or lazily create) the decoration type for a commit's colour slot.
  private _getDecorationType(colorIndex: number): vscode.TextEditorDecorationType {
    const slot = colorIndex % HIGHLIGHT_COLORS.length;
    let decorationType = this._decorationTypes.get(slot);
    if (!decorationType) {
      const [r, g, b] = HIGHLIGHT_COLORS[slot];
      decorationType = vscode.window.createTextEditorDecorationType({
        backgroundColor: `rgba(${r}, ${g}, ${b}, 0.25)`,
        borderWidth: '1px',
        borderStyle: 'solid',
        borderColor: `rgba(${r}, ${g}, ${b}, 0.5)`,
        overviewRulerColor: `rgba(${r}, ${g}, ${b}, 0.8)`,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        isWholeLine: true
      });
      this._decorationTypes.set(slot, decorationType);
    }
    return decorationType;
  }

  // Remove every commit colour from an editor.
  private _clearEditorDecorations(editor: vscode.TextEditor) {
    for (const decorationType of this._decorationTypes.values()) {
      editor.setDecorations(decorationType, []);
    }
  }

  // Check if the file (or any child file in a directory) is highlighted
  private _isFileOrChildHighlighted(fsPath: string): boolean {
    if (this._highlightedFiles.has(fsPath)) {
      return true;
    }
    if (fsPath.endsWith(path.sep)) {
      fsPath = fsPath.slice(0, -1);
    }
    for (const filePath of this._highlightedFiles.keys()) {
      if (filePath.startsWith(fsPath + path.sep)) {
        return true;
      }
    }
    return false;
  }
  
  // Clean up resources
  public dispose() {
    if (this._fileDecorationProviderDisposable) {
      this._fileDecorationProviderDisposable.dispose();
    }
    for (const decorationType of this._decorationTypes.values()) {
      decorationType.dispose();
    }
    this._decorationTypes.clear();
  }

  /**
   * Apply highlighting to lines in the editor that match one of the provided commit hashes.
   * (This method uses Git blame on a per-file basis.)
   */
  public async applyHighlighting(editor: vscode.TextEditor, commitHashes: string[]) {
    if (commitHashes.length === 0) {
      return;
    }
    const filePath = editor.document.uri.fsPath;
    console.log(`Processing file: ${filePath}`);

    try {
      const blameInfos = await this.getBlameInfoForFile(filePath);
      if (!blameInfos || blameInfos.length === 0) {
        console.log("No blame information found for this file");
        return;
      }

      // Group the decorations by the commit's position in the list, so each commit gets its own colour.
      const decorationsByColor = new Map<number, vscode.DecorationOptions[]>();
      let decorationCount = 0;

      for (const blameInfo of blameInfos) {
        const colorIndex = commitHashes.findIndex(hash => blameInfo.hash.startsWith(hash));
        if (colorIndex === -1) {
          continue;
        }
        console.log(`Found matching hash ${blameInfo.hash} with ${blameInfo.lines.length} lines`);
        const decorations = decorationsByColor.get(colorIndex) ?? [];
        for (const lineNumber of blameInfo.lines) {
          decorations.push({
            range: editor.document.lineAt(lineNumber).range,
            hoverMessage: `Commit: ${blameInfo.hash}`
          });
        }
        decorationCount += decorations.length;
        decorationsByColor.set(colorIndex, decorations);
      }
      console.log(`Applying ${decorationCount} decorations`);

      this._clearEditorDecorations(editor);
      for (const [colorIndex, decorations] of decorationsByColor) {
        editor.setDecorations(this._getDecorationType(colorIndex), decorations);
      }

      // Update tracking: if any decorations were applied, mark the file as highlighted.
      if (decorationCount > 0) {
        this._highlightedFiles.set(filePath, {
          uri: editor.document.uri,
          highlightCount: decorationCount
        });
      } else {
        this._highlightedFiles.delete(filePath);
      }

      this._refreshFileExplorerDecorations();
    } catch (error) {
      console.error("Error applying highlighting:", error);
      vscode.window.showErrorMessage(`Error applying highlighting: ${error}`);
    }
  }

  /**
   * Clear highlighting from a specific editor.
   */
  public clearHighlighting(editor: vscode.TextEditor) {
    console.log("Clearing all highlighting decorations");
    this._clearEditorDecorations(editor);
    const filePath = editor.document.uri.fsPath;
    this._highlightedFiles.delete(filePath);
    this._refreshFileExplorerDecorations();
  }
  
  /**
   * Clear highlights from all visible editors.
   */
  public clearAllHighlights() {
    vscode.window.visibleTextEditors.forEach(editor => this._clearEditorDecorations(editor));
    this._highlightedFiles.clear();
    this._refreshFileExplorerDecorations();
  }
  
  /**
   * Trigger a refresh of file explorer decorations.
   */
  private _refreshFileExplorerDecorations() {
    this._onDidChangeFileDecorations.fire(undefined);
  }

  /**
   * Clear cached blame information for a specific file.
   */
  public clearBlameCache(filePath: string) {
    this._blameCache.delete(filePath);
  }

  /**
   * Clear all cached blame information.
   */
  public clearAllBlameCache() {
    this._blameCache.clear();
  }

  /**
   * Get blame information for a file using Git.
   */
  private async getBlameInfoForFile(filePath: string): Promise<BlameInfo[]> {
    if (this._blameCache.has(filePath)) {
      console.log("Using cached blame info");
      return this._blameCache.get(filePath) || [];
    }

    console.log("Getting blame info from Git");
    try {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
      if (!workspaceFolder) {
        console.error("File is not in a workspace folder");
        return [];
      }
      const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
      const execPromise = util.promisify(cp.exec);
      const { stdout } = await execPromise(
        `git blame -l "${relativePath}"`,
        { cwd: workspaceFolder.uri.fsPath }
      );

      const blameInfo: BlameInfo[] = [];
      const blameLines = stdout.split('\n');
      const hashMap = new Map<string, number[]>();

      for (let i = 0; i < blameLines.length; i++) {
        const line = blameLines[i];
        if (!line || line.trim() === '') {
          continue;
        }
        const match = line.match(/^(\w+)/);
        if (match && match[1]) {
          const hash = match[1];
          const shortHash = hash.substring(0, 40);
          if (!hashMap.has(shortHash)) {
            hashMap.set(shortHash, []);
          }
          hashMap.get(shortHash)?.push(i);
        }
      }

      hashMap.forEach((lines, hash) => {
        blameInfo.push({ hash, lines });
      });

      this._blameCache.set(filePath, blameInfo);
      return blameInfo;
    } catch (error) {
      console.error(`Error getting blame info: ${error}`);
      vscode.window.showErrorMessage(`Failed to get Git blame info: ${error}`);
      return [];
    }
  }

  // ─── NEW FUNCTIONALITY ──────────────────────────────────────────────

  /**
   * Get the list of files changed in a specific commit.
   */
  private async getFilesForCommit(commit: string, cwd: string): Promise<string[]> {
    const execPromise = util.promisify(cp.exec);
    try {
      const { stdout } = await execPromise(
        `git diff-tree --no-commit-id --name-only -r ${commit}`,
        { cwd }
      );
      return stdout.split('\n').filter(line => line.trim().length > 0);
    } catch (error) {
      console.error(`Error getting files for commit ${commit}:`, error);
      return [];
    }
  }

  /**
   * Update highlighted files based on a list of commit hashes.
   * This method queries Git for each commit's changed files and marks them as highlighted,
   * so that the Explorer decorations update automatically.
   */
  public async updateFilesForCommits(commitIdentifiers: string[]): Promise<void> {
    // Clear previous highlighted files
    this._highlightedFiles.clear();
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }
    const workspacePath = workspaceFolders[0].uri.fsPath;
  
    for (const identifier of commitIdentifiers) {
      let commit = identifier;
      // If the identifier looks like a Change-Id (e.g., starts with 'I'), try to resolve it
      if (identifier.startsWith('I')) {
        const resolved = await this.resolveChangeId(identifier, workspacePath);
        if (resolved) {
          commit = resolved;
        } else {
          console.warn(`Could not resolve Change-Id: ${identifier}`);
          continue; // Skip if it cannot be resolved
        }
      }
  
      const files = await this.getFilesForCommit(commit, workspacePath);
      for (const file of files) {
        const absolutePath = path.join(workspacePath, file);
        this._highlightedFiles.set(absolutePath, {
          uri: vscode.Uri.file(absolutePath),
          highlightCount: 1
        });
      }
    }
    // Notify VS Code to update Explorer decorations
    this._refreshFileExplorerDecorations();
  }
  
  private async resolveChangeId(changeId: string, cwd: string): Promise<string | null> {
    // Use git log to resolve a Change-Id to a commit hash.
    const execPromise = util.promisify(cp.exec);
    try {
      const { stdout } = await execPromise(
        `git log --grep="Change-Id: ${changeId}" --format="%H" -n 1`,
        { cwd }
      );
      const commitHash = stdout.trim();
      return commitHash.length > 0 ? commitHash : null;
    } catch (error) {
      console.error(`Error resolving Change-Id ${changeId}:`, error);
      return null;
    }
  }  
}