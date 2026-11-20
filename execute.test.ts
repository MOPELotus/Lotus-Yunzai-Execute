import { expect, test } from "bun:test";
import { createModule, matchesExecution, parseExecution, type ExecuteContext, type ExecuteService } from "./index.ts";

const actor = {
  message_type: "group",
  self_id: 101,
  user_id: 201,
  group_id: 301,
  isMaster: false,
  canDelegate: true,
  delegationSignal: new AbortController().signal,
} satisfies ExecuteContext;

test("retains the documented Chinese and post-command forms", () => {
  expect(parseExecution("#代 123456789 #体力2", actor)).toEqual({
    users: [123456789], group: "本群", gap: 5, hold: false, command: "#体力2",
    segments: [{ type: "text", text: "#体力2" }],
  });
  expect(parseExecution("代123456789体力2", actor)).toMatchObject({
    users: [123456789], command: "体力2",
  });
  expect(parseExecution("#执行 123456789,987654321 群=12345678 间隔=0.5 静默=关 -- #体力2 --profile 2", actor)).toMatchObject({
    users: [123456789, 987654321], group: 12345678, gap: 0.5, hold: false, command: "#体力2 --profile 2",
  });
  expect(parseExecution("#执行 全员 群=全部群 间隔=5 静默=开 -- #体力", actor)).toMatchObject({
    users: "all", group: "全部群", gap: 5, hold: true, command: "#体力",
  });
  expect(parseExecution("#执行 123456789 群=私聊 -- #体力", actor)).toMatchObject({ group: "私聊" });
  expect(parseExecution("#执行 全员 #体力", actor)).toMatchObject({ users: "all", group: "本群" });
  expect(() => parseExecution("#执行 全员 群=私聊 -- #体力", actor)).toThrow("私聊执行需指定用户");
  expect(() => parseExecution("#执行 204 间隔=-1 -- #体力", actor)).toThrow("间隔需为 0–86400 秒");
  expect(matchesExecution("#执行计划")).toBe(false);
  expect(matchesExecution("#代理文件")).toBe(false);
  expect(matchesExecution("代理人图鉴")).toBe(false);
  expect(matchesExecution("#代")).toBe(true);
  expect(matchesExecution("#代123456789体力2")).toBe(true);
  expect(matchesExecution("#代@用户 #体力2")).toBe(true);
  expect(matchesExecution("#代#体力2")).toBe(true);
  expect(parseExecution("#代操作123456789 #体力2", actor)).toMatchObject({ users: [123456789], command: "#体力2" });
  expect(parseExecution("#代全员#体力2", actor)).toMatchObject({ users: "all", command: "#体力2" });
});

test("retains legacy options and case-insensitive entry", () => {
  expect(parseExecution("#execute in:here as:123456789 gap:5 hold:false run:#体力2", actor)).toMatchObject({
    users: [123456789], group: "本群", gap: 5, hold: false, command: "#体力2",
  });
  expect(parseExecution("#EXECUTE as:@a in:@e gap:0 hold:true run:#体力2", actor)).toMatchObject({
    users: "all", group: "全部群", gap: 0, hold: true, command: "#体力2",
  });
  expect(parseExecution("#execute in:@s as:203 run:#体力2", actor)).toMatchObject({ users: [203], group: "私聊" });
  expect(() => parseExecution("#execute in:here as:203", actor)).toThrow("缺少 run: 后的指令");
});

test("uses only routing mentions to select recipients and preserves argument segments in order", () => {
  const message = [
    { type: "at", qq: 101 },
    { type: "text", text: "  #执行 " },
    { type: "at", qq: "203" },
    { type: "text", text: ",203 群=本群 -- #命令 -- " },
    { type: "at", qq: 204 },
    { type: "text", text: "  参数" },
    { type: "face", id: 5 },
    { type: "reply", id: 99 },
  ];
  expect(parseExecution("#执行 ,203 群=本群 -- #命令 --   参数", { ...actor, message })).toMatchObject({
    users: [203], command: "#命令 --   参数",
    segments: [
      { type: "text", text: "#命令 -- " },
      { type: "at", qq: 204 },
      { type: "text", text: "  参数" },
      { type: "face", id: 5 },
    ],
  });
  expect(parseExecution("#执行  #体力", { ...actor, message: [
    { type: "text", text: "#执行 " }, { type: "at", qq: "all" }, { type: "text", text: " #体力" },
  ] })).toMatchObject({ users: "all" });
});

