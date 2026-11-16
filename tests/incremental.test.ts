import { DEFAULT_ROOT } from "./fixtures";
import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { pageRef, type Frame, type Page } from "../src/model";
import { read, all, write } from "../src/db";
const rootRef = pageRef(DEFAULT_ROOT)!;
const mk = (id: string, title: string) => ({
  id,
  title,
  url: `https://app.notion.com/p/example-space/${id}`,
});
const week = mk("7453b397eb6726fbc27f44f6a6ead49d", "本周 周报");
const person = mk("d64d0540d98a335174234f5e55375cd3", "个人页");
const replacement = mk("28e4c3a061b8662cacf80aa80e91700f", "新个人页");
const silentChild = mk("56cc7a213c70077d499f144e8714af76", "同分钟新增页");
const dbpage = mk("6d37febb29922155d3ffb23a4aa23e3a", "内嵌库页");
let listener: any;
const tabs = new Map<number, any>();
let counter = 400;
const inspects = new Map<string, number>();
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const event = { addListener: () => {} };
const settings: Record<string, unknown> = {
  root: DEFAULT_ROOT,
  interval: 60,
  enabled: false,
  notify: false,
  concurrency: 2,
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
      get: async () => ({ ownershipToken: "inc-session" }),
      set: async () => {},
    },
    local: { get: async () => ({ settings }) },
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
      if (action === "inspect-step")
        inspects.set(id, (inspects.get(id) || 0) + 1);
      const children =
        id === rootRef.id
          ? [week]
          : id === week.id
            ? [
                ...(replaced ? [replacement] : [person]),
                dbpage,
                ...(silentAdded ? [silentChild] : []),
              ]
            : [];
      const warnings =
        id === dbpage.id ? ["含内嵌数据库：仅发现当前已渲染的页面条目"] : [];
      const frame: Frame = {
        id,
        title:
          id === rootRef.id
            ? "周报数据库"
            : id === week.id
              ? week.title
              : id === person.id
                ? person.title
                : dbpage.title,
        ready: true,
        children,
        warnings,
        bottom: true,
        position: 0,
        height: 300,
        observed: Date.now(),
      };
      if (action === "prepare-metadata") tab.menuOpen = true;
      if (action === "metadata" && tab.menuOpen) {
        frame.author = id === week.id && changedWeek ? "乙" : "甲";
        frame.rawTime = id === week.id && changedWeek ? weekKey : "今天 14:02";
      }
      if (action === "metadata" && !tab.menuOpen)
        frame.error = "未找到最近编辑信息";
      return [{ result: frame }];
    },
  },
};
let changedWeek = false,
  replaced = false,
  silentAdded = false;
let weekKey = "今天 15:00";
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
const run = async () => {
  inspects.clear();
  assert.ok(!(await message("start")).error);
  await waitFor(
    async () => (await read<any>("state", "run"))?.status === "done",
  );
  return read<any>("state", "run");
};
test("未变化页面跳过整页滚动，已知子页仍继续检查；有内嵌库的页面始终重扫", async () => {
  const first = await run();
  assert.equal(first.done, 4);
  assert.equal(first.failed, 0);
  assert.ok((inspects.get(rootRef.id) || 0) > 0);
  assert.ok((inspects.get(week.id) || 0) > 0);
  assert.ok((inspects.get(person.id) || 0) > 0);
  assert.ok((inspects.get(dbpage.id) || 0) > 0);
  // Run 2: nothing changed. The root always rescans; warned pages always rescan.
  const second = await run();
  assert.equal(second.done, 4);
  assert.equal(second.metrics.cacheHits, 2);
  assert.equal(second.metrics.fullScans, 2);
  assert.ok((inspects.get(rootRef.id) || 0) > 0, "入口数据库必须重新扫描");
  assert.equal(inspects.get(week.id) || 0, 0, "未变化的周报不应再滚动");
  assert.equal(inspects.get(person.id) || 0, 0, "未变化的个人页不应再滚动");
  assert.ok((inspects.get(dbpage.id) || 0) > 0, "含内嵌数据库的页面必须重扫");
  assert.equal((await all<Page>("pages")).length, 4);
  // Run 3: the week changed; it must rescan, and its known children are replayed.
  changedWeek = true;
  const third = await run();
  assert.equal(third.done, 4);
  assert.ok((inspects.get(week.id) || 0) > 0, "变化页面必须重新滚动");
  assert.equal(inspects.get(person.id) || 0, 0, "未变化的子页仍可跳过");
  assert.ok((inspects.get(dbpage.id) || 0) > 0);
  const updates = await all<any>("updates");
  assert.equal(
    updates.filter((u) => u.pageId === week.id).length,
    1,
    "变化应记录且不重复",
  );
  // Run 4: turning the toggle off forces a full scroll scan of every page.
  settings.incremental = false;
  const fourth = await run();
  assert.equal(fourth.done, 4);
  assert.ok((inspects.get(week.id) || 0) > 0);
  assert.ok((inspects.get(person.id) || 0) > 0);
  assert.ok((inspects.get(dbpage.id) || 0) > 0);
});

test("子页移出后不被历史 parent 记录重新纳入扫描", async () => {
  settings.incremental = true;
  replaced = true;
  weekKey = "今天 15:01";
  const replacedRun = await run();
  assert.equal(replacedRun.done, 4);
  assert.ok((inspects.get(week.id) || 0) > 0, "父页改动后应刷新子页关系");
  assert.equal(inspects.get(person.id) || 0, 0, "已移出的个人页不在新范围内");
  const cachedRun = await run();
  assert.equal(
    cachedRun.done,
    4,
    "增量轮次必须沿用刷新后的子页集合，而非全部历史 parent 记录",
  );
  assert.equal(inspects.get(person.id) || 0, 0, "增量轮次不可复活已移出的子页");
  assert.ok(
    (await read<Page>("pages", person.id))?.lastSuccessfulAt,
    "保留移出页面历史记录",
  );
});

test("旧版记录补建子页快照；缓存过期后重新发现同一分钟新增的子页", async () => {
  const old = await read<Page>("pages", week.id);
  assert.ok(old?.lastSuccessfulAt);
  await write("pages", {
    ...old!,
    children: undefined,
    lastDiscoveryAt: undefined,
  });
  await run();
  assert.ok(
    (inspects.get(week.id) || 0) > 0,
    "没有子页快照的旧记录不能直接用历史 parent 关系代替",
  );
  const rebuilt = await read<Page>("pages", week.id);
  assert.ok(Array.isArray(rebuilt?.children));
  silentAdded = true;
  await write("pages", {
    ...rebuilt!,
    lastDiscoveryAt: Date.now() - 25 * 60 * 60 * 1000,
  });
  const refreshed = await run();
  assert.equal(refreshed.done, 5);
  assert.ok(
    (inspects.get(week.id) || 0) > 0,
    "缓存到期必须重扫，不能无限相信分钟级编辑时间",
  );
  assert.ok(
    (await read<Page>("pages", silentChild.id))?.lastSuccessfulAt,
    "发现分钟信息未变的新增子页",
  );
});
