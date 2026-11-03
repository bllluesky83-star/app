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
  function mapLinks(q) {
    const e = encodeURIComponent(q);
    return [
      ['네이버지도', `https://map.naver.com/p/search/${e}`],
      ['카카오맵', `https://map.kakao.com/?q=${e}`],
      ['구글맵', `https://www.google.com/maps/search/?api=1&query=${e}`],
    ];
  }

  // ---------------------------------------------------------------------------
  // 날씨: 지역 위치(Nominatim) → 강수확률(Open-Meteo). 둘 다 키 불필요.
  // 결과: { status: 'ok', maxProb, rain } | { status: 'none' } | { status: 'error' }
  // ---------------------------------------------------------------------------
  async function geocode(area) {
    const cache = store.get('geoCache', {}) || {};
    const key = normArea(area);
    if (cache[key]) return cache[key];
    const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
      format: 'jsonv2', limit: '1', countrycodes: 'kr', 'accept-language': 'ko', q: area,
    });
    const list = await fetchJson(url, CFG.GEOCODE_TIMEOUT_MS);
    if (!Array.isArray(list) || !list.length) return null;
    const pt = { lat: Number(list[0].lat), lng: Number(list[0].lon) };
    cache[key] = pt;
    store.set('geoCache', cache);
    return pt;
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
        hourly: 'precipitation_probability',
        timezone: 'auto',
        start_date: date,
        end_date: date,
      });
      const json = await fetchJson(url, CFG.WEATHER_TIMEOUT_MS);
      const times = (json.hourly && json.hourly.time) || [];
      const probs = (json.hourly && json.hourly.precipitation_probability) || [];
      const [from, to] = CFG.DINNER_HOURS;
      const vals = [];
      times.forEach((t, i) => {
        const hour = Number(t.slice(11, 13));
        if (t.startsWith(date) && hour >= from && hour <= to && typeof probs[i] === 'number') vals.push(probs[i]);
      });
      if (!vals.length) return { status: 'none' };
      const maxProb = Math.max(...vals);
      return { status: 'ok', maxProb, rain: maxProb >= CFG.RAIN_PROB_THRESHOLD };
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

  // 종합점수 = (v×R + m×C) ÷ (v+m), C = 이번 후보 전체 평균 별점.
  // 후보가 적으면 평균이 한두 곳에 휘둘리므로 BAYES_C_MIN_CANDIDATES 미만일 때는 BAYES_C_DEFAULT를 쓴다.
  // 별점이나 리뷰 수가 없는 후보는 순위에서 빼고 unscored로 돌려준다.
  function rankCandidates(input) {
    const all = Object.values(getPlaces()).filter((p) => matchesInput(p, input));
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
  function weatherText(input, w) {
    const d = fmtShort(input.date);
    if (!w || w.status === 'error') return { cls: 'none', text: `${d} 날씨 정보를 불러오지 못했어요 (날씨 취소선 생략)` };
    if (w.status === 'none') return { cls: 'none', text: `${d} 예보 없음` };
    return w.rain
      ? { cls: 'rain', text: `${d} 저녁 강수확률 ${w.maxProb}% · 비 예보` }
      : { cls: '', text: `${d} 저녁 강수확률 ${w.maxProb}% · 비 소식 없음` };
  }
  function inputSummary(input) {
    const space = SPACES.find(([k]) => k === input.space)[1];
    const parts = [input.area, fmtShort(input.date), `${input.people}명`, input.genre, `공간 ${space}`];
    if (input.parking) parts.push('주차 필요');
    return parts.map((p) => `<strong>${esc(p)}</strong>`).join(' · ');
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
      ${topbar('회식 장소 추천기')}
      <p class="subtitle">조건을 넣고 지도에서 찾은 후보를 적으면, 믿을 만한 Top ${CFG.TOP_N}과 예약 정보를 한 화면에 정리해 드려요.</p>
      <form id="input-form" class="card" novalidate>
        <div class="field">
          <label for="f-area">지역 <span class="req">*</span></label>
          <input id="f-area" class="input" name="area" type="text" placeholder="예: 강남역, 성수동" value="${esc(v.area)}" autocomplete="off" enterkeyhint="search">
          <div class="field-error" id="err-area" hidden>지역(동네·역 이름)을 입력해 주세요.</div>
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
        </div>
      </form>
      ${bottomBar('<button class="btn btn-primary btn-block" type="submit" form="input-form">추천 받기</button>')}
    `;

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
      location.hash = '#/results';
    });
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
              ? `★ ${p.rating.toFixed(1)} · 리뷰 ${p.reviews.toLocaleString('ko-KR')}개`
              : '별점·리뷰 수를 적으면 순위에 들어가요'}</div>
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

  async function renderResults() {
    const input = currentInput();
    if (!input.area) { location.hash = '#/'; return; }
    const token = ++state.renderToken;
    const q = buildQuery(input);
    const { ranked, unscored, total } = rankCandidates(input);
    const notes = getNotes();

    const draw = (weather) => {
      const w = weather ? weatherText(input, weather) : { cls: 'none', text: `${fmtShort(input.date)} 날씨 확인 중…` };
      const top = ranked.slice(0, CFG.TOP_N);
      const rest = ranked.slice(CFG.TOP_N);
      let list;
      if (!total) {
        list = stateView('', `<p>아직 "${esc(input.area)}${input.genre === '전체' ? '' : ' ' + esc(input.genre)}" 후보가 없어요.<br>위 지도에서 찾아보고 <strong>후보 추가</strong>로 적어 주세요.</p>`);
      } else {
        list = `
          ${top.length ? `<ol class="rank-list">${top.map((p, i) => rankItem(p, i, input, weather, notes)).join('')}</ol>` : ''}
          ${rest.length || unscored.length ? `
            <h2 class="section-title">나머지 후보 ${rest.length + unscored.length}곳</h2>
            <ol class="rank-list">
              ${rest.map((p, i) => rankItem(p, CFG.TOP_N + i, input, weather, notes)).join('')}
              ${unscored.map((p) => rankItem(p, null, input, weather, notes)).join('')}
            </ol>` : ''}
          <p class="attribution">후보 ${total}곳 · 종합점수(베이지안 평균) 순</p>`;
      }
      $app.innerHTML = `
        ${topbar(`추천 Top ${CFG.TOP_N}`, '#/', '조건 바꾸기')}
        <section class="card">
          <div class="summary">${inputSummary(input)}</div>
          <div class="weather ${w.cls}">${esc(w.text)}</div>
        </section>
        <section class="card">
          <h2>지도에서 후보 찾기</h2>
          <p class="meta" style="margin:-6px 0 10px">"${esc(q)}" 검색 결과를 새 탭으로 열어요.</p>
          <div class="link-row">
            ${mapLinks(q).map(([label, href]) => `<a class="btn btn-sm" href="${esc(href)}" target="_blank" rel="noopener">${esc(label)}</a>`).join('')}
          </div>
          <p class="meta" style="margin:10px 0 0">별점·리뷰 수는 한 지도(예: 카카오맵)를 기준으로 통일해서 적어야 점수가 공정해요.</p>
        </section>
        ${list}
        ${bottomBar(`
          <a class="btn" href="#/">조건 바꾸기</a>
          <a class="btn btn-primary btn-block" href="#/add">+ 후보 추가</a>
        `)}
      `;
    };

    draw(state.weather && state.weather.key === normArea(input.area) + '|' + input.date ? state.weather.value : null);
    const weather = await ensureWeather(input);
    if (token !== state.renderToken) return;
    const y = window.scrollY;
    draw(weather);
    window.scrollTo(0, y);
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
            <label class="label" for="p-reviews">리뷰 수</label>
            <input id="p-reviews" class="input" name="reviews" type="text" inputmode="numeric" placeholder="1,500" value="${p.reviews == null ? '' : esc(p.reviews)}">
          </div>
        </div>
        <div class="field-error" id="err-score" hidden style="margin:-8px 0 12px">별점은 0~5, 리뷰 수는 0 이상의 정수로 적어 주세요.</div>
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
        <p class="meta" style="margin:0">별점·리뷰 수가 비어 있으면 "나머지 후보"에 들어가고 순위에는 빠져요.</p>
        ${existing ? '<button class="btn btn-block" type="button" id="del-place" style="margin-top:16px;color:var(--danger)">이 후보 삭제</button>' : ''}
      </form>
      ${bottomBar(`
        <a class="btn" href="${backHref}">취소</a>
        <button class="btn btn-primary btn-block" type="submit" form="place-form">저장</button>
      `)}
    `;
    if (!existing) document.getElementById('p-name').focus();

    const form = document.getElementById('place-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(form);
      const num = (k) => {
        const s = String(fd.get(k) || '').trim().replace(/,/g, '');
        return s === '' ? null : Number(s);
      };
      const next = {
        id: existing ? existing.id : uuid(),
        name: String(fd.get('name') || '').trim(),
        area: String(fd.get('area') || '').trim(),
        genre: String(fd.get('genre') || '기타'),
        rating: num('rating'),
        reviews: num('reviews'),
        phone: String(fd.get('phone') || '').trim(),
        address: String(fd.get('address') || '').trim(),
        link: String(fd.get('link') || '').trim(),
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
          ${place.rating != null ? `★ ${place.rating.toFixed(1)}` : '별점 없음'}${place.reviews != null ? ` · 리뷰 ${place.reviews.toLocaleString('ko-KR')}개` : ''}
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
