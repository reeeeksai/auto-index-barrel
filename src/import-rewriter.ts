import * as path from "node:path";
import { TextDecoder } from "node:util";

import * as ts from "typescript";
import * as vscode from "vscode";

const INDEX_FILE_NAME = "index.ts";

const EXCLUDED_GLOB =
  "**/{node_modules,dist,out,build,coverage,.git,.angular}/**";

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

interface ImportReplacement {
  range: vscode.Range;
  newModuleSpecifier: string;
}

interface BarrelCandidate {
  folderUri: vscode.Uri;
  indexUri: vscode.Uri;
}

/**
 * Updates imports inside one TypeScript document.
 *
 * Returns the number of changed import paths.
 */
export async function updateImportsInDocument(
  document: vscode.TextDocument,
): Promise<number> {
  if (!isSupportedDocument(document)) {
    return 0;
  }

  const replacements = await findImportReplacements(document);

  if (replacements.length === 0) {
    return 0;
  }

  const workspaceEdit = new vscode.WorkspaceEdit();

  for (const replacement of replacements) {
    workspaceEdit.replace(
      document.uri,
      replacement.range,
      replacement.newModuleSpecifier,
    );
  }

  const applied = await vscode.workspace.applyEdit(workspaceEdit);

  if (!applied) {
    throw new Error(`Could not update imports in ${document.uri.fsPath}`);
  }

  return replacements.length;
}

/**
 * Updates imports in every TypeScript file below rootUri.
 *
 * Returns:
 * - number of changed files
 * - number of changed import declarations
 */
export async function updateAllImports(
  rootUri: vscode.Uri,
  progress?: vscode.Progress<{
    message?: string;
    increment?: number;
  }>,
  cancellationToken?: vscode.CancellationToken,
): Promise<{
  changedFiles: number;
  changedImports: number;
}> {
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(rootUri, "**/*.{ts,tsx,mts,cts}"),
    EXCLUDED_GLOB,
  );

  let changedFiles = 0;
  let changedImports = 0;

  for (let index = 0; index < files.length; index++) {
    if (cancellationToken?.isCancellationRequested) {
      break;
    }

    const fileUri = files[index];

    if (isIgnoredTypeScriptFile(fileUri)) {
      continue;
    }

    progress?.report({
      message: vscode.workspace.asRelativePath(fileUri),
      increment: files.length > 0 ? 100 / files.length : undefined,
    });

    const document = await vscode.workspace.openTextDocument(fileUri);

    const changedInFile = await updateImportsInDocument(document);

    if (changedInFile === 0) {
      continue;
    }

    changedFiles++;
    changedImports += changedInFile;

    const saved = await document.save();

    if (!saved) {
      throw new Error(`Could not save ${fileUri.fsPath}`);
    }
  }

  return {
    changedFiles,
    changedImports,
  };
}

async function findImportReplacements(
  document: vscode.TextDocument,
): Promise<ImportReplacement[]> {
  const sourceText = document.getText();

  const sourceFile = ts.createSourceFile(
    document.uri.fsPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(document.uri),
  );

  const replacements: ImportReplacement[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    /*
     * Skip:
     *
     * import './register';
     *
     * Side-effect imports should not be redirected through a barrel.
     */
    if (!statement.importClause) {
      continue;
    }

    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }

    const originalSpecifier = statement.moduleSpecifier.text;

    if (!isRelativeModuleSpecifier(originalSpecifier)) {
      continue;
    }

    const targetFileUri = await resolveImportedFile(
      document.uri,
      originalSpecifier,
    );

    if (!targetFileUri) {
      continue;
    }

    const barrel = await findExportingBarrel(document.uri, targetFileUri);

    if (!barrel) {
      continue;
    }

    const newSpecifier = createRelativeModuleSpecifier(
      document.uri,
      barrel.folderUri,
    );

    if (
      normalizeModuleSpecifier(newSpecifier) ===
      normalizeModuleSpecifier(originalSpecifier)
    ) {
      continue;
    }

    const literalStart = statement.moduleSpecifier.getStart(sourceFile);

    /*
     * Exclude the opening and closing quote.
     */
    const replacementStart = literalStart + 1;
    const replacementEnd = statement.moduleSpecifier.getEnd() - 1;

    replacements.push({
      range: new vscode.Range(
        document.positionAt(replacementStart),
        document.positionAt(replacementEnd),
      ),
      newModuleSpecifier: newSpecifier,
    });
  }

  return replacements;
}

async function findExportingBarrel(
  importerUri: vscode.Uri,
  importedFileUri: vscode.Uri,
): Promise<BarrelCandidate | undefined> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(importedFileUri);

  if (!workspaceFolder) {
    return undefined;
  }

  let candidateFolder = parentUri(importedFileUri);

  while (isInsideOrEqual(workspaceFolder.uri, candidateFolder)) {
    const indexUri = vscode.Uri.joinPath(candidateFolder, INDEX_FILE_NAME);

    if (await fileExists(indexUri)) {
      /*
       * Files inside the same barrel tree should continue using
       * direct sibling imports.
       */
      if (!isInsideOrEqual(candidateFolder, importerUri)) {
        const exportsTarget = await barrelExportsFile(
          indexUri,
          importedFileUri,
        );

        if (exportsTarget) {
          return {
            folderUri: candidateFolder,
            indexUri,
          };
        }
      }
    }

    const nextFolder = parentUri(candidateFolder);

    if (sameUri(nextFolder, candidateFolder)) {
      break;
    }

    candidateFolder = nextFolder;
  }

  return undefined;
}

