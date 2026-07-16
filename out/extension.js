"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const barrel_generator_1 = require("./barrel-generator");
const COMMAND_REGENERATE_FOLDER = "autoIndexBarrel.regenerateFolder";
const COMMAND_REGENERATE_ALL = "autoIndexBarrel.regenerateAll";
const FILE_CHANGE_DEBOUNCE_MS = 250;
const MOVE_FIRST_PASS_DELAY_MS = 150;
const MOVE_FINAL_PASS_DELAY_MS = 800;
function activate(context) {
    const output = vscode.window.createOutputChannel("Auto Index Barrel");
    const pendingUpdates = new Map();
    /*
     * There is intentionally no separate index.ts watcher.
     *
     * Watching and saving generated index.ts files caused the extension
     * to react to its own writes and enter an infinite loop.
     */
    const typescriptWatcher = vscode.workspace.createFileSystemWatcher("**/*.ts", false, false, false);
    const createDisposable = typescriptWatcher.onDidCreate((uri) => {
        if ((0, barrel_generator_1.isIndexUri)(uri)) {
            const barrelFolder = (0, barrel_generator_1.parentUri)(uri);
            scheduleDirectBarrelCreation(barrelFolder, MOVE_FIRST_PASS_DELAY_MS, pendingUpdates, output);
            return;
        }
        if (!(0, barrel_generator_1.isRelevantTypeScriptUri)(uri)) {
            return;
        }
        scheduleAffectedUpdate([uri], MOVE_FIRST_PASS_DELAY_MS, pendingUpdates, output, "create");
    });
    const changeDisposable = typescriptWatcher.onDidChange(async (uri) => {
        /*
         * index.ts is excluded by isRelevantTypeScriptUri(), so the
         * extension does not react to its own generated saves.
         */
        if (!(0, barrel_generator_1.isRelevantTypeScriptUri)(uri)) {
            return;
        }
        if (!(await (0, barrel_generator_1.hasNearbyBarrel)(uri))) {
            return;
        }
        scheduleAffectedUpdate([uri], FILE_CHANGE_DEBOUNCE_MS, pendingUpdates, output, "change");
    });
    const deleteDisposable = typescriptWatcher.onDidDelete((uri) => {
        if (!(0, barrel_generator_1.isRelevantTypeScriptUri)(uri)) {
            return;
        }
        scheduleAffectedUpdate([uri], MOVE_FIRST_PASS_DELAY_MS, pendingUpdates, output, "delete");
    });
    const renameDisposable = vscode.workspace.onDidRenameFiles((event) => {
        const changedUris = event.files.flatMap((file) => [
            file.oldUri,
            file.newUri,
        ]);
        /*
         * First pass updates the barrels shortly after the filesystem move.
         */
        scheduleAffectedUpdate(changedUris, MOVE_FIRST_PASS_DELAY_MS, pendingUpdates, output, "rename-first");
        /*
         * VS Code may update imports after the rename event, sometimes
         * temporarily changing a barrel to ../something.
         *
         * This second pass runs after VS Code has finished those updates and
         * rebuilds both old and new barrels from their real folder contents.
         */
        scheduleAffectedUpdate(changedUris, MOVE_FINAL_PASS_DELAY_MS, pendingUpdates, output, "rename-final");
    });
    const regenerateFolderCommand = vscode.commands.registerCommand(COMMAND_REGENERATE_FOLDER, async (selectedUri) => {
        const folderUri = await resolveSelectedFolder(selectedUri);
        if (!folderUri) {
            vscode.window.showErrorMessage("Auto Index Barrel: no folder was selected.");
            return;
        }
        try {
            await (0, barrel_generator_1.regenerateBarrel)(folderUri, true);
            vscode.window.showInformationMessage("Auto Index Barrel: index.ts regenerated.");
        }
        catch (error) {
            showError(output, "Could not regenerate index.ts", error);
        }
    });
    const regenerateAllCommand = vscode.commands.registerCommand(COMMAND_REGENERATE_ALL, async (selectedUri) => {
        const selectedFolder = await resolveSelectedFolder(selectedUri);
        const rootUri = selectedFolder ?? vscode.workspace.workspaceFolders?.[0]?.uri;
        if (!rootUri) {
            vscode.window.showErrorMessage("Auto Index Barrel: no workspace is open.");
            return;
        }
        try {
            const count = await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Regenerating index.ts files",
            }, () => (0, barrel_generator_1.regenerateAllBarrels)(rootUri));
            vscode.window.showInformationMessage(`Auto Index Barrel: regenerated ${count} index.ts file${count === 1 ? "" : "s"}.`);
        }
        catch (error) {
            showError(output, "Could not regenerate all index.ts files", error);
        }
    });
    context.subscriptions.push(output, typescriptWatcher, createDisposable, changeDisposable, deleteDisposable, renameDisposable, regenerateFolderCommand, regenerateAllCommand, {
        dispose: () => {
            for (const timeout of pendingUpdates.values()) {
                clearTimeout(timeout);
            }
            pendingUpdates.clear();
        },
    });
    output.appendLine("Auto Index Barrel activated.");
}
function deactivate() {
    // Disposables are handled by context.subscriptions.
}
function scheduleAffectedUpdate(uris, delayMs, pendingUpdates, output, keyPrefix) {
    const relevantUris = uris.filter((uri) => (0, barrel_generator_1.isRelevantTypeScriptUri)(uri) || (0, barrel_generator_1.isIndexUri)(uri));
    if (relevantUris.length === 0) {
        return;
    }
    const key = `${keyPrefix}:` +
        relevantUris
            .map((uri) => uri.toString())
            .sort()
            .join("|");
    replacePendingTimeout(key, delayMs, pendingUpdates, async () => {
        try {
            const updatedCount = await (0, barrel_generator_1.regenerateAffectedBarrels)(relevantUris);
            if (updatedCount > 0) {
                output.appendLine(`Updated ${updatedCount} barrel folder${updatedCount === 1 ? "" : "s"} (${keyPrefix}).`);
            }
        }
        catch (error) {
            logError(output, "Could not update affected barrel files", error);
        }
    });
}
function replacePendingTimeout(key, delayMs, pendingUpdates, callback) {
    const existingTimeout = pendingUpdates.get(key);
    if (existingTimeout) {
        clearTimeout(existingTimeout);
    }
    const timeout = setTimeout(async () => {
        pendingUpdates.delete(key);
        try {
            await callback();
        }
        catch {
            /*
             * Individual callbacks already log their errors.
             * This prevents unhandled promise rejections.
             */
        }
    }, delayMs);
    pendingUpdates.set(key, timeout);
}
async function resolveSelectedFolder(selectedUri) {
    if (!selectedUri) {
        return vscode.workspace.workspaceFolders?.[0]?.uri;
    }
    try {
        const stat = await vscode.workspace.fs.stat(selectedUri);
        if (stat.type === vscode.FileType.Directory) {
            return selectedUri;
        }
        return (0, barrel_generator_1.parentUri)(selectedUri);
    }
    catch {
        return (0, barrel_generator_1.parentUri)(selectedUri);
    }
}
function scheduleDirectBarrelCreation(barrelFolderUri, delayMs, pendingUpdates, output) {
    const key = `create-index:${barrelFolderUri.toString()}`;
    replacePendingTimeout(key, delayMs, pendingUpdates, async () => {
        try {
            const regenerated = await (0, barrel_generator_1.regenerateBarrel)(barrelFolderUri, false);
            if (regenerated) {
                output.appendLine(`Filled new index.ts in ${barrelFolderUri.fsPath}.`);
            }
        }
        catch (error) {
            logError(output, `Could not fill new index.ts in ${barrelFolderUri.fsPath}`, error);
        }
    });
}
function showError(output, message, error) {
    logError(output, message, error);
    vscode.window.showErrorMessage(`Auto Index Barrel: ${message}. See the output panel for details.`);
}
function logError(output, message, error) {
    const errorMessage = error instanceof Error ? (error.stack ?? error.message) : String(error);
    output.appendLine(`${message}: ${errorMessage}`);
}
//# sourceMappingURL=extension.js.map