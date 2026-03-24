(function () {
	const vscode = acquireVsCodeApi();
	const bootstrap = document.getElementById('jb-git-changes-bootstrap');
	const initialState = bootstrap?.textContent ? JSON.parse(bootstrap.textContent) : {
		selectedCommitHash: undefined,
		files: []
	};

	const elements = {
		filterInput: document.getElementById('changes-filter-input'),
		filterClear: document.getElementById('changes-filter-clear'),
		modeToggle: document.getElementById('changes-mode-toggle'),
		meta: document.getElementById('changes-meta'),
		content: document.getElementById('changes-content')
	};

	const state = {
		data: initialState,
		filterText: '',
		mode: 'tree',
		selectedRowId: null,
		tooltipTimer: null,
		tooltipTargetId: null,
		lastFocusState: null
	};

	const tooltipElement = document.createElement('div');
	tooltipElement.className = 'changes-tooltip';
	document.body.appendChild(tooltipElement);

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

	function normalize(value) {
		return value.trim().toLowerCase();
	}

	function buildTree(files) {
		const root = [];
		const directoryMap = new Map();

		for (const file of files) {
			const path = file.path;
			const parts = path.split('/').filter(Boolean);
			let currentChildren = root;
			let parentPath = '';

			for (let index = 0; index < parts.length; index += 1) {
				const part = parts[index];
				const currentPath = parentPath ? `${parentPath}/${part}` : part;
				const isLast = index === parts.length - 1;

				if (isLast) {
					currentChildren.push({
						type: 'file',
						id: `file:${currentPath}`,
						path: currentPath,
						name: part,
						added: file.added,
						deleted: file.deleted,
						status: file.status || 'M'
					});
					continue;
				}

				if (!directoryMap.has(currentPath)) {
					const directory = {
						type: 'directory',
						id: `dir:${currentPath}`,
						name: part,
						path: currentPath,
						children: []
					};
					directoryMap.set(currentPath, directory);
					currentChildren.push(directory);
				}

				currentChildren = directoryMap.get(currentPath).children;
				parentPath = currentPath;
			}
		}

		return sortTreeNodes(root);
	}

	function sortTreeNodes(nodes) {
		nodes.sort((a, b) => {
			if (a.type !== b.type) {
				return a.type === 'directory' ? -1 : 1;
			}

			return a.name.localeCompare(b.name);
		});

		nodes.forEach((node) => {
			if (node.type === 'directory') {
				sortTreeNodes(node.children);
			}
		});

		return nodes;
	}

	function filterPaths(files, query) {
		if (!query) {
			return files;
		}

		return files.filter((file) => file.path.toLowerCase().includes(query));
	}

	function getVisibleRows() {
		const filteredFiles = filterPaths(state.data.files || [], normalize(state.filterText));
		if (state.mode === 'list') {
			return filteredFiles.map((file) => ({
				id: `file:${file.path}`,
				type: 'file',
				path: file.path,
				label: file.path,
				depth: 0,
				added: file.added,
				deleted: file.deleted,
				status: file.status || 'M'
			}));
		}

		const rows = [];
		const walk = (nodes, depth) => {
			nodes.forEach((node) => {
				rows.push({
					id: node.id,
					type: node.type,
					path: node.path,
					label: node.name,
					depth,
					added: node.type === 'file' ? node.added : 0,
					deleted: node.type === 'file' ? node.deleted : 0,
					status: node.type === 'file' ? node.status : ''
				});
				if (node.type === 'directory') {
					walk(node.children, depth + 1);
				}
			});
		};
		walk(buildTree(filteredFiles), 0);
		return rows;
	}

	function ensureSelection() {
		const rows = getVisibleRows();
		if (!rows.length) {
			state.selectedRowId = null;
			return;
		}

		if (!state.selectedRowId || !rows.some((row) => row.id === state.selectedRowId)) {
			state.selectedRowId = rows[0].id;
		}
	}

	function render() {
		const filteredFiles = filterPaths(state.data.files || [], normalize(state.filterText));
		ensureSelection();
		const rows = getVisibleRows();
		hideTooltip();
		elements.filterInput.value = state.filterText;
		elements.filterClear.classList.toggle('is-visible', Boolean(state.filterText));
		elements.modeToggle.textContent = state.mode === 'tree' ? 'Tree' : 'List';
		elements.meta.textContent = state.data.selectedCommitHash
			? `${filteredFiles.length} files`
			: 'Select a commit to view changed files.';

		if (!state.data.selectedCommitHash) {
			elements.content.innerHTML = '<div class="changes-empty">No commit selected.</div>';
			return;
		}

		if (!rows.length) {
			elements.content.innerHTML = '<div class="changes-empty">No files match the current filter.</div>';
			return;
		}

		if (state.mode === 'tree') {
			elements.content.innerHTML = renderTreeMarkup(buildTree(filteredFiles));
		} else {
			elements.content.innerHTML = `
				<ul class="changes-list">
					${rows.map((row) => renderRowMarkup(row, true)).join('')}
				</ul>
			`;
		}
		scrollSelectedIntoView();
	}

	function renderTreeMarkup(nodes, isRoot = true) {
		return `
			<ul class="${isRoot ? 'changes-tree-root' : 'changes-tree-list'}">
				${nodes.map((node) => {
					const row = {
						id: node.id,
						type: node.type,
						path: node.path,
						label: node.name,
						added: node.type === 'file' ? node.added : 0,
						deleted: node.type === 'file' ? node.deleted : 0,
						status: node.type === 'file' ? node.status : ''
					};
					const children = node.type === 'directory' ? renderTreeMarkup(node.children, false) : '';
					return `<li>${renderRowMarkup(row, false)}${children}</li>`;
				}).join('')}
			</ul>
		`;
	}

	function renderRowMarkup(row, useFullPath) {
		const labelText = useFullPath ? row.path : row.label;
		const labelToneClass = row.type === 'file' ? getLabelToneClass(row.status) : '';
		return `
			<button
				class="changes-row${row.id === state.selectedRowId ? ' is-selected' : ''}"
				type="button"
				data-row-id="${escapeHtml(row.id)}"
				data-row-type="${escapeHtml(row.type)}"
				data-row-path="${escapeHtml(row.path)}"
			>
				<span class="changes-row-main">
					<span class="changes-row-icon">${row.type === 'directory' ? '▾' : ''}</span>
					<span class="changes-row-label${labelToneClass ? ` ${labelToneClass}` : ''}" data-full-path="${escapeHtml(row.path)}">${escapeHtml(labelText)}</span>
				</span>
				${row.type === 'file' ? `<span class="changes-row-stats"><span class="changes-row-added">+${escapeHtml(String(row.added))}</span><span class="changes-row-deleted">-${escapeHtml(String(row.deleted))}</span></span>` : '<span class="changes-row-stats"></span>'}
			</button>
		`;
	}

	function getLabelToneClass(status) {
		const normalizedStatus = String(status || '').trim().toUpperCase();
		if (normalizedStatus.startsWith('A')) {
			return 'is-added';
		}

		if (normalizedStatus.startsWith('D')) {
			return 'is-deleted';
		}

		return '';
	}

	function clearTooltipTimer() {
		if (state.tooltipTimer !== null) {
			window.clearTimeout(state.tooltipTimer);
			state.tooltipTimer = null;
		}
	}

	function hideTooltip() {
		clearTooltipTimer();
		state.tooltipTargetId = null;
		tooltipElement.classList.remove('is-visible');
		tooltipElement.textContent = '';
		tooltipElement.style.left = '-9999px';
		tooltipElement.style.top = '-9999px';
	}

	function isTruncated(labelElement) {
		return labelElement.scrollWidth > labelElement.clientWidth + 1;
	}

	function scheduleTooltip(labelElement) {
		if (!labelElement) {
			hideTooltip();
			return;
		}

		const targetId = labelElement.closest('[data-row-id]')?.getAttribute('data-row-id') ?? null;
		if (!targetId) {
			hideTooltip();
			return;
		}

		if (!isTruncated(labelElement)) {
			hideTooltip();
			return;
		}

		clearTooltipTimer();
		state.tooltipTargetId = targetId;
		state.tooltipTimer = window.setTimeout(() => {
			showTooltip(labelElement, targetId);
		}, 3000);
	}

	function showTooltip(labelElement, targetId) {
		if (!document.body.contains(labelElement) || state.tooltipTargetId !== targetId || !isTruncated(labelElement)) {
			hideTooltip();
			return;
		}

		const fullPath = labelElement.getAttribute('data-full-path');
		if (!fullPath) {
			hideTooltip();
			return;
		}

		tooltipElement.textContent = fullPath;
		tooltipElement.classList.add('is-visible');
		const labelRect = labelElement.getBoundingClientRect();
		const tooltipRect = tooltipElement.getBoundingClientRect();
		let left = labelRect.left;
		let top = labelRect.bottom + 8;

		if (left + tooltipRect.width > window.innerWidth - 8) {
			left = window.innerWidth - tooltipRect.width - 8;
		}

		if (top + tooltipRect.height > window.innerHeight - 8) {
			top = labelRect.top - tooltipRect.height - 8;
		}

		tooltipElement.style.left = `${Math.max(8, left)}px`;
		tooltipElement.style.top = `${Math.max(8, top)}px`;
	}

	function scrollSelectedIntoView() {
		if (!state.selectedRowId) {
			return;
		}

		elements.content.querySelector(`[data-row-id="${cssEscape(state.selectedRowId)}"]`)?.scrollIntoView({ block: 'nearest' });
	}

	function openSelectedFileDiff() {
		const rows = getVisibleRows();
		const selectedRow = rows.find((row) => row.id === state.selectedRowId);
		if (!selectedRow || selectedRow.type !== 'file') {
			return;
		}

		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}

		vscode.postMessage({
			type: 'openFileDiff',
			path: selectedRow.path
		});
	}

	function moveSelection(delta) {
		const rows = getVisibleRows();
		if (!rows.length) {
			return;
		}

		const currentIndex = Math.max(0, rows.findIndex((row) => row.id === state.selectedRowId));
		const nextIndex = (currentIndex + delta + rows.length) % rows.length;
		state.selectedRowId = rows[nextIndex].id;
		render();
	}

	function focusFirstResult() {
		const rows = getVisibleRows();
		if (!rows.length) {
			return;
		}

		state.selectedRowId = rows[0].id;
		render();
		elements.content.focus();
	}

	function focusView() {
		const rows = getVisibleRows();
		if (rows.length > 0) {
			if (!state.selectedRowId || !rows.some((row) => row.id === state.selectedRowId)) {
				state.selectedRowId = rows[0].id;
				render();
			}
			elements.content.focus();
			scrollSelectedIntoView();
			return;
		}

		elements.filterInput.focus();
	}

	function bindEvents() {
		elements.filterInput.addEventListener('input', (event) => {
			state.filterText = event.target.value;
			render();
		});

		elements.filterInput.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === 'ArrowDown') {
				event.preventDefault();
				focusFirstResult();
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				if (state.filterText) {
					state.filterText = '';
					render();
				} else {
					elements.content.focus();
				}
			}
		});

		elements.filterClear.addEventListener('click', () => {
			state.filterText = '';
			render();
			elements.filterInput.focus();
		});

		elements.modeToggle.addEventListener('click', () => {
			state.mode = state.mode === 'tree' ? 'list' : 'tree';
			render();
		});

		elements.content.addEventListener('mouseover', (event) => {
			const labelElement = event.target.closest('.changes-row-label');
			if (!labelElement) {
				hideTooltip();
				return;
			}

			const previousLabel = event.relatedTarget instanceof Element
				? event.relatedTarget.closest('.changes-row-label')
				: null;
			if (previousLabel === labelElement) {
				return;
			}

			scheduleTooltip(labelElement);
		});

		elements.content.addEventListener('mouseout', (event) => {
			const labelElement = event.target.closest('.changes-row-label');
			if (!labelElement) {
				return;
			}

			const nextLabel = event.relatedTarget instanceof Element
				? event.relatedTarget.closest('.changes-row-label')
				: null;
			if (nextLabel === labelElement) {
				return;
			}

			hideTooltip();
		});

		elements.content.addEventListener('mouseleave', () => {
			hideTooltip();
		});

		elements.content.addEventListener('scroll', () => {
			hideTooltip();
		});

		elements.content.addEventListener('mousedown', (event) => {
			const row = event.target.closest('[data-row-id]');
			if (!row) {
				return;
			}

			event.preventDefault();
		});

		elements.content.addEventListener('click', (event) => {
			const row = event.target.closest('[data-row-id]');
			if (!row) {
				return;
			}

			hideTooltip();
			state.selectedRowId = row.getAttribute('data-row-id');
			render();

			if (row.getAttribute('data-row-type') === 'file') {
				if (document.activeElement instanceof HTMLElement) {
					document.activeElement.blur();
				}

				vscode.postMessage({
					type: 'openFileDiff',
					path: row.getAttribute('data-row-path')
				});
				return;
			}

			elements.content.focus();
		});

		elements.content.addEventListener('keydown', (event) => {
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				hideTooltip();
				moveSelection(1);
				return;
			}

			if (event.key === 'ArrowUp') {
				event.preventDefault();
				hideTooltip();
				moveSelection(-1);
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				hideTooltip();
				elements.filterInput.focus();
				elements.filterInput.select();
				return;
			}

			if (event.key === 'Enter') {
				event.preventDefault();
				hideTooltip();
				openSelectedFileDiff();
			}
		});

		window.addEventListener('blur', () => {
			hideTooltip();
			sendFocusState(false);
		});
		window.addEventListener('focus', () => {
			sendFocusState(true);
		});
		document.addEventListener('focusin', () => {
			sendFocusState(true);
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
				hideTooltip();
				state.data = message.payload;
				render();
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

	bindEvents();
	render();
	vscode.postMessage({ type: 'ready' });
}());
