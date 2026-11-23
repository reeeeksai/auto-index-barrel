import * as assert from 'assert';
import * as vscode from 'vscode';
import { mergeBarrelContents } from '../barrel-generator';

suite('Barrel generator', () => {
	test('preserves custom exports and comments when refreshing barrel', () => {
		const existing = "// public API\nexport { Legacy } from './legacy';\nexport * from './old';\n";
		const result = mergeBarrelContents(existing, ["export * from './new';"]);

		assert.ok(result.includes("// public API"));
		assert.ok(result.includes("export { Legacy } from './legacy';"));
		assert.ok(result.includes("export * from './new';"));
		assert.ok(result.includes("export * from './old';"));
	});

	test('preserves custom relative exports and comments when refreshing barrel', () => {
		const existing = "// public API\nexport { Legacy } from './legacy';\nexport * from '../services/action-form.service';\nexport * from '../../../features/actions/compression';\n";
		const result = mergeBarrelContents(existing, ["export * from './new';"]);

		assert.ok(result.includes("// public API"));
		assert.ok(result.includes("export { Legacy } from './legacy';"));
		assert.ok(result.includes("export * from '../services/action-form.service';"));
		assert.ok(result.includes("export * from '../../../features/actions/compression';"));
		assert.ok(result.includes("export * from './new';"));
	});

	test('handles CRLF and duplicate generated exports', () => {
		const existing = "// API\r\nexport * from './one';\r\nexport * from './one';\r\n";
		const result = mergeBarrelContents(existing, [
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
		const result = mergeBarrelContents(existing, ["export * from './generated';"]);

		assert.ok(result.includes("// Keep this comment"));
		assert.ok(result.includes("export { Special } from '../features/special';"));
		assert.ok(result.includes("export * from './generated';"));
	});

	test('preserves nested barrel paths', () => {
		const existing = "export * from '../../../features/actions/compression';\n";
		const result = mergeBarrelContents(existing, ["export * from './nested/nested.service';"]);

		assert.ok(result.includes("export * from './nested/nested.service';"));
		assert.ok(result.includes("export * from '../../../features/actions/compression';"));
	});

	test('preserves deep relative compression barrel export', () => {
		const existing = "export * from '../../../features/actions/compression';\n";
		const result = mergeBarrelContents(existing, ["export * from './consumer';"]);

		assert.ok(result.includes("export * from '../../../features/actions/compression';"));
		assert.ok(result.includes("export * from './consumer';"));
	});
});

suite('Production configuration', () => {
	test('enables safe on-save rewriting by default', () => {
		const fs = require('fs') as typeof import('fs');
		const path = require('path') as typeof import('path');
		const packageJsonPath = path.resolve(__dirname, '../../package.json');
		const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
			contributes: {
				configuration: {
					properties: Record<string, { default?: unknown }>;
				};
			};
		};

		assert.strictEqual(
			packageJson.contributes.configuration.properties[
				'autoIndexBarrel.rewriteImportsOnSave'
			].default,
			true,
		);
	});
});
