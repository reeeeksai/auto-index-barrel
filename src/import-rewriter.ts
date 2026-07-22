import * as path from "node:path";
import { TextDecoder } from "node:util";

import * as ts from "typescript";
import * as vscode from "vscode";

const INDEX_FILE_NAME = "index.ts";

const EXCLUDED_GLOB =
  "**/{node_modules,dist,out,build,coverage,.git,.angular}/**";

const TYPESCRIPT_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];

const CONFIG_FILE_NAMES = [
  "tsconfig.app.json",
  "tsconfig.json",
  "jsconfig.json",
];

interface ImportReplacement {
  range: vscode.Range;
  newModuleSpecifier: string;
}

interface BarrelCandidate {
  folderUri: vscode.Uri;
  indexUri: vscode.Uri;
}

interface ProjectConfiguration {
  configFilePath: string;
  options: ts.CompilerOptions;
}

const projectConfigurationCache = new Map<
  string,
  ProjectConfiguration | undefined
>();

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
 * Updates imports in every supported TypeScript file
 * below rootUri.
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
  projectConfigurationCache.clear();

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

  const projectConfiguration = findProjectConfiguration(document.uri.fsPath);

  const replacements: ImportReplacement[] = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) {
      continue;
    }

    /*
     * Ignore side-effect imports:
     *
     * import './register';
     */
    if (!statement.importClause) {
      continue;
    }

    if (!ts.isStringLiteralLike(statement.moduleSpecifier)) {
      continue;
    }

    const originalSpecifier = statement.moduleSpecifier.text;

    const targetFileUri = await resolveImportedFile(
      document.uri,
      originalSpecifier,
      projectConfiguration,
    );

    if (!targetFileUri) {
      continue;
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(targetFileUri);

    /*
     * Do not rewrite imports that resolve outside the
     * current workspace, such as npm packages.
     */
    if (!workspaceFolder) {
      continue;
    }

    const barrel = await findExportingBarrel(
      document.uri,
      targetFileUri,
      projectConfiguration,
    );

    if (!barrel) {
      continue;
    }

    const newSpecifier = createBarrelModuleSpecifier(
      document.uri,
      originalSpecifier,
      targetFileUri,
      barrel.folderUri,
    );

    if (!newSpecifier) {
      continue;
    }

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
  projectConfiguration: ProjectConfiguration | undefined,
): Promise<BarrelCandidate | undefined> {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(importedFileUri);

  if (!workspaceFolder) {
    return undefined;
  }

  let candidateFolder = parentUri(importedFileUri);

  while (isInsideOrEqual(workspaceFolder.uri, candidateFolder)) {
    const indexUri = vscode.Uri.joinPath(candidateFolder, INDEX_FILE_NAME);

    if (await isFile(indexUri)) {
      /*
       * A file inside components/, services/, etc.
       * should not import through its own barrel.
       */
      if (!isInsideOrEqual(candidateFolder, importerUri)) {
        const exportsTarget = await barrelExportsFile(
          indexUri,
          importedFileUri,
          projectConfiguration,
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
  projectConfiguration: ProjectConfiguration | undefined,
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

    const resolvedExport = await resolveImportedFile(
      indexUri,
      exportedSpecifier,
      projectConfiguration,
    );

    if (resolvedExport && sameFile(resolvedExport, targetFileUri)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolves:
 *
 * ../components/button/button.component
 * src/app/components/button/button.component
 * @app/components/button/button.component
 */
async function resolveImportedFile(
  importerUri: vscode.Uri,
  moduleSpecifier: string,
  projectConfiguration?: ProjectConfiguration | undefined,
): Promise<vscode.Uri | undefined> {
  if (importerUri.scheme !== "file") {
    return undefined;
  }

  const configuration =
    projectConfiguration ?? findProjectConfiguration(importerUri.fsPath);

  /*
   * Let TypeScript perform the real module resolution.
   * This handles baseUrl, paths, extends and configured
   * module resolution behavior.
   */
  if (configuration) {
    const resolution = ts.resolveModuleName(
      moduleSpecifier,
      importerUri.fsPath,
      configuration.options,
      ts.sys,
    );

    const resolvedFileName = resolution.resolvedModule?.resolvedFileName;

    if (resolvedFileName && !isNodeModulesPath(resolvedFileName)) {
      const normalizedPath = normalizeResolvedFileName(resolvedFileName);

      const resolvedUri = vscode.Uri.file(normalizedPath);

      if (await isFile(resolvedUri)) {
        return resolvedUri;
      }
    }
  }

  /*
   * Relative-path fallback.
   */
  if (isRelativeModuleSpecifier(moduleSpecifier)) {
    return resolveFileFromBaseFolder(parentUri(importerUri), moduleSpecifier);
  }

  /*
   * Angular-style fallback:
   *
   * import { X } from 'src/app/...';
   *
   * Some projects use this even when TypeScript configuration
   * does not resolve it correctly for the extension.
   */
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(importerUri);

  if (workspaceFolder) {
    /*
     * Supports:
     *
     * src/app/services/goal.service
     * → <workspace>/src/app/services/goal.service
     */
    if (moduleSpecifier === "src" || moduleSpecifier.startsWith("src/")) {
      return resolveFileFromBaseFolder(workspaceFolder.uri, moduleSpecifier);
    }

    /*
     * Supports:
     *
     * app/services/goal.service
     * → <workspace>/src/app/services/goal.service
     */
    if (moduleSpecifier === "app" || moduleSpecifier.startsWith("app/")) {
      return resolveFileFromBaseFolder(
        vscode.Uri.joinPath(workspaceFolder.uri, "src"),
        moduleSpecifier,
      );
    }
  }
}

async function resolveFileFromBaseFolder(
  baseFolderUri: vscode.Uri,
  moduleSpecifier: string,
): Promise<vscode.Uri | undefined> {
  const normalizedSpecifier = moduleSpecifier.replace(/\\/g, "/");

  const unresolvedUri = vscode.Uri.joinPath(
    baseFolderUri,
    ...normalizedSpecifier.split("/"),
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

/**
 * Creates the new barrel specifier while preserving
 * the style of the existing import.
 *
 * Examples:
 *
 * ../components/button/button.component
 * → ../components
 *
 * @app/components/button/button.component
 * → @app/components
 *
 * src/app/components/button/button.component
 * → src/app/components
 */
function createBarrelModuleSpecifier(
  importerUri: vscode.Uri,
  originalSpecifier: string,
  targetFileUri: vscode.Uri,
  barrelFolderUri: vscode.Uri,
): string | undefined {
  if (isRelativeModuleSpecifier(originalSpecifier)) {
    return createRelativeModuleSpecifier(importerUri, barrelFolderUri);
  }

  return createNonRelativeBarrelSpecifier(
    originalSpecifier,
    targetFileUri,
    barrelFolderUri,
  );
}

function createNonRelativeBarrelSpecifier(
  originalSpecifier: string,
  targetFileUri: vscode.Uri,
  barrelFolderUri: vscode.Uri,
): string | undefined {
  const normalizedOriginal = normalizeModuleSpecifier(originalSpecifier);

  const targetWithoutExtension = removeTypeScriptExtension(targetFileUri);

  let targetRelativeToBarrel = path.relative(
    barrelFolderUri.fsPath,
    targetWithoutExtension.fsPath,
  );

  targetRelativeToBarrel = targetRelativeToBarrel.replace(/\\/g, "/");

  if (!targetRelativeToBarrel || targetRelativeToBarrel.startsWith("..")) {
    return undefined;
  }

  const normalizedTargetSuffix = normalizeModuleSpecifier(
    targetRelativeToBarrel,
  );

  /*
   * Original:
   * @app/components/button/button.component
   *
   * Target suffix:
   * button/button.component
   *
   * Result:
   * @app/components
   */
  if (normalizedOriginal === normalizedTargetSuffix) {
    return ".";
  }

  const expectedSuffix = `/${normalizedTargetSuffix}`;

  if (!normalizedOriginal.endsWith(expectedSuffix)) {
    return undefined;
  }

  const result = normalizedOriginal.slice(0, -expectedSuffix.length);

  return result || ".";
}

function findProjectConfiguration(
  sourceFilePath: string,
): ProjectConfiguration | undefined {
  const sourceDirectory = path.dirname(sourceFilePath);

  const cacheKey = normalizeFsPath(sourceDirectory);

  if (projectConfigurationCache.has(cacheKey)) {
    return projectConfigurationCache.get(cacheKey);
  }

  for (const configFileName of CONFIG_FILE_NAMES) {
    const configFilePath = ts.findConfigFile(
      sourceDirectory,
      ts.sys.fileExists,
      configFileName,
    );

    if (!configFilePath) {
      continue;
    }

    const configuration = parseProjectConfiguration(configFilePath);

    if (configuration) {
      projectConfigurationCache.set(cacheKey, configuration);

      return configuration;
    }
  }

  projectConfigurationCache.set(cacheKey, undefined);

  return undefined;
}

function parseProjectConfiguration(
  configFilePath: string,
): ProjectConfiguration | undefined {
  const readResult = ts.readConfigFile(configFilePath, ts.sys.readFile);

  if (readResult.error) {
    return undefined;
  }

  const parsedConfiguration = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    path.dirname(configFilePath),
    undefined,
    configFilePath,
  );

  return {
    configFilePath,
    options: parsedConfiguration.options,
  };
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

function normalizeResolvedFileName(fileName: string): string {
  return fileName.replace(/\.(?:d\.)?ts$/i, (matched) =>
    matched.toLowerCase() === ".d.ts" ? matched : matched,
  );
}

function normalizeFsPath(value: string): string {
  const normalized = path.normalize(value);

  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isNodeModulesPath(fileName: string): boolean {
  const normalized = fileName.replace(/\\/g, "/");

  return normalized.includes("/node_modules/");
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
  return sameUri(
    removeTypeScriptExtension(left),
    removeTypeScriptExtension(right),
  );
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
