import { DEFAULT_ROOT } from "./fixtures";
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRef, type Frame, type Page } from "../src/model";
import { read, all, write } from "../src/db";
const root = pageRef(DEFAULT_ROOT)!;
const child = {
  id: "5e4e33127b3d0b180c44beca586fc30b",
  url: "https://app.notion.com/p/5e4e33127b3d0b180c44beca586fc30b",
  title: "个人页",
};
let listener: any,
  nextTab = 1,
  nextWindow = 10,
  focusOnRead = false,
  addUserTab = false;
const tabs = new Map<number, any>(),
  windows = new Map<number, any>();
const creations: any[] = [];
const removed: number[] = [];
const event = { addListener: () => {} };
const delay = (n: number) => new Promise((r) => setTimeout(r, n));
const chromeMock = {
  runtime: {
    id: "window-test",
    getURL: (p: string) => `chrome-extension://window-test/${p}`,
    onInstalled: event,
    onStartup: event,
    onMessage: { addListener: (fn: any) => (listener = fn) },
  },
  action: { onClicked: event },
  notifications: { onClicked: event },
  permissions: { contains: async () => true },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: event },
  storage: {
    session: {
      get: async () => ({ ownershipToken: "window-session" }),
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
          windowMode: true,
        },
      }),
    },
  },
  windows: {
    create: async (options: any) => {
      creations.push(options);
      const id = nextWindow++,
        tab = {
          id: nextTab++,
          windowId: id,
          url: options.url,
          active: true,
          menuOpen: false,
        };
      tabs.set(tab.id, tab);
      const win = { id, focused: false, state: "normal", tabs: [tab] };
      windows.set(id, win);
      return win;
    },
    get: async (id: number) => {
      if (!windows.has(id)) throw Error("No window");
      return windows.get(id);
    },
  },
  tabs: {
    create: async () => {
      throw Error("窗口模式不应另开普通后台标签");
    },
    get: async (id: number) => {
      if (!tabs.has(id)) throw Error("No tab");
      return tabs.get(id);
    },
    update: async (id: number, options: any) =>
      Object.assign(tabs.get(id), options, { menuOpen: false }),
    remove: async (id: number) => {
      const tab = tabs.get(id);
      removed.push(id);
      tabs.delete(id);
      if (![...tabs.values()].some((t) => t.windowId === tab.windowId))
        windows.delete(tab.windowId);
    },
  },
  scripting: {
    executeScript: async (options: any) => {
      const tab = tabs.get(options.target.tabId),
        id = pageRef(tab.url)!.id,
        action = options.args[0];
      const f: Frame = {
        id,
        documentId: id,
        title: id === root.id ? "周报数据库" : child.title,
        ready: true,
        children: id === root.id ? [child] : [],
        warnings: [],
        bottom: true,
        position: 0,
        height: 300,
        observed: Date.now(),
      };
      if (action === "prepare-metadata") {
        tab.menuOpen = true;
        if (focusOnRead) windows.get(tab.windowId).focused = true;
      }
      if (action === "metadata" && tab.menuOpen) {
        f.author = "甲";
        f.rawTime = "今天 14:02";
        if (addUserTab && !tabs.has(999))
          tabs.set(999, {
            id: 999,
            windowId: tab.windowId,
            url: "https://example.com/user-work",
            active: false,
          });
      }
      return [{ result: f }];
    },
  },
};
Object.assign(globalThis, { chrome: chromeMock });
await import("../src/worker");
const message = (type: string) =>
  new Promise<any>((resolve) =>
    listener(
      { type },
      {
        id: "window-test",
        url: "chrome-extension://window-test/dashboard.html",
      },
      resolve,
    ),
  );
async function run(expected = "done", type = "start") {
  const result = await message(type);
  assert.ok(!result.error, result.error);
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    const state = await read<any>("state", "run");
    if (state && state.status !== "running") {
      assert.equal(state.status, expected);
      await delay(80);
      return state;
    }
    await delay(20);
  }
  throw Error("窗口检查未结束");
}
test("独立窗口：不抢焦点、强制单路、正常结束关闭自有页面", async () => {
  const state = await run();
  assert.equal(state.windowMode, true);
  assert.equal(state.concurrency, 1);
  assert.equal(state.done, 2);
  assert.equal(state.failed, 0);
  assert.equal(creations.length, 1);
  assert.equal(creations[0].focused, false);
  assert.equal(tabs.size, 0);
  assert.equal(windows.size, 0);
  assert.equal((await all<Page>("pages")).length, 2);
  assert.ok(state.metrics.fullScans >= 2);
  assert.equal(state.metrics.cacheHits, 0);
});
test("用户在检查窗口添加页面时，收尾只关闭扩展自己的标签", async () => {
  addUserTab = true;
  await run();
  assert.ok(tabs.has(999));
  assert.ok(windows.has(tabs.get(999).windowId));
  assert.ok(!removed.includes(999));
  addUserTab = false;
});
test("用户切到检查窗口时暂停，保留该窗口和原有成功记录", async () => {
  focusOnRead = true;
  const before = new Map(
    (await all<Page>("pages")).map((p) => [p.id, p.lastSuccessfulAt]),
  );
  const state = await run("paused");
  assert.equal(state.done, 0);
  assert.ok([...windows.values()].some((w) => w.focused));
  for (const page of await all<Page>("pages"))
    assert.equal(page.lastSuccessfulAt, before.get(page.id));
});

test("仅重试上一轮最终失败页，不重新遍历全部子页", async () => {
  focusOnRead = false;
  const previous = await read<any>("state", "run");
  const page = await read<Page>("pages", root.id);
  await write("state", {
    ...previous,
    status: "done",
    seen: [root.id, child.id],
  });
  await write("pages", {
    ...page!,
    error: "菜单暂缺",
    lastAttemptAt: Date.now(),
  });
  const childBefore = (await read<Page>("pages", child.id))?.lastAttemptAt;
  const state = await run("done", "retry");
  assert.equal(state.retryOnly, true);
  assert.equal(state.done, 1);
  assert.equal(state.failed, 0);
  assert.equal(state.queue.length, 0);
  assert.equal(
    (await read<Page>("pages", child.id))?.lastAttemptAt,
    childBefore,
    "重试入口时不得顺带重读已成功子页",
  );
});
