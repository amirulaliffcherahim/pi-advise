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
}

export const ask = async (ctx: ExtensionContext, o: AskOptions): Promise<AskResult> => {
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
