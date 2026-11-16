import { DEFAULT_ROOT } from "./fixtures";
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRef, type Frame, type Page } from "../src/model";
import { read, all } from "../src/db";
const rootRef = pageRef(DEFAULT_ROOT)!;
const kids = [
  "1988651f14e00fbedc64638c95cd5cd7",
  "e4efa5e135044172f5075cc5814482e7",
  "2646932e629d9f85ba0f80b41ba00c7c",
  "e80890332bb8fdffd74eff51b378d5e5",
  "f26503e1e6f6eeefca61c7fb0734ba44",
  "2e579acb0c9b90db418b6373b3fa3b5c",
  "a3153dbbb5b677454f9f3a0a976ee6c3",
].map((id, index) => ({
  id,
  url: `https://app.notion.com/p/example-space/${id}`,
  title: `个人周报${index + 1}`,
}));
let listener: any;
const tabs = new Map<number, any>();
let counter = 100;
const activeTabs = new Set<number>();
let maxParallel = 0;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
      get: async () => ({ ownershipToken: "parallel-session" }),
      set: async () => {},
    },
    local: {
      get: async () => ({
        settings: {
          root: DEFAULT_ROOT,
          interval: 60,
          enabled: false,
          notify: false,
          concurrency: 6,
        },
      }),
    },
  },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: event },
  tabs: {
    // Real Chrome does not resolve concurrent tab creations in order. Lane 0 is
    // delayed, so higher lanes are persisted first and slot 0 stays a hole.
    create: async (o: any) => {
      const t = { id: ++counter, url: o.url, active: false, menuOpen: false };
      tabs.set(t.id, t);
      await delay(o.url === kids[0].url ? 80 : 10);
      return t;
    },
    get: async (id: number) => {
      if (!tabs.has(id)) throw Error(`No tab with id ${id}`);
      return tabs.get(id);
    },
    update: async (id: number, o: any) =>
      Object.assign(tabs.get(id), o, { menuOpen: false }),
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
      activeTabs.add(tab.id);
      maxParallel = Math.max(maxParallel, activeTabs.size);
      try {
        // A small delay per DOM round trip lets lanes overlap like real pages.
        await delay(35);
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
          frame.author = `甲${id.slice(-1)}`;
          frame.rawTime = "今天 14:02";
        }
        if (action === "metadata" && !tab.menuOpen)
          frame.error = "未找到最近编辑信息";
        return [{ result: frame }];
      } finally {
        activeTabs.delete(tab.id);
      }
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
const waitFor = async (check: () => Promise<boolean>, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw Error("等待超时");
};
test("并行调度：六页同时读取、每页只提交一次、结束后关闭自有标签", async () => {
  assert.ok(!(await message("start")).error);
  await waitFor(
    async () => (await read<any>("state", "run"))?.status === "done",
  );
  const run = await read<any>("state", "run");
  assert.equal(run.concurrency, 6);
  assert.equal(run.done, 8);
  assert.equal(run.failed, 0);
  assert.equal(run.queue.length, 0);
  assert.ok(
    maxParallel >= 6,
    `应有六个标签页同时读取，实际最多 ${maxParallel}`,
  );
  const pages = await all<Page>("pages");
  assert.equal(pages.length, 8);
  assert.equal(new Set(pages.map((p) => p.id)).size, 8, "同一页面不得重复提交");
  assert.equal((await all("updates")).length, 0, "首次基线保持静默");
  for (const kid of kids)
    assert.equal(
      (await read<Page>("pages", kid.id))?.author,
      `甲${kid.id.slice(-1)}`,
    );
  assert.equal(tabs.size, 0, "本轮结束后关闭自己创建的标签页");
});
test("并行中停止：晚到的页面结果不写入、不复活任务", async () => {
  maxParallel = 0;
  const started = await message("start");
  assert.ok(!started.error);
  await waitFor(async () => activeTabs.size >= 2, 8000);
  assert.ok(activeTabs.size >= 2, "停止前应至少有两页在读取");
  assert.ok(!(await message("stop")).error);
  const snapshot = await read<any>("state", "run");
  assert.equal(snapshot.status, "stopped");
  const before = new Map(
    (await all<Page>("pages")).map((page) => [page.id, page.lastAttemptAt]),
  );
  await delay(1600);
  const after = await read<any>("state", "run");
  assert.equal(after.status, "stopped", "晚到的检查点不得把状态改回运行");
  assert.equal(after.done, snapshot.done, "晚到结果不得增加成功页数");
  assert.equal(
    after.queue.length,
    snapshot.queue.length,
    "晚到结果不得改动队列",
  );
  const pages = await all<Page>("pages");
  assert.equal(pages.length, before.size, "晚到结果不得新增页面");
  for (const page of pages)
    assert.equal(
      page.lastAttemptAt,
      before.get(page.id),
      "晚到结果不得覆盖页面基线",
    );
});
