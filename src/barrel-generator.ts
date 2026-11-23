import * as vscode from "vscode";
import { TextDecoder, TextEncoder } from "node:util";
import * as ts from "typescript";

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
  const key = barrelFolderUri.toString();
  const previous = barrelUpdateQueues.get(key) ?? Promise.resolve();

  let release: () => void = () => undefined;
  const turn = new Promise<void>((resolve) => {
    release = resolve;
  });

  const queued = previous.then(() => turn);
  barrelUpdateQueues.set(key, queued);

  await previous;

  try {
    return await regenerateBarrelInternal(barrelFolderUri, createIfMissing);
  } finally {
    release();

    if (barrelUpdateQueues.get(key) === queued) {
      barrelUpdateQueues.delete(key);
    }
  }
}

async function regenerateBarrelInternal(
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

  const indexUri = vscode.Uri.joinPath(barrelFolderUri, INDEX_FILE_NAME);
  const findOpenDocument = () =>
    vscode.workspace.textDocuments.find((document) =>
      sameUri(document.uri, indexUri),
    );

  let openDocument = findOpenDocument();
  let diskContents: Uint8Array | undefined;
  if (!openDocument) {
    try {
      diskContents = await vscode.workspace.fs.readFile(indexUri);
    } catch (error) {
      if (
        !createIfMissing ||
        !(error instanceof vscode.FileSystemError) ||
        error.code !== "FileNotFound"
      ) {
        throw error;
      }
    }
    openDocument = findOpenDocument();
  }

  if (openDocument) {
    const wasDirty = openDocument.isDirty;
    const version = openDocument.version;
    const currentContents = openDocument.getText();
    const contents = mergeBarrelContents(currentContents, exportLines);
    if (contents === currentContents) {
      return true;
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      indexUri,
      new vscode.Range(
        openDocument.positionAt(0),
        openDocument.positionAt(currentContents.length),
      ),
      contents,
    );
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(`Could not update ${indexUri.fsPath}`);
    }

    // Persist generated changes only if they are the sole edit since the snapshot.
    const documentEol =
      openDocument.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    if (
      !wasDirty &&
      !openDocument.isClosed &&
      openDocument.isDirty &&
      openDocument.version === version + 1 &&
      openDocument.getText() === contents.replace(/\r?\n/g, documentEol)
    ) {
      if (!(await openDocument.save())) {
        throw new Error(`Could not save ${indexUri.fsPath}`);
      }
    }
    return true;
  }

  const existingContents =
    diskContents &&
    new TextDecoder("utf-8", {
      ignoreBOM: true,
    }).decode(diskContents);
  const contents = mergeBarrelContents(existingContents, exportLines);
  if (contents === existingContents) {
    return true;
  }

  if (!diskContents) {
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(indexUri, { contents: new TextEncoder().encode(contents) });
    return vscode.workspace.applyEdit(edit);
  }

  const latestContents = await vscode.workspace.fs.readFile(indexUri);
  if (findOpenDocument() || !Buffer.from(latestContents).equals(diskContents)) {
    return false;
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
    const workspaceRoot = vscode.workspace.getWorkspaceFolder(changedUri)?.uri;
    if (!workspaceRoot) {
      continue;
    }

    let folder = parentUri(changedUri);
    while (
      folder.path === workspaceRoot.path ||
      folder.path.startsWith(workspaceRoot.path.replace(/\/$/, "") + "/")
    ) {
      folders.set(folder.toString(), folder);
      const parent = parentUri(folder);
      if (sameUri(folder, workspaceRoot) || sameUri(folder, parent)) {
        break;
      }
      folder = parent;
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
    const childExports = await collectRecursiveExportPaths(
      childFolderUri,
      name,
    );

    exportPaths.push(...childExports);
  }

  return exportPaths;
}

async function collectRecursiveExportPaths(
  barrelFolderUri: vscode.Uri,
  relativeFolderName: string,
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
      const exportPath = await getExportPath(
        barrelFolderUri,
        name,
        relativeFolderName,
      );

      if (exportPath) {
        exportPaths.push(exportPath);
      }

      continue;
    }

    if (type !== vscode.FileType.Directory || shouldIgnoreFolder(name)) {
      continue;
    }

    const childFolderUri = vscode.Uri.joinPath(barrelFolderUri, name);
    const childExports = await collectRecursiveExportPaths(
      childFolderUri,
      `${relativeFolderName}/${name}`,
    );

    exportPaths.push(...childExports);
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
  const sourceFile = ts.createSourceFile(
    "candidate.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  return sourceFile.statements.some((statement) => {
    if (ts.isExportDeclaration(statement)) {
      return true;
    }

    return (
      (ts.isVariableStatement(statement) ||
        ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement) ||
        ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isModuleDeclaration(statement)) &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) === true
    );
  });
}

function shouldConsiderFile(fileName: string): boolean {
  const lowerName = fileName.toLowerCase();

  return (
    TYPESCRIPT_EXTENSIONS.some((extension) => lowerName.endsWith(extension)) &&
    !/^index\.(?:tsx?|mts|cts)$/i.test(lowerName) &&
    !lowerName.endsWith(".spec.ts") &&
    !lowerName.endsWith(".test.ts") &&
    !lowerName.endsWith(".d.ts")
  );
}

function shouldIgnoreFolder(folderName: string): boolean {
  return EXCLUDED_FOLDERS.has(folderName) || folderName.startsWith(".");
}

function removeTsExtension(fileName: string): string {
  return fileName.replace(/\.(?:tsx?|mts|cts)$/i, "");
}

function getFileName(uri: vscode.Uri): string | undefined {
  return uri.path.split("/").pop();
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  return left.toString() === right.toString();
}

export const GENERATED_EXPORTS_MARKER = "// Generated exports";
export const CUSTOM_EXPORTS_MARKER = "// Custom exports";

export function mergeBarrelContents(
  existingContents: string | undefined,
  generatedExportLines: string[],
): string {
  const eol = existingContents?.match(/\r?\n/)?.[0] ?? "\n";
  const bom = existingContents?.startsWith("\uFEFF") ? "\uFEFF" : "";
  const previous = existingContents?.slice(bom.length) ?? "";
  const marker = /^[ \t]*\/\/ Custom exports[ \t]*(?=\r?$)/m.exec(previous);
  const isGenerated = /^[ \t]*\/\/ Generated exports[ \t]*(?=\r?$)/m.test(
    previous,
  );
  const customSection = marker
    ? previous.slice(marker.index)
    : CUSTOM_EXPORTS_MARKER + eol + (isGenerated ? "" : previous);

  const customLines = new Set(
    customSection.split(/\r?\n/).map((line) => line.trim()),
  );
  const uniqueGeneratedLines = [...new Set(generatedExportLines)]
    .filter((line) => !customLines.has(line))
    .sort((left, right) => left.localeCompare(right));
  const generatedSection = [
    GENERATED_EXPORTS_MARKER,
    ...uniqueGeneratedLines,
  ].join(eol);

  return bom + generatedSection + eol + eol + customSection;
}

const barrelUpdateQueues = new Map<string, Promise<void>>();
