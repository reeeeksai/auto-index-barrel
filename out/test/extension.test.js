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
const assert = __importStar(require("assert"));
const vscode = __importStar(require("vscode"));
const barrel_generator_1 = require("../barrel-generator");
suite("Barrel generator", () => {
    test("preserves custom exports and comments when refreshing barrel", () => {
        const existing = "// Generated exports\nexport * from './old';\n\n// Custom exports\n// public API\nexport { Legacy } from './legacy';\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, ["export * from './new';"]);
        assert.ok(result.includes("// public API"));
        assert.ok(result.includes("export { Legacy } from './legacy';"));
        assert.ok(result.includes("export * from './new';"));
        assert.ok(!result.includes("export * from './old';"));
    });
    test("preserves custom relative exports and comments when refreshing barrel", () => {
        const existing = "// Generated exports\nexport * from './old';\n\n// Custom exports\n// public API\nexport * from '../services/action-form.service';\nexport * from '../../../features/actions/compression';\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, ["export * from './new';"]);
        assert.ok(result.includes("// public API"));
        assert.ok(result.includes("export * from '../services/action-form.service';"));
        assert.ok(result.includes("export * from '../../../features/actions/compression';"));
        assert.ok(result.includes("export * from './new';"));
    });
    test("handles CRLF and duplicate generated exports", () => {
        const existing = "// Generated exports\r\nexport * from './one';\r\nexport * from './one';\r\n\r\n// Custom exports\r\n// API\r\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, [
            "export * from './one';",
            "export * from './two';",
        ]);
        assert.ok(result.includes("// API"));
        assert.ok(result.includes("export * from './one';"));
        assert.ok(result.includes("export * from './two';"));
        assert.strictEqual(result.match(/export \* from '\.\/one';/g)?.length, 1);
    });
    test("preserves custom named exports and comments verbatim", () => {
        const existing = "// Generated exports\nexport * from './old';\n\n// Custom exports\n// Keep this comment\nexport { Special } from '../features/special';\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, [
            "export * from './generated';",
        ]);
        assert.ok(result.includes("// Keep this comment"));
        assert.ok(result.includes("export { Special } from '../features/special';"));
        assert.ok(result.includes("export * from './generated';"));
    });
    test("preserves nested barrel paths", () => {
        const existing = "// Generated exports\n\n// Custom exports\nexport * from '../../../features/actions/compression';\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, [
            "export * from './nested/nested.service';",
        ]);
        assert.ok(result.includes("export * from './nested/nested.service';"));
        assert.ok(result.includes("export * from '../../../features/actions/compression';"));
    });
    test("preserves deep relative compression barrel export", () => {
        const existing = "// Generated exports\n\n// Custom exports\nexport * from '../../../features/actions/compression';\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, [
            "export * from './consumer';",
        ]);
        assert.ok(result.includes("export * from '../../../features/actions/compression';"));
        assert.ok(result.includes("export * from './consumer';"));
    });
    test("replaces stale generated exports and preserves custom exports", () => {
        const existing = "// Generated exports\nexport * from './moved.service';\nexport * from './old.service';\n\n// Custom exports\nexport * from '../shared/custom.service';\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, ["export * from './current.service';"]);
        assert.ok(result.includes("// Generated exports"));
        assert.ok(result.includes("export * from './current.service';"));
        assert.ok(!result.includes("export * from './moved.service';"));
        assert.ok(!result.includes("export * from './old.service';"));
        assert.ok(result.includes("// Custom exports"));
        assert.ok(result.includes("export * from '../shared/custom.service';"));
    });
    test("always includes the custom exports section", () => {
        const result = (0, barrel_generator_1.mergeBarrelContents)(undefined, ["export * from './current.service';"]);
        assert.ok(result.includes("// Generated exports"));
        assert.ok(result.includes("export * from './current.service';"));
        assert.ok(result.endsWith("// Custom exports\n"));
    });
});
suite("Production configuration", () => {
    test("enables safe on-save rewriting by default", () => {
        const fs = require("fs");
        const path = require("path");
        const packageJsonPath = path.resolve(__dirname, "../../package.json");
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        assert.strictEqual(packageJson.contributes.configuration.properties["autoIndexBarrel.rewriteImportsOnSave"].default, true);
    });
});
suite("Save race integration", () => {
    test("keeps an open barrel editable without stale save conflicts", async () => {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            return;
        }
        const folderUri = vscode.Uri.joinPath(workspaceFolder.uri, "save-race-temp");
        await vscode.workspace.fs.createDirectory(folderUri);
        const indexUri = vscode.Uri.joinPath(folderUri, "index.ts");
        await vscode.workspace.fs.writeFile(indexUri, new TextEncoder().encode("// Generated exports\n// Custom exports\n"));
        const document = await vscode.workspace.openTextDocument(indexUri);
        await vscode.window.showTextDocument(document);
        void (0, barrel_generator_1.mergeBarrelContents)(document.getText(), [
            "export * from './first';",
            "export * from './second';",
        ]);
        await Promise.all([
            (0, barrel_generator_1.regenerateBarrel)(folderUri, false),
            (0, barrel_generator_1.regenerateBarrel)(folderUri, false),
        ]);
        await document.save();
        assert.strictEqual(document.isDirty, false);
        await vscode.workspace.fs.delete(folderUri, { recursive: true });
    });
});
//# sourceMappingURL=extension.test.js.map