import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installedWorkloads } from './lib/dotnet.mjs';

test('workload inventory accepts localized SDK notices without accepting malformed results', () => {
  assert.deepEqual(
    installedWorkloads('正在跳过 NuGet 包签名验证。\n{"installed":["maui-maccatalyst"],"updateAvailable":[]}\n'),
    ['maui-maccatalyst'],
  );
  assert.deepEqual(installedWorkloads('{"installed":[]}'), []);
  assert.throws(() => installedWorkloads('maui-maccatalyst installed'));
  assert.throws(() => installedWorkloads('{"installed":[{}]}'));
  assert.throws(() => installedWorkloads('{"installed":'));
});
