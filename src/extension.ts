import * as vscode from "vscode";

import {
  createMissingBarrels,
  getFolderName,
  hasNearbyBarrel,
  isDirectory,
  isIndexUri,
  isRelevantTypeScriptUri,
  parentUri,
  regenerateAffectedBarrels,
  regenerateAllBarrels,
  regenerateBarrel,
} from "./barrel-generator";

import { updateAllImports, updateImportsInDocument } from "./import-rewriter";

const COMMAND_REGENERATE_ALL = "autoIndexBarrel.regenerateAll";

const COMMAND_CREATE_MISSING = "autoIndexBarrel.createMissingBarrels";

const COMMAND_REGENERATE_ALL_IMPORTS = "autoIndexBarrel.regenerateAllImports";

const CONFIGURATION_SECTION = "autoIndexBarrel";

const FILE_CHANGE_DEBOUNCE_MS = 250;
const STRUCTURE_CHANGE_DELAY_MS = 150;
const MOVE_FINAL_PASS_DELAY_MS = 800;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("Auto Index Barrel");

  const pendingUpdates = new Map<string, NodeJS.Timeout>();

  /*
   * Prevents recursive saves when import rewriting modifies
   * and saves the same document.
   */
  const importRewriteInProgress = new Set<string>();
  const barrelRewriteInProgress = new Set<string>();

  const typescriptWatcher = vscode.workspace.createFileSystemWatcher(
    "**/*.ts",
    false,
    false,
    false,
  );

  /*
   * A TypeScript file or index.ts was created.
   */
  const createDisposable = typescriptWatcher.onDidCreate((uri) => {
    if (isIndexUri(uri)) {
      scheduleDirectBarrelUpdate(
        parentUri(uri),
        STRUCTURE_CHANGE_DELAY_MS,
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
      STRUCTURE_CHANGE_DELAY_MS,
      pendingUpdates,
      output,
      "file-create",
    );
  });

  /*
   * An existing TypeScript file changed.
   *
   * This listener maintains nearby existing barrels.
   * Import rewriting is handled separately by onDidSaveTextDocument.
   */
  const changeDisposable = typescriptWatcher.onDidChange(async (uri) => {
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
      "file-change",
    );
  });

  /*
   * A TypeScript file was deleted.
   */
  const deleteDisposable = typescriptWatcher.onDidDelete((uri) => {
    if (!isRelevantTypeScriptUri(uri)) {
      return;
    }

    scheduleAffectedUpdate(
      [uri],
      STRUCTURE_CHANGE_DELAY_MS,
      pendingUpdates,
      output,
      "file-delete",
    );
  });

  /*
   * Handles folders created through the VS Code Explorer.
   *
   * Only newly created folders whose names appear in
   * autoCreateFolderNames receive a barrel automatically.
   */
  const createFilesDisposable = vscode.workspace.onDidCreateFiles(
    async (event) => {
      for (const uri of event.files) {
        await createBarrelForMatchingFolder(uri, output);
      }
    },
  );

  /*
   * Handles files and folders that were renamed or moved.
   */
  const renameDisposable = vscode.workspace.onDidRenameFiles(async (event) => {
    const changedUris = event.files.flatMap((item) => [
      item.oldUri,
      item.newUri,
    ]);

    /*
     * The first pass updates most moved-file cases quickly.
     */
    scheduleAffectedUpdate(
      changedUris,
      STRUCTURE_CHANGE_DELAY_MS,
      pendingUpdates,
      output,
      "rename-first",
    );

    /*
     * VS Code may update imports after the rename event.
     * The delayed final pass makes sure barrel contents use
     * the final paths.
     */
    scheduleAffectedUpdate(
      changedUris,
      MOVE_FINAL_PASS_DELAY_MS,
      pendingUpdates,
      output,
      "rename-final",
    );

    for (const item of event.files) {
      await createBarrelForMatchingFolder(item.newUri, output);
    }
  });

  const saveBarrelDisposable = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      if (!isIndexUri(document.uri)) {
        return;
      }

      const documentKey = document.uri.toString();

      if (barrelRewriteInProgress.has(documentKey)) {
        return;
      }

      try {
        barrelRewriteInProgress.add(documentKey);

        await regenerateBarrel(parentUri(document.uri), false);

        output.appendLine(`Regenerated saved barrel: ${document.uri.fsPath}`);
      } catch (error) {
        logError(output, `Could not regenerate ${document.uri.fsPath}`, error);
      } finally {
        barrelRewriteInProgress.delete(documentKey);
      }
    },
  );

  /*
   * Optionally rewrite safe direct imports after a file is saved.
   */
  const saveImportsDisposable = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      const documentKey = document.uri.toString();

      if (importRewriteInProgress.has(documentKey)) {
        return;
      }

      const configuration = vscode.workspace.getConfiguration(
        CONFIGURATION_SECTION,
        document.uri,
      );

      const rewriteOnSave = configuration.get<boolean>(
        "rewriteImportsOnSave",
        true,
      );

      if (!rewriteOnSave) {
        return;
      }

      try {
        importRewriteInProgress.add(documentKey);

        const changedImports = await updateImportsInDocument(document);

        if (changedImports === 0) {
          return;
        }

        /*
         * updateImportsInDocument applies a WorkspaceEdit,
         * so the document must be saved again.
         */
        const saved = await document.save();

        if (!saved) {
          throw new Error(`Could not save ${document.uri.fsPath}`);
        }

        output.appendLine(
          `Updated ${changedImports} import${
            changedImports === 1 ? "" : "s"
          } in ${document.uri.fsPath}.`,
        );
      } catch (error) {
        logError(
          output,
          `Could not update imports in ${document.uri.fsPath}`,
          error,
        );
      } finally {
        importRewriteInProgress.delete(documentKey);
      }
    },
  );

  /*
   * Regenerates all existing index.ts files.
   *
   * It does not create missing barrel files.
   */
  const regenerateAllCommand = vscode.commands.registerCommand(
    COMMAND_REGENERATE_ALL,
    async (selectedUri?: vscode.Uri) => {
      const rootUri = await resolveCommandRoot(selectedUri);

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
            title: "Auto Index Barrel: regenerating existing barrels",
          },
          () => regenerateAllBarrels(rootUri),
        );

        vscode.window.showInformationMessage(
          `Auto Index Barrel: regenerated ${count} existing barrel${
            count === 1 ? "" : "s"
          }.`,
        );
      } catch (error) {
        showError(output, "Could not regenerate existing barrels", error);
      }
    },
  );

  /*
   * Creates index.ts in existing folders whose names match
   * autoCreateFolderNames.
   */
  const createMissingCommand = vscode.commands.registerCommand(
    COMMAND_CREATE_MISSING,
    async (selectedUri?: vscode.Uri) => {
      const rootUri = await resolveCommandRoot(selectedUri);

      if (!rootUri) {
        vscode.window.showErrorMessage(
          "Auto Index Barrel: no workspace is open.",
        );
        return;
      }

      const folderNames = getConfiguredFolderNames(rootUri);

      if (folderNames.length === 0) {
        vscode.window.showInformationMessage(
          "Auto Index Barrel: no auto-create folder names are configured.",
        );
        return;
      }

      try {
        const count = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Auto Index Barrel: creating missing barrels",
          },
          () => createMissingBarrels(rootUri, folderNames),
        );

        vscode.window.showInformationMessage(
          `Auto Index Barrel: created ${count} missing barrel${
            count === 1 ? "" : "s"
          }.`,
        );
      } catch (error) {
        showError(output, "Could not create missing barrels", error);
      }
    },
  );

  /*
   * Rewrites safe imports across the selected folder/project.
   */
  const regenerateAllImportsCommand = vscode.commands.registerCommand(
    COMMAND_REGENERATE_ALL_IMPORTS,
    async (selectedUri?: vscode.Uri) => {
      const rootUri = await resolveCommandRoot(selectedUri);

      if (!rootUri) {
        vscode.window.showErrorMessage(
          "Auto Index Barrel: no workspace is open.",
        );
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        "Update all safe TypeScript imports under the selected folder?",
        {
          modal: true,
          detail:
            "Direct imports will be changed to barrel imports when a matching index.ts exports the imported file. Changed files will be saved.",
        },
        "Update Imports",
      );

      if (confirmation !== "Update Imports") {
        return;
      }

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Auto Index Barrel: updating imports",
            cancellable: true,
          },
          (progress, cancellationToken) =>
            updateAllImports(rootUri, progress, cancellationToken),
        );

        vscode.window.showInformationMessage(
          `Auto Index Barrel: updated ${result.changedImports} import${
            result.changedImports === 1 ? "" : "s"
          } across ${result.changedFiles} file${
            result.changedFiles === 1 ? "" : "s"
          }.`,
        );
      } catch (error) {
        showError(output, "Could not regenerate project imports", error);
      }
    },
  );

  context.subscriptions.push(
    output,
    typescriptWatcher,
    createDisposable,
    changeDisposable,
    deleteDisposable,
    createFilesDisposable,
    renameDisposable,
    saveImportsDisposable,
    regenerateAllCommand,
    createMissingCommand,
    regenerateAllImportsCommand,
    saveBarrelDisposable,
    {
      dispose: () => {
        for (const timeout of pendingUpdates.values()) {
          clearTimeout(timeout);
        }

        pendingUpdates.clear();
        importRewriteInProgress.clear();
      },
    },
  );

  output.appendLine("Auto Index Barrel activated.");
}

