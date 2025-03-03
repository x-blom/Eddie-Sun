# Commit Hash Highlighter

## Overview
Commit Hash Highlighter is a Visual Studio Code extension that highlights code sections based on commit hashes and Change-IDs (from Gerrit). This helps developers quickly identify and review changes associated with specific commits.

## Features
- **Highlight Code by Commit Hash**: Enter one or more Git commit hashes, and the extension will highlight the relevant code sections.
- **Supports Gerrit Change-IDs**: In addition to Git hashes, you can highlight code based on Gerrit's Change-IDs.
- **Automatic File Decoration**: Displays an indicator on files that contain highlighted commits.
- **Real-Time Updates**: Automatically updates highlighting when switching files or modifying code.
- **Sidebar for Easy Management**: View and manage commit hashes through the extension sidebar.

## Installation

### From Visual Studio Marketplace
1. Open VS Code.
2. Go to the Extensions view (`Ctrl+Shift+X`).
3. Search for "Commit Hash Highlighter".
4. Click "Install".

### Manual Installation
1. Download the latest `.vsix` file from the [Releases](https://marketplace.visualstudio.com/) page.
2. In VS Code, open the command palette (`Ctrl+Shift+P`) and run `Extensions: Install from VSIX`.
3. Select the downloaded file.

## Usage

### Adding Commit Hashes
1. Open the **Commit Hash Highlighter** sidebar.
2. Enter commit hashes (or Change-IDs) in the text area, one per line.
3. Click the **Apply** button to start highlighting.

### Enabling/Disabling Highlighting
- Use the **Toggle Highlighting** button in the sidebar.
- Alternatively, use the command palette (`Ctrl+Shift+P`) and run `Commit Hash Highlighter: Toggle Highlighting`.

### How It Works
- The extension fetches file blame information using `git blame`.
- It highlights the corresponding lines for the given commit hashes.
- If a Gerrit Change-ID is provided, it retrieves all commit hashes associated with that Change-ID.

## Commands
| Command | Description |
|---------|-------------|
| `Commit Hash Highlighter: Toggle Highlighting` | Enable or disable highlighting |
| `Commit Hash Highlighter: Clear Highlights` | Remove all highlights |

## Configuration
No additional configuration is required. However, ensure that Git is installed and accessible from VS Code.

## Requirements
- Visual Studio Code `1.80.0` or later
- Git installed and accessible from the command line

## Contributing
Contributions are welcome! If you find bugs or have feature requests, please submit pull request on the [GitHub repository](https://github.com/x-blom/Eddie-Sun).

## License
This project is licensed under the **Apache License 2.0**. See the [LICENSE](LICENSE) file for details.
