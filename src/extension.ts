import * as vscode from "vscode";

import {
  hasNearbyBarrel,
  isIndexUri,
  isRelevantTypeScriptUri,
  parentUri,
  regenerateAffectedBarrels,
  regenerateAllBarrels,
  regenerateBarrel,
} from "./barrel-generator";

const COMMAND_REGENERATE_FOLDER = "autoIndexBarrel.regenerateFolder";

const COMMAND_REGENERATE_ALL = "autoIndexBarrel.regenerateAll";

const FILE_CHANGE_DEBOUNCE_MS = 250;
const MOVE_FIRST_PASS_DELAY_MS = 150;
const MOVE_FINAL_PASS_DELAY_MS = 800;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Auto Index Barrel");

  const pendingUpdates = new Map<string, NodeJS.Timeout>();

  /*
   * There is intentionally no separate index.ts watcher.
   *
   * Watching and saving generated index.ts files caused the extension
   * to react to its own writes and enter an infinite loop.
   */
  const typescriptWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.ts",
    false,
    false,
    false,
  );

  const createDisposable = typescriptWatcher.onDidCreate((uri) => {
    if (isIndexUri(uri)) {
      const barrelFolder = parentUri(uri);

      scheduleDirectBarrelCreation(
        barrelFolder,
        MOVE_FIRST_PASS_DELAY_MS,
        pendingUpdates,
        output,
      );

      return;
    }

    if (!isRelevantTypeScriptUri(uri)) {
      return;
    }

    scheduleAffectedUpdate(
      [uri],
      MOVE_FIRST_PASS_DELAY_MS,
      pendingUpdates,
      output,
      "create",
    );
  });

  const changeDisposable = typescriptWatcher.onDidChange(async (uri) => {
    /*
     * index.ts is excluded by isRelevantTypeScriptUri(), so the
     * extension does not react to its own generated saves.
     */
    if (!isRelevantTypeScriptUri(uri)) {
      return;
    }

    if (!(await hasNearbyBarrel(uri))) {
      return;
    }

    scheduleAffectedUpdate(
      [uri],
      FILE_CHANGE_DEBOUNCE_MS,
      pendingUpdates,
      output,
      "change",
    );
  });

  const deleteDisposable = typescriptWatcher.onDidDelete((uri) => {
    if (!isRelevantTypeScriptUri(uri)) {
      return;
    }

    scheduleAffectedUpdate(
      [uri],
      MOVE_FIRST_PASS_DELAY_MS,
      pendingUpdates,
      output,
      "delete",
    );
  });

  const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
    const changedUris = event.files.flatMap((file) => [
      file.oldUri,
      file.newUri,
    ]);

    /*
     * First pass updates the barrels shortly after the filesystem move.
     */
    scheduleAffectedUpdate(
      changedUris,
      MOVE_FIRST_PASS_DELAY_MS,
      pendingUpdates,
      output,
      "rename-first",
    );

    /*
     * VS Code may update imports after the rename event, sometimes
     * temporarily changing a barrel to ../something.
     *
     * This second pass runs after VS Code has finished those updates and
     * rebuilds both old and new barrels from their real folder contents.
     */
    scheduleAffectedUpdate(
      changedUris,
      MOVE_FINAL_PASS_DELAY_MS,
      pendingUpdates,
      output,
      "rename-final",
    );
  });

  const regenerateFolderCommand = vscode.commands.registerCommand(
    COMMAND_REGENERATE_FOLDER,
    async (selectedUri?: vscode.Uri) => {
      const folderUri = await resolveSelectedFolder(selectedUri);

      if (!folderUri) {
        vscode.window.showErrorMessage(
          "Auto Index Barrel: no folder was selected.",
        );
        return;
      }

      try {
        await regenerateBarrel(folderUri, true);

        vscode.window.showInformationMessage(
          "Auto Index Barrel: index.ts regenerated.",
        );
      } catch (error) {
        showError(output, "Could not regenerate index.ts", error);
      }
    },
  );

  const regenerateAllCommand = vscode.commands.registerCommand(
    COMMAND_REGENERATE_ALL,
    async (selectedUri?: vscode.Uri) => {
      const selectedFolder = await resolveSelectedFolder(selectedUri);

      const rootUri =
        selectedFolder ?? vscode.workspace.workspaceFolders?.[0]?.uri;

      if (!rootUri) {
        vscode.window.showErrorMessage(
          "Auto Index Barrel: no workspace is open.",
        );
        return;
      }

      try {
        const count = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Regenerating index.ts files",
          },
          () => regenerateAllBarrels(rootUri),
        );

        vscode.window.showInformationMessage(
          `Auto Index Barrel: regenerated ${count} index.ts file${
            count === 1 ? "" : "s"
          }.`,
        );
      } catch (error) {
        showError(output, "Could not regenerate all index.ts files", error);
      }
    },
  );

  context.subscriptions.push(
    output,
    typescriptWatcher,
    createDisposable,
    changeDisposable,
    deleteDisposable,
    renameDisposable,
    regenerateFolderCommand,
    regenerateAllCommand,
    {
      dispose: () => {
        for (const timeout of pendingUpdates.values()) {
          clearTimeout(timeout);
        }

        pendingUpdates.clear();
      },
    },
  );

  output.appendLine("Auto Index Barrel activated.");
}

