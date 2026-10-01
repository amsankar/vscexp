# Workspace Explorer with Git Branches

Browse workspace files in a dedicated Explorer view, with each folder labeled by its current Git branch, for example `api-service [main]`.

## Features

- Browse files and folders from the current VS Code workspace.
- See the current branch beside each workspace root when Git detects a repository.
- Create files and folders, rename items, and move deleted items to the system trash.
- Select multiple items and use copy, cut, paste, or drag and drop within the view.
- Open files, copy paths, and reveal items in VS Code's built-in Explorer.
- Refresh the tree manually or let it update when files and Git state change.

## Get started

1. Install **Workspace Explorer with Git Branches** from the Visual Studio Marketplace.
2. Open a folder or multi-root workspace in VS Code.
3. Open the **Explorer** activity and expand **Workspace Explorer**.
4. Expand a workspace root to browse its files. Branch labels appear when the built-in Git extension detects a repository.

## Notes

This extension adds a separate view inside the Explorer container; it does not replace or modify VS Code's built-in Explorer. Workspace roots without a detected Git repository appear without a branch suffix.

## Development

```sh
npm install
npm run compile
```

Press `F5` to launch the Extension Development Host. Run `npm run watch` to compile automatically while developing.

## License

MIT. See [LICENSE](LICENSE).
