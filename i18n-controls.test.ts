import { expect, test } from "bun:test";
import { getLanguage, registerLanguage, setLanguage } from "../../packages/i18n/index.ts";
import { parseExecution, type ExecuteContext } from "./index.ts";

async function isolated(name: string) {
  if (Bun.env.LOTUS_I18N_CONTROL_CHILD === name) return false;
  const child = Bun.spawn([process.execPath, "test", "--test-name-pattern", name, import.meta.path], {
    env: { ...process.env, LOTUS_I18N_CONTROL_CHILD: name }, stdout: "pipe", stderr: "pipe",
  });
  const [status, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (status !== 0) throw new Error(output + errors);
  return true;
}

test("执行目的地保持协议值，不随回执语言变化", async () => {
  if (await isolated('执行目的地保持协议值，不随回执语言变化')) return;
  const previous = getLanguage();
  registerLanguage("en", { execute: {
    "index.text_0d5f4509dd": "current group", "index.text_6add2714c4": "private", "index.text_b932a43ffa": "all groups",
  } });
  const actor: ExecuteContext = { message_type: "group", self_id: 101, user_id: 201, group_id: 301, isMaster: true, canDelegate: true };
  try {
    setLanguage("en");
    expect(parseExecution("#execute as:123 in:here run:#体力", actor).group).toBe("本群");
    expect(parseExecution("#execute as:123 in:@s run:#体力", actor).group).toBe("私聊");
    expect(parseExecution("#execute as:123 in:@e run:#体力", actor).group).toBe("全部群");
  } finally { setLanguage(previous); }
});
