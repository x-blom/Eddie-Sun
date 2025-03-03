import * as vscode from 'vscode';
import { SidebarProvider } from './SidebarProvider';

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "commit-hash-highlighter" is now active!');

  try {
    // Create and register the sidebar provider (webview)
    const sidebarProvider = new SidebarProvider(context.extensionUri);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        'commit-hash-highlighter-sidebar',
        sidebarProvider
      )
    );

    // Command to open/focus the sidebar
    context.subscriptions.push(
      vscode.commands.registerCommand('commit-hash-highlighter.openSidebar', () => {
        vscode.commands.executeCommand('commit-hash-highlighter-sidebar.focus');
      })
    );

    // Ensure proper disposal
    context.subscriptions.push({
      dispose: () => {
        sidebarProvider.dispose();
      }
    });

    console.log("Extension activation completed successfully");
  } catch (error) {
    console.error("Error during extension activation:", error);
  }
}

export function deactivate() {
  // Clean-up is handled via context.subscriptions disposal.
}
