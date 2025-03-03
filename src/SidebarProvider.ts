import * as vscode from 'vscode';
import { GitBlameService } from './GitBlameService';

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  private _commitHashes: string[] = [];
  private _isHighlightingEnabled: boolean = false;
  private _gitBlameService: GitBlameService;

  constructor(private readonly _extensionUri: vscode.Uri) {
    this._gitBlameService = new GitBlameService();

    // Listen to active editor changes
    vscode.window.onDidChangeActiveTextEditor(editor => {
      if (editor && this._isHighlightingEnabled) {
        console.log("Active editor changed - attempting to highlight");
        this.triggerHighlighting();
      }
    });

    // Listen to document changes to update highlighting
    vscode.workspace.onDidChangeTextDocument(event => {
      const activeEditor = vscode.window.activeTextEditor;
      if (activeEditor && event.document === activeEditor.document && this._isHighlightingEnabled) {
        console.log("Document changed - re-applying highlighting");
        const filePath = activeEditor.document.uri.fsPath;
        this._gitBlameService.clearBlameCache(filePath);
        this.triggerHighlighting();
      }
    });
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
            this._gitBlameService.clearAllBlameCache();
            if (this._isHighlightingEnabled && this._commitHashes.length > 0) {
              console.log("Highlighting enabled - updating files for commits");
              // Fetch and mark files changed by these commits.
              this._gitBlameService.updateFilesForCommits(this._commitHashes);
              this.triggerHighlighting();
            }
            vscode.window.showInformationMessage(`Updated commit hashes (${newHashes.length})`);
          }
          this.saveState();
          break;
        }
        case 'toggleHighlighting': {
          this._isHighlightingEnabled = data.value;
          console.log(`Highlighting toggled to: ${this._isHighlightingEnabled}`);
          if (this._isHighlightingEnabled) {
            if (this._commitHashes.length > 0) {
              console.log("Highlighting enabled - updating files for commits");
              this._gitBlameService.updateFilesForCommits(this._commitHashes);
            }
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
    Click "highligh on" to start highlighting code from these commits.
  </div>
  
  <textarea id="commitHashesTextarea" placeholder="Enter commit hashes here, one per line"></textarea>
  
  <div>
    <button id="toggleHighlightButton">Highlighting: <span id="highlightStatus">OFF</span></button>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const commitHashesTextarea = document.getElementById('commitHashesTextarea');
    const toggleHighlightButton = document.getElementById('toggleHighlightButton');
    const highlightStatusSpan = document.getElementById('highlightStatus');
    
    // Restore stored state from the webview if available
    const storedState = vscode.getState() || { commitHashes: [], isHighlightingEnabled: false };
    if (storedState.commitHashes && storedState.commitHashes.length > 0) {
      commitHashesTextarea.value = storedState.commitHashes.join('\\n');
    }
    if (storedState.isHighlightingEnabled) {
      highlightStatusSpan.textContent = 'ON';
    }
    
    // Request state restoration from the extension
    vscode.postMessage({ type: 'viewStateRestored' });
    
    toggleHighlightButton.addEventListener('click', toggleHighlight);
    
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
        case 'restoreState':
          if (message.commitHashes && message.commitHashes.length > 0) {
            commitHashesTextarea.value = message.commitHashes.join('\\n');
          }
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
      console.log("Restored state to webview");
    }
  }

  private triggerHighlighting() {
    this.highlightActiveEditor();
    this.highlightAllVisibleEditors();
  }
  
  private highlightActiveEditor() {
    const activeEditor = vscode.window.activeTextEditor;
    if (activeEditor) {
      console.log("Triggering highlighting in active editor");
      this._gitBlameService.clearHighlighting(activeEditor);
      if (this._isHighlightingEnabled && this._commitHashes.length > 0) {
        console.log(`Applying highlighting for ${this._commitHashes.length} hashes`);
        this._gitBlameService.applyHighlighting(activeEditor, this._commitHashes);
      } else {
        console.log(`Highlighting not applied: enabled=${this._isHighlightingEnabled}, hashes=${this._commitHashes.length}`);
      }
    } else {
      console.log("No active editor found for highlighting");
    }
  }
  
  private highlightAllVisibleEditors() {
    if (!this._isHighlightingEnabled || this._commitHashes.length === 0) {
      return;
    }
    
    vscode.window.visibleTextEditors.forEach(editor => {
      if (editor === vscode.window.activeTextEditor) {
        return;
      }
      this._gitBlameService.clearHighlighting(editor);
      this._gitBlameService.applyHighlighting(editor, this._commitHashes);
    });
  }

  public dispose() {
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
