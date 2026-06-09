# JBGit

JBGit is a Git panel for VS Code, Cursor, Windsurf, and other VS Code-compatible IDEs. It is inspired by the Git tool windows in JetBrains IDEs and focuses on fast branch, commit, and change navigation inside one bottom panel.

## Features

- `Branches` view with local and remote branch trees, upstream state, task links, and context actions.
- Branch actions for checkout, push, update, force update, rename, delete, compare, merge, and rebase workflows.
- `Commits` view with branch-scoped log browsing, smart search filters, and commit actions.
- `Changes` view for the selected commit, with tree/list modes and native VS Code diff opening.
- Keyboard-friendly focus switching between JBGit views.
- Automatic refresh when Git metadata changes.

## Installation

Download the latest `.vsix` from [GitHub Releases](https://github.com/salexer/jbgit/releases), then install it in your IDE:

- VS Code: run `Extensions: Install from VSIX...` from the Command Palette.
- Cursor and other compatible IDEs: use the same VSIX install command if available.
- CLI: run `code --install-extension path/to/vs-jb-git.vsix`.

## Settings

The extension contributes these settings:

- `jbGit.updateMethod`: choose whether branch update uses `rebase` or `merge`.
- `jbGit.branchTaskUrl`: enable task links for branch names like `ROD-123`.
- `jbGit.branchTaskUrlTemplate`: URL template for task links, for example `https://jira.example.com/browse/{BRANCH}`.

## Development

```sh
npm ci
npm run compile
npm run lint
```

Build a local VSIX package:

```sh
npm run package:vsix -- --out dist/vs-jb-git.vsix
```

## Release Automation

Every push to `main` runs the GitHub Actions workflow in `.github/workflows/release-vsix.yml`.

The workflow:

- installs dependencies with `npm ci`;
- compiles and lints the extension;
- packages a `.vsix` file;
- publishes the package to the rolling GitHub Release tagged `main-latest`.

The `main-latest` release is replaced on every successful `main` build, so the Releases page always contains a fresh installable VSIX from the current main branch.

## Known Limitations

- The UI is implemented with custom webviews, so some interactions intentionally mimic VS Code instead of using native tree controls.
- Native diff behavior can vary slightly between VS Code-compatible IDEs.

## Release Notes

### 0.2.1

- Completed branch context actions for push, compare, merge, and rebase workflows.
- Added automated VSIX release packaging for the `main` branch.
- Updated project metadata and installation documentation.

### 0.2.0

- Added the JBGit panel with `Branches`, `Commits`, and `Changes`.
- Added branch task links, branch actions, smart commit search, and native diff integration.
