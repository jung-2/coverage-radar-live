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
let rescoreAnswer = [];  // "옛 카드 다시 보기"에 가짜 AI가 답할 내용
let rescorePrompts = [];
let modelList = [];   // 가짜 모델 목록(비어 있으면 기본 모델만 씀)
let modelsTried = [];  // 요약 호출에 쓰인 모델 이름들
let missingModels = new Set(); // 이 모델은 404로 답함
globalThis.fetch = async (url, opt) => {
  assert.match(String(url), /generativelanguage\.googleapis\.com/);
  if (!opt || !opt.body) return { ok: true, json: async () => ({ models: modelList }) };
  const usedModel = String(url).match(/models\/([^:]+):/)[1];
  modelsTried.push(usedModel);
  if (missingModels.has(usedModel)) return { ok: false, status: 404, text: async () => "model not found" };
  geminiCalls++;
  const body = JSON.parse(opt.body);
  const name = body.tools[0].functionDeclarations[0].name;
  const prompt = body.contents[0].parts[0].text;
  if (name === "split_telegram_digests") return geminiOk({ __name: name, splits: [] });
  if (name === "rescore_cards") { // 옛 카드 다시 보기 — 새 글 요약 호출 수(geminiCalls)에는 안 셈
    geminiCalls--;
    rescorePrompts.push(prompt);
    return geminiOk({ __name: name, cards: rescoreAnswer });
  }
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

beforeEach(() => { db = makeDb(); script = []; geminiCalls = 0; rescoreAnswer = []; rescorePrompts = []; modelList = []; modelsTried = []; missingModels = new Set(); });

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

// ── 2026-11-28 추가: 숫자·사실 목록(facts), 잡동사니 통 막기 ──
// 가짜 Gemini가 이번 한 번만 이 함수가 만든 updates로 답하게 함
function answerWith(makeUpdates) {
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, opt) => {
    if (!opt || !opt.body) return prev(url, opt);
    const body = JSON.parse(opt.body);
    const name = body.tools[0].functionDeclarations[0].name;
    if (name !== "emit_updates") return prev(url, opt);
    globalThis.fetch = prev;
    geminiCalls++;
    return geminiOk({ __name: name, updates: makeUpdates(body.contents[0].parts[0].text) });
  };
}

test("AI가 준 숫자·사실 목록을 카드에 저장하고, 같은 카드에 글이 더 붙으면 이력으로 쌓임", async () => {
  db.DB.items.push(tgItem(1, microIso(NOW - 120e3)));
  answerWith(() => [{ indices: [1], existing_cluster_ref: 0, headline: "메이투안 3분기 실적", impact: "high", impact_reason: "실적·추정치 변경", targets: ["메이투안"],
    note: "[BEAT]\n매출 예상 상회", facts: ["• 매출 1,155.6억위안(+21.6% YoY)", "매출 1,155.6억위안(+21.6% YoY)", "조정 순이익 18.5억위안 vs. 예상 22억위안", 42] }]);
  await press(false);
  assert.deepEqual(db.DB.clusters[0].updates[0].facts, ["매출 1,155.6억위안(+21.6% YoY)", "조정 순이익 18.5억위안 vs. 예상 22억위안"], "앞 기호·겹치는 줄·글자가 아닌 값은 정리됨");

  db.DB.items.push(tgItem(2, microIso(NOW - 60e3)));
  answerWith(() => [{ indices: [1], existing_cluster_ref: 1, headline: "", impact: "medium", impact_reason: "실적·추정치 변경", targets: ["메이투안"], note: "", facts: ["핵심 로컬 커머스 영업이익률 7.3%"] }]);
  await press(true);
  assert.equal(db.DB.clusters.length, 1);
  assert.equal(db.DB.clusters[0].sources.length, 2);
  assert.deepEqual(db.DB.clusters[0].updates.map(u => u.facts), [["매출 1,155.6억위안(+21.6% YoY)", "조정 순이익 18.5억위안 vs. 예상 22억위안"], ["핵심 로컬 커머스 영업이익률 7.3%"]], "설명이 비어도 숫자 목록은 이력에 남음");
});

test("AI에게 글 본문을 1500자까지 보여줌(400자 뒤쪽 숫자가 잘리지 않게)", async () => {
  db.DB.items.push(tgItem(1, microIso(NOW - 60e3), { summary: "가".repeat(1200) + " 끝쪽숫자 987.6억원" }));
  let seen = "";
  answerWith((prompt) => { seen = prompt; return [{ indices: [1], existing_cluster_ref: 0, headline: "사건", impact: "low", targets: ["회사"], note: "한 줄", facts: [] }]; });
  await press(false);
  assert.match(seen, /987\.6억원/);
});

