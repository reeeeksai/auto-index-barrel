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
exports.barrelExists = barrelExists;
exports.isDirectory = isDirectory;
exports.regenerateBarrel = regenerateBarrel;
exports.regenerateAllBarrels = regenerateAllBarrels;
exports.createMissingBarrels = createMissingBarrels;
exports.regenerateAffectedBarrels = regenerateAffectedBarrels;
exports.hasNearbyBarrel = hasNearbyBarrel;
exports.isRelevantTypeScriptUri = isRelevantTypeScriptUri;
exports.isIndexUri = isIndexUri;
exports.getFolderName = getFolderName;
exports.parentUri = parentUri;
exports.mergeBarrelContents = mergeBarrelContents;
const vscode = __importStar(require("vscode"));
const node_util_1 = require("node:util");
const ts = __importStar(require("typescript"));
const INDEX_FILE_NAME = "index.ts";
const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
const EXCLUDED_FOLDERS = new Set([
    "node_modules",
    "dist",
    "out",
    "build",
    "coverage",
    ".git",
    ".angular",
]);
async function barrelExists(folderUri) {
    const indexUri = vscode.Uri.joinPath(folderUri, INDEX_FILE_NAME);
    try {
        const stat = await vscode.workspace.fs.stat(indexUri);
        return stat.type === vscode.FileType.File;
    }
    catch {
        return false;
    }
}
async function isDirectory(uri) {
    try {
        const stat = await vscode.workspace.fs.stat(uri);
        return stat.type === vscode.FileType.Directory;
    }
    catch {
        return false;
    }
}
async function regenerateBarrel(barrelFolderUri, createIfMissing = false) {
    const exists = await barrelExists(barrelFolderUri);
    if (!exists && !createIfMissing) {
        return false;
    }
    const exportPaths = await collectExportPaths(barrelFolderUri);
    const uniqueExportPaths = [...new Set(exportPaths)].sort((left, right) => left.localeCompare(right));
    const exportLines = uniqueExportPaths.map((exportPath) => `export * from './${exportPath}';`);
    let existingContents;
    try {
        const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() ===
            vscode.Uri.joinPath(barrelFolderUri, INDEX_FILE_NAME).toString());
        if (openDocument) {
            existingContents = openDocument.getText();
        }
        else {
            const indexUri = vscode.Uri.joinPath(barrelFolderUri, INDEX_FILE_NAME);
            const currentBytes = await vscode.workspace.fs.readFile(indexUri);
            existingContents = new node_util_1.TextDecoder().decode(currentBytes);
        }
    }
    catch {
        // index.ts may not exist yet.
    }
    const contents = mergeBarrelContents(existingContents, exportLines);
    const indexUri = vscode.Uri.joinPath(barrelFolderUri, INDEX_FILE_NAME);
    const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === indexUri.toString());
    if (openDocument) {
        const currentContents = openDocument.getText();
        if (currentContents === contents) {
            return true;
        }
        const range = new vscode.Range(openDocument.positionAt(0), openDocument.positionAt(currentContents.length));
        const edit = new vscode.WorkspaceEdit();
        edit.replace(indexUri, range, contents);
        const applied = await vscode.workspace.applyEdit(edit);
        if (!applied) {
            throw new Error(`Could not update ${indexUri.fsPath}`);
        }
        const saved = await openDocument.save();
        if (!saved) {
            throw new Error(`Could not save ${indexUri.fsPath}`);
        }
        return true;
    }
    await vscode.workspace.fs.writeFile(indexUri, new node_util_1.TextEncoder().encode(contents));
    return true;
}
/**
 * Regenerates existing index.ts files only.
 * It does not create missing barrel files.
 */
async function regenerateAllBarrels(rootUri) {
    const indexFiles = await vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, "**/index.ts"), "**/{node_modules,dist,out,build,coverage,.git,.angular}/**");
    let count = 0;
    for (const indexFileUri of indexFiles) {
        const barrelFolderUri = parentUri(indexFileUri);
        if (await regenerateBarrel(barrelFolderUri, false)) {
            count++;
        }
    }
    return count;
}
/**
 * Finds existing folders whose names match the configured names
 * and creates index.ts when one is missing.
 */
