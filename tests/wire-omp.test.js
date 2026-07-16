import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyOmpModelsYml,
  clearOmpModelsYml,
  detectOmpWired,
  generateOmpModelsYml,
  renderOmpModelsYml,
} from '../src/cli/wire/omp.js';

function mkProvider({ id, apiKey, type, baseUrl, order, models }) {
  return {
    id,
    apiKey,
    type,
    baseUrl,
    order,
    priority: order,
    quotaReset: 'daily',
    failureReset: 'hourly',
    headers: {},
    models,
    key: { name: id, value: apiKey, priority: order },
  };
}

function makeConfig(providers) {
  return { providers };
}

const YAML_DELIM = '---';

test('generateOmpModelsYml emits one provider per (mfk provider, type)', () => {
  const config = makeConfig([
    mkProvider({ id: 'a', apiKey: 'sk-AKEY', type: 'anthropic', baseUrl: 'https://a.example.com', order: 0, models: ['claude-sonnet-4-6'] }),
    mkProvider({ id: 'o', apiKey: 'sk-OKEY', type: 'openai', baseUrl: 'https://o.example.com', order: 1, models: ['gpt-5.3-codex'] }),
    mkProvider({ id: 'g', apiKey: 'sk-GKEY', type: 'google', baseUrl: 'https://g.example.com', order: 2, models: ['gemini-3-pro'] }),
  ]);

  const body = generateOmpModelsYml({ config });
  const yaml = renderOmpModelsYml(body);

  assert.match(yaml, /^providers:\n/, 'starts with providers map');
  assert.match(yaml, /example\.com-anthropic-00:/, 'first provider is domain-anthropic with orderPad 00');
  assert.match(yaml, /example\.com-openai-01:/, 'second is openai with orderPad 01');
  assert.match(yaml, /example\.com-google-02:/, 'third is google with orderPad 02');
  assert.match(yaml, /api: anthropic-messages/, 'translates anthropic type');
  assert.match(yaml, /api: openai-responses/, 'translates openai type');
  assert.match(yaml, /api: google-generative-ai/, 'translates google type');
  assert.match(yaml, /auth: apiKey/, 'auth defaults to apiKey');
});

test('generateOmpModelsYml strips mfk namespace prefixes from model ids', () => {
  const config = makeConfig([
    mkProvider({ id: 'a', apiKey: 'sk-AKEY', type: 'anthropic', baseUrl: 'https://a.example.com', order: 0, models: [
      'anthropic/claude-opus-4-7',
      'anthropic/claude-sonnet-4-6',
      'deepseek-v4-pro-anthropic',
    ] }),
  ]);

  const yaml = renderOmpModelsYml(generateOmpModelsYml({ config }));

  assert.match(yaml, /id: claude-opus-4-7/);
  assert.match(yaml, /id: claude-sonnet-4-6/);
  assert.match(yaml, /id: deepseek-v4-pro-anthropic/);
  assert.doesNotMatch(yaml, /id: anthropic\/claude/, 'namespace prefix stripped');
});

