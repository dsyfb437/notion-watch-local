import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { readDocument } from "../src/reader";
const root = "d672e4d709c0f4797530d2636319499a",
  child = "3b836e314814ef0c3e2a7c3683bc25bf",
  other = "72c6aacb7a6a61e689ed529b0f488010";
function setup(body: string) {
  const w = new Window({
    url: `https://app.notion.com/p/example-space/${root}`,
  });
  Object.assign(globalThis, {
    document: w.document,
    location: w.location,
    Element: w.Element,
    Node: w.Node,
  });
  w.document.body.innerHTML = body;
  return w;
}
const shell = (body: string) =>
  `<header><div role="button" aria-label="操作"></div></header><main><h1 data-block-id="${root}">周报<img class="notion-emoji" alt="🐸"></h1><div class="notion-scroller vertical">${body}</div></main>`;
test("数据库只发现顶层卡片，不误收卡片预览里的个人页和侧边栏链接", () => {
  setup(
    `<nav><a href="/p/${other}">侧栏</a></nav>` +
      shell(
        `<div class="notion-collection_view-block"><div class="notion-page-block notion-collection-item" data-block-id="${child}"><a href="/p/${child}?pvs=25"><div data-block-id="xxx">卡片预览污染</div>第十二周</a><div class="notion-page-block" data-block-id="${other}"><a href="/p/${other}">个人页</a></div></div></div>`,
      ),
  );
  const result = readDocument("inspect");
  assert.equal(result.ready, true);
  assert.equal(result.title, "周报🐸");
  assert.deepEqual(
    result.children.map((x) => x.id),
    [child],
  );
  assert.equal(result.children[0].title, "第十二周");
});
test("普通 Notion 超链接与外链不递归，真正子页面按 blockId 确认", () => {
  setup(
    shell(
      `<div class="notion-page-content"><a href="/p/${other}">普通链接</a><div class="notion-page-block" data-block-id="${child}"><a href="/p/${child}">真正子页</a><a href="https://evil.test/p/${other}">外部</a></div></div>`,
    ),
  );
  assert.deepEqual(
    readDocument("inspect").children.map((x) => x.id),
    [child],
  );
});
test("读取最近编辑信息不会把在线人员或评论作者当成编辑者", () => {
  setup(
    shell('<div class="notion-page-content"><div>评论作者：乙</div></div>') +
      `<div role="dialog"><div><div>上次编辑日期</div><div><div><img alt="甲"><span>甲</span></div><div>今天 14:02</div></div></div></div>`,
  );
  const result = readDocument("metadata");
  assert.equal(result.author, "甲");
  assert.equal(result.rawTime, "今天 14:02");
  assert.equal(result.error, undefined);
});
test("布局变动、缺失菜单信息时返回失败，不猜编辑者", () => {
  setup(shell('<div class="notion-page-content"></div>'));
  assert.ok(readDocument("metadata").error);
  setup("<main><h1>正在加载</h1></main>");
  assert.equal(readDocument("inspect").ready, false);
});
test("只读菜单动作不会触碰删除、锁定或通知项", () => {
  const w = setup(
    shell('<div class="notion-page-content"></div>') +
      '<div role="option" id="delete">移至垃圾箱</div>',
  );
  let action = 0,
    deleted = 0;
  w.document
    .querySelector('header [role="button"]')!
    .addEventListener("click", () => action++);
  w.document
    .getElementById("delete")!
    .addEventListener("click", () => deleted++);
  readDocument("open-menu");
  assert.equal(action, 1);
  assert.equal(deleted, 0);
});
test("数据库卡片中的嵌套数据库预览不被当成根级子页", () => {
  setup(
    shell(
      `<div class="notion-collection_view-block"><div class="notion-page-block notion-collection-item" data-block-id="${child}"><a href="/p/${child}">第十二周</a><div class="notion-page-block notion-collection-item" data-block-id="${other}"><a href="/p/${other}">内嵌预览</a></div></div></div>`,
    ),
  );
  assert.deepEqual(
    readDocument("inspect").children.map((x) => x.id),
    [child],
  );
});
test("真实顶栏结构无 aria-label 时仍能定位，不点击正文内同名结构", () => {
  const w = setup(
    shell(
      '<div class="notion-page-content"><div class="notion-topbar-more-button" role="button" id="body-fake"></div></div>',
    ),
  );
  const original = w.document.querySelector('header [role="button"]')!;
  original.removeAttribute("aria-label");
  original.className = "notion-topbar-more-button";
  let opened = 0,
    bad = 0;
  original.addEventListener("click", () => opened++);
  w.document
    .getElementById("body-fake")!
    .addEventListener("click", () => bad++);
  assert.equal(readDocument("open-menu").error, undefined);
  assert.equal(opened, 1);
  assert.equal(bad, 0);
  original.setAttribute("aria-expanded", "true");
  readDocument("open-menu");
  assert.equal(opened, 1, "不把已经打开的菜单再次关掉");
});
test("URL 已切换但标题区块仍属于旧页面时，不视为页面就绪", () => {
  const w = setup(shell('<div class="notion-page-content"></div>'));
  w.document.querySelector("h1")!.setAttribute("data-block-id", child);
  const frame = readDocument("inspect");
  assert.equal(frame.ready, false);
  assert.equal(frame.documentId, child);
  let clicked = 0;
  w.document
    .querySelector('header [role="button"]')!
    .addEventListener("click", () => clicked++);
  readDocument("open-menu");
  assert.equal(clicked, 0);
});
test("顶栏按钮尚未附带 role 时可识别，真正空标题页面也能就绪", () => {
  const w = setup(shell('<div class="notion-page-content"></div>'));
  const heading = w.document.querySelector("h1")!;
  heading.textContent = "";
  const button = w.document.querySelector('header [role="button"]')!;
  button.className = "notion-topbar-more-button";
  button.removeAttribute("role");
  button.removeAttribute("aria-label");
  let count = 0;
  button.addEventListener("click", () => count++);
  assert.equal(readDocument("inspect").title, "未命名页面");
  assert.equal(readDocument("inspect").ready, true);
  assert.equal(readDocument("open-menu").error, undefined);
  assert.equal(count, 1);
});
