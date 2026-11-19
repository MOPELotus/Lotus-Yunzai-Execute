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

const executePrefix = /^(?:#?代\s*|#执行(?:\s+|$)|#execute(?:\s+|$))/iu;
const nestedExecute = /^(?:#?(?:代|执行|execute\b))/iu;
const replyPrefix = "[execute] ";
const usage = "用法：#代 @用户 #体力2，或 #执行 全员 群=本群 间隔=5 静默=关 -- #体力";

function id(value: unknown, label: string): number {
  const number = typeof value === "string" && /^\d+$/u.test(value) ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`${label}编号无效`);
  }
  return number;
}

export function matchesExecution(message: string): boolean {
  return executePrefix.test(message.trimStart());
}

export function parseExecution(message: string, context: ExecuteInput): ExecuteRequest {
  let segments = typeof context.message === "string" ? [] : context.message ?? [];
  const raw = message.trim();
  const prefix = raw.match(executePrefix)?.[0];
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
    if (!run) throw new Error("缺少 run: 后的指令");
    commandOffset = run.index + run[0].length;
    const header = body.slice(0, run.index);
    const inValue = header.match(/\bin:(here|@s|@e|\d+)(?=\s|$)/u)?.[1];
    if (inValue === "@s") group = "私聊";
    else if (inValue === "@e") group = "全部群";
    else if (inValue && inValue !== "here") group = id(inValue, "群");
    gap = Number(header.match(/\bgap:(\S+)/u)?.[1] ?? 5);
    hold = /\bhold:true\b/u.test(header);
    route = header.match(/\bas:([\s\S]*?)(?=\s(?:in|gap|hold):|$)/u)?.[1] ?? "";
  } else {
    const delimiter = /--|#/u.exec(body);
    if (delimiter) {
      commandOffset = delimiter.index + (delimiter[0] === "--" ? 2 : 0);
      route = body.slice(0, delimiter.index);
    } else if (prefix.includes("代")) {
      route = body.match(/^\d+/u)?.[0] ?? "";
      commandOffset = route.length;
    } else {
      throw new Error(usage);
    }
    const groupValue = route.match(/群=(本群|私聊|全部群|\d+)/u)?.[1];
    if (groupValue) {
      group = groupValue === "本群" || groupValue === "私聊" || groupValue === "全部群" ? groupValue : id(groupValue, "群");
    }
    gap = Number(route.match(/间隔=(\S+)/u)?.[1] ?? 5);
    hold = /静默=开/u.test(route);
    route = route.replace(/(?:群|间隔|静默)=\S+/gu, "");
  }

  const suffix = body.slice(commandOffset);
  const command = suffix.trim();
  if (!command) throw new Error(usage);
  if (nestedExecute.test(command) || context.isDelegated) throw new Error("不能嵌套代操作或执行指令");
  if (!Number.isFinite(gap) || gap < 0 || gap > 86400) throw new Error("间隔需为 0–86400 秒");

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
      else mentionedUsers.push(id(segment.qq, "用户"));
    }
  }

  const numericUsers = route.replace(/\[CQ:at[^\]]*\]/gu, "").match(/\d+/gu) ?? [];
  const users = all ? "all" : [...new Set([...mentionedUsers, ...numericUsers.map((user) => id(user, "用户"))])];
  if (users !== "all" && !users.length) throw new Error(usage);
  if (users === "all" && (group === "私聊" || (group === "本群" && context.message_type !== "group"))) {
    throw new Error("私聊执行需指定用户");
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
      if (!matchesExecution(message)) return;
      const { message_type, self_id, user_id, group_id, isMaster, canDelegate, isDelegated, delegationSignal, adapter } = input;
      if (isDelegated) return `${replyPrefix}不能嵌套代操作或执行指令`;
      if (canDelegate !== true || !delegationSignal || message_type === "terminal" || self_id === undefined || user_id === undefined) return;
      const batchSignal = AbortSignal.any([signal, lifetime.signal, delegationSignal]);
      if (batchSignal.aborted) return;
      if (!execute) return `${replyPrefix}代操作服务当前不可用`;
      if (running.has(self_id)) return `${replyPrefix}当前机器人正在执行另一批代操作`;

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
        if (!total) return `${replyPrefix}没有可执行的目标用户`;
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
        if (!batchSignal.aborted) return `${replyPrefix}无法取得执行目标`;
      } finally {
        running.delete(self_id);
      }
      const counts = `已处理 ${handled}，异常 ${failed}，未命中或被拒绝 ${rejected}`;
      if (batchSignal.aborted) {
        const remaining = total === undefined ? "" : `，未完成 ${total - handled - failed - rejected}`;
        return `执行取消：${counts}${remaining}。`;
      }
      return `执行结束：${counts}。具体业务结果以各指令回复为准。`;
    },
  };
}