test('generateOmpModelsYml drops wildcards and de-duplicates within a provider', () => {
  const config = makeConfig([
    mkProvider({ id: 'a', apiKey: 'sk-AKEY', type: 'anthropic', baseUrl: 'https://a.example.com', order: 0, models: [
      '*', 'anthropic/*', 'foo', 'foo', 'bar',
    ] }),
  ]);

  const yaml = renderOmpModelsYml(generateOmpModelsYml({ config }));
  const modelsBlock = yaml.split('models:\n')[1].split('\n');
  const ids = modelsBlock.map((line) => line.match(/id: (\S+)/)?.[1]).filter(Boolean);

  assert.deepEqual(ids, ['foo', 'bar']);
  assert.doesNotMatch(yaml, /id: \*/);
  assert.doesNotMatch(yaml, /id: anthropic\//);
});

test('generateOmpModelsYml produces one omp provider per type for multi-typed providers', () => {
  const config = makeConfig([
    mkProvider({ id: 'multi', apiKey: 'sk-MULTI', type: 'anthropic', baseUrl: 'https://m.example.com', order: 0, models: ['claude-sonnet-4-6'] }),
    mkProvider({ id: 'multi', apiKey: 'sk-MULTI', type: 'openai', baseUrl: 'https://m.example.com', order: 1, models: ['gpt-5.3-codex'] }),
  ]);

  const yaml = renderOmpModelsYml(generateOmpModelsYml({ config }));

  assert.match(yaml, /example\.com-anthropic-00:/, 'anthropic variant from order 0');
  assert.match(yaml, /example\.com-openai-01:/, 'openai variant from order 1');
  assert.match(yaml, /api: anthropic-messages/);
  assert.match(yaml, /api: openai-responses/);
});

test('generateOmpModelsYml sets reasoning:true on opus and thinking variants', () => {
  const config = makeConfig([
    mkProvider({ id: 'a', apiKey: 'sk-AKEY', type: 'anthropic', baseUrl: 'https://a.example.com', order: 0, models: [
      'claude-opus-4-7',
      'claude-sonnet-4-6',
      'claude-opus-4-7-thinking',
      'plain-model',
    ] }),
  ]);

  const yaml = renderOmpModelsYml(generateOmpModelsYml({ config }));

  // Each model block is the indented keys following `      - id: <name>`.
  // Split on those markers so we can attribute per-model reasoning presence.
  const blocks = yaml.split('\n      - id: ').slice(1);
  const byId = Object.fromEntries(blocks.map((block) => {
    const [id, ...rest] = block.split('\n');
    return [id, rest.join('\n')];
  }));

  assert.match(byId['claude-opus-4-7'], /reasoning: true/, 'opus gets reasoning flag');
  assert.match(byId['claude-opus-4-7-thinking'], /reasoning: true/, 'opus-thinking gets reasoning flag');
  assert.doesNotMatch(byId['plain-model'] ?? '', /reasoning/, 'unknown plain model has no catalog reasoning flag');
});

test('generateOmpModelsYml attaches catalog metadata to matched models', () => {
  const config = makeConfig([
    mkProvider({ id: 'a', apiKey: 'sk-AKEY', type: 'anthropic', baseUrl: 'https://a.example.com', order: 0, models: [
      'claude-sonnet-4-6',
      'gpt-5.6-sol',
    ] }),
  ]);

  const yaml = renderOmpModelsYml(generateOmpModelsYml({ config }));

  const blocks = yaml.split('\n      - id: ').slice(1);
  const byId = Object.fromEntries(blocks.map((block) => {
    const [id, ...rest] = block.split('\n');
    return [id, rest.join('\n')];
  }));

  // Exact catalog hit.
  assert.match(byId['claude-sonnet-4-6'], /input: \[text, image\]/);
  assert.match(byId['claude-sonnet-4-6'], /contextWindow: 200000/);
  assert.match(byId['claude-sonnet-4-6'], /maxTokens: 64000/);
  assert.match(byId['claude-sonnet-4-6'], /cost: \{ input: 3, output: 15, cacheRead: 0\.3, cacheWrite: 3\.75 \}/);

  // Fuzzy hit: gpt-5.6-sol resolves to the gpt-5.6 catalog entry, keeps its own id.
  assert.match(byId['gpt-5.6-sol'], /name: GPT-5\.6/);
  assert.match(byId['gpt-5.6-sol'], /contextWindow: 400000/);
});

test('generateOmpModelsYml omits catalog extras for unmatched models', () => {
  const config = makeConfig([
    mkProvider({ id: 'a', apiKey: 'sk-AKEY', type: 'anthropic', baseUrl: 'https://a.example.com', order: 0, models: [
      'totally-unknown-model-xyz',
    ] }),
  ]);

  const yaml = renderOmpModelsYml(generateOmpModelsYml({ config }));

  assert.match(yaml, /id: totally-unknown-model-xyz/);
  assert.doesNotMatch(yaml, /contextWindow:/);
  assert.doesNotMatch(yaml, /cost:/);
  assert.doesNotMatch(yaml, /input:/);
});

test('generateOmpModelsYml skips providers with missing apiKey or baseUrl', () => {
  const config = makeConfig([
    mkProvider({ id: 'empty', apiKey: '', type: 'anthropic', baseUrl: 'https://empty.example.com', order: 0, models: ['claude-sonnet-4-6'] }),
    mkProvider({ id: 'nokey', apiKey: 'sk-NOKEY', type: 'openai', baseUrl: '', order: 1, models: ['gpt-5.3-codex'] }),
    mkProvider({ id: 'unknown-type', apiKey: 'sk-XKEY', type: 'cohere', baseUrl: 'https://x.example.com', order: 2, models: ['command-r'] }),
  ]);

  const yaml = renderOmpModelsYml(generateOmpModelsYml({ config }));

  assert.doesNotMatch(yaml, /empty\.example\.com/);
  assert.doesNotMatch(yaml, /command-r/);
  // Body should be empty (only the providers map wrapper).
  assert.equal(yaml.trimEnd(), 'providers: {}', 'invalid providers all skipped');
});

test('applyOmpModelsYml writes the managed block and creates a backup the first time only', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfk-omp-'));
  const outPath = path.join(tmpDir, 'models.yml');
  const original = 'providers:\n  user-anthropic:\n    baseUrl: https://my-gateway.example.com\n    apiKey: hand-written\n    api: anthropic-messages\n    auth: oauth\n    models: []\n';
  fs.writeFileSync(outPath, original);

  const body = '  mfk-aaaa-anthropic-00:\n    baseUrl: https://a.example.com\n    apiKey: sk-AKEY\n    api: anthropic-messages\n    auth: apiKey\n    models:\n      - id: claude-sonnet-4-6';

  const first = applyOmpModelsYml({ outPath, body });
  assert.equal(first.action, 'wrote');
  assert.equal(fs.existsSync(`${outPath}.mfk-backup`), true, 'first write creates backup');

  const backupContent = fs.readFileSync(`${outPath}.mfk-backup`, 'utf8');
  assert.equal(backupContent, original, 'backup captures the original byte-for-byte');

  // Rewriting with a different body should NOT touch the backup.
  const backupMtime1 = fs.statSync(`${outPath}.mfk-backup`).mtimeMs;
  // Force a small delay so mtime can change if we erroneously rewrite the backup.
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  return wait(20).then(() => {
    const second = applyOmpModelsYml({ outPath, body: body + '\n      - id: claude-opus-4-7' });
    assert.equal(second.action, 'wrote');
    const backupMtime2 = fs.statSync(`${outPath}.mfk-backup`).mtimeMs;
    assert.equal(backupMtime1, backupMtime2, 'backup not re-touched on second write');

    const finalContent = fs.readFileSync(outPath, 'utf8');
    assert.match(finalContent, /user-anthropic:\n    baseUrl: https:\/\/my-gateway\.example\.com/, 'preserves user block');
    assert.match(finalContent, /\n\n# >>> mfk wire omp >>>/, 'managed block appended below existing content');
    assert.match(finalContent, /claude-sonnet-4-6/, 'first write body present');
    assert.match(finalContent, /claude-opus-4-7/, 'second write appended model present');
    // No duplicate sentinels.
    assert.equal((finalContent.match(/# >>> mfk wire omp >>>/g) ?? []).length, 1, 'exactly one start sentinel');
    assert.equal((finalContent.match(/# <<< mfk wire omp <<</g) ?? []).length, 1, 'exactly one end sentinel');
  });
});

test('applyOmpModelsYml rewire replaces the existing managed block in place', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfk-omp-'));
  const outPath = path.join(tmpDir, 'models.yml');
  fs.writeFileSync(outPath, 'providers: {}\n');

  applyOmpModelsYml({
    outPath,
    body: '  mfk-aaaa-anthropic-00:\n    models:\n      - id: old-model',
  });
  const afterFirst = fs.readFileSync(outPath, 'utf8');

  applyOmpModelsYml({
    outPath,
    body: '  mfk-bbbb-anthropic-01:\n    models:\n      - id: new-model',
  });
  const afterSecond = fs.readFileSync(outPath, 'utf8');

  assert.match(afterFirst, /old-model/, 'first write is visible');
  assert.match(afterSecond, /new-model/, 'second write replaces body');
  assert.doesNotMatch(afterSecond, /\bold-model\b/, 'old body no longer in file');
  assert.equal((afterSecond.match(/# >>> mfk wire omp >>>/g) ?? []).length, 1, 'sentinel count stable');
});

test('applyOmpModelsYml dryRun does not touch the file and returns the rendered body', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfk-omp-'));
  const outPath = path.join(tmpDir, 'models.yml');
  const original = '# existing hand-written config\nproviders:\n  oauth-anthropic:\n    apiKey: env\n';
  fs.writeFileSync(outPath, original);

  const result = applyOmpModelsYml({ outPath, body: '# synthetic body', dryRun: true });
  assert.equal(result.action, 'dry-run');
  assert.equal(result.body, '# synthetic body');
  assert.equal(fs.readFileSync(outPath, 'utf8'), original, 'dryRun leaves file untouched');
  assert.equal(fs.existsSync(`${outPath}.mfk-backup`), false, 'dryRun creates no backup');
});

test('applyOmpModelsYml creates the parent directory when missing', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfk-omp-'));
  const outPath = path.join(tmpDir, 'nested', 'dir', 'models.yml');

  applyOmpModelsYml({ outPath, body: '  mfk-aaaa-openai-00:\n    models: []' });
  assert.equal(fs.existsSync(outPath), true);
});

test('clearOmpModelsYml removes the managed block but preserves the rest', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfk-omp-'));
  const outPath = path.join(tmpDir, 'models.yml');
  const handWritten = '# user header\nproviders:\n  oauth-anthropic:\n    apiKey: env\n';
  fs.writeFileSync(outPath, handWritten);
  applyOmpModelsYml({ outPath, body: '  mfk-aaaa-anthropic-00:\n    models: []' });

  const before = fs.readFileSync(outPath, 'utf8');
  assert.match(before, /# >>> mfk wire omp >>>/);

  const result = clearOmpModelsYml({ outPath });
  assert.equal(result.action, 'cleared');

  const after = fs.readFileSync(outPath, 'utf8');
  assert.match(after, /# user header/, 'preserves user header');
  assert.match(after, /oauth-anthropic/, 'preserves user provider');
  assert.doesNotMatch(after, /# >>> mfk wire omp >>>/, 'removes managed block start');
  assert.doesNotMatch(after, /mfk-aaaa-anthropic-00/, 'removes managed block body');
});

test('clearOmpModelsYml no-op when there is no managed block', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfk-omp-'));
  const outPath = path.join(tmpDir, 'models.yml');
  fs.writeFileSync(outPath, 'providers: {}\n');

  const result = clearOmpModelsYml({ outPath });
  assert.equal(result.action, 'nothing-to-clear');
});

test('detectOmpWired reflects the current managed-block state', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfk-omp-'));
  const outPath = path.join(tmpDir, 'models.yml');

  assert.equal(detectOmpWired({ outPath }), false, 'no file → not wired');

  fs.writeFileSync(outPath, 'providers: {}\n');
  assert.equal(detectOmpWired({ outPath }), false, 'no managed block → not wired');

  applyOmpModelsYml({ outPath, body: '  mfk-aaaa-anthropic-00:\n    models: []' });
  assert.equal(detectOmpWired({ outPath }), true, 'managed block present → wired');

  clearOmpModelsYml({ outPath });
  assert.equal(detectOmpWired({ outPath }), false, 'after clear → not wired');
});
