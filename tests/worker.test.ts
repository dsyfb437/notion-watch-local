import { DEFAULT_ROOT } from "./fixtures";
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRef, type Frame, type Page, type Update } from "../src/model";
import { read, all } from "../src/db";
test("调度端到端：导航过渡等待、首次基线静默、子页单独更新、无变化去重、读取失败保留旧结果", async () => {
  const root = pageRef(DEFAULT_ROOT)!;
  const childId = "3b836e314814ef0c3e2a7c3683bc25bf";
  const child = {
    id: childId,
    url: `https://app.notion.com/p/example-space/${childId}`,
    title: "第十二周",
  };
  let changed = false,
    fail = false,
    staleOnce = true,
    dropOnce = true,
    menuDelayOnce = true;
  let listener: any;
  let calls = 0;
  let tabCounter = 0;
  const tabs = new Map<number, any>();
  const event = { addListener: () => {} };
  const session: Record<string, unknown> = {};
  const chromeMock = {
    runtime: {
      id: "test-extension",
      getURL: (p: string) => `chrome-extension://test-extension/${p}`,
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
        set: async (value: Record<string, unknown>) =>
          Object.assign(session, value),
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
        const t = {
          id: ++tabCounter,
          url: o.url,
          active: false,
          menuOpen: false,
        };
        tabs.set(t.id, t);
        return t;
      },
      get: async (id: number) => {
        const t = tabs.get(id);
        if (!t) throw Error("tab missing");
        return t;
      },
      update: async (id: number, o: any) =>
        Object.assign(tabs.get(id), o, { menuOpen: false }),
      remove: async (id: number) => {
        tabs.delete(id);
      },
    },
    scripting: {
      executeScript: async (o: any) => {
        calls++;
        const tab = tabs.get(o.target.tabId);
        const id = pageRef(tab.url)!.id;
        if (
          (o.args[0] === "inspect" || o.args[0] === "inspect-step") &&
          dropOnce
        ) {
          dropOnce = false;
          return [];
        }
        const delayed =
          (o.args[0] === "open-menu" || o.args[0] === "prepare-metadata") &&
          menuDelayOnce;
        if (delayed) menuDelayOnce = false;
        else if (o.args[0] === "open-menu" || o.args[0] === "prepare-metadata")
          tab.menuOpen = true;
        const frame: Frame = {
          id,
          title: id === root.id ? "周报数据库" : child.title,
          ready: true,
          children: id === root.id ? [child] : [],
          warnings: [],
          bottom: true,
          position: 0,
          height: 500,
          observed: new Date(2026, 10, 16, 15).getTime(),
        };
        if (delayed) frame.error = "无法唯一定位页面操作菜单（匹配 0 个）";
        if (o.args[0] === "metadata") {
          frame.author = id === childId && changed ? "乙" : "甲";
          frame.rawTime =
            id === childId && changed ? "今天 14:03" : "今天 14:02";
          if (!tab.menuOpen || (fail && id === childId)) {
            frame.author = undefined;
            frame.error = "字段缺失";
          }
        }
        if (
          (o.args[0] === "inspect" || o.args[0] === "inspect-step") &&
          id === childId &&
          staleOnce
        ) {
          staleOnce = false;
          frame.id = root.id;
          frame.ready = false;
        }
        return [{ result: frame }];
      },
    },
  };
  Object.assign(globalThis, { chrome: chromeMock });
  await import("../src/worker");
  const message = (type: string, extra: Record<string, unknown> = {}) =>
    new Promise<any>((resolve) =>
      listener(
        { type, ...extra },
        {
          id: "test-extension",
          url: "chrome-extension://test-extension/dashboard.html",
        },
        resolve,
      ),
    );
  async function run(singlePage = false) {
    const started = await message("start", { singlePage });
    assert.ok(!started.error, started.error);
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      const r = await read<any>("state", "run");
      if (r?.status !== "running") {
        assert.equal(r?.status, "done");
        await new Promise((r) => setTimeout(r, 30));
        return r;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error("调度未结束");
  }
  const single = await run(true);
  assert.equal(single.done, 1);
  assert.equal(
    await read("state", "baseline"),
    undefined,
    "单页检查不把全量基线标为完成",
  );
  assert.equal(await read("pages", childId), undefined);
  const first = await run();
  assert.equal(first.done, 2);
  assert.equal((await all("updates")).length, 0);
  assert.equal((await read<Page>("pages", childId))?.author, "甲");
  changed = true;
  await run();
  assert.equal((await all<Update>("updates")).length, 1);
  assert.equal((await read<Page>("pages", childId))?.author, "乙");
  await run();
  assert.equal((await all("updates")).length, 1);
  const success = (await read<Page>("pages", childId))?.lastSuccessfulAt;
  fail = true;
  const failed = await run();
  assert.equal(failed.failed, 1);
  assert.equal((await read<Page>("pages", childId))?.lastSuccessfulAt, success);
  assert.equal((await read<Page>("pages", childId))?.author, "乙");
  assert.equal((await all("updates")).length, 1);
  assert.ok(calls > 10);
});
