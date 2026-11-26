// Vercel 서버리스 함수 — 텔레그램/추적 키워드 수집을 실행함(2026-11-26 추가).
// GitHub Actions 예약 실행이 "5분마다"로 설정돼 있어도 실제론 6~10시간에 한 번만 돌아서 데이터가 계속 묵었음.
// 그래서 대시보드(web/index.html)를 열어 두면 화면이 5분마다 이걸 불러서 직접 수집하게 함. GitHub Actions는 예비용으로 남겨 둠.
// 실제 수집 로직은 scraper/collect.mjs(GitHub Actions와 같은 코드).
//
// 누가 막 불러도 괜찮게: 종류별로 마지막 수집 후 MIN_INTERVAL_MS가 안 지났으면 건너뜀.
// 이 확인은 "조건부 update로 자리 잡기"로 해서, 탭 여러 개가 동시에 불러도 한 번만 돎.
//
// 필요한 Vercel 환경변수: SUPABASE_URL, SUPABASE_SERVICE_KEY (summarize.js와 같은 값)

import { createClient } from "@supabase/supabase-js";
import { runCollect } from "../scraper/collect.mjs";

const MIN_INTERVAL_MS = 4 * 60 * 1000;
const STATUS_ID = { telegram: 1, keywords: 2 };

// 이번에 내가 돌릴 차례인지 — 마지막 수집이 MIN_INTERVAL_MS 전보다 오래됐을 때만 last_run_at을 지금으로 바꾸고 true
async function claim(sb, mode) {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - MIN_INTERVAL_MS).toISOString();
  const { data, error } = await sb
    .from("status")
    .update({ last_run_at: now.toISOString() })
    .eq("id", STATUS_ID[mode])
    .lt("last_run_at", staleBefore)
    .select("id");
  if (error) throw error;
  if (data && data.length) return true;
  // status 줄 자체가 아직 없거나 시각이 비어 있으면(처음) 그냥 돌림 — runCollect가 채워 줌
  const { data: row } = await sb.from("status").select("id, last_run_at").eq("id", STATUS_ID[mode]).maybeSingle();
  if (row && row.last_run_at) return false;
  if (row) await sb.from("status").update({ last_run_at: now.toISOString() }).eq("id", STATUS_ID[mode]); // 실패해도 4분간은 다시 안 돌게
  return true;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST만 지원함" });
    return;
  }
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    res.status(500).json({ error: "서버 환경변수(SUPABASE_URL/SUPABASE_SERVICE_KEY)가 설정되지 않음" });
    return;
  }
  const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  try {
    const results = await Promise.all(["telegram", "keywords"].map(async (mode) => {
      if (!(await claim(sb, mode))) return { mode, skipped: true };
      try {
        return await runCollect(sb, mode, { trigger: "화면" });
      } catch (err) {
        console.error(`${mode} 수집 실패:`, err);
        return { mode, error: String(err.message || err) };
      }
    }));
    res.status(200).json({ results });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
}