test("'기타 소식 모음' 같은 잡동사니 통은 만들지 않고 글 하나씩 따로, 이미 있는 통에는 더 넣지 않음", async () => {
  const today = new Date(NOW + 9 * 3600e3).toISOString().slice(0, 10);
  db.DB.clusters.push({ id: 900, day_key: today, headline: "기타 소식 모음 삼십번", impact: "low", targets: ["기타소식"], why: "",
    sources: [{ url: "https://t.me/ch/9000", source: "텔레그램: ch", published_at: new Date(NOW - 3600e3).toISOString() }], updates: [], updated_at: new Date(NOW - 1800e3).toISOString() });
  for (let i = 1; i <= 3; i++) db.DB.items.push(tgItem(i, microIso(NOW - 60e3)));
  let seen = "";
  answerWith((prompt) => { seen = prompt; return [{ indices: [1, 2, 3], existing_cluster_ref: 0, headline: "기타 소식 모음", impact: "low", targets: ["기타소식"], note: "이것저것", facts: [] }]; });
  await press(false);
  assert.ok(!seen.includes("기타 소식 모음 삼십번"), "잡동사니 통은 합칠 대상 목록에 안 보여줌");
  const fresh = db.DB.clusters.filter(c => c.id !== 900);
  assert.equal(fresh.length, 3, "글 3개가 카드 3개로 따로");
  assert.equal(db.DB.clusters.find(c => c.id === 900).sources.length, 1, "옛 통은 그대로");
});

test("중요도 이유 한마디(impact_reason)를 카드 이력에 남김", async () => {
  db.DB.items.push(tgItem(1, microIso(NOW - 60e3)));
  answerWith(() => [{ indices: [1], existing_cluster_ref: 0, headline: "HBM 시장 전망 상향", impact: "high", impact_reason: "전망치 변경", targets: ["HBM"], note: "한 줄", facts: ["HBM 시장 2027년 $100 billion"] }]);
  await press(false);
  assert.equal(db.DB.clusters[0].impact, "high");
  assert.equal(db.DB.clusters[0].updates[0].reason, "전망치 변경");
});

// ── 2026-11-28 추가: Gemini 모델 자동 고르기 ──
const gm = (name, methods = ["generateContent"]) => ({ name: `models/${name}`, supportedGenerationMethods: methods });

test("모델 목록에서 가장 새 flash를 고르고, 하루 동안은 목록을 다시 받지 않음", async () => {
  modelList = [gm("gemini-3.5-flash"), gm("gemini-3.8-flash"), gm("gemini-4.0-flash"), gm("gemini-4.0-flash-lite"),
    gm("gemini-4.5-flash-preview"), gm("gemini-9.9-flash", ["embedContent"]), gm("gemini-4.0-pro")];
  db.DB.items.push(tgItem(1, microIso(NOW - 120e3)));
  await press(false);
  assert.equal(new Set(modelsTried).size, 1);
  assert.equal(modelsTried[0], "gemini-4.0-flash", "미리보기·pro·요약 못 하는 모델은 안 고름");
  assert.deepEqual(JSON.parse(db.DB.status.find(r => r.id === 4).last_note).models, ["gemini-4.0-flash", "gemini-4.0-flash-lite", "gemini-3.5-flash-lite"]);
  assert.match(db.DB.status.find(r => r.id === 3).last_note, /gemini-4\.0-flash$/);

  modelList = [gm("gemini-5.0-flash")]; // 새 모델이 나와도 하루가 지나기 전엔 그대로
  modelsTried = [];
  db.DB.items.push(tgItem(2, microIso(NOW - 60e3)));
  await press(true);
  assert.equal(modelsTried[0], "gemini-4.0-flash");
  db.DB.status.find(r => r.id === 4).last_run_at = new Date(NOW - 25 * 3600e3).toISOString(); // 하루 지남
  modelsTried = [];
  db.DB.items.push(tgItem(3, microIso(NOW - 30e3)));
  await press(true);
  assert.equal(modelsTried[0], "gemini-5.0-flash");
});

test("고른 모델을 무료로 못 쓰면(404) 다음 모델로 넘어가서 요약은 계속됨", async () => {
  modelList = [gm("gemini-7.0-flash"), gm("gemini-7.0-flash-lite")];
  missingModels = new Set(["gemini-7.0-flash"]);
  db.DB.items.push(tgItem(1, microIso(NOW - 60e3)));
  const r = await press(false);
  assert.equal(r.code, 200);
  assert.equal(clusterUrls().length, 1);
  assert.equal(modelsTried.at(-1), "gemini-7.0-flash-lite");
  assert.ok(JSON.parse(db.DB.status.find(r => r.id === 4).last_note).bad["gemini-7.0-flash"], "안 되는 모델을 적어 둠");
  modelsTried = [];
  db.DB.items.push(tgItem(2, microIso(NOW - 30e3)));
  await press(true);
  assert.ok(!modelsTried.includes("gemini-7.0-flash"), "다음 실행에서는 안 되는 모델을 건너뜀");
});

