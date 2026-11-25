import { createTranslator as createTextTranslator } from "../../packages/i18n/index.ts";
import messageCatalog from "./i18n/zh-CN.json";
const $t = createTextTranslator("execute", messageCatalog.messages);
import { setTimeout as delay } from "node:timers/promises";

export interface ExecuteSegment {
  readonly type: string;
  readonly [key: string]: unknown;
}

export interface ExecuteContext {
  readonly message_type: "group" | "private" | "terminal";
  readonly self_id?: number;
  readonly user_id?: number;
  readonly group_id?: number;
  readonly isMaster: boolean;
  readonly canDelegate?: boolean;
  readonly isDelegated?: boolean;
  readonly delegationSignal?: AbortSignal;
  readonly adapter?: "milky";
}

export interface ExecuteRequest {
  readonly users: readonly number[] | "all";
  readonly group: "本群" | "私聊" | "全部群" | number;
  readonly gap: number;
  readonly hold: boolean;
  readonly command: string;
  readonly segments: readonly ExecuteSegment[];
}

export interface ExecuteTarget {
  readonly userId: number;
  readonly groupId?: number;
}

export interface ExecuteService {
  readonly resolveTargets: (context: ExecuteContext, request: ExecuteRequest, signal: AbortSignal) => Promise<readonly ExecuteTarget[]>;
  readonly dispatch: (context: ExecuteContext, target: ExecuteTarget, request: ExecuteRequest, signal: AbortSignal) => Promise<"handled" | "rejected">;
}

type ExecuteInput = ExecuteContext & { readonly message?: string | readonly ExecuteSegment[] };

// A compact delegate command may start with a QQ number or a structured mention before the inner command.
const delegatePrefix = /^#?代(?:操作)?(?=$|\s|[\d@#]|全员|群=|间隔=|静默=|\[CQ:at|--)\s*/iu;
const compactDelegate = /^#?代(?:操作)?$/u;
const batchPrefix = /^#(?:执行|execute)(?:\s+|$)/iu;
// Preserve the batch target guard, including its unprefixed forms.
const nestedBatch = /^#?(?:执行|execute\b)/iu;
const replyPrefix = "[execute] ";
const usage = $t("index.text_1409f2047b");

function id(value: unknown, label: string): number {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error($t("index.text_71057f5bc1", { "label": label }));
  }
  return number;
}

function mentionSeparatedPrefix(message: string, context: ExecuteInput): string | undefined {
  if (!context.message || typeof context.message === "string") return;
  let beforeMention = "";
  for (const segment of context.message) {
    if (segment.type === "text") beforeMention += String(segment.text ?? "");
    if (segment.type === "at" && String(segment.qq) !== String(context.self_id)) {
      const prefix = beforeMention.trimStart();
      if (compactDelegate.test(prefix) && message.startsWith(prefix)) return prefix;
      return;
    }
  }
}

export function matchesExecution(message: string, context?: ExecuteInput): boolean {
  const input = message.trimStart();
  return delegatePrefix.test(input) || batchPrefix.test(input) || Boolean(context && mentionSeparatedPrefix(input, context));
}

export function isNestedExecution(message: string): boolean {
  const input = message.trimStart();
  return delegatePrefix.test(input) || nestedBatch.test(input);
}

