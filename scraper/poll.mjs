// 커버리지 레이더 라이브 — 수집 스크립트(GitHub Actions용 껍데기)
// .github/workflows/poll-telegram.yml, poll-keywords.yml이 "5분마다"로 설정돼 있지만, GitHub가 무료 저장소의
// 예약 실행을 미뤄서 실제로는 6~10시간에 한 번 정도만 돎(2026-11 확인). 그래서 지금 주 수집 경로는
// 대시보드가 5분마다 부르는 api/poll.js이고, 이건 화면을 아무도 안 열어 둘 때를 위한 예비용.
// 실제 수집 로직은 scraper/collect.mjs에 있음(둘이 같이 씀).
//
// 실행 방식: node scraper/poll.mjs telegram   — 텔레그램 채널만
//            node scraper/poll.mjs keywords   — 추적 키워드만(Google News)
// 로컬에서 테스트하려면: SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scraper/poll.mjs telegram

import { createClient } from "@supabase/supabase-js";
import { runCollect } from "./collect.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_KEY 환경변수가 없습니다.");
  process.exit(1);
}

const MODE = process.argv[2];
if (MODE !== "telegram" && MODE !== "keywords") {
  console.error("사용법: node scraper/poll.mjs telegram|keywords");
  process.exit(1);
}

runCollect(createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY), MODE, { trigger: "github" }).catch((err) => {
  console.error("poll 실행 중 오류:", err);
  process.exit(1);
});
