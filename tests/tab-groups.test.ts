import { DEFAULT_ROOT } from "./fixtures";
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRef, type Frame } from "../src/model";
import { read } from "../src/db";
const root = pageRef(DEFAULT_ROOT)!;
const child = {
  id: "5e4e33127b3d0b180c44beca586fc30b",
  url: "https://app.notion.com/p/5e4e33127b3d0b180c44beca586fc30b",
  title: "个人页",
};
let listener: any,
  tabId = 10,
  groupId = 100,
  granted = true;
const tabs = new Map<number, any>(),
  groups = new Map<number, any>(),
  created: any[] = [],
  updated: any[] = [];
const saved: any = {
  settings: {
    root: DEFAULT_ROOT,
    interval: 60,
    enabled: false,
    notify: false,
    concurrency: 2,
    windowMode: true,
    collapseTabs: true,
  },
};
const event = { addListener: () => {} };
const chromeMock = {
  runtime: {
    id: "groups-test",
    getURL: (p: string) => `chrome-extension://groups-test/${p}`,
    onInstalled: event,
    onStartup: event,
    onMessage: { addListener: (fn: any) => (listener = fn) },
  },
  action: { onClicked: event },
  notifications: { onClicked: event },
  permissions: {
    contains: async (p: any) =>
      p.permissions?.includes("tabGroups") ? granted : true,
  },
  storage: {
    session: {
      get: async () => ({ ownershipToken: "group-session" }),
      set: async () => {},
    },
    local: {
      get: async () => saved,
      set: async (values: any) => Object.assign(saved, values),
    },
  },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: event },
  tabGroups: {
    get: async (id: number) => {
      if (!groups.has(id)) throw Error("No group");
      return groups.get(id);
    },
    update: async (id: number, value: any) => {
      updated.push({ id, ...value });
      Object.assign(groups.get(id), value);
      return groups.get(id);
    },
  },
  tabs: {
    create: async (o: any) => {
      const t = {
        id: tabId++,
        windowId: 1,
        url: o.url,
        active: false,
        menuOpen: false,
      };
      tabs.set(t.id, t);
      return t;
    },
    get: async (id: number) => tabs.get(id),
    update: async (id: number, o: any) =>
      Object.assign(tabs.get(id), o, { menuOpen: false }),
    group: async (o: any) => {
      let id = o.groupId;
      if (id === undefined) {
        id = groupId++;
        groups.set(id, { id, windowId: o.createProperties.windowId });
        created.push(id);
      }
      for (const tid of o.tabIds) {
        assert.ok(tabs.has(tid));
        tabs.get(tid).groupId = id;
      }
      return id;
    },
    remove: async (id: number) => {
      const g = tabs.get(id)?.groupId;
      tabs.delete(id);
      if (g !== undefined && ![...tabs.values()].some((t) => t.groupId === g))
        groups.delete(g);
    },
  },
  scripting: {
    executeScript: async (o: any) => {
      const tab = tabs.get(o.target.tabId),
        id = pageRef(tab.url)!.id,
        action = o.args[0];
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
      if (action === "prepare-metadata") tab.menuOpen = true;
      if (action === "metadata" && tab.menuOpen) {
        f.author = "甲";
        f.rawTime = "今天 14:00";
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
        id: "groups-test",
        url: "chrome-extension://groups-test/dashboard.html",
      },
      resolve,
    ),
  );
const delay = (n: number) => new Promise((r) => setTimeout(r, n));
async function run() {
  const response = await message("start");
  assert.ok(!response.error, response.error);
  const until = Date.now() + 10000;
  while (Date.now() < until) {
    const r = await read<any>("state", "run");
    if (r?.status === "done") {
      await delay(80);
      return r;
    }
    await delay(20);
  }
  throw Error("分组扫描未结束");
}
test("日常界面迁移回后台检查，保留其他订阅设置", async () => {
  await message("status");
  assert.equal(saved.inboxUiVersion, 1);
  assert.equal(saved.settings.windowMode, false);
  assert.equal(saved.settings.collapseTabs, true);
  assert.equal(saved.settings.interval, 60);
  assert.equal(saved.settings.enabled, false);
});
test("只折叠扩展创建的标签组，正常结束自动清理", async () => {
  const state = await run();
  assert.equal(state.done, 2);
  assert.equal(created.length, 1);
  assert.equal(updated.length, 1);
  assert.equal(updated[0].collapsed, true);
  assert.equal(updated[0].title, "周报检查");
  assert.equal(tabs.size, 0);
  assert.equal(groups.size, 0);
});
test("标签组权限被撤销时继续普通后台读取，不崩溃也不操作分组", async () => {
  granted = false;
  const before = created.length;
  const state = await run();
  assert.equal(state.done, 2);
  assert.equal(state.failed, 0);
  assert.equal(created.length, before);
});
