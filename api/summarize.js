// Vercel 서버리스 함수 — 대시보드의 "브리핑 생성" 버튼이 호출하는 엔드포인트.
// 서비스 키/API 키는 전부 서버사이드 환경변수로만 쓰고, 브라우저에는 절대 노출되지 않음.
//
// 필요한 Vercel 환경변수(Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  — GitHub Actions 시크릿과 같은 값
//   ANTHROPIC_API_KEY                   — console.anthropic.com 에서 발급받은 API 키(채팅 구독과 별개)

import { createClient } from "@supabase/supabase-js";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_ITEMS = 250;          // 프롬프트에 넣을 최대 항목 수(비용/토큰 제한용)
const COOLDOWN_MS = 30 * 1000;  // 연타 방지용 최소 간격
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000; // 이전 브리핑이 없을 때 기본 조회 범위(24시간)

const CAT_LABEL = {
  packaging: "패키징", hbm: "HBM", cpo: "CPO/광인터커넥트", power: "전력반도체",
  ai_server: "AI서버", korea: "한국주식", biotech: "바이오", disclosure: "공시",
  telegram: "텔레그램", other: "기타",
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST만 지원함" });
    return;
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "서버 환경변수(SUPABASE_URL/SUPABASE_SERVICE_KEY/ANTHROPIC_API_KEY)가 설정되지 않음" });
    return;
  }

  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    // 1) 마지막 브리핑 시점 확인 (연타 방지 + 조회 범위 산정)
    const { data: lastBriefing } = await sb
      .from("briefings")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (lastBriefing?.created_at) {
      const elapsed = Date.now() - new Date(lastBriefing.created_at).getTime();
      if (elapsed < COOLDOWN_MS) {
        res.status(429).json({ error: `너무 빠른 요청임. ${Math.ceil((COOLDOWN_MS - elapsed) / 1000)}초 후 다시 시도해줘.` });
        return;
      }
    }

    const periodFrom = lastBriefing?.created_at
      ? new Date(lastBriefing.created_at)
      : new Date(Date.now() - FALLBACK_WINDOW_MS);
    const periodTo = new Date();

    // 2) 그 이후 새로 쌓인 항목 가져오기
    const { data: items, error: itemsErr } = await sb
      .from("items")
      .select("title, url, source, category, sentiment, importance, ticker, published_at")
      .gte("added_at", periodFrom.toISOString())
      .order("published_at", { ascending: false })
      .limit(MAX_ITEMS);

    if (itemsErr) throw itemsErr;

    if (!items || items.length === 0) {
      res.status(200).json({
        skipped: true,
        message: "마지막 브리핑 이후로 새로 쌓인 기사가 없음.",
        period_from: periodFrom.toISOString(),
        period_to: periodTo.toISOString(),
      });
      return;
    }

    // 3) 프롬프트 구성 (원문 전체가 아니라 이미 수집 단계에서 뽑은 제목/메타데이터만 사용)
    const lines = items.map(it => {
      const cat = CAT_LABEL[it.category] || it.category || "기타";
      const tag = it.ticker ? `[${it.ticker}] ` : "";
      return `- (${cat}/${it.sentiment}/${it.importance}) ${tag}${it.title} — ${it.source || "출처불명"}`;
    }).join("\n");

    const prompt = `당신은 반도체·AI인프라 섹터를 커버하는 증권사 애널리스트를 돕는 리서치 어시스턴트입니다.
아래는 지난 브리핑 이후 새로 수집된 뉴스/공시/텔레그램 헤드라인 목록(${items.length}건, 카테고리/감성/중요도 태그 포함)입니다.
이걸 바탕으로 애널리스트가 몇 분 안에 훑어볼 수 있는 브리핑을 작성하세요.

작성 규칙:
- 한자 사용 금지, 순한글로만 작성
- 개별 항목을 그냥 나열하지 말고, 서로 관련된 것끼리 묶어서 맥락이 이해되도록 문장으로 서술
- 실제로 등장한 카테고리 위주로 소제목을 나눠서 정리하고, 카테고리명을 소제목으로 한 줄에 쓴 뒤 빈 줄 하나 띄우고 본문 작성
- importance=high 항목과 sentiment가 beat/miss인 항목은 반드시 언급하고 왜 중요한지 코멘트
- 너무 축약하지 말고, 읽으면 바로 이해될 정도로 충분히 설명(핵심어만 나열 금지)
- 마크다운 기호(#, *, - 등) 쓰지 말고 순수 텍스트로만 작성
- 서두에 "다음은 브리핑입니다" 같은 군더더기 없이 바로 본문 시작

헤드라인 목록:
${lines}`;

    // 4) Claude API 호출
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 2000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      throw new Error(`Claude API 오류 ${apiRes.status}: ${errBody.slice(0, 500)}`);
    }

    const apiJson = await apiRes.json();
    const content = (apiJson.content || []).map(b => b.text || "").join("").trim();

    if (!content) throw new Error("Claude API 응답에 텍스트가 없음");

    // 5) 결과 저장 (소스 목록도 함께 저장 — 대시보드에서 "소스 보기"로 펼쳐볼 수 있게)
    const sources = items.map(it => ({
      title: it.title, url: it.url, source: it.source, published_at: it.published_at,
    }));

    const { data: saved, error: saveErr } = await sb
      .from("briefings")
      .insert({
        period_from: periodFrom.toISOString(),
        period_to: periodTo.toISOString(),
        item_count: items.length,
        content,
        sources,
      })
      .select()
      .single();

    if (saveErr) throw saveErr;

    res.status(200).json({ skipped: false, briefing: saved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
