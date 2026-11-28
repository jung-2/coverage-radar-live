// scraper/collect.mjs + api/poll.js 시험 — 가짜 DB + 가짜 t.me 페이지로 텔레그램 수집을 돌려 봄.
// 실행: npm test
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./mock-supabase.mjs";

let db;
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => db.client } });
process.env.SUPABASE_URL = "x"; process.env.SUPABASE_SERVICE_KEY = "x";
const { runCollect, parseTelegramPage } = await import("../scraper/collect.mjs");
const { default: pollHandler } = await import("../api/poll.js");

// 가짜 채널: 글 번호 1..last, 1분 간격. t.me/s 처럼 한 페이지에 최근 20개(before 있으면 그 앞 20개)
let channelPosts = {};
let pageRequests = [];
function pageHtml(handle, ids) {
  return ids.map(id => `<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${handle}/${id}">
    <div class="tgme_widget_message_text js-message_text" dir="auto">${handle} 글 ${id} <b>내용</b></div>
    <time datetime="${new Date(Date.now() - (channelPosts[handle] - id) * 60e3).toISOString()}" class="time">x</time></div>`).join("\n");
}
globalThis.fetch = async (url) => {
  const u = new URL(url);
  assert.equal(u.host, "t.me");
  pageRequests.push(url);
  const handle = u.pathname.split("/").pop();
  const before = Number(u.searchParams.get("before")) || channelPosts[handle] + 1;
  const ids = [];
  for (let id = Math.max(1, before - 20); id < before; id++) ids.push(id);
  return { ok: true, text: async () => pageHtml(handle, ids) };
};

function seedKnown(handle, maxId) {
  db.DB.items.push({ url: `https://t.me/${handle}/${maxId}`, source: `텔레그램: ${handle}`, source_type: "telegram",
    title: "x", published_at: new Date(Date.now() - 3600e3).toISOString() });
}
const tgUrls = (handle) => db.DB.items.filter(i => i.source === `텔레그램: ${handle}`).map(i => i.url);

beforeEach(() => {
  db = makeDb(); channelPosts = {}; pageRequests = [];
  db.DB.status.push({ id: 1, last_run_at: null }, { id: 2, last_run_at: null });
});

test("t.me 페이지에서 글 번호·시각·본문을 읽음", () => {
  channelPosts.ch = 5;
  const posts = parseTelegramPage(pageHtml("ch", [4, 5]), "ch");
  assert.deepEqual(posts.map(p => p.id), [4, 5]);
  assert.equal(posts[1].rawText, "ch 글 5 내용");
});

test("수집이 오래 쉬어서 20개 넘게 밀려도 빠진 글을 거슬러 올라가 다 가져옴", async () => {
  db.DB.telegram_channels.push({ handle: "busy" });
  channelPosts.busy = 100;
  seedKnown("busy", 45); // DB엔 45번까지 있음 → 46~100(55개)이 새 글
  const r = await runCollect(db.client, "telegram");
  assert.equal(r.inserted, 55);
  const ids = tgUrls("busy").map(u => Number(u.split("/").pop())).sort((a, b) => a - b);
  assert.deepEqual(ids, Array.from({ length: 56 }, (_, i) => 45 + i));
  assert.match(db.DB.status.find(s => s.id === 1).last_note, /빠진 글 \d+페이지/);
});

test("새로 추가한 채널은 첫 페이지만 읽음(옛 글을 끝없이 긁지 않음)", async () => {
  db.DB.telegram_channels.push({ handle: "fresh" });
  channelPosts.fresh = 500;
  const r = await runCollect(db.client, "telegram");
  assert.equal(r.inserted, 20);
  assert.equal(pageRequests.length, 1);
});

test("밀린 게 없으면 페이지 하나만 읽고 새 글만 저장", async () => {
  db.DB.telegram_channels.push({ handle: "calm" });
  channelPosts.calm = 30;
  seedKnown("calm", 28);
  const r = await runCollect(db.client, "telegram");
  assert.equal(r.inserted, 2);
  assert.equal(pageRequests.length, 1);
});

async function callPoll() {
  let out;
  await pollHandler({ method: "POST" }, { status(c) { this.code = c; return this; }, json(j) { out = { code: this.code, ...j }; } });
  return out;
}

test("/api/poll: 처음엔 수집하고, 4분 안에 또 부르면 건너뜀", async () => {
  db.DB.telegram_channels.push({ handle: "ch" });
  channelPosts.ch = 3;
  const r1 = await callPoll();
  const tg1 = r1.results.find(x => x.mode === "telegram");
  assert.equal(tg1.inserted, 3);
  const r2 = await callPoll();
  assert.ok(r2.results.every(x => x.skipped), "바로 다시 부르면 둘 다 건너뛰어야 함");
});

test("/api/poll: 마지막 수집이 5분 넘었으면 다시 수집", async () => {
  db.DB.telegram_channels.push({ handle: "ch" });
  channelPosts.ch = 3;
  db.DB.status[0].last_run_at = new Date(Date.now() - 6 * 60e3).toISOString();
  db.DB.status[1].last_run_at = new Date(Date.now() - 60e3).toISOString();
  const r = await callPoll();
  assert.equal(r.results.find(x => x.mode === "telegram").inserted, 3);
  assert.equal(r.results.find(x => x.mode === "keywords").skipped, true);
});

// ── 2026-11-28 추가: 답글·줄바꿈·알림 글·못 읽는 채널 ──
test("답글은 인용된 옛 글이 아니라 진짜 본문을 읽고, 줄바꿈·특수문자를 살림", () => {
  const html = `<div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="ch/7">
    <a class="tgme_widget_message_reply"><div class="tgme_widget_message_text js-message_reply_text" dir="auto">인용된 옛 글</div></a>
    <div class="tgme_widget_message_text js-message_text" dir="auto">매출 1,155억 &amp; 영업이익 57억<br/>단가 &#036;3.50 &gt; &#036;5.50</div>
    <time datetime="2026-11-28T01:00:00+00:00" class="time">x</time></div>`;
  const posts = parseTelegramPage(html, "ch");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].rawText, "매출 1,155억 & 영업이익 57억\n단가 $3.50 > $5.50");
});

test("'○○ pinned «…»' 같은 알림 글은 저장하지 않음", () => {
  const block = (id, cls, text) => `<div class="tgme_widget_message ${cls}" data-post="ch/${id}">
    <div class="tgme_widget_message_text js-message_text" dir="auto">${text}</div>
    <time datetime="2026-11-28T01:00:00+00:00" class="time">x</time></div>`;
  const posts = parseTelegramPage(block(1, "service_message js-widget_message", "알림") + block(2, "js-widget_message", "채널이름 pinned « 옛 글 »") + block(3, "js-widget_message", "진짜 글"), "ch");
  assert.deepEqual(posts.map(p => p.id), [3]);
});

test("웹 미리보기가 꺼진 채널은 '새 글 없음'이 아니라 '못 읽는 채널'로 남김", async () => {
  db.DB.telegram_channels.push({ handle: "closed" }, { handle: "ok" });
  channelPosts.ok = 2;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => String(url).includes("/closed")
    ? { ok: true, url: "https://t.me/closed", text: async () => "<html>채널 소개</html>" }
    : { ...(await realFetch(url)), url: String(url) };
  try {
    const r = await runCollect(db.client, "telegram");
    assert.equal(r.inserted, 2);
    assert.match(db.DB.status.find(s => s.id === 1).last_note, /못 읽는 채널: closed/);
  } finally { globalThis.fetch = realFetch; }
});
