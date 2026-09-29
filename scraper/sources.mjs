// 한 번 실행(poll)당 사용자 키워드(keywords 테이블, 전부 기업명)에서 몇 개씩 순환할지.
// 키워드 GROUP_SIZE개를 "A" OR "B" 한 번의 검색으로 묶어서 조회하므로(poll.mjs 참고)
// 실제 Google News 요청 수는 KEYWORD_BATCH_SIZE / GROUP_SIZE개. 5분 주기 실행 기준으로
// 전체 목록이 한 바퀴 도는 시간 = 키워드 수 / KEYWORD_BATCH_SIZE * 5분.
export const KEYWORD_BATCH_SIZE = 300; // 키워드 수보다 크면 매 실행마다 전체를 다 돎(한 바퀴 = 5분 이하)
export const GROUP_SIZE = 2;        // 한 검색에 묶을 키워드 수(크면 큰 회사가 결과를 독차지해 작은 회사 기사가 빠짐 — 4개 테스트 시 1건까지 줄었음)
export const CONCURRENCY = 5;       // Google News 동시 요청 수(너무 많으면 429 차단)
export const PER_KEYWORD_LIMIT = 8; // 키워드 하나당 저장할 최대 기사 수

// 카테고리 분류용 키워드 매핑 — 제목+요약에 아래 단어가 들어있으면 해당 카테고리로 태깅
export const CATEGORY_RULES = [
  ["packaging", ["CoWoS", "CoPoS", "패키징", "OSAT", "TCB", "본딩"]],
  ["hbm", ["HBM", "고대역폭메모리", "D램", "DRAM", "메모리"]],
  ["cpo", ["CPO", "광인터커넥트", "포토닉스", "실리콘포토닉스", "옵틱스", "트랜시버", "레이저"]],
  ["power", ["800VDC", "전력반도체", "GaN", "SiC", "전류센서", "파워"]],
  ["ai_server", ["AI서버", "capex", "캐펙스", "데이터센터", "하이퍼스케일러", "GPU"]],
  ["korea", ["삼성전자", "SK하이닉스", "DB하이텍", "코스닥", "코스피", "원화"]],
  ["biotech", ["GLP-1", "비만치료제", "바이오", "임상", "신약", "제약"]],
  ["disclosure", ["공시", "매출 발표", "월매출", "실적발표", "DART"]],
];

export function categorize(text) {
  for (const [cat, words] of CATEGORY_RULES) {
    if (words.some((w) => text.includes(w))) return cat;
  }
  return "other";
}

const BEAT_WORDS = ["상향", "호조", "급등", "확대", "beat", "surge", "record", "growth", "돌파", "증가"];
const MISS_WORDS = ["하향", "급락", "부진", "우려", "miss", "cut", "decline", "감소", "축소"];
const NOTE_WORDS = ["경고", "지연", "리스크", "조정", "note", "delay", "risk"];

export function guessSentiment(text) {
  if (BEAT_WORDS.some((w) => text.includes(w))) return "beat";
  if (MISS_WORDS.some((w) => text.includes(w))) return "miss";
  if (NOTE_WORDS.some((w) => text.includes(w))) return "note";
  return "neutral";
}

export function guessImportance(text) {
  const HIGH = ["목표주가", "실적", "HBM4", "capex", "공시", "M&A", "인수"];
  if (HIGH.some((w) => text.includes(w))) return "high";
  return "medium";
}
