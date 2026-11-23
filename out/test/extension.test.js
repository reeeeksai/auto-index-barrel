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
const barrel_generator_1 = require("../barrel-generator");
suite('Barrel generator', () => {
    test('preserves custom exports and comments when refreshing barrel', () => {
        const existing = "// public API\nexport { Legacy } from './legacy';\nexport * from './old';\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, ["export * from './new';"]);
        assert.ok(result.includes("// public API"));
        assert.ok(result.includes("export { Legacy } from './legacy';"));
        assert.ok(result.includes("export * from './new';"));
        assert.ok(result.includes("export * from './old';"));
    });
    test('preserves custom relative exports and comments when refreshing barrel', () => {
        const existing = "// public API\nexport { Legacy } from './legacy';\nexport * from '../services/action-form.service';\nexport * from '../../../features/actions/compression';\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, ["export * from './new';"]);
        assert.ok(result.includes("// public API"));
        assert.ok(result.includes("export { Legacy } from './legacy';"));
        assert.ok(result.includes("export * from '../services/action-form.service';"));
        assert.ok(result.includes("export * from '../../../features/actions/compression';"));
        assert.ok(result.includes("export * from './new';"));
    });
    test('handles CRLF and duplicate generated exports', () => {
        const existing = "// API\r\nexport * from './one';\r\nexport * from './one';\r\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, [
            "export * from './one';",
            "export * from './two';",
        ]);
        assert.ok(result.includes("// API"));
        assert.ok(result.includes("export * from './one';"));
        assert.ok(result.includes("export * from './two';"));
        assert.strictEqual(result.match(/export \* from '\.\/one';/g)?.length, 2);
    });
    test('preserves custom named exports and comments verbatim', () => {
        const existing = "// Keep this comment\nexport { Special } from '../features/special';\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, ["export * from './generated';"]);
        assert.ok(result.includes("// Keep this comment"));
        assert.ok(result.includes("export { Special } from '../features/special';"));
        assert.ok(result.includes("export * from './generated';"));
    });
    test('preserves nested barrel paths', () => {
        const existing = "export * from '../../../features/actions/compression';\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, ["export * from './nested/nested.service';"]);
        assert.ok(result.includes("export * from './nested/nested.service';"));
        assert.ok(result.includes("export * from '../../../features/actions/compression';"));
    });
    test('preserves deep relative compression barrel export', () => {
        const existing = "export * from '../../../features/actions/compression';\n";
        const result = (0, barrel_generator_1.mergeBarrelContents)(existing, ["export * from './consumer';"]);
        assert.ok(result.includes("export * from '../../../features/actions/compression';"));
        assert.ok(result.includes("export * from './consumer';"));
    });
});
suite('Production configuration', () => {
    test('enables safe on-save rewriting by default', () => {
        const fs = require('fs');
        const path = require('path');
        const packageJsonPath = path.resolve(__dirname, '../../package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        assert.strictEqual(packageJson.contributes.configuration.properties['autoIndexBarrel.rewriteImportsOnSave'].default, true);
    });
});
//# sourceMappingURL=extension.test.js.map