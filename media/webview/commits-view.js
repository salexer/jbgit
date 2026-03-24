(function () {
	const vscode = acquireVsCodeApi();
	const bootstrap = document.getElementById('jb-git-commits-bootstrap');
	const initialState = bootstrap?.textContent ? JSON.parse(bootstrap.textContent) : {
		currentBranch: undefined,
		loadedBranch: undefined,
		commits: [],
		branchOptions: [{ value: 'all', label: 'All' }],
		userOptions: [{ value: 'all', label: 'All' }],
		dateOptions: [{ value: 'all', label: 'All' }],
		pathOptions: [{ value: 'all', label: 'All' }]
	};

	const elements = {
		search: document.getElementById('commit-search'),
		searchHistory: document.getElementById('commit-search-history'),
		searchClear: document.getElementById('commit-search-clear'),
		regex: document.getElementById('commit-regex'),
		matchCase: document.getElementById('commit-match-case'),
		branch: document.getElementById('commit-branch-filter'),
		cherryPick: document.getElementById('commit-cherry-pick'),
		meta: document.getElementById('commit-toolbar-meta'),
		list: document.getElementById('commit-list'),
		searchAssist: document.getElementById('commit-search-assist'),
		filterMenu: document.getElementById('commit-filter-menu'),
		menu: document.getElementById('commit-context-menu')
	};

	const persisted = vscode.getState() || {};
	const state = {
		data: initialState,
		searchDraft: persisted.searchText || '',
		searchApplied: persisted.searchText || '',
		regex: Boolean(persisted.regex),
		matchCase: Boolean(persisted.matchCase),
		branch: persisted.branch || 'all',
		searchHistory: Array.isArray(persisted.searchHistory) ? persisted.searchHistory : [],
		selectedHash: null,
		activeFilterKey: null,
		filterMenuQuery: '',
		activeSearchAssistIndex: -1,
		activeFilterIndex: -1,
		activeMenuIndex: -1,
		lastNotifiedCommitHash: null,
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

	function saveState() {
		vscode.setState({
			searchText: state.searchApplied,
			regex: state.regex,
			matchCase: state.matchCase,
			branch: state.branch,
			searchHistory: state.searchHistory.slice(0, 10)
		});
	}

	function getFilterOptions(key) {
		switch (key) {
			case 'branch':
				return state.data.branchOptions;
			default:
				return [{ value: 'all', label: 'All' }];
		}
	}

	function getFilterTitle(key) {
		switch (key) {
			case 'branch':
				return 'Branch';
			default:
				return '';
		}
	}

	function getFilterValueLabel(key, value) {
		const options = getFilterOptions(key);
		return options.find((option) => option.value === value)?.label || options[0]?.label || 'All';
	}

	function renderFilterTrigger(button, key, value) {
		const title = getFilterTitle(key);
		const hasValue = value !== 'all';
		const valueLabel = getFilterValueLabel(key, value);
		button.classList.toggle('is-active', hasValue);
		button.setAttribute('aria-expanded', state.activeFilterKey === key ? 'true' : 'false');
		button.innerHTML = hasValue
			? `<span class="filter-trigger-prefix">${escapeHtml(title)}:</span><span class="filter-trigger-value">${escapeHtml(valueLabel)}</span><span class="filter-trigger-clear" data-filter-clear="${key}" aria-hidden="true">×</span>`
			: `<span class="filter-trigger-label">${escapeHtml(title)}</span>`;
	}

	function renderToolbar() {
		elements.search.value = state.searchDraft;
		elements.searchHistory.innerHTML = state.searchHistory
			.map((value) => `<option value="${escapeHtml(value)}"></option>`)
			.join('');
		elements.regex.classList.toggle('is-active', state.regex);
		elements.matchCase.classList.toggle('is-active', state.matchCase);
		if (!getFilterOptions('branch').some((option) => option.value === state.branch)) {
			state.branch = 'all';
		}
		renderFilterTrigger(elements.branch, 'branch', state.branch);
		elements.searchClear.disabled = state.searchDraft.length === 0;
		const visibleCount = getVisibleCommits().length;
		const totalCount = state.data.commits.length;
		const currentBranchText = state.data.currentBranch ? `Current branch: ${state.data.currentBranch}` : 'Detached HEAD';
		const loadedBranchText = state.data.loadedBranch ? ` • Log branch: ${state.data.loadedBranch}` : '';
		elements.meta.textContent = `${currentBranchText}${loadedBranchText} • ${visibleCount}/${totalCount} commits`;
	}

	function clearToolbarControl(control) {
		if (control === elements.search || control === elements.searchClear) {
			state.searchDraft = '';
			state.searchApplied = '';
			saveState();
			hideSearchAssist();
			renderToolbar();
			renderCommits();
			elements.search.focus();
			return true;
		}

		if (control === elements.regex && state.regex) {
			state.regex = false;
			saveState();
			renderToolbar();
			renderCommits();
			elements.regex.focus();
			return true;
		}

		if (control === elements.matchCase && state.matchCase) {
			state.matchCase = false;
			saveState();
			renderToolbar();
			renderCommits();
			elements.matchCase.focus();
			return true;
		}

		if (control === elements.branch && state.branch !== 'all') {
			applyFilterValue('branch', 'all');
			elements.branch.focus();
			return true;
		}

		return false;
	}

	function handleToolbarNavigation(event, currentElement) {
		if (event.key === 'ArrowDown') {
			event.preventDefault();
			elements.list.focus();
			return true;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			return clearToolbarControl(currentElement);
		}

		return false;
	}

	function isFilterMenuVisible() {
		return elements.filterMenu.classList.contains('is-visible');
	}

	function getVisibleFilterOptions() {
		const items = Array.from(elements.filterMenu.querySelectorAll('[data-filter-value]'));
		return items.filter((item) => !item.classList.contains('is-hidden'));
	}

	function getFilterMenuButtons() {
		return getVisibleFilterOptions();
	}

	function updateFilterMenuActiveItem() {
		const items = getFilterMenuButtons();
		items.forEach((item, index) => {
			item.classList.toggle('is-active', index === state.activeFilterIndex);
			if (index === state.activeFilterIndex) {
				item.scrollIntoView({ block: 'nearest' });
			}
		});
	}

	function renderFilterMenu() {
		if (!state.activeFilterKey) {
			return;
		}

		const options = getFilterOptions(state.activeFilterKey);
		const currentValue = state[state.activeFilterKey];
		elements.filterMenu.innerHTML = `
			<div class="commit-filter-search-box">
				<input
					id="commit-filter-menu-search"
					class="commit-filter-search-input"
					type="text"
					placeholder="Filter..."
					autocomplete="off"
					spellcheck="false"
					value="${escapeHtml(state.filterMenuQuery)}"
				/>
			</div>
			<div class="commit-filter-menu-list">${options.map((option) => `
				<button
					class="commit-filter-menu-item${option.value === currentValue ? ' is-selected' : ''}"
					type="button"
					data-filter-value="${escapeHtml(option.value)}"
				>
					<span>${escapeHtml(option.label)}</span>
					${option.value === currentValue ? '<span class="commit-filter-menu-check" aria-hidden="true">✓</span>' : ''}
				</button>
			`).join('')}</div>
			<div class="commit-filter-menu-empty" hidden>No matches</div>
		`;

		applyFilterMenuQuery();
		const visibleItems = getVisibleFilterOptions();
		const selectedIndex = Math.max(0, visibleItems.findIndex((item) => item.getAttribute('data-filter-value') === currentValue));
		state.activeFilterIndex = selectedIndex;
		updateFilterMenuActiveItem();
	}

	function applyFilterMenuQuery() {
		const query = state.filterMenuQuery.trim().toLowerCase();
		const items = getFilterMenuButtons();
		let visibleCount = 0;
		items.forEach((item) => {
			const label = item.textContent?.toLowerCase() || '';
			const value = item.getAttribute('data-filter-value')?.toLowerCase() || '';
			const matches = !query || label.includes(query) || value.includes(query);
			item.classList.toggle('is-hidden', !matches);
			if (matches) {
				visibleCount += 1;
			}
		});

		const empty = elements.filterMenu.querySelector('.commit-filter-menu-empty');
		if (empty) {
			empty.hidden = visibleCount > 0;
		}

		const visibleItems = getVisibleFilterOptions();
		if (state.activeFilterIndex >= visibleItems.length) {
			state.activeFilterIndex = visibleItems.length > 0 ? visibleItems.length - 1 : -1;
		}
		updateFilterMenuActiveItem();
	}

	function positionFilterMenu(anchor) {
		const rect = anchor.getBoundingClientRect();
		const menuRect = elements.filterMenu.getBoundingClientRect();
		const margin = 8;
		const left = Math.min(rect.left, window.innerWidth - menuRect.width - margin);
		const preferredTop = rect.bottom + 6;
		const fitsBelow = preferredTop + menuRect.height <= window.innerHeight - margin;
		const top = fitsBelow
			? preferredTop
			: Math.max(margin, rect.top - menuRect.height - 6);
		elements.filterMenu.style.left = `${Math.max(margin, left)}px`;
		elements.filterMenu.style.top = `${top}px`;
	}

	function showFilterMenu(key, anchor) {
		state.activeFilterKey = key;
		state.filterMenuQuery = '';
		renderToolbar();
		renderFilterMenu();
		elements.filterMenu.classList.add('is-visible');
		elements.filterMenu.setAttribute('aria-hidden', 'false');
		positionFilterMenu(anchor);
		elements.filterMenu.querySelector('#commit-filter-menu-search')?.focus();
	}

	function hideFilterMenu() {
		elements.filterMenu.classList.remove('is-visible');
		elements.filterMenu.setAttribute('aria-hidden', 'true');
		elements.filterMenu.innerHTML = '';
		state.activeFilterKey = null;
		state.filterMenuQuery = '';
		state.activeFilterIndex = -1;
		renderToolbar();
	}

	function applyFilterValue(key, value) {
		state[key] = value;
		saveState();
		hideFilterMenu();
		renderToolbar();
		if (key === 'branch') {
			vscode.postMessage({
				type: 'branchFilterChanged',
				branch: value
			});
			elements.list.focus();
			return;
		}

		renderCommits();
	}

	function handleFilterMenuKey(event) {
		if (!isFilterMenuVisible()) {
			return false;
		}

		const items = getFilterMenuButtons();
		if (!items.length) {
			return false;
		}

		if (event.key === 'ArrowDown') {
			if (state.activeFilterIndex >= items.length - 1) {
				state.activeFilterIndex = -1;
				elements.filterMenu.querySelector('#commit-filter-menu-search')?.focus();
				return true;
			}

			state.activeFilterIndex += 1;
			updateFilterMenuActiveItem();
			items[state.activeFilterIndex]?.focus();
			return true;
		}

		if (event.key === 'ArrowUp') {
			if (state.activeFilterIndex <= 0) {
				state.activeFilterIndex = -1;
				elements.filterMenu.querySelector('#commit-filter-menu-search')?.focus();
				return true;
			}

			state.activeFilterIndex -= 1;
			updateFilterMenuActiveItem();
			items[state.activeFilterIndex]?.focus();
			return true;
		}

		if (event.key === 'Enter') {
			items[state.activeFilterIndex]?.click();
			return true;
		}

		if (event.key === 'Escape') {
			const activeKey = state.activeFilterKey;
			hideFilterMenu();
			if (activeKey) {
				elements[activeKey]?.focus?.();
			}
			return true;
		}

		return false;
	}

	function handleFilterMenuSearchKey(event) {
		if (!isFilterMenuVisible()) {
			return false;
		}

		const items = getFilterMenuButtons();
		if (event.key === 'ArrowDown' && items.length > 0) {
			event.preventDefault();
			state.activeFilterIndex = 0;
			updateFilterMenuActiveItem();
			items[0]?.focus();
			return true;
		}

		if (event.key === 'ArrowUp' && items.length > 0) {
			event.preventDefault();
			state.activeFilterIndex = items.length - 1;
			updateFilterMenuActiveItem();
			items[state.activeFilterIndex]?.focus();
			return true;
		}

		if (event.key === 'Enter' && items.length > 0) {
			event.preventDefault();
			items[Math.max(0, state.activeFilterIndex)]?.click();
			return true;
		}

		if (event.key === 'Escape') {
			event.preventDefault();
			const activeKey = state.activeFilterKey;
			hideFilterMenu();
			if (activeKey) {
				elements[activeKey]?.focus?.();
			}
			return true;
		}

		return false;
	}

	function normalize(value) {
		return state.matchCase ? value : value.toLowerCase();
	}

	function tokenizeSearch(query) {
		return query.match(/"[^"]+"|\S+/g) || [];
	}

	function parseDateToken(value) {
		const match = value.trim().match(/^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/);
		if (!match) {
			return null;
		}

		const [, dayText, monthText, yearText] = match;
		const day = Number(dayText);
		const month = Number(monthText);
		const year = yearText ? Number(yearText) : new Date().getFullYear();
		if (day < 1 || day > 31 || month < 1 || month > 12) {
			return null;
		}

		return { day, month, year };
	}

	function parseSmartQuery(query) {
		const parsed = {
			text: '',
			authors: [],
			paths: [],
			dates: []
		};

		for (const rawToken of tokenizeSearch(query)) {
			const token = rawToken.replace(/^"|"$/g, '');
			const separatorIndex = token.indexOf(':');
			if (separatorIndex > 0) {
				const field = token.slice(0, separatorIndex).toLowerCase();
				const value = token.slice(separatorIndex + 1).trim();
				if (field === 'date' && value) {
					const parsedDate = parseDateToken(value);
					if (parsedDate) {
						parsed.dates.push(parsedDate);
						continue;
					}
				}

				if (field === 'path' && value) {
					parsed.paths.push(value);
					continue;
				}

				if (field === 'author' && value) {
					parsed.authors.push(value);
					continue;
				}
			}

			if (token.length > 0) {
				parsed.text += `${parsed.text ? ' ' : ''}${token}`;
			}
		}

		return parsed;
	}

	function commitMatchesSearch(commit) {
		const query = parseSmartQuery(state.searchApplied);
		if (query.dates.length > 0) {
			const commitDate = new Date(commit.dateIso);
			const matchesDate = query.dates.some((date) =>
				commitDate.getFullYear() === date.year &&
				commitDate.getMonth() + 1 === date.month &&
				commitDate.getDate() === date.day
			);
			if (!matchesDate) {
				return false;
			}
		}

		if (query.paths.length > 0) {
			const matchesPath = query.paths.every((pathQuery) => {
				if (!state.regex) {
					return commit.paths.some((path) => path === pathQuery || path.startsWith(`${pathQuery}/`));
				}

				try {
					const regex = new RegExp(pathQuery, state.matchCase ? 'g' : 'gi');
					return commit.paths.some((path) => regex.test(path));
				} catch {
					return true;
				}
			});
			if (!matchesPath) {
				return false;
			}
		}

		if (query.authors.length > 0) {
			const authorHaystack = [commit.authorName, commit.authorEmail].join('\n');
			const matchesAuthor = query.authors.every((authorQuery) => {
				if (!state.regex) {
					return normalize(authorHaystack).includes(normalize(authorQuery));
				}

				try {
					const regex = new RegExp(authorQuery, state.matchCase ? 'g' : 'gi');
					return regex.test(authorHaystack);
				} catch {
					return true;
				}
			});
			if (!matchesAuthor) {
				return false;
			}
		}

		if (!query.text) {
			return true;
		}

		const haystack = [commit.hash, commit.shortHash, commit.subject, commit.body].join('\n');
		if (!state.regex) {
			return normalize(haystack).includes(normalize(query.text));
		}

		try {
			const regex = new RegExp(query.text, state.matchCase ? 'g' : 'gi');
			return regex.test(haystack);
		} catch {
			return true;
		}
	}

	function getSearchAssistSuggestions() {
		const match = state.searchDraft.match(/(^|\s)\/([a-z]*)$/i);
		if (!match) {
			return [];
		}

		const partial = match[2].toLowerCase();
		return [
			{ field: 'date', label: 'date:', description: 'Filter by commit date, e.g. date:20.03' },
			{ field: 'path', label: 'path:', description: 'Filter by changed path, e.g. path:dir1/dir2' },
			{ field: 'author', label: 'author:', description: 'Filter by author name or email' }
		].filter((item) => item.field.startsWith(partial));
	}

	function isSearchAssistVisible() {
		return elements.searchAssist.classList.contains('is-visible');
	}

	function renderSearchAssist() {
		const suggestions = getSearchAssistSuggestions();
		if (!suggestions.length) {
			hideSearchAssist();
			return;
		}

		elements.searchAssist.innerHTML = suggestions.map((item, index) => `
			<button class="commit-search-assist-item${index === state.activeSearchAssistIndex ? ' is-active' : ''}" type="button" data-search-assist="${escapeHtml(item.field)}">
				<span>${escapeHtml(item.label)}</span>
				<span class="commit-search-assist-hint">${escapeHtml(item.description)}</span>
			</button>
		`).join('');
		elements.searchAssist.classList.add('is-visible');
		elements.searchAssist.setAttribute('aria-hidden', 'false');
		const searchRect = elements.search.closest('.search-box').getBoundingClientRect();
		elements.searchAssist.style.left = `${searchRect.left}px`;
		elements.searchAssist.style.top = `${searchRect.bottom + 6}px`;
	}

	function hideSearchAssist() {
		elements.searchAssist.classList.remove('is-visible');
		elements.searchAssist.setAttribute('aria-hidden', 'true');
		elements.searchAssist.innerHTML = '';
		state.activeSearchAssistIndex = -1;
	}

	function applySearchAssist(field) {
		state.searchDraft = state.searchDraft.replace(/(^|\s)\/[a-z]*$/i, `$1${field}:`);
		elements.search.value = state.searchDraft;
		hideSearchAssist();
		elements.search.focus();
	}

	function commitMatchesBranch(commit) {
		void commit;
		return true;
	}

	function getVisibleCommits() {
		return state.data.commits.filter((commit) =>
			commitMatchesSearch(commit) &&
			commitMatchesBranch(commit)
		);
	}

	function formatDate(iso) {
		const date = new Date(iso);
		if (Number.isNaN(date.getTime())) {
			return {
				date: iso,
				time: ''
			};
		}

		return {
			date: date.toLocaleDateString(),
			time: date.toLocaleTimeString()
		};
	}

	function getCommitBodyPreview(commit) {
		if (!commit.body) {
			return '';
		}

		const lines = commit.body
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line.length > 0);

		if (!lines.length) {
			return '';
		}

		const normalizedSubject = commit.subject.trim();
		const [firstLine, ...rest] = lines;
		if (firstLine === normalizedSubject) {
			return rest[0] || '';
		}

		return firstLine;
	}

	function renderCommits() {
		const commits = getVisibleCommits();
		if (!commits.length) {
			elements.list.innerHTML = '<div class="commit-empty">No commits match the current filters.</div>';
			elements.cherryPick.disabled = true;
			return;
		}

		if (!state.selectedHash || !commits.some((commit) => commit.hash === state.selectedHash)) {
			state.selectedHash = commits[0].hash;
		}

		elements.list.innerHTML = commits.map((commit) => {
			const selectedClass = commit.hash === state.selectedHash ? ' is-selected' : '';
			const refs = commit.refs.length > 0
				? `<span class="commit-refs-inline">${commit.refs.map((ref) => `<span class="commit-ref">${escapeHtml(ref)}</span>`).join('')}</span>`
				: '';
			const bodyPreview = getCommitBodyPreview(commit);
			const body = bodyPreview ? `<div class="commit-body">${escapeHtml(bodyPreview)}</div>` : '';
			const formattedDate = formatDate(commit.dateIso);
			const dateMarkup = formattedDate.time
				? `<span class="commit-date-value">${escapeHtml(formattedDate.date)}</span><span class="commit-time-value">${escapeHtml(formattedDate.time)}</span>`
				: `<span class="commit-date-value">${escapeHtml(formattedDate.date)}</span>`;
			return `
				<button
					class="commit-row${selectedClass}"
					type="button"
					data-commit-hash="${escapeHtml(commit.hash)}"
				>
					<div class="commit-hash">${escapeHtml(commit.shortHash)}</div>
					<div class="commit-main">
						<div class="commit-subject-row">
							<div class="commit-subject">${escapeHtml(commit.subject)}</div>
							${refs}
						</div>
						${body}
					</div>
					<div class="commit-meta">
						<div class="commit-author">${escapeHtml(commit.authorName)}</div>
						<div class="commit-date">${dateMarkup}</div>
					</div>
				</button>
			`;
		}).join('');

		elements.cherryPick.disabled = !state.selectedHash;
		scrollSelectedIntoView();
		notifySelectedCommit();
	}

	function applySearch() {
		state.searchApplied = state.searchDraft;
		if (state.searchApplied) {
			state.searchHistory = [state.searchApplied, ...state.searchHistory.filter((item) => item !== state.searchApplied)].slice(0, 10);
		}
		saveState();
		renderCommits();
	}

	function selectCommit(hash) {
		state.selectedHash = hash;
		renderCommits();
	}

	function scrollSelectedIntoView() {
		if (!state.selectedHash) {
			return;
		}

		const selected = elements.list.querySelector(`[data-commit-hash="${cssEscape(state.selectedHash)}"]`);
		selected?.scrollIntoView({ block: 'nearest' });
	}

	function getSelectedCommit() {
		return state.data.commits.find((commit) => commit.hash === state.selectedHash) || null;
	}

	function focusView() {
		const commits = getVisibleCommits();
		if (commits.length > 0) {
			if (!state.selectedHash || !commits.some((commit) => commit.hash === state.selectedHash)) {
				state.selectedHash = commits[0].hash;
				renderCommits();
			}
			elements.list.focus();
			scrollSelectedIntoView();
			return;
		}

		elements.search.focus();
		elements.search.select();
	}

	function focusChanges() {
		const commit = getSelectedCommit();
		if (!commit) {
			return;
		}

		vscode.postMessage({ type: 'focusChanges' });
	}

	function notifySelectedCommit() {
		if (state.lastNotifiedCommitHash === state.selectedHash) {
			return;
		}

		state.lastNotifiedCommitHash = state.selectedHash;
		vscode.postMessage({
			type: 'commitSelected',
			hash: state.selectedHash
		});
	}

	function getMenuItems(commit) {
		if (!commit) {
			return [];
		}

		return [
			{ label: 'Copy Revision Number', action: 'copyRevision', mnemonic: 'c' },
			{ label: 'Create Patch', action: 'createPatch', mnemonic: 'a' },
			{ type: 'separator' },
			{ label: 'Checkout Revision', action: 'checkoutRevision', mnemonic: 'h' },
			{ label: 'Show Repository at Revision', action: 'showRepositoryAtRevision', mnemonic: 'w' },
			{ label: 'Compare with Local', action: 'compareWithLocal', mnemonic: 'l' },
			{ type: 'separator' },
			{ label: 'Cherry-Pick', action: 'cherryPick', mnemonic: 'p', disabled: commit.isInCurrentBranch },
			{ label: 'Reset Current Branch to Here', action: 'resetCurrentBranchToHere', mnemonic: 's', disabled: !commit.isInCurrentBranch },
			{ type: 'separator' },
			{ label: 'Revert Commit', action: 'revertCommit', mnemonic: 'r' },
			{ label: 'Undo Commit', action: 'undoCommit', mnemonic: 'u', disabled: !(commit.isHeadCommit && commit.authoredByCurrentUser) },
			{ label: 'Edit Commit Message', action: 'editCommitMessage', mnemonic: 'e', disabled: true },
			{ label: 'Fixup', action: 'fixup', mnemonic: 'f', disabled: true },
			{ label: 'Squash Into', action: 'squashInto', mnemonic: 'q', disabled: true },
			{ label: 'Interactively Rebase from Here', action: 'interactiveRebaseFromHere', mnemonic: 'i', disabled: !commit.isInCurrentBranch },
			{ type: 'separator' },
			{ label: 'New Branch', action: 'newBranch', mnemonic: 'b' },
			{ label: 'New Tag', action: 'newTag', mnemonic: 't' },
			{ label: 'Go to Parent Commit', action: 'goToParentCommit', mnemonic: 'g', disabled: commit.parents.length === 0 },
			{ label: 'Go to Child Commit', action: 'goToChildCommit', mnemonic: 'o', disabled: true }
		];
	}

	function renderMenuLabel(label, mnemonic) {
		if (!mnemonic) {
			return escapeHtml(label);
		}

		const index = label.toLowerCase().indexOf(mnemonic.toLowerCase());
		if (index < 0) {
			return escapeHtml(label);
		}

		return `${escapeHtml(label.slice(0, index))}<span class="context-menu-mnemonic">${escapeHtml(label.slice(index, index + 1))}</span>${escapeHtml(label.slice(index + 1))}`;
	}

	function showContextMenu(commit, x, y) {
		const items = getMenuItems(commit);
		elements.menu.innerHTML = items.map((item) => {
			if (item.type === 'separator') {
				return '<div class="commit-context-menu-separator"></div>';
			}

			return `
				<button class="commit-context-menu-item${item.disabled ? ' is-disabled' : ''}" type="button" data-menu-action="${item.action}" data-menu-mnemonic="${item.mnemonic || ''}" ${item.disabled ? 'disabled' : ''}>
					<span>${renderMenuLabel(item.label, item.mnemonic)}</span>
					<span class="commit-context-menu-hint"></span>
				</button>
			`;
		}).join('');

		elements.menu.classList.add('is-visible');
		elements.menu.setAttribute('aria-hidden', 'false');
		const rect = elements.menu.getBoundingClientRect();
		const margin = 8;
		elements.menu.style.left = `${Math.min(x, window.innerWidth - rect.width - margin)}px`;
		elements.menu.style.top = `${Math.min(y, window.innerHeight - rect.height - margin)}px`;
		state.activeMenuIndex = 0;
		updateMenuActiveItem();
		elements.menu.tabIndex = -1;
		elements.menu.focus();
	}

	function hideContextMenu() {
		elements.menu.classList.remove('is-visible');
		elements.menu.setAttribute('aria-hidden', 'true');
		elements.menu.innerHTML = '';
		state.activeMenuIndex = -1;
	}

	function isContextMenuVisible() {
		return elements.menu.classList.contains('is-visible');
	}

	function getMenuActionItems() {
		return Array.from(elements.menu.querySelectorAll('[data-menu-action]:not(:disabled)'));
	}

	function updateMenuActiveItem() {
		const items = getMenuActionItems();
		items.forEach((item, index) => {
			item.classList.toggle('is-active', index === state.activeMenuIndex);
			if (index === state.activeMenuIndex) {
				item.scrollIntoView({ block: 'nearest' });
			}
		});
	}

	function triggerCommitAction(action) {
		const commit = getSelectedCommit();
		if (!commit) {
			return;
		}

		vscode.postMessage({
			type: 'commitAction',
			action,
			hash: commit.hash
		});
		hideContextMenu();
		elements.list.focus();
	}

	function handleMenuKey(event) {
		if (!isContextMenuVisible()) {
			return false;
		}

		const items = getMenuActionItems();
		if (!items.length) {
			return false;
		}

		if (event.key === 'ArrowDown') {
			state.activeMenuIndex = (state.activeMenuIndex + 1) % items.length;
			updateMenuActiveItem();
			return true;
		}

		if (event.key === 'ArrowUp') {
			state.activeMenuIndex = (state.activeMenuIndex - 1 + items.length) % items.length;
			updateMenuActiveItem();
			return true;
		}

		if (event.key === 'Enter') {
			items[state.activeMenuIndex]?.click();
			return true;
		}

		const mnemonicTarget = items.find((item) => item.getAttribute('data-menu-mnemonic') === event.key.toLowerCase());
		if (mnemonicTarget) {
			mnemonicTarget.click();
			return true;
		}

		return false;
	}

	function moveSelection(delta) {
		const commits = getVisibleCommits();
		if (!commits.length) {
			return;
		}

		const currentIndex = Math.max(0, commits.findIndex((commit) => commit.hash === state.selectedHash));
		const nextIndex = (currentIndex + delta + commits.length) % commits.length;
		state.selectedHash = commits[nextIndex].hash;
		renderCommits();
	}

	function bindEvents() {
		elements.search.addEventListener('input', (event) => {
			state.searchDraft = event.target.value;
			elements.searchClear.disabled = state.searchDraft.length === 0;
			renderSearchAssist();
		});

		elements.search.addEventListener('blur', () => {
			window.setTimeout(() => {
				if (!isSearchAssistVisible()) {
					applySearch();
				}
			}, 0);
		});
		elements.search.addEventListener('keydown', (event) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
				event.preventDefault();
				event.target.select();
				return;
			}

			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				event.target.select();
				return;
			}

			if (isSearchAssistVisible()) {
				const suggestions = Array.from(elements.searchAssist.querySelectorAll('[data-search-assist]'));
				if (event.key === 'ArrowDown' && suggestions.length > 0) {
					event.preventDefault();
					state.activeSearchAssistIndex = (state.activeSearchAssistIndex + 1) % suggestions.length;
					renderSearchAssist();
					return;
				}

				if (event.key === 'ArrowUp' && suggestions.length > 0) {
					event.preventDefault();
					state.activeSearchAssistIndex = (state.activeSearchAssistIndex - 1 + suggestions.length) % suggestions.length;
					renderSearchAssist();
					return;
				}

				if (event.key === 'Enter' && suggestions.length > 0) {
					event.preventDefault();
					const index = state.activeSearchAssistIndex >= 0 ? state.activeSearchAssistIndex : 0;
					applySearchAssist(suggestions[index].getAttribute('data-search-assist') || '');
					return;
				}

				if (event.key === 'Escape') {
					event.preventDefault();
					hideSearchAssist();
					return;
				}
			}

			if (handleToolbarNavigation(event, elements.search)) {
				return;
			}

			if (event.key === 'Enter') {
				event.preventDefault();
				applySearch();
			}
		});

		elements.searchClear.addEventListener('click', () => {
			state.searchDraft = '';
			state.searchApplied = '';
			saveState();
			renderToolbar();
			renderCommits();
			hideSearchAssist();
			elements.search.focus();
		});

		elements.regex.addEventListener('click', () => {
			state.regex = !state.regex;
			saveState();
			renderToolbar();
			renderCommits();
		});

		elements.matchCase.addEventListener('click', () => {
			state.matchCase = !state.matchCase;
			saveState();
			renderToolbar();
			renderCommits();
		});

		elements.branch.addEventListener('click', (event) => {
			const clearButton = event.target.closest('[data-filter-clear]');
			if (clearButton) {
				event.preventDefault();
				event.stopPropagation();
				applyFilterValue('branch', 'all');
				elements.branch.focus();
				return;
			}

			if (state.activeFilterKey === 'branch' && isFilterMenuVisible()) {
				hideFilterMenu();
				return;
			}

			showFilterMenu('branch', elements.branch);
		});

		elements.branch.addEventListener('keydown', (event) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				showFilterMenu('branch', elements.branch);
				return;
			}

			handleToolbarNavigation(event, elements.branch);
		});

		for (const control of [elements.searchClear, elements.regex, elements.matchCase, elements.cherryPick]) {
			control.addEventListener('keydown', (event) => {
				handleToolbarNavigation(event, control);
			});
		}

		elements.cherryPick.addEventListener('click', () => {
			triggerCommitAction('cherryPick');
		});

		elements.list.addEventListener('click', (event) => {
			const row = event.target.closest('[data-commit-hash]');
			if (!row) {
				hideContextMenu();
				return;
			}

			selectCommit(row.getAttribute('data-commit-hash'));
			elements.list.focus();
			hideContextMenu();
		});

		elements.list.addEventListener('contextmenu', (event) => {
			const row = event.target.closest('[data-commit-hash]');
			if (!row) {
				return;
			}

			event.preventDefault();
			selectCommit(row.getAttribute('data-commit-hash'));
			const commit = getSelectedCommit();
			if (!commit) {
				return;
			}

			showContextMenu(commit, event.clientX, event.clientY);
		});

		elements.list.addEventListener('keydown', (event) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'l') {
				event.preventDefault();
				elements.search.focus();
				elements.search.select();
				return;
			}

			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				elements.search.focus();
				elements.search.select();
				return;
			}

			if ((event.ctrlKey || event.metaKey) && event.key === 'F5') {
				event.preventDefault();
				vscode.postMessage({ type: 'refresh' });
				return;
			}

			if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu' || ((event.ctrlKey || event.metaKey) && event.key === '.')) {
				event.preventDefault();
				const selected = elements.list.querySelector(`[data-commit-hash="${cssEscape(state.selectedHash || '')}"]`);
				const commit = getSelectedCommit();
				if (selected && commit) {
					const rect = selected.getBoundingClientRect();
					showContextMenu(commit, rect.left + 24, rect.top + 20);
				}
				return;
			}

			if (handleMenuKey(event)) {
				event.preventDefault();
				return;
			}

			if (event.key === 'Escape' && isContextMenuVisible()) {
				event.preventDefault();
				hideContextMenu();
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				elements.search.focus();
				elements.search.select();
				return;
			}

			if (event.key === 'Enter') {
				event.preventDefault();
				focusChanges();
				return;
			}

			if (event.key === 'ArrowDown') {
				event.preventDefault();
				moveSelection(1);
				return;
			}

			if (event.key === 'ArrowUp') {
				event.preventDefault();
				moveSelection(-1);
				return;
			}
		});

		document.addEventListener('click', (event) => {
			if (!elements.searchAssist.contains(event.target) && event.target !== elements.search) {
				hideSearchAssist();
			}
			if (!elements.filterMenu.contains(event.target) && !event.target.closest('.filter-trigger')) {
				hideFilterMenu();
			}
			if (!elements.menu.contains(event.target)) {
				hideContextMenu();
			}
		});

		window.addEventListener('blur', () => {
			hideSearchAssist();
			hideFilterMenu();
			hideContextMenu();
			sendFocusState(false);
		});
		window.addEventListener('focus', () => {
			sendFocusState(true);
		});
		document.addEventListener('focusin', () => {
			sendFocusState(true);
		});
		window.addEventListener('resize', () => {
			hideSearchAssist();
			hideFilterMenu();
			hideContextMenu();
		});
		document.addEventListener('scroll', (event) => {
			if (!elements.searchAssist.contains(event.target)) {
				hideSearchAssist();
			}
			if (!elements.filterMenu.contains(event.target)) {
				hideFilterMenu();
			}
			if (!elements.menu.contains(event.target)) {
				hideContextMenu();
			}
		}, true);

		elements.filterMenu.addEventListener('click', (event) => {
			const button = event.target.closest('[data-filter-value]');
			if (!button || !state.activeFilterKey) {
				return;
			}

			applyFilterValue(state.activeFilterKey, button.getAttribute('data-filter-value') || 'all');
		});

		elements.filterMenu.addEventListener('keydown', (event) => {
			if (event.target?.id === 'commit-filter-menu-search') {
				if (handleFilterMenuSearchKey(event)) {
					event.preventDefault();
					event.stopPropagation();
					return;
				}
			}

			if (handleFilterMenuKey(event)) {
				event.preventDefault();
				event.stopPropagation();
			}
		});

		elements.filterMenu.addEventListener('input', (event) => {
			if (event.target?.id !== 'commit-filter-menu-search') {
				return;
			}

			state.filterMenuQuery = event.target.value;
			applyFilterMenuQuery();
			positionFilterMenu(elements[state.activeFilterKey]);
		});

		elements.menu.addEventListener('click', (event) => {
			const button = event.target.closest('[data-menu-action]');
			if (!button) {
				return;
			}

			triggerCommitAction(button.getAttribute('data-menu-action'));
		});

		elements.menu.addEventListener('keydown', (event) => {
			if (handleMenuKey(event)) {
				event.preventDefault();
				return;
			}

			if (event.key === 'Escape') {
				event.preventDefault();
				hideContextMenu();
				elements.list.focus();
			}
		});

		elements.searchAssist.addEventListener('click', (event) => {
			const button = event.target.closest('[data-search-assist]');
			if (!button) {
				return;
			}

			applySearchAssist(button.getAttribute('data-search-assist') || '');
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
				if (state.data.loadedBranch && state.branch !== state.data.loadedBranch) {
					state.branch = state.data.loadedBranch;
					saveState();
				}
				renderToolbar();
				renderCommits();
			}
		});

		document.addEventListener('keydown', (event) => {
			if (elements.filterMenu.contains(event.target)) {
				return;
			}

			if (handleFilterMenuKey(event)) {
				event.preventDefault();
				return;
			}

			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
				event.preventDefault();
				elements.search.focus();
				elements.search.select();
				return;
			}

			if ((event.ctrlKey || event.metaKey) && event.key === 'F5') {
				event.preventDefault();
				vscode.postMessage({ type: 'refresh' });
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
	renderToolbar();
	renderCommits();
	vscode.postMessage({ type: 'ready' });
}());