export function parseExecution(message: string, context: ExecuteInput): ExecuteRequest {
  let segments = typeof context.message === "string" ? [] : context.message ?? [];
  const raw = message.trim();
  const mentionedPrefix = mentionSeparatedPrefix(raw, context);
  const prefix = mentionedPrefix ?? (delegatePrefix.exec(raw) ?? batchPrefix.exec(raw))?.[0];
  if (!prefix) throw new Error(usage);

  const body = raw.slice(prefix.length);
  // The host may normalize or remove bot aliases at the start of the text.
  const plain = segments.filter(({ type }) => type === "text").map(({ text }) => String(text ?? "")).join("").trimEnd();
  if (!plain.endsWith(body)) segments = [];
  const bodyStart = plain.length - body.length;
  let commandOffset: number;
  let route: string;
  let group: ExecuteRequest["group"] = "本群";
  let gap: number;
  let hold: boolean;
  if (prefix.toLowerCase().startsWith("#execute")) {
    const run = /\brun:\s*/u.exec(body);
    if (!run) throw new Error($t("index.text_8349c8d54d"));
    commandOffset = run.index + run[0].length;
    const header = body.slice(0, run.index);
    const inValue = header.match(/\bin:(here|@s|@e|\d+)(?=\s|$)/u)?.[1];
    if (inValue === "@s") group = "私聊";
    else if (inValue === "@e") group = "全部群";
    else if (inValue && inValue !== "here") group = id(inValue, $t("index.text_0df737cb62"));
    gap = Number(header.match(/\bgap:(\S+)/u)?.[1] ?? 5);
    hold = /\bhold:true\b/u.test(header);
    route = header.match(/\bas:([\s\S]*?)(?=\s(?:in|gap|hold):|$)/u)?.[1] ?? "";
  } else {
    const delimiter = /--|#/u.exec(body);
    if (delimiter) {
      commandOffset = delimiter.index + (delimiter[0] === "--" ? 2 : 0);
      route = body.slice(0, delimiter.index);
    } else if (prefix.includes("代")) {
      route = mentionedPrefix ? "" : body.match(/^\d+/u)?.[0] ?? "";
      commandOffset = route.length;
    } else {
      throw new Error(usage);
    }
    const groupValue = route.match(/群=(本群|私聊|全部群|\d+)/u)?.[1];
    if (groupValue) {
      group = groupValue === "本群" || groupValue === "私聊" || groupValue === "全部群" ? groupValue : id(groupValue, $t("index.text_0df737cb62"));
    }
    gap = Number(route.match(/间隔=(\S+)/u)?.[1] ?? 5);
    hold = /静默=开/u.test(route);
    route = route.replace(/(?:群|间隔|静默)=\S+/gu, "");
  }

  const suffix = body.slice(commandOffset);
  const command = suffix.trim();
  if (!command) throw new Error(usage);
  if (isNestedExecution(command) || context.isDelegated) throw new Error($t("index.text_e4f37ba636"));
  if (!Number.isFinite(gap) || gap < 0 || gap > 86400) throw new Error($t("index.text_0a94387f71"));

  const start = bodyStart + commandOffset + suffix.length - suffix.trimStart().length;
  const end = start + command.length;
  const mentionedUsers: number[] = [];
  const commandSegments: ExecuteSegment[] = [];
  let all = /全员|@a\b/u.test(route);
  let offset = 0;
  for (const segment of segments) {
    if (segment.type === "text") {
      const text = String(segment.text ?? "");
      const part = text.slice(Math.max(0, start - offset), Math.max(0, end - offset));
      if (part) commandSegments.push({ type: "text", text: part });
      offset += text.length;
    } else if (offset > start) {
      // Message references are scoped to the originating conversation.
      if (segment.type !== "reply") commandSegments.push({ ...segment });
    } else if (segment.type === "at" && String(segment.qq) !== String(context.self_id)) {
      if (segment.qq === "all") all = true;
      else mentionedUsers.push(id(segment.qq, $t("index.text_0d0e1a86b3")));
    }
  }

  const numericUsers = route.replace(/\[CQ:at[^\]]*\]/gu, "").match(/\d+/gu) ?? [];
  const users = all ? "all" : [...new Set([...mentionedUsers, ...numericUsers.map((user) => id(user, $t("index.text_0d0e1a86b3")))])];
  if (users !== "all" && !users.length) throw new Error(usage);
  if (users === "all" && (group === "私聊" || (group === "本群" && context.message_type !== "group"))) {
    throw new Error($t("index.text_a642e9785f"));
  }
  return { users, group, gap, hold, command, segments: commandSegments.length ? commandSegments : [{ type: "text", text: command }] };
}

export function createModule({ execute, signal }: { readonly execute?: ExecuteService; readonly signal: AbortSignal }) {
  const lifetime = new AbortController();
  const running = new Set<number>();

  return {
    commands: {},
    dispose() { lifetime.abort(); },
    async fallback(message: string, input: ExecuteInput): Promise<string | undefined> {
      if (!matchesExecution(message, input)) return;
      const { message_type, self_id, user_id, group_id, isMaster, canDelegate, isDelegated, delegationSignal, adapter } = input;
      if (isDelegated) return $t("index.text_de5eb96335", { "replyPrefix": replyPrefix });
      if (canDelegate !== true || !delegationSignal || message_type === "terminal" || self_id === undefined || user_id === undefined) return;
      const batchSignal = AbortSignal.any([signal, lifetime.signal, delegationSignal]);
      if (batchSignal.aborted) return;
      if (!execute) return $t("index.text_05016dff41", { "replyPrefix": replyPrefix });
      if (running.has(self_id)) return $t("index.text_634928d0ab", { "replyPrefix": replyPrefix });

      let request: ExecuteRequest;
      try {
        request = parseExecution(message, input);
      } catch (error) {
        return `${replyPrefix}${error instanceof Error ? error.message : usage}`;
      }
      const context: ExecuteContext = { message_type, self_id, user_id, group_id, isMaster, canDelegate, delegationSignal, adapter };
      running.add(self_id);
      let handled = 0;
      let failed = 0;
      let rejected = 0;
      let total: number | undefined;
      try {
        const targets = (await execute.resolveTargets(context, request, batchSignal)).filter((target) => target.userId !== self_id);
        total = targets.length;
        batchSignal.throwIfAborted();
        if (!total) return $t("index.text_0f2aec89d2", { "replyPrefix": replyPrefix });
        for (const [index, target] of targets.entries()) {
          if (index && request.gap > 0) await delay(request.gap * 1_000, undefined, { signal: batchSignal });
          batchSignal.throwIfAborted();
          try {
            const result = await execute.dispatch(context, target, request, batchSignal);
            if (result === "handled") handled++;
            else rejected++;
          } catch {
            if (batchSignal.aborted) break;
            failed++;
          }
        }
      } catch {
        if (!batchSignal.aborted) return $t("index.text_193b929295", { "replyPrefix": replyPrefix });
      } finally {
        running.delete(self_id);
      }
      const counts = $t("index.text_d324041f6b", { "handled": handled, "failed": failed, "rejected": rejected });
      if (batchSignal.aborted) {
        const remaining = total === undefined ? "" : $t("index.text_1141b3d19f", { "value1": total - handled - failed - rejected });
        return $t("index.text_0e6847a456", { "counts": counts, "remaining": remaining });
      }
      return $t("index.text_20dfb3d609", { "counts": counts });
    },
  };
}
