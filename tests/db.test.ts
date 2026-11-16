import "fake-indexeddb/auto";
import { test } from "node:test";
import assert from "node:assert/strict";
import { commit, read, all } from "../src/db";
import type { Page, Update } from "../src/model";
test("页面与动态原子写入；重复写入同一动态不重复", async () => {
  const page: Page = {
    id: "page",
    url: "https://app.notion.com",
    title: "测试",
    depth: 0,
    author: "甲",
    editKey: "2026-11-16 14:02",
  };
  const update: Update = {
    id: "change",
    pageId: page.id,
    url: page.url,
    title: page.title,
    author: "甲",
    editKey: page.editKey!,
    detectedAt: 1,
    kind: "updated",
    notified: false,
  };
  await commit(page, update);
  await commit(page, update);
  assert.equal((await all("updates")).length, 1);
  assert.deepEqual(await read("pages", page.id), page);
  // A key-path failure in the second write must roll back the page update too.
  await assert.rejects(
    commit({ ...page, author: "乙" }, {
      ...update,
      id: undefined,
    } as unknown as Update),
  );
  assert.equal((await read<Page>("pages", page.id))?.author, "甲");
});

test("停止与进度提交竞争时，不复活任务、不覆盖页面基线", async () => {
  const { write, checkpointRun } = await import("../src/db");
  const stopped = {
    id: "run",
    runId: "stopped-run",
    status: "stopped",
    done: 2,
  };
  await write("state", stopped);
  await assert.rejects(
    checkpointRun({ ...stopped, status: "running", done: 3 }),
    /检查已停止/,
  );
  assert.deepEqual(await read("state", "run"), stopped);
  const before = await read<Page>("pages", "page");
  await assert.rejects(
    commit({ ...before!, author: "错误的晚到结果" }, undefined, "stopped-run"),
    /检查已停止/,
  );
  assert.deepEqual(await read("pages", "page"), before);
  await write("state", {
    id: "run",
    runId: "new-run",
    status: "running",
    done: 0,
  });
  await assert.rejects(
    checkpointRun({ id: "run", runId: "old-run", status: "paused" }),
    /检查已停止/,
  );
  assert.equal((await read<any>("state", "run")).runId, "new-run");
});

test("已读和桌面通知并发更新时保留两种标记", async () => {
  const { patchUpdateFlags } = await import("../src/db");
  const page: Page = {
    id: "flags-page",
    url: "https://app.notion.com",
    title: "测试",
    depth: 0,
  };
  const update: Update = {
    id: "flags-update",
    pageId: page.id,
    url: page.url,
    title: page.title,
    author: "甲",
    editKey: "2026-11-16 14:00",
    detectedAt: 1,
    kind: "updated",
    notified: false,
    read: false,
  };
  await commit(page, update);
  await Promise.all([
    patchUpdateFlags([update.id], { read: true }),
    patchUpdateFlags([update.id], { notified: true }),
  ]);
  const result = await read<Update>("updates", update.id);
  assert.equal(result?.read, true);
  assert.equal(result?.notified, true);
  assert.equal(result?.title, update.title);
  await patchUpdateFlags(["missing"], { read: true });
  assert.equal(await read("updates", "missing"), undefined);
});

test("重复事件重放不清除已读和通知状态，也不改写首次发现时间", async () => {
  const { patchUpdateFlags } = await import("../src/db");
  const page: Page = {
    id: "replay-page",
    url: "https://app.notion.com",
    title: "测试",
    depth: 0,
  };
  const event: Update = {
    id: "replay-event",
    pageId: page.id,
    url: page.url,
    title: page.title,
    author: "甲",
    editKey: "2026-11-16 14:00",
    detectedAt: 1,
    kind: "updated",
    notified: false,
  };
  await commit(page, event);
  await patchUpdateFlags([event.id], { read: true, notified: true });
  await commit(page, { ...event, detectedAt: 2 });
  const saved = await read<Update>("updates", event.id);
  assert.equal(saved?.read, true);
  assert.equal(saved?.notified, true);
  assert.equal(saved?.detectedAt, 1);
});
