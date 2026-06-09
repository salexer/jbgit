import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { existsSync, watch, type FSWatcher } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type BranchScope = 'local' | 'remote';
type BranchAction =
	| 'checkout'
	| 'newFrom'
	| 'checkoutAndRebase'
	| 'compareWithCurrent'
	| 'showDiffWithWorkingTree'
	| 'rebaseCurrentOnto'
	| 'mergeIntoCurrent'
	| 'update'
	| 'forceUpdate'
	| 'push'
	| 'rename'
	| 'delete';

interface BranchLeafNode {
	type: 'branch';
	id: string;
	label: string;
	branchRef: string;
	scope: BranchScope;
	isCurrent: boolean;
	isDefaultBranch?: boolean;
	upstream?: string;
	ahead?: number;
	behind?: number;
	taskUrl?: string;
	hasMissingUpstream?: boolean;
	requiresForceUpdate?: boolean;
}

interface BranchGroupNode {
	type: 'group';
	id: string;
	label: string;
	kind: 'section' | 'remote';
	expanded: boolean;
	children: BranchTreeNode[];
}

type BranchTreeNode = BranchLeafNode | BranchGroupNode;

interface BranchesViewState {
	head?: {
		label: string;
		branchRef: string;
		isDefaultBranch?: boolean;
	};
	nodes: BranchTreeNode[];
}

interface BranchActionMessage {
	type: 'branchAction';
	action: BranchAction;
	branchRef: string;
	scope: BranchScope;
	isCurrent: boolean;
}

interface OpenExternalMessage {
	type: 'openExternal';
	url: string;
}

type CommitAction =
	| 'copyRevision'
	| 'createPatch'
	| 'checkoutRevision'
	| 'showRepositoryAtRevision'
	| 'compareWithLocal'
	| 'cherryPick'
	| 'resetCurrentBranchToHere'
	| 'revertCommit'
	| 'undoCommit'
	| 'editCommitMessage'
	| 'fixup'
	| 'squashInto'
	| 'interactiveRebaseFromHere'
	| 'newBranch'
	| 'newTag'
	| 'goToParentCommit'
	| 'goToChildCommit'
	| 'refresh';

interface CommitRecord {
	hash: string;
	shortHash: string;
	authorName: string;
	authorEmail: string;
	dateIso: string;
	refs: string[];
	subject: string;
	body: string;
	parents: string[];
	paths: string[];
	isInCurrentBranch: boolean;
	isHeadCommit: boolean;
	isMergeCommit: boolean;
	authoredByCurrentUser: boolean;
}

interface CommitsViewState {
	currentBranch?: string;
	loadedBranch?: string;
	commits: CommitRecord[];
	branchOptions: Array<{ value: string; label: string }>;
	userOptions: Array<{ value: string; label: string }>;
	dateOptions: Array<{ value: string; label: string }>;
	pathOptions: Array<{ value: string; label: string }>;
}

interface CommitActionMessage {
	type: 'commitAction';
	action: CommitAction;
	hash: string;
}

interface CommitBranchFilterMessage {
	type: 'branchFilterChanged';
	branch: string;
}

interface CommitSelectionMessage {
	type: 'commitSelected';
	hash: string | null;
}

interface FocusChangesMessage {
	type: 'focusChanges';
}

interface ChangesOpenDiffMessage {
	type: 'openFileDiff';
	path: string;
}

type JbGitFocusView = 'branches' | 'commits' | 'changes';

interface FocusStateMessage {
	type: 'focusState';
	focused: boolean;
}

interface ChangesFileNode {
	type: 'file';
	id: string;
	path: string;
	name: string;
	added: number;
	deleted: number;
	status: string;
	originalPath?: string;
}

interface ChangesTreeNode {
	type: 'directory';
	id: string;
	name: string;
	path: string;
	children: Array<ChangesTreeNode | ChangesFileNode>;
}

interface ChangesViewState {
	selectedCommitHash?: string;
	files: Array<{ path: string; added: number; deleted: number; status: string; originalPath?: string }>;
}

let currentFocusedJbGitView: JbGitFocusView | undefined;
const WEBVIEW_FOCUS_DELAY_MS = 75;

export function activate(context: vscode.ExtensionContext) {
	const gitCommitService = new GitCommitService();
	const branchesProvider = new BranchesWebviewProvider(context.extensionUri, new GitBranchService());
	const changesProvider = new ChangesWebviewProvider(context.extensionUri, gitCommitService);
	const commitsProvider = new CommitsWebviewProvider(
		context.extensionUri,
		gitCommitService,
		async (hash) => {
			await changesProvider.setSelectedCommit(hash);
		},
		async () => {
			await changesProvider.focus();
		}
	);
	const focusJbGitCommand = () => {
		void branchesProvider.focus();
	};
	const focusCommitsCommand = () => {
		void commitsProvider.focus();
	};
	const togglePrimaryFocusCommand = () => {
		if (currentFocusedJbGitView === 'branches') {
			void commitsProvider.focus();
			return;
		}

		if (currentFocusedJbGitView === 'commits' || currentFocusedJbGitView === 'changes') {
			void branchesProvider.focus();
			return;
		}

		void branchesProvider.focus();
	};

	context.subscriptions.push(
		branchesProvider,
		commitsProvider,
		changesProvider,
		vscode.window.registerWebviewViewProvider('jbGitBranches', branchesProvider, {
			webviewOptions: {
				retainContextWhenHidden: true
			}
		}),
		vscode.window.registerWebviewViewProvider('jbGitCommits', commitsProvider, {
			webviewOptions: {
				retainContextWhenHidden: true
			}
		}),
		vscode.window.registerWebviewViewProvider('jbGitChanges', changesProvider, {
			webviewOptions: {
				retainContextWhenHidden: true
			}
		}),
		vscode.commands.registerCommand('vs-jb-git.helloWorld', () => {
			vscode.window.showInformationMessage('Hello World from vs-jb-git!');
		}),
		vscode.commands.registerCommand('vs-jb-git.focusPanel', focusJbGitCommand),
		vscode.commands.registerCommand('vs-jb-git.focusCommits', focusCommitsCommand),
		vscode.commands.registerCommand('vs-jb-git.togglePrimaryFocus', togglePrimaryFocusCommand),
		vscode.commands.registerCommand('vs-jb-git.refresh', async () => {
			await branchesProvider.refresh();
			await commitsProvider.refresh();
			await changesProvider.refresh();
		}),
		vscode.workspace.onDidChangeConfiguration(async (event) => {
			if (event.affectsConfiguration('jbGit.branchTaskUrl') || event.affectsConfiguration('jbGit.branchTaskUrlTemplate')) {
				await branchesProvider.refresh();
			}
		})
	);
}

async function revealJbGitView(viewId: 'jbGitBranches' | 'jbGitCommits' | 'jbGitChanges'): Promise<void> {
	void viewId;
	try {
		await vscode.commands.executeCommand('workbench.panel.jbGitPanel');
		return;
	} catch {
		// Fall through.
	}

	try {
		await vscode.commands.executeCommand('workbench.view.extension.jbGitPanel');
	} catch {
		// Best effort only.
	}
}

function scheduleWebviewFocus(view: vscode.WebviewView | undefined): void {
	if (!view) {
		return;
	}

	setTimeout(() => {
		void (async () => {
			try {
				view.show(false);
				await view.webview.postMessage({ type: 'focusView' });
			} catch {
				// Best effort only.
			}
		})();
	}, WEBVIEW_FOCUS_DELAY_MS);
}

async function updateJbGitFocusContext(view: JbGitFocusView, focused: boolean): Promise<void> {
	if (focused) {
		currentFocusedJbGitView = view;
		await vscode.commands.executeCommand('setContext', 'jbGit.focusedView', view);
		return;
	}

	if (currentFocusedJbGitView === view) {
		currentFocusedJbGitView = undefined;
		await vscode.commands.executeCommand('setContext', 'jbGit.focusedView', undefined);
	}
}

class BranchesWebviewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private readonly gitWatcher: GitMetadataWatcher;
	private pendingFocus = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly gitService: GitBranchService
	) {
		this.gitWatcher = new GitMetadataWatcher(this.gitService, async () => {
			await this.postState();
		});
	}

	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		await this.gitWatcher.ensureWatching();

		webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
			if (!message || typeof message !== 'object' || !('type' in message)) {
				return;
			}

			const typedMessage = message as { type: string };
			if (typedMessage.type === 'ready' || typedMessage.type === 'refresh') {
				await this.postState();
				if (typedMessage.type === 'ready' && this.pendingFocus) {
					scheduleWebviewFocus(this.view);
					this.pendingFocus = false;
				}
				return;
			}

			if (typedMessage.type === 'branchAction') {
				await this.handleBranchAction(message as BranchActionMessage);
			}

			if (typedMessage.type === 'openExternal') {
				await this.handleOpenExternal(message as OpenExternalMessage);
				return;
			}

			if (typedMessage.type === 'focusState') {
				await updateJbGitFocusContext('branches', Boolean((message as FocusStateMessage).focused));
			}
		});
	}

	public async refresh(): Promise<void> {
		await this.postState();
	}

	public async focus(): Promise<void> {
		this.pendingFocus = true;
		if (this.view) {
			scheduleWebviewFocus(this.view);
			this.pendingFocus = false;
			return;
		}

		await revealJbGitView('jbGitBranches');
	}

	private async handleBranchAction(message: BranchActionMessage): Promise<void> {
		try {
			switch (message.action) {
				case 'checkout':
					if (message.scope === 'remote') {
						await this.gitService.checkoutRemoteBranch(message.branchRef);
					} else {
						await this.gitService.runGitOrThrow(['checkout', message.branchRef]);
					}
					await vscode.window.showInformationMessage(`[JBGit] Checked out ${message.branchRef}`);
					return;
				case 'newFrom': {
					const newBranchName = await vscode.window.showInputBox({
						title: 'New Branch from Branch',
						prompt: `Create a new branch from ${message.branchRef}`,
						placeHolder: 'feature/my-branch',
						validateInput: (value) => value.trim().length === 0 ? 'Branch name is required.' : undefined
					});
					if (!newBranchName) {
						return;
					}

					await this.gitService.runGitOrThrow(['checkout', '-b', newBranchName.trim(), message.branchRef]);
					await vscode.window.showInformationMessage(`[JBGit] Created and checked out ${newBranchName.trim()}`);
					return;
				}
				case 'rename': {
					if (message.scope === 'remote') {
						return;
					}

					const newBranchName = await vscode.window.showInputBox({
						title: 'Rename Branch',
						prompt: `Rename ${message.branchRef}`,
						value: message.branchRef,
						validateInput: (value) => value.trim().length === 0 ? 'Branch name is required.' : undefined
					});
					if (!newBranchName) {
						return;
					}

					const trimmedName = newBranchName.trim();
					if (trimmedName === message.branchRef) {
						return;
					}

					if (message.isCurrent) {
						await this.gitService.runGitOrThrow(['branch', '-m', trimmedName]);
					} else {
						await this.gitService.runGitOrThrow(['branch', '-m', message.branchRef, trimmedName]);
					}

					await vscode.window.showInformationMessage(`[JBGit] Renamed ${message.branchRef} to ${trimmedName}`);
					return;
				}
				case 'delete': {
					if (message.scope === 'remote' || message.isCurrent) {
						return;
					}

					const confirmation = await vscode.window.showWarningMessage(
						`Delete branch ${message.branchRef}?`,
						{ modal: true },
						'Delete'
					);
					if (confirmation !== 'Delete') {
						return;
					}

					try {
						await this.gitService.runGitOrThrow(['branch', '-d', message.branchRef]);
					} catch (error) {
						if (!this.gitService.isBranchNotFullyMergedError(error)) {
							throw error;
						}

						const forceDeleteConfirmation = await vscode.window.showWarningMessage(
							`Branch ${message.branchRef} is not fully merged. Force delete it?`,
							{ modal: true },
							'Force Delete'
						);

						if (forceDeleteConfirmation !== 'Force Delete') {
							return;
						}

						await this.gitService.runGitOrThrow(['branch', '-D', message.branchRef]);
					}

					await vscode.window.showInformationMessage(`[JBGit] Deleted ${message.branchRef}`);
					return;
				}
				case 'update':
					if (message.scope !== 'local') {
						return;
					}

					await this.gitService.updateBranch(message.branchRef, message.isCurrent);
					await vscode.window.showInformationMessage('[JBGit] Update completed');
					return;
				case 'push':
					if (message.scope !== 'local') {
						return;
					}

					await this.gitService.pushBranch(message.branchRef, message.isCurrent);
					await vscode.window.showInformationMessage(`[JBGit] Pushed ${message.branchRef}`);
					return;
				case 'checkoutAndRebase': {
					if (message.isCurrent) {
						return;
					}

					const currentBranch = await this.gitService.getCurrentBranchOrThrow();
					const confirmation = await vscode.window.showWarningMessage(
						`Checkout ${message.branchRef} and rebase it onto ${currentBranch}?`,
						{ modal: true },
						'Checkout and Rebase'
					);
					if (confirmation !== 'Checkout and Rebase') {
						return;
					}

					if (message.scope === 'remote') {
						await this.gitService.checkoutRemoteBranch(message.branchRef);
					} else {
						await this.gitService.runGitOrThrow(['checkout', message.branchRef]);
					}

					await this.gitService.runGitOrThrow(['rebase', currentBranch]);
					await vscode.window.showInformationMessage(`[JBGit] Rebased ${message.branchRef} onto ${currentBranch}`);
					return;
				}
				case 'compareWithCurrent':
					await this.gitService.openBranchDiffWithCurrent(message.branchRef);
					return;
				case 'showDiffWithWorkingTree':
					await this.gitService.openBranchDiffWithWorkingTree(message.branchRef);
					return;
				case 'rebaseCurrentOnto': {
					if (message.scope !== 'local' || message.isCurrent) {
						return;
					}

					const currentBranch = await this.gitService.getCurrentBranchOrThrow();
					const confirmation = await vscode.window.showWarningMessage(
						`Rebase ${currentBranch} onto ${message.branchRef}?`,
						{ modal: true },
						'Rebase'
					);
					if (confirmation !== 'Rebase') {
						return;
					}

					await this.gitService.runGitOrThrow(['rebase', message.branchRef]);
					await vscode.window.showInformationMessage(`[JBGit] Rebased ${currentBranch} onto ${message.branchRef}`);
					return;
				}
				case 'mergeIntoCurrent': {
					if (message.scope !== 'local' || message.isCurrent) {
						return;
					}

					const currentBranch = await this.gitService.getCurrentBranchOrThrow();
					await this.gitService.runGitOrThrow(['merge', '--no-edit', message.branchRef]);
					await vscode.window.showInformationMessage(`[JBGit] Merged ${message.branchRef} into ${currentBranch}`);
					return;
				}
				case 'forceUpdate':
					if (message.scope !== 'local') {
						return;
					}

					const confirmation = await vscode.window.showWarningMessage(
						message.isCurrent
							? `Force update ${message.branchRef}? Local branch and working tree will be reset to upstream.`
							: `Force update ${message.branchRef}? Local branch will be reset to its upstream.`,
						{ modal: true },
						'Force Update'
					);
					if (confirmation !== 'Force Update') {
						return;
					}

					await this.gitService.forceUpdateBranch(message.branchRef, message.isCurrent);
					await vscode.window.showInformationMessage('[JBGit] Force update completed');
					return;
				default:
					await vscode.window.showInformationMessage(`[JBGit] ${this.getActionLabel(message.action)}: ${message.branchRef}`);
			}
		} catch (error) {
			this.gitService.showGitError(error, `${this.getActionLabel(message.action)} failed for ${message.branchRef}`);
		}
	}

	private async postState(): Promise<void> {
		if (!this.view) {
			return;
		}

		const payload = await this.gitService.getBranchesViewState();
		await this.view.webview.postMessage({
			type: 'setState',
			payload
		});
	}

	private async handleOpenExternal(message: OpenExternalMessage): Promise<void> {
		if (!message.url) {
			return;
		}

		await vscode.env.openExternal(vscode.Uri.parse(message.url));
	}

	private getHtml(webview: vscode.Webview): string {
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'tree-panel.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'branches-view.js'));
		const nonce = getNonce();
		const initialState = JSON.stringify({
			head: undefined,
			nodes: []
		}).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta
		http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
	/>
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${cssUri}" />
	<title>JBGit Branches</title>
</head>
<body>
	<div class="tree-panel">
			<div class="filter-bar">
				<div class="filter-input-wrapper">
					<span class="filter-icon" aria-hidden="true">⌕</span>
					<input
						id="branch-filter-input"
						class="filter-input"
						type="text"
						placeholder="Filter branches"
						autocomplete="off"
						spellcheck="false"
					/>
					<button id="branch-filter-clear" class="filter-clear" type="button" title="Clear filter" aria-label="Clear filter">×</button>
				</div>
			</div>
		<div id="branch-filter-meta" class="filter-meta"></div>
		<div id="branch-head-info" class="head-info" hidden></div>
		<div id="branch-tree" class="tree-root" tabindex="0" role="tree" aria-label="Branches tree"></div>
	</div>
	<div id="branch-context-menu" class="context-menu" aria-hidden="true"></div>
	<script id="jb-git-bootstrap" type="application/json">${initialState}</script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	public dispose(): void {
		this.gitWatcher.dispose();
	}

	private getActionLabel(action: BranchAction): string {
		switch (action) {
			case 'checkout':
				return 'Checkout';
			case 'newFrom':
				return 'New Branch from';
			case 'checkoutAndRebase':
				return 'Checkout and Rebase onto current';
			case 'compareWithCurrent':
				return 'Compare with current';
			case 'showDiffWithWorkingTree':
				return 'Show Diff with Working Tree';
			case 'rebaseCurrentOnto':
				return 'Rebase current onto';
			case 'mergeIntoCurrent':
				return 'Merge into current';
			case 'update':
				return 'Update';
			case 'forceUpdate':
				return 'Force Update';
			case 'push':
				return 'Push';
			case 'rename':
				return 'Rename';
			case 'delete':
				return 'Delete';
		}
	}
}

class CommitsWebviewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private readonly gitWatcher: GitMetadataWatcher;
	private activeBranchFilter = 'all';
	private branchFilterInitialized = false;
	private pendingFocus = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly gitService: GitCommitService,
		private readonly onCommitSelected: (hash: string | null) => Promise<void>,
		private readonly onFocusChanges: () => Promise<void>
	) {
		this.gitWatcher = new GitMetadataWatcher(this.gitService, async () => {
			await this.postState();
		});
	}

	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);
		await this.gitWatcher.ensureWatching();

		webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
			if (!message || typeof message !== 'object' || !('type' in message)) {
				return;
			}

			const typedMessage = message as { type: string };
			if (typedMessage.type === 'ready' || typedMessage.type === 'refresh') {
				await this.postState();
				if (typedMessage.type === 'ready' && this.pendingFocus) {
					scheduleWebviewFocus(this.view);
					this.pendingFocus = false;
				}
				return;
			}

			if (typedMessage.type === 'branchFilterChanged') {
				this.activeBranchFilter = (message as CommitBranchFilterMessage).branch || 'all';
				this.branchFilterInitialized = true;
				await this.postState();
				return;
			}

			if (typedMessage.type === 'commitAction') {
				await this.handleCommitAction(message as CommitActionMessage);
				return;
			}

			if (typedMessage.type === 'commitSelected') {
				await this.onCommitSelected((message as CommitSelectionMessage).hash);
				return;
			}

			if (typedMessage.type === 'focusChanges') {
				await this.onFocusChanges();
				return;
			}

			if (typedMessage.type === 'focusState') {
				await updateJbGitFocusContext('commits', Boolean((message as FocusStateMessage).focused));
			}
		});
	}

	public async refresh(): Promise<void> {
		await this.postState();
	}

	public async focus(): Promise<void> {
		this.pendingFocus = true;
		if (this.view) {
			scheduleWebviewFocus(this.view);
			this.pendingFocus = false;
			return;
		}

		await revealJbGitView('jbGitCommits');
	}

	public dispose(): void {
		this.gitWatcher.dispose();
	}

	private async postState(): Promise<void> {
		if (!this.view) {
			return;
		}

		let payload = await this.gitService.getCommitsViewState(this.activeBranchFilter);
		if (
			!this.branchFilterInitialized &&
			this.activeBranchFilter === 'all' &&
			payload.currentBranch &&
			payload.branchOptions.some((option) => option.value === payload.currentBranch)
		) {
			this.activeBranchFilter = payload.currentBranch;
			this.branchFilterInitialized = true;
			payload = await this.gitService.getCommitsViewState(this.activeBranchFilter);
		}

		await this.view.webview.postMessage({
			type: 'setState',
			payload
		});
	}

	private async handleCommitAction(message: CommitActionMessage): Promise<void> {
		try {
			switch (message.action) {
				case 'copyRevision':
					await vscode.env.clipboard.writeText(message.hash);
					await vscode.window.showInformationMessage(`[JBGit] Copied revision ${message.hash}`);
					return;
				case 'createPatch': {
					const targetUri = await vscode.window.showSaveDialog({
						defaultUri: vscode.Uri.file(join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '', `${message.hash.slice(0, 7)}.patch`)),
						saveLabel: 'Create Patch',
						filters: {
							Patch: ['patch']
						}
					});
					if (!targetUri) {
						return;
					}

					const patch = await this.gitService.runGitOrThrow(['format-patch', '--stdout', '-1', message.hash]);
					await vscode.workspace.fs.writeFile(targetUri, Buffer.from(patch, 'utf8'));
					await vscode.window.showInformationMessage(`[JBGit] Patch created for ${message.hash}`);
					return;
				}
				case 'checkoutRevision': {
					const confirmation = await vscode.window.showWarningMessage(
						`Checkout revision ${message.hash}? This will detach HEAD.`,
						{ modal: true },
						'Checkout Revision'
					);
					if (confirmation !== 'Checkout Revision') {
						return;
					}

					await this.gitService.runGitOrThrow(['checkout', message.hash]);
					await vscode.window.showInformationMessage(`[JBGit] Checked out revision ${message.hash}`);
					return;
				}
				case 'showRepositoryAtRevision':
					await vscode.window.showInformationMessage(`[JBGit] Show Repository at Revision: ${message.hash}`);
					return;
				case 'compareWithLocal': {
					const diff = await this.gitService.runGitOrThrow(['diff', `${message.hash}..HEAD`]);
					const document = await vscode.workspace.openTextDocument({
						content: diff || 'No diff with local.',
						language: 'diff'
					});
					await vscode.window.showTextDocument(document, { preview: false });
					return;
				}
				case 'cherryPick':
					await this.gitService.runGitOrThrow(['cherry-pick', message.hash]);
					await vscode.window.showInformationMessage(`[JBGit] Cherry-picked ${message.hash}`);
					return;
				case 'resetCurrentBranchToHere':
				case 'undoCommit':
				case 'editCommitMessage':
				case 'fixup':
				case 'squashInto':
				case 'interactiveRebaseFromHere':
					await vscode.window.showInformationMessage(`[JBGit] ${this.formatCommitAction(message.action)} is not implemented yet.`);
					return;
				case 'revertCommit': {
					const confirmation = await vscode.window.showWarningMessage(
						`Revert commit ${message.hash}?`,
						{ modal: true },
						'Revert Commit'
					);
					if (confirmation !== 'Revert Commit') {
						return;
					}

					await this.gitService.runGitOrThrow(['revert', '--no-edit', message.hash]);
					await vscode.window.showInformationMessage(`[JBGit] Reverted ${message.hash}`);
					return;
				}
				case 'newBranch': {
					const branchName = await vscode.window.showInputBox({
						title: 'New Branch from Commit',
						prompt: `Create a new branch from ${message.hash}`,
						placeHolder: 'feature/my-branch',
						validateInput: (value) => value.trim().length === 0 ? 'Branch name is required.' : undefined
					});
					if (!branchName) {
						return;
					}

					await this.gitService.runGitOrThrow(['checkout', '-b', branchName.trim(), message.hash]);
					await vscode.window.showInformationMessage(`[JBGit] Created branch ${branchName.trim()} from ${message.hash}`);
					return;
				}
				case 'newTag': {
					const tagName = await vscode.window.showInputBox({
						title: 'New Tag',
						prompt: `Create a tag on ${message.hash}`,
						placeHolder: 'v1.0.0',
						validateInput: (value) => value.trim().length === 0 ? 'Tag name is required.' : undefined
					});
					if (!tagName) {
						return;
					}

					await this.gitService.runGitOrThrow(['tag', tagName.trim(), message.hash]);
					await vscode.window.showInformationMessage(`[JBGit] Created tag ${tagName.trim()} on ${message.hash}`);
					return;
				}
				case 'goToParentCommit':
				case 'goToChildCommit':
					await vscode.window.showInformationMessage(`[JBGit] ${this.formatCommitAction(message.action)} is not implemented yet.`);
					return;
				case 'refresh':
					await this.postState();
					return;
			}
		} catch (error) {
			this.gitService.showGitError(error, `Commit action failed for ${message.hash}`);
		}
	}

	private getHtml(webview: vscode.Webview): string {
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'commits-view.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'commits-view.js'));
		const nonce = getNonce();
		const initialState = JSON.stringify({
			currentBranch: undefined,
			loadedBranch: undefined,
			commits: [],
			branchOptions: [{ value: 'all', label: 'All' }],
			userOptions: [{ value: 'all', label: 'All' }],
			dateOptions: [{ value: 'all', label: 'All' }],
			pathOptions: [{ value: 'all', label: 'All' }]
		}).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta
		http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
	/>
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${cssUri}" />
	<title>JBGit Commits</title>
</head>
<body>
	<div class="commits-panel">
		<div class="toolbar">
			<div class="search-box">
				<input id="commit-search" class="search-input" type="text" placeholder="Search commits, use / for fields" autocomplete="off" spellcheck="false" list="commit-search-history" />
				<button id="commit-search-clear" class="tool-button" type="button" title="Clear">×</button>
			</div>
			<datalist id="commit-search-history"></datalist>
			<button id="commit-regex" class="tool-button tool-toggle" type="button" title="Regex">.*</button>
			<button id="commit-match-case" class="tool-button tool-toggle" type="button" title="Case Sensitive">Cc</button>
			<button id="commit-branch-filter" class="filter-trigger" type="button" title="Branch"></button>
			<button id="commit-cherry-pick" class="tool-button tool-icon-button" type="button" title="Cherry Pick" aria-label="Cherry Pick">
				<span class="tool-icon" aria-hidden="true">
					<svg class="tool-icon-svg" viewBox="0 0 16 16" focusable="false" aria-hidden="true">
						<path d="M3 3.25A1.75 1.75 0 1 1 6.5 3.25A1.75 1.75 0 0 1 3 3.25Zm1.75-.75a.75.75 0 1 0 0 1.5a.75.75 0 0 0 0-1.5Z"></path>
						<path d="M9.5 12.75A1.75 1.75 0 1 1 13 12.75A1.75 1.75 0 0 1 9.5 12.75Zm1.75-.75a.75.75 0 1 0 0 1.5a.75.75 0 0 0 0-1.5Z"></path>
						<path d="M4.75 5.5a.5.5 0 0 1 .5.5v1.75c0 .69.56 1.25 1.25 1.25h2.88L7.9 7.53a.5.5 0 0 1 .7-.71l2.35 2.35a.5.5 0 0 1 0 .71l-2.35 2.35a.5.5 0 1 1-.7-.71L9.38 10H6.5A2.25 2.25 0 0 1 4.25 7.75V6a.5.5 0 0 1 .5-.5Z"></path>
					</svg>
				</span>
			</button>
		</div>
		<div class="toolbar secondary">
			<div id="commit-toolbar-meta" class="toolbar-meta"></div>
		</div>
		<div id="commit-list" class="commit-list" tabindex="0" role="listbox" aria-label="Git commits"></div>
	</div>
	<div id="commit-search-assist" class="commit-search-assist" aria-hidden="true"></div>
	<div id="commit-filter-menu" class="commit-filter-menu" aria-hidden="true"></div>
	<div id="commit-context-menu" class="commit-context-menu" aria-hidden="true"></div>
	<script id="jb-git-commits-bootstrap" type="application/json">${initialState}</script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}

	private formatCommitAction(action: CommitAction): string {
		switch (action) {
			case 'copyRevision': return 'Copy Revision Number';
			case 'createPatch': return 'Create Patch';
			case 'checkoutRevision': return 'Checkout Revision';
			case 'showRepositoryAtRevision': return 'Show Repository at Revision';
			case 'compareWithLocal': return 'Compare with Local';
			case 'cherryPick': return 'Cherry-Pick';
			case 'resetCurrentBranchToHere': return 'Reset Current Branch to Here';
			case 'revertCommit': return 'Revert Commit';
			case 'undoCommit': return 'Undo Commit';
			case 'editCommitMessage': return 'Edit Commit Message';
			case 'fixup': return 'Fixup';
			case 'squashInto': return 'Squash Into';
			case 'interactiveRebaseFromHere': return 'Interactively Rebase from Here';
			case 'newBranch': return 'New Branch';
			case 'newTag': return 'New Tag';
			case 'goToParentCommit': return 'Go to Parent Commit';
			case 'goToChildCommit': return 'Go to Child Commit';
			case 'refresh': return 'Refresh';
		}
	}
}

