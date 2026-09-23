// 커버리지 레이더 라이브 — 수집 스크립트
// GitHub Actions에서 5분 간격으로 이 파일을 실행함(.github/workflows/poll.yml 참고).
// 로컬에서 테스트하려면: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scraper/poll.mjs

import { createClient } from "@supabase/supabase-js";
import Parser from "rss-parser";
import { FIXED_THEMES, KEYWORD_BATCH_SIZE, categorize, guessSentiment, guessImportance } from "./sources.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY 환경변수가 없습니다.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const rss = new Parser({ timeout: 15000 });

function googleNewsUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ko&gl=KR&ceid=KR:ko`;
}

function splitTitleSource(rawTitle) {
  // Google News 타이틀은 보통 "기사 제목 - 매체명" 형태
  const idx = rawTitle.lastIndexOf(" - ");
  if (idx === -1) return { title: rawTitle, source: "Google News" };
  return { title: rawTitle.slice(0, idx), source: rawTitle.slice(idx + 3) };
}

async function fetchKeywordItems(keyword) {
  try {
    const feed = await rss.parseURL(googleNewsUrl(keyword));
    return (feed.items || []).slice(0, 8).map((it) => {
      const { title, source } = splitTitleSource(it.title || "");
      const text = `${title} ${it.contentSnippet || ""}`;
      return {
        title,
        summary: (it.contentSnippet || "").slice(0, 300),
        url: it.link,
        source,
        source_type: "newswire",
        category: categorize(text),
        keyword_match: keyword,
        sentiment: guessSentiment(text),
        importance: guessImportance(text),
        published_at: it.isoDate || it.pubDate || new Date().toISOString(),
      };
    });
  } catch (err) {
    console.error(`[keyword] ${keyword} 실패:`, err.message);
    return [];
  }
}

async function fetchTelegramItems(handle) {
  try {
    const res = await fetch(`https://t.me/s/${handle}`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; coverage-radar-bot/1.0)" },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const blocks = html.split('class="tgme_widget_message ').slice(1);
    const items = [];
    for (const block of blocks.slice(-20)) {
      const postMatch = block.match(/data-post="([^"]+)"/);
      const timeMatch = block.match(/<time[^>]*datetime="([^"]+)"/);
      const textMatch = block.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
      if (!postMatch || !timeMatch) continue;
      const rawText = textMatch ? textMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
      if (!rawText) continue;
      const title = rawText.length > 60 ? rawText.slice(0, 60) + "…" : rawText;
      items.push({
        title,
        // 뉴스정리/브리핑 스타일 글은 꽤 길 수 있어서 넉넉하게 저장(2026-09-23 늘림) —
        // summarize.js의 텔레그램 다중뉴스 분리 단계가 원문 전체를 봐야 정확히 쪼갤 수 있음.
        summary: rawText.slice(0, 3000),
        url: `https://t.me/${postMatch[1]}`,
        source: `텔레그램: ${handle}`,
        source_type: "telegram",
        category: categorize(rawText),
        keyword_match: null,
        sentiment: guessSentiment(rawText),
        importance: guessImportance(rawText),
        published_at: timeMatch[1],
      });
    }
    return items;
  } catch (err) {
    console.error(`[telegram] ${handle} 실패:`, err.message);
    return [];
  }
}

async function main() {
  const [{ data: keywordRows }, { data: channelRows }, { data: cursorRow }] = await Promise.all([
    supabase.from("keywords").select("term").order("term"),
    supabase.from("telegram_channels").select("handle"),
    supabase.from("poll_cursor").select("idx").eq("id", 1).single(),
  ]);

  const keywords = (keywordRows || []).map((r) => r.term);
  const channels = (channelRows || []).map((r) => r.handle);
  const startIdx = cursorRow?.idx || 0;
  const batch = [];
  for (let i = 0; i < Math.min(KEYWORD_BATCH_SIZE, keywords.length); i++) {
    batch.push(keywords[(startIdx + i) % keywords.length]);
  }
  const nextIdx = keywords.length ? (startIdx + KEYWORD_BATCH_SIZE) % keywords.length : 0;

  console.log(`고정 테마 ${FIXED_THEMES.length}개 + 키워드 ${batch.length}개(전체 ${keywords.length}개 중) + 텔레그램 채널 ${channels.length}개 조회`);

  const searchTerms = [...FIXED_THEMES, ...batch];
  const results = await Promise.all([
    ...searchTerms.map(fetchKeywordItems),
    ...channels.map(fetchTelegramItems),
  ]);
  const allItems = results.flat().filter((it) => it.url && it.title);

  console.log(`수집된 원시 항목: ${allItems.length}건 (중복은 DB unique(url)에서 자동 무시)`);

  let inserted = 0;
  if (allItems.length) {
    // url 중복은 upsert + ignoreDuplicates로 DB 레벨에서 처리 (경합 조건에도 안전)
    const { data, error } = await supabase
      .from("items")
      .upsert(allItems, { onConflict: "url", ignoreDuplicates: true })
      .select("id");
    if (error) {
      console.error("insert 실패:", error.message);
    } else {
      inserted = data?.length || 0;
    }
  }

  await supabase.from("poll_cursor").update({ idx: nextIdx }).eq("id", 1);

  const { count } = await supabase.from("items").select("id", { count: "exact", head: true });

  await supabase
    .from("status")
    .update({
      last_run_at: new Date().toISOString(),
      last_note: `이번 실행: 신규 ${inserted}건 (검색 ${searchTerms.length}개 + 텔레그램 ${channels.length}개)`,
      total_items: count || 0,
    })
    .eq("id", 1);

  console.log(`신규 저장: ${inserted}건, 전체 누적: ${count}건`);
}

main().catch((err) => {
  console.error("poll 실행 중 오류:", err);
  process.exit(1);
});
