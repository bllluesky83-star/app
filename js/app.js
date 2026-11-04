(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const params = new URLSearchParams(location.search);
  // 테스트용: ?rain=70 처럼 강수확률을 강제로 지정해 비 예보 규칙을 시험할 수 있다.
  const RAIN_OVERRIDE = params.has('rain') ? Number(params.get('rain')) : null;

  const $app = document.getElementById('app');
  const GENRES = ['전체', '한식', '중식', '일식', '양식'];
  const PLACE_GENRES = ['한식', '중식', '일식', '양식', '기타'];
  const SPACES = [['any', '상관없음'], ['room', '룸'], ['outdoor', '야장']];
  const DAY_SHORT = ['일', '월', '화', '수', '목', '금', '토'];
  const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]; // 월요일부터 표시
  const TRI = [['yes', '있음'], ['no', '없음'], ['unknown', '확인필요']];
  const PARKING_OPTS = [['yes', '가능'], ['no', '불가'], ['unknown', '확인필요']];
  const RESERVATION_OPTS = [
    ['phone', '전화'], ['naver', '네이버예약'], ['catchtable', '캐치테이블'],
    ['walkin', '현장'], ['etc', '기타'], ['unknown', '확인필요'],
  ];

  const state = {
    input: null,
    weather: null,          // { key, value }
    renderToken: 0,
  };

  // ---------------------------------------------------------------------------
  // 저장소 (localStorage). 실패해도 화면이 깨지지 않게 한다.
  // places: 직접 입력한 후보 / placeNotes: 직접 확인한 정보 / history: 회식 기록
  // ---------------------------------------------------------------------------
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
        return true;
      } catch (e) {
        return false;
      }
    },
  };

  function getPlaces() {
    const p = store.get('places', {});
    return p && typeof p === 'object' ? p : {};
  }
  function getPlace(id) {
    return getPlaces()[id] || null;
  }
  function getNotes() {
    const n = store.get('placeNotes', {});
    return n && typeof n === 'object' ? n : {};
  }
  function getNote(id) {
    return getNotes()[id] || {};
  }
  function saveNote(id, note) {
    const all = getNotes();
    all[id] = { ...note, updatedAt: isoNow() };
    return store.set('placeNotes', all);
  }
  function getHistory() {
    const h = store.get('history', []);
    return Array.isArray(h) ? h : [];
  }
  function historyFor(id) {
    return getHistory()
      .filter((h) => h.placeId === id)
      .sort((a, b) => (a.date < b.date ? 1 : -1));
  }

  // ---------------------------------------------------------------------------
  // 유틸
  // ---------------------------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[c]);
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function parseDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  function weekdayOf(s) { return parseDate(s).getDay(); }
  function daysFromToday(s) {
    return Math.round((parseDate(s) - parseDate(todayStr())) / 86400000);
  }
  function fmtShort(s) {
    const d = parseDate(s);
    return `${d.getMonth() + 1}/${d.getDate()}(${DAY_SHORT[d.getDay()]})`;
  }
  function fmtMonthDay(s) {
    const d = parseDate(s);
    return `${d.getMonth() + 1}월 ${d.getDate()}일`;
  }
  function isoNow() {
    const d = new Date();
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + Math.random().toString(36).slice(2);
  }
  function normArea(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
  function isHttpUrl(s) { return /^https?:\/\//i.test(String(s || '').trim()); }

  async function fetchJson(url, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), { status: res.status });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  let toastTimer;
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2000);
  }

  function defaultInput() {
    const last = store.get('lastInput', null) || {};
    const date = last.date && last.date >= todayStr() ? last.date : todayStr();
    return {
      area: typeof last.area === 'string' ? last.area : '',
      date,
      people: Number(last.people) > 0 ? Number(last.people) : 10,
      genre: GENRES.includes(last.genre) ? last.genre : '전체',
      space: ['any', 'room', 'outdoor'].includes(last.space) ? last.space : 'any',
      parking: !!last.parking,
    };
  }
  function currentInput() {
    if (!state.input) state.input = defaultInput();
    return state.input;
  }

  // ---------------------------------------------------------------------------
  // 지도 검색 링크 (키 불필요). 앱이 결과를 읽어오지 않고 사용자가 새 탭에서 본다.
  // ---------------------------------------------------------------------------
  function buildQuery(input) {
    const area = input.area.trim();
    return input.genre === '전체' ? `${area} 맛집` : `${area} ${input.genre} 맛집`;
  }
  // 순위 화면의 지도 탭. embed는 이 화면 안에 띄우는 주소, link는 새 탭으로 여는 주소.
  // 카카오맵 PC 화면은 다른 사이트 안에 표시하는 것을 막아 두어서 모바일 웹 화면을 띄운다.
  // 네이버는 PC 지도 왼쪽 목록에 쓰는 플레이스 음식점 목록(pcmap.place.naver.com)을 띄운다.
  // 모바일 목록(m.place.naver.com)은 수시로 검색 페이지(m.search.naver.com, 다른 사이트 안 표시 금지)로 넘겨 빈 칸이 된다.
  // 그래도 빈 칸이 될 때를 대비해 지도 칸 뒤 안내와 '다시 불러오기'·'열기' 버튼을 둔다.
  // embed를 null로 두면 그 탭은 화면 안에 띄우지 않고 새 탭으로 연다.
  const MAP_TABS = [
    {
      key: 'naver', label: '네이버지도',
      embed: (q) => `https://pcmap.place.naver.com/restaurant/list?query=${encodeURIComponent(q)}`,
      link: (q) => `https://map.naver.com/p/search/${encodeURIComponent(q)}`,
    },
    {
      key: 'google', label: '구글 지도',
      embed: (q) => `https://www.google.com/maps?q=${encodeURIComponent(q)}&output=embed&hl=ko`,
      link: (q) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`,
    },
    {
      key: 'kakao', label: '카카오맵',
      // #!/all/map/place: 목록 대신 지도에 검색된 식당 핀을 찍은 화면으로 바로 연다 (위쪽 '목록' 버튼으로 목록 전환)
      embed: (q) => `https://m.map.kakao.com/actions/searchView?q=${encodeURIComponent(q)}#!/all/map/place`,
      link: (q) => `https://map.kakao.com/?q=${encodeURIComponent(q)}`,
    },
  ];

  // ---------------------------------------------------------------------------
  // 날씨: 지역 위치(Nominatim) → 강수확률(Open-Meteo). 둘 다 키 불필요.
  // 결과: { status: 'ok', maxProb, rain } | { status: 'none' } | { status: 'error' }
  // ---------------------------------------------------------------------------
  async function geocode(area) {
    // geoCache2: 같은 이름의 다른 동네(예: 성수동 → 제주)로 잘못 저장된 예전 geoCache는 버린다
    const cache = store.get('geoCache2', {}) || {};
    const key = normArea(area);
    if (cache[key]) return cache[key];
    // 동·역 이름뿐 아니라 건물 이름(예: 판교 알파돔타워)도 찾는다.
    // 못 찾으면 뒤 낱말을 하나씩 떼며 다시 찾는다 (예: "알파돔타워 3층" → "알파돔타워")
    const words = area.trim().split(/\s+/);
    let pt = null;
    for (let n = words.length; n >= 1 && !pt; n--) {
      const q = words.slice(0, n).join(' ');
      pt = await geocodePhoton(q).catch(() => null) || await geocodeNominatim(q).catch(() => null);
    }
    if (!pt) return null;
    cache[key] = pt;
    store.set('geoCache2', cache);
    return pt;
  }
  // Photon(오픈스트리트맵, 키 불필요): 서울 근처 결과를 먼저 고르고 한국 밖은 뺀다
  async function geocodePhoton(q) {
    const url = 'https://photon.komoot.io/api/?' + new URLSearchParams({
      q, limit: '1', lat: '37.5665', lon: '126.978', bbox: '124.5,33,131.9,38.7',
    });
    const json = await fetchJson(url, CFG.GEOCODE_TIMEOUT_MS);
    const f = json && json.features && json.features[0];
    return f ? { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] } : null;
  }
  async function geocodeNominatim(q) {
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      format: 'jsonv2', limit: '1', countrycodes: 'kr', 'accept-language': 'ko', q,
    });
    const list = await fetchJson(url, CFG.GEOCODE_TIMEOUT_MS);
    return Array.isArray(list) && list.length ? { lat: Number(list[0].lat), lng: Number(list[0].lon) } : null;
  }

  // WMO 날씨 코드 → 아이콘 종류 (뒤로 갈수록 궂은 날씨)
  const KIND_ORDER = ['clear', 'partly', 'cloudy', 'fog', 'rain', 'snow', 'storm'];
  function weatherKind(code) {
    if (code <= 1) return 'clear';
    if (code === 2) return 'partly';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'storm';
    return 'rain';
  }

  async function getWeather(area, date) {
    if (RAIN_OVERRIDE != null && !Number.isNaN(RAIN_OVERRIDE)) {
      return { status: 'ok', maxProb: RAIN_OVERRIDE, rain: RAIN_OVERRIDE >= CFG.RAIN_PROB_THRESHOLD };
    }
    const diff = daysFromToday(date);
    if (diff < 0 || diff >= CFG.FORECAST_DAYS) return { status: 'none' };
    try {
      const pt = await geocode(area);
      if (!pt) return { status: 'error' };
      const url = 'https://api.open-meteo.com/v1/forecast?' + new URLSearchParams({
        latitude: pt.lat.toFixed(4),
        longitude: pt.lng.toFixed(4),
        hourly: 'precipitation_probability,weather_code,temperature_2m',
        timezone: 'auto',
        start_date: date,
        end_date: date,
      });
      const json = await fetchJson(url, CFG.WEATHER_TIMEOUT_MS);
      const times = (json.hourly && json.hourly.time) || [];
      const probs = (json.hourly && json.hourly.precipitation_probability) || [];
      const codes = (json.hourly && json.hourly.weather_code) || [];
      const temps = (json.hourly && json.hourly.temperature_2m) || [];
      const [from, to] = CFG.DINNER_HOURS;
      const vals = [];
      const kinds = [];
      const degs = [];
      times.forEach((t, i) => {
        const hour = Number(t.slice(11, 13));
        if (!t.startsWith(date) || hour < from || hour > to) return;
        if (typeof probs[i] === 'number') vals.push(probs[i]);
        if (typeof codes[i] === 'number') kinds.push(weatherKind(codes[i]));
        if (typeof temps[i] === 'number') degs.push(temps[i]);
      });
      if (!vals.length) return { status: 'none' };
      const maxProb = Math.max(...vals);
      // 저녁 시간 중 가장 궂은 날씨를 대표로 쓴다
      const kind = kinds.length ? kinds.reduce((a, b) => (KIND_ORDER.indexOf(b) > KIND_ORDER.indexOf(a) ? b : a)) : null;
      const temp = degs.length ? Math.round(degs.reduce((s, x) => s + x, 0) / degs.length) : null;
      return { status: 'ok', maxProb, rain: maxProb >= CFG.RAIN_PROB_THRESHOLD, kind, temp };
    } catch (e) {
      return e && e.status === 400 ? { status: 'none' } : { status: 'error' };
    }
  }

  async function ensureWeather(input) {
    const key = normArea(input.area) + '|' + input.date;
    if (state.weather && state.weather.key === key && state.weather.value.status !== 'error') return state.weather.value;
    const value = await getWeather(input.area.trim(), input.date);
    state.weather = { key, value };
    return value;
  }

  // ---------------------------------------------------------------------------
  // 후보 선별·점수·판정 규칙
  // ---------------------------------------------------------------------------
  function matchesInput(place, input) {
    const a = normArea(place.area);
    const b = normArea(input.area);
    const areaOk = a && b && (a === b || (a.length >= 2 && b.includes(a)) || (b.length >= 2 && a.includes(b)));
    return areaOk && (input.genre === '전체' || place.genre === input.genre);
  }

  // 종합점수 = (v×R + m×C) ÷ (v+m), R = 별점, v = 방문자 수(저장 필드 이름은 reviews), C = 이번 후보 전체 평균 별점.
  // 후보가 적으면 평균이 한두 곳에 휘둘리므로 BAYES_C_MIN_CANDIDATES 미만일 때는 BAYES_C_DEFAULT를 쓴다.
  // 별점이나 방문자 수가 없는 후보는 순위에서 빼고 unscored로 돌려준다.
  // draft를 주면 저장된 후보 대신(또는 더해서) 그 값으로 계산한다 (후보 추가 화면 미리보기용).
  function rankCandidates(input, draft) {
    const places = { ...getPlaces() };
    if (draft) places[draft.id] = draft;
    const all = Object.values(places).filter((p) => matchesInput(p, input));
    const scored = all.filter((p) => typeof p.rating === 'number' && typeof p.reviews === 'number');
    const unscored = all.filter((p) => !scored.includes(p)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    if (!scored.length) return { ranked: [], unscored, total: all.length };
    const C = scored.length >= CFG.BAYES_C_MIN_CANDIDATES
      ? scored.reduce((s, p) => s + p.rating, 0) / scored.length
      : CFG.BAYES_C_DEFAULT;
    const m = CFG.BAYES_M;
    const ranked = scored
      .map((p) => ({ ...p, score: (p.reviews * p.rating + m * C) / (p.reviews + m) }))
      .sort((a, b) => b.score - a.score || b.reviews - a.reviews);
    return { ranked, unscored, total: all.length };
  }

  // closedDays: 없음 = 확인필요, [] = 연중무휴, [0..6] = 정기 휴무 요일(0=일)
  function effectiveInfo(note) {
    const v = (x) => (x === 'yes' || x === 'no' ? x : 'unknown');
    return {
      room: v(note.room),
      outdoor: v(note.outdoor),
      parking: v(note.parking),
      reservation: note.reservation && note.reservation !== 'unknown' ? note.reservation : 'unknown',
      closedDays: Array.isArray(note.closedDays) ? note.closedDays : null,
    };
  }

  function strikeReasons(input, weather, note) {
    const eff = effectiveInfo(note);
    const reasons = [];
    if (eff.closedDays && eff.closedDays.includes(weekdayOf(input.date))) {
      reasons.push(`${fmtShort(input.date)} 휴무`);
    }
    if (weather && weather.status === 'ok' && weather.rain && input.space === 'outdoor' && eff.outdoor === 'yes') {
      reasons.push(`비 예보(강수확률 ${weather.maxProb}%)`);
    }
    if (input.space === 'room' && eff.room === 'no') reasons.push('룸 없음(직접 확인)');
    if (input.space === 'outdoor' && eff.outdoor === 'no') reasons.push('야장 없음(직접 확인)');
    if (input.parking && eff.parking === 'no') reasons.push('주차 불가(직접 확인)');
    return reasons;
  }

  // ---------------------------------------------------------------------------
  // 화면 공통 조각
  // ---------------------------------------------------------------------------
  function chip(label, value, words) {
    const word = (words || TRI).find(([k]) => k === value)[1];
    return `<span class="chip ${value}">${esc(label)} ${esc(word)}</span>`;
  }
  function closedChip(closedDays) {
    if (!closedDays) return '<span class="chip unknown">휴무 확인필요</span>';
    if (!closedDays.length) return '<span class="chip yes">연중무휴</span>';
    const days = WEEK_ORDER.filter((d) => closedDays.includes(d)).map((d) => DAY_SHORT[d]).join('·');
    return `<span class="chip no">${esc(days)}요일 휴무</span>`;
  }
  function historyBadge(id) {
    const h = historyFor(id)[0];
    return h ? `<span class="chip history">지난 회식 ${esc(fmtMonthDay(h.date))}</span>` : '';
  }
  function segGroup(name, options, selected) {
    return `<div class="seg" role="radiogroup">${options.map(([v, label]) => `
      <label><input type="radio" name="${name}" value="${esc(v)}" ${v === selected ? 'checked' : ''}><span>${esc(label)}</span></label>`).join('')}
    </div>`;
  }
  // 날씨 아이콘 (40x40 선 그림). 저녁 시간대라 맑음은 달로 그린다.
  const CLOUD_MID = '<path d="M12 30h17a7 7 0 0 0 0-14 10 10 0 0 0-19 3 5.5 5.5 0 0 0 2 11z"/>';
  const CLOUD_HIGH = '<path d="M12 23h17a7 7 0 0 0 0-14 10 10 0 0 0-19 3 5.5 5.5 0 0 0 2 11z"/>';
  const WEATHER_ICONS = {
    clear: '<path d="M27 6a14 14 0 1 0 8 22A12 12 0 0 1 27 6z"/><path d="M10 9v4M8 11h4M33 4v3M31.5 5.5h3"/>',
    partly: '<path d="M20 5a9 9 0 0 0 3 12 9 9 0 0 0 9 1A10 10 0 0 1 20 5z"/><path d="M8 33h15a6 6 0 0 0 0-12 8 8 0 0 0-15 2.5A4.8 4.8 0 0 0 8 33z"/>',
    cloudy: CLOUD_MID,
    fog: CLOUD_HIGH + '<path d="M6 29h28M10 35h22"/>',
    rain: CLOUD_HIGH + '<path d="M14 28l-2 6M21 28l-2 6M28 28l-2 6"/>',
    snow: CLOUD_HIGH + '<path d="M13 29v5M10.5 31.5h5M20 29v5M17.5 31.5h5M27 29v5M24.5 31.5h5"/>',
    storm: CLOUD_HIGH + '<path d="M21 25l-4 6h5l-3 6"/>',
    none: '<rect x="6" y="9" width="28" height="25" rx="4"/><path d="M6 16h28M13 5v6M27 5v6M17 22a3 3 0 1 1 4 3v2M20 30.5v.5"/>',
    loading: CLOUD_MID,
  };
  const DROP_ICON = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 1.5C6 5 3.5 7.5 3.5 10a4.5 4.5 0 0 0 9 0C12.5 7.5 10 5 8 1.5z"/></svg>';
  const KIND_LABEL = { clear: '맑음', partly: '구름 조금', cloudy: '흐림', fog: '안개', rain: '비', snow: '눈', storm: '뇌우' };

  function weatherIcon(kind) {
    return `<svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WEATHER_ICONS[kind]}</svg>`;
  }

  // 순위 화면 요약 카드의 날씨 줄. weather가 null이면 불러오는 중.
  function weatherView(input, w) {
    const [from, to] = CFG.DINNER_HOURS;
    const when = `${fmtShort(input.date)} 저녁 ${from > 12 ? from - 12 : from}~${to > 12 ? to - 12 : to}시`;
    const row = (cls, kind, main, sub) => `
      <div class="weather ${cls}">
        <div class="weather-icon">${weatherIcon(kind)}</div>
        <div class="weather-body">
          <div class="weather-when">${esc(when)}</div>
          <div class="weather-main">${main}</div>
          <div class="weather-sub">${esc(sub)}</div>
        </div>
        ${cls === 'ok rain' || cls === 'ok dry' ? `<div class="weather-prob" title="저녁 시간 최대 강수확률">${DROP_ICON}<span>${w.maxProb}%</span><small>강수확률</small></div>` : ''}
      </div>`;
    if (!w) return row('loading', 'loading', '날씨 확인 중…', '');
    if (w.status === 'error') return row('none', 'none', '날씨 정보 없음', '불러오지 못해서 비 예보 취소선은 빼고 보여 드려요.');
    if (w.status === 'none') return row('none', 'none', '예보 없음', `날씨 예보는 오늘부터 ${CFG.FORECAST_DAYS}일 안쪽만 나와요.`);
    // 강수확률로 비 예보가 났는데 날씨 코드가 맑음·흐림이면 아이콘은 비로 맞춘다
    let kind = w.kind || (w.rain ? 'rain' : 'cloudy');
    if (w.rain && !['rain', 'snow', 'storm'].includes(kind)) kind = 'rain';
    const main = `${esc(KIND_LABEL[kind])}${w.temp != null ? ` <span class="weather-temp">${w.temp}°</span>` : ''}`;
    return w.rain
      ? row('ok rain', kind, main, input.space === 'outdoor' ? '비 예보 · 야장 가게는 취소선으로 표시해요' : '비 예보 · 우산 챙기세요')
      : row('ok dry', kind, main, '비 소식 없음');
  }
  function stateView(kind, html) {
    return `<div class="state ${kind}">${kind === 'loading' ? '<div class="spinner"></div>' : ''}${html}</div>`;
  }
  function bottomBar(inner) {
    return `<div class="bottom-bar"><div class="inner">${inner}</div></div>`;
  }
  function topbar(title, backHref, backLabel) {
    return `
      <div class="topbar">
        ${backHref ? `<a class="icon-btn" href="${backHref}" aria-label="${esc(backLabel)}">←</a>` : ''}
        <h1>${esc(title)}</h1>
      </div>`;
  }
  // 순위 화면 제목: 발랄한 글자체 + 글자마다 통통 튀어 오르는 애니메이션
  function funTitle(title, backHref, backLabel) {
    const letters = [...title].map((ch, i) =>
      ch === ' ' ? ' ' : `<span style="--i:${i}">${esc(ch)}</span>`).join('');
    return `
      <div class="topbar">
        ${backHref ? `<a class="icon-btn" href="${backHref}" aria-label="${esc(backLabel)}">←</a>` : ''}
        <h1 class="fun-title" aria-label="${esc(title)}"><span aria-hidden="true">${letters}</span></h1>
      </div>`;
  }
  function placeMapUrl(place) {
    if (isHttpUrl(place.link)) return place.link.trim();
    return `https://map.naver.com/p/search/${encodeURIComponent(`${place.area} ${place.name}`)}`;
  }

  // ---------------------------------------------------------------------------
  // 입력 화면
  // ---------------------------------------------------------------------------
  function renderInput() {
    const v = currentInput();
    $app.innerHTML = `
      <header class="hero">
        <div class="hero-badge" aria-hidden="true">
          <svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 20h32a16 13 0 0 1-32 0z"/><path d="M13 34h14"/>
            <path d="M22 16L36 4M26 16L38 8"/>
          </svg>
        </div>
        <h1>회식 장소 추천기</h1>
        <p>조건을 넣고 지도에서 찾은 후보를 적으면, 믿을 만한 Top ${CFG.TOP_N}과 예약 정보를 한 화면에 정리해 드려요.</p>      </header>
      <form id="input-form" class="card" novalidate>${conditionFields(v)}</form>
      ${bottomBar('<button class="btn btn-primary btn-block" type="submit" form="input-form">추천 받기</button>')}
    `;
    bindConditionForm(() => { location.hash = '#/results'; });
  }

  // 입력 화면과 순위 화면(조건 수정)이 같이 쓰는 조건 입력칸
  function conditionFields(v) {
    return `
        <div class="field">
          <label for="f-area">지역 <span class="req">*</span> <span class="meta">동네·역·건물 이름</span></label>
          <input id="f-area" class="input" name="area" type="text" placeholder="예: 강남역, 성수동, 판교 알파돔타워" value="${esc(v.area)}" autocomplete="off" enterkeyhint="search">
          <div class="field-error" id="err-area" hidden>지역(동네·역·건물 이름)을 입력해 주세요.</div>
        </div>
        <div class="field">
          <label for="f-date">회식 날짜 <span class="req">*</span></label>
          <input id="f-date" class="input" name="date" type="date" value="${esc(v.date)}">
        </div>
        <div class="field">
          <label for="f-people">인원 <span class="req">*</span></label>
          <input id="f-people" class="input" name="people" type="number" inputmode="numeric" min="1" max="200" value="${esc(v.people)}">
          <div class="field-error" id="err-people" hidden>인원을 1명 이상으로 입력해 주세요.</div>
        </div>
        <div class="field">
          <span class="label">장르</span>
          ${segGroup('genre', GENRES.map((g) => [g, g]), v.genre)}
        </div>
        <div class="field">
          <span class="label">공간</span>
          ${segGroup('space', SPACES, v.space)}
        </div>
        <div class="field">
          <label class="check"><input type="checkbox" name="parking" ${v.parking ? 'checked' : ''}><span>주차 필요</span></label>
        </div>`;
  }

  // 검사를 통과하면 조건을 저장하고 onSaved를 부른다
  function bindConditionForm(onSaved) {
    const form = document.getElementById('input-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const input = {
        area: String(fd.get('area') || '').trim(),
        date: String(fd.get('date') || '') || todayStr(),
        people: Number(fd.get('people')),
        genre: String(fd.get('genre') || '전체'),
        space: String(fd.get('space') || 'any'),
        parking: fd.get('parking') === 'on',
      };
      const badArea = !input.area;
      const badPeople = !(input.people >= 1);
      document.getElementById('err-area').hidden = !badArea;
      document.getElementById('err-people').hidden = !badPeople;
      if (badArea) { document.getElementById('f-area').focus(); return; }
      if (badPeople) { document.getElementById('f-people').focus(); return; }
      state.input = input;
      store.set('lastInput', input);
      onSaved();
    });
  }

  // 순위 화면 맨 위: 조건 칸을 누르면 그 자리에서 바로 고친다
  function conditionPanel(input) {
    const opts = (list, sel) => list.map(([v, label]) => `<option value="${esc(v)}" ${v === sel ? 'selected' : ''}>${esc(label)}</option>`).join('');
    return `
      <section class="card cond">
        <h2>입력한 조건 <span class="meta">· 눌러서 바로 고치기</span></h2>
        <div class="cond-grid">
          <label class="cond-cell"><span>지역</span>
            <input name="area" type="text" value="${esc(input.area)}" autocomplete="off" enterkeyhint="done" aria-label="지역"></label>
          <label class="cond-cell"><span>날짜</span>
            <input name="date" type="date" value="${esc(input.date)}" aria-label="회식 날짜"></label>
          <label class="cond-cell"><span>인원</span>
            <div class="cond-unit"><input name="people" type="number" inputmode="numeric" min="1" max="200" value="${esc(input.people)}" aria-label="인원">명</div></label>
          <label class="cond-cell"><span>장르</span>
            <select name="genre" aria-label="장르">${opts(GENRES.map((g) => [g, g]), input.genre)}</select></label>
          <label class="cond-cell"><span>공간</span>
            <select name="space" aria-label="공간">${opts(SPACES, input.space)}</select></label>
          <button type="button" class="cond-cell" name="parking" aria-pressed="${input.parking}"><span>주차</span>
            <b>${input.parking ? '필요' : '상관없음'}</b></button>
        </div>
        <div class="field-error" id="cond-error" hidden></div>
      </section>`;
  }

  // 조건 칸 하나가 바뀌면 검사하고 저장한 뒤 onChange(input)를 부른다
  function bindConditionPanel(onChange) {
    const panel = $app.querySelector('.cond');
    const err = document.getElementById('cond-error');
    const commit = (el) => {
      const input = { ...currentInput() };
      if (el.name === 'parking') {
        input.parking = !input.parking;
        el.setAttribute('aria-pressed', String(input.parking));
        el.querySelector('b').textContent = input.parking ? '필요' : '상관없음';
      } else if (el.name === 'area') {
        input.area = el.value.trim();
        if (!input.area) { showErr(el, '지역(동네·역·건물 이름)을 입력해 주세요.'); return; }
      } else if (el.name === 'people') {
        input.people = Number(el.value);
        if (!(input.people >= 1)) { showErr(el, '인원을 1명 이상으로 입력해 주세요.'); return; }
      } else if (el.name === 'date') {
        input.date = el.value || todayStr();
      } else {
        input[el.name] = el.value;
      }
      clearErr();
      state.input = input;
      store.set('lastInput', input);
      onChange(input);
    };
    const showErr = (el, msg) => { err.textContent = msg; err.hidden = false; el.closest('.cond-cell').classList.add('bad'); };
    const clearErr = () => { err.hidden = true; panel.querySelectorAll('.bad').forEach((c) => c.classList.remove('bad')); };
    panel.querySelectorAll('input, select').forEach((el) => {
      el.addEventListener('change', () => commit(el));
      if (el.type === 'text' || el.type === 'number') {
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } });
      }
    });
    panel.querySelector('button[name="parking"]').addEventListener('click', (e) => commit(e.currentTarget));
  }

  // ---------------------------------------------------------------------------
  // 순위 화면
  // ---------------------------------------------------------------------------
  function rankItem(p, i, input, weather, notes) {
    const note = notes[p.id] || {};
    const eff = effectiveInfo(note);
    const reasons = strikeReasons(input, weather, note);
    return `
      <li class="rank-item">
        <a class="rank-link" href="#/place/${encodeURIComponent(p.id)}">
          <div class="rank-no">${i == null ? '–' : i + 1}</div>
          <div class="rank-body">
            <div class="rank-head">
              <span class="rank-name ${reasons.length ? 'struck' : ''}">${esc(p.name)}</span>
              ${p.score != null ? `<span class="score">${p.score.toFixed(2)}</span>` : ''}
            </div>
            <div class="meta">${p.score != null
              ? `★ ${p.rating.toFixed(1)} · 방문자 ${p.reviews.toLocaleString('ko-KR')}명`
              : '별점·방문자 수를 적으면 순위에 들어가요'}</div>
            ${reasons.length ? `<div class="reasons">${reasons.map(esc).join(' · ')}</div>` : ''}
            <div class="chips">
              ${chip('룸', eff.room)}
              ${chip('야장', eff.outdoor)}
              ${input.parking ? chip('주차', eff.parking, PARKING_OPTS) : ''}
              ${closedChip(eff.closedDays)}
              ${historyBadge(p.id)}
            </div>
          </div>
        </a>
      </li>`;
  }

  function renderResults() {
    const input = currentInput();
    if (!input.area) { location.hash = '#/'; return; }

    // 틀은 한 번만 그린다. 조건이 바뀌면 refresh()가 날씨·지도·순위 칸만 바꾼다
    // (지도 검색어가 그대로면 지도 프레임은 다시 로드하지 않는다)
    $app.innerHTML = `
      ${funTitle('오늘은 이곳이다!!', '#/', '처음 화면으로')}
      ${conditionPanel(input)}
      <div id="wx-slot"></div>
      <section class="card map-card">
        <h2>지도에서 후보 찾기</h2>
        <p class="meta" style="margin:-6px 0 10px">"<span id="map-q"></span>" 검색 결과예요. 마음에 드는 곳은 <strong>후보 추가</strong>로 적어 주세요.</p>
        <div class="map-tabs" role="tablist">
          ${MAP_TABS.map((t) => `<button type="button" role="tab" data-map="${t.key}">${esc(t.label)}</button>`).join('')}
          <button type="button" role="tab" data-map="none">접기</button>
        </div>
        <div id="map-slot"></div>
        <div id="map-top"></div>
        <form id="quick-add" class="quick-add" novalidate>
          <p class="quick-add-title">지도에서 본 가게 바로 추가</p>
          <textarea class="quick-add-paste" name="paste" rows="2" aria-label="지도에서 복사한 가게 정보"
            placeholder="📋 지도에서 복사한 가게 정보 붙여넣기 → 자동으로 채워져요"></textarea>
          <div class="quick-add-row">
            <input name="name" type="text" placeholder="가게 이름" autocomplete="off" aria-label="가게 이름" enterkeyhint="next">
            <input name="rating" type="number" inputmode="decimal" min="0" max="5" step="0.1" placeholder="별점" aria-label="별점">
            <input name="reviews" type="text" inputmode="numeric" placeholder="방문자 수" aria-label="방문자 수" enterkeyhint="done">
            <button class="btn btn-sm btn-primary" type="submit">추가</button>
          </div>
          <div class="field-error" id="qa-error" hidden></div>
        </form>
        <p class="meta" style="margin:10px 0 0">별점·방문자 수는 한 지도(예: 네이버지도)를 기준으로 통일해서 적어야 점수가 공정해요.</p>
      </section>
      <div id="rank-slot"></div>
      ${bottomBar('<a class="btn btn-primary btn-block" href="#/add">+ 후보 추가</a>')}
    `;

    // 지도 상태: base = 조건으로 만든 검색어, focus = Top 5 줄에서 고른 가게 (없으면 base를 보여 준다)
    // strip = Top 5 줄을 그릴 재료 (조건·날씨가 바뀌면 refreshResults가 채운다)
    const savedTab = store.get('mapTab', 'kakao');
    const map = {
      tab: savedTab === 'none' || MAP_TABS.some((t) => t.key === savedTab) ? savedTab : 'kakao',
      base: null,
      focus: null,
      strip: null,
      current() { return MAP_TABS.find((t) => t.key === this.tab) || null; },
      renderFrame() {
        $app.querySelectorAll('[data-map]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.map === this.tab)));
        const t = this.current();
        const q = this.focus || this.base;
        // 지도 사이트가 화면 안 표시를 거절하면 iframe이 투명한 빈 칸으로 남는다 (앱에서는 알아낼 수 없음).
        // 그래서 iframe 뒤에 안내를 깔아 두고, 지도가 그려지면 지도에 가려지게 한다.
        const others = MAP_TABS.filter((x) => x.key !== t?.key).map((x) => x.label).join('·');
        if (t && !t.embed) {
          document.getElementById('map-slot').innerHTML = `
            <div class="map-out">
              <p><strong>${esc(t.label)}는 이 화면 안에 띄울 수 없어요.</strong><br>
              다른 사이트 안 표시를 막아 두어서 새 탭(휴대폰은 앱)으로 열려요.<br>
              거기서 가게 정보를 복사해 와서 아래 <b>바로 추가</b> 칸에 붙여넣으세요.</p>
              <a class="btn btn-primary" href="${esc(t.link(q))}" target="_blank" rel="noopener">${esc(t.label)}에서 "${esc(q)}" 보기 ↗</a>
            </div>`;
          return;
        }
        document.getElementById('map-slot').innerHTML = t
          ? `<div class="map-frame">
              <div class="map-fallback" aria-hidden="true">
                <div class="spinner"></div>
                <p><strong>${esc(t.label)} 불러오는 중…</strong> (10초쯤 걸릴 수 있어요)<br>
                계속 빈 화면이면 아래 <b>다시 불러오기</b>를 누르거나,<br>
                <b>${esc(others)}</b> 탭으로 바꾸거나, <b>${esc(t.label)} 열기</b>를 눌러 주세요.</p>
              </div>
              <iframe src="${esc(t.embed(q))}" title="${esc(t.label)} 검색 결과" referrerpolicy="no-referrer-when-downgrade"></iframe>
            </div>
            <div class="map-open-bar">
              <button class="btn btn-sm" type="button" id="map-reload">↻ 다시 불러오기</button>
              <a class="btn btn-sm" href="${esc(t.link(q))}" target="_blank" rel="noopener">${esc(t.label)} 열기 ↗</a>
            </div>`
          : '';
        const reload = document.getElementById('map-reload');
        if (reload) reload.addEventListener('click', () => this.renderFrame());
      },
      renderStrip() {
        if (!this.strip) return;
        const { input, top, weather, notes } = this.strip;
        if (this.focus && !top.some((p) => placeQuery(p) === this.focus)) this.focus = null;
        document.getElementById('map-top').innerHTML = mapTopStrip(input, top, weather, notes, this.focus, this.current());
      },
      render() { this.renderFrame(); this.renderStrip(); },
    };
    // 탭이나 가게를 누르면 지도 칸을 화면 위쪽에 맞춰서 지도와 바로 아래 Top 5가 한 화면에 보이게 한다
    const reveal = () => $app.querySelector('.map-tabs').scrollIntoView({ behavior: 'smooth', block: 'start' });
    $app.querySelectorAll('[data-map]').forEach((b) => b.addEventListener('click', () => {
      map.tab = b.dataset.map;
      store.set('mapTab', map.tab);
      map.render();
      const t = map.current();
      // 새 탭으로 여는 지도는 탭을 누른 그 순간에 바로 연다 (사용자가 누른 순간이라 팝업으로 막히지 않음)
      if (t && !t.embed) window.open(t.link(map.focus || map.base), '_blank', 'noopener');
      if (t) reveal();
    }));
    // Top 5 줄의 가게를 누르면 지도가 그 가게를 찾는다 (같은 가게를 다시 누르면 전체 검색으로).
    // 새 탭 지도(네이버)에서는 각 칸이 링크라서 그 가게가 새 탭으로 열린다.
    document.getElementById('map-top').addEventListener('click', (e) => {
      const b = e.target.closest('[data-focus]');
      if (!b) return;
      const next = b.dataset.focus || null;
      const t = map.current();
      if (t && !t.embed) {
        // 링크가 먼저 열리도록 다시 그리기는 클릭 처리가 끝난 뒤에 한다
        map.focus = next;
        setTimeout(() => map.render());
        return;
      }
      if (!t) { map.tab = 'kakao'; store.set('mapTab', map.tab); }
      map.focus = map.focus === next ? null : next;
      map.render();
      reveal();
    });

    // 빠른 추가: 이름·별점·방문자 수만 적으면 지금 조건(지역·장르)으로 저장하고 Top 5를 바로 다시 계산한다
    const qa = document.getElementById('quick-add');
    // 붙여넣은 글에서 이름·별점·방문자 수를 찾아 칸을 채운다 (못 찾은 칸은 비워서 직접 적게 한다)
    qa.paste.addEventListener('input', () => {
      const info = parsePlaceText(qa.paste.value);
      qa.name.value = info.name;
      qa.rating.value = info.rating == null ? '' : info.rating;
      qa.reviews.value = info.reviews == null ? '' : info.reviews.toLocaleString('ko-KR');
      const found = [info.name && '이름', info.rating != null && '별점', info.reviews != null && '방문자 수'].filter(Boolean);
      const err = document.getElementById('qa-error');
      err.hidden = !qa.paste.value.trim() || found.length === 3;
      err.textContent = found.length ? `${found.join('·')}만 찾았어요. 나머지는 직접 적어 주세요.` : '가게 정보를 찾지 못했어요. 직접 적어 주세요.';
    });
    qa.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = currentInput();
      const name = qa.name.value.trim();
      const rating = qa.rating.value.trim() === '' ? NaN : Number(qa.rating.value);
      const reviewsText = qa.reviews.value.trim().replace(/,/g, '');
      const reviews = reviewsText === '' ? NaN : Number(reviewsText);
      const err = document.getElementById('qa-error');
      let msg = '';
      if (!name) msg = '가게 이름을 적어 주세요.';
      else if (!(rating >= 0 && rating <= 5)) msg = '별점은 0~5 사이로 적어 주세요.';
      else if (!(Number.isInteger(reviews) && reviews >= 0)) msg = '방문자 수는 0 이상의 숫자로 적어 주세요.';
      err.textContent = msg;
      err.hidden = !msg;
      if (msg) {
        (!name ? qa.name : !(rating >= 0 && rating <= 5) ? qa.rating : qa.reviews).focus();
        return;
      }
      const place = {
        id: uuid(), name, area: input.area, genre: input.genre === '전체' ? '기타' : input.genre,
        rating, reviews, phone: '', address: '', link: '', createdAt: isoNow(), updatedAt: isoNow(),
      };
      const all = getPlaces();
      all[place.id] = place;
      if (!store.set('places', all)) { toast('저장하지 못했어요 (브라우저 저장소를 확인해 주세요)'); return; }
      const rank = rankCandidates(input).ranked.findIndex((p) => p.id === place.id);
      toast(rank >= 0 && rank < CFG.TOP_N ? `"${name}" 추가 · ${rank + 1}위` : `"${name}" 추가 · ${rank + 1}위 (Top ${CFG.TOP_N} 밖)`);
      qa.reset();
      qa.name.focus();
      refreshResults(map);
    });

    bindConditionPanel(() => refreshResults(map));
    refreshResults(map);
  }

  function placeQuery(p) { return `${p.area} ${p.name}`; }

  // 지도 목록에서 복사한 글 → { name, rating, reviews }. 예)
  //   네이버: "OO식당\n한식\n별점4.52\n방문자 리뷰 1,234\n블로그 리뷰 567"
  //   카카오: "OO식당 판교점한식\n평점 :\n3.4\n(60) | 리뷰 970"
  const CATEGORY_TAIL = /(한식|중식|일식|양식|분식|술집|카페|고기|육류|고기요리|돼지고기구이|소고기구이|정육식당|해물|생선|해산물|치킨|국밥|찌개|이자카야|요리주점|호프|아시아음식|뷔페)(\s*[,>].*)?$/;
  function parsePlaceText(text) {
    const lines = String(text || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const all = lines.join(' ');
    const toInt = (s) => Number(s.replace(/,/g, ''));

    let rating = null;
    const r1 = all.match(/(?:별점|평점)\s*:?\s*([0-5](?:\.\d{1,2})?)/);
    const r2 = all.match(/(?:^|[^\d.])([0-5]\.\d{1,2})(?![\d.])/);
    if (r1) rating = Number(r1[1]);
    else if (r2) rating = Number(r2[1]);

    let reviews = null;
    // 별점을 매긴 사람 수에 가장 가까운 숫자를 고른다
    const v = all.match(/방문자\s*리뷰\s*([\d,]+)/)   // 네이버 방문자 리뷰
      || all.match(/\(([\d,]+)\)/)                   // 카카오 평점 참여 수 (60)
      || all.match(/리뷰\s*([\d,]+)/)
      || all.match(/([\d,]+)\s*명/);
    if (v) reviews = toInt(v[1]);

    // 이름: 첫 줄에서 별점·숫자 부분을 떼고, 붙어 있는 업종 이름(예: "OO점한식")을 뗀다
    let name = (lines[0] || '').replace(/(?:별점|평점).*$/, '').replace(/\s*[0-5]\.\d.*$/, '').trim();
    const cut = name.replace(CATEGORY_TAIL, '').trim();
    if (cut) name = cut;
    if (/^[\d\s.,()|★:]*$/.test(name)) name = '';
    return { name, rating, reviews: Number.isInteger(reviews) ? reviews : null };
  }

  // 지도 바로 아래 한 줄: 이번 조건의 Top 5 (취소선 이유는 날씨가 오면 반영)
  function mapTopStrip(input, top, weather, notes, focus, tab) {
    if (!top.length) {
      return `
        <div class="map-top-empty">
          <p><strong>아직 추천할 후보가 없어요.</strong><br>위 지도에서 본 가게의 이름·별점·방문자 수를 바로 아래에 적고 <b>추가</b>를 누르면 여기에 Top ${CFG.TOP_N}이 바로 채워져요.</p>
        </div>`;
    }
    const out = tab && !tab.embed;
    const base = buildQuery(input);
    const item = (q, cls, inner) => out
      ? `<a class="map-top-item ${cls}" href="${esc(tab.link(q || base))}" target="_blank" rel="noopener" data-focus="${esc(q)}" aria-pressed="${(q || null) === focus}">${inner}</a>`
      : `<button type="button" class="map-top-item ${cls}" data-focus="${esc(q)}" aria-pressed="${(q || null) === focus}">${inner}</button>`;
    return `
      <p class="map-top-title">추천 Top ${top.length} · ${out ? `누르면 ${esc(tab.label)}에서 그 가게가 열려요 ↗` : '누르면 위 지도에서 그 가게를 보여 줘요'}</p>
      <div class="map-top">${item('', 'all', '<b>전체</b><small>검색 결과</small>')}${top.map((p, i) => {
        const struck = strikeReasons(input, weather, notes[p.id] || {}).length > 0;
        return item(placeQuery(p), '', `
          <span class="map-top-no">${i + 1}</span>
          <b class="${struck ? 'struck' : ''}">${esc(p.name)}</b>
          <small>★ ${p.rating.toFixed(1)} · ${p.score.toFixed(2)}점</small>`);
      }).join('')}</div>`;
  }

  async function refreshResults(map) {
    const input = currentInput();
    const token = ++state.renderToken;
    const q = buildQuery(input);
    const { ranked, unscored, total } = rankCandidates(input);
    const notes = getNotes();
    const top = ranked.slice(0, CFG.TOP_N);
    const drawStrip = (weather) => {
      map.strip = { input, top, weather, notes };
      map.renderStrip();
    };

    const baseChanged = q !== map.base;
    if (baseChanged) {
      map.base = q;
      map.focus = null;
      document.getElementById('map-q').textContent = q;
    }
    const cached = state.weather && state.weather.key === normArea(input.area) + '|' + input.date ? state.weather.value : null;
    const hadFocus = map.focus;
    drawStrip(cached);
    if (baseChanged || hadFocus !== map.focus) map.renderFrame();

    const listHtml = (weather) => {
      const top = ranked.slice(0, CFG.TOP_N);
      const rest = ranked.slice(CFG.TOP_N);
      if (!total) {
        return stateView('', `<p>아직 "${esc(input.area)}${input.genre === '전체' ? '' : ' ' + esc(input.genre)}" 후보가 없어요.<br>위 지도에서 찾아보고 <strong>후보 추가</strong>로 적어 주세요.</p>`);
      }
      return `
        ${top.length ? `<ol class="rank-list">${top.map((p, i) => rankItem(p, i, input, weather, notes)).join('')}</ol>` : ''}
        ${rest.length || unscored.length ? `
          <h2 class="section-title">나머지 후보 ${rest.length + unscored.length}곳</h2>
          <ol class="rank-list">
            ${rest.map((p, i) => rankItem(p, CFG.TOP_N + i, input, weather, notes)).join('')}
            ${unscored.map((p) => rankItem(p, null, input, weather, notes)).join('')}
          </ol>` : ''}
        <p class="attribution">후보 ${total}곳 · 종합점수(베이지안 평균) 순</p>`;
    };

    document.getElementById('wx-slot').innerHTML = weatherView(input, cached);
    document.getElementById('rank-slot').innerHTML = listHtml(cached);

    const weather = await ensureWeather(input);
    if (token !== state.renderToken) return;
    document.getElementById('wx-slot').innerHTML = weatherView(input, weather);
    document.getElementById('rank-slot').innerHTML = listHtml(weather);
    drawStrip(weather);
  }

  // ---------------------------------------------------------------------------
  // 후보 추가·수정 화면
  // ---------------------------------------------------------------------------
  function renderEdit(id) {
    state.renderToken++;
    const input = currentInput();
    const existing = id ? getPlace(id) : null;
    if (id && !existing) {
      $app.innerHTML = topbar('후보 수정', '#/results', '순위로 돌아가기') + stateView('error', '<p>후보를 찾을 수 없어요.</p>');
      return;
    }
    const p = existing || {
      name: '', area: input.area, genre: input.genre === '전체' ? '한식' : input.genre,
      rating: null, reviews: null, phone: '', address: '', link: '',
    };
    const backHref = existing ? `#/place/${encodeURIComponent(id)}` : '#/results';

    $app.innerHTML = `
      ${topbar(existing ? '후보 수정' : '후보 추가', backHref, '뒤로')}
      <form id="place-form" class="card" novalidate>
        <div class="field">
          <label for="p-name">가게 이름 <span class="req">*</span></label>
          <input id="p-name" class="input" name="name" type="text" value="${esc(p.name)}" autocomplete="off">
          <div class="field-error" id="err-name" hidden>가게 이름을 입력해 주세요.</div>
        </div>
        <div class="field">
          <label for="p-area">지역 <span class="req">*</span></label>
          <input id="p-area" class="input" name="area" type="text" value="${esc(p.area)}" autocomplete="off">
          <div class="field-error" id="err-area" hidden>지역을 입력해 주세요.</div>
        </div>
        <div class="field">
          <span class="label">장르</span>
          ${segGroup('genre', PLACE_GENRES.map((g) => [g, g]), p.genre)}
        </div>
        <div class="field" style="display:flex;gap:10px">
          <div style="flex:1">
            <label class="label" for="p-rating">별점 (0~5)</label>
            <input id="p-rating" class="input" name="rating" type="number" inputmode="decimal" min="0" max="5" step="0.1" placeholder="4.5" value="${p.rating == null ? '' : esc(p.rating)}">
          </div>
          <div style="flex:1">
            <label class="label" for="p-reviews">방문자 수</label>
            <input id="p-reviews" class="input" name="reviews" type="text" inputmode="numeric" placeholder="1,500" value="${p.reviews == null ? '' : esc(p.reviews)}">
          </div>
        </div>
        <div class="field-error" id="err-score" hidden style="margin:-8px 0 12px">별점은 0~5, 방문자 수는 0 이상의 정수로 적어 주세요.</div>
        <div class="bayes-preview" id="bayes-preview" aria-live="polite"></div>
        <div class="field">
          <label for="p-phone">전화번호</label>
          <input id="p-phone" class="input" name="phone" type="tel" inputmode="tel" placeholder="02-123-4567" value="${esc(p.phone)}">
        </div>
        <div class="field">
          <label for="p-address">주소</label>
          <input id="p-address" class="input" name="address" type="text" value="${esc(p.address)}">
        </div>
        <div class="field">
          <label for="p-link">지도 링크</label>
          <input id="p-link" class="input" name="link" type="url" inputmode="url" placeholder="지도 앱의 '공유 → 링크 복사' 붙여넣기" value="${esc(p.link)}">
        </div>
        <p class="meta" style="margin:0">별점·방문자 수가 비어 있으면 "나머지 후보"에 들어가고 순위에는 빠져요.</p>
        ${existing ? '<button class="btn btn-block" type="button" id="del-place" style="margin-top:16px;color:var(--danger)">이 후보 삭제</button>' : ''}
      </form>
      ${bottomBar(`
        <a class="btn" href="${backHref}">취소</a>
        <button class="btn btn-primary btn-block" type="submit" form="place-form">저장</button>
      `)}
    `;
    if (!existing) document.getElementById('p-name').focus();

    const form = document.getElementById('place-form');
    const draftId = existing ? existing.id : uuid();
    const readForm = () => {
      const fd = new FormData(form);
      const num = (k) => {
        const s = String(fd.get(k) || '').trim().replace(/,/g, '');
        return s === '' ? null : Number(s);
      };
      return {
        id: draftId,
        name: String(fd.get('name') || '').trim(),
        area: String(fd.get('area') || '').trim(),
        genre: String(fd.get('genre') || '기타'),
        rating: num('rating'),
        reviews: num('reviews'),
        phone: String(fd.get('phone') || '').trim(),
        address: String(fd.get('address') || '').trim(),
        link: String(fd.get('link') || '').trim(),
      };
    };

    // 입력하는 동안 별점·방문자 수로 베이지안 점수를 계산해 이번 조건의 Top 5를 바로 보여 준다
    const drawPreview = () => {
      const d = readForm();
      const valid = d.rating != null && d.reviews != null && d.rating >= 0 && d.rating <= 5
        && Number.isInteger(d.reviews) && d.reviews >= 0;
      const draft = valid ? { ...d, name: d.name || '(입력 중인 가게)' } : null;
      const { ranked } = rankCandidates(input, draft);
      const top = ranked.slice(0, CFG.TOP_N);
      const draftRank = draft ? ranked.findIndex((p) => p.id === draftId) : -1;
      const row = (p, i) => `
        <li class="${p.id === draftId ? 'me' : ''}">
          <span class="bp-no">${i + 1}</span>
          <span class="bp-name">${esc(p.name)}${p.id === draftId ? ' <em>입력 중</em>' : ''}</span>
          <span class="bp-meta">★${p.rating.toFixed(1)} · ${p.reviews.toLocaleString('ko-KR')}명</span>
          <b>${p.score.toFixed(2)}</b>
        </li>`;
      let note = '';
      if (!valid) note = '별점과 방문자 수를 넣으면 이 가게가 몇 위인지 바로 계산해요.';
      else if (draftRank < 0) note = `현재 조건(${esc(input.area)}${input.genre === '전체' ? '' : ' · ' + esc(input.genre)})과 지역·장르가 달라서 이번 순위에는 들어가지 않아요.`;
      else if (draftRank >= CFG.TOP_N) note = `이 가게는 ${draftRank + 1}위 · 종합점수 ${ranked[draftRank].score.toFixed(2)}점이라 Top ${CFG.TOP_N} 밖이에요.`;
      document.getElementById('bayes-preview').innerHTML = `
        <div class="bp-head">
          <strong>베이지안 Top ${CFG.TOP_N} 미리보기</strong>
          <span>종합점수 = (방문자×별점 + ${CFG.BAYES_M}×평균별점) ÷ (방문자 + ${CFG.BAYES_M})</span>
        </div>
        ${top.length ? `<ol>${top.map(row).join('')}</ol>` : '<p class="bp-empty">아직 순위에 들어간 후보가 없어요.</p>'}
        ${note ? `<p class="bp-note">${note}</p>` : ''}`;
    };
    form.addEventListener('input', drawPreview);
    form.addEventListener('change', drawPreview);
    drawPreview();

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const next = {
        ...readForm(),
        createdAt: existing ? existing.createdAt : isoNow(),
        updatedAt: isoNow(),
      };
      const badName = !next.name;
      const badArea = !next.area;
      const badScore = (next.rating != null && !(next.rating >= 0 && next.rating <= 5))
        || (next.reviews != null && !(Number.isInteger(next.reviews) && next.reviews >= 0));
      document.getElementById('err-name').hidden = !badName;
      document.getElementById('err-area').hidden = !badArea;
      document.getElementById('err-score').hidden = !badScore;
      if (badName || badArea || badScore) return;

      const all = getPlaces();
      all[next.id] = next;
      if (!store.set('places', all)) { toast('저장하지 못했어요 (브라우저 저장소를 확인해 주세요)'); return; }
      toast(existing ? '수정했어요' : '후보를 추가했어요');
      location.hash = `#/place/${encodeURIComponent(next.id)}`;
    });

    const del = document.getElementById('del-place');
    if (del) {
      del.addEventListener('click', () => {
        if (!confirm(`"${existing.name}" 후보를 삭제할까요? 직접 확인한 정보와 회식 기록도 함께 지워져요.`)) return;
        const places = getPlaces(); delete places[id]; store.set('places', places);
        const notes = getNotes(); delete notes[id]; store.set('placeNotes', notes);
        store.set('history', getHistory().filter((h) => h.placeId !== id));
        toast('삭제했어요');
        location.hash = '#/results';
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 세부 화면
  // ---------------------------------------------------------------------------
  async function renderDetail(id) {
    const token = ++state.renderToken;
    const input = currentInput();
    const place = getPlace(id);
    const header = topbar('가게 정보', '#/results', '순위로 돌아가기');
    if (!place) {
      $app.innerHTML = header + stateView('error', '<p>후보를 찾을 수 없어요.</p><a class="btn" href="#/results">순위로</a>');
      return;
    }
    let weather = null;
    if (input.area && matchesInput(place, input)) {
      drawDetail(id, input, header, state.weather ? state.weather.value : null);
      weather = await ensureWeather(input);
      if (token !== state.renderToken) return;
    }
    const y = window.scrollY;
    drawDetail(id, input, header, weather);
    window.scrollTo(0, y);
  }

  function drawDetail(id, input, header, weather) {
    const place = getPlace(id);
    const ranking = rankCandidates(input);
    const rankIdx = ranking.ranked.findIndex((p) => p.id === id);
    const score = rankIdx >= 0 ? ranking.ranked[rankIdx].score : null;
    const note = getNote(id);
    const eff = effectiveInfo(note);
    const reasons = strikeReasons(input, weather, note);
    const wd = weekdayOf(input.date);
    const history = historyFor(id);
    const telHref = place.phone ? 'tel:' + place.phone.replace(/[^0-9+]/g, '') : null;
    const reservationWord = RESERVATION_OPTS.find(([k]) => k === eff.reservation)[1];
    const closedDays = eff.closedDays;
    const sourceTag = (has) => (has ? ' <span class="meta">(직접 확인)</span>' : '');

    $app.innerHTML = `
      ${header}
      <section class="card">
        <h2 class="detail-name ${reasons.length ? 'struck' : ''}">${esc(place.name)}</h2>
        ${reasons.length ? `<div class="reasons">${reasons.map(esc).join(' · ')}</div>` : ''}
        <div class="meta" style="margin-top:6px">
          ${rankIdx >= 0 ? `${rankIdx + 1}위 · 종합점수 <strong>${score.toFixed(2)}</strong> · ` : ''}
          ${place.rating != null ? `★ ${place.rating.toFixed(1)}` : '별점 없음'}${place.reviews != null ? ` · 방문자 ${place.reviews.toLocaleString('ko-KR')}명` : ''}
          · ${esc(place.area)} · ${esc(place.genre)}
        </div>
        <div class="chips">
          ${chip('룸', eff.room)}${chip('야장', eff.outdoor)}${chip('주차', eff.parking, PARKING_OPTS)}
          <span class="chip ${eff.reservation === 'unknown' ? 'unknown' : 'yes'}">예약 ${esc(reservationWord)}</span>
          ${closedChip(closedDays)}
          ${historyBadge(id)}
        </div>
        <dl class="kv" style="margin-top:12px">
          <dt>주소</dt><dd>${esc(place.address || '정보 없음')}</dd>
          <dt>전화</dt><dd>${telHref ? `<a href="${esc(telHref)}">${esc(place.phone)}</a>` : '정보 없음'}</dd>
        </dl>
        <div class="phone-row">
          <a class="btn" href="${esc(placeMapUrl(place))}" target="_blank" rel="noopener">지도에서 보기</a>
          <a class="btn" href="#/edit/${encodeURIComponent(id)}">정보 수정</a>
        </div>
        <div class="notice">휴무일·영업시간은 지도에서 확인한 뒤 아래에 체크하세요. 공휴일·임시 휴무는 전화로 확인을 권장해요.</div>
      </section>

      <form class="card" id="note-form">
        <h2>직접 확인한 정보</h2>
        <div class="field">
          <span class="label">정기 휴무 요일${sourceTag(!!closedDays)} <span class="meta">회식날은 ${esc(fmtShort(input.date))}</span></span>
          <div class="seg">
            ${WEEK_ORDER.map((d) => `
              <label><input type="checkbox" name="closed" value="${d}" ${closedDays && closedDays.includes(d) ? 'checked' : ''}><span${d === wd ? ' style="text-decoration:underline;text-underline-offset:4px"' : ''}>${DAY_SHORT[d]}</span></label>`).join('')}
            <label><input type="checkbox" name="noclose" value="1" ${closedDays && !closedDays.length ? 'checked' : ''}><span>연중무휴</span></label>
          </div>
          <p class="meta" style="margin:6px 0 0">아무것도 고르지 않으면 "확인필요"로 남아요.</p>
        </div>
        <div class="field"><span class="label">룸(독립 공간)${sourceTag(eff.room !== 'unknown')}</span>${segGroup('room', TRI, eff.room)}</div>
        <div class="field"><span class="label">야장${sourceTag(eff.outdoor !== 'unknown')}</span>${segGroup('outdoor', TRI, eff.outdoor)}</div>
        <div class="field"><span class="label">주차${sourceTag(eff.parking !== 'unknown')}</span>${segGroup('parking', PARKING_OPTS, eff.parking)}</div>
        <div class="field"><span class="label">예약 방법</span>${segGroup('reservation', RESERVATION_OPTS, eff.reservation)}</div>
        <div class="field">
          <label for="n-memo">메모</label>
          <textarea id="n-memo" class="input" name="memo" placeholder="대표 메뉴, 룸 수용 인원 등">${esc(note.memo || '')}</textarea>
        </div>
        <button class="btn btn-primary btn-block" type="submit">확인 정보 저장</button>
        ${note.updatedAt ? `<p class="meta" style="margin:8px 0 0">마지막 저장 ${esc(note.updatedAt.slice(0, 16).replace('T', ' '))}</p>` : ''}
      </form>

      <section class="card">
        <h2>회식 기록</h2>
        <button class="btn btn-block" type="button" id="open-booking">여기로 예약했어요</button>
        <form id="booking-form" class="sheet" hidden style="margin-top:12px">
          <div class="field"><label for="b-date">날짜</label><input id="b-date" class="input" name="date" type="date" value="${esc(input.date)}" required></div>
          <div class="field"><label for="b-people">인원</label><input id="b-people" class="input" name="people" type="number" inputmode="numeric" min="1" value="${esc(input.people)}" required></div>
          <div class="field"><label for="b-memo">한 줄 메모</label><input id="b-memo" class="input" name="memo" type="text" placeholder="예: 룸 좋았음, 주차 2대"></div>
          <button class="btn btn-primary btn-block" type="submit">기록 저장</button>
        </form>
        <div style="margin-top:12px">
          ${history.length ? `<ul class="history-list">${history.map((h) => `
            <li>
              <div class="h-body"><div class="h-date">${esc(fmtShort(h.date))} · ${esc(h.people)}명</div>${h.memo ? `<div class="meta">${esc(h.memo)}</div>` : ''}</div>
              <button class="btn btn-sm" type="button" data-del="${esc(h.id)}">삭제</button>
            </li>`).join('')}</ul>` : '<p class="empty">아직 이 가게의 회식 기록이 없어요.</p>'}
        </div>
      </section>

      ${bottomBar(`
        <a class="btn" href="#/results">목록</a>
        ${telHref
          ? `<a class="btn btn-primary btn-block" href="${esc(telHref)}">전화하기 ${esc(place.phone)}</a>`
          : `<a class="btn btn-block" href="#/edit/${encodeURIComponent(id)}">전화번호 추가</a>`}
      `)}
    `;

    const rerender = () => drawDetail(id, input, header, weather);
    const noteForm = document.getElementById('note-form');

    // "연중무휴"와 요일 체크는 함께 고를 수 없다.
    noteForm.addEventListener('change', (e) => {
      if (e.target.name === 'noclose' && e.target.checked) {
        noteForm.querySelectorAll('input[name=closed]').forEach((c) => { c.checked = false; });
      } else if (e.target.name === 'closed' && e.target.checked) {
        noteForm.querySelector('input[name=noclose]').checked = false;
      }
    });

    noteForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(noteForm);
      const days = fd.getAll('closed').map(Number);
      const next = {
        room: fd.get('room') || 'unknown',
        outdoor: fd.get('outdoor') || 'unknown',
        parking: fd.get('parking') || 'unknown',
        reservation: fd.get('reservation') || 'unknown',
        memo: String(fd.get('memo') || '').trim(),
      };
      if (days.length) next.closedDays = days;
      else if (fd.get('noclose')) next.closedDays = [];
      const ok = saveNote(id, next);
      toast(ok ? '저장했어요' : '저장하지 못했어요 (브라우저 저장소를 확인해 주세요)');
      rerender();
    });

    const bookingForm = document.getElementById('booking-form');
    document.getElementById('open-booking').addEventListener('click', () => {
      bookingForm.hidden = !bookingForm.hidden;
      if (!bookingForm.hidden) document.getElementById('b-memo').focus();
    });
    bookingForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(bookingForm);
      const date = String(fd.get('date') || '');
      const people = Number(fd.get('people'));
      if (!date || !(people >= 1)) { toast('날짜와 인원을 확인해 주세요'); return; }
      const all = getHistory();
      all.push({ id: uuid(), placeId: id, date, people, memo: String(fd.get('memo') || '').trim(), createdAt: isoNow() });
      toast(store.set('history', all) ? '회식 기록을 남겼어요' : '저장하지 못했어요 (브라우저 저장소를 확인해 주세요)');
      rerender();
    });

    $app.querySelectorAll('[data-del]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (!confirm('이 회식 기록을 삭제할까요?')) return;
        store.set('history', getHistory().filter((h) => h.id !== btn.dataset.del));
        rerender();
      });
    });
  }

  // ---------------------------------------------------------------------------
  // 라우터
  // ---------------------------------------------------------------------------
  function route() {
    const h = location.hash || '#/';
    const arg = (prefix) => decodeURIComponent(h.slice(prefix.length));
    if (h.startsWith('#/results')) renderResults();
    else if (h === '#/add') renderEdit(null);
    else if (h.startsWith('#/edit/')) renderEdit(arg('#/edit/'));
    else if (h.startsWith('#/place/')) renderDetail(arg('#/place/'));
    else { state.renderToken++; renderInput(); }
    window.scrollTo(0, 0);
  }

  window.addEventListener('hashchange', route);
  route();
})();
