import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const SECRET_PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g, "[REDACTED KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "[REDACTED TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS KEY]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[REDACTED JWT]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, "Bearer [REDACTED]"],
  [
    /\b([A-Za-z0-9_]*(?:api[_-]?key|secret|token|passw(?:or)?d|credential)[A-Za-z0-9_]*)(\s*[:=]\s*)["']?[^\s"',;]{6,}/gi,
    "$1$2[REDACTED]",
  ],
];

/** The transcript leaves the machine for another model: scrub obvious secrets first. */
export const redact = (text: string): string => SECRET_PATTERNS.reduce((t, [re, rep]) => t.replace(re, rep), text);

const clip = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  return `${text.slice(0, head)}\n[... ${text.length - max} chars cut ...]\n${text.slice(-tail)}`;
};

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: any) => (p?.type === "text" && typeof p.text === "string" ? p.text : p?.type === "image" ? "[image]" : ""))
    .filter(Boolean)
    .join("\n");
};

const fmtEntry = (entry: any): string | undefined => {
  switch (entry?.type) {
    case "compaction":
      return typeof entry.summary === "string" ? `[EARLIER WORK, COMPACTED]\n${clip(entry.summary, 6000)}` : undefined;
    case "custom_message": {
      const body = textOf(entry.content);
      return body ? `[NOTE ${entry.customType}]\n${clip(body, 2500)}` : undefined;
    }
    case "message":
      break;
    default:
      return undefined;
  }

  const m = entry.message;
  switch (m?.role) {
    case "user": {
      const t = textOf(m.content);
      return t ? `USER:\n${clip(t, 6000)}` : undefined;
    }
    case "assistant": {
      const parts: string[] = [];
      const t = textOf(m.content);
      if (t) parts.push(clip(t, 4000));
      for (const p of Array.isArray(m.content) ? m.content : []) {
        if (p?.type === "toolCall") {
          parts.push(`[tool call: ${p.name}(${clip(JSON.stringify(p.arguments ?? {}), 600)})]`);
        }
      }
      return parts.length ? `AGENT:\n${parts.join("\n")}` : undefined;
    }
    case "toolResult": {
      const t = textOf(m.content);
      return `[tool result: ${m.toolName ?? "?"} ${m.isError ? "ERROR" : "ok"}]\n${clip(t, 1800)}`;
    }
    case "bashExecution":
      return `[user ran shell: ${clip(String(m.command ?? ""), 400)}]\n${clip(String(m.output ?? ""), 1500)}`;
    default:
      return undefined;
  }
};

export interface Transcript {
  text: string;
  entries: number;
  omitted: number;
}

const entriesOf = (ctx: ExtensionContext): any[] => {
  const sm = ctx.sessionManager;
  try {
    return (sm.buildContextEntries?.() ?? sm.getBranch()) as any[];
  } catch {
    return sm.getBranch() as any[];
  }
};

/**
 * Newest-first fit into maxChars. The first user message (the original task) is
 * always kept, because without it nothing else can be judged.
 */
export const buildTranscript = (ctx: ExtensionContext, maxChars: number): Transcript => {
  const formatted = entriesOf(ctx)
    .map(fmtEntry)
    .filter((s): s is string => !!s);

  const firstUser = formatted.findIndex((s) => s.startsWith("USER:"));
  const anchor = firstUser >= 0 ? formatted[firstUser] : undefined;
  const budget = maxChars - (anchor?.length ?? 0) - 200;

  const picked: string[] = [];
  let used = 0;
  for (let i = formatted.length - 1; i >= 0; i--) {
    if (i === firstUser) continue;
    const len = formatted[i].length + 2;
    if (used + len > budget && picked.length > 0) break;
    picked.push(formatted[i]);
    used += len;
  }
  picked.reverse();

  const kept = picked.length + (anchor ? 1 : 0);
  const omitted = Math.max(0, formatted.length - kept);
  const body = [
    ...(anchor ? [anchor] : []),
    ...(omitted > 0 ? [`[... ${omitted} older entries omitted ...]`] : []),
    ...picked,
  ].join("\n\n");

  const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
  const head = `Working directory: ${ctx.cwd}\nSession agent model: ${model}\n\n`;
  return { text: redact(head + body), entries: formatted.length, omitted };
};

/** The live session's system prompt (Pi rules, house rules). Redacted and bounded. */
export const sessionRules = (ctx: ExtensionContext, maxChars: number): string => {
  let sp = "";
  try {
    sp = ctx.getSystemPrompt?.() ?? "";
  } catch {
    return "";
  }
  return sp ? redact(clip(sp, maxChars)) : "";
};
