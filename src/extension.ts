import * as vscode from "vscode";

import {
  createMissingBarrels,
  getFolderName,
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

const COMMAND_REGENERATE_EVERYTHING = "autoIndexBarrel.regenerateEverything";

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
    "**/*.{ts,tsx,mts,cts}",
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
  const changeDisposable = typescriptWatcher.onDidChange((uri) => {
    if (!isRelevantTypeScriptUri(uri)) {
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
      true,
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
      true,
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

        await updateImportsInDocument(document);
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
            "Direct imports will be changed to barrel imports when a matching index.ts exports the imported file. Files with pending edits still need a manual save.",
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

  const regenerateEverythingCommand = vscode.commands.registerCommand(
    COMMAND_REGENERATE_EVERYTHING,
    async (selectedUri?: vscode.Uri) => {
      const rootUri = await resolveCommandRoot(selectedUri);

      if (!rootUri) {
        vscode.window.showErrorMessage(
          "Auto Index Barrel: no workspace is open.",
        );
        return;
      }

      const confirmation = await vscode.window.showWarningMessage(
        "Regenerate everything under the selected folder?",
        {
          modal: true,
          detail:
            "This creates configured missing barrels, regenerates existing barrels, and updates safe direct imports. Files with pending edits still need a manual save.",
        },
        "Regenerate Everything",
      );

      if (confirmation !== "Regenerate Everything") {
        return;
      }

      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Auto Index Barrel: regenerating everything",
            cancellable: true,
          },
          async (progress, cancellationToken) => {
            const folderNames = getConfiguredFolderNames(rootUri);

            progress.report({
              message: "Creating missing barrels",
              increment: 10,
            });

            const createdCount = await createMissingBarrels(
              rootUri,
              folderNames,
            );

            if (cancellationToken.isCancellationRequested) {
              return;
            }

            progress.report({
              message: "Regenerating existing barrels",
              increment: 25,
            });

            const regeneratedCount = await regenerateAllBarrels(rootUri);

            if (cancellationToken.isCancellationRequested) {
              return;
            }

            progress.report({
              message: "Rewriting safe imports",
              increment: 35,
            });

            const importResult = await updateAllImports(
              rootUri,
              progress,
              cancellationToken,
            );

            vscode.window.showInformationMessage(
              `Auto Index Barrel: created ${createdCount} missing barrel${
                createdCount === 1 ? "" : "s"
              }, regenerated ${regeneratedCount} barrel${
                regeneratedCount === 1 ? "" : "s"
              }, and updated ${importResult.changedImports} import${
                importResult.changedImports === 1 ? "" : "s"
              }.`,
            );
          },
        );
      } catch (error) {
        showError(output, "Could not regenerate everything", error);
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
    regenerateEverythingCommand,
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
  includeFolderMoves = false,
): void {
  const relevantUris = uris.filter(
    (uri) =>
      includeFolderMoves || isRelevantTypeScriptUri(uri) || isIndexUri(uri),
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
          `Regenerated ${count} barrel${count === 1 ? "" : "s"}: ${key}.`,
        );
      }
    } catch (error) {
      showError(output, `Could not update affected barrels: ${key}`, error);
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

  const timeout = setTimeout(() => {
    pendingUpdates.delete(key);

    callback().catch((error) => {
      // Ensure that an unhandled rejection inside the timeout
      // does not crash the extension.
      console.error(`Pending timeout error (${key}):`, error);
    });
  }, delayMs);

  pendingUpdates.set(key, timeout);
}

function logError(
  output: vscode.OutputChannel,
  message: string,
  error: unknown,
): void {
  output.appendLine(`${message} ${formatError(error)}`);
}

function showError(
  output: vscode.OutputChannel,
  message: string,
  error: unknown,
): void {
  vscode.window.showErrorMessage(`${message}: ${formatError(error)}`);

  logError(output, message, error);
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function resolveCommandRoot(
  selectedUri?: vscode.Uri,
): Promise<vscode.Uri | undefined> {
  if (selectedUri) {
    return (await isDirectory(selectedUri))
      ? selectedUri
      : parentUri(selectedUri);
  }

  const workspaceFolders = vscode.workspace.workspaceFolders;

  if (workspaceFolders && workspaceFolders.length > 0) {
    return workspaceFolders[0].uri;
  }

  return undefined;
}

function scheduleDirectBarrelUpdate(
  uri: vscode.Uri,
  delayMs: number,
  pendingUpdates: Map<string, NodeJS.Timeout>,
  output: vscode.OutputChannel,
): void {
  replacePendingTimeout(
    `direct-barrel-update:${uri.toString()}`,
    delayMs,
    pendingUpdates,
    async () => {
      try {
        await regenerateBarrel(uri, false);

        output.appendLine(`Regenerated direct barrel: ${uri.fsPath}`);
      } catch (error) {
        logError(
          output,
          `Could not regenerate direct barrel ${uri.fsPath}`,
          error,
        );
      }
    },
  );
}
