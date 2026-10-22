import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ARCHETYPES, type ArchetypeId } from "./personas.ts";

export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** model "" / undefined = follow the current session model. */
export interface ModelSlot {
  model?: string;
  effort?: Effort;
}

export interface AgentSlot extends ModelSlot {
  id: ArchetypeId;
  enabled: boolean;
}

export interface AdviceConfig {
  advise: ModelSlot;
  discuss: {
    rounds: number;
    wrapUp: boolean;
    synth: ModelSlot;
    agents: AgentSlot[];
  };
  /** Let the session agent call the advise/discuss tools on its own. */
  /** Terse caveman replies from advisor/discussion models to save tokens. */
  caveman: boolean;
  /** If the chosen model fails, retry once on the session model instead of giving up. */
  fallback: boolean;
  /** Per model call, retries included only per attempt. */
  timeoutSec: number;
  /** Tell the agent to consider `advise` after repeated tool failures (costs no model call). */
  nudge: boolean;
  agentTools: boolean;
  /** Max agent-initiated calls per Pi process (manual commands are never limited). */
  maxAgentCalls: number;
  maxContextChars: number;
}

export const MAX_ROUNDS = 4;
const DEFAULT_ENABLED: ArchetypeId[] = ["contrarian", "analyst", "pragmatist"];

export const defaultConfig = (): AdviceConfig => ({
  advise: {},
  discuss: {
    rounds: 2,
    wrapUp: true,
    synth: {},
    agents: ARCHETYPES.map((a) => ({ id: a.id, enabled: DEFAULT_ENABLED.includes(a.id) })),
  },
  caveman: true,
  fallback: true,
  timeoutSec: 180,
  nudge: true,
  agentTools: true,
  maxAgentCalls: 10,
  maxContextChars: 120_000,
});

// Same rule Pi uses for its own config dir; avoids a runtime import so tests need no Pi packages.
const agentDir = (): string => process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");

export const configPath = (): string => join(agentDir(), "pi-advice.json");

const isEffort = (v: unknown): v is Effort => typeof v === "string" && (EFFORTS as readonly string[]).includes(v);

const slot = (raw: unknown): ModelSlot => {
  const r = (raw ?? {}) as Record<string, unknown>;
  const out: ModelSlot = {};
  if (typeof r.model === "string" && r.model.includes("/")) out.model = r.model;
  if (isEffort(r.effort)) out.effort = r.effort;
  return out;
};

const int = (v: unknown, min: number, max: number, fallback: number): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : fallback;

/** Never trust the file: every field is validated and falls back to its default. */
export const sanitize = (raw: unknown): AdviceConfig => {
  const d = defaultConfig();
  const r = (raw ?? {}) as Record<string, any>;
  const discuss = (r.discuss ?? {}) as Record<string, any>;
  const savedAgents: unknown[] = Array.isArray(discuss.agents) ? discuss.agents : [];

  const agents: AgentSlot[] = d.discuss.agents.map((def) => {
    const saved = savedAgents.find((a) => (a as any)?.id === def.id) as Record<string, unknown> | undefined;
    return saved
      ? { id: def.id, enabled: typeof saved.enabled === "boolean" ? saved.enabled : def.enabled, ...slot(saved) }
      : def;
  });

  return {
    advise: slot(r.advise),
    discuss: {
      rounds: int(discuss.rounds, 1, MAX_ROUNDS, d.discuss.rounds),
      wrapUp: typeof discuss.wrapUp === "boolean" ? discuss.wrapUp : d.discuss.wrapUp,
      synth: slot(discuss.synth),
      agents,
    },
    caveman: typeof r.caveman === "boolean" ? r.caveman : d.caveman,
    fallback: typeof r.fallback === "boolean" ? r.fallback : d.fallback,
    timeoutSec: int(r.timeoutSec, 10, 900, d.timeoutSec),
    nudge: typeof r.nudge === "boolean" ? r.nudge : d.nudge,
    agentTools: typeof r.agentTools === "boolean" ? r.agentTools : d.agentTools,
    maxAgentCalls: int(r.maxAgentCalls, 0, 1000, d.maxAgentCalls),
    maxContextChars: int(r.maxContextChars, 4_000, 1_000_000, d.maxContextChars),
  };
};

export const loadConfig = (): AdviceConfig => {
  const file = configPath();
  if (!existsSync(file)) return defaultConfig();
  try {
    return sanitize(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return defaultConfig();
  }
};

export const saveConfig = (cfg: AdviceConfig): void => {
  const file = configPath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
};

export const updateConfig = (mutate: (cfg: AdviceConfig) => void): AdviceConfig => {
  const cfg = loadConfig();
  mutate(cfg);
  saveConfig(cfg);
  return cfg;
};
