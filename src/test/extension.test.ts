import * as assert from "assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as ts from "typescript";
import * as vscode from "vscode";
import { mergeBarrelContents, regenerateBarrel } from "../barrel-generator";

suite("Barrel generator", () => {
  test("preserves custom exports and comments when refreshing barrel", () => {
    const existing =
      "// Generated exports\nexport * from './old';\n\n// Custom exports\n// public API\nexport { Legacy } from './legacy';\n";
    const result = mergeBarrelContents(existing, ["export * from './new';"]);

    assert.ok(result.includes("// public API"));
    assert.ok(result.includes("export { Legacy } from './legacy';"));
    assert.ok(result.includes("export * from './new';"));
    assert.ok(!result.includes("export * from './old';"));
  });

  test("preserves custom relative exports and comments when refreshing barrel", () => {
    const existing =
      "// Generated exports\nexport * from './old';\n\n// Custom exports\n// public API\nexport * from '../services/action-form.service';\nexport * from '../../../features/actions/compression';\n";
    const result = mergeBarrelContents(existing, ["export * from './new';"]);

    assert.ok(result.includes("// public API"));
    assert.ok(
      result.includes("export * from '../services/action-form.service';"),
    );
    assert.ok(
      result.includes("export * from '../../../features/actions/compression';"),
    );
    assert.ok(result.includes("export * from './new';"));
  });

  test("handles CRLF and duplicate generated exports", () => {
    const existing =
      "// Generated exports\r\nexport * from './one';\r\nexport * from './one';\r\n\r\n// Custom exports\r\n// API\r\n";
    const result = mergeBarrelContents(existing, [
      "export * from './one';",
      "export * from './two';",
    ]);

    assert.ok(result.includes("// API"));
    assert.ok(result.includes("export * from './one';"));
    assert.ok(result.includes("export * from './two';"));
    assert.strictEqual(result.match(/export \* from '\.\/one';/g)?.length, 1);
  });

  test("preserves custom named exports and comments verbatim", () => {
    const existing =
      "// Generated exports\nexport * from './old';\n\n// Custom exports\n// Keep this comment\nexport { Special } from '../features/special';\n";
    const result = mergeBarrelContents(existing, [
      "export * from './generated';",
    ]);

    assert.ok(result.includes("// Keep this comment"));
    assert.ok(
      result.includes("export { Special } from '../features/special';"),
    );
    assert.ok(result.includes("export * from './generated';"));
  });

  test("preserves nested barrel paths", () => {
    const existing =
      "// Generated exports\n\n// Custom exports\nexport * from '../../../features/actions/compression';\n";
    const result = mergeBarrelContents(existing, [
      "export * from './nested/nested.service';",
    ]);

    assert.ok(result.includes("export * from './nested/nested.service';"));
    assert.ok(
      result.includes("export * from '../../../features/actions/compression';"),
    );
  });

  test("preserves deep relative compression barrel export", () => {
    const existing =
      "// Generated exports\n\n// Custom exports\nexport * from '../../../features/actions/compression';\n";
    const result = mergeBarrelContents(existing, [
      "export * from './consumer';",
    ]);

    assert.ok(
      result.includes("export * from '../../../features/actions/compression';"),
    );
    assert.ok(result.includes("export * from './consumer';"));
  });

  test("replaces stale generated exports and preserves custom exports", () => {
    const existing =
      "// Generated exports\nexport * from './moved.service';\nexport * from './old.service';\n\n// Custom exports\nexport * from '../shared/custom.service';\n";
    const result = mergeBarrelContents(existing, [
      "export * from './current.service';",
    ]);

    assert.ok(result.includes("// Generated exports"));
    assert.ok(result.includes("export * from './current.service';"));
    assert.ok(!result.includes("export * from './moved.service';"));
    assert.ok(!result.includes("export * from './old.service';"));
    assert.ok(result.includes("// Custom exports"));
    assert.ok(result.includes("export * from '../shared/custom.service';"));
  });

  test("ignores marker text in template literals and block comments", () => {
    const existing = "export const text = `inside\n// Custom exports\n`;\n" +
      "/*\n// Custom exports\n*/\n";
    const result = mergeBarrelContents(existing, []);
    assert.ok(result.endsWith("// Custom exports\n" + existing));
    assert.strictEqual(mergeBarrelContents(result, []), result);
  });

  test("omits conflicting generated names and emits Node16 module extensions", async () => {
    const folder = vscode.Uri.file(await mkdtemp(join(tmpdir(), "auto-index-exports-")));
    const file = (name: string) => vscode.Uri.joinPath(folder, name);
    const encoder = new TextEncoder();
    try {
      await Promise.all([
        vscode.workspace.fs.writeFile(file("index.ts"), encoder.encode("")),
        vscode.workspace.fs.writeFile(file("package.json"), encoder.encode('{"type":"module"}')),
        vscode.workspace.fs.writeFile(
          file("tsconfig.json"), encoder.encode('{"compilerOptions":{"module":"node16"}}'),
        ),
        vscode.workspace.fs.writeFile(
          file("first.mts"),
          encoder.encode("export class Duplicate {}\nexport class First {}\n"),
        ),
        vscode.workspace.fs.writeFile(
          file("second.cts"),
          encoder.encode("export class Duplicate {}\nexport interface Second {}\n"),
        ),
      ]);
      assert.strictEqual(await regenerateBarrel(folder), true);

      const index = file("index.ts").fsPath;
      const program = ts.createProgram([index], {
        module: ts.ModuleKind.Node16,
        moduleResolution: ts.ModuleResolutionKind.Node16,
        types: [],
        noEmit: true,
      });
      assert.deepStrictEqual(ts.getPreEmitDiagnostics(program).map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
      const source = program.getSourceFile(index)!;
      const checker = program.getTypeChecker();
      assert.deepStrictEqual(
        checker.getExportsOfModule(checker.getSymbolAtLocation(source)!)
          .map((symbol) => symbol.getName()).sort(),
        ["First", "Second"],
      );

      await vscode.workspace.fs.writeFile(file("package.json"), encoder.encode('{"type":"commonjs"}'));
      assert.strictEqual(await regenerateBarrel(folder), true);
      const commonJs = new TextDecoder().decode(await vscode.workspace.fs.readFile(file("index.ts")));
      assert.ok(!commonJs.includes("first.mjs"));
      assert.ok(commonJs.includes("./second.cjs"));
    } finally {
      await vscode.workspace.fs.delete(folder, { recursive: true });
    }
  });

  test("always includes the custom exports section", () => {
    const result = mergeBarrelContents(undefined, [
      "export * from './current.service';",
    ]);

    assert.ok(result.includes("// Generated exports"));
    assert.ok(result.includes("export * from './current.service';"));
    assert.ok(result.endsWith("// Custom exports\n"));
  });
});

suite("Production configuration", () => {
  test("enables safe on-save rewriting by default", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const packageJsonPath = path.resolve(__dirname, "../../package.json");
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf8"),
    ) as {
      contributes: {
        configuration: {
          properties: Record<string, { default?: unknown }>;
        };
      };
    };

    assert.strictEqual(
      packageJson.contributes.configuration.properties[
        "autoIndexBarrel.rewriteImportsOnSave"
      ].default,
      true,
    );
  });
});

