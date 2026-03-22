import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type BranchNodeKind = 'root' | 'section' | 'remoteGroup' | 'branch';
type BranchScope = 'local' | 'remote';

interface BranchNodeData {
	label: string;
	kind: BranchNodeKind;
	branchRef?: string;
	isCurrent?: boolean;
	scope?: BranchScope;
	children?: BranchNodeData[];
}

export function activate(context: vscode.ExtensionContext) {
	const branchesProvider = new BranchesProvider();
	const commitsProvider = new StaticListProvider('git-commit', [
		'Initial extension scaffold',
		'Bottom panel container',
		'Native branch tree view'
	]);
	const changesProvider = new StaticListProvider('diff', [
		'src/extension.ts',
		'package.json',
		'media/jb-git.svg'
	]);

	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('jbGitBranches', branchesProvider),
		vscode.window.registerTreeDataProvider('jbGitCommits', commitsProvider),
		vscode.window.registerTreeDataProvider('jbGitChanges', changesProvider),
		vscode.commands.registerCommand('vs-jb-git.helloWorld', () => {
			vscode.window.showInformationMessage('Hello World from vs-jb-git!');
		}),
		vscode.commands.registerCommand('vs-jb-git.refresh', () => {
			branchesProvider.refresh();
		}),
		...registerBranchCommands(branchesProvider)
	);
}

function registerBranchCommands(branchesProvider: BranchesProvider): vscode.Disposable[] {
	return [
		vscode.commands.registerCommand('vs-jb-git.branch.checkout', async (node?: BranchItem) => {
			if (!node?.branchRef) {
				return;
			}

			try {
				if (node.scope === 'remote') {
					await branchesProvider.checkoutRemoteBranch(node.branchRef);
				} else {
					await branchesProvider.runGitOrThrow(['checkout', node.branchRef]);
				}

				branchesProvider.refresh();
				vscode.window.showInformationMessage(`[JBGit] Checked out ${node.branchRef}`);
			} catch (error) {
				branchesProvider.showGitError(error, `Checkout failed for ${node.branchRef}`);
			}
		}),
		vscode.commands.registerCommand('vs-jb-git.branch.newFrom', async (node?: BranchItem) => {
			if (!node?.branchRef) {
				return;
			}

			const newBranchName = await vscode.window.showInputBox({
				title: 'New Branch from Branch',
				prompt: `Create a new branch from ${node.branchRef}`,
				placeHolder: 'feature/my-branch',
				validateInput: (value) => value.trim().length === 0 ? 'Branch name is required.' : undefined
			});

			if (!newBranchName) {
				return;
			}

			try {
				await branchesProvider.runGitOrThrow(['checkout', '-b', newBranchName.trim(), node.branchRef]);
				branchesProvider.refresh();
				vscode.window.showInformationMessage(`[JBGit] Created and checked out ${newBranchName.trim()}`);
			} catch (error) {
				branchesProvider.showGitError(error, `Failed to create branch from ${node.branchRef}`);
			}
		}),
		vscode.commands.registerCommand('vs-jb-git.branch.rename', async (node?: BranchItem) => {
			if (!node?.branchRef || node.scope === 'remote') {
				return;
			}

			const newBranchName = await vscode.window.showInputBox({
				title: 'Rename Branch',
				prompt: `Rename ${node.branchRef}`,
				value: node.branchRef,
				validateInput: (value) => value.trim().length === 0 ? 'Branch name is required.' : undefined
			});

			if (!newBranchName) {
				return;
			}

			const trimmedName = newBranchName.trim();
			if (trimmedName === node.branchRef) {
				return;
			}

			try {
				if (node.isCurrent) {
					await branchesProvider.runGitOrThrow(['branch', '-m', trimmedName]);
				} else {
					await branchesProvider.runGitOrThrow(['branch', '-m', node.branchRef, trimmedName]);
				}

				branchesProvider.refresh();
				vscode.window.showInformationMessage(`[JBGit] Renamed ${node.branchRef} to ${trimmedName}`);
			} catch (error) {
				branchesProvider.showGitError(error, `Failed to rename ${node.branchRef}`);
			}
		}),
		vscode.commands.registerCommand('vs-jb-git.branch.delete', async (node?: BranchItem) => {
			if (!node?.branchRef || node.scope === 'remote' || node.isCurrent) {
				return;
			}

			const confirmation = await vscode.window.showWarningMessage(
				`Delete branch ${node.branchRef}?`,
				{ modal: true },
				'Delete'
			);

			if (confirmation !== 'Delete') {
				return;
			}

			try {
				await branchesProvider.runGitOrThrow(['branch', '-D', node.branchRef]);
				branchesProvider.refresh();
				vscode.window.showInformationMessage(`[JBGit] Deleted ${node.branchRef}`);
			} catch (error) {
				branchesProvider.showGitError(error, `Failed to delete ${node.branchRef}`);
			}
		}),
		...[
			['vs-jb-git.branch.checkoutAndRebase', 'Checkout and Rebase onto current'],
			['vs-jb-git.branch.compareWithCurrent', 'Compare with current'],
			['vs-jb-git.branch.showDiffWithWorkingTree', 'Show Diff with Working Tree'],
			['vs-jb-git.branch.rebaseCurrentOnto', 'Rebase current onto'],
			['vs-jb-git.branch.mergeIntoCurrent', 'Merge into current'],
			['vs-jb-git.branch.update', 'Update'],
			['vs-jb-git.branch.push', 'Push']
		].map(([commandId, title]) =>
			vscode.commands.registerCommand(commandId, async (node?: BranchItem) => {
				const target = node?.branchRef ?? 'unknown';
				vscode.window.showInformationMessage(`[JBGit] ${title}: ${target}`);
			})
		)
	];
}

