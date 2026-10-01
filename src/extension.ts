import * as vscode from 'vscode';
import * as path from 'node:path';

type NodeKind = 'root' | 'folder' | 'file';
const treeMimeType = 'application/vnd.code.tree.sanvsexpExplorer';
const criticalBranches = new Set(['main', 'master', 'init', 'develop', 'release']);

interface ExplorerNode {
  readonly uri: vscode.Uri;
  readonly kind: NodeKind;
  readonly label: string;
}

interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { readonly name?: string };
    readonly onDidChange: vscode.Event<void>;
  };
}

interface GitApi {
  readonly repositories: readonly GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

function isUriEqualOrParent(parentUri: vscode.Uri, childUri: vscode.Uri): boolean {
  if (parentUri.scheme !== childUri.scheme) {
    return false;
  }
  if (parentUri.scheme !== 'file') {
    return parentUri.toString() === childUri.toString();
  }

  const relativePath = path.relative(parentUri.fsPath, childUri.fsPath);
  return relativePath === '' ||
    (relativePath !== '..' && !relativePath.startsWith(`..${path.sep}`) && !path.isAbsolute(relativePath));
}

class WorkspaceExplorer implements
  vscode.TreeDataProvider<ExplorerNode>,
  vscode.TreeDragAndDropController<ExplorerNode>,
  vscode.FileDecorationProvider,
  vscode.Disposable {
  readonly dragMimeTypes = [treeMimeType];
  readonly dropMimeTypes = [treeMimeType];
  private readonly treeChanged = new vscode.EventEmitter<ExplorerNode | undefined | null | void>();
  readonly onDidChangeTreeData = this.treeChanged.event;
  private readonly decorationsChanged = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.decorationsChanged.event;
  private readonly fileWatchers: vscode.Disposable[] = [];
  private readonly gitSubscriptions: vscode.Disposable[] = [];
  private readonly repositorySubscriptions = new Map<GitRepository, vscode.Disposable>();
  private gitApi: GitApi | undefined;

  getTreeItem(node: ExplorerNode): vscode.TreeItem {
    const isFile = node.kind === 'file';
    const item = new vscode.TreeItem(
      node.label,
      isFile ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed
    );
    item.id = node.uri.toString();
    item.resourceUri = node.uri;
    item.contextValue = node.kind;

    if (isFile) {
      item.command = {
        command: 'vscode.open',
        title: 'Open File',
        arguments: [node.uri]
      };
    }

    return item;
  }

  async getChildren(node?: ExplorerNode): Promise<ExplorerNode[]> {
    if (!node) {
      return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
        uri: folder.uri,
        kind: 'root',
        label: this.getRepositoryLabel(folder.uri, folder.name, true)
      }));
    }

    if (node.kind === 'file') {
      return [];
    }

    try {
      const entries = await vscode.workspace.fs.readDirectory(node.uri);
      return entries
        .map(([name, type]) => {
          const isDirectory = (type & vscode.FileType.Directory) !== 0;
          return {
            uri: vscode.Uri.joinPath(node.uri, name),
            kind: isDirectory ? 'folder' : 'file',
            label: isDirectory
              ? this.getRepositoryLabel(vscode.Uri.joinPath(node.uri, name), name)
              : name
          } satisfies ExplorerNode;
        })
        .sort((first, second) => {
          if (first.kind !== second.kind) {
            return first.kind === 'folder' ? -1 : 1;
          }
          return first.label.localeCompare(second.label, undefined, { sensitivity: 'base' });
        });
    } catch (error) {
      void vscode.window.showErrorMessage(`Unable to read ${node.uri.fsPath}: ${String(error)}`);
      return [];
    }
  }

  refresh(node?: ExplorerNode): void {
    this.treeChanged.fire(node);
  }

  handleDrag(source: readonly ExplorerNode[], dataTransfer: vscode.DataTransfer): void {
    const uris = source
      .filter((node) => node.kind !== 'root')
      .map((node) => node.uri.toString());
    dataTransfer.set(treeMimeType, new vscode.DataTransferItem(uris));
  }

  async handleDrop(target: ExplorerNode | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const destination = target?.kind === 'file'
      ? vscode.Uri.joinPath(target.uri, '..')
      : target?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
    const sources = dataTransfer.get(treeMimeType)?.value as string[] | undefined;
    if (!destination || !sources) {
      return;
    }

    for (const sourceText of sources) {
      const source = vscode.Uri.parse(sourceText);
      const targetUri = vscode.Uri.joinPath(destination, path.basename(source.fsPath));
      if (isUriEqualOrParent(source, destination) || source.toString() === targetUri.toString()) {
        continue;
      }
      await vscode.workspace.fs.rename(source, targetUri);
    }
    this.refresh();
  }

  watchWorkspace(): void {
    this.disposeFileWatchers();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(folder, '**/*')
      );
      const refreshForUri = (uri: vscode.Uri) => {
        if (!path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).includes('.git')) {
          this.refresh();
        }
      };
      this.fileWatchers.push(
        watcher,
        watcher.onDidCreate(refreshForUri),
        watcher.onDidDelete(refreshForUri),
        watcher.onDidChange(refreshForUri)
      );
    }
  }

  private disposeFileWatchers(): void {
    for (const watcher of this.fileWatchers.splice(0)) {
      watcher.dispose();
    }
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const isWorkspaceRoot = vscode.workspace.workspaceFolders?.some(
      (folder) => folder.uri.toString() === uri.toString()
    ) ?? false;
    const repository = this.getRepository(uri, isWorkspaceRoot);
    const branch = repository?.state.HEAD?.name;
    if (!branch) {
      return undefined;
    }

    const normalizedBranch = branch.toLowerCase();
    const isCritical = criticalBranches.has(normalizedBranch) || normalizedBranch.startsWith('release/');
    return new vscode.FileDecoration(
      undefined,
      isCritical
        ? `Critical branch ${branch}: avoid committing or pushing directly to this branch.`
        : `Branch ${branch}`,
      new vscode.ThemeColor(isCritical
        ? 'gitDecoration.deletedResourceForeground'
        : 'gitDecoration.addedResourceForeground')
    );
  }

  attachGit(api: GitApi): void {
    this.gitApi = api;
    this.gitSubscriptions.push(
      api.onDidOpenRepository((repository) => {
        this.watchRepository(repository);
        this.refresh();
        this.decorationsChanged.fire(undefined);
      }),
      api.onDidCloseRepository((repository) => {
        this.repositorySubscriptions.get(repository)?.dispose();
        this.repositorySubscriptions.delete(repository);
        this.refresh();
        this.decorationsChanged.fire(undefined);
      })
    );
    api.repositories.forEach((repository) => this.watchRepository(repository));
    this.refresh();
  }

  private watchRepository(repository: GitRepository): void {
    if (!this.repositorySubscriptions.has(repository)) {
      this.repositorySubscriptions.set(repository, repository.state.onDidChange(() => {
        this.refresh();
        this.decorationsChanged.fire(undefined);
      }));
    }
  }

  private getRepository(uri: vscode.Uri, includeParent = false): GitRepository | undefined {
    return this.gitApi?.repositories
      .filter((candidate) => includeParent
        ? isUriEqualOrParent(candidate.rootUri, uri)
        : candidate.rootUri.toString() === uri.toString())
      .sort((first, second) => second.rootUri.fsPath.length - first.rootUri.fsPath.length)[0];
  }

  private getRepositoryLabel(uri: vscode.Uri, label: string, includeParent = false): string {
    const repository = this.getRepository(uri, includeParent);
    const branch = repository?.state.HEAD?.name;
    return branch ? `${label} [${branch}]` : label;
  }

  dispose(): void {
    this.disposeFileWatchers();
    for (const subscription of this.gitSubscriptions.splice(0)) {
      subscription.dispose();
    }
    for (const subscription of this.repositorySubscriptions.values()) {
      subscription.dispose();
    }
    this.repositorySubscriptions.clear();
    this.treeChanged.dispose();
    this.decorationsChanged.dispose();
  }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const provider = new WorkspaceExplorer();
  const treeView = vscode.window.createTreeView('sanvsexp.workspaceExplorer', {
    treeDataProvider: provider,
    showCollapseAll: true,
    canSelectMany: true,
    dragAndDropController: provider
  });
  context.subscriptions.push(
    provider,
    treeView,
    vscode.window.registerFileDecorationProvider(provider)
  );
  provider.watchWorkspace();
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.watchWorkspace();
      provider.refresh();
    })
  );

  const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (gitExtension) {
    const git = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
    provider.attachGit(git.getAPI(1));
  }

  const selectedNodes = (node?: ExplorerNode): readonly ExplorerNode[] => {
    if (node && !treeView.selection.includes(node)) {
      return [node];
    }
    return treeView.selection.length > 0 ? treeView.selection : node ? [node] : [];
  };

  const selectedNode = (node?: ExplorerNode): ExplorerNode | undefined => selectedNodes(node)[0];

  const getCreationDirectory = (node?: ExplorerNode): vscode.Uri | undefined => {
    const target = selectedNode(node);
    if (target?.kind === 'file') {
      return vscode.Uri.joinPath(target.uri, '..');
    }
    return target?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;
  };

  const askForName = async (prompt: string, value?: string): Promise<string | undefined> => {
    const name = await vscode.window.showInputBox({ prompt, value });
    if (name === undefined) {
      return undefined;
    }

    const trimmedName = name.trim();
    if (!trimmedName || trimmedName === '.' || trimmedName === '..' || /[\\/]/.test(trimmedName)) {
      void vscode.window.showErrorMessage('Enter a name without path separators.');
      return undefined;
    }
    return trimmedName;
  };

  let clipboard: { uris: vscode.Uri[]; cut: boolean } | undefined;

  context.subscriptions.push(
    vscode.commands.registerCommand('sanvsexp.refreshExplorer', () => provider.refresh()),
    vscode.commands.registerCommand('sanvsexp.createFile', async (node?: ExplorerNode) => {
      const directory = getCreationDirectory(node);
      if (!directory) {
        return;
      }
      const name = await askForName('File name');
      if (name) {
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, name), new Uint8Array());
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('sanvsexp.createFolder', async (node?: ExplorerNode) => {
      const directory = getCreationDirectory(node);
      if (!directory) {
        return;
      }
      const name = await askForName('Folder name');
      if (name) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(directory, name));
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('sanvsexp.copy', async (node?: ExplorerNode) => {
      const nodes = selectedNodes(node).filter((entry) => entry.kind !== 'root');
      if (nodes.length > 0) {
        clipboard = { uris: nodes.map((entry) => entry.uri), cut: false };
        await vscode.env.clipboard.writeText(clipboard.uris.map((uri) => uri.fsPath).join('\n'));
      }
    }),
    vscode.commands.registerCommand('sanvsexp.cut', async (node?: ExplorerNode) => {
      const nodes = selectedNodes(node).filter((entry) => entry.kind !== 'root');
      if (nodes.length > 0) {
        clipboard = { uris: nodes.map((entry) => entry.uri), cut: true };
        await vscode.env.clipboard.writeText(clipboard.uris.map((uri) => uri.fsPath).join('\n'));
      }
    }),
    vscode.commands.registerCommand('sanvsexp.paste', async (node?: ExplorerNode) => {
      const directory = getCreationDirectory(node);
      if (!directory || !clipboard) {
        return;
      }
      for (const source of clipboard.uris) {
        const destination = vscode.Uri.joinPath(directory, path.basename(source.fsPath));
        if (isUriEqualOrParent(source, directory) || source.toString() === destination.toString()) {
          continue;
        }
        if (clipboard.cut) {
          await vscode.workspace.fs.rename(source, destination);
        } else {
          await vscode.workspace.fs.copy(source, destination);
        }
      }
      if (clipboard.cut) {
        clipboard = undefined;
      }
      provider.refresh();
    }),
    vscode.commands.registerCommand('sanvsexp.copyPath', async (node?: ExplorerNode) => {
      const target = selectedNode(node);
      if (target) {
        await vscode.env.clipboard.writeText(target.uri.fsPath);
      }
    }),
    vscode.commands.registerCommand('sanvsexp.rename', async (node?: ExplorerNode) => {
      const target = selectedNode(node);
      if (!target || target.kind === 'root') {
        return;
      }
      const name = await askForName('New name', target.label);
      if (name) {
        await vscode.workspace.fs.rename(target.uri, vscode.Uri.joinPath(target.uri, '..', name));
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('sanvsexp.delete', async (node?: ExplorerNode) => {
      const target = selectedNode(node);
      if (!target || target.kind === 'root') {
        return;
      }
      const choice = await vscode.window.showWarningMessage(
        `Delete "${target.label}"?`,
        { modal: true },
        'Delete'
      );
      if (choice === 'Delete') {
        await vscode.workspace.fs.delete(target.uri, { recursive: true, useTrash: true });
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand('sanvsexp.revealInExplorer', async (node?: ExplorerNode) => {
      const target = selectedNode(node);
      if (target) {
        await vscode.commands.executeCommand('revealInExplorer', target.uri);
      }
    })
  );
}

export function deactivate(): void {}