class ChangesWebviewProvider implements vscode.WebviewViewProvider {
	private view?: vscode.WebviewView;
	private selectedCommitHash: string | null = null;
	private pendingFocus = false;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly gitService: GitCommitService
	) {}

	public async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')]
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
			if (!message || typeof message !== 'object' || !('type' in message)) {
				return;
			}

			const typedMessage = message as { type: string };
			if (typedMessage.type === 'ready' || typedMessage.type === 'refresh') {
				await this.postState();
				if (typedMessage.type === 'ready' && this.pendingFocus) {
					scheduleWebviewFocus(this.view);
					this.pendingFocus = false;
				}
				return;
			}

			if (typedMessage.type === 'openFileDiff') {
				await this.openFileDiff(message as ChangesOpenDiffMessage);
				return;
			}

			if (typedMessage.type === 'focusState') {
				await updateJbGitFocusContext('changes', Boolean((message as FocusStateMessage).focused));
			}
		});
	}

	public async setSelectedCommit(hash: string | null): Promise<void> {
		this.selectedCommitHash = hash;
		await this.postState();
	}

	public async refresh(): Promise<void> {
		await this.postState();
	}

	public async focus(): Promise<void> {
		this.pendingFocus = true;
		if (this.view) {
			scheduleWebviewFocus(this.view);
			this.pendingFocus = false;
			return;
		}

		await revealJbGitView('jbGitChanges');
	}

	public dispose(): void {
		// No-op.
	}

	private async openFileDiff(message: ChangesOpenDiffMessage): Promise<void> {
		if (!this.selectedCommitHash || !message.path) {
			return;
		}

		try {
			await this.gitService.openCommitDiff(this.selectedCommitHash, message.path);
		} catch (error) {
			this.gitService.showGitError(error, 'Unable to open commit diff.');
		}
	}

	private async postState(): Promise<void> {
		if (!this.view) {
			return;
		}

		const files = this.selectedCommitHash
			? await this.gitService.getCommitFiles(this.selectedCommitHash)
			: [];
		const payload: ChangesViewState = {
			selectedCommitHash: this.selectedCommitHash ?? undefined,
			files
		};

		await this.view.webview.postMessage({
			type: 'setState',
			payload
		});
	}

	private getHtml(webview: vscode.Webview): string {
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'changes-view.css'));
		const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'changes-view.js'));
		const nonce = getNonce();
		const initialState = JSON.stringify({
			selectedCommitHash: undefined,
			files: []
		}).replace(/</g, '\\u003c');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta
		http-equiv="Content-Security-Policy"
		content="default-src 'none'; img-src ${webview.cspSource} https: data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';"
	/>
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<link rel="stylesheet" href="${cssUri}" />
	<title>JBGit Changes</title>
