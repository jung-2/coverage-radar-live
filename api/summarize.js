// Vercel 서버리스 함수 — 대시보드의 "브리핑 생성" 버튼이 호출하는 엔드포인트.
// 서비스 키/API 키는 전부 서버사이드 환경변수로만 쓰고, 브라우저에는 절대 노출되지 않음.
//
// 방식: 새로 쌓인 기사/텔레그램 항목을 "한 건씩" Claude에게 검토시켜서
//   - impact(high/medium/low): 특정 종목/산업에 실질적 영향이 있는지
//   - targets: 관련 종목/산업명
//   - why: impact가 medium/high일 때만 2~3문장으로 왜 중요한지
// 를 항목별로 빠짐없이 반환하게 함 (tool-use로 구조화된 JSON 강제).
//
// 필요한 Vercel 환경변수(Settings → Environment Variables):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  — GitHub Actions 시크릿과 같은 값
//   ANTHROPIC_API_KEY                   — console.anthropic.com(=platform.claude.com) 에서 발급받은 API 키

import { createClient } from "@supabase/supabase-js";

const MODEL = "claude-haiku-4-5-20251001";
const MAX_ITEMS = 200;          // 한 번에 분류할 최대 항목 수(비용/토큰 제한용)
const MAX_TOKENS = 8000;        // 항목이 많을 때도 잘리지 않도록 넉넉히
const COOLDOWN_MS = 30 * 1000;  // 연타 방지용 최소 간격
const FALLBACK_WINDOW_MS = 24 * 60 * 60 * 1000; // 이전 브리핑이 없을 때 기본 조회 범위(24시간)

const CAT_LABEL = {
  packaging: "패키징", hbm: "HBM", cpo: "CPO/광인터커넥트", power: "전력반도체",
  ai_server: "AI서버", korea: "한국주식", biotech: "바이오", disclosure: "공시",
  telegram: "텔레그램", other: "기타",
};

const SIGNAL_TOOL = {
  name: "emit_signals",
  description:
    "입력된 헤드라인 목록을 한 건씩 검토해서 분류한 결과를 반환한다. 목록에 있는 모든 항목에 대해 빠짐없이 결과를 반환해야 하며, 절대 건너뛰지 않는다.",
  input_schema: {
    type: "object",
    properties: {
      signals: {
        type: "array",
        description: "입력 헤드라인 목록과 정확히 같은 개수의 판단 결과 배열",
        items: {
          type: "object",
          properties: {
            index: { type: "integer", description: "입력 헤드라인 목록의 번호 (1부터 시작, 목록에 표시된 번호 그대로)" },
            impact: {
              type: "string",
              enum: ["high", "medium", "low"],
              description: "이 소식이 특정 종목/산업에 실질적인 영향을 줄 수 있는지. 이미 알려진 내용의 반복, 일반적인 시황 잡담, 영향이 불분명한 내용은 low",
            },
            targets: {
              type: "array",
              items: { type: "string" },
              description: "영향받는 구체적인 종목명 또는 산업/테마명 (예: 삼성전자, HBM, 전력반도체). 특정 대상이 없으면 빈 배열",
            },
            why: {
              type: "string",
              description: "impact가 medium 또는 high일 때만 채움: 왜 중요한지, 어떤 영향이 예상되는지 2~3문장. 순한글로만 작성(한자 금지), 너무 축약하지 말고 바로 이해되게. impact가 low면 빈 문자열",
            },
          },
          required: ["index", "impact", "targets", "why"],
        },
      },
    },
    required: ["signals"],
  },
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

    // 3) 프롬프트 구성 — 번호를 매겨서 나중에 signals[i].index로 다시 매칭
    const lines = items.map((it, i) => {
      const cat = CAT_LABEL[it.category] || it.category || "기타";
      const tag = it.ticker ? `[${it.ticker}] ` : "";
      return `${i + 1}. (${cat}) ${tag}${it.title} — ${it.source || "출처불명"}`;
    }).join("\n");

    const prompt = `당신은 반도체·AI인프라 섹터를 커버하는 증권사 애널리스트를 돕는 리서치 어시스턴트입니다.
아래는 지난 브리핑 이후 새로 수집된 뉴스/공시/텔레그램 헤드라인 목록(${items.length}건, 번호가 매겨져 있음)입니다.

각 항목을 하나씩 검토해서 emit_signals 도구로 판단 결과를 반환하세요. 규칙:
- 목록의 모든 항목에 대해 빠짐없이 결과를 반환할 것 — 결과 개수가 입력 항목 개수(${items.length}건)와 정확히 같아야 하며, 하나도 건너뛰지 말 것
- impact는 이 소식이 특정 종목이나 산업에 실질적인 영향을 줄 수 있는지로 판단. 이미 알려진 내용의 반복, 일반적인 시황 잡담, 영향이 불분명한 내용은 low로 분류
- targets에는 구체적인 종목명이나 산업/테마명을 적을 것. 특정 대상이 없으면 빈 배열
- why는 impact가 medium 또는 high인 항목에만 2~3문장으로 채울 것 — 왜 중요한지, 어떤 영향이 예상되는지. 순한글로만 작성(한자 금지), 너무 축약하지 말고 읽으면 바로 이해되게. impact가 low면 빈 문자열로 둘 것

헤드라인 목록:
${lines}`;

    // 4) Claude API 호출 (tool-use로 구조화된 JSON 강제)
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        tools: [SIGNAL_TOOL],
        tool_choice: { type: "tool", name: "emit_signals" },
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      throw new Error(`Claude API 오류 ${apiRes.status}: ${errBody.slice(0, 500)}`);
    }

    const apiJson = await apiRes.json();
    const toolUse = (apiJson.content || []).find(b => b.type === "tool_use" && b.name === "emit_signals");
    if (!toolUse || !toolUse.input || !Array.isArray(toolUse.input.signals)) {
      throw new Error("Claude가 구조화된 분류 결과를 반환하지 않음 (형식 오류)");
    }

    // 5) 모델이 반환한 index를 원본 item과 다시 매칭해서 제목/링크/출처를 합침
    const signals = toolUse.input.signals
      .map(s => {
        const item = items[s.index - 1];
        if (!item) return null;
        return {
          impact: ["high", "medium", "low"].includes(s.impact) ? s.impact : "low",
          targets: Array.isArray(s.targets) ? s.targets.filter(Boolean) : [],
          why: typeof s.why === "string" ? s.why.trim() : "",
          title: item.title,
          url: item.url,
          source: item.source,
          published_at: item.published_at,
          category: item.category,
        };
      })
      .filter(Boolean);

    if (!signals.length) throw new Error("분류 결과를 원본 항목과 매칭하지 못함");

    const highCount = signals.filter(s => s.impact === "high").length;
    const medCount = signals.filter(s => s.impact === "medium").length;

    // 6) 결과 저장
    const { data: saved, error: saveErr } = await sb
      .from("briefings")
      .insert({
        period_from: periodFrom.toISOString(),
        period_to: periodTo.toISOString(),
        item_count: items.length,
        content: `${items.length}건 검토 · 높음 ${highCount}건, 중간 ${medCount}건`,
        signals,
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
