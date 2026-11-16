import { DEFAULT_ROOT } from "./fixtures";
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRef, type Frame, type Page } from "../src/model";
import { read, all } from "../src/db";
const rootRef = pageRef(DEFAULT_ROOT)!;
const kids = [
  "0bc59143125cd724cf83c68c172e6075",
  "afd13e82470b9b039f3b5fda6a94e0c5",
  "c97458cc9a7e6fbca82bf1d4128c39bc",
].map((id, index) => ({
  id,
  url: `https://app.notion.com/p/example-space/${id}`,
  title: `个人周报${index + 1}`,
}));
let listener: any;
const tabs = new Map<number, any>();
let counter = 200;
let routerWorks = true;
let fastAttempts = 0;
let tabUpdates = 0;
let stopInFast = false;
let updatesAtStop = -1;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const event = { addListener: () => {} };
const settings: Record<string, unknown> = {
  root: DEFAULT_ROOT,
  interval: 60,
  enabled: false,
  notify: false,
  concurrency: 2,
  fastNav: true,
};
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
      get: async () => ({ ownershipToken: "fastnav-session" }),
      set: async () => {},
    },
    local: { get: async () => ({ settings }) },
  },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: event },
  tabs: {
    create: async (o: any) => {
      const t = {
        id: ++counter,
        url: o.url,
        docId: pageRef(o.url)!.id,
        active: false,
        menuOpen: false,
      };
      tabs.set(t.id, t);
      return t;
    },
    get: async (id: number) => {
      if (!tabs.has(id)) throw Error(`No tab with id ${id}`);
      return tabs.get(id);
    },
    update: async (id: number, o: any) => {
      tabUpdates++;
      return Object.assign(tabs.get(id), o, {
        docId: pageRef(o.url)!.id,
        menuOpen: false,
      });
    },
    remove: async (id: number) => {
      tabs.delete(id);
    },
  },
  scripting: {
    executeScript: async (o: any) => {
      const tab = tabs.get(o.target.tabId);
      if (!tab) throw Error("tab missing");
      if (o.world === "MAIN") {
        // replaceState always rewrites the URL; only a live router swaps the document.
        fastAttempts++;
        tab.url = o.args[0];
        if (stopInFast) {
          await message("stop");
          updatesAtStop = tabUpdates;
        }
        if (routerWorks) tab.docId = pageRef(o.args[0])!.id;
        return [{}];
      }
      const action = o.args[0],
        urlId = pageRef(tab.url)!.id,
        docId = tab.docId || urlId;
      const frame: Frame = {
        id: urlId,
        documentId: docId,
        title:
          docId === rootRef.id
            ? "周报数据库"
            : kids.find((k) => k.id === docId)?.title || "页面",
        ready: docId === urlId,
        children: docId === urlId && docId === rootRef.id ? kids : [],
        warnings: [],
        bottom: true,
        position: 0,
        height: 400,
        observed: Date.now(),
      };
      if (action === "peek") return [{ result: frame }];
      if (!frame.ready)
        return [{ result: { ...frame, error: "目标页面正文仍在切换" } }];
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
const waitFor = async (check: () => Promise<boolean>, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw Error("等待超时");
};
test("快速切换：Notion 路由响应时不再整页重载", async () => {
  assert.ok(!(await message("start")).error);
  await waitFor(
    async () => (await read<any>("state", "run"))?.status === "done",
  );
  const run = await read<any>("state", "run");
  assert.equal(run.done, 4);
  assert.equal(run.failed, 0);
  assert.equal(run.fastFails, 0);
  assert.ok(fastAttempts >= 2, `应尝试页面内跳转，实际 ${fastAttempts}`);
  assert.equal(tabUpdates, 0, "路由响应时不应再整页导航");
  const pages = await all<Page>("pages");
  assert.equal(pages.length, 4);
  assert.equal(tabs.size, 0, "结束时关闭自有标签");
});
test("快速切换失效：自动退回整页加载并在两次后关闭", async () => {
  routerWorks = false;
  fastAttempts = 0;
  tabUpdates = 0;
  assert.ok(!(await message("start")).error);
  await waitFor(
    async () => (await read<any>("state", "run"))?.status === "done",
  );
  const run = await read<any>("state", "run");
  assert.equal(run.done, 4);
  assert.equal(run.failed, 0);
  assert.ok(fastAttempts >= 2, `应至少尝试两次，实际 ${fastAttempts}`);
  assert.equal(run.fastNav, false, "连续失败后关闭快速切换");
  assert.ok(tabUpdates >= 1, "失败后应退回整页导航");
  assert.equal((await all<Page>("pages")).length, 4);
});

test("快速切换等待中停止，不得随后执行整页回退导航", async () => {
  await delay(80);
  routerWorks = false;
  stopInFast = true;
  updatesAtStop = -1;
  tabUpdates = 0;
  assert.ok(!(await message("start")).error);
  await waitFor(async () => updatesAtStop >= 0);
  await delay(600);
  assert.equal((await read<any>("state", "run")).status, "stopped");
  assert.equal(
    tabUpdates,
    updatesAtStop,
    "停止后不得把路由未就绪误当成回退理由继续导航",
  );
});