export function deactivate(): void {
  // Resources are disposed through context.subscriptions.
}

async function createBarrelForMatchingFolder(
  uri: vscode.Uri,
  output: vscode.OutputChannel,
): Promise<void> {
  if (!(await isDirectory(uri))) {
    return;
  }

  const configuredNames = getConfiguredFolderNames(uri);

  if (configuredNames.length === 0) {
    return;
  }

  const configuredNameSet = new Set(
    configuredNames.map((name) => name.toLowerCase()),
  );

  const folderName = getFolderName(uri).toLowerCase();

  if (!configuredNameSet.has(folderName)) {
    return;
  }

  try {
    await regenerateBarrel(uri, true);

    output.appendLine(
      `Automatically created or populated barrel in ${uri.fsPath}.`,
    );
  } catch (error) {
    logError(output, `Could not auto-create barrel in ${uri.fsPath}`, error);
  }
}

function getConfiguredFolderNames(resourceUri?: vscode.Uri): string[] {
  const configuration = vscode.workspace.getConfiguration(
    CONFIGURATION_SECTION,
    resourceUri,
  );

  return configuration
    .get<string[]>("autoCreateFolderNames", [])
    .map((name) => name.trim())
    .filter(Boolean);
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
      const count = await regenerateAffectedBarrels(relevantUris);

      if (count > 0) {
        output.appendLine(
          `Updated ${count} affected barrel${count === 1 ? "" : "s"}.`,
        );
      }
    } catch (error) {
      logError(output, "Could not update affected barrels", error);
    }
  });
}

