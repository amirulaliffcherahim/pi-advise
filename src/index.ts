import { Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Text, matchesKey } from "@earendil-works/pi-tui";
import { runAdvise } from "./advise.ts";
import { MAX_ROUNDS, loadConfig, saveConfig, updateConfig, type AdviceConfig } from "./config.ts";
import { activeAgents, formatDiscussion, planCalls, runDiscuss, type DiscussProgress } from "./discuss.ts";
import { fmtUsage } from "./llm.ts";
import { discussionWarnings } from "./discuss.ts";
import { parseSlotArgs, pickSlot, slotLabel } from "./models.ts";
import { ARCHETYPES, findArchetype } from "./personas.ts";

const MSG = "pi-advice";
const KEY = "pi-advice";

interface AdviceDetails {
  kind: "advise" | "discuss";
  title: string;
  models: string;
  usage?: string;
  text: string;
  warnings?: string[];
  /** Streaming snapshot from a tool call still running. */
  partial?: boolean;
}

/* ---------------------------------------------------------------- helpers */

const verdictOf = (text: string): "SOUND" | "NEEDS CHANGES" | "WRONG DIRECTION" | undefined => {
  const m = /^\s*VERDICT:\s*(SOUND|NEEDS CHANGES|WRONG DIRECTION)/im.exec(text);
  return m?.[1].toUpperCase() as any;
};

const notify = (ctx: ExtensionContext, msg: string, level: "info" | "warning" | "error" = "info") => {
  if (ctx.hasUI) ctx.ui.notify(msg, level);
  else console.error(`[pi-advice] ${msg}`);
};

/** Pull `--flag value` / `--flag` out of the arg string; the rest is free text. */
const takeFlags = (raw: string, valued: string[], bare: string[]) => {
  const flags: Record<string, string | true> = {};
  let rest = raw;
  for (const f of valued) {
    const re = new RegExp(`(?:^|\\s)--${f}(?:=|\\s+)(\\S+)`, "i");
    const m = re.exec(rest);
    if (m) {
      flags[f] = m[1];
      rest = rest.replace(m[0], " ");
    }
  }
  for (const f of bare) {
    const re = new RegExp(`(?:^|\\s)--${f}(?=\\s|$)`, "i");
    if (re.test(rest)) {
      flags[f] = true;
      rest = rest.replace(re, " ");
    }
  }
  return { flags, text: rest.trim() };
};

/** Esc aborts the run; progress goes to the status line and a small live widget. */
const withProgress = async <T>(
  ctx: ExtensionContext,
  label: string,
  ac: AbortController,
  run: (signal: AbortSignal, show: (heading: string, partial: string) => void) => Promise<T>,
): Promise<T> => {
  const off =
    ctx.mode === "tui"
      ? ctx.ui.onTerminalInput((data) => {
          if (matchesKey(data, "escape")) {
            ac.abort();
            return { consume: true };
          }
          return undefined;
        })
      : undefined;

  let last = 0;
  const show = (heading: string, partial: string) => {
    if (!ctx.hasUI) return;
    const now = Date.now();
    if (now - last < 120) return;
    last = now;
    const tail = partial.split("\n").filter(Boolean).slice(-4).map((l) => `  ${l.slice(0, 160)}`);
    ctx.ui.setWidget(KEY, [`◆ ${heading}  (Esc to cancel)`, ...tail]);
  };

  if (ctx.hasUI) {
    ctx.ui.setStatus(KEY, `${label}…`);
    ctx.ui.setWidget(KEY, [`◆ ${label}…  (Esc to cancel)`]);
  }
  try {
    return await run(ac.signal, show);
  } finally {
    off?.();
    if (ctx.hasUI) {
      ctx.ui.setStatus(KEY, undefined);
      ctx.ui.setWidget(KEY, undefined);
    }
  }
};

/* ------------------------------------------------------------------ main */

