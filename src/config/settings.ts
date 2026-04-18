import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { env } from "node:process";
import yaml from "js-yaml";
import { PROJECT_ROOT } from "../paths.js";

export type AppSettings = {
  dataDir: string;
  /** MCP Project Brain 도구에서 project_id 생략 시 사용 */
  defaultProjectId: string;
  contextUsageThresholdPercent: number;
  compactionThresholdRatio: number;
  summarizationStartRatio: number;
  embeddingModel: string;
  tiktokenEncoding: string;
  compactionCooldownSeconds: number;
  compactionMaxRunsPerWindow: number;
  compactionRateWindowSeconds: number;
  maxInjectTokensDefault: number;
  openaiApiKey: string | null;
  openaiBaseUrl: string;
  compactionModel: string;
};

const DEFAULTS: AppSettings = {
  dataDir: "./data",
  defaultProjectId: "default",
  contextUsageThresholdPercent: 80,
  compactionThresholdRatio: 0.8,
  summarizationStartRatio: 0.75,
  embeddingModel: "all-MiniLM-L6-v2",
  tiktokenEncoding: "cl100k_base",
  compactionCooldownSeconds: 300,
  compactionMaxRunsPerWindow: 6,
  compactionRateWindowSeconds: 3600,
  maxInjectTokensDefault: 2000,
  openaiApiKey: null,
  openaiBaseUrl: "https://api.openai.com/v1",
  compactionModel: "gpt-4o-mini",
};

const CAMEL_MAP: Record<string, keyof AppSettings> = {
  data_dir: "dataDir",
  default_project_id: "defaultProjectId",
  context_usage_threshold_percent: "contextUsageThresholdPercent",
  compaction_threshold_ratio: "compactionThresholdRatio",
  summarization_start_ratio: "summarizationStartRatio",
  embedding_model: "embeddingModel",
  tiktoken_encoding: "tiktokenEncoding",
  compaction_cooldown_seconds: "compactionCooldownSeconds",
  compaction_max_runs_per_window: "compactionMaxRunsPerWindow",
  compaction_rate_window_seconds: "compactionRateWindowSeconds",
  max_inject_tokens_default: "maxInjectTokensDefault",
  openai_api_key: "openaiApiKey",
  openai_base_url: "openaiBaseUrl",
  compaction_model: "compactionModel",
};

function fieldToEnvKey(field: keyof AppSettings): string {
  const snake = field.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
  return `ICK_${snake.toUpperCase()}`;
}

function readYamlDict(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = yaml.load(readFileSync(path, "utf8"));
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

function coerceYaml(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  if (out.context_usage_threshold_percent == null && out.compaction_threshold_ratio != null) {
    const r = Number(out.compaction_threshold_ratio);
    if (!Number.isNaN(r)) out.context_usage_threshold_percent = Math.round(r * 100);
  }
  return out;
}

function yamlToPartialSettings(yamlDict: Record<string, unknown>): Partial<AppSettings> {
  const partial: Partial<AppSettings> = {};
  for (const [k, v] of Object.entries(yamlDict)) {
    const key = CAMEL_MAP[k];
    if (!key || v === undefined) continue;
    if (key === "dataDir") partial.dataDir = String(v);
    else if (key === "defaultProjectId") partial.defaultProjectId = String(v);
    else if (key === "openaiApiKey") partial.openaiApiKey = v == null || v === "" ? null : String(v);
    else if (key === "openaiBaseUrl") partial.openaiBaseUrl = String(v);
    else if (key === "embeddingModel") partial.embeddingModel = String(v);
    else if (key === "tiktokenEncoding") partial.tiktokenEncoding = String(v);
    else if (key === "compactionModel") partial.compactionModel = String(v);
    else if (typeof v === "number" && Number.isFinite(v)) {
      (partial as Record<string, number>)[key] = v;
    } else if (typeof v === "string" && /^\d+$/.test(v)) {
      const n = Number(v);
      if (Number.isFinite(n)) (partial as Record<string, number>)[key] = n;
    } else if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n) && v.trim() !== "") (partial as Record<string, number>)[key] = n;
    }
  }
  return partial;
}

function envOverrides(): Partial<AppSettings> {
  const keys = Object.keys(DEFAULTS) as (keyof AppSettings)[];
  const out: Partial<AppSettings> = {};
  for (const field of keys) {
    const ek = fieldToEnvKey(field);
    if (env[ek] === undefined) continue;
    const raw = String(env[ek]).trim();
    if (field === "openaiApiKey") {
      out.openaiApiKey = raw === "" ? null : raw;
      continue;
    }
    if (
      field === "dataDir" ||
      field === "defaultProjectId" ||
      field === "embeddingModel" ||
      field === "tiktokenEncoding" ||
      field === "openaiBaseUrl" ||
      field === "compactionModel"
    ) {
      (out as Record<string, string>)[field] = raw;
      continue;
    }
    const n = Number(raw);
    if (!Number.isNaN(n)) (out as Record<string, number>)[field] = n;
  }
  return out;
}

function resolveConfigPath(): string {
  const override = (env.ICK_SETTINGS_YAML ?? "").trim();
  if (override) return resolve(override);
  return join(PROJECT_ROOT, "config", "default.yaml");
}

export function loadSettings(): AppSettings {
  const yamlPath = resolveConfigPath();
  const yamlDict = coerceYaml(readYamlDict(yamlPath));
  const fromYaml = yamlToPartialSettings(yamlDict);
  const fromEnv = envOverrides();
  const merged: AppSettings = {
    ...DEFAULTS,
    ...fromYaml,
    ...fromEnv,
  };
  merged.dataDir = resolve(merged.dataDir);
  return merged;
}
