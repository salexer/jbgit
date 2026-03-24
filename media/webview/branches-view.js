(function () {
	const vscode = acquireVsCodeApi();
	const bootstrapElement = document.getElementById('jb-git-bootstrap');
	const initialState = bootstrapElement?.textContent ? JSON.parse(bootstrapElement.textContent) : { nodes: [] };

	const elements = {
		tree: document.getElementById('branch-tree'),
		headInfo: document.getElementById('branch-head-info'),
		filterInput: document.getElementById('branch-filter-input'),
		filterClear: document.getElementById('branch-filter-clear'),
		filterMeta: document.getElementById('branch-filter-meta'),
		contextMenu: document.getElementById('branch-context-menu')
	};

	const state = {
		data: initialState,
		filterText: '',
		selectedNodeId: null,
		selectedBranchId: null,
		selectedBranch: null,
		expanded: new Map(),
		activeMenuIndex: -1,
		lastFocusState: null
	};

	function sendFocusState(focused) {
		if (state.lastFocusState === focused) {
			return;
		}

		state.lastFocusState = focused;
		vscode.postMessage({
			type: 'focusState',
			focused
		});
	}

	function isBranchNode(node) {
		return node.type === 'branch';
	}

	function ensureExpandedDefaults(nodes) {
		nodes.forEach((node) => {
			if (node.type === 'group') {
				if (!state.expanded.has(node.id)) {
					state.expanded.set(node.id, Boolean(node.expanded));
				}
				ensureExpandedDefaults(node.children);
			}
		});
	}

	function normalizeText(value) {
		return value.trim().toLowerCase();
	}

	function nodeMatches(node, query) {
		if (!query) {
			return true;
		}

		if (node.type === 'branch') {
			return [node.label, node.branchRef, node.scope, String(node.ahead || ''), String(node.behind || ''), node.upstream || '']
				.some((value) => value.toLowerCase().includes(query));
		}

		return node.label.toLowerCase().includes(query);
	}

	function filterNodes(nodes, query) {
		if (!query) {
			return nodes;
		}

		return nodes
			.map((node) => {
				if (node.type === 'group') {
					const filteredChildren = filterNodes(node.children, query);
					if (filteredChildren.length > 0 || nodeMatches(node, query)) {
						return {
							...node,
							expanded: true,
							children: filteredChildren
						};
					}

					return null;
				}

				return nodeMatches(node, query) ? node : null;
			})
			.filter(Boolean);
	}

	function flattenBranches(nodes, output) {
		nodes.forEach((node) => {
			if (node.type === 'group') {
				flattenBranches(node.children, output);
				return;
			}

			output.push(node);
		});
	}

	function findBranchById(nodes, branchId) {
		for (const node of nodes) {
			if (node.type === 'group') {
				const found = findBranchById(node.children, branchId);
				if (found) {
					return found;
				}
				continue;
			}

			if (node.id === branchId) {
				return node;
			}
		}

		return null;
	}

	function getVisibleNodes() {
		return filterNodes(state.data.nodes || [], normalizeText(state.filterText));
	}

	function renderTree() {
		const visibleNodes = getVisibleNodes();
		const query = normalizeText(state.filterText);
		renderHeadInfo();

		if (!visibleNodes.length) {
			elements.tree.innerHTML = '<div class="tree-no-results">No branches match the current filter.</div>';
			elements.filterMeta.textContent = query ? `Filter: ${state.filterText}` : '';
			elements.filterClear.classList.toggle('is-visible', Boolean(state.filterText));
			return;
		}

		elements.tree.innerHTML = `<ul class="tree-list">${visibleNodes.map((node) => renderNode(node, query)).join('')}</ul>`;
		elements.filterMeta.textContent = query ? `Filter: ${state.filterText}` : 'Type while the tree is focused to start filtering.';
		elements.filterClear.classList.toggle('is-visible', Boolean(state.filterText));

		if (state.selectedNodeId) {
			const selectedElement = elements.tree.querySelector(`[data-node-id="${cssEscape(state.selectedNodeId)}"]`);
			if (!selectedElement) {
				state.selectedNodeId = null;
			}
		}

		if (state.selectedBranchId) {
			const selectedBranchElement = elements.tree.querySelector(`[data-branch-id="${cssEscape(state.selectedBranchId)}"]`);
			if (!selectedBranchElement) {
				state.selectedBranchId = null;
				state.selectedBranch = null;
			}
		}
	}

	function renderHeadInfo() {
		const head = state.data.head;
		if (!head) {
			elements.headInfo.hidden = true;
			elements.headInfo.innerHTML = '';
			return;
		}

		const badge = head.isDefaultBranch ? '<span class="head-info-badge">★</span>' : '<span class="head-info-badge">🏷</span>';
		elements.headInfo.hidden = false;
		elements.headInfo.innerHTML = `
			<div class="head-info-title">${escapeHtml(head.label)}</div>
			<div class="head-info-value">${badge}<span>${escapeHtml(head.branchRef)}</span></div>
		`;
	}

	function renderNode(node, query) {
		if (node.type === 'group') {
			const expanded = query ? true : Boolean(state.expanded.get(node.id));
			const disclosure = expanded ? '▾' : '▸';
			const selectedClass = state.selectedNodeId === node.id ? ' is-selected' : '';
			const children = expanded
				? node.children.length
					? `<ul class="tree-group-children">${node.children.map((child) => renderNode(child, query)).join('')}</ul>`
					: '<div class="tree-empty">Empty</div>'
				: '';

			return `
				<li class="tree-group" data-group-id="${escapeHtml(node.id)}">
					<button
						class="tree-row tree-group-row${selectedClass}"
						type="button"
						data-group-toggle="${escapeHtml(node.id)}"
						data-node-id="${escapeHtml(node.id)}"
					>
						<span class="tree-disclosure">${disclosure}</span>
						<span class="tree-row-label">${escapeHtml(node.label)}</span>
						<span class="tree-row-meta"></span>
					</button>
					${children}
				</li>
			`;
		}

		const selectedClass = state.selectedBranchId === node.id ? ' is-selected' : '';
		const currentClass = node.isCurrent ? ' is-current' : '';
		const icon = getBranchIcon(node);
		const meta = renderBranchMeta(node);

		return `
			<li>
				<button
					class="tree-row branch-row${selectedClass}${currentClass}"
					type="button"
					data-node-id="${escapeHtml(node.id)}"
					data-branch-id="${escapeHtml(node.id)}"
					data-branch-ref="${escapeHtml(node.branchRef)}"
					data-branch-scope="${escapeHtml(node.scope)}"
					data-branch-current="${node.isCurrent ? 'true' : 'false'}"
				>
					<span class="tree-disclosure">${icon}</span>
					<span class="tree-row-label">${escapeHtml(node.label)}</span>
					<span class="tree-row-meta">${meta}</span>
				</button>
			</li>
		`;
	}

	function getBranchIcon(node) {
		if (node.isCurrent) {
			return '🏷';
		}

		if (node.isDefaultBranch) {
			return '★';
		}

		if (node.scope === 'remote') {
			return '◌';
		}

		return '⌬';
	}

	function renderBranchMeta(node) {
		const tokens = [];

		if (node.scope === 'remote') {
			tokens.push('<span class="branch-meta-token branch-meta-token--muted">remote</span>');
		}

		if (node.isCurrent) {
			tokens.push('<span class="branch-meta-token branch-meta-token--muted">current</span>');
		}

		if (node.scope === 'local' && node.hasMissingUpstream) {
			tokens.push(`
				<span
					class="branch-meta-icon branch-meta-icon--workspace-untrusted"
					title="Branch has no upstream or its upstream no longer exists"
					aria-label="Branch has no upstream or its upstream no longer exists"
				></span>
			`);
		}

		if (node.scope === 'local' && node.requiresForceUpdate) {
			tokens.push(`
				<span
					class="branch-meta-icon branch-meta-icon--error"
					title="Branch diverged from upstream. Regular update may fail; Force Update is available."
					aria-label="Branch diverged from upstream. Regular update may fail; Force Update is available."
				></span>
			`);
		}

		if (node.scope === 'local' && node.taskUrl) {
			tokens.push(`
				<span
					class="branch-meta-link branch-meta-icon branch-meta-icon--link-external"
					data-task-url="${escapeHtml(node.taskUrl)}"
					title="Open branch task"
					aria-label="Open branch task"
					role="button"
				></span>
			`);
		}

		if (node.scope === 'local' && node.behind > 0) {
			tokens.push(`<span class="branch-meta-token branch-meta-token--behind">↓ ${escapeHtml(String(node.behind))}</span>`);
		}

		if (node.scope === 'local' && node.ahead > 0) {
			tokens.push(`<span class="branch-meta-token branch-meta-token--ahead">↑ ${escapeHtml(String(node.ahead))}</span>`);
		}

		return tokens.join('');
	}

	function selectBranch(branchId) {
		state.selectedNodeId = branchId;
		state.selectedBranchId = branchId;
		state.selectedBranch = findBranchById(state.data.nodes || [], branchId);
		renderTree();
		scrollSelectedIntoView();
	}

	function selectNode(nodeId) {
		state.selectedNodeId = nodeId;
		const branch = findBranchById(state.data.nodes || [], nodeId);
		state.selectedBranchId = branch ? nodeId : null;
		state.selectedBranch = branch;
		renderTree();
		scrollSelectedIntoView();
	}

	function setFilterText(value) {
		state.filterText = value;
		elements.filterInput.value = value;
		renderTree();
	}

	function clearFilter() {
		setFilterText('');
		hideContextMenu();
	}

	function focusFirstResult() {
		const firstRow = getVisibleRowDescriptors()[0];
		if (!firstRow) {
			return;
		}

		selectRowDescriptor(firstRow);
		elements.tree.focus();
	}

	function focusView() {
		const rows = getVisibleRowDescriptors();
		if (rows.length > 0) {
			if (!state.selectedNodeId) {
				selectRowDescriptor(rows[0]);
			}
			elements.tree.focus();
			scrollSelectedIntoView();
			return;
		}

		elements.filterInput.focus();
	}

	function toggleGroup(groupId) {
		state.expanded.set(groupId, !Boolean(state.expanded.get(groupId)));
		renderTree();
		scrollSelectedIntoView();
	}

	function setGroupExpanded(groupId, expanded) {
		state.expanded.set(groupId, expanded);
		renderTree();
		scrollSelectedIntoView();
	}

	function getMenuItems(branch) {
		if (!branch) {
			return [];
		}

		const canEditLocal = branch.scope === 'local';
		const primaryItems = [];
		const secondaryItems = [];
		const advancedItems = [];

		if (canEditLocal) {
			primaryItems.push({ label: 'Push...', action: 'push', mnemonic: 'p' });
		}

		if (canEditLocal && !branch.isCurrent) {
			primaryItems.push({ label: 'Delete', action: 'delete', mnemonic: 'd' });
		}

		if (canEditLocal) {
			primaryItems.push({ label: 'Rename...', action: 'rename', hint: 'F2', mnemonic: 'r' });
		}

		if (!branch.isCurrent) {
			primaryItems.push({ label: 'Checkout', action: 'checkout', mnemonic: 'c' });
		}

		if (canEditLocal) {
			primaryItems.push({ label: 'Update', action: 'update', mnemonic: 'u' });
		}

		primaryItems.push({ label: 'New Branch from "{branch}"...', action: 'newFrom', mnemonic: 'n' });

		if (branch.taskUrl) {
			secondaryItems.push({ label: 'Go to task', action: 'openTask', mnemonic: 'g' });
		}

		secondaryItems.push({ label: 'Show Diff with Working Tree', action: 'showDiffWithWorkingTree', mnemonic: 'w' });

		if (!branch.isCurrent) {
			secondaryItems.unshift(
				{ label: 'Checkout and Rebase onto "{current}"', action: 'checkoutAndRebase', mnemonic: 'a' },
				{ label: 'Compare with "{current}"', action: 'compareWithCurrent', mnemonic: 'o' }
			);

			if (canEditLocal) {
				advancedItems.push(
					{ label: 'Rebase "{current}" onto "{branch}"', action: 'rebaseCurrentOnto', mnemonic: 'b' },
					{ label: 'Merge "{branch}" into "{current}"', action: 'mergeIntoCurrent', mnemonic: 'm' }
				);
			}
		}

		if (branch.requiresForceUpdate && canEditLocal) {
			advancedItems.push({ label: 'Force Update', action: 'forceUpdate', mnemonic: 'f' });
		}

		return joinMenuSections(primaryItems, secondaryItems, advancedItems);
	}

	function joinMenuSections(...sections) {
		const visibleSections = sections.filter((section) => section.length > 0);
		return visibleSections.flatMap((section, index) => (
			index === 0 ? section : [{ type: 'separator' }, ...section]
		));
	}

	function fillMenuTemplate(template, branch) {
		const currentBranch = findCurrentBranch(state.data.nodes || []);
		return template
			.replaceAll('{branch}', branch.branchRef)
			.replaceAll('{current}', currentBranch ? currentBranch.branchRef : 'current');
	}

	function findCurrentBranch(nodes) {
		const branches = [];
		flattenBranches(nodes, branches);
		return branches.find((branch) => branch.isCurrent) || null;
	}

	function showContextMenu(branch, x, y) {
		const items = getMenuItems(branch);
		if (!items.length) {
			return;
		}

		elements.contextMenu.innerHTML = items.map((item) => {
			if (item.type === 'separator') {
				return '<div class="context-menu-separator"></div>';
			}

			const disabledClass = item.disabled ? ' is-disabled' : '';
			return `
				<button
					class="context-menu-item${disabledClass}"
					type="button"
					data-menu-action="${item.action}"
					data-menu-mnemonic="${escapeHtml(item.mnemonic || '')}"
					${item.disabled ? 'disabled' : ''}
				>
					<span>${renderMenuLabel(fillMenuTemplate(item.label, branch), item.mnemonic)}</span>
					<span class="context-menu-hint">${escapeHtml(item.hint || '')}</span>
				</button>
			`;
		}).join('');

		elements.contextMenu.classList.add('is-visible');
		elements.contextMenu.setAttribute('aria-hidden', 'false');

		const menuRect = elements.contextMenu.getBoundingClientRect();
		const margin = 8;
		const bottomSafeArea = 12;
		const left = Math.min(x, Math.max(margin, window.innerWidth - menuRect.width - margin));
		const maxTop = Math.max(margin, window.innerHeight - menuRect.height - bottomSafeArea);
		const top = y + menuRect.height <= window.innerHeight - bottomSafeArea
			? y
			: maxTop;

		elements.contextMenu.style.left = `${left}px`;
		elements.contextMenu.style.top = `${top}px`;
		state.activeMenuIndex = getEnabledMenuItems().length > 0 ? 0 : -1;
		updateMenuActiveItem();
		elements.contextMenu.tabIndex = -1;
		elements.contextMenu.focus();
	}

	function showContextMenuForSelectedBranch() {
		if (!state.selectedBranch) {
			return false;
		}

		const selectedElement = elements.tree.querySelector(`[data-branch-id="${cssEscape(state.selectedBranch.id)}"]`);
		if (!selectedElement) {
			return false;
		}

		const rect = selectedElement.getBoundingClientRect();
		const x = Math.min(window.innerWidth - 12, rect.left + 24);
		const y = Math.min(window.innerHeight - 12, rect.top + Math.min(rect.height, 20));
		showContextMenu(state.selectedBranch, x, y);
		return true;
	}

	function hideContextMenu() {
		elements.contextMenu.classList.remove('is-visible');
		elements.contextMenu.setAttribute('aria-hidden', 'true');
		elements.contextMenu.innerHTML = '';
		state.activeMenuIndex = -1;
	}

	function handleDocumentScroll(event) {
		if (elements.contextMenu.contains(event.target)) {
			return;
		}

		hideContextMenu();
	}

	function renderMenuLabel(label, mnemonic) {
		if (!mnemonic) {
			return escapeHtml(label);
		}

		const lowerLabel = label.toLowerCase();
		const index = lowerLabel.indexOf(mnemonic.toLowerCase());
		if (index < 0) {
			return escapeHtml(label);
		}

		const before = escapeHtml(label.slice(0, index));
		const match = escapeHtml(label.slice(index, index + 1));
		const after = escapeHtml(label.slice(index + 1));
		return `${before}<span class="context-menu-mnemonic">${match}</span>${after}`;
	}

	function isContextMenuVisible() {
		return elements.contextMenu.classList.contains('is-visible');
	}

	function getEnabledMenuItems() {
		return Array.from(elements.contextMenu.querySelectorAll('[data-menu-action]:not(:disabled)'));
	}

	function updateMenuActiveItem() {
		const items = getEnabledMenuItems();
		items.forEach((item, index) => {
			item.classList.toggle('is-active', index === state.activeMenuIndex);
			if (index === state.activeMenuIndex) {
				item.scrollIntoView({ block: 'nearest' });
			}
		});
	}

	function triggerMenuMnemonic(key) {
		if (!isContextMenuVisible()) {
			return false;
		}

		const target = elements.contextMenu.querySelector(`[data-menu-mnemonic="${cssEscape(key.toLowerCase())}"]:not(:disabled)`);
		if (!target) {
			return false;
		}

		target.click();
		return true;
	}

	function handleContextMenuNavigation(event) {
		if (!isContextMenuVisible()) {
			return false;
		}

		const items = getEnabledMenuItems();
		if (!items.length) {
			return false;
		}

		if (event.key === 'ArrowDown') {
			state.activeMenuIndex = state.activeMenuIndex < 0
				? 0
				: (state.activeMenuIndex + 1) % items.length;
			updateMenuActiveItem();
			return true;
		}

		if (event.key === 'ArrowUp') {
			state.activeMenuIndex = state.activeMenuIndex < 0
				? items.length - 1
				: (state.activeMenuIndex - 1 + items.length) % items.length;
			updateMenuActiveItem();
			return true;
		}

		if (event.key === 'Enter') {
			const activeItem = items[state.activeMenuIndex];
			if (activeItem) {
				activeItem.click();
				return true;
			}
		}

		return false;
	}

	function handlePrintableTreeInput(event) {
		if (event.ctrlKey || event.metaKey || event.altKey) {
			return false;
		}

		if (event.key.length === 1) {
			const nextValue = `${state.filterText}${event.key}`;
			setFilterText(nextValue);
			elements.filterInput.focus();
			elements.filterInput.setSelectionRange(nextValue.length, nextValue.length);
			return true;
		}

		if (event.key === 'Backspace' && state.filterText) {
			const nextValue = state.filterText.slice(0, -1);
			setFilterText(nextValue);
			elements.filterInput.focus();
			elements.filterInput.setSelectionRange(nextValue.length, nextValue.length);
			return true;
		}

		if (event.key === 'Escape' && state.filterText) {
			clearFilter();
			elements.tree.focus();
			return true;
		}

		return false;
	}

	function bindEvents() {
		elements.filterInput.addEventListener('input', (event) => {
			setFilterText(event.target.value);
		});

		elements.filterInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter') {
				event.preventDefault();
				focusFirstResult();
				return;
			}

			if (event.key === 'Escape') {
				if (state.filterText) {
					event.preventDefault();
					clearFilter();
				}
				elements.tree.focus();
			}
		});

		elements.filterClear.addEventListener('click', () => {
			clearFilter();
			elements.filterInput.focus();
		});

		elements.tree.addEventListener('click', (event) => {
			const taskLinkButton = event.target.closest('[data-task-url]');
			if (taskLinkButton) {
				event.preventDefault();
				event.stopPropagation();
				vscode.postMessage({
					type: 'openExternal',
					url: taskLinkButton.getAttribute('data-task-url')
				});
				return;
			}

			const toggle = event.target.closest('[data-group-toggle]');
			if (toggle) {
				selectNode(toggle.getAttribute('data-node-id'));
				toggleGroup(toggle.getAttribute('data-group-toggle'));
				return;
			}

			const branchRow = event.target.closest('[data-branch-id]');
			if (!branchRow) {
				hideContextMenu();
				return;
			}

			selectBranch(branchRow.getAttribute('data-branch-id'));
			elements.tree.focus();
			hideContextMenu();
		});

		elements.tree.addEventListener('mousedown', (event) => {
			const taskLinkButton = event.target.closest('[data-task-url]');
			if (taskLinkButton) {
				event.preventDefault();
				event.stopPropagation();
				return;
			}

			const row = event.target.closest('[data-node-id]');
			if (!row) {
				return;
			}

			event.preventDefault();
			elements.tree.focus();

			const branchId = row.getAttribute('data-branch-id');
			if (branchId) {
				selectBranch(branchId);
				return;
			}

			selectNode(row.getAttribute('data-node-id'));
		});

		elements.tree.addEventListener('contextmenu', (event) => {
			const branchRow = event.target.closest('[data-branch-id]');
			if (!branchRow) {
				return;
			}

			event.preventDefault();
			elements.tree.focus();
			const branchId = branchRow.getAttribute('data-branch-id');
			selectBranch(branchId);

			const branch = findBranchById(state.data.nodes || [], branchId);
			if (!branch) {
				return;
			}

			showContextMenu(branch, event.clientX, event.clientY);
		});

		elements.tree.addEventListener('keydown', (event) => {
			const isMenuShortcut =
				(event.shiftKey && event.key === 'F10') ||
				event.key === 'ContextMenu' ||
				((event.ctrlKey || event.metaKey) && event.key === '.');

			if (isMenuShortcut && state.selectedBranch) {
				event.preventDefault();
				showContextMenuForSelectedBranch();
				return;
			}

			if (isContextMenuVisible()) {
				if (handleContextMenuNavigation(event)) {
					event.preventDefault();
					return;
				}
			}

			if (triggerMenuMnemonic(event.key)) {
				event.preventDefault();
				return;
			}

			if (event.key === 'Escape' && isContextMenuVisible()) {
				event.preventDefault();
				hideContextMenu();
				return;
			}

			if (handlePrintableTreeInput(event)) {
				event.preventDefault();
				return;
			}

			if (handleTreeNavigation(event)) {
				event.preventDefault();
				hideContextMenu();
				return;
			}

			if (event.key === 'Enter' && state.selectedBranch && !state.selectedBranch.isCurrent) {
				event.preventDefault();
				vscode.postMessage({
					type: 'branchAction',
					action: 'checkout',
					branchRef: state.selectedBranch.branchRef,
					scope: state.selectedBranch.scope,
					isCurrent: state.selectedBranch.isCurrent
				});
			}
		});

		document.addEventListener('click', (event) => {
			if (!elements.contextMenu.contains(event.target)) {
				hideContextMenu();
			}
		});

		document.addEventListener('visibilitychange', () => {
			if (document.hidden) {
				hideContextMenu();
			}
		});

		document.addEventListener('scroll', handleDocumentScroll, true);
		window.addEventListener('resize', hideContextMenu);
		window.addEventListener('blur', () => {
			hideContextMenu();
			sendFocusState(false);
		});
		window.addEventListener('focus', () => {
			sendFocusState(true);
		});
		document.addEventListener('focusin', () => {
			sendFocusState(true);
		});

		elements.contextMenu.addEventListener('click', (event) => {
			const actionButton = event.target.closest('[data-menu-action]');
			if (!actionButton || !state.selectedBranch) {
				return;
			}

			if (actionButton.disabled) {
				return;
			}

			const action = actionButton.getAttribute('data-menu-action');
			if (action === 'openTask') {
				if (state.selectedBranch.taskUrl) {
					vscode.postMessage({
						type: 'openExternal',
						url: state.selectedBranch.taskUrl
					});
				}
				hideContextMenu();
				elements.tree.focus();
				return;
			}

			vscode.postMessage({
				type: 'branchAction',
				action,
				branchRef: state.selectedBranch.branchRef,
				scope: state.selectedBranch.scope,
				isCurrent: state.selectedBranch.isCurrent
			});
			hideContextMenu();
			elements.tree.focus();
		});

		elements.contextMenu.addEventListener('keydown', (event) => {
			if (handleContextMenuNavigation(event)) {
				event.preventDefault();
				return;
			}

			if (triggerMenuMnemonic(event.key)) {
				event.preventDefault();
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				hideContextMenu();
				elements.tree.focus();
			}
		});

		window.addEventListener('message', (event) => {
			const message = event.data;
			if (!message || typeof message !== 'object' || !('type' in message)) {
				return;
			}

			if (message.type === 'focusView') {
				focusView();
				return;
			}

			if (message.type === 'setState') {
				state.data = message.payload;
				ensureExpandedDefaults(state.data.nodes || []);

				if (!state.selectedNodeId) {
					const firstNode = getVisibleRowDescriptors()[0];
					if (firstNode) {
						state.selectedNodeId = firstNode.id;
					}
				}

				if (state.selectedBranchId && !findBranchById(state.data.nodes || [], state.selectedBranchId)) {
					state.selectedBranchId = null;
					state.selectedBranch = null;
				} else if (state.selectedBranchId) {
					state.selectedBranch = findBranchById(state.data.nodes || [], state.selectedBranchId);
				}

				renderTree();
			}
		});
	}

	function escapeHtml(value) {
		return String(value)
			.replaceAll('&', '&amp;')
			.replaceAll('<', '&lt;')
			.replaceAll('>', '&gt;')
			.replaceAll('"', '&quot;')
			.replaceAll("'", '&#39;');
	}

	function cssEscape(value) {
		return String(value).replace(/["\\]/g, '\\$&');
	}

	function getVisibleRowDescriptors() {
		const rows = [];
		const query = normalizeText(state.filterText);
		const nodes = getVisibleNodes();

		function walk(items, parentGroupId) {
			items.forEach((node) => {
				if (node.type === 'group') {
					const expanded = query ? true : Boolean(state.expanded.get(node.id));
					rows.push({ id: node.id, type: 'group', parentGroupId, expanded });
					if (expanded) {
						walk(node.children, node.id);
					}
					return;
				}

				rows.push({ id: node.id, type: 'branch', parentGroupId, branch: node });
			});
		}

		walk(nodes, null);
		return rows;
	}

	function handleTreeNavigation(event) {
		const rows = getVisibleRowDescriptors();
		if (!rows.length) {
			return false;
		}

		const currentIndex = Math.max(0, rows.findIndex((row) => row.id === state.selectedNodeId));
		const currentRow = rows[currentIndex];

		if (event.key === 'ArrowDown') {
			const nextRow = rows[Math.min(rows.length - 1, currentIndex + 1)];
			selectRowDescriptor(nextRow);
			return true;
		}

		if (event.key === 'ArrowUp') {
			const prevRow = rows[Math.max(0, currentIndex - 1)];
			selectRowDescriptor(prevRow);
			return true;
		}

		if (event.key === 'ArrowRight') {
			if (currentRow.type === 'group' && !currentRow.expanded) {
				setGroupExpanded(currentRow.id, true);
				return true;
			}

			return false;
		}

		if (event.key === 'ArrowLeft') {
			if (currentRow.type === 'group' && currentRow.expanded) {
				setGroupExpanded(currentRow.id, false);
				return true;
			}

			if (currentRow.parentGroupId) {
				setGroupExpanded(currentRow.parentGroupId, false);
				selectNode(currentRow.parentGroupId);
				return true;
			}

			return false;
		}

		return false;
	}

	function selectRowDescriptor(row) {
		if (!row) {
			return;
		}

		if (row.type === 'branch') {
			selectBranch(row.id);
			return;
		}

		selectNode(row.id);
	}

	function scrollSelectedIntoView() {
		if (!state.selectedNodeId) {
			return;
		}

		const selectedElement = elements.tree.querySelector(`[data-node-id="${cssEscape(state.selectedNodeId)}"]`);
		selectedElement?.scrollIntoView({ block: 'nearest' });
	}

	bindEvents();
	ensureExpandedDefaults(state.data.nodes || []);
	renderTree();
	vscode.postMessage({ type: 'ready' });
}());
