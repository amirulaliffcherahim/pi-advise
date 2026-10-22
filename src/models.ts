import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { EFFORTS, type Effort, type ModelSlot } from "./config.ts";
import { refOf } from "./llm.ts";

export const FOLLOW = "(follow session model)";
const DEFAULT_EFFORT = "(model default)";

const candidateRefs = (ctx: ExtensionContext): string[] => {
  const scoped = ctx.scopedModels.map((s) => refOf(s.model));
  const pool = scoped.length ? scoped : ctx.modelRegistry.getAvailable().map(refOf);
  return [...new Set(pool)].sort();
};

export const slotLabel = (s: ModelSlot): string =>
  `${s.model ?? "session model"}${s.effort ? ` · ${s.effort}` : ""}`;

export const parseEffort = (v: string | undefined): Effort | undefined | "invalid" => {
  if (!v) return undefined;
  const e = v.toLowerCase();
  return (EFFORTS as readonly string[]).includes(e) ? (e as Effort) : "invalid";
};

/** Interactive model + effort picker. Returns undefined when the user cancels. */
export const pickSlot = async (
  ctx: ExtensionContext,
  title: string,
  current: ModelSlot,
): Promise<ModelSlot | undefined> => {
  let refs = candidateRefs(ctx);
  if (current.model && !refs.includes(current.model)) refs = [current.model, ...refs];

  if (refs.length > 40) {
    const q = (await ctx.ui.input(`${title}: filter ${refs.length} models`, "e.g. opus, flash, gemini"))?.trim().toLowerCase();
    if (q === undefined) return undefined;
    if (q) refs = refs.filter((r) => r.toLowerCase().includes(q));
    if (!refs.length) {
      ctx.ui.notify(`No model matches "${q}".`, "warning");
      return undefined;
    }
  }

  const choice = await ctx.ui.select(`${title}  (now: ${slotLabel(current)})`, [FOLLOW, ...refs]);
  if (choice === undefined) return undefined;

  const effortChoice = await ctx.ui.select(`${title}: reasoning effort`, [DEFAULT_EFFORT, ...EFFORTS]);
  if (effortChoice === undefined) return undefined;

  const slot: ModelSlot = {};
  if (choice !== FOLLOW) slot.model = choice;
  if (effortChoice !== DEFAULT_EFFORT) slot.effort = effortChoice as Effort;
  return slot;
};

/** Parse "<provider/id | session> [effort]" from CLI-style args. */
export const parseSlotArgs = (
  ctx: ExtensionContext,
  words: string[],
): { slot: ModelSlot } | { error: string } => {
  const [ref, eff] = words;
  if (!ref) return { error: "Missing model. Use provider/id or `session`." };
  const slot: ModelSlot = {};

  if (!["session", "follow"].includes(ref.toLowerCase())) {
    if (!ref.includes("/")) return { error: `"${ref}" is not provider/id.` };
    const i = ref.indexOf("/");
    if (!ctx.modelRegistry.find(ref.slice(0, i), ref.slice(i + 1))) return { error: `Unknown model: ${ref}` };
    slot.model = ref;
  }
  const e = parseEffort(eff);
  if (e === "invalid") return { error: `Effort must be one of: ${EFFORTS.join(", ")}` };
  if (e) slot.effort = e;
  return { slot };
};
