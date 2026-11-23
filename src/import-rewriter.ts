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

interface ProjectConfiguration {
  configFilePath: string;
  options: ts.CompilerOptions;
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

  const version = document.version;
  const replacements = await findImportReplacements(document);

  if (
    document.isClosed ||
    document.version !== version ||
    replacements.length === 0
  ) {
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
  }

  return {
    changedFiles,
    changedImports,
  };
}

async function findImportReplacements(
  document: vscode.TextDocument,
): Promise<ImportReplacement[]> {
  const version = document.version;
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
  const barrelFiles = new Map<string, Thenable<vscode.Uri[]>>();

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

    const names = getImportedNames(statement.importClause);
    if (names.length === 0 || isIndexFile(targetFileUri)) {
      continue;
    }

    const workspaceKey = workspaceFolder.uri.toString();
    let indexes = barrelFiles.get(workspaceKey);
    if (!indexes) {
      indexes = vscode.workspace.findFiles(
        new vscode.RelativePattern(workspaceFolder.uri, "**/index.ts"),
        EXCLUDED_GLOB,
      );
      barrelFiles.set(workspaceKey, indexes);
    }
    const candidates: { indexUri: vscode.Uri; specifier: string }[] = [];
    for (const indexUri of await indexes) {
      const folder = parentUri(indexUri);
      if (isInsideOrEqual(folder, document.uri)) {
        continue;
      }

      const specifier = createBarrelModuleSpecifier(
        document.uri,
        originalSpecifier,
        targetFileUri,
        folder,
      );
      if (!specifier || specifier === originalSpecifier) {
        continue;
      }

      const resolved = await resolveImportedFile(
        document.uri,
        specifier,
        projectConfiguration,
      );
      if (
        resolved &&
        sameUri(resolved, indexUri) &&
        (await barrelDirectlyForwards(indexUri, targetFileUri, names))
      ) {
        candidates.push({ indexUri, specifier });
      }
    }

    if (candidates.length !== 1) {
      continue;
    }

    const [{ indexUri, specifier: newSpecifier }] = candidates;
    if (
      !exportsSameSymbols(
        targetFileUri,
        indexUri,
        names,
        projectConfiguration?.options,
      )
    ) {
      continue;
    }

    if (document.isClosed || document.version !== version) {
      return [];
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

function isIndexFile(uri: vscode.Uri): boolean {
  return /\/index\.(?:tsx?|mts|cts)$/i.test(uri.path);
}

function openContents(uri: vscode.Uri): string | undefined {
  return vscode.workspace.textDocuments
    .find((document) => sameUri(document.uri, uri))
    ?.getText();
}

async function barrelDirectlyForwards(
  indexUri: vscode.Uri,
  targetUri: vscode.Uri,
  names: readonly string[],
): Promise<boolean> {
  const remaining = new Set(names);
  const openText = openContents(indexUri);
  let text: string;
  try {
    text =
      openText ??
      new TextDecoder().decode(await vscode.workspace.fs.readFile(indexUri));
  } catch {
    return false;
  }

  const source = ts.createSourceFile(
    indexUri.fsPath,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const config = findProjectConfiguration(indexUri.fsPath);
  for (const statement of source.statements) {
    if (
      !ts.isExportDeclaration(statement) ||
      statement.isTypeOnly ||
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      continue;
    }

    const resolved = await resolveImportedFile(
      indexUri,
      statement.moduleSpecifier.text,
      config,
    );
    if (!resolved || !sameUri(resolved, targetUri)) {
      continue;
    }

    if (!statement.exportClause) {
      for (const name of remaining) {
        if (name !== "default") {
          remaining.delete(name);
        }
      }
    } else if (ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (
          !element.isTypeOnly &&
          (!element.propertyName ||
            element.propertyName.text === element.name.text)
        ) {
          remaining.delete(element.name.text);
        }
      }
    }
  }

  return remaining.size === 0;
}

function exportsSameSymbols(
  targetUri: vscode.Uri,
  indexUri: vscode.Uri,
  names: readonly string[],
  options: ts.CompilerOptions = {},
): boolean {
  const compilerOptions = {
    ...options,
    noResolve: false,
    noLib: true,
    types: [],
  };
  const host = ts.createCompilerHost(compilerOptions);
  const readFile = host.readFile.bind(host);
  host.readFile = (fileName) =>
    openContents(vscode.Uri.file(fileName)) ?? readFile(fileName);

  const program = ts.createProgram(
    [targetUri.fsPath, indexUri.fsPath],
    compilerOptions,
    host,
  );
  const target = program.getSourceFile(targetUri.fsPath);
  const barrel = program.getSourceFile(indexUri.fsPath);
  if (
    !target ||
    !barrel ||
    program
      .getSemanticDiagnostics(barrel)
      .some((diagnostic) => diagnostic.code === 2308)
  ) {
    return false;
  }

  const checker = program.getTypeChecker();
  const exportsOf = (source: ts.SourceFile) => {
    const module = checker.getSymbolAtLocation(source);
    return new Map(
      module &&
        checker
          .getExportsOfModule(module)
          .map((symbol) => [symbol.getName(), symbol] as const),
    );
  };
  const targetExports = exportsOf(target);
  const barrelExports = exportsOf(barrel);
  const originalSymbol = (symbol: ts.Symbol) =>
    symbol.flags & ts.SymbolFlags.Alias
      ? checker.getAliasedSymbol(symbol)
      : symbol;

  return names.every((name) => {
    const original = targetExports.get(name);
    const forwarded = barrelExports.get(name);
    if (
      !original ||
      !forwarded ||
      forwarded.declarations?.some(ts.isTypeOnlyImportOrExportDeclaration)
    ) {
      return false;
    }
    const symbol = originalSymbol(original);
    return Boolean(
      symbol.declarations?.length && symbol === originalSymbol(forwarded),
    );
  });
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
    const result = ts.resolveModuleName(
      moduleSpecifier,
      importerUri.fsPath,
      configuration.options,
      ts.sys,
    ).resolvedModule;
    if (!result || isNodeModulesPath(result.resolvedFileName)) {
      return undefined;
    }
    const resolvedUri = vscode.Uri.file(result.resolvedFileName);
    return (await isFile(resolvedUri)) ? resolvedUri : undefined;
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
  let directory = path.dirname(sourceFilePath);
  const root = vscode.workspace.getWorkspaceFolder(
    vscode.Uri.file(sourceFilePath),
  )?.uri.fsPath;
  while (true) {
    for (const name of CONFIG_FILE_NAMES) {
      const configPath = path.join(directory, name);
      if (ts.sys.fileExists(configPath)) {
        const configuration = parseProjectConfiguration(configPath);
        if (configuration) {
          return configuration;
        }
      }
    }
    const parent = path.dirname(directory);
    if (
      parent === directory ||
      (root && normalizeFsPath(root) === normalizeFsPath(directory))
    ) {
      return undefined;
    }
    directory = parent;
  }
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

function getImportedNames(importClause: ts.ImportClause): string[] {
  if (
    importClause.namedBindings &&
    ts.isNamespaceImport(importClause.namedBindings)
  ) {
    return [];
  }

  const names: string[] = [];

  if (importClause.name) {
    names.push("default");
  }

  if (
    importClause.namedBindings &&
    ts.isNamedImports(importClause.namedBindings)
  ) {
    for (const element of importClause.namedBindings.elements) {
      names.push(element.propertyName?.text ?? element.name.text);
    }
  }

  return [...new Set(names)];
}

/**
 * Preview shape for import updates.
 */
export interface ImportRewritePreview {
  fileUri: vscode.Uri;
  line: number;
  originalSpecifier: string;
  newSpecifier: string;
}

/**
 * Preview import rewrites in one TypeScript document.
 */
export async function previewImportRewritesInDocument(
  document: vscode.TextDocument,
): Promise<ImportRewritePreview[]> {
  if (!isSupportedDocument(document)) {
    return [];
  }

  const version = document.version;
  const replacements = await findImportReplacements(document);
  if (document.isClosed || document.version !== version) {
    return [];
  }

  return replacements.map((replacement) => ({
    fileUri: document.uri,
    line: replacement.range.start.line + 1,
    originalSpecifier: document.getText(replacement.range),
    newSpecifier: replacement.newModuleSpecifier,
  }));
}
