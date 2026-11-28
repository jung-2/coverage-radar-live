// api/tick.js 시험 — 5분마다 한 번: 수집(가짜 t.me) → 요약(가짜 Gemini)이 이어서 도는지.
// 실행: npm test
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./mock-supabase.mjs";

let db = makeDb();
mock.module("@supabase/supabase-js", { namedExports: { createClient: () => db.client } });
process.env.SUPABASE_URL = "x"; process.env.SUPABASE_SERVICE_KEY = "x"; process.env.GEMINI_API_KEY = "x";
const { default: tick } = await import("../api/tick.js");

const NOW = Date.now();
globalThis.fetch = async (url, opt) => {
  const u = new URL(url);
  if (u.host === "t.me") {
    const html = [1, 2, 3].map(id => `<div class="tgme_widget_message js-widget_message" data-post="ch/${id}">
      <div class="tgme_widget_message_text js-message_text">ch 글 ${id}</div>
      <time datetime="${new Date(NOW - (4 - id) * 60e3).toISOString()}">x</time></div>`).join("");
    return { ok: true, text: async () => html };
  }
  assert.match(u.host, /generativelanguage\.googleapis\.com/);
  if (!opt || !opt.body) return { ok: true, json: async () => ({ models: [] }) };
  const body = JSON.parse(opt.body);
  const name = body.tools[0].functionDeclarations[0].name;
  const n = Number(body.contents[0].parts[0].text.match(/총 (\d+)건/)?.[1] || 0);
  const args = name === "split_telegram_digests" ? { splits: [] } : {
    updates: Array.from({ length: n }, (_, i) => ({ indices: [i + 1], existing_cluster_ref: 0, headline: `사건 ${i}`,
      impact: i === 0 ? "high" : "low", impact_reason: "전망치 변경", targets: [`회사${i}`], note: i === 0 ? "중요한 이유" : "", facts: i === 0 ? ["전망치 10% 상향"] : [] })),
  };
  return { ok: true, json: async () => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ functionCall: { name, args } }] } }] }) };
};

test("한 번 부르면 새 텔레그램 글을 모으고 바로 요약·중요도 분류까지 함", async () => {
  db.DB.telegram_channels.push({ handle: "ch" });
  db.DB.status.push({ id: 1, last_run_at: null }, { id: 2, last_run_at: new Date().toISOString() });
  let out;
  await tick({ method: "POST", query: { by: "cron" } }, { status(c) { this.code = c; return this; }, json(j) { out = { code: this.code, ...j }; } });
  assert.equal(out.code, 200);
  assert.equal(out.collect.find(x => x.mode === "telegram").inserted, 3);
  assert.equal(out.summarize.code, 200);
  assert.equal(out.summarize.item_count, 3);
  assert.equal(db.DB.clusters.filter(c => c.impact === "high").length, 1);
  assert.match(db.DB.status.find(r => r.id === 1).last_note, /자동 예약/);
});
