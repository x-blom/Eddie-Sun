import * as vscode from 'vscode';
import { CommitMatch, GitBlameService, HIGHLIGHT_COLORS } from './GitBlameService';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _commitHashes: string[] = [];
  private _isHighlightingEnabled: boolean = false;
  private _gitBlameService: GitBlameService;
  private _commitMatches: CommitMatch[] = [];
  private _matchGeneration = 0;
  private _disposables: vscode.Disposable[] = [];

  constructor(private readonly _extensionUri: vscode.Uri) {
    this._gitBlameService = new GitBlameService();

    // Highlight editors as they come into view (opening, switching tabs, splitting)
    this._disposables.push(vscode.window.onDidChangeVisibleTextEditors(() => {
      if (this._isHighlightingEnabled) {
        this.triggerHighlighting();
      }
    }));

    // Re-run blame when a file is saved. While typing, VS Code shifts the existing
    // decorations along with the text, so there's no need to call git on every keystroke.
    this._disposables.push(vscode.workspace.onDidSaveTextDocument(document => {
      if (this._isHighlightingEnabled) {
        console.log("Document saved - re-applying highlighting");
        this._gitBlameService.clearBlameCache(document.uri.fsPath);
        this.triggerHighlighting();
      }
    }));
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'media')]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(data => {
      switch (data.type) {
        case 'updateCommitHashes': {
          const newHashes = data.value;
          console.log(`Updating commit hashes: ${newHashes.join(', ')}`);
          if (JSON.stringify(this._commitHashes) !== JSON.stringify(newHashes)) {
            this._commitHashes = newHashes;
            console.log(`Current hashes: ${this._commitHashes.join(', ')}`);
            if (this._isHighlightingEnabled) {
              if (this._commitHashes.length > 0) {
                this.triggerHighlighting();
              } else {
                this._gitBlameService.clearAllHighlights();
              }
            }
            this.refreshCommitMatches();
          }
          this.saveState();
          break;
        }
        case 'toggleHighlighting': {
          this._isHighlightingEnabled = data.value;
          console.log(`Highlighting toggled to: ${this._isHighlightingEnabled}`);
          if (this._isHighlightingEnabled) {
            this.refreshCommitMatches();
            this.triggerHighlighting();
          } else {
            this._gitBlameService.clearAllHighlights();
          }
          this.saveState();
          vscode.window.showInformationMessage(
            `Commit hash highlighting: ${this._isHighlightingEnabled ? 'ON' : 'OFF'}`
          );
          break;
        }
        case 'viewStateRestored': {
          console.log("Webview requesting stored data");
          this.restoreWebviewState();
          break;
        }
      }
    });

    this.updateSidebarContent();
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Commit Hash Highlighter</title>
  <style>
    body {
      padding: 10px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
      background-color: #1e1e1e;
      color: #d4d4d4;
    }
    button {
      margin: 5px 0;
      padding: 5px 10px;
      background-color: #007ACC;
      color: white;
      border: none;
      border-radius: 3px;
      cursor: pointer;
    }
    button:hover {
      background-color: #005999;
    }
    textarea {
      padding: 8px;
      margin-bottom: 10px;
      width: 100%;
      height: 150px;
      box-sizing: border-box;
      font-family: monospace;
      resize: vertical;
      background-color: #2d2d2d;
      color: #d4d4d4;
      border: 1px solid #3c3c3c;
    }
    .legend {
      margin-bottom: 10px;
    }
    .legend-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-family: monospace;
      font-size: 12px;
      margin: 3px 0;
    }
    .swatch {
      flex: none;
      width: 12px;
      height: 12px;
      border-radius: 2px;
    }
    .legend-item.no-match .swatch {
      opacity: 0.35;
    }
    .legend-status {
      margin-left: auto;
      color: #9d9d9d;
    }
    .legend-item.no-match .legend-status {
      color: #e5a50a;
    }
    .help-text {
      font-size: 12px;
      color: #9d9d9d;
      margin-bottom: 10px;
    }
    h1 {
      color: #cccccc;
      font-size: 16px;
      margin-bottom: 15px;
    }
  </style>
