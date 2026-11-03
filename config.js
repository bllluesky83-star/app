// 회식 장소 추천기 설정값 (PRD 7.3)
// 지도 API 키 없이 동작한다: 후보는 지도 검색 링크로 찾아 직접 입력하고,
// 날씨 위치는 Nominatim(오픈스트리트맵, 키 불필요)으로 찾는다.
window.APP_CONFIG = {
  BAYES_M: 50,               // 베이지안 평균 기준 리뷰 수
  BAYES_C_MIN_CANDIDATES: 5, // 별점 있는 후보가 이보다 적으면 평균 별점(C) 대신 아래 기본값 사용
  BAYES_C_DEFAULT: 4.0,      // 후보가 적을 때 쓰는 평균 별점(C)
  RAIN_PROB_THRESHOLD: 60,   // 비 예보 판정 강수확률(%)
  DINNER_HOURS: [18, 22],    // 비 예보 판정 시간대 (시작시, 끝시 포함)
  TOP_N: 5,                  // 순위 표시 개수
  FORECAST_DAYS: 16,         // Open-Meteo 예보 제공 일수 (오늘 포함)
  GEOCODE_TIMEOUT_MS: 4000,  // 지역 위치 찾기 제한 시간
  WEATHER_TIMEOUT_MS: 4000,  // 날씨 조회 제한 시간
};
