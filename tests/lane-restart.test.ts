import { DEFAULT_ROOT } from "./fixtures";
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRef, type Frame } from "../src/model";
import { read, write } from "../src/db";
const rootRef = pageRef(DEFAULT_ROOT)!;
const kids = [
  "3517a3bc4544f58228a37c46ffef2be6",
  "ed3cbbfd82fd2b3775306a9b9b071ef9",
].map((id, index) => ({
  id,
  url: `https://app.notion.com/p/example-space/${id}`,
  title: `个人周报${index + 1}`,
}));
let listener: any;
const tabs = new Map<number, any>();
let counter = 100;
const navigations: Array<{ id: number; url: string }> = [];
const created: number[] = [];
const session: Record<string, unknown> = { ownershipToken: "lane-session" };
const event = { addListener: () => {} };
const chromeMock = {
  runtime: {
    id: "test",
    getURL: (p: string) => `chrome-extension://test/${p}`,
    onInstalled: event,
    onStartup: event,
    onMessage: { addListener: (fn: any) => (listener = fn) },
  },
  action: { onClicked: event },
  notifications: { onClicked: event, create: async () => {} },
  permissions: { contains: async () => true },
  storage: {
    session: {
      get: async () => session,
      set: async (v: any) => Object.assign(session, v),
    },
    local: {
      get: async () => ({
        settings: {
          root: DEFAULT_ROOT,
          interval: 60,
          enabled: false,
          notify: false,
        },
      }),
    },
  },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: event },
  tabs: {
    create: async (o: any) => {
      const t = { id: ++counter, url: o.url, active: false, menuOpen: false };
      tabs.set(t.id, t);
      created.push(t.id);
      return t;
    },
    get: async (id: number) => {
      if (!tabs.has(id)) throw Error(`No tab with id ${id}`);
      return tabs.get(id);
    },
    update: async (id: number, o: any) => {
      navigations.push({ id, url: o.url });
      return Object.assign(tabs.get(id), o, { menuOpen: false });
    },
    remove: async (id: number) => {
      tabs.delete(id);
    },
  },
  scripting: {
    executeScript: async (o: any) => {
      const tab = tabs.get(o.target.tabId);
      if (!tab) throw Error("tab missing");
      const id = pageRef(tab.url)!.id,
        action = o.args[0];
      const frame: Frame = {
        id,
        title:
          id === rootRef.id
            ? "周报数据库"
            : kids.find((k) => k.id === id)?.title || "页面",
        ready: true,
        children: id === rootRef.id ? kids : [],
        warnings: [],
        bottom: true,
        position: 0,
        height: 400,
        observed: Date.now(),
      };
      if (action === "prepare-metadata") tab.menuOpen = true;
      if (action === "metadata" && tab.menuOpen) {
        frame.author = "甲";
        frame.rawTime = "今天 14:02";
      }
      if (action === "metadata" && !tab.menuOpen)
        frame.error = "未找到最近编辑信息";
      return [{ result: frame }];
    },
  },
};
Object.assign(globalThis, { chrome: chromeMock });
await import("../src/worker");
const message = (type: string) =>
  new Promise<any>((resolve) =>
    listener(
      { type },
      { id: "test", url: "chrome-extension://test/dashboard.html" },
      resolve,
    ),
  );
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const startWhenIdle = async () => {
  for (let i = 0; i < 80; i++) {
    const result = await message("start");
    if (!result.error) return;
    if (!String(result.error).includes("收尾")) throw Error(result.error);
    await delay(50);
  }
  throw Error("调度未能启动");
};
const finish = async () => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const run = await read<any>("state", "run");
    if (run?.status === "done") {
      await delay(100);
      return run;
    }
    if (run?.status === "paused")
      throw Error(`意外暂停：${run.errors?.join("；")}`);
    await delay(20);
  }
  throw Error("扫描没有结束");
};
const recoveredRun = (
  tabId: number,
  sessionToken: string,
  concurrency?: number,
) => ({
  id: "run",
  runId: "recovered",
  status: "running",
  queue: [{ ...rootRef, title: "周报数据库", depth: 0, tries: 0 }],
  seen: [rootRef.id],
  done: 0,
  failed: 0,
  initial: true,
  concurrency,
  lanes: [
    { runId: "recovered", tabId, ownedPageId: rootRef.id, current: rootRef.id },
  ],
  startedAt: Date.now(),
  heartbeat: 0,
  errors: [],
  limited: false,
  sessionToken,
});
test("浏览器会话变化时不复用旧标签；同一会话的后台重启继续用原标签", async () => {
  // 1) A new browser session owns no tab: the old tab is preserved, never navigated.
  tabs.set(7, { id: 7, url: rootRef.url, active: false, menuOpen: false });
  await write("state", recoveredRun(7, "old-browser-session"));
  await startWhenIdle();
  const first = await finish();
  assert.equal(first.done, 3);
  assert.equal(first.failed, 0);
  assert.equal(
    navigations.filter((item) => item.id === 7).length,
    0,
    "不得接管上一个浏览器会话的标签页",
  );
  assert.ok(tabs.has(7), "不属于本会话的旧标签应保留，不擅自关闭");
  assert.equal(tabs.size, 1);
  // 2) Same session: the persisted lane keeps its tab instead of opening a new one.
  const createdBefore = created.length;
  tabs.set(9, { id: 9, url: rootRef.url, active: false, menuOpen: false });
  await write("state", recoveredRun(9, session.ownershipToken as string, 1));
  await startWhenIdle();
  const second = await finish();
  assert.equal(second.done, 3);
  assert.equal(created.length, createdBefore, "同一会话应复用原标签，不再新建");
  assert.ok(
    navigations.some((item) => item.id === 9),
    "应继续使用原标签导航",
  );
  assert.ok(!tabs.has(9), "本轮结束后关闭自己复用的标签页");
});
test("持久化的空洞并行槽位在收尾时被忽略", async () => {
  // A worker can be terminated between lane writes; slot 1 may exist while slot 0
  // does not. Completion must release only real lanes, not crash on the hole.
  const lanes: any[] = [];
  lanes[1] = {
    runId: "hole",
    tabId: 11,
    ownedPageId: rootRef.id,
    current: rootRef.id,
  };
  tabs.set(11, { id: 11, url: rootRef.url, active: false, menuOpen: false });
  await write("state", {
    id: "run",
    runId: "hole",
    status: "running",
    queue: [],
    seen: [rootRef.id],
    done: 0,
    failed: 0,
    initial: true,
    lanes,
    startedAt: Date.now(),
    heartbeat: 0,
    errors: [],
    limited: false,
    sessionToken: session.ownershipToken,
  });
  await startWhenIdle();
  const run = await finish();
  assert.equal(run.status, "done");
  assert.ok(!tabs.has(11), "残留的自有标签在收尾时关闭");
});