</head>
<body>
  <h1>Commit Hash Highlighter</h1>
  <div class="help-text">
    Enter commit hashes below, one per line. 
    Click the button to start highlighting code from these commits. Changes to the list are saved and, while highlighting is on, applied automatically.
  </div>
  
  <textarea id="commitHashesTextarea" placeholder="Enter commit hashes here, one per line"></textarea>
  
  <div class="legend" id="legend"></div>

  <div>
    <button id="toggleHighlightButton">Highlighting: <span id="highlightStatus">OFF</span></button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const commitHashesTextarea = document.getElementById('commitHashesTextarea');
    const toggleHighlightButton = document.getElementById('toggleHighlightButton');
    const highlightStatusSpan = document.getElementById('highlightStatus');
    const legend = document.getElementById('legend');
    const palette = ${JSON.stringify(HIGHLIGHT_COLORS)};
    // What the extension found for each hash: { hash, status: 'ok' | 'gone' | 'unknown', lines }
    let matches = {};
    
    // Restore stored state from the webview if available
    const storedState = vscode.getState() || { commitHashes: [], isHighlightingEnabled: false };
    if (storedState.commitHashes && storedState.commitHashes.length > 0) {
      commitHashesTextarea.value = storedState.commitHashes.join('\\n');
    }
    if (storedState.isHighlightingEnabled) {
      highlightStatusSpan.textContent = 'ON';
    }
    
    // Hand any locally saved hashes to the extension first, in case the last edit was never sent.
    if (storedState.commitHashes && storedState.commitHashes.length > 0) {
      vscode.postMessage({ type: 'updateCommitHashes', value: storedState.commitHashes });
    }

    // Request state restoration from the extension
    vscode.postMessage({ type: 'viewStateRestored' });
    
    toggleHighlightButton.addEventListener('click', toggleHighlight);
    commitHashesTextarea.addEventListener('input', () => {
      renderLegend();
      scheduleHashUpdate();
    });

    // Save edited hashes right away (even with highlighting off) so they survive switching views.
    let hashUpdateTimer;
    function scheduleHashUpdate() {
      const hashes = parseCommitHashes(commitHashesTextarea.value);
      vscode.setState({ commitHashes: hashes, isHighlightingEnabled: highlightStatusSpan.textContent === 'ON' });
      clearTimeout(hashUpdateTimer);
      hashUpdateTimer = setTimeout(() => {
        vscode.postMessage({ type: 'updateCommitHashes', value: hashes });
      }, 400);
    }

    renderLegend();

    // Show the highlight colour used for each hash, in the same order the extension assigns them.
    function renderLegend() {
      legend.textContent = '';
      parseCommitHashes(commitHashesTextarea.value).forEach((hash, index) => {
        const [r, g, b] = palette[index % palette.length];
        const item = document.createElement('div');
        item.className = 'legend-item';
        const swatch = document.createElement('span');
        swatch.className = 'swatch';
        swatch.style.backgroundColor = 'rgb(' + r + ', ' + g + ', ' + b + ')';
        const label = document.createElement('span');
        label.textContent = hash;
        item.append(swatch, label);
        const match = matches[hash];
        if (match) {
          const status = document.createElement('span');
          status.className = 'legend-status';
          if (match.status === 'ok') {
            status.textContent = match.lines + (match.lines === 1 ? ' line' : ' lines');
          } else {
            item.className += ' no-match';
            status.textContent = match.status === 'gone' ? 'no code left' : 'not found';
            item.title = match.status === 'gone'
              ? 'None of this commit\\'s lines are in the current code'
              : 'No such commit in this repository';
          }
          item.append(status);
        }
        legend.append(item);
      });
    }
    
    function toggleHighlight() {
      const hashesText = commitHashesTextarea.value;
      const hashes = parseCommitHashes(hashesText);
      
      // Send updated hashes
      vscode.postMessage({ 
        type: 'updateCommitHashes', 
        value: hashes 
      });
      
      // Toggle highlighting
      const isEnabled = highlightStatusSpan.textContent === 'OFF';
      vscode.postMessage({ 
        type: 'toggleHighlighting', 
        value: isEnabled 
      });
      
      highlightStatusSpan.textContent = isEnabled ? 'ON' : 'OFF';
      
      // Save state in the webview
      vscode.setState({ 
        commitHashes: hashes, 
        isHighlightingEnabled: isEnabled 
      });
    }
    
    function parseCommitHashes(text) {
      if (!text) {
        return [];
      }
      const lines = text.split('\\n');
      return lines
        .map(line => line.trim())
        .filter(line => line.length > 0);
    }

    window.addEventListener('message', event => {
      const message = event.data;
      switch (message.type) {
        case 'updateCommitHashList':
          updateCommitHashesTextarea(message.value);
          break;
        case 'updateHighlightStatus':
          highlightStatusSpan.textContent = message.value ? 'ON' : 'OFF';
          break;
        case 'commitStatus':
          matches = {};
          for (const match of message.value) {
            matches[match.hash] = match;
          }
          renderLegend();
          break;
        case 'restoreState':
          // Don't overwrite what the user is typing right now.
          if (message.commitHashes && message.commitHashes.length > 0 && document.activeElement !== commitHashesTextarea) {
            commitHashesTextarea.value = message.commitHashes.join('\\n');
          }
          renderLegend();
          highlightStatusSpan.textContent = message.isHighlightingEnabled ? 'ON' : 'OFF';
          vscode.setState({
            commitHashes: message.commitHashes || [],
            isHighlightingEnabled: message.isHighlightingEnabled || false
          });
          break;
      }
    });

    function updateCommitHashesTextarea(hashes) {
      commitHashesTextarea.value = hashes.join('\\n');
      renderLegend();
      const currentState = vscode.getState() || {};
      vscode.setState({
        ...currentState,
        commitHashes: hashes
      });
    }
  </script>