</head>
<body>
	<div class="changes-panel">
		<div class="changes-toolbar">
			<div class="changes-filter-wrapper">
				<span class="changes-filter-icon" aria-hidden="true">⌕</span>
				<input id="changes-filter-input" class="changes-filter-input" type="text" placeholder="Filter files" autocomplete="off" spellcheck="false" />
				<button id="changes-filter-clear" class="changes-filter-clear" type="button" title="Clear filter" aria-label="Clear filter">×</button>
			</div>
			<button id="changes-mode-toggle" class="changes-mode-toggle" type="button" title="Toggle tree/list view" aria-label="Toggle tree/list view">Tree</button>
		</div>
		<div id="changes-meta" class="changes-meta"></div>
		<div id="changes-content" class="changes-content" tabindex="0" role="tree" aria-label="Changed files"></div>
	</div>
	<script id="jb-git-changes-bootstrap" type="application/json">${initialState}</script>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

class GitBranchService {
	public async getAbsoluteGitDir(): Promise<string | undefined> {
		try {
			const gitDir = await this.runGitOrThrow(['rev-parse', '--absolute-git-dir']);
			const normalized = gitDir.trim();
			return normalized.length > 0 ? normalized : undefined;
		} catch {
			return undefined;
		}
	}

	public async getBranchesViewState(): Promise<BranchesViewState> {
		const gitRoot = this.getWorkspaceRoot();
		if (!gitRoot) {
			return {
				head: undefined,
				nodes: [
					{
						type: 'group',
						id: 'section-empty',
						label: 'Workspace',
						kind: 'section',
						expanded: true,
						children: []
					}
				]
			};
		}

		const [currentBranchLines, localBranchStatusLines, remoteBranchLines, remoteHeadLines] = await Promise.all([
			this.runGit(['branch', '--show-current']),
			this.runGit(['for-each-ref', '--format=%(refname:short)%09%(upstream:short)%09%(upstream:track,nobracket)', 'refs/heads']),
			this.runGit(['for-each-ref', '--format=%(refname:short)', 'refs/remotes']),
			this.runGit(['for-each-ref', '--format=%(symref:short)', 'refs/remotes/*/HEAD'])
		]);

		const currentBranch = currentBranchLines[0] ?? 'Detached HEAD';
		const localBranchStatusMap = new Map(
			localBranchStatusLines.map((line) => {
				const [branchRef = '', upstream = '', tracking = ''] = line.split('\t');
				return [branchRef, this.parseLocalBranchStatus(upstream, tracking)];
			})
		);
		const localBranchLines = [...localBranchStatusMap.keys()];
		const localBranchSet = new Set(localBranchLines);
		if (!localBranchSet.has(currentBranch) && currentBranch !== 'Detached HEAD') {
			localBranchLines.unshift(currentBranch);
			localBranchStatusMap.set(currentBranch, {
				upstream: '',
				ahead: 0,
				behind: 0
			});
		}

		const defaultBranch = this.resolveDefaultBranch(localBranchLines, remoteHeadLines);
		const remoteBranchSet = new Set(remoteBranchLines);
		const taskUrlTemplate = vscode.workspace.getConfiguration('jbGit').get<string>('branchTaskUrlTemplate', '').trim();
		const taskUrlEnabled = vscode.workspace.getConfiguration('jbGit').get<boolean>('branchTaskUrl', false);

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

		const remoteNodes: BranchTreeNode[] = [...remoteGroups.entries()]
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([remoteName, branchNames]) => ({
				type: 'group',
				id: `remote:${remoteName}`,
				label: remoteName,
				kind: 'remote',
				expanded: true,
				children: branchNames
					.sort((a, b) => a.localeCompare(b))
					.map<BranchLeafNode>((branchName) => ({
						type: 'branch',
						id: `branch:remote:${remoteName}/${branchName}`,
						label: branchName,
						branchRef: `${remoteName}/${branchName}`,
						scope: 'remote',
						isCurrent: false,
						isDefaultBranch: branchName === defaultBranch
					}))
			}));

		const nodes: BranchTreeNode[] = [
			{
				type: 'group',
				id: 'section-local',
				label: 'Local',
				kind: 'section',
				expanded: true,
				children: localBranchLines
					.sort((a, b) => {
						if (a === currentBranch) {
							return -1;
						}

						if (b === currentBranch) {
							return 1;
						}

						return a.localeCompare(b);
					})
					.map<BranchLeafNode>((branchName) => ({
							type: 'branch',
							id: `branch:local:${branchName}`,
							label: branchName,
							branchRef: branchName,
						scope: 'local',
						isCurrent: branchName === currentBranch,
						isDefaultBranch: branchName === defaultBranch,
						upstream: localBranchStatusMap.get(branchName)?.upstream,
						ahead: localBranchStatusMap.get(branchName)?.ahead ?? 0,
						behind: localBranchStatusMap.get(branchName)?.behind ?? 0,
						taskUrl: this.buildTaskUrl(
							branchName,
							taskUrlEnabled,
							taskUrlTemplate
						),
						hasMissingUpstream: this.hasMissingUpstream(
							localBranchStatusMap.get(branchName)?.upstream,
							remoteBranchSet
						),
						requiresForceUpdate: this.requiresForceUpdate(localBranchStatusMap.get(branchName))
					}))
			},
			{
				type: 'group',
				id: 'section-remote',
				label: 'Remote',
				kind: 'section',
				expanded: true,
				children: remoteNodes
			}
		];

		return {
			head: {
				label: 'HEAD (Current Branch)',
				branchRef: currentBranch,
				isDefaultBranch: currentBranch === defaultBranch
			},
			nodes
		};
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

	public async getCurrentBranchOrThrow(): Promise<string> {
		const currentBranch = (await this.runGitOrThrow(['branch', '--show-current'])).trim();
		if (!currentBranch) {
			throw new Error('Current branch is not available in detached HEAD.');
		}

		return currentBranch;
	}

	public async pushBranch(branchRef: string, isCurrent: boolean): Promise<void> {
		const upstream = await this.getBranchUpstream(branchRef, isCurrent);
		if (!upstream) {
			await this.runGitOrThrow(['push', '-u', 'origin', branchRef]);
			return;
		}

		const remoteBranch = this.parseRemoteBranchRef(upstream);
		if (!remoteBranch) {
			throw new Error(`Unable to parse upstream branch ${upstream}.`);
		}

		await this.runGitOrThrow(['push', remoteBranch.remote, `${branchRef}:${remoteBranch.branch}`]);
	}

	public async openBranchDiffWithCurrent(branchRef: string): Promise<void> {
		const currentBranch = await this.getCurrentBranchOrThrow();
		const diff = await this.runGitOrThrow(['diff', `${currentBranch}..${branchRef}`]);
		await this.openDiffDocument(diff);
	}

	public async openBranchDiffWithWorkingTree(branchRef: string): Promise<void> {
		const diff = await this.runGitOrThrow(['diff', branchRef]);
		await this.openDiffDocument(diff);
	}

	public async runGitOrThrow(args: string[], cwdOverride?: string): Promise<string> {
		const cwd = cwdOverride ?? this.getWorkspaceRoot();
		if (!cwd) {
			throw new Error('Open a workspace folder first.');
		}

		try {
			const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
			return stdout;
		} catch (error) {
			throw this.toError(error);
		}
	}

	public showGitError(error: unknown, fallbackMessage: string): void {
		const message = this.getErrorMessage(error) || fallbackMessage;
		void vscode.window.showErrorMessage(`[JBGit] ${message}`);
	}

	public isBranchNotFullyMergedError(error: unknown): boolean {
		return this.getErrorMessage(error).toLowerCase().includes('not fully merged');
	}

	private getWorkspaceRoot(): string | undefined {
		return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	}

	public async updateBranch(branchRef: string, isCurrent: boolean): Promise<void> {
		const upstream = await this.getBranchUpstream(branchRef, isCurrent);
		if (!upstream) {
			throw new Error(`Branch ${branchRef} has no upstream branch.`);
		}

		await this.fetchUpstream(upstream);
		const updateMethod = vscode.workspace.getConfiguration('jbGit').get<'rebase' | 'merge'>('updateMethod', 'rebase');
		if (isCurrent) {
			const args = updateMethod === 'merge'
				? ['pull', '--no-rebase']
				: ['pull', '--rebase'];
			await this.runGitOrThrow(args);
			return;
		}

		await this.withTemporaryWorktree(branchRef, async (worktreePath) => {
			const args = updateMethod === 'merge'
				? ['merge', '--no-edit', upstream]
				: ['rebase', upstream];
			await this.runGitOrThrow(args, worktreePath);
		});
	}