test("preserves mention routing when the host normalizes the command prefix", () => {
  const message = [
    { type: "text", text: "云崽 ＃ 执行 " },
    { type: "at", qq: 203 },
    { type: "text", text: " -- #测试 " },
    { type: "at", qq: 204 },
  ];
  expect(parseExecution("#执行  -- #测试", { ...actor, message })).toMatchObject({
    users: [203], segments: [{ type: "text", text: "#测试" }, { type: "at", qq: 204 }],
  });
});

test("requires host authorization and live chat identity, and rejects nested execute", async () => {
  let calls = 0;
  const execute: ExecuteService = {
    async resolveTargets() { calls++; return []; },
    async dispatch() { throw new Error("unexpected dispatch"); },
  };
  const module = createModule({ execute, signal: new AbortController().signal });
  for (const input of [
    { ...actor, canDelegate: false, isMaster: true },
    { ...actor, delegationSignal: undefined },
    { ...actor, message_type: "terminal" as const },
    { ...actor, self_id: undefined },
  ]) {
    expect(await module.fallback("#代 203 #体力", input)).toBeUndefined();
  }
  expect(await module.fallback("#代 203 #体力", { ...actor, isDelegated: true })).toBe("[execute] 不能嵌套代操作或执行指令");
  expect(await module.fallback("#代 203 #EXECUTE as:204 run:#体力", actor)).toBe("[execute] 不能嵌套代操作或执行指令");
  expect(calls).toBe(0);
});

test("runs sequentially, skips the bot and counts handled, rejected and failed separately", async () => {
  const dispatched: number[] = [];
  const service: ExecuteService = {
    async resolveTargets(context, request) {
      expect(context).toEqual({ ...actor, adapter: undefined });
      expect(request.hold).toBe(true);
      return [101, 202, 203, 204].map((userId) => ({ userId, groupId: 301 }));
    },
    async dispatch(_context, target) {
      dispatched.push(target.userId);
      if (target.userId === 203) throw new Error("private failure internals");
      return target.userId === 202 ? "handled" : "rejected";
    },
  };
  const module = createModule({ execute: service, signal: new AbortController().signal });
  expect(await module.fallback("#执行 全员 间隔=0 静默=开 -- #体力", actor)).toBe(
    "执行结束：已处理 1，异常 1，未命中或被拒绝 1。具体业务结果以各指令回复为准。",
  );
  expect(dispatched).toEqual([202, 203, 204]);
});

test("limits overlapping batches and stops waiting when the connection closes", async () => {
  const owner = new AbortController();
  const first = Promise.withResolvers<void>();
  let calls = 0;
  const execute: ExecuteService = {
    async resolveTargets() { return [{ userId: 202 }, { userId: 203 }]; },
    async dispatch() { calls++; first.resolve(); return "handled"; },
  };
  const module = createModule({ execute, signal: new AbortController().signal });
  const input = { ...actor, delegationSignal: owner.signal };
  const job = module.fallback("#执行 202,203 间隔=86400 -- #体力", input);
  await first.promise;
  expect(await module.fallback("#代 204 #体力", input)).toBe("[execute] 当前机器人正在执行另一批代操作");
  owner.abort();
  expect(await job).toBe("执行取消：已处理 1，异常 0，未命中或被拒绝 0，未完成 1。");
  expect(calls).toBe(1);
  module.dispose();
  expect(await module.fallback("#代 204 #体力", actor)).toBeUndefined();
});