async function barrelExportsFile(
  indexUri: vscode.Uri,
  targetFileUri: vscode.Uri,
): Promise<boolean> {
  let sourceText: string;

  try {
    const bytes = await vscode.workspace.fs.readFile(indexUri);

    sourceText = new TextDecoder().decode(bytes);
  } catch {
    return false;
  }

  const sourceFile = ts.createSourceFile(
    indexUri.fsPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement)) {
      continue;
    }

    if (
      !statement.moduleSpecifier ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }

    const exportedSpecifier = statement.moduleSpecifier.text;

    if (!isRelativeModuleSpecifier(exportedSpecifier)) {
      continue;
    }

    const resolvedExport = await resolveImportedFile(
      indexUri,
      exportedSpecifier,
    );

    if (resolvedExport && sameFile(resolvedExport, targetFileUri)) {
      return true;
    }
  }

  return false;
}

async function resolveImportedFile(
  importerUri: vscode.Uri,
  moduleSpecifier: string,
): Promise<vscode.Uri | undefined> {
  const importerFolder = parentUri(importerUri);

  const unresolvedUri = vscode.Uri.joinPath(
    importerFolder,
    ...moduleSpecifier.split("/"),
  );

  const directCandidates = [
    unresolvedUri,
    ...TYPESCRIPT_EXTENSIONS.map((extension) =>
      unresolvedUri.with({
        path: unresolvedUri.path + extension,
      }),
    ),
  ];

  for (const candidate of directCandidates) {
    if (await isFile(candidate)) {
      return candidate;
    }
  }

  /*
   * Handles direct imports to a directory:
   *
   * import { Something } from './some-folder';
   */
  for (const extension of TYPESCRIPT_EXTENSIONS) {
    const indexCandidate = vscode.Uri.joinPath(
      unresolvedUri,
      `index${extension}`,
    );

    if (await isFile(indexCandidate)) {
      return indexCandidate;
    }
  }

  return undefined;
}

function createRelativeModuleSpecifier(
  importerUri: vscode.Uri,
  barrelFolderUri: vscode.Uri,
): string {
  const importerFolderPath = parentUri(importerUri).fsPath;

  let relativePath = path.relative(importerFolderPath, barrelFolderUri.fsPath);

  relativePath = relativePath.replace(/\\/g, "/");

  if (relativePath === "") {
    return ".";
  }

  if (!relativePath.startsWith(".")) {
    relativePath = `./${relativePath}`;
  }

  return relativePath;
}

function isSupportedDocument(document: vscode.TextDocument): boolean {
  return (
    document.uri.scheme === "file" &&
    !isIgnoredTypeScriptFile(document.uri) &&
    ["typescript", "typescriptreact"].includes(document.languageId)
  );
}

function isIgnoredTypeScriptFile(uri: vscode.Uri): boolean {
  const lowerName = uri.path.toLowerCase();

  return (
    lowerName.endsWith("/index.ts") ||
    lowerName.endsWith("/index.tsx") ||
    lowerName.endsWith(".spec.ts") ||
    lowerName.endsWith(".test.ts") ||
    lowerName.endsWith(".d.ts")
  );
}

function getScriptKind(uri: vscode.Uri): ts.ScriptKind {
  const lowerPath = uri.path.toLowerCase();

  if (lowerPath.endsWith(".tsx")) {
    return ts.ScriptKind.TSX;
  }

  if (lowerPath.endsWith(".jsx")) {
    return ts.ScriptKind.JSX;
  }

  return ts.ScriptKind.TS;
}

function isRelativeModuleSpecifier(moduleSpecifier: string): boolean {
  return (
    moduleSpecifier === "." ||
    moduleSpecifier === ".." ||
    moduleSpecifier.startsWith("./") ||
    moduleSpecifier.startsWith("../")
  );
}

function normalizeModuleSpecifier(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  return isFile(uri);
}

async function isFile(uri: vscode.Uri): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(uri);

    return (stat.type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
}

function parentUri(uri: vscode.Uri): vscode.Uri {
  const parentPath = path.posix.dirname(uri.path);

  return uri.with({
    path: parentPath,
  });
}

function isInsideOrEqual(parent: vscode.Uri, child: vscode.Uri): boolean {
  if (parent.scheme !== child.scheme || parent.authority !== child.authority) {
    return false;
  }

  const relativePath = path.posix.relative(parent.path, child.path);

  return (
    relativePath === "" ||
    (!relativePath.startsWith("..") && !path.posix.isAbsolute(relativePath))
  );
}

function sameFile(left: vscode.Uri, right: vscode.Uri): boolean {
  const leftWithoutExtension = removeTypeScriptExtension(left);

  const rightWithoutExtension = removeTypeScriptExtension(right);

  return sameUri(leftWithoutExtension, rightWithoutExtension);
}

function removeTypeScriptExtension(uri: vscode.Uri): vscode.Uri {
  return uri.with({
    path: uri.path.replace(/\.(?:tsx?|mts|cts)$/i, ""),
  });
}

function sameUri(left: vscode.Uri, right: vscode.Uri): boolean {
  if (process.platform === "win32") {
    return left.toString().toLowerCase() === right.toString().toLowerCase();
  }

  return left.toString() === right.toString();
}
