import assert from "node:assert/strict";
import { test } from "node:test";
import { runAdvise } from "../src/advise.ts";
import { defaultConfig, sanitize } from "../src/config.ts";
import { formatDiscussion, planCalls, runDiscuss } from "../src/discuss.ts";
import { buildTranscript, redact } from "../src/transcript.ts";

const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } };

const msg = (role: string, content: unknown, extra: object = {}) => ({ type: "message", message: { role, content, ...extra } });

const makeCtx = (entries: any[], reply: (system: string, user: string, modelId: string) => string | Error) => {
  const calls: { system: string; user: string; model: string }[] = [];
  const models: Record<string, any> = {
    "a/one": { provider: "a", id: "one" },
    "a/two": { provider: "a", id: "two" },
  };
  const ctx: any = {
    cwd: "C:/proj",
    hasUI: false,
    mode: "print",
    model: models["a/one"],
    scopedModels: [],
    sessionManager: { getBranch: () => entries },
    modelRegistry: {
      find: (p: string, i: string) => models[`${p}/${i}`],
      getAvailable: () => Object.values(models),
      streamSimple: (model: any, c: any) => {
        const user = c.messages[0].content as string;
        calls.push({ system: c.systemPrompt, user, model: model.id });
        const out = reply(c.systemPrompt, user, model.id);
        return {
          async *[Symbol.asyncIterator]() {
            if (!(out instanceof Error)) yield { type: "text_delta", delta: out };
          },
          async result() {
            return out instanceof Error
              ? { stopReason: "error", errorMessage: out.message, content: [], usage }
              : { stopReason: "stop", content: [{ type: "text", text: out }], usage };
          },
        };
      },
    },
  };
  return { ctx, calls };
};

const session = [
  msg("user", "fix the login bug"),
  msg("assistant", [{ type: "text", text: "I'll patch auth.ts" }, { type: "toolCall", name: "edit", arguments: { path: "auth.ts" } }]),
  msg("toolResult", [{ type: "text", text: "ok" }], { toolName: "edit" }),
];

test("redact scrubs secrets", () => {
  const t = redact("key sk-abcdefghijklmnopqrstuvwx and API_KEY=hunter2hunter2 and ghp_abcdefghijklmnopqrstuvwxyz");
  assert.ok(!t.includes("abcdefghijklmnopqrstuvwx"));
  assert.ok(!t.includes("hunter2hunter2"));
  assert.ok(t.includes("[REDACTED"));
});

test("transcript keeps first user task when trimming old history", () => {
  const many = [msg("user", "ORIGINAL TASK"), ...Array.from({ length: 200 }, (_, i) => msg("assistant", [{ type: "text", text: `step ${i} ${"x".repeat(300)}` }]))];
  const { ctx } = makeCtx(many, () => "");
  const tr = buildTranscript(ctx, 5000);
  assert.ok(tr.text.includes("ORIGINAL TASK"));
  assert.ok(tr.text.includes("step 199"));
  assert.ok(!tr.text.includes("step 0 "));
  assert.ok(tr.omitted > 0);
  assert.ok(tr.text.length < 6000);
});

test("sanitize rejects garbage and clamps", () => {
  const c = sanitize({ advise: { model: "nope", effort: "turbo" }, discuss: { rounds: 99, agents: [{ id: "analyst", enabled: false, model: "a/one" }, { id: "bogus" }] }, maxAgentCalls: -5 });
  assert.equal(c.advise.model, undefined);
  assert.equal(c.advise.effort, undefined);
  assert.equal(c.discuss.rounds, 4);
  assert.equal(c.maxAgentCalls, 0);
  assert.equal(c.discuss.agents.length, 6);
  const an = c.discuss.agents.find((a) => a.id === "analyst")!;
  assert.equal(an.enabled, false);
  assert.equal(an.model, "a/one");
});

