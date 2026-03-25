/**
 * OpenClaw provider plugin for mfk (local LLM proxy).
 *
 * Registers an "mfk" provider that auto-discovers available models and their
 * API types by querying the running mfk instance at startup.
 *
 * API key is resolved from:
 *   1. MFK_API_KEY env var (set via openclaw.json `env.MFK_API_KEY` or shell)
 *   2. plugins.entries.mfk.config.apiKey fallback
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const DISCOVERY_TIMEOUT_MS = 3000;

interface ModelInfo {
  id: string;
  apiType: string;
}

interface ModelInfoResponse {
  models: ModelInfo[];
}

interface ModelListResponse {
  data: Array<{ id: string }>;
}

export default function register(api: any) {
  api.registerProvider({
    id: "mfk",
    label: "mfk (local proxy)",
    docsPath: "/providers/mfk",
    envVars: ["MFK_API_KEY"],

    // No interactive auth — key comes from env or plugin config.
    auth: [],

    discovery: {
      order: "late",
      run: async (ctx: any) => {
        const pluginConfig: Record<string, string> =
          ctx.config?.plugins?.entries?.mfk?.config ?? {};

        const apiKey =
          process.env.MFK_API_KEY ??
          pluginConfig.apiKey ??
          null;

        if (!apiKey) {
          return null;
        }

        const baseUrl = (pluginConfig.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");

        try {
          const models = await fetchModelInfos(baseUrl);
          if (!models || models.length === 0) return null;

          return {
            provider: {
              baseUrl,
              api: "openai-completions",
              models: models.map((m) => ({
                id: m.id,
                api: m.apiType,
              })),
            },
          };
        } catch {
          return null;
        }
      },
    },
  });
}

async function fetchModelInfos(baseUrl: string): Promise<ModelInfo[] | null> {
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);

  try {
    const res = await fetch(`${baseUrl}/v1/models/info`, { signal });
    if (res.ok) {
      const body = (await res.json()) as ModelInfoResponse;
      if (Array.isArray(body.models) && body.models.length > 0) {
        return body.models;
      }
    }
  } catch {
    // Fall through to /v1/models fallback.
  }

  const res = await fetch(`${baseUrl}/v1/models`, {
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
  });
  if (!res.ok) return null;

  const body = (await res.json()) as ModelListResponse;
  if (!Array.isArray(body.data) || body.data.length === 0) return null;

  return body.data.map((m) => ({
    id: m.id,
    apiType: inferApiType(m.id),
  }));
}

function inferApiType(modelId: string): string {
  return modelId.startsWith("anthropic/") ? "anthropic-messages" : "openai-completions";
}
