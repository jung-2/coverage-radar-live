// Vercel 서버리스 함수 — 5분마다 불리는 "자동 처리" 한 번(2026-11-26 추가).
//   1) 텔레그램/추적 키워드 수집(api/poll.js의 collectDue — 4분 안에 이미 돌았으면 건너뜀)
//   2) 새로 쌓인 텔레그램 글 요약 + 중요도 분류(api/summarize.js — 잠금이 있어서 겹쳐 불려도 한 번만 돎)
// 부르는 쪽:
//   - Supabase pg_cron(supabase/auto-schedule.sql): 화면을 안 열어 둬도 5분마다 — 주 경로
//   - 대시보드 화면(web/index.html의 autoCollect): 열어 두면 5분마다 — pg_cron이 아직 설정 안 됐거나 멈췄을 때 대비
// 브라우저 주소창에 /api/tick을 쳐서 열어도 한 번 돌고 결과(JSON)가 보임 — 잘 도는지 확인용.

import { createClient } from "@supabase/supabase-js";
import { collectDue } from "./poll.js";
import summarize from "./summarize.js";

export default async function handler(req, res) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: "서버 환경변수(SUPABASE_URL/SUPABASE_SERVICE_KEY)가 설정되지 않음" });
    return;
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const by = (req.query && req.query.by) || "unknown";

  let collect;
  try {
    collect = await collectDue(sb, by === "cron" ? "자동 예약" : "화면");
  } catch (err) {
    collect = { error: String(err.message || err) };
  }

  // 요약은 summarize.js 핸들러를 그대로 부름(잠금·이어서 처리·재시도 전부 그쪽에 있음)
  let code = 200, body = {};
  const capture = { status(c) { code = c; return capture; }, json(j) { body = j; } };
  await summarize({ method: "POST", body: { run_at: new Date().toISOString() } }, capture);

  res.status(200).json({ collect, summarize: { code, ...body } });
}