test("advise: uses configured model, sends transcript + plan, is anti-yes-man", async () => {
  const { ctx, calls } = makeCtx(session, () => "VERDICT: NEEDS CHANGES\n## Problems\n1. unverified");
  const cfg = defaultConfig();
  cfg.advise = { model: "a/two" };
  const r = await runAdvise(ctx, cfg, { question: "is it right?", draft: "then rewrite everything" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "two");
  assert.equal(r.model, "a/two");
  assert.ok(calls[0].user.includes("fix the login bug"));
  assert.ok(calls[0].user.includes("then rewrite everything"));
  assert.ok(calls[0].user.includes("is it right?"));
  assert.match(calls[0].system, /NOT a yes-man/);
  assert.match(r.text, /NEEDS CHANGES/);
});

test("advise: follows session model when unset; empty session errors", async () => {
  const { ctx, calls } = makeCtx(session, () => "VERDICT: SOUND");
  await runAdvise(ctx, defaultConfig(), {});
  assert.equal(calls[0].model, "one");
  const empty = makeCtx([], () => "x");
  await assert.rejects(runAdvise(empty.ctx, defaultConfig(), {}), /Nothing to review/);
});

test("advise: unknown configured model fails clearly", async () => {
  const { ctx } = makeCtx(session, () => "x");
  const cfg = defaultConfig();
  cfg.advise = { model: "zzz/none" };
  await assert.rejects(runAdvise(ctx, cfg, {}), /Model not found/);
});

test("discuss: per-agent models, rounds, later agents see earlier, wrap-up runs", async () => {
  const { ctx, calls } = makeCtx(session, (sys, _u, id) => `reply from ${id}`);
  const cfg = defaultConfig();
  cfg.discuss.rounds = 2;
  cfg.discuss.agents.find((a) => a.id === "contrarian")!.model = "a/two";
  assert.equal(planCalls(cfg), 3 * 2 + 1);
  const r = await runDiscuss(ctx, cfg, { topic: "ship or wait?", includeSession: false });
  assert.equal(r.calls, 7);
  assert.equal(calls.length, 7);
  assert.equal(r.turns.length, 6);
  assert.equal(r.turns[0].who.id, "contrarian");
  assert.equal(r.turns[0].model, "a/two");
  assert.equal(r.turns[1].model, "a/one");
  assert.ok(!calls[0].user.includes("reply from"), "first speaker sees nothing");
  assert.ok(calls[1].user.includes("The Contrarian (round 1): reply from two"));
  assert.match(calls[0].system, /The Contrarian/);
  assert.ok(!calls[0].user.includes("fix the login bug"), "no session unless asked");
  assert.match(calls[6].system, /close a group discussion/);
  assert.ok(r.synthesis);
  assert.ok(r.usage && r.usage.totalTokens === 14);
  assert.match(formatDiscussion(r), /Wrap-up/);
});

test("discuss: one failing agent does not kill the run; all failing does", async () => {
  const a = makeCtx(session, (sys) => (/The Analyst/.test(sys.split("\n")[0]) ? new Error("boom") : "fine"));
  const cfg = defaultConfig();
  cfg.discuss.rounds = 1;
  const r = await runDiscuss(a.ctx, cfg, { topic: "t", includeSession: false });
  assert.equal(r.turns.filter((t) => t.error).length, 1);
  assert.ok(r.synthesis);

  const b = makeCtx(session, () => new Error("down"));
  await assert.rejects(runDiscuss(b.ctx, cfg, { topic: "t", includeSession: false }), /Every agent failed/);
});

test("discuss: --session attaches transcript; bad model fails before any call; abort stops", async () => {
  const a = makeCtx(session, () => "ok");
  const cfg = defaultConfig();
  cfg.discuss.rounds = 1;
  await runDiscuss(a.ctx, cfg, { topic: "", includeSession: true });
  assert.ok(a.calls[0].user.includes("fix the login bug"));

  const b = makeCtx(session, () => "ok");
  const bad = defaultConfig();
  bad.discuss.agents.find((x) => x.id === "analyst")!.model = "zzz/none";
  await assert.rejects(runDiscuss(b.ctx, bad, { topic: "t", includeSession: false }), /Model not found/);
  assert.equal(b.calls.length, 0);

  const c = makeCtx(session, () => "ok");
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(runDiscuss(c.ctx, cfg, { topic: "t", includeSession: false, signal: ac.signal }), /Cancelled/);
});

test("discuss: only= overrides enabled set and single agent skips wrap-up", async () => {
  const { ctx, calls } = makeCtx(session, () => "solo");
  const cfg = defaultConfig();
  cfg.discuss.rounds = 1;
  const r = await runDiscuss(ctx, cfg, { topic: "t", includeSession: false, only: ["visionary"] });
  assert.equal(r.turns.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(r.synthesis, undefined);
});

test("session rules reach advise + discuss; caveman on by default and can be turned off", async () => {
  const a = makeCtx(session, () => "VERDICT: SOUND");
  a.ctx.getSystemPrompt = () => "HOUSE RULE: minimal diff. key sk-abcdefghijklmnopqrstuvwx";
  await runAdvise(a.ctx, defaultConfig(), {});
  assert.ok(a.calls[0].user.includes("<session_rules>") && a.calls[0].user.includes("HOUSE RULE: minimal diff"));
  assert.ok(!a.calls[0].user.includes("abcdefghijklmnopqrstuvwx"), "rules redacted");
  assert.match(a.calls[0].system, /caveman/);
  assert.match(a.calls[0].system, /session_rules/);

  const off = defaultConfig();
  off.caveman = false;
  const b = makeCtx(session, () => "VERDICT: SOUND");
  await runAdvise(b.ctx, off, {});
  assert.ok(!/caveman/.test(b.calls[0].system));
  assert.ok(!b.calls[0].user.includes("<session_rules>"), "no rules when none exist");

  const c = makeCtx(session, () => "ok");
  c.ctx.getSystemPrompt = () => "HOUSE RULE: be safe";
  const cfg = defaultConfig();
  cfg.discuss.rounds = 1;
  await runDiscuss(c.ctx, cfg, { topic: "t", includeSession: true });
  assert.ok(c.calls[0].user.includes("HOUSE RULE: be safe"));
  assert.match(c.calls[0].system, /caveman/);
  assert.match(c.calls.at(-1)!.system, /caveman/);
  const d = makeCtx(session, () => "ok");
  d.ctx.getSystemPrompt = () => "HOUSE RULE: be safe";
  await runDiscuss(d.ctx, cfg, { topic: "t", includeSession: false });
  assert.ok(!d.calls[0].user.includes("HOUSE RULE"), "no session data unless asked");
});
