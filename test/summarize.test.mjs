// api/summarize.js 시험 — 가짜 DB + 가짜 Gemini로 "업데이트" 버튼 흐름을 돌려 봄.
// 실행: npm test
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./mock-supabase.mjs";

let db;
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => db.client } });
process.env.SUPABASE_URL = "x"; process.env.SUPABASE_SERVICE_KEY = "x"; process.env.GEMINI_API_KEY = "x";
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn) => realSetTimeout(fn, 0); // 재시도 대기 시간 없이 바로
const { default: handler } = await import("../api/summarize.js");

// 가짜 Gemini: script 배열에 "이번 호출은 이렇게 답해라"를 순서대로 넣어 둠(없으면 정상 응답)
let script = [];
let geminiCalls = 0;
function geminiOk(args) {
  return { ok: true, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name: args.__name, args } }] } }] }) };
}
globalThis.fetch = async (url, opt) => {
  assert.match(String(url), /generativelanguage\.googleapis\.com/);
  geminiCalls++;
  const body = JSON.parse(opt.body);
  const name = body.tools[0].functionDeclarations[0].name;
  const prompt = body.contents[0].parts[0].text;
  if (name === "split_telegram_digests") return geminiOk({ __name: name, splits: [] });
  const step = script.shift();
  if (step === "max_tokens") return { ok: true, json: async () => ({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [] } }] }) };
  if (step === 429) return { ok: false, status: 429, text: async () => "rate limited" };
  const n = Number(prompt.match(/총 (\d+)건/)[1]);
  const updates = Array.from({ length: n }, (_, i) => ({
    indices: [i + 1], existing_cluster_ref: 0, headline: `사건 ${i} ${Math.random()}`,
    impact: "low", targets: [`회사${Math.random()}`], note: "",
  }));
  return geminiOk({ __name: name, updates });
};

const NOW = Date.now();
function tgItem(i, addedAt, extra = {}) {
  return {
    title: `글${i}`, url: `https://t.me/ch/${String(i).padStart(4, "0")}`, source: "텔레그램: ch",
    source_type: "telegram", summary: `본문 ${i} `.repeat(10), category: "telegram",
    published_at: new Date(NOW - 3600e3 + i * 1000).toISOString(), added_at: addedAt, ...extra,
  };
}
// DB가 돌려주는 시각처럼 마이크로초까지 붙인 문자열
const microIso = (ms) => new Date(ms).toISOString().replace(/\.(\d{3})Z$/, ".$1456+00:00");

async function press(continuation) {
  let out;
  const res = { status(c) { this.code = c; return this; }, json(j) { out = { code: this.code, ...j }; } };
  await handler({ method: "POST", body: { run_at: new Date().toISOString(), continuation } }, res);
  return out;
}
const clusterUrls = () => db.DB.clusters.flatMap(c => c.sources.map(s => s.url));

beforeEach(() => { db = makeDb(); script = []; geminiCalls = 0; });

test("같은 시각에 몰려 들어온 100건을 빠짐없이 한 번씩만 처리하고, 키워드 뉴스는 건드리지 않음", async () => {
  const at = microIso(NOW - 1800e3);
  for (let i = 0; i < 100; i++) db.DB.items.push(tgItem(i, at));
  db.DB.items.push(tgItem(500, at, { source_type: "newswire", source: "Google News" }));
  const r = await press(false);
  assert.equal(r.code, 200);
  assert.equal(r.item_count, 100);
  assert.equal(r.has_more_backlog, false);
  const urls = clusterUrls();
  assert.equal(urls.length, 100);
  assert.equal(new Set(urls).size, 100, "같은 글이 두 번 들어가면 안 됨");
  assert.ok(!urls.includes("https://t.me/ch/0500"), "키워드 뉴스는 요약 대상 아님");
  assert.equal(db.DB.briefings.at(-1).period_to, at, "커서는 DB 시각 문자열 그대로(마이크로초 포함)");
});

test("다시 눌러도 이미 처리한 글은 또 요약하지 않음", async () => {
  const at = microIso(NOW - 1800e3);
  for (let i = 0; i < 10; i++) db.DB.items.push(tgItem(i, at));
  await press(false);
  const callsBefore = geminiCalls;
  const r = await press(true);
  assert.equal(r.skipped, true);
  assert.equal(geminiCalls, callsBefore, "AI 호출이 더 일어나면 안 됨");
  assert.equal(clusterUrls().length, 10);
});

test("다른 요약이 돌고 있으면(잠금) 409로 돌려보내고, 5분 넘은 잠금은 풀린 걸로 봄", async () => {
  db.DB.items.push(tgItem(1, microIso(NOW - 60e3)));
  db.DB.status.push({ id: 3, last_run_at: new Date(NOW - 60e3).toISOString(), last_note: "진행중" });
  const busy = await press(false);
  assert.equal(busy.code, 409);
  assert.equal(clusterUrls().length, 0);
  db.DB.status[0].last_run_at = new Date(NOW - 6 * 60e3).toISOString(); // 죽은 실행이 남긴 잠금
  const r = await press(false);
  assert.equal(r.code, 200);
  assert.equal(clusterUrls().length, 1);
});

test("요약이 끝나면 잠금을 풀고 결과를 status id 3에 남김(화면 상단 표시용)", async () => {
  db.DB.items.push(tgItem(1, microIso(NOW - 60e3)));
  await press(false);
  const row = db.DB.status.find(r => r.id === 3);
  assert.match(row.last_note, /^1건 정리/);
  const again = await press(false);
  assert.equal(again.code, 200, "바로 다시 눌러도 막히지 않음(쿨다운 없음)");
  assert.equal(db.DB.status.find(r => r.id === 3).last_note, "새 글 없음");
});

test("AI 응답이 잘리면 배치를 반으로 줄여서 다시 하고, 결국 다 처리함", async () => {
  const at = microIso(NOW - 1800e3);
  for (let i = 0; i < 40; i++) db.DB.items.push(tgItem(i, at));
  script = ["max_tokens"];
  let r = await press(false);
  assert.equal(r.code, 200);
  for (let k = 0; k < 5 && r.has_more_backlog; k++) r = await press(true);
  const urls = clusterUrls();
  assert.equal(urls.length, 40);
  assert.equal(new Set(urls).size, 40);
});

test("Gemini 무료 한도(429)에 한 번 걸려도 자동 재시도로 넘어감", async () => {
  db.DB.items.push(tgItem(1, microIso(NOW - 60e3)));
  script = [429];
  const r = await press(false);
  assert.equal(r.code, 200);
  assert.equal(clusterUrls().length, 1);
});

test("48시간보다 오래된 백로그는 건너뜀", async () => {
  db.DB.items.push(tgItem(1, microIso(NOW - 72 * 3600e3)));
  db.DB.items.push(tgItem(2, microIso(NOW - 60e3)));
  db.DB.briefings.push({ id: 0, created_at: new Date(NOW - 80 * 3600e3).toISOString(), period_to: microIso(NOW - 80 * 3600e3) });
  const r = await press(false);
  assert.equal(r.item_count, 1);
  assert.deepEqual(clusterUrls(), ["https://t.me/ch/0002"]);
});
