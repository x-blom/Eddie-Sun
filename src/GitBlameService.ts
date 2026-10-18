import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as util from 'util';

const execFile = util.promisify(cp.execFile);

// Run git without a shell, so hashes and file names are passed through untouched.
async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

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
  // Pending or finished blame lookups, so editors showing the same file share one git call.
  private _blameCache: Map<string, Promise<BlameInfo[]>> = new Map();
  private _highlightedFiles: Map<string, HighlightedFileInfo> = new Map();
  // Files touched by the listed commits; these are shown in the Explorer without opening them.
  private _commitFiles: Map<string, HighlightedFileInfo> = new Map();
  // Every highlighted file plus all of its parent folders, for constant-time Explorer lookups.
  private _decoratedPaths: Set<string> = new Set();
  // Bumped on every update/clear so a slow, outdated commit lookup can't overwrite newer results.
  private _commitFilesGeneration = 0;
  private _fileDecorationProviderDisposable: vscode.Disposable | undefined;
  private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>;

  constructor() {
    // Create an event emitter for file decoration changes
    this._onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();

    // Register the FileDecorationProvider to update Explorer icons/labels
    this._fileDecorationProviderDisposable = vscode.window.registerFileDecorationProvider({
      onDidChangeFileDecorations: this._onDidChangeFileDecorations.event,
      provideFileDecoration: (uri: vscode.Uri): vscode.FileDecoration | undefined => {
        if (this._decoratedPaths.has(uri.fsPath)) {
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

  // Clean up resources
  public dispose() {
    if (this._fileDecorationProviderDisposable) {
      this._fileDecorationProviderDisposable.dispose();
    }
    this._onDidChangeFileDecorations.dispose();
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
    // Only real files on disk can be blamed (skips untitled documents, output panels, etc.)
    if (commitHashes.length === 0 || editor.document.uri.scheme !== 'file') {
      return;
    }
    const filePath = editor.document.uri.fsPath;
    console.log(`Processing file: ${filePath}`);

    try {
      const blameInfos = await this.getBlameInfoForFile(filePath);
      if (blameInfos.length === 0) {
        console.log("No blame information found for this file");
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
   * Clear highlights from all visible editors.
   */
  public clearAllHighlights() {
    vscode.window.visibleTextEditors.forEach(editor => this._clearEditorDecorations(editor));
    this._highlightedFiles.clear();
    this._commitFiles.clear();
    this._commitFilesGeneration++;
    this._refreshFileExplorerDecorations();
  }
  
  /**
   * Trigger a refresh of file explorer decorations.
   */
  private _refreshFileExplorerDecorations() {
    const decoratedPaths = new Set<string>();
    for (const files of [this._highlightedFiles, this._commitFiles]) {
      for (const filePath of files.keys()) {
        // Walk up to the root, stopping early once a folder is already recorded.
        let current = filePath;
        while (!decoratedPaths.has(current)) {
          decoratedPaths.add(current);
          const parent = path.dirname(current);
          if (parent === current) {
            break;
          }
          current = parent;
        }
      }
    }
    this._decoratedPaths = decoratedPaths;
    this._onDidChangeFileDecorations.fire(undefined);
  }

  /**
   * Clear cached blame information for a specific file.
   */
  public clearBlameCache(filePath: string) {
    this._blameCache.delete(filePath);
  }

  /**
   * Get blame information for a file using Git.
   */
  private getBlameInfoForFile(filePath: string): Promise<BlameInfo[]> {
    let blame = this._blameCache.get(filePath);
    if (!blame) {
      blame = this._runBlame(filePath);
      this._blameCache.set(filePath, blame);
    }
    return blame;
  }

  private async _runBlame(filePath: string): Promise<BlameInfo[]> {
    console.log("Getting blame info from Git");
    try {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath));
      if (!workspaceFolder) {
        console.error("File is not in a workspace folder");
        return [];
      }
      const relativePath = path.relative(workspaceFolder.uri.fsPath, filePath);
      // -s drops author/date columns; --root stops root-commit lines being marked as boundary (^hash).
      const stdout = await git(['blame', '-l', '-s', '--root', '--', relativePath], workspaceFolder.uri.fsPath);

      const hashMap = new Map<string, number[]>();
      const blameLines = stdout.split('\n');
      for (let i = 0; i < blameLines.length; i++) {
        const match = blameLines[i].match(/^(\w+)/);
        if (match) {
          const lines = hashMap.get(match[1]);
          if (lines) {
            lines.push(i);
          } else {
            hashMap.set(match[1], [i]);
          }
        }
      }

      return Array.from(hashMap, ([hash, lines]) => ({ hash, lines }));
    } catch (error) {
      // Don't cache failures, so the next attempt retries.
      this._blameCache.delete(filePath);
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
    try {
      const stdout = await git(['diff-tree', '--root', '--relative', '--no-commit-id', '--name-only', '-r', commit], cwd);
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
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }
    const workspacePath = workspaceFolders[0].uri.fsPath;
    const generation = ++this._commitFilesGeneration;
    // Build into a fresh map, then swap it in.
    const commitFiles = new Map<string, HighlightedFileInfo>();

    // Look up all commits in parallel.
    const fileLists = await Promise.all(commitIdentifiers.map(async identifier => {
      let commit = identifier;
      // If the identifier looks like a Change-Id (e.g., starts with 'I'), try to resolve it
      if (identifier.startsWith('I')) {
        const resolved = await this.resolveChangeId(identifier, workspacePath);
        if (!resolved) {
          console.warn(`Could not resolve Change-Id: ${identifier}`);
          return []; // Skip if it cannot be resolved
        }
        commit = resolved;
      }
      return this.getFilesForCommit(commit, workspacePath);
    }));

    for (const file of fileLists.flat()) {
      const absolutePath = path.join(workspacePath, file);
      commitFiles.set(absolutePath, {
        uri: vscode.Uri.file(absolutePath),
        highlightCount: 1
      });
    }
    if (generation !== this._commitFilesGeneration) {
      return;
    }
    this._commitFiles = commitFiles;
    // Notify VS Code to update Explorer decorations
    this._refreshFileExplorerDecorations();
  }
  
  private async resolveChangeId(changeId: string, cwd: string): Promise<string | null> {
    // Use git log to resolve a Change-Id to a commit hash.
    try {
      const stdout = await git(['log', '--fixed-strings', `--grep=Change-Id: ${changeId}`, '--format=%H', '-n', '1'], cwd);
      const commitHash = stdout.trim();
      return commitHash.length > 0 ? commitHash : null;
    } catch (error) {
      console.error(`Error resolving Change-Id ${changeId}:`, error);
      return null;
    }
  }  
}