async function createMissingBarrels(rootUri, configuredFolderNames) {
    const normalizedNames = new Set(configuredFolderNames
        .map((name) => name.trim().toLowerCase())
        .filter(Boolean));
    if (normalizedNames.size === 0) {
        return 0;
    }
    const matchingFolders = [];
    await findMatchingFoldersRecursively(rootUri, normalizedNames, matchingFolders);
    let createdCount = 0;
    for (const folderUri of matchingFolders) {
        if (await barrelExists(folderUri)) {
            continue;
        }
        if (await regenerateBarrel(folderUri, true)) {
            createdCount++;
        }
    }
    return createdCount;
}
async function regenerateAffectedBarrels(changedUris) {
    const candidateFolders = findAffectedBarrelFolders(changedUris);
    let count = 0;
    for (const folderUri of candidateFolders) {
        if (await regenerateBarrel(folderUri, false)) {
            count++;
        }
    }
    return count;
}
async function hasNearbyBarrel(fileUri) {
    const containingFolder = parentUri(fileUri);
    if (await barrelExists(containingFolder)) {
        return true;
    }
    const parentFolder = parentUri(containingFolder);
    if (sameUri(parentFolder, containingFolder)) {
        return false;
    }
    return barrelExists(parentFolder);
}
function isRelevantTypeScriptUri(uri) {
    const fileName = getFileName(uri);
    return fileName !== undefined && shouldConsiderFile(fileName);
}
function isIndexUri(uri) {
    return getFileName(uri)?.toLowerCase() === INDEX_FILE_NAME;
}
function getFolderName(uri) {
    return getFileName(uri) ?? "";
}
function parentUri(uri) {
    const slashIndex = uri.path.lastIndexOf("/");
    if (slashIndex <= 0) {
        return uri;
    }
    return uri.with({
        path: uri.path.slice(0, slashIndex),
    });
}
async function findMatchingFoldersRecursively(currentFolderUri, configuredNames, results) {
    let entries;
    try {
        entries = await vscode.workspace.fs.readDirectory(currentFolderUri);
    }
    catch {
        return;
    }
    for (const [name, type] of entries) {
        if (type !== vscode.FileType.Directory || shouldIgnoreFolder(name)) {
            continue;
        }
        const childFolderUri = vscode.Uri.joinPath(currentFolderUri, name);
        if (configuredNames.has(name.toLowerCase())) {
            results.push(childFolderUri);
        }
        await findMatchingFoldersRecursively(childFolderUri, configuredNames, results);
    }
}
function findAffectedBarrelFolders(changedUris) {
    const folders = new Map();
    for (const changedUri of changedUris) {
        const containingFolder = parentUri(changedUri);
        const parentFolder = parentUri(containingFolder);
        folders.set(containingFolder.toString(), containingFolder);
        if (!sameUri(parentFolder, containingFolder)) {
            folders.set(parentFolder.toString(), parentFolder);
        }
    }
    return [...folders.values()];
}
async function collectExportPaths(barrelFolderUri) {
    let entries;
    try {
        entries = await vscode.workspace.fs.readDirectory(barrelFolderUri);
    }
    catch {
        return [];
    }
    const exportPaths = [];
    for (const [name, type] of entries) {
        if (type === vscode.FileType.File) {
            const exportPath = await getExportPath(barrelFolderUri, name);
            if (exportPath) {
                exportPaths.push(exportPath);
            }
            continue;
        }
        if (type !== vscode.FileType.Directory || shouldIgnoreFolder(name)) {
            continue;
        }
        const childFolderUri = vscode.Uri.joinPath(barrelFolderUri, name);
        const childExports = await collectRecursiveExportPaths(childFolderUri, name);
        exportPaths.push(...childExports);
    }
    return exportPaths;
}
async function collectRecursiveExportPaths(barrelFolderUri, relativeFolderName) {
    let entries;
    try {
        entries = await vscode.workspace.fs.readDirectory(barrelFolderUri);
    }
    catch {
        return [];
    }
    const exportPaths = [];
    for (const [name, type] of entries) {
        if (type === vscode.FileType.File) {
            const exportPath = await getExportPath(barrelFolderUri, name, relativeFolderName);
            if (exportPath) {
                exportPaths.push(exportPath);
            }
            continue;
        }
        if (type !== vscode.FileType.Directory || shouldIgnoreFolder(name)) {
            continue;
        }
        const childFolderUri = vscode.Uri.joinPath(barrelFolderUri, name);
        const childExports = await collectRecursiveExportPaths(childFolderUri, `${relativeFolderName}/${name}`);
        exportPaths.push(...childExports);
    }
    return exportPaths;
}
async function getExportPath(containingFolderUri, fileName, relativeFolderName) {
    if (!shouldConsiderFile(fileName)) {
        return undefined;
    }
    const fileUri = vscode.Uri.joinPath(containingFolderUri, fileName);
    if (!(await fileHasExports(fileUri))) {
        return undefined;
    }
    const pathWithoutExtension = removeTsExtension(fileName);
    return relativeFolderName
        ? `${relativeFolderName}/${pathWithoutExtension}`
        : pathWithoutExtension;
}
async function fileHasExports(fileUri) {
    try {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const source = new node_util_1.TextDecoder().decode(bytes);
        return hasExportStatement(source);
    }
    catch {
        return false;
    }
}
function hasExportStatement(source) {
    const sourceFile = ts.createSourceFile("candidate.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    return sourceFile.statements.some((statement) => {
        if (ts.isExportDeclaration(statement)) {
            return true;
        }
        return ((ts.isVariableStatement(statement) ||
            ts.isFunctionDeclaration(statement) ||
            ts.isClassDeclaration(statement) ||
            ts.isInterfaceDeclaration(statement) ||
            ts.isTypeAliasDeclaration(statement) ||
            ts.isEnumDeclaration(statement) ||
            ts.isModuleDeclaration(statement)) &&
            statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true);
    });
}
function shouldConsiderFile(fileName) {
    const lowerName = fileName.toLowerCase();
    return (TYPESCRIPT_EXTENSIONS.some((extension) => lowerName.endsWith(extension)) &&
        !/^index\.(?:tsx?|mts|cts)$/i.test(lowerName) &&
        !lowerName.endsWith(".spec.ts") &&
        !lowerName.endsWith(".test.ts") &&
        !lowerName.endsWith(".d.ts"));
}
function shouldIgnoreFolder(folderName) {
    return EXCLUDED_FOLDERS.has(folderName) || folderName.startsWith(".");
}
function removeTsExtension(fileName) {
    return fileName.replace(/\.(?:tsx?|mts|cts)$/i, "");
}
function getFileName(uri) {
    return uri.path.split("/").pop();
}
function sameUri(left, right) {
    return left.toString() === right.toString();
}
function mergeBarrelContents(existingContents, generatedExportLines) {
    if (!existingContents) {
        const uniqueGeneratedLines = [...new Set(generatedExportLines)].sort((left, right) => left.localeCompare(right));
        return withTrailingNewline(uniqueGeneratedLines.join("\n"));
    }
    const existingText = existingContents.replace(/\r?\n$/, "");
    const existingLines = new Set(existingText
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean));
    const missingGeneratedLines = [...new Set(generatedExportLines)]
        .filter((line) => !existingLines.has(line.trim()))
        .sort((left, right) => left.localeCompare(right));
    if (missingGeneratedLines.length === 0) {
        return withTrailingNewline(existingText);
    }
    return withTrailingNewline([existingText, ...missingGeneratedLines].filter(Boolean).join("\n"));
}
function withTrailingNewline(value) {
    return value.length > 0 ? `${value}\n` : "";
}
//# sourceMappingURL=barrel-generator.js.map