class BranchesProvider implements vscode.TreeDataProvider<BranchItem> {
	private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<BranchItem | undefined>();

	public readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

	public refresh(): void {
		this.onDidChangeTreeDataEmitter.fire(undefined);
	}

	public async getTreeItem(element: BranchItem): Promise<vscode.TreeItem> {
		return element;
	}

	public async getChildren(element?: BranchItem): Promise<BranchItem[]> {
		if (element) {
			return element.children;
		}

		const root = await this.loadBranchTree();
		return root.children ?? [];
	}

	public async getCurrentBranchName(): Promise<string | undefined> {
		const current = await this.runGit(['branch', '--show-current']);
		return current[0];
	}

	public async checkoutRemoteBranch(remoteRef: string): Promise<void> {
		const localName = this.getLocalNameFromRemoteRef(remoteRef);
		const localBranches = await this.runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads']);

		if (localBranches.includes(localName)) {
			await this.runGitOrThrow(['checkout', localName]);
			return;
		}

		await this.runGitOrThrow(['checkout', '--track', remoteRef]);
	}

	public async runGitOrThrow(args: string[]): Promise<string> {
		const gitRoot = this.getWorkspaceRoot();
		if (!gitRoot) {
			throw new Error('Open a workspace folder first.');
		}

		try {
			const { stdout } = await execFileAsync('git', args, { cwd: gitRoot });
			return stdout;
		} catch (error) {
			throw this.toError(error);
		}
	}

	public showGitError(error: unknown, fallbackMessage: string): void {
		const message = error instanceof Error && error.message.trim().length > 0
			? error.message
			: fallbackMessage;
		void vscode.window.showErrorMessage(`[JBGit] ${message}`);
	}

