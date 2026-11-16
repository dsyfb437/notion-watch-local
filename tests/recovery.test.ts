import { DEFAULT_ROOT } from "./fixtures";
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRef, type Frame, type Page } from "../src/model";
import { read, write } from "../src/db";
test("恢复与接管：父级元数据失败仍遍历子页；重启不复用旧标签；用户导航不被覆盖", async () => {
  const root = pageRef(DEFAULT_ROOT)!;
  const child = {
    id: "3b836e314814ef0c3e2a7c3683bc25bf",
    title: "个人周报",
    url: "https://app.notion.com/p/3b836e314814ef0c3e2a7c3683bc25bf",
  };
  let failRoot = true,
    takeover = false,
    listener: any,
    counter = 10;
  const tabs = new Map<number, any>();
  let session: Record<string, unknown> = {};
  const navigations: Array<{ id: number; url: string }> = [];
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
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: event },
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
    tabs: {
      create: async (o: any) => {
        const t = { id: ++counter, url: o.url, active: false, menuOpen: false };
        tabs.set(t.id, t);
        return t;
      },
      get: async (id: number) => {
        if (!tabs.has(id)) throw Error("tab missing");
        return tabs.get(id);
      },
      update: async (id: number, o: any) => {
        navigations.push({ id, url: o.url });
        return Object.assign(tabs.get(id), o, { menuOpen: false });
      },
      remove: async (id: number) => tabs.delete(id),
    },
    scripting: {
      executeScript: async (o: any) => {
        const tab = tabs.get(o.target.tabId),
          id = pageRef(tab.url)!.id;
        const f: Frame = {
          id,
          title: id === root.id ? "数据库" : child.title,
          ready: true,
          children: id === root.id ? [child] : [],
          warnings: [],
          bottom: true,
          position: 0,
          height: 500,
          observed: new Date(2026, 10, 16, 15).getTime(),
        };
        if (o.args[0] === "open-menu" || o.args[0] === "prepare-metadata")
          tab.menuOpen = true;
        if (
          (o.args[0] === "open-menu" || o.args[0] === "prepare-metadata") &&
          takeover
        )
          tab.url = "https://example.com/user-navigation";
        if (o.args[0] === "metadata") {
          f.author = "甲";
          f.rawTime = "今天 14:02";
          if (!tab.menuOpen || (id === root.id && failRoot)) {
            f.error = "作者字段未就绪";
            f.author = undefined;
          }
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
        { id: "test", url: "chrome-extension://test/dashboard.html" },
        resolve,
      ),
    );
  const finish = async (status: string) => {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      const r = await read<any>("state", "run");
      if (r?.status !== "running") {
        assert.equal(r.status, status);
        await new Promise((r) => setTimeout(r, 50));
        return r;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw Error("扫描没有结束");
  };
  assert.ok(!(await message("start")).error);
  const partial = await finish("done");
  assert.equal(partial.failed, 1);
  assert.equal(partial.done, 1);
  assert.equal((await read<Page>("pages", child.id))?.author, "甲");
  // A browser restart invalidates session storage. Even an identical URL and recycled ID is not ownership proof.
  failRoot = false;
  session = { ownershipToken: "fresh-browser-session" };
  tabs.set(2, { id: 2, url: root.url, active: false });
  await write("state", {
    id: "run",
    runId: "recovered",
    status: "running",
    queue: [{ ...root, title: "数据库", depth: 0, tries: 0 }],
    seen: [root.id],
    done: 0,
    failed: 0,
    initial: true,
    startedAt: Date.now(),
    heartbeat: 0,
    errors: [],
    limited: false,
    tabId: 2,
    ownedPageId: root.id,
    sessionToken: "old-browser-session",
  });
  assert.ok(!(await message("start")).error);
  await finish("done");
  assert.ok(tabs.has(2));
  assert.equal(navigations.filter((x) => x.id === 2).length, 0);
  takeover = true;
  assert.ok(!(await message("start")).error);
  await finish("paused");
  const userTab = [...tabs.values()].find(
    (t) => t.url === "https://example.com/user-navigation",
  );
  assert.ok(userTab, "保留被用户导航的检查标签页");
  assert.equal(
    navigations.filter((n) => n.id === userTab.id).length,
    0,
    "没有覆盖用户导航",
  );
});
