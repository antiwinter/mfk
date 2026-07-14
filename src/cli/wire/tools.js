import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../config/store.js';
import { applyOmpModelsYml, clearOmpModelsYml, detectOmpWired, generateOmpModelsYml, renderOmpModelsYml } from './omp.js';

const BLOCK_START = '# >>> mfk wire >>>';
const BLOCK_END = '# <<< mfk wire <<<';

// Captures an existing managed block (including its sentinel lines), non-greedy, multiline.
const BLOCK_REGEX = new RegExp(
  `${escapeRegex(BLOCK_START)}[\\s\\S]*?${escapeRegex(BLOCK_END)}\\n?`,
);

function home(rel) {
  return path.join(os.homedir(), rel);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function portOf(url) {
  try {
    return new URL(url).port;
  } catch {
    return '';
  }
}

// A tool is considered wired to mfk when its stored base URL targets the mfk
// port and its credential is an mfk virtual key. This is independent of how the
// host is written (localhost vs 127.0.0.1 vs a domain), which is what made the
// previous exact-host comparison miss valid wirings.
function isMfkWired(storedUrl, storedToken, baseUrl) {
  const port = portOf(baseUrl);
  const urlOk = port !== '' && String(storedUrl ?? '').includes(port);
  const tokenOk = Boolean(storedToken) && String(storedToken).startsWith('mfk-');
  return urlOk && tokenOk;
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function readJson(filePath) {
  const text = readText(filePath);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

// One-time safety backup so the user can recover the original file manually.
function backupFile(filePath) {
  const backup = `${filePath}.mfk-backup`;
  if (!fs.existsSync(backup) && fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, backup);
  }
  return backup;
}

function hasManagedBlock(text) {
  return text != null && text.includes(BLOCK_START);
}

function setManagedBlock(text, innerContent) {
  const base = removeManagedBlock(text) ?? '';
  const trimmed = base.replace(/\n+$/, '');
  const block = `${BLOCK_START}\n${innerContent}\n${BLOCK_END}`;
  return trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
}

function removeManagedBlock(text) {
  if (text == null) return null;
  const cleaned = text.replace(BLOCK_REGEX, '');
  return cleaned.replace(/\n{3,}/g, '\n\n');
}

// --- Adapters -----------------------------------------------------------------

const claudeCode = {
  id: 'claude',
  label: 'Claude Code',
  description: '~/.claude/settings.json — env.ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN',
  detect(baseUrl) {
    const cfg = readJson(home('.claude/settings.json'));
    return isMfkWired(cfg?.env?.ANTHROPIC_BASE_URL, cfg?.env?.ANTHROPIC_AUTH_TOKEN, baseUrl);
  },
  wire({ baseUrl, virtualKey }) {
    const filePath = home('.claude/settings.json');
    backupFile(filePath);
    const cfg = readJson(filePath) ?? {};
    cfg.env = {
      ...(cfg.env ?? {}),
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: virtualKey,
    };
    writeJson(filePath, cfg);
    return `wrote ${filePath}`;
  },
  clear() {
    const filePath = home('.claude/settings.json');
    const cfg = readJson(filePath);
    if (!cfg?.env || (!cfg.env.ANTHROPIC_BASE_URL && !cfg.env.ANTHROPIC_AUTH_TOKEN)) {
      return `nothing to clear: ${filePath}`;
    }
    delete cfg.env.ANTHROPIC_BASE_URL;
    delete cfg.env.ANTHROPIC_AUTH_TOKEN;
    writeJson(filePath, cfg);
    return `cleared ${filePath}`;
  },
};

const codex = {
  id: 'codex',
  label: 'Codex CLI',
  description: '~/.codex/config.toml + auth.json — custom provider (wire_api = chat)',
  detect() {
    const text = readText(home('.codex/config.toml'));
    return hasManagedBlock(text);
  },
  wire({ baseUrl, virtualKey }) {
    const filePath = home('.codex/config.toml');
    backupFile(filePath);
    const original = readText(filePath) ?? '';
    // Drop any existing top-level `model_provider = …` so we never produce a duplicate key,
    // then remove a prior managed block (idempotent).
    const stripped = removeManagedBlock(original).replace(
      /^[ \t]*model_provider[ \t]*=.*$\n?/gim,
      '',
    );
    const inner = [
      `model_provider = "mfk"`,
      ``,
      `[model_providers.mfk]`,
      `name = "MFK Gateway"`,
      `base_url = "${baseUrl.replace(/\/+$/, '')}/v1"`,
      `wire_api = "chat"`,
      `experimental_bearer_token = "${virtualKey}"`,
    ].join('\n');
    writeText(filePath, setManagedBlock(stripped, inner));

    // The CLI reads experimental_bearer_token from config.toml, but the VS Code
    // Codex extension only checks ~/.codex/auth.json for login state. Write the
    // virtual key there too so the extension recognises the session.
    const authPath = home('.codex/auth.json');
    backupFile(authPath);
    writeJson(authPath, { OPENAI_API_KEY: virtualKey });

    return `wrote ${filePath} + auth.json`;
  },
  clear() {
    const filePath = home('.codex/config.toml');
    const original = readText(filePath);
    if (!hasManagedBlock(original)) {
      return `nothing to clear: ${filePath}`;
    }
    // Removing the managed block (which carried model_provider = "mfk") leaves codex
    // with no model_provider, so it falls back to its built-in default (official OpenAI).
    // The original file is preserved as <file>.mfk-backup for manual recovery.
    const cleaned = removeManagedBlock(original).replace(/\n+$/, '');
    writeText(filePath, `${cleaned}\n`);

    // Restore the pre-wire auth.json from backup if present (preserves a prior
    // ChatGPT login); otherwise drop the mfk key we wrote.
    const authPath = home('.codex/auth.json');
    const backup = `${authPath}.mfk-backup`;
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, authPath);
    } else {
      const auth = readJson(authPath);
      if (auth && typeof auth.OPENAI_API_KEY === 'string' && auth.OPENAI_API_KEY.startsWith('mfk-')) {
        fs.rmSync(authPath);
      }
    }

    return `cleared ${filePath} + auth.json`;
  },
};

