import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { bundledPacks, defaultLocale } from './index';

const root = resolve(import.meta.dirname, '..');
const files = readdirSync(root, { recursive: true })
  .map(String)
  .filter(file => /\.tsx?$/.test(file) && !file.includes('.test.') && !file.endsWith('.d.ts'));
const messages = bundledPacks.find(pack => pack.locale === defaultLocale)!.messages;
describe('language-neutral product source', () => {
  it('keeps host message references in the same language contract', () => {
    const failures: string[] = [];
    for (const project of ['Vroom.Core', 'Vroom.App']) {
      const directory = resolve(root, '../../', project);
      for (const file of readdirSync(directory, { recursive: true })
        .map(String)
        .filter(file => file.endsWith('.cs') && !/(^|[\\/])(obj|bin)[\\/]/.test(file))) {
        const source = readFileSync(join(directory, file), 'utf8');
        for (const match of source.matchAll(/"(host\.[A-Za-z0-9_.]+)"/g))
          if (!Object.hasOwn(messages, match[1])) failures.push(project + '/' + file + ': missing ' + match[1]);
      }
    }
    expect(failures).toEqual([]);
  });
  it('does not embed Chinese copy or choose translations with language-specific branches', () => {
    const failures: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      if (
        /\p{Script=Han}/u.test(source) ||
        /startsWith\(['"](?:zh|en)['"]\)/.test(source) ||
        /['"](?:zh-CN|en-US)['"]/.test(source)
      )
        failures.push(file);
    }
    expect(failures).toEqual([]);
  });
  it('resolves literal message references and rejects inline English errors and visible copy', () => {
    const failures: string[] = [];
    for (const file of files) {
      const source = readFileSync(join(root, file), 'utf8');
      const ast = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      function visit(node: ts.Node) {
        if (
          ts.isCallExpression(node) &&
          ['appText', 'tr', 'translate', 'configText', 'ui'].includes(node.expression.getText(ast)) &&
          node.arguments[0] &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const key = (node.expression.getText(ast) === 'ui' ? 'ui.' : '') + node.arguments[0].text;
          if (!Object.hasOwn(messages, key)) failures.push(file + ': missing ' + key);
        }
        if (
          ts.isNewExpression(node) &&
          node.expression.getText(ast) === 'Error' &&
          node.arguments?.[0] &&
          ts.isStringLiteral(node.arguments[0]) &&
          /[a-z]+\s+[a-z]+/.test(node.arguments[0].text)
        )
          failures.push(file + ': inline error');
        if (ts.isJsxText(node) && /[a-z]{2,}/.test(node.text)) failures.push(file + ': inline JSX ' + node.text.trim());
        ts.forEachChild(node, visit);
      }
      visit(ast);
    }
    expect(failures).toEqual([]);
  });
});