// ── 2026-11-28 추가: 옛 기준으로 매긴 오늘 카드를 새 기준으로 다시 봄 ──
test("이유가 안 붙은 오늘 카드는 원문과 함께 다시 보고 중요도·설명·숫자 목록을 새로 저장, 한 번 본 카드는 다시 안 봄", async () => {
  const today = new Date(NOW + 9 * 3600e3).toISOString().slice(0, 10);
  const at = new Date(NOW - 3600e3).toISOString();
  db.DB.items.push(tgItem(1, microIso(NOW - 3 * 3600e3), { summary: "블랙프라이데이 매출 전년 대비 -4.2%, 소비심리지수 51.0" }));
  db.DB.clusters.push({ id: 700, day_key: today, headline: "미국 블랙프라이데이 소비 부진", impact: "low", targets: ["미국 소비"], why: "",
    sources: [{ url: "https://t.me/ch/0001", source: "텔레그램: ch", published_at: at }], updates: [{ at, note: "새로 감지됨" }], updated_at: at });
  db.DB.briefings.push({ id: 0, created_at: new Date(NOW - 60e3).toISOString(), period_to: microIso(NOW - 60e3) }); // 새 글 없음
  rescoreAnswer = [{ index: 1, impact: "high", impact_reason: "전망치 변경", note: "소비 둔화가 숫자로 확인됨", facts: ["블랙프라이데이 매출 전년 대비 -4.2%"] }];
  const r = await press(false);
  assert.equal(r.code, 200);
  assert.match(rescorePrompts[0], /소비심리지수 51\.0/, "원문을 같이 보여줌");
  const c = db.DB.clusters.find(x => x.id === 700);
  assert.equal(c.impact, "high");
  assert.equal(c.why, "소비 둔화가 숫자로 확인됨");
  assert.deepEqual(c.updates.at(-1).facts, ["블랙프라이데이 매출 전년 대비 -4.2%"]);
  assert.equal(c.updates.at(-1).reason, "전망치 변경");
  assert.equal(c.updated_at, at, "카드 순서가 안 흔들리게 시각은 그대로");
  assert.match(db.DB.status.find(s => s.id === 3).last_note, /옛 카드 1개 다시 봄/);
  await press(true);
  assert.equal(rescorePrompts.length, 1, "한 번 본 카드는 다시 안 봄");
});

// ── 2026-11-28 추가: 모음 글에서 나온 카드는 다시 볼 때 그 카드 대목만 읽힘 ──
test("모음 글 조각 카드를 다시 볼 때 글 전체가 아니라 카드 제목에 해당하는 대목만 보여줌", async () => {
  const today = new Date(NOW + 9 * 3600e3).toISOString().slice(0, 10);
  const at = new Date(NOW - 3600e3).toISOString();
  db.DB.items.push(tgItem(1, microIso(NOW - 3 * 3600e3), { title: "글로벌 뉴스 브리핑…",
    summary: "• 미 연방 금융당국이 유나이티드 피델리티 은행을 폐쇄함. • 버라이즌이 광대역 인터넷 사업을 위해 피디엄 인수를 추진함. 인수가는 $2 billion 수준. • 어도비가 블랙프라이데이 매출 전망을 발표함." }));
  db.DB.clusters.push({ id: 701, day_key: today, headline: "버라이즌, 피디엄 인수 추진", impact: "medium", targets: ["버라이즌"], why: "",
    sources: [{ title: "버라이즌, 광대역 인터넷 사업 위해 피디엄 인수 추진", url: "https://t.me/ch/0001", source: "텔레그램: ch", published_at: at }],
    updates: [{ at, note: "새로 감지됨" }], updated_at: at });
  db.DB.briefings.push({ id: 0, created_at: new Date(NOW - 60e3).toISOString(), period_to: microIso(NOW - 60e3) });
  rescoreAnswer = [{ index: 1, headline: "버라이즌, 피디엄 인수 추진", impact: "medium", impact_reason: "개별 회사 소식", importance_score: 5, note: "버라이즌이 피디엄 인수를 추진함", facts: ["인수가 $2 billion 수준"] }];
  await press(false);
  const p = rescorePrompts[0];
  assert.match(p, /피디엄 인수를 추진함/);
  assert.ok(!p.includes("유나이티드 피델리티"), "같은 글의 다른 뉴스는 안 보여줌");
});