export default function (pi: ExtensionAPI) {
  let agentCalls = 0;
  let running: { label: string; ac: AbortController } | undefined;
  let failStreak = 0;
  let nudged = false;
  let lastVerdict: string | undefined;

  const setFooter = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(KEY, lastVerdict ? `advice: ${lastVerdict.toLowerCase()}` : undefined);
  };

  /** One run at a time: two reviews racing would double the cost and interleave the widget. */
  const claim = (label: string): AbortController => {
    if (running) throw new Error(`${running.label} is already running. Press Esc to cancel it first.`);
    const ac = new AbortController();
    running = { label, ac };
    return ac;
  };
  const release = (ac: AbortController) => {
    if (running?.ac === ac) running = undefined;
  };

  pi.on("session_start", (_e, ctx) => {
    agentCalls = 0;
    failStreak = 0;
    nudged = false;
    lastVerdict = undefined;
    setFooter(ctx);
  });

  pi.on("session_shutdown", () => {
    running?.ac.abort();
    running = undefined;
  });

  /** Cheap, no model call: after repeated tool failures, point the agent at advise once per streak. */
  pi.on("tool_result", (e) => {
    if (e.toolName === "advise" || e.toolName === "discuss") return;
    if (!e.isError) {
      failStreak = 0;
      nudged = false;
      return;
    }
    failStreak++;
    const cfg = loadConfig();
    if (!cfg.nudge || !cfg.agentTools || nudged || failStreak < 2 || agentCalls >= cfg.maxAgentCalls) return;
    if (!pi.getActiveTools().includes("advise")) return;
    nudged = true;
    return {
      content: [
        ...e.content,
        { type: "text" as const, text: "\n[pi-advice: this is the 2nd failure in a row. Stop retrying the same thing. Call the advise tool for a second opinion before the next attempt.]" },
      ],
    };
  });

  const renderAdvice = (d: AdviceDetails, expanded: boolean, theme: any) => {
    const box = new Box(1, 1, (t: string) => theme.bg("customMessageBg", t));
    if (d.partial) {
      const tail = d.text.split("\n").filter(Boolean).slice(-3).join("\n");
      box.addChild(new Text(theme.fg("accent", theme.bold(`◆ ${d.title}`)), 0, 0));
      box.addChild(new Text(theme.fg("dim", tail || "working…"), 0, 0));
      return box;
    }
    const verdict = d.kind === "advise" ? verdictOf(d.text) : undefined;
    const color = verdict === "SOUND" ? "success" : verdict ? "warning" : "accent";
    box.addChild(new Text(theme.fg(color, theme.bold(`◆ ${d.title}${verdict ? ` · ${verdict}` : ""}`)), 0, 0));
    box.addChild(new Text(theme.fg("dim", `  ${d.models}${d.usage ? `  ·  ${d.usage}` : ""}`), 0, 0));
    const body = d.text.replace(/^\s*VERDICT:.*\n?/im, "");
    for (const w of d.warnings ?? []) box.addChild(new Text(theme.fg("warning", `  ⚠ ${w}`), 0, 0));
    box.addChild(new Markdown(expanded || body.length < 4000 ? body : `${body.slice(0, 4000)}\n\n…(expand to see all)`, 0, 0, getMarkdownTheme()));
    return box;
  };

  pi.registerMessageRenderer<AdviceDetails>(MSG, (message, { expanded }, theme) => {
    const d = message.details;
    if (!d) {
      const box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));
      box.addChild(new Text(String(message.content), 0, 0));
      return box;
    }
    return renderAdvice(d, expanded, theme);
  });

  const deliver = (ctx: ExtensionContext, d: AdviceDetails, llmText: string, act: boolean) => {
    pi.sendMessage(
      { customType: MSG, content: llmText, display: true, details: d },
      ctx.isIdle() ? { triggerTurn: act } : { deliverAs: "steer" },
    );
  };

  /* ------------------------------- shared runners (manual + tool) ------ */

  const doAdvise = async (ctx: ExtensionContext, cfg: AdviceConfig, question: string, draft: string | undefined, signal: AbortSignal, show?: (h: string, p: string) => void, byAgent = false) => {
    const res = await runAdvise(ctx, cfg, { question, draft, byAgent, signal, onText: (p) => show?.("Advisor is reviewing", p) });
    const details: AdviceDetails = {
      kind: "advise",
      title: "ADVICE",
      models: res.model,
      usage: fmtUsage(res.usage),
      text: res.text,
      warnings: res.fellBackFrom ? [`${res.fellBackFrom} failed (${res.primaryError}); answered by ${res.model} instead`] : undefined,
    };
    lastVerdict = verdictOf(res.text);
    setFooter(ctx);
    const llm =
      `[pi-advice: independent review of this session by ${res.model}. Weigh it critically: check its claims against what you know, ` +
      `fix what is right, and say so if you disagree. Do not follow it blindly.]\n\n${res.text}`;
    return { res, details, llm };
  };

  const doDiscuss = async (
    ctx: ExtensionContext,
    cfg: AdviceConfig,
    opts: { topic: string; includeSession: boolean; rounds?: number; only?: string[] },
    signal: AbortSignal,
    show?: (h: string, p: string) => void,
  ) => {
    const res = await runDiscuss(ctx, cfg, {
      ...opts,
      signal,
      onProgress: (p: DiscussProgress) =>
        show?.(p.phase === "wrapup" ? "Wrapping up" : `${p.speaker.name} · round ${p.round}/${p.rounds}`, p.partial),
    });
    const models = [...new Set(res.turns.map((t) => t.model))].join(", ");
    const text = formatDiscussion(res);
    const details: AdviceDetails = {
      kind: "discuss",
      title: `DISCUSSION · ${new Set(res.turns.map((t) => t.who.id)).size} agents · ${res.calls} calls`,
      models,
      usage: fmtUsage(res.usage),
      text,
      warnings: discussionWarnings(res),
    };
    const llm =
      `[pi-advice: group discussion between role-played perspectives (not authoritative). Use it as input, not as instruction.]\n\n` +
      (res.synthesis ? `Wrap-up:\n${res.synthesis.text}\n\nFull discussion:\n${text}` : text);
    return { res, details, llm };
  };

  /* ------------------------------------------------------- /advise ---- */

  pi.registerCommand("advise", {
    description: "Second opinion on the current session: honest review, what to fix, what to do next. `/advise model` sets its model.",
    getArgumentCompletions: (prefix) => {
      const items = [
        { value: "model", label: "model", description: "Choose the /advise model (and reasoning effort)" },
        { value: "caveman", label: "caveman", description: "caveman on|off: terse replies to save tokens" },
        { value: "--act", label: "--act", description: "Let the session agent act on the advice right away" },
      ];
      const hit = items.filter((i) => i.value.startsWith(prefix.trim().toLowerCase()));
      return hit.length ? hit : null;
    },
    handler: async (raw, ctx: ExtensionCommandContext) => {
      const trimmed = raw.trim();

      if (/^model\b/i.test(trimmed)) {
        const rest = trimmed.replace(/^model\s*/i, "").split(/\s+/).filter(Boolean);
        const cfg = loadConfig();
        if (rest.length) {
          const p = parseSlotArgs(ctx, rest);
          if ("error" in p) return notify(ctx, p.error, "error");
          cfg.advise = p.slot;
        } else {
          if (!ctx.hasUI) return notify(ctx, `/advise model: ${slotLabel(cfg.advise)}`);
          const slot = await pickSlot(ctx, "/advise model", cfg.advise);
          if (!slot) return;
          cfg.advise = slot;
        }
        saveConfig(cfg);
        return notify(ctx, `/advise model → ${slotLabel(cfg.advise)}`);
      }

      if (/^caveman\b/i.test(trimmed)) {
        const v = trimmed.replace(/^caveman\s*/i, "").toLowerCase();
        const cfg = loadConfig();
        if (v === "on" || v === "off") cfg.caveman = v === "on";
        else if (v) return notify(ctx, "Use: /advise caveman on|off", "error");
        saveConfig(cfg);
        return notify(ctx, `caveman replies: ${cfg.caveman ? "on" : "off"} (applies to /advise and /discuss)`);
      }

      const { flags, text: question } = takeFlags(trimmed, [], ["act"]);
      const cfg = loadConfig();
      let ac: AbortController;
      try {
        ac = claim("/advise");
      } catch (e) {
        return notify(ctx, (e as Error).message, "warning");
      }
      try {
        const { res, details, llm } = await withProgress(ctx, "Advisor reviewing session", ac, (signal, show) =>
          doAdvise(ctx, cfg, question, undefined, signal, show),
        );
        if (!ctx.hasUI) console.log(details.text);
        deliver(ctx, details, llm, flags.act === true);
        const note = details.warnings?.length ? ` ⚠ ${details.warnings[0]}` : "";
        notify(ctx, `Advice from ${res.model} added to the session${flags.act ? "" : ". Tell the agent to apply it, or use /advise --act."}${note}`, note ? "warning" : "info");
      } catch (e) {
        notify(ctx, `/advise failed: ${(e as Error).message ?? String(e)}`, "error");
      } finally {
        release(ac);
      }
    },
  });

  /* ------------------------------------------------------ /discuss ---- */

  const pickAgents = (cfg: AdviceConfig, ids: string[]) => {
    const wanted = ids.map((s) => findArchetype(s)?.id).filter((x): x is any => !!x);
    for (const a of cfg.discuss.agents) a.enabled = wanted.includes(a.id);
    return wanted.length;
  };

  const menu = async (ctx: ExtensionCommandContext) => {
    for (;;) {
      const cfg = loadConfig();
      const rows = cfg.discuss.agents.map((s) => {
        const a = ARCHETYPES.find((x) => x.id === s.id)!;
        return { s, a, label: `${s.enabled ? "[x]" : "[ ]"} ${a.name} — ${slotLabel(s)}` };
      });
      const wrapLabel = `Wrap-up: ${cfg.discuss.wrapUp ? "on" : "off"} — ${slotLabel(cfg.discuss.synth)}`;
      const roundsLabel = `Rounds: ${cfg.discuss.rounds} (max ${MAX_ROUNDS})`;
      const done = "Done";
      const choice = await ctx.ui.select("/discuss setup — pick an agent to edit", [...rows.map((r) => r.label), wrapLabel, roundsLabel, done]);
      if (choice === undefined || choice === done) return;

      const row = rows.find((r) => r.label === choice);
      if (row) {
        const act = await ctx.ui.select(row.a.name, [row.s.enabled ? "Turn off" : "Turn on", "Set model", "Back"]);
        if (act === "Turn on" || act === "Turn off") {
          updateConfig((c) => {
            const t = c.discuss.agents.find((x) => x.id === row.s.id)!;
            t.enabled = act === "Turn on";
          });
        } else if (act === "Set model") {
          const slot = await pickSlot(ctx, row.a.name, row.s);
          if (slot) updateConfig((c) => Object.assign(c.discuss.agents.find((x) => x.id === row.s.id)!, { model: undefined, effort: undefined }, slot));
        }
      } else if (choice === wrapLabel) {
        const act = await ctx.ui.select("Wrap-up", [cfg.discuss.wrapUp ? "Turn off" : "Turn on", "Set model", "Back"]);
        if (act === "Turn on" || act === "Turn off") updateConfig((c) => void (c.discuss.wrapUp = act === "Turn on"));
        else if (act === "Set model") {
          const slot = await pickSlot(ctx, "Wrap-up model", cfg.discuss.synth);
          if (slot) updateConfig((c) => void (c.discuss.synth = slot));
        }
      } else if (choice === roundsLabel) {
        const v = await ctx.ui.select("Rounds", Array.from({ length: MAX_ROUNDS }, (_, i) => String(i + 1)));
        if (v) updateConfig((c) => void (c.discuss.rounds = Number(v)));
      }
    }
  };

  const showConfig = (ctx: ExtensionContext, cfg: AdviceConfig) => {
    const lines = cfg.discuss.agents.map((s) => `${s.enabled ? "[x]" : "[ ]"} ${s.id.padEnd(10)} ${slotLabel(s)}`);
    notify(ctx, `${lines.join("\n")}\nwrap-up ${cfg.discuss.wrapUp ? "on" : "off"}: ${slotLabel(cfg.discuss.synth)} · rounds ${cfg.discuss.rounds}`);
  };

  pi.registerCommand("discuss", {
    description: "Group discussion between up to 6 archetype agents (Contrarian, Confidant, Analyst, Visionary, Pragmatist, Explorer). `/discuss model` sets their models.",
    getArgumentCompletions: (prefix) => {
      const items = [
        { value: "model", label: "model", description: "Set agent models, on/off, wrap-up and rounds" },
        { value: "agents", label: "agents", description: "Pick which agents speak: /discuss agents contrarian,analyst" },
        { value: "--session", label: "--session", description: "Give the agents the current session as background" },
        { value: "--with", label: "--with", description: "Use only these agents for this run: --with contrarian,pragmatist" },
        { value: "--rounds", label: "--rounds", description: `Rounds for this run (1-${MAX_ROUNDS})` },
        { value: "--act", label: "--act", description: "Let the session agent act on the outcome right away" },
      ];
      const hit = items.filter((i) => i.value.startsWith(prefix.trim().toLowerCase()));
      return hit.length ? hit : null;
    },
    handler: async (raw, ctx: ExtensionCommandContext) => {
      const trimmed = raw.trim();

      if (/^model\b/i.test(trimmed)) {
        const rest = trimmed.replace(/^model\s*/i, "").split(/\s+/).filter(Boolean);
        if (!rest.length) {
          if (!ctx.hasUI) return showConfig(ctx, loadConfig());
          return menu(ctx);
        }
        // /discuss model <archetype|all|wrapup> <provider/id|session> [effort]
        const [target, ...tail] = rest;
        const p = parseSlotArgs(ctx, tail);
        if ("error" in p) return notify(ctx, p.error, "error");
        const cfg = loadConfig();
        const t = target.toLowerCase();
        if (t === "all") {
          for (const a of cfg.discuss.agents) Object.assign(a, { model: undefined, effort: undefined }, p.slot);
        } else if (t === "wrapup" || t === "synth") {
          cfg.discuss.synth = p.slot;
        } else {
          const a = findArchetype(target);
          if (!a) return notify(ctx, `Unknown agent "${target}". Use: ${ARCHETYPES.map((x) => x.id).join(", ")}, all, wrapup.`, "error");
          Object.assign(cfg.discuss.agents.find((x) => x.id === a.id)!, { model: undefined, effort: undefined }, p.slot);
        }
        saveConfig(cfg);
        return showConfig(ctx, cfg);
      }

      if (/^agents\b/i.test(trimmed)) {
        const ids = trimmed.replace(/^agents\s*/i, "").split(/[\s,]+/).filter(Boolean);
        const cfg = loadConfig();
        if (!ids.length) return showConfig(ctx, cfg);
        if (pickAgents(cfg, ids) === 0) return notify(ctx, `No known agent in "${ids.join(" ")}".`, "error");
        saveConfig(cfg);
        return showConfig(ctx, cfg);
      }

      if (/^rounds\b/i.test(trimmed)) {
        const n = Number(trimmed.replace(/^rounds\s*/i, ""));
        if (!Number.isInteger(n) || n < 1 || n > MAX_ROUNDS) return notify(ctx, `Rounds must be 1-${MAX_ROUNDS}.`, "error");
        updateConfig((c) => void (c.discuss.rounds = n));
        return notify(ctx, `Discussion rounds → ${n}`);
      }

      const { flags, text: topic } = takeFlags(trimmed, ["with", "rounds"], ["session", "act"]);
      const only = typeof flags.with === "string" ? flags.with.split(",").map((s) => findArchetype(s)?.id).filter((x): x is any => !!x) : undefined;
      if (typeof flags.with === "string" && !only?.length) return notify(ctx, `--with: no known agent in "${flags.with}".`, "error");
      const rounds = typeof flags.rounds === "string" ? Number(flags.rounds) : undefined;
      if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS)) return notify(ctx, `--rounds must be 1-${MAX_ROUNDS}.`, "error");

      const cfg = loadConfig();
      const includeSession = flags.session === true || !topic;
      const n = activeAgents(cfg, only).length;
      if (n === 0) return notify(ctx, "No agents enabled. Run /discuss model.", "error");

      if (ctx.hasUI) {
        const calls = planCalls(cfg, only, rounds);
        if (calls > 12 && !(await ctx.ui.confirm("Large discussion", `${n} agents will make ${calls} model calls. Continue?`))) return;
      }

      let ac: AbortController;
      try {
        ac = claim("/discuss");
      } catch (e) {
        return notify(ctx, (e as Error).message, "warning");
      }
      try {
        const { res, details, llm } = await withProgress(ctx, "Discussion running", ac, (signal, show) =>
          doDiscuss(ctx, cfg, { topic, includeSession, rounds, only }, signal, show),
        );
        if (!ctx.hasUI) console.log(details.text);
        deliver(ctx, details, llm, flags.act === true);
        const w = details.warnings ?? [];
        notify(ctx, `Discussion done (${res.calls} calls).${w.length ? ` ⚠ ${w.join("; ")}` : ""}`, w.length ? "warning" : "info");
      } catch (e) {
        notify(ctx, `/discuss failed: ${(e as Error).message ?? String(e)}`, "error");
      } finally {
        release(ac);
      }
    },
  });

  /* ------------------------------------- tools: Pi triggers them too --- */

  const gate = (cfg: AdviceConfig, name: string) => {
    if (!cfg.agentTools) throw new Error(`${name} is disabled for the agent (agentTools=false in pi-advice.json). Ask the user to run /${name} themselves.`);
    if (agentCalls >= cfg.maxAgentCalls) throw new Error(`Agent-initiated advice limit reached (${cfg.maxAgentCalls}). The user can still run /${name}.`);
    agentCalls++;
  };

  pi.registerTool(
    defineTool({
      name: "advise",
      label: "Advise",
      description:
        "Get an independent second opinion on the current session from another model. It reads the whole session transcript and says whether the approach is right, what is wrong, and what to do next. It does not agree by default. Use before committing to a risky plan, after repeated failures, or before declaring work done.",
      promptSnippet: "advise: independent second-opinion review of the current session (another model, critical, not a yes-man)",
      promptGuidelines: [
        "Call advise before a risky or irreversible step, after two failed attempts at the same thing, and before claiming a non-trivial task is finished. Pass your intended plan in `plan` if you have not acted on it yet.",
        "Treat advise output as input to weigh, not an order: verify its claims, fix what is right, and tell the user if you disagree.",
      ],
      parameters: Type.Object({
        question: Type.Optional(Type.String({ description: "Specific thing to check, if any." })),
        plan: Type.Optional(Type.String({ description: "Your intended next steps, not yet in the transcript." })),
      }),
      renderShell: "self",
      renderCall: (args, theme) => new Text(theme.fg("accent", theme.bold("◆ advise")) + theme.fg("dim", args.question ? `  ${String(args.question).slice(0, 90)}` : ""), 0, 0),
      renderResult: (result, { expanded }, theme) =>
        result.details ? renderAdvice(result.details as AdviceDetails, expanded, theme) : new Text(theme.fg("dim", "…"), 0, 0),
      async execute(_id, params, signal, onUpdate, ctx) {
        const cfg = loadConfig();
        const ac = claim("advise");
        const off = signal ? (() => { const f = () => ac.abort(); signal.addEventListener("abort", f, { once: true }); return () => signal.removeEventListener("abort", f); })() : undefined;
        try {
          gate(cfg, "advise");
          const { res, details, llm } = await doAdvise(ctx, cfg, params.question ?? "", params.plan, ac.signal, (h, p) =>
            onUpdate?.({ content: [{ type: "text", text: h }], details: { kind: "advise", title: h, models: "", text: p, partial: true } satisfies AdviceDetails }),
            true);
          return { content: [{ type: "text", text: llm }], details, usage: res.usage };
        } finally {
          off?.();
          release(ac);
        }
      },
    }),
  );

  pi.registerTool(
    defineTool({
      name: "discuss",
      label: "Discuss",
      description:
        "Run a group discussion between role-played perspectives (Contrarian, Confidant, Analyst, Visionary, Pragmatist, Explorer) on a topic, each possibly on a different model, then get a wrap-up. Use for open-ended decisions where several viewpoints help. It costs several model calls.",
      promptSnippet: "discuss: multi-perspective group discussion on a topic (several model calls)",
      promptGuidelines: ["Use discuss only for genuinely open decisions; prefer advise for reviewing your own work."],
      parameters: Type.Object({
        topic: Type.String({ description: "What to discuss." }),
        includeSession: Type.Optional(Type.Boolean({ description: "Give the group the current session as background." })),
        agents: Type.Optional(Type.Array(Type.String(), { description: "Subset of: contrarian, confidant, analyst, visionary, pragmatist, explorer." })),
        rounds: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_ROUNDS })),
      }),
      renderShell: "self",
      renderCall: (args, theme) => new Text(theme.fg("accent", theme.bold("◆ discuss")) + theme.fg("dim", `  ${String(args.topic ?? "").slice(0, 90)}`), 0, 0),
      renderResult: (result, { expanded }, theme) =>
        result.details ? renderAdvice(result.details as AdviceDetails, expanded, theme) : new Text(theme.fg("dim", "…"), 0, 0),
      async execute(_id, params, signal, onUpdate, ctx) {
        const cfg = loadConfig();
        const ac = claim("discuss");
        const off = signal ? (() => { const f = () => ac.abort(); signal.addEventListener("abort", f, { once: true }); return () => signal.removeEventListener("abort", f); })() : undefined;
        try {
          gate(cfg, "discuss");
          const only = params.agents?.map((s) => findArchetype(s)?.id).filter((x): x is any => !!x);
          const { res, details, llm } = await doDiscuss(
            ctx,
            cfg,
            { topic: params.topic, includeSession: params.includeSession ?? false, rounds: params.rounds, only: only?.length ? only : undefined },
            ac.signal,
            (h, p) => onUpdate?.({ content: [{ type: "text", text: h }], details: { kind: "discuss", title: h, models: "", text: p, partial: true } satisfies AdviceDetails }),
          );
          return { content: [{ type: "text", text: llm }], details, usage: res.usage };
        } finally {
          off?.();
          release(ac);
        }
      },
    }),
  );
}