	public async forceUpdateBranch(branchRef: string, isCurrent: boolean): Promise<void> {
		const upstream = await this.getBranchUpstream(branchRef, isCurrent);
		if (!upstream) {
			throw new Error(`Branch ${branchRef} has no upstream branch.`);
		}

		await this.fetchUpstream(upstream);
		if (isCurrent) {
			await this.runGitOrThrow(['reset', '--hard', upstream]);
			return;
		}

		await this.runGitOrThrow(['branch', '-f', branchRef, upstream]);
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

	private parseRemoteBranchRef(ref: string): { remote: string; branch: string } | undefined {
		const separatorIndex = ref.indexOf('/');
		if (separatorIndex <= 0 || separatorIndex === ref.length - 1) {
			return undefined;
		}

		return {
			remote: ref.slice(0, separatorIndex),
			branch: ref.slice(separatorIndex + 1)
		};
	}

	private async openDiffDocument(diff: string): Promise<void> {
		const document = await vscode.workspace.openTextDocument({
			content: diff || 'No diff.',
			language: 'diff'
		});
		await vscode.window.showTextDocument(document, { preview: false });
	}

	private async getCurrentBranchUpstream(): Promise<string | undefined> {
		try {
			const upstream = await this.runGitOrThrow(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
			const normalized = upstream.trim();
			return normalized.length > 0 ? normalized : undefined;
		} catch {
			return undefined;
		}
	}

	private async getBranchUpstream(branchRef: string, isCurrent: boolean): Promise<string | undefined> {
		if (isCurrent) {
			return this.getCurrentBranchUpstream();
		}

		try {
			const upstream = await this.runGitOrThrow(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${branchRef}@{upstream}`]);
			const normalized = upstream.trim();
			return normalized.length > 0 ? normalized : undefined;
		} catch {
			return undefined;
		}
	}

	private async fetchUpstream(upstream: string): Promise<void> {
		const remoteName = upstream.split('/')[0];
		if (!remoteName) {
			return;
		}

		await this.runGitOrThrow(['fetch', remoteName, '--prune']);
	}

	private parseLocalBranchStatus(upstream: string, tracking: string): { upstream?: string; ahead: number; behind: number } {
		const status = {
			upstream: upstream || undefined,
			ahead: 0,
			behind: 0
		};

		if (!tracking) {
			return status;
		}

		const aheadMatch = tracking.match(/ahead (\d+)/);
		const behindMatch = tracking.match(/behind (\d+)/);

		if (aheadMatch) {
			status.ahead = Number.parseInt(aheadMatch[1], 10);
		}

		if (behindMatch) {
			status.behind = Number.parseInt(behindMatch[1], 10);
		}

		return status;
	}

	private requiresForceUpdate(status: { upstream?: string; ahead: number; behind: number } | undefined): boolean {
		if (!status?.upstream) {
			return false;
		}

		return status.ahead > 0 && status.behind > 0;
	}

	private resolveDefaultBranch(localBranchLines: string[], remoteHeadLines: string[]): string | undefined {
		for (const remoteHead of remoteHeadLines) {
			if (!remoteHead) {
				continue;
			}

			const parts = remoteHead.split('/');
			const branchName = parts.at(-1);
			if (branchName) {
				return branchName;
			}
		}

		if (localBranchLines.includes('main')) {
			return 'main';
		}

		if (localBranchLines.includes('master')) {
			return 'master';
		}

		return undefined;
	}

	private buildTaskUrl(
		branchName: string,
		taskUrlEnabled: boolean,
		taskUrlTemplate: string
	): string | undefined {
		if (!taskUrlEnabled || !taskUrlTemplate) {
			return undefined;
		}

		const normalizedBranch = this.normalizeBranchTaskKey(branchName);
		if (!normalizedBranch) {
			return undefined;
		}

		return taskUrlTemplate.replaceAll('{BRANCH}', normalizedBranch);
	}

	private normalizeBranchTaskKey(branchName: string): string | undefined {
		const match = branchName.match(/\b(\w+-[1-9]\d*)\b/);
		return match?.[1];
	}

	private hasMissingUpstream(upstream: string | undefined, remoteBranchSet: Set<string>): boolean {
		if (!upstream) {
			return true;
		}

		return !remoteBranchSet.has(upstream);
	}

	private toError(error: unknown): Error {
		const errorWithStreams = error as { message?: string; stderr?: string; stdout?: string } | undefined;
		const stderr = errorWithStreams?.stderr?.trim();
		const stdout = errorWithStreams?.stdout?.trim();
		const message = stderr || stdout || errorWithStreams?.message || String(error);
		return new Error(message);
	}

	private async withTemporaryWorktree(branchRef: string, callback: (worktreePath: string) => Promise<void>): Promise<void> {
		const worktreePath = await mkdtemp(join(tmpdir(), 'jb-git-worktree-'));
		try {
			await this.runGitOrThrow(['worktree', 'add', '--force', worktreePath, branchRef]);
			await callback(worktreePath);
		} finally {
			try {
				await this.runGitOrThrow(['worktree', 'remove', '--force', worktreePath]);
			} finally {
				await rm(worktreePath, { recursive: true, force: true });
			}
		}
	}

	private getErrorMessage(error: unknown): string {
		if (error instanceof Error) {
			return error.message;
		}

		return String(error);
	}
}

class GitCommitService {
	public async getAbsoluteGitDir(): Promise<string | undefined> {
		try {
			const gitDir = await this.runGitOrThrow(['rev-parse', '--absolute-git-dir']);
			const normalized = gitDir.trim();
			return normalized.length > 0 ? normalized : undefined;
		} catch {
			return undefined;
		}
	}

	public async getCommitsViewState(branchFilter = 'all'): Promise<CommitsViewState> {
		const gitRoot = this.getWorkspaceRoot();
		if (!gitRoot) {
			return {
				currentBranch: undefined,
				loadedBranch: undefined,
				commits: [],
				branchOptions: [{ value: 'all', label: 'All' }],
				userOptions: [{ value: 'all', label: 'All' }],
				dateOptions: this.getDateOptions(),
				pathOptions: [{ value: 'all', label: 'All' }]
			};
		}

		const [currentBranchLines, branchLines, currentUserEmailLines] = await Promise.all([
			this.runGit(['branch', '--show-current']),
			this.runGit(['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes']),
			this.runGit(['config', 'user.email'])
		]);

		const currentBranch = currentBranchLines[0];
		const currentUserEmail = currentUserEmailLines[0];
		const normalizedBranchFilter = branchFilter !== 'all' && branchLines.includes(branchFilter) ? branchFilter : 'all';
		const [currentBranchHeadHashLines, currentBranchCommitHashesLines, commits] = await Promise.all([
			currentBranch ? this.runGit(['rev-parse', currentBranch]) : Promise.resolve([]),
			currentBranch ? this.runGit(['rev-list', currentBranch, '-n', '5000']) : Promise.resolve([]),
			this.loadCommits(normalizedBranchFilter, currentBranch, currentUserEmail)
		]);
		const currentBranchHeadHash = currentBranchHeadHashLines[0];
		const currentBranchCommitHashes = new Set(currentBranchCommitHashesLines);
		const normalizedCommits = commits.map((commit) => ({
			...commit,
			isInCurrentBranch: currentBranchCommitHashes.has(commit.hash),
			isHeadCommit: Boolean(currentBranchHeadHash && commit.hash === currentBranchHeadHash),
			isMergeCommit: commit.parents.length > 1,
			authoredByCurrentUser: Boolean(currentUserEmail && commit.authorEmail === currentUserEmail)
		}));
		const uniqueBranchLines = branchLines.filter((value, index, values) => {
			if (value.length === 0 || values.indexOf(value) !== index) {
				return false;
			}

			if (value === 'origin' || value === 'origin/HEAD' || value.endsWith('/HEAD')) {
				return false;
			}

			return true;
		});
		const localBranches = uniqueBranchLines
			.filter((branch) => !branch.includes('/'))
			.sort((a, b) => a.localeCompare(b));
		const remoteBranches = uniqueBranchLines
			.filter((branch) => branch.includes('/'))
			.filter((branch) => branch.split('/').length > 1)
			.sort((a, b) => a.localeCompare(b));
		const orderedBranches = [
			...(currentBranch && localBranches.includes(currentBranch) ? [currentBranch] : []),
			...localBranches.filter((branch) => branch !== currentBranch),
			...remoteBranches
		];
		const branchOptions = [
			{ value: 'all', label: 'All' },
			...orderedBranches.map((branch) => ({ value: branch, label: branch }))
		];
		const userOptions = [
			{ value: 'all', label: 'All' },
			...[...new Set(normalizedCommits.map((commit) => commit.authorName))]
				.sort((a, b) => a.localeCompare(b))
				.map((author) => ({ value: author, label: author }))
		];
		const pathOptions = [
			{ value: 'all', label: 'All' },
			...[...new Set(normalizedCommits.flatMap((commit) => commit.paths.map((path) => this.toPathOption(path))))]
				.filter((value, index, values) => value.length > 0 && values.indexOf(value) === index)
				.sort((a, b) => a.localeCompare(b))
				.map((path) => ({ value: path, label: path }))
		];

		return {
			currentBranch,
			loadedBranch: normalizedBranchFilter === 'all' ? undefined : normalizedBranchFilter,
			commits: normalizedCommits,
			branchOptions,
			userOptions,
			dateOptions: this.getDateOptions(),
			pathOptions
		};
	}

	public async getCommitFiles(hash: string): Promise<Array<{ path: string; added: number; deleted: number; status: string; originalPath?: string }>> {
		if (!hash) {
			return [];
		}

		const [numstatOutput, statusOutput] = await Promise.all([
			this.runGitOrThrow(['show', '--pretty=format:', '--numstat', hash]),
			this.runGitOrThrow(['show', '--pretty=format:', '--name-status', hash])
		]);

		const filesByPath = new Map<string, { path: string; added: number; deleted: number; status: string; originalPath?: string }>();
		statusOutput
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.forEach((line) => {
				const [statusText = '', ...pathParts] = line.split('\t');
				const status = statusText.trim() || 'M';
				const statusCode = status.charAt(0).toUpperCase();
				const hasSourcePath = statusCode === 'R' || statusCode === 'C';
				const originalPath = hasSourcePath ? pathParts[0] : undefined;
				const path = hasSourcePath ? pathParts[1] : pathParts[0];
				if (path.length === 0) {
					return;
				}

				filesByPath.set(path, {
					path,
					added: 0,
					deleted: 0,
					status,
					originalPath
				});
			});

		numstatOutput
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0)
			.forEach((line) => {
				const [addedText = '0', deletedText = '0', ...pathParts] = line.split('\t');
				const hasSourcePath = pathParts.length > 1;
				const path = hasSourcePath ? pathParts[pathParts.length - 1] : pathParts[0];
				if (!path) {
					return;
				}

				const existing = filesByPath.get(path) ?? {
					path,
					added: 0,
					deleted: 0,
					status: 'M'
				};
				existing.added = addedText === '-' ? 0 : Number.parseInt(addedText, 10) || 0;
				existing.deleted = deletedText === '-' ? 0 : Number.parseInt(deletedText, 10) || 0;
				if (hasSourcePath && !existing.originalPath) {
					existing.originalPath = pathParts[0];
				}
				filesByPath.set(path, existing);
			});

		return [...filesByPath.values()]
			.filter((item) => item.path.length > 0)
			.sort((a, b) => a.path.localeCompare(b.path));
	}

	public async openCommitDiff(hash: string, preferredPath?: string): Promise<void> {
		if (!hash) {
			throw new Error('No commit selected.');
		}

		const workspaceRoot = this.getWorkspaceRoot();
		if (!workspaceRoot) {
			throw new Error('Open a workspace folder first.');
		}

		await vscode.extensions.getExtension('vscode.git')?.activate();

		const commit = await this.getCommitSummary(hash);
		const baseRef = commit.parents[0] ?? await this.getEmptyTreeHash();
		const files = await this.getCommitFiles(hash);
		const orderedFiles = preferredPath
			? this.movePreferredFileFirst(files, preferredPath)
			: files;
		if (!orderedFiles.length) {
			throw new Error('The selected commit does not contain changed files.');
		}

		const title = `${commit.shortHash} - ${this.truncateText(commit.subject, 72)}`;
		const multiDiffSourceUri = vscode.Uri.from({
			scheme: 'scm-history-item',
			path: `${workspaceRoot}/${baseRef}..${hash}`
		});
		const resources = orderedFiles.map((file) => this.toMultiDiffResource(file, baseRef, hash));

			try {
				await vscode.commands.executeCommand('_workbench.openMultiDiffEditor', {
					multiDiffSourceUri,
					title,
					resources,
					preserveFocus: false
				});
				await this.waitForEditorOpen();
				await this.focusOpenedEditor();
			} catch {
				const preferredFile = orderedFiles[0];
				await this.openSingleCommitDiffFile(preferredFile, baseRef, hash, title);
			}
		}

	private async openSingleCommitDiffFile(
		file: { path: string; status: string; originalPath?: string },
		baseRef: string,
		commitHash: string,
		titlePrefix: string
	): Promise<void> {
		const statusCode = file.status.trim().charAt(0).toUpperCase();
		const originalUri = statusCode === 'A'
			? this.toGitUri(file.path, baseRef)
			: this.toGitUri(file.originalPath ?? file.path, baseRef);
		const modifiedUri = statusCode === 'D'
			? this.toGitUri(file.originalPath ?? file.path, await this.getEmptyTreeHash())
			: this.toGitUri(file.path, commitHash);
		const fileName = file.path.split('/').pop() ?? file.path;
		const editorTitle = `${fileName} (${titlePrefix})`;

		await vscode.commands.executeCommand('vscode.diff', originalUri, modifiedUri, editorTitle, {
			preview: true,
			preserveFocus: false
		});
		await this.waitForEditorOpen();
		await this.focusOpenedEditor();
	}

	private toMultiDiffResource(
		file: { path: string; status: string; originalPath?: string },
		baseRef: string,
		commitHash: string
	): { originalUri?: vscode.Uri; modifiedUri?: vscode.Uri } {
		const statusCode = file.status.trim().charAt(0).toUpperCase();
		switch (statusCode) {
			case 'A':
				return {
					originalUri: undefined,
					modifiedUri: this.toGitUri(file.path, commitHash)
				};
			case 'D':
				return {
					originalUri: this.toGitUri(file.originalPath ?? file.path, baseRef),
					modifiedUri: undefined
				};
			case 'R':
			case 'C':
				return {
					originalUri: this.toGitUri(file.originalPath ?? file.path, baseRef),
					modifiedUri: this.toGitUri(file.path, commitHash)
				};
			default:
				return {
					originalUri: this.toGitUri(file.path, baseRef),
					modifiedUri: this.toGitUri(file.path, commitHash)
				};
		}
	}

	private toGitUri(path: string, ref: string): vscode.Uri {
		const workspaceRoot = this.getWorkspaceRoot();
		if (!workspaceRoot) {
			throw new Error('Open a workspace folder first.');
		}

		const absolutePath = join(workspaceRoot, path);
		const fileUri = vscode.Uri.file(absolutePath);
		return fileUri.with({
			scheme: 'git',
			path: fileUri.path,
			query: JSON.stringify({
				path: fileUri.fsPath,
				ref
			})
		});
	}

	private movePreferredFileFirst<T extends { path: string }>(files: T[], preferredPath: string): T[] {
		const index = files.findIndex((file) => file.path === preferredPath);
		if (index <= 0) {
			return files;
		}

		return [files[index], ...files.slice(0, index), ...files.slice(index + 1)];
	}

	private async getCommitSummary(hash: string): Promise<{ subject: string; shortHash: string; parents: string[] }> {
		const output = await this.runGitOrThrow(['show', '--quiet', '--format=%H%x00%h%x00%s%x00%P', hash]);
		const [fullHash = '', shortHash = '', subject = '', parentsText = ''] = output.trim().split('\0');
		if (!fullHash) {
			throw new Error(`Unable to load commit ${hash}.`);
		}

		return {
			subject,
			shortHash: shortHash || fullHash.slice(0, 7),
			parents: parentsText.split(' ').filter(Boolean)
		};
	}

	private async getEmptyTreeHash(): Promise<string> {
		const output = await this.runGitWithStdinOrThrow(['hash-object', '-t', 'tree', '--stdin'], '');
		const value = output.trim();
		if (!value) {
			throw new Error('Unable to resolve empty tree hash.');
		}

		return value;
	}

	private async runGitWithStdinOrThrow(args: string[], input: string, cwdOverride?: string): Promise<string> {
		const cwd = cwdOverride ?? this.getWorkspaceRoot();
		if (!cwd) {
			throw new Error('Open a workspace folder first.');
		}

		return await new Promise<string>((resolve, reject) => {
			const child = execFile('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
				if (error) {
					reject(this.toError(error));
					return;
				}

				resolve(stdout);
			});

			child.stdin?.end(input);
		});
	}

	private truncateText(value: string, maxLength: number): string {
		if (value.length <= maxLength) {
			return value;
		}

		return `${value.slice(0, maxLength - 1)}…`;
	}

	private async waitForEditorOpen(timeoutMs = 800): Promise<void> {
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = () => {
				if (settled) {
					return;
				}

				settled = true;
				tabsDisposable.dispose();
				editorDisposable.dispose();
				clearTimeout(timeoutHandle);
				resolve();
			};

			const tabsDisposable = vscode.window.tabGroups.onDidChangeTabs((event) => {
				if (event.opened.length > 0 || event.changed.some((tab) => tab.isActive)) {
					finish();
				}
			});
			const editorDisposable = vscode.window.onDidChangeActiveTextEditor(() => {
				finish();
			});
			const timeoutHandle = setTimeout(() => {
				finish();
			}, timeoutMs);
		});
	}

	private async focusOpenedEditor(): Promise<void> {
		for (const delayMs of [0, 75, 175, 350, 700]) {
			if (delayMs > 0) {
				await new Promise((resolve) => {
					setTimeout(resolve, delayMs);
				});
			}

			try {
				await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
			} catch {
				// Fall through.
			}

			try {
				await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
			} catch {
				// Best effort only.
			}
		}
	}

	public async runGitOrThrow(args: string[], cwdOverride?: string): Promise<string> {
		const cwd = cwdOverride ?? this.getWorkspaceRoot();
		if (!cwd) {
			throw new Error('Open a workspace folder first.');
		}

		try {
			const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
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

	private async loadCommits(branchFilter = 'all', currentBranch?: string, currentUserEmail?: string): Promise<CommitRecord[]> {
		const args = [
			'log',
			'--date=iso-strict',
			'--decorate=short',
			'--name-only',
			'-n',
			'200',
			'--pretty=format:__JBGIT_COMMIT__%n%H%x09%h%x09%an%x09%ae%x09%aI%x09%D%x09%P%n__JBGIT_SUBJECT__%n%s%n__JBGIT_BODY__%n%B%n__JBGIT_PATHS__'
		];
		if (branchFilter === 'all') {
			args.splice(1, 0, '--all');
		} else {
			args.push(branchFilter);
		}

		const raw = await this.runGitOrThrow(args);

		return raw
			.split('__JBGIT_COMMIT__\n')
			.map((chunk) => chunk.trim())
			.filter((chunk) => chunk.length > 0)
			.map((chunk) => this.parseCommitChunk(chunk, currentBranch, currentUserEmail))
			.filter((commit): commit is CommitRecord => commit !== undefined);
	}

	private parseCommitChunk(chunk: string, currentBranch?: string, currentUserEmail?: string): CommitRecord | undefined {
		const subjectMarker = '\n__JBGIT_SUBJECT__\n';
		const bodyMarker = '\n__JBGIT_BODY__\n';
		const pathsMarker = '\n__JBGIT_PATHS__';
		const subjectIndex = chunk.indexOf(subjectMarker);
		const bodyIndex = chunk.indexOf(bodyMarker);
		const pathsIndex = chunk.indexOf(pathsMarker);

		if (subjectIndex < 0 || bodyIndex < 0 || pathsIndex < 0) {
			return undefined;
		}

		const header = chunk.slice(0, subjectIndex).trim();
		const subject = chunk.slice(subjectIndex + subjectMarker.length, bodyIndex).trim();
		const body = chunk.slice(bodyIndex + bodyMarker.length, pathsIndex).trim();
		const pathsText = chunk.slice(pathsIndex + pathsMarker.length).trim();
		const [hash = '', shortHash = '', authorName = '', authorEmail = '', dateIso = '', refsText = '', parentsText = ''] = header.split('\t');

		if (!hash) {
			return undefined;
		}

		return {
			hash,
			shortHash,
			authorName,
			authorEmail,
			dateIso,
			refs: refsText.split(',').map((value) => value.trim()).filter((value) => value.length > 0),
			subject,
			body,
			parents: parentsText.split(' ').filter((value) => value.length > 0),
			paths: pathsText.split(/\r?\n/).map((value) => value.trim()).filter((value) => value.length > 0),
			isInCurrentBranch: false,
			isHeadCommit: Boolean(currentBranch && currentBranch === hash),
			isMergeCommit: parentsText.split(' ').filter((value) => value.length > 0).length > 1,
			authoredByCurrentUser: Boolean(currentUserEmail && authorEmail === currentUserEmail)
		};
	}

	private getDateOptions(): Array<{ value: string; label: string }> {
		return [
			{ value: 'all', label: 'All' },
			{ value: '7d', label: 'Last 7 days' },
			{ value: '30d', label: 'Last 30 days' },
			{ value: '90d', label: 'Last 90 days' }
		];
	}

	private toPathOption(path: string): string {
		if (!path) {
			return '';
		}

		const [head] = path.split('/');
		return head || path;
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
			const { stdout } = await execFileAsync('git', args, { cwd: gitRoot, maxBuffer: 8 * 1024 * 1024 });
			return stdout
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		} catch {
			return [];
		}
	}

	private toError(error: unknown): Error {
		const errorWithStreams = error as { message?: string; stderr?: string; stdout?: string } | undefined;
		const stderr = errorWithStreams?.stderr?.trim();
		const stdout = errorWithStreams?.stdout?.trim();
		const message = stderr || stdout || errorWithStreams?.message || String(error);
		return new Error(message);
	}
}

class GitMetadataWatcher implements vscode.Disposable {
	private watchers: FSWatcher[] = [];
	private refreshTimer?: NodeJS.Timeout;
	private isWatching = false;

	constructor(
		private readonly gitService: { getAbsoluteGitDir(): Promise<string | undefined> },
		private readonly onChange: () => Promise<void>
	) {}

	public async ensureWatching(): Promise<void> {
		if (this.isWatching) {
			return;
		}

		const gitDir = await this.gitService.getAbsoluteGitDir();
		if (!gitDir) {
			return;
		}

		this.isWatching = true;
		const recursiveSupported = process.platform === 'darwin' || process.platform === 'win32';

		try {
			this.watchers.push(
				watch(gitDir, { recursive: recursiveSupported }, () => {
					this.scheduleRefresh();
				})
			);
			return;
		} catch {
			const fallbackPaths = [
				gitDir,
				join(gitDir, 'HEAD'),
				join(gitDir, 'FETCH_HEAD'),
				join(gitDir, 'ORIG_HEAD'),
				join(gitDir, 'index'),
				join(gitDir, 'packed-refs'),
				join(gitDir, 'refs'),
				join(gitDir, 'logs'),
				join(gitDir, 'rebase-merge'),
				join(gitDir, 'rebase-apply')
			];

			for (const targetPath of fallbackPaths) {
				if (!existsSync(targetPath)) {
					continue;
				}

				try {
					this.watchers.push(
						watch(targetPath, () => {
							this.scheduleRefresh();
						})
					);
				} catch {
					// Ignore paths that cannot be watched individually.
				}
			}
		}
	}

	public dispose(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}

		for (const watcher of this.watchers) {
			watcher.close();
		}

		this.watchers = [];
		this.isWatching = false;
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer) {
			clearTimeout(this.refreshTimer);
		}

		this.refreshTimer = setTimeout(() => {
			void this.onChange();
		}, 150);
	}
}

function getNonce(): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
	let nonce = '';

	for (let index = 0; index < 32; index += 1) {
		nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
	}

	return nonce;
}

export function deactivate() {}
