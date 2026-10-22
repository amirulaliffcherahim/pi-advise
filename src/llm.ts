import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Effort, ModelSlot } from "./config.ts";

export const splitRef = (ref: string): [string, string] => {
  const i = ref.indexOf("/");
  return i < 0 ? ["", ref] : [ref.slice(0, i), ref.slice(i + 1)];
};

export const refOf = (m: { provider: string; id: string }): string => `${m.provider}/${m.id}`;

/** slot.model unset => follow the live session model. */
export const resolveSlot = (ctx: ExtensionContext, slot: ModelSlot): { model: Model<Api>; ref: string } => {
  if (!slot.model) {
    if (!ctx.model) throw new Error("No session model is active and no advisor model is configured.");
    return { model: ctx.model, ref: refOf(ctx.model) };
  }
  const [provider, id] = splitRef(slot.model);
  const model = ctx.modelRegistry.find(provider, id);
  if (!model) throw new Error(`Model not found: ${slot.model}. Pick another with the model subcommand.`);
  return { model, ref: slot.model };
};

const toReasoning = (e: Effort | undefined) => (e === undefined || e === "off" ? undefined : e);

export interface AskResult {
  text: string;
  usage?: Usage;
}

export interface AskOptions {
  model: Model<Api>;
  effort?: Effort;
  system: string;
  user: string;
  signal?: AbortSignal;
  onText?: (soFar: string) => void;
  /** Per attempt. Default 180s. */
  timeoutMs?: number;
  /** Extra attempts on transient errors only. Default 2. */
  retries?: number;
  retryDelayMs?: number;
}

const TRANSIENT = /\b(429|500|502|503|504|529)\b|rate.?limit|overload|temporar|unavailable|timed? ?out|timeout|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket|network|capacity/i;
export const isTransient = (message: string): boolean => TRANSIENT.test(message);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

/** One attempt, bounded by a timeout. User cancel and timeout are told apart. */
const askOnce = async (ctx: ExtensionContext, o: AskOptions): Promise<AskResult> => {
  const timeoutMs = o.timeoutMs ?? 180_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout;
  try {
    return await streamOnce(ctx, { ...o, signal });
  } catch (e) {
    if (o.signal?.aborted) throw new Error("Cancelled.");
    if (timeout.aborted) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s.`);
    throw e;
  }
};

export const ask = async (ctx: ExtensionContext, o: AskOptions): Promise<AskResult> => {
  const retries = o.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await askOnce(ctx, o);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (o.signal?.aborted || attempt >= retries || !isTransient(msg)) throw e;
      await sleep((o.retryDelayMs ?? 800) * 2 ** attempt, o.signal);
      if (o.signal?.aborted) throw new Error("Cancelled.");
    }
  }
};

export interface ResilientOptions extends Omit<AskOptions, "model" | "effort"> {
  effort?: Effort;
}
export interface ResilientResult extends AskResult {
  ref: string;
  /** Set when the chosen model failed and the session model answered instead. */
  fellBackFrom?: string;
  primaryError?: string;
}

/** Ask the chosen model; on a hard failure, fall back once to the session model. Never falls back after a cancel. */
export const askResilient = async (
  ctx: ExtensionContext,
  cfg: { fallback: boolean; timeoutSec: number },
  primary: { model: Model<Api>; ref: string },
  o: ResilientOptions,
): Promise<ResilientResult> => {
  const base = { timeoutMs: cfg.timeoutSec * 1000, ...o };
  try {
    return { ...(await ask(ctx, { ...base, model: primary.model })), ref: primary.ref };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const session = ctx.model;
    if (o.signal?.aborted || !cfg.fallback || !session || refOf(session) === primary.ref) throw e;
    const res = await ask(ctx, { ...base, model: session, effort: undefined });
    return { ...res, ref: refOf(session), fellBackFrom: primary.ref, primaryError: msg };
  }
};

const streamOnce = async (ctx: ExtensionContext, o: AskOptions): Promise<AskResult> => {
  const stream = ctx.modelRegistry.streamSimple(
    o.model,
    { systemPrompt: o.system, messages: [{ role: "user", content: o.user, timestamp: Date.now() }] },
    { reasoning: toReasoning(o.effort), signal: o.signal },
  );

  let text = "";
  for await (const ev of stream) {
    if (ev.type === "text_delta") {
      text += ev.delta;
      o.onText?.(text);
    }
  }
  const res = await stream.result();

  if (o.signal?.aborted) throw new Error("Cancelled.");
  if (res.stopReason === "error" || res.stopReason === "aborted") {
    throw new Error(res.errorMessage ?? `Model stream ended with ${res.stopReason}.`);
  }

  const final = res.content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
  const out = final || text.trim();
  if (!out) throw new Error("Model returned no text.");
  return { text: out, usage: res.usage };
};

export const sumUsage = (list: (Usage | undefined)[]): Usage | undefined => {
  const items = list.filter((u): u is Usage => !!u);
  if (!items.length) return undefined;
  const z: Usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  for (const u of items) {
    z.input += u.input;
    z.output += u.output;
    z.cacheRead += u.cacheRead;
    z.cacheWrite += u.cacheWrite;
    z.totalTokens += u.totalTokens;
    z.cost.input += u.cost.input;
    z.cost.output += u.cost.output;
    z.cost.cacheRead += u.cost.cacheRead;
    z.cost.cacheWrite += u.cost.cacheWrite;
    z.cost.total += u.cost.total;
  }
  return z;
};

export const fmtUsage = (u?: Usage): string =>
  u ? `${u.totalTokens.toLocaleString("en-US")} tok · $${u.cost.total.toFixed(4)}` : "";