function scheduleDirectBarrelUpdate(
  folderUri: vscode.Uri,
  delayMs: number,
  pendingUpdates: Map<string, NodeJS.Timeout>,
  output: vscode.OutputChannel,
): void {
  const key = `index-create:${folderUri.toString()}`;

  replacePendingTimeout(key, delayMs, pendingUpdates, async () => {
    try {
      await regenerateBarrel(folderUri, false);

      output.appendLine(`Populated new index.ts in ${folderUri.fsPath}.`);
    } catch (error) {
      logError(
        output,
        `Could not populate index.ts in ${folderUri.fsPath}`,
        error,
      );
    }
  });
}

function replacePendingTimeout(
  key: string,
  delayMs: number,
  pendingUpdates: Map<string, NodeJS.Timeout>,
  callback: () => Promise<void>,
): void {
  const existing = pendingUpdates.get(key);

  if (existing) {
    clearTimeout(existing);
  }

  const timeout = setTimeout(async () => {
    pendingUpdates.delete(key);

    try {
      await callback();
    } catch {
      /*
       * Callback-specific errors are already logged
       * by the callback itself.
       */
    }
  }, delayMs);

  pendingUpdates.set(key, timeout);
}

async function resolveCommandRoot(
  selectedUri?: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  const selectedFolder = await resolveSelectedFolder(selectedUri);

  if (selectedFolder) {
    return selectedFolder;
  }

  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

async function resolveSelectedFolder(
  selectedUri?: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  if (!selectedUri) {
    return undefined;
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