export function deactivate(): void {
  // Disposables are handled by context.subscriptions.
}

function scheduleAffectedUpdate(
  uris: readonly vscode.Uri[],
  delayMs: number,
  pendingUpdates: Map<string, NodeJS.Timeout>,
  output: vscode.OutputChannel,
  keyPrefix: string,
): void {
  const relevantUris = uris.filter(
    (uri) => isRelevantTypeScriptUri(uri) || isIndexUri(uri),
  );

  if (relevantUris.length === 0) {
    return;
  }

  const key =
    `${keyPrefix}:` +
    relevantUris
      .map((uri) => uri.toString())
      .sort()
      .join("|");

  replacePendingTimeout(key, delayMs, pendingUpdates, async () => {
    try {
      const updatedCount = await regenerateAffectedBarrels(relevantUris);

      if (updatedCount > 0) {
        output.appendLine(
          `Updated ${updatedCount} barrel folder${
            updatedCount === 1 ? "" : "s"
          } (${keyPrefix}).`,
        );
      }
    } catch (error) {
      logError(output, "Could not update affected barrel files", error);
    }
  });
}

function replacePendingTimeout(
  key: string,
  delayMs: number,
  pendingUpdates: Map<string, NodeJS.Timeout>,
  callback: () => Promise<void>,
): void {
  const existingTimeout = pendingUpdates.get(key);

  if (existingTimeout) {
    clearTimeout(existingTimeout);
  }

  const timeout = setTimeout(async () => {
    pendingUpdates.delete(key);

    try {
      await callback();
    } catch {
      /*
       * Individual callbacks already log their errors.
       * This prevents unhandled promise rejections.
       */
    }
  }, delayMs);

  pendingUpdates.set(key, timeout);
}

async function resolveSelectedFolder(
  selectedUri?: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  if (!selectedUri) {
    return vscode.workspace.workspaceFolders?.[0]?.uri;
  }

  try {
    const stat = await vscode.workspace.fs.stat(selectedUri);

    if (stat.type === vscode.FileType.Directory) {
      return selectedUri;
    }

    return parentUri(selectedUri);
  } catch {
    return parentUri(selectedUri);
  }
}

function scheduleDirectBarrelCreation(
  barrelFolderUri: vscode.Uri,
  delayMs: number,
  pendingUpdates: Map<string, NodeJS.Timeout>,
  output: vscode.OutputChannel,
): void {
  const key = `create-index:${barrelFolderUri.toString()}`;

  replacePendingTimeout(key, delayMs, pendingUpdates, async () => {
    try {
      const regenerated = await regenerateBarrel(barrelFolderUri, false);

      if (regenerated) {
        output.appendLine(`Filled new index.ts in ${barrelFolderUri.fsPath}.`);
      }
    } catch (error) {
      logError(
        output,
        `Could not fill new index.ts in ${barrelFolderUri.fsPath}`,
        error,
      );
    }
  });
}

function showError(
  output: vscode.OutputChannel,
  message: string,
  error: unknown,
): void {
  logError(output, message, error);

  vscode.window.showErrorMessage(
    `Auto Index Barrel: ${message}. See the output panel for details.`,
  );
}

function logError(
  output: vscode.OutputChannel,
  message: string,
  error: unknown,
): void {
  const errorMessage =
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  output.appendLine(`${message}: ${errorMessage}`);
}