function shellEnvFiles() {
  return ['.zshrc', '.bashrc'].map((rel) => home(rel)).filter((p) => fs.existsSync(p));
}

function shellBlockInner(baseUrl, virtualKey) {
  return [
    `export OPENAI_BASE_URL="${baseUrl}"`,
    `export OPENAI_API_KEY="${virtualKey}"`,
    `export ANTHROPIC_BASE_URL="${baseUrl}"`,
    `export ANTHROPIC_AUTH_TOKEN="${virtualKey}"`,
  ].join('\n');
}

const shellEnv = {
  id: 'shell',
  label: 'Shell env',
  description: '~/.zshrc (+ ~/.bashrc) — OPENAI_/ANTHROPIC_ base URL + key exports',
  detect() {
    return shellEnvFiles().some((filePath) => hasManagedBlock(readText(filePath)));
  },
  wire({ baseUrl, virtualKey }) {
    const files = shellEnvFiles();
    if (files.length === 0) {
      return 'no shell rc found (~/.zshrc / ~/.bashrc)';
    }
    for (const filePath of files) {
      backupFile(filePath);
      writeText(filePath, setManagedBlock(readText(filePath), shellBlockInner(baseUrl, virtualKey)));
    }
    return `wrote ${files.join(', ')}`;
  },
  clear() {
    const files = shellEnvFiles().filter((filePath) => hasManagedBlock(readText(filePath)));
    if (files.length === 0) {
      return 'nothing to clear: ~/.zshrc / ~/.bashrc';
    }
    for (const filePath of files) {
      writeText(filePath, removeManagedBlock(readText(filePath)));
    }
    return `cleared ${files.join(', ')}`;
  },
};

// omp is wired by translating mfk's config.json into ~/.omp/agent/models.yml.
// omp talks to upstreams directly, so it ignores the mfk baseUrl/virtualKey.
const omp = {
  id: 'omp',
  label: 'OMP',
  description: '~/.omp/agent/models.yml — providers/models translated from mfk config',
  detect() {
    return detectOmpWired();
  },
  async wire({ configPath }) {
    const { config } = await loadConfig(configPath);
    const body = generateOmpModelsYml({ config });
    const yaml = renderOmpModelsYml(body);
    const result = applyOmpModelsYml({ body: yaml.trimEnd() });
    if (result.action === 'wrote') {
      return `wrote ${result.path}`;
    }
    return `${result.action}: ${result.path}`;
  },
  clear() {
    const result = clearOmpModelsYml();
    if (result.action === 'cleared') {
      return `cleared ${result.path}`;
    }
    return result.action;
  },
};

export const TOOLS = [claudeCode, codex, shellEnv, omp];

export function getTool(id) {
  return TOOLS.find((tool) => tool.id === id) ?? null;
}