	private async loadBranchTree(): Promise<BranchItem> {
		const gitRoot = this.getWorkspaceRoot();
		if (!gitRoot) {
			return new BranchItem({
				label: 'Branches',
				kind: 'root',
				children: [
					{
						label: 'Open a workspace folder to load Git branches.',
						kind: 'section'
					}
				]
			});
		}

		const [currentBranchLines, localBranchLines, remoteBranchLines] = await Promise.all([
			this.runGit(['branch', '--show-current']),
			this.runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads']),
			this.runGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes'])
		]);

		const currentBranch = currentBranchLines[0] ?? 'Detached HEAD';
		const localBranchSet = new Set(localBranchLines);
		if (!localBranchSet.has(currentBranch) && currentBranch !== 'Detached HEAD') {
			localBranchLines.unshift(currentBranch);
		}

		const remoteGroups = new Map<string, string[]>();
		for (const remoteRef of remoteBranchLines) {
			const parts = remoteRef.split('/');
			if (parts.length < 2) {
				continue;
			}

			const remoteName = parts[0];
			const branchName = parts.slice(1).join('/');
			if (branchName === 'HEAD') {
				continue;
			}

			if (!remoteGroups.has(remoteName)) {
				remoteGroups.set(remoteName, []);
			}

			remoteGroups.get(remoteName)?.push(branchName);
		}

		const remoteNodes: BranchNodeData[] = [...remoteGroups.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([remoteName, branchNames]) => ({
				label: remoteName,
				kind: 'remoteGroup',
				children: branchNames
					.sort((a, b) => a.localeCompare(b))
					.map((branchName) => ({
						label: branchName,
						kind: 'branch',
						branchRef: `${remoteName}/${branchName}`,
						isCurrent: false,
						scope: 'remote'
					}))
			}));

		return new BranchItem({
			label: 'Branches',
			kind: 'root',
			children: [
				{
					label: 'HEAD (Current Branch)',
					kind: 'section',
					children: [
						{
							label: currentBranch,
							kind: 'branch',
							branchRef: currentBranch,
							isCurrent: true,
							scope: 'local'
						}
					]
				},
				{
					label: 'Local',
					kind: 'section',
					children: localBranchLines.length > 0
						? localBranchLines
							.sort((a, b) => a.localeCompare(b))
							.map((branchName) => ({
								label: branchName,
								kind: 'branch',
								branchRef: branchName,
								isCurrent: branchName === currentBranch,
								scope: 'local'
							}))
						: [
							{
								label: 'No local branches',
								kind: 'section'
							}
						]
				},
				{
					label: 'Remote',
					kind: 'section',
					children: remoteNodes.length > 0
						? remoteNodes
						: [
							{
								label: 'No remote branches',
								kind: 'section'
							}
						]
				}
			]
		});
	}

	private getWorkspaceRoot(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	private async runGit(args: string[]): Promise<string[]> {
		const gitRoot = this.getWorkspaceRoot();
		if (!gitRoot) {
			return [];
		}

		try {
			const { stdout } = await execFileAsync('git', args, { cwd: gitRoot });
			return stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		} catch {
			return [];
		}
	}

	private getLocalNameFromRemoteRef(remoteRef: string): string {
		const parts = remoteRef.split('/');
		return parts.slice(1).join('/') || remoteRef;
	}

	private toError(error: unknown): Error {
		if (error instanceof Error) {
			return error;
		}

		return new Error(String(error));
	}
}

class BranchItem extends vscode.TreeItem {
	public readonly branchRef?: string;
	public readonly isCurrent: boolean;
	public readonly scope?: BranchScope;
	public readonly children: BranchItem[];

	constructor(data: BranchNodeData) {
		super(
			data.label,
			data.children && data.children.length > 0
				? vscode.TreeItemCollapsibleState.Expanded
				: vscode.TreeItemCollapsibleState.None
		);

		this.branchRef = data.branchRef;
		this.isCurrent = data.isCurrent ?? false;
		this.scope = data.scope;
		this.children = (data.children ?? []).map((child) => new BranchItem(child));

		if (data.kind === 'branch') {
			this.contextValue = data.isCurrent
				? 'currentBranch'
				: data.scope === 'remote'
					? 'remoteBranch'
					: 'localBranch';
			this.iconPath = data.isCurrent
				? new vscode.ThemeIcon('target')
				: data.scope === 'remote'
					? new vscode.ThemeIcon('cloud')
					: new vscode.ThemeIcon('git-branch');
			this.description = data.isCurrent ? 'current' : data.scope === 'remote' ? 'remote' : undefined;
			this.tooltip = data.branchRef ?? data.label;
		} else if (data.kind === 'remoteGroup') {
			this.contextValue = 'remoteGroup';
			this.iconPath = new vscode.ThemeIcon('cloud');
		} else if (data.kind === 'section') {
			this.contextValue = 'section';
			this.iconPath = data.children && data.children.length > 0
				? new vscode.ThemeIcon('folder')
				: new vscode.ThemeIcon('info');
		}
	}
}

class StaticListProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
	constructor(
		private readonly iconId: string,
		private readonly items: string[]
	) {}

	public getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
		return element;
	}

	public getChildren(): vscode.TreeItem[] {
		return this.items.map((item) => {
			const treeItem = new vscode.TreeItem(item, vscode.TreeItemCollapsibleState.None);
			treeItem.iconPath = new vscode.ThemeIcon(this.iconId);
			return treeItem;
		});
	}
}

export function deactivate() {}
