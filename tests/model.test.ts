import { test } from "node:test";
import assert from "node:assert/strict";
import {
  pageRef,
  editDate,
  changed,
  inRecentScope,
  type Page,
} from "../src/model";
test("地址保留数据库视图、去掉追踪片段，拒绝外部域与伪造子域", () => {
  const id = "d672e4d709c0f4797530d2636319499a";
  assert.equal(
    pageRef(
      `https://app.notion.com/p/example-space/title-${id}?v=view&pvs=25#anything`,
    )?.url,
    `https://app.notion.com/p/example-space/title-${id}?v=view`,
  );
  for (const url of [
    `https://app.notion.com.evil.test/p/${id}`,
    `http://app.notion.com/p/${id}`,
    `https://evil:secret@app.notion.com/p/${id}`,
    `https://app.notion.com/login?next=${id}`,
  ])
    assert.equal(pageRef(url), null);
});
test("昨天跨月、今天跨午夜归一化后不产生误报", () => {
  const before = new Date(2026, 10, 30, 23, 59).getTime(),
    after = new Date(2026, 11, 1, 1).getTime();
  assert.equal(editDate("今天 14:02", before), editDate("昨天 14:02", after));
  assert.equal(
    editDate("昨天 08:15", new Date(2026, 0, 1).getTime()),
    "2025-12-31 08:15",
  );
  assert.equal(editDate("2026年11月16日 14:02", after), "2026-11-16 14:02");
  assert.equal(editDate("11月16日 14:02", after), "2026-11-16 14:02");
  assert.equal(editDate("今天 25:99", after), null);
  assert.equal(editDate("6 小时前", after), null);
  assert.equal(editDate("2026年2月30日", after), null);
});
test("首次读取不报更新；编辑者变化、编辑分钟变化才报告", () => {
  const p = {
    id: "x",
    title: "测试",
    url: "https://app.notion.com",
    depth: 0,
    author: "甲",
    editKey: "2026-11-16 14:02",
  } satisfies Page;
  assert.equal(changed(undefined, p), false);
  assert.equal(
    changed(p, { ...p, lastAttemptAt: Date.now(), rawTime: "昨天 14:02" }),
    false,
  );
  assert.equal(changed(p, { ...p, author: "乙" }), true);
  assert.equal(changed(p, { ...p, editKey: "2026-11-16 14:03" }), true);
  assert.equal(changed(p, { ...p, editKey: undefined }), false);
});
test("时间显示从分钟退化为日期不会误报更新", () => {
  const page: Page = {
    id: "p",
    title: "p",
    url: "https://app.notion.com",
    depth: 0,
    author: "甲",
    editKey: "2026-11-16 14:02",
  };
  assert.equal(changed(page, { ...page, editKey: "2026-11-16" }), false);
  assert.equal(
    changed(
      { ...page, editKey: "2026-11-16" },
      { ...page, editKey: "2026-11-16 14:02" },
    ),
    false,
  );
  assert.equal(changed(page, { ...page, editKey: "2026-11-17" }), true);
  assert.equal(
    changed(page, { ...page, editKey: "2026-11-16", author: "乙" }),
    true,
  );
});
test("Notion 英文相对日期与 12 小时制，包括真实日志中的两种格式", () => {
  const now = new Date(2026, 10, 16, 15, 40).getTime();
  assert.equal(editDate("Yesterday at 10:50 PM", now), "2026-11-15 22:50");
  assert.equal(editDate("Today at 12:36 AM", now), "2026-11-16 00:36");
  assert.equal(editDate("Today at 12:36 PM", now), "2026-11-16 12:36");
  assert.equal(editDate("Today at 1:05\u202fPM", now), "2026-11-16 13:05");
  assert.equal(
    editDate("November 14, 2026 at 12:42 AM", now),
    "2026-11-14 00:42",
  );
  assert.equal(editDate("Nov 14 at 22:42", now), "2026-11-14 22:42");
  assert.equal(editDate("Nov 14, 2026", now), "2026-11-14");
  assert.equal(editDate("Today at 13:00 PM", now), null);
  assert.equal(editDate("Today at 00:00 AM", now), null);
});

test("最近两周范围：周一含上一周，周二起只含本周与更新的周报", () => {
  const mon = new Date(2026, 10, 16).getTime();
  assert.equal(inRecentScope("11.16-11.22第十二周 周报", mon), true);
  assert.equal(inRecentScope("🤖 标注图标11.9-11.15第十一周 周报", mon), true);
  assert.equal(inRecentScope("11.2-11.8第十周 周报", mon), false);
  const tue = new Date(2026, 10, 17, 9).getTime();
  assert.equal(inRecentScope("11.9-11.15第十一周 周报", tue), false);
  assert.equal(inRecentScope("11.16-11.22第十二周 周报", tue), true);
  assert.equal(inRecentScope("11.23-11.29第十三周 周报", tue), true);
  assert.equal(inRecentScope("xxxx 周报", tue), true);
  assert.equal(inRecentScope("11.16 周报", tue), true);
  assert.equal(inRecentScope("单周 10.26-11.1 周报", tue), false);
  // 跨年：2027-01-02 所在周是 12.28-1.3；上一周 12.21-12.27 不在范围。
  assert.equal(
    inRecentScope("12.28-1.3 周报", new Date(2027, 0, 2).getTime()),
    true,
  );
  assert.equal(
    inRecentScope("12.21-12.27 周报", new Date(2027, 0, 2).getTime()),
    false,
  );
});