suite("Save race integration", () => {
  test("keeps an open barrel editable without stale save conflicts", async () => {
    // The active development extension watches the workspace. Keep this direct
    // generator test outside it so both copies cannot write the same barrel.
    const folderUri = vscode.Uri.file(await mkdtemp(join(tmpdir(), "auto-index-save-")));
    try {
      const indexUri = vscode.Uri.joinPath(folderUri, "index.ts");
      await vscode.workspace.fs.writeFile(
        indexUri,
        new TextEncoder().encode("// Generated exports\n// Custom exports\n"),
      );

      const document = await vscode.workspace.openTextDocument(indexUri);
      await vscode.window.showTextDocument(document);

      const firstUri = vscode.Uri.joinPath(folderUri, "first.service.ts");
      const secondUri = vscode.Uri.joinPath(folderUri, "second.service.ts");
      await vscode.workspace.fs.writeFile(
        firstUri,
        new TextEncoder().encode("export class FirstService {}\n"),
      );

      await Promise.all([
        regenerateBarrel(folderUri, false),
        regenerateBarrel(folderUri, false),
      ]);

      assert.strictEqual(document.isDirty, false);
      const saved = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(indexUri),
      );
      assert.ok(saved.includes("export * from './first.service';"));

      const manualEdit = new vscode.WorkspaceEdit();
      manualEdit.insert(
        indexUri,
        document.positionAt(document.getText().length),
        "// Manual edit\n",
      );
      assert.strictEqual(await vscode.workspace.applyEdit(manualEdit), true);

      await vscode.workspace.fs.rename(firstUri, secondUri);
      await regenerateBarrel(folderUri, false);

      assert.strictEqual(document.isDirty, true);
      assert.ok(document.getText().includes("// Manual edit"));
      assert.ok(document.getText().includes("export * from './second.service';"));
      assert.ok(!document.getText().includes("export * from './first.service';"));
      assert.strictEqual(
        new TextDecoder().decode(await vscode.workspace.fs.readFile(indexUri)),
        saved,
      );
      assert.strictEqual(await document.save(), true);
    } finally {
      await vscode.workspace.fs.delete(folderUri, { recursive: true });
    }
  });
});
