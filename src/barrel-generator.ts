import * as vscode from "vscode";
import { TextDecoder, TextEncoder } from "node:util";

const INDEX_FILE_NAME = "index.ts";

const EXCLUDED_FOLDERS = new Set([
  "node_modules",
  "dist",
  "out",
  "build",
  "coverage",
  ".git",
  ".angular",
]);

export async function barrelExists(folderUri: vscode.Uri): Promise<boolean> {
  const indexUri = vscode.Uri.joinPath(folderUri, INDEX_FILE_NAME);

  try {
    const stat = await vscode.workspace.fs.stat(indexUri);

    return stat.type === vscode.FileType.File;
  } catch {
    return false;
  }
}

export async function isDirectory(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);

    return stat.type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

export async function regenerateBarrel(
  barrelFolderUri: vscode.Uri,
  createIfMissing = false,
): Promise<boolean> {
  const exists = await barrelExists(barrelFolderUri);

  if (!exists && !createIfMissing) {
    return false;
  }

  const exportPaths = await collectExportPaths(barrelFolderUri);

  const uniqueExportPaths = [...new Set(exportPaths)].sort((left, right) =>
    left.localeCompare(right),
  );

  const exportLines = uniqueExportPaths.map(
    (exportPath) => `export * from './${exportPath}';`,
  );

  const contents =
    exportLines.join("\n") + (exportLines.length > 0 ? "\n" : "");

  const indexUri = vscode.Uri.joinPath(barrelFolderUri, INDEX_FILE_NAME);

  const openDocument = vscode.workspace.textDocuments.find(
    (document) => document.uri.toString() === indexUri.toString(),
  );

  if (openDocument) {
    const currentContents = openDocument.getText();

    if (currentContents === contents) {
      return true;
    }

    const range = new vscode.Range(
      openDocument.positionAt(0),
      openDocument.positionAt(currentContents.length),
    );

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

  try {
    const currentBytes = await vscode.workspace.fs.readFile(indexUri);

    const currentContents = new TextDecoder().decode(currentBytes);

    if (currentContents === contents) {
      return true;
    }
  } catch {
    // index.ts may not exist yet.
  }

  await vscode.workspace.fs.writeFile(
    indexUri,
    new TextEncoder().encode(contents),
  );

  return true;
}

/**
 * Regenerates existing index.ts files only.
 * It does not create missing barrel files.
 */
export async function regenerateAllBarrels(
  rootUri: vscode.Uri,
): Promise<number> {
  const indexFiles = await vscode.workspace.findFiles(
    new vscode.RelativePattern(rootUri, "**/index.ts"),
    "**/{node_modules,dist,out,build,coverage,.git,.angular}/**",
  );

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
export async function createMissingBarrels(
  rootUri: vscode.Uri,
  configuredFolderNames: readonly string[],
): Promise<number> {
  const normalizedNames = new Set(
    configuredFolderNames
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );

  if (normalizedNames.size === 0) {
    return 0;
  }

  const matchingFolders: vscode.Uri[] = [];

  await findMatchingFoldersRecursively(
    rootUri,
    normalizedNames,
    matchingFolders,
  );

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

export async function regenerateAffectedBarrels(
  changedUris: readonly vscode.Uri[],
): Promise<number> {
  const candidateFolders = findAffectedBarrelFolders(changedUris);

  let count = 0;

  for (const folderUri of candidateFolders) {
    if (await regenerateBarrel(folderUri, false)) {
      count++;
    }
  }

  return count;
}

export async function hasNearbyBarrel(fileUri: vscode.Uri): Promise<boolean> {
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

export function isRelevantTypeScriptUri(uri: vscode.Uri): boolean {
  const fileName = getFileName(uri);

  return fileName !== undefined && shouldConsiderFile(fileName);
}

export function isIndexUri(uri: vscode.Uri): boolean {
  return getFileName(uri)?.toLowerCase() === INDEX_FILE_NAME;
}

export function getFolderName(uri: vscode.Uri): string {
  return getFileName(uri) ?? "";
}

export function parentUri(uri: vscode.Uri): vscode.Uri {
  const slashIndex = uri.path.lastIndexOf("/");

  if (slashIndex <= 0) {
    return uri;
  }

  return uri.with({
    path: uri.path.slice(0, slashIndex),
  });
}

async function findMatchingFoldersRecursively(
  currentFolderUri: vscode.Uri,
  configuredNames: ReadonlySet<string>,
  results: vscode.Uri[],
): Promise<void> {
  let entries: [string, vscode.FileType][];

  try {
    entries = await vscode.workspace.fs.readDirectory(currentFolderUri);
  } catch {
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

    await findMatchingFoldersRecursively(
      childFolderUri,
      configuredNames,
      results,
    );
  }
}

function findAffectedBarrelFolders(
  changedUris: readonly vscode.Uri[],
): vscode.Uri[] {
  const folders = new Map<string, vscode.Uri>();

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

async function collectExportPaths(
  barrelFolderUri: vscode.Uri,
): Promise<string[]> {
  let entries: [string, vscode.FileType][];

  try {
    entries = await vscode.workspace.fs.readDirectory(barrelFolderUri);
  } catch {
    return [];
  }

  const exportPaths: string[] = [];

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

    const childExports = await collectDirectChildExports(childFolderUri, name);

    exportPaths.push(...childExports);
  }

  return exportPaths;
}

async function collectDirectChildExports(
  childFolderUri: vscode.Uri,
  childFolderName: string,
): Promise<string[]> {
  let entries: [string, vscode.FileType][];

  try {
    entries = await vscode.workspace.fs.readDirectory(childFolderUri);
  } catch {
    return [];
  }

  const exportPaths: string[] = [];

  for (const [fileName, type] of entries) {
    if (type !== vscode.FileType.File) {
      continue;
    }

    const exportPath = await getExportPath(
      childFolderUri,
      fileName,
      childFolderName,
    );

    if (exportPath) {
      exportPaths.push(exportPath);
    }
  }

  return exportPaths;
}

async function getExportPath(
  containingFolderUri: vscode.Uri,
  fileName: string,
  relativeFolderName?: string,
): Promise<string | undefined> {
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

async function fileHasExports(fileUri: vscode.Uri): Promise<boolean> {
  try {
    const bytes = await vscode.workspace.fs.readFile(fileUri);

    const source = new TextDecoder().decode(bytes);

    return hasExportStatement(source);
  } catch {
    return false;
  }
}

function hasExportStatement(source: string): boolean {
  return (
    /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:class|interface|type|enum|const|let|var|function|namespace|module)\b/.test(
      source,
    ) ||
    /\bexport\s*\{/.test(source) ||
    /\bexport\s*\*/.test(source) ||
    /\bexport\s+default\b/.test(source)
  );
}

function shouldConsiderFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();

  return (
    lowerName.endsWith(".ts") &&
    lowerName !== INDEX_FILE_NAME &&
    !lowerName.endsWith(".spec.ts") &&
    !lowerName.endsWith(".test.ts") &&
    !lowerName.endsWith(".d.ts")
  );
}

function shouldIgnoreFolder(folderName: string): boolean {
  return EXCLUDED_FOLDERS.has(folderName) || folderName.startsWith(".");
}

function removeTsExtension(fileName: string): string {
  return fileName.slice(0, -".ts".length);
}

function getFileName(uri: vscode.Uri): string | undefined {
  return uri.path.split("/").pop();
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}
