import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { read, write, all } from "../src/db";
import { pageRef } from "../src/model";
import { DEFAULT_ROOT } from "./fixtures";
const rootA = DEFAULT_ROOT,
  rootB = "https://app.notion.com/p/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const saved: Record<string, any> = {};
let listener: any,
  granted = true;
const event = { addListener: () => {} };
Object.assign(globalThis, {
  chrome: {
    runtime: {
      id: "settings-test",
      getURL: (p: string) => `chrome-extension://settings-test/${p}`,
      onMessage: { addListener: (fn: any) => (listener = fn) },
      onInstalled: event,
      onStartup: event,
    },
    action: { onClicked: event },
    permissions: { contains: async () => granted },
    storage: {
      local: {
        get: async () => saved,
        set: async (v: any) => Object.assign(saved, v),
      },
      session: {
        get: async () => ({ ownershipToken: "test-session" }),
        set: async () => {},
      },
    },
    alarms: { create: async () => {}, clear: async () => {}, onAlarm: event },
  },
});
await import("../src/worker");
const message = (
  type: string,
  extra: Record<string, unknown> = {},
  hash = "#settings",
) =>
  new Promise<any>((resolve) =>
    listener(
      { type, ...extra },
      {
        id: "settings-test",
        url: "chrome-extension://settings-test/dashboard.html" + hash,
      },
      resolve,
    ),
  );
const desired = (root: string) => ({
  root,
  enabled: false,
  interval: 120,
  notify: true,
  concurrency: 2,
  collapseTabs: true,
  fastNav: true,
  recentOnly: false,
  incremental: false,
  windowMode: false,
});
test("全新安装没有预设私人入口，hash 路由仍能与真实后台通信", async () => {
  const status = await message("status");
  assert.equal(status.settings.root, "");
  assert.equal(status.settings.enabled, false);
  assert.equal(status.pages.length, 0);
  assert.match((await message("start")).error, /填写并保存/);
});
test("后台持久保存所有展示设置，并拒绝不支持地址和无权限自动检查", async () => {
  const bad = await message("save", {
    settings: desired("https://evil.test/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
  });
  assert.match(bad.error, /格式/);
  granted = false;
  const noPermission = await message("save", {
    settings: { ...desired(rootA), enabled: true },
  });
  assert.match(noPermission.error, /权限/);
  granted = true;
  assert.deepEqual(await message("save", { settings: desired(rootA) }), {
    ok: true,
  });
  const status = await message("status");
  for (const [key, value] of Object.entries(desired(rootA)))
    assert.equal(status.settings[key], value, key);
  assert.equal(saved.settings.databaseRoot, pageRef(rootA)!.id);
  const again = await message("status", {}, "#logs");
  assert.equal(again.settings.collapseTabs, true);
  assert.equal(again.settings.interval, 120);
});
test("更换入口隔离页面、动态、已读标记和首次基线；切回来保留原记录", async () => {
  const id = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  await write("pages", { id, title: "A 中的页面", depth: 1 });
  await write("updates", { id: "event", title: "A 的动态", read: true });
  await write("state", { id: "baseline", done: true });
  delete saved.settings.databaseRoot; // Simulate an existing 0.1.x installation.
  await message("save", { settings: desired(rootB) });
  let status = await message("status");
  assert.equal(status.pages.length, 0);
  assert.equal(status.updates.length, 0);
  assert.equal(await read("state", "baseline"), undefined);
  await write("pages", { id, title: "B 中的同名 ID", depth: 1 });
  await write("updates", { id: "event", title: "B 的动态", read: false });
  const stale = await message("read", {
    scope: pageRef(rootA)!.id,
    ids: ["event"],
  });
  assert.match(stale.error, /入口已/);
  assert.equal((await all<any>("updates"))[0].read, false);
  await message("save", { settings: desired(rootA) });
  status = await message("status");
  assert.equal(status.pages[0].title, "A 中的页面");
  assert.equal(status.updates[0].read, true);
  assert.equal((await read<any>("state", "baseline")).done, true);
  await message("save", { settings: desired(rootB) });
  status = await message("status");
  assert.equal(status.pages[0].title, "B 中的同名 ID");
  assert.equal(status.updates[0].read, false);
});
test("仅扩展自身控制台可发送消息；不接受其他页面或伪造扩展身份", () => {
  let calls = 0;
  for (const sender of [
    { id: "other", url: "chrome-extension://settings-test/dashboard.html" },
    { id: "settings-test", url: "https://evil.test/dashboard.html" },
    {
      id: "settings-test",
      url: "chrome-extension://settings-test/other.html#settings",
    },
  ])
    assert.equal(
      listener({ type: "status" }, sender, () => calls++),
      undefined,
    );
  assert.equal(calls, 0);
});