</body>
</html>`;
  }

  public updateSidebarContent() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'updateCommitHashList',
        value: this._commitHashes
      });
    }
  }

  /**
   * Check which listed commits still have code in the current files and tell the webview.
   * While highlighting is on this also marks the touched files in the Explorer.
   */
  private async refreshCommitMatches() {
    const generation = ++this._matchGeneration;
    const hashes = this._commitHashes;
    const matches = hashes.length === 0
      ? []
      : this._isHighlightingEnabled
        ? await this._gitBlameService.updateFilesForCommits(hashes)
        : (await this._gitBlameService.analyzeCommits(hashes)).matches;
    // Skip results made outdated by a newer edit.
    if (!matches || generation !== this._matchGeneration) {
      return;
    }
    this._commitMatches = matches;
    this._postCommitMatches();
  }

  private _postCommitMatches() {
    this._view?.webview.postMessage({ type: 'commitStatus', value: this._commitMatches });
  }

  private saveState() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'restoreState',
        commitHashes: this._commitHashes,
        isHighlightingEnabled: this._isHighlightingEnabled
      });
      console.log("Saved state to webview storage");
    }
  }
  
  private restoreWebviewState() {
    if (this._view) {
      this._view.webview.postMessage({
        type: 'restoreState',
        commitHashes: this._commitHashes,
        isHighlightingEnabled: this._isHighlightingEnabled
      });
      this._postCommitMatches();
      console.log("Restored state to webview");
    }
  }

  private triggerHighlighting() {
    if (!this._isHighlightingEnabled || this._commitHashes.length === 0) {
      return;
    }
    // applyHighlighting replaces an editor's old decorations itself, so no separate clear (and flicker) is needed.
    for (const editor of vscode.window.visibleTextEditors) {
      this._gitBlameService.applyHighlighting(editor, this._commitHashes);
    }
  }

  public dispose() {
    this._disposables.forEach(disposable => disposable.dispose());
    this._gitBlameService.dispose();
  }
}

function getNonce() {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
