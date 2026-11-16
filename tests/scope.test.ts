import { DEFAULT_ROOT } from "./fixtures";
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRef, type Frame, type Page } from "../src/model";
import { read, all } from "../src/db";
const rootRef = pageRef(DEFAULT_ROOT)!;
const now = new Date();
const dow = (now.getDay() + 6) % 7;
const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
const fmt = (d: Date) => `${d.getMonth() + 1}.${d.getDate()}`;
const weekTitle = (offset: number) => {
  const s = new Date(
    mon.getFullYear(),
    mon.getMonth(),
    mon.getDate() + offset * 7,
  );
  const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 6);
  return `${fmt(s)}-${fmt(e)} 周报`;
};
const pageRefOf = (id: string, title: string) => ({
  id,
  title,
  url: `https://app.notion.com/p/example-space/${id}`,
});
const current = pageRefOf("c5c36217d8dc95b09ed9f03874b5c9d7", weekTitle(0));
const oldWeek = pageRefOf("a7ecffae7ac9187dd754a86c85b1ee61", weekTitle(-3));
const unknown = pageRefOf("a4ce03f358cf3d9145797744d3369d2a", "xxxx 周报");
const person = pageRefOf("16c2d65a81b520d6b99c9753cb275bb8", "个人页");
let listener: any;
const tabs = new Map<number, any>();
let counter = 300;
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
      get: async () => ({ ownershipToken: "scope-session" }),
      set: async () => {},
    },
    local: {
      get: async () => ({
        settings: {
          root: DEFAULT_ROOT,
          interval: 60,
          enabled: false,
          notify: false,
          concurrency: 2,
        },
      }),
    },
  },
  alarms: { create: async () => {}, clear: async () => {}, onAlarm: event },
  tabs: {
    create: async (o: any) => {
      const t = { id: ++counter, url: o.url, active: false, menuOpen: false };
      tabs.set(t.id, t);
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
      const title =
        id === rootRef.id
          ? "周报数据库"
          : [current, oldWeek, unknown, person].find((x) => x.id === id)
              ?.title || "页面";
      const children =
        id === rootRef.id
          ? [current, oldWeek, unknown]
          : id === current.id
            ? [person]
            : [];
      const frame: Frame = {
        id,
        title,
        ready: true,
        children,
        warnings: [],
        bottom: true,
        position: 0,
        height: 300,
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
const waitFor = async (check: () => Promise<boolean>, timeout = 30000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw Error("等待超时");
};
test("只扫描最近窗口内的周报，旧周报整个子树跳过", async () => {
  assert.ok(!(await message("start")).error);
  await waitFor(
    async () => (await read<any>("state", "run"))?.status === "done",
  );
  const run = await read<any>("state", "run");
  assert.equal(run.skipped, 1);
  assert.equal(run.done, 4);
  const pages = await all<Page>("pages");
  const ids = new Set(pages.map((p) => p.id));
  assert.ok(ids.has(current.id));
  assert.ok(ids.has(person.id));
  assert.ok(ids.has(unknown.id));
  assert.ok(!ids.has(oldWeek.id), "更早的周报不应被打开");
});
