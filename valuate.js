/* valuate.js — форма ручного ввода → POST 6.valuate/api.py → рендер результата.
 * Автономная страница (без общего state с app.js — своя маленькая независимая
 * форма, MVP шаг пивота), но переиспользует общий site-ui.js для темы/языка/
 * профиля (решение юзера 2026-09-23: язык и профиль нужны на всех новых
 * страницах, не только на app.html).
 */

import { initTheme, initLang, initProfile } from "./site-ui.js?v=202610040158";
// Адрес бэкенда: localhost в исходниках, живой адрес туннеля в опубликованной
// копии — см. api-base.js.
import { API_BASE } from "./api-base.js?v=202610040158";

const $ = (s) => document.querySelector(s);

// Те же районы, что в config_scoring.DISTRICT_SCORES (2.scoring/config_scoring.py) —
// список не приходит с бэкенда специально: страница должна показать варианты
// ДО первого запроса к /valuate, а не после. Названия районов — официальные
// польские топонимы, не переводятся при смене языка (как и на app.html).
const DISTRICTS = [
  "Śródmieście", "Mokotów", "Żoliborz", "Ochota", "Ursynów", "Wola", "Wilanów",
  "Bielany", "Bemowo", "Praga-Południe", "Praga-Północ", "Targówek", "Włochy",
  "Ursus", "Białołęka", "Wawer", "Rembertów", "Wesoła",
];

// Языконезависимые ключи (те же значения, что принимает 6.valuate/api.py и
// что использует LABEL.mt/ut/cs в app.js) — отображаемые подписи берутся из
// T[lang].market/seller/cond ниже, сам ключ в payload не переводится.
const MARKET_VALUES = ["primary", "secondary"];
const SELLER_VALUES = ["private", "developer", "agency"];
// condition принимается бэкендом и эхо, но пока НЕ участвует в скоринге
// (в LISTING_RULES нет отдельной шкалы состояния — см. докстринг api.py).
const COND_VALUES = ["ready_to_use", "to_completion", "to_renovation"];

// Канонические ключи осей — ТЕ ЖЕ строки, что ключи SCORE_AXES
// (2.scoring/config_scoring.py), backend ждёт axis_weights именно с такими
// ключами независимо от языка интерфейса. Отображаемая подпись — отдельно,
// через T[lang].axes[i] (тот же порядок) — переключение языка НЕ должно
// стирать выставленные пользователем веса осей.
const AXIS_IDS = ["Транспорт", "Инфраструктура", "Зелень и тишина", "Соседство", "Квартира и дом"];

const T = {
  ru: {
    val_header_label: "Оценка квартиры",
    theme_t: "Светлая / тёмная тема",
    hero_h1: "Оценить квартиру",
    hero_p: "Введите адрес и параметры вручную или вставьте ссылку на объявление — "
      + "поля заполнятся сами. Обязательно только местоположение, остальное можно пропустить.",
    loc_title: "Местоположение",
    mode_address: "По адресу", mode_coords: "Координаты", mode_link: "По ссылке",
    addr_label: "Адрес в Варшаве", addr_ph: "например, Prosta 67",
    link_label: "Ссылка на объявление",
    link_note: "Площадь, комнаты, этаж, цена и район подставятся со страницы объявления. "
      + "Если сейчас автозаполнение недоступно — переключитесь на «По адресу» или «Координаты».",
    apt_title: "Квартира",
    area_label: "Площадь, м²", rooms_label: "Комнаты", floor_label: "Этаж",
    total_floors_label: "Этажей в доме", year_label: "Год постройки", price_label: "Цена, PLN",
    cat_title: "Район и тип",
    district_label: "Район", district_blank: "— не указан —",
    market_label: "Рынок", seller_label: "Продавец", cond_label: "Состояние",
    axes_title: "Что важнее",
    submit_default: "Оценить", submit_link: "Заполнить и оценить",
    submit_busy_manual: "Считаю…", submit_busy_link: "Загружаю…",
    back_link: "← Ко всем квартирам в базе",
    err_no_address: "Введите адрес или переключитесь на ручные координаты.",
    err_no_coords: "Заполните оба поля: lat и lon.",
    err_no_link: "Вставьте ссылку на объявление.",
    err_manual_hint: " Переключитесь на «По адресу» или «Координаты вручную», чтобы ввести данные самостоятельно.",
    err_backend: (base, msg) => `Не удалось связаться с сервером оценки (${base}). Бэкенд запущен? (${msg})`,
    result_title: "Результат",
    score_label: "из 100 · по той же шкале, что квартиры в базе",
    f_addr: "Адрес", f_coords: "Координаты", f_noise: "Шум", f_gaps: "Не заполнено",
    f_link: "По ссылке", f_price_page: "Цена на странице",
    noise_val: (v) => `~${v} дБ, карта шума города`,
    gaps_val: (n) => n === 0 ? "всё заполнено"
      : `${n} ${n % 10 === 1 && n % 100 !== 11 ? "поле" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "поля" : "полей"} — оценка по остальным`,
    raw_score_label: "сырой балл — без сравнения с базой",
    norm_unavailable_default: "Нормализация недоступна — показан только сырой балл.",
    gaps_label: (n) => `Не заполнено полей: ${n}`,
    found_by_link: (bits, title) => `Нашли по ссылке${title ? " " + title : ""}${bits ? ": " + bits : ""}`,
    price_on_page: (p) => `Цена на странице: ${p} PLN`,
    found_address: (addr) => `Нашли: ${addr}`,
    coords_label: (lat, lon) => `Координаты: ${lat}, ${lon}`,
    noise_label: (v) => `Шум (карта города, приближённо): ~${v} дБ`,
    rooms_suffix: "-комн.", floor_prefix: "эт. ",
    market: { primary: "Первичка", secondary: "Вторичка" },
    seller: { private: "Собственник", developer: "Застройщик", agency: "Агентство" },
    cond: { ready_to_use: "Под ключ", to_completion: "Под отделку", to_renovation: "Под ремонт" },
    axes: ["Транспорт", "Инфраструктура", "Зелень и тишина", "Соседство", "Квартира и дом"],
  },
  pl: {
    val_header_label: "Wycena mieszkania",
    theme_t: "Jasny / ciemny motyw",
    hero_h1: "Wyceń mieszkanie",
    hero_p: "Podaj adres i parametry ręcznie albo wklej link do ogłoszenia — pola "
      + "uzupełnią się same. Wymagana jest tylko lokalizacja, resztę można pominąć.",
    loc_title: "Lokalizacja",
    mode_address: "Według adresu", mode_coords: "Współrzędne", mode_link: "Wg linku",
    addr_label: "Adres w Warszawie", addr_ph: "np. Prosta 67",
    link_label: "Link do ogłoszenia",
    link_note: "Powierzchnia, pokoje, piętro, cena i dzielnica uzupełnią się ze strony ogłoszenia. "
      + "Jeśli autouzupełnianie jest teraz niedostępne — przełącz się na „Według adresu” lub „Współrzędne”.",
    apt_title: "Mieszkanie",
    area_label: "Powierzchnia, m²", rooms_label: "Pokoje", floor_label: "Piętro",
    total_floors_label: "Pięter w budynku", year_label: "Rok budowy", price_label: "Cena, PLN",
    cat_title: "Dzielnica i typ",
    district_label: "Dzielnica", district_blank: "— nie podano —",
    market_label: "Rynek", seller_label: "Sprzedający", cond_label: "Stan",
    axes_title: "Co ważniejsze",
    submit_default: "Oceń", submit_link: "Uzupełnij i oceń",
    submit_busy_manual: "Liczę…", submit_busy_link: "Wczytuję…",
    back_link: "← Do wszystkich mieszkań w bazie",
    err_no_address: "Podaj adres albo przełącz się na ręczne współrzędne.",
    err_no_coords: "Wypełnij oba pola: lat i lon.",
    err_no_link: "Wklej link do ogłoszenia.",
    err_manual_hint: " Przełącz się na „Według adresu” lub „Współrzędne ręcznie”, aby wprowadzić dane samodzielnie.",
    err_backend: (base, msg) => `Nie udało się połączyć z serwerem wyceny (${base}). Backend jest uruchomiony? (${msg})`,
    result_title: "Wynik",
    score_label: "ze 100 · w tej samej skali co mieszkania w bazie",
    f_addr: "Adres", f_coords: "Współrzędne", f_noise: "Hałas", f_gaps: "Nie wypełniono",
    f_link: "Z linku", f_price_page: "Cena na stronie",
    noise_val: (v) => `~${v} dB, mapa hałasu miasta`,
    gaps_val: (n) => n === 0 ? "wszystko wypełnione"
      : `${n} ${n === 1 ? "pole" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "pola" : "pól"} — ocena z pozostałych`,
    raw_score_label: "surowy wynik — bez porównania z bazą",
    norm_unavailable_default: "Normalizacja niedostępna — pokazano tylko surowy wynik.",
    gaps_label: (n) => `Brakujące pola: ${n}`,
    found_by_link: (bits, title) => `Znaleziono przez link${title ? " " + title : ""}${bits ? ": " + bits : ""}`,
    price_on_page: (p) => `Cena na stronie: ${p} PLN`,
    found_address: (addr) => `Znaleziono: ${addr}`,
    coords_label: (lat, lon) => `Współrzędne: ${lat}, ${lon}`,
    noise_label: (v) => `Hałas (mapa miasta, przybliżony): ~${v} dB`,
    rooms_suffix: "-pok.", floor_prefix: "p. ",
    market: { primary: "Pierwotny", secondary: "Wtórny" },
    seller: { private: "Właściciel", developer: "Deweloper", agency: "Biuro nieruchomości" },
    cond: { ready_to_use: "Do zamieszkania", to_completion: "Do wykończenia", to_renovation: "Do remontu" },
    axes: ["Transport", "Infrastruktura", "Zieleń i cisza", "Sąsiedztwo", "Mieszkanie i budynek"],
  },
};

let tr = (k) => T.ru[k] ?? k;   // заменится реальным tr() из initLang() ниже

const state = {
  locMode: "address",
  market: null, seller: null, cond: null,
  axisWeights: Object.fromEntries(AXIS_IDS.map((a) => [a, 1.0])),
};

let lastResultData = null;   // последний успешный ответ — для перерисовки при смене языка

// ── Район (select) ───────────────────────────────────────────────────────────
function buildDistrictSelect() {
  const sel = $("#v-district");
  const blank = document.createElement("option");
  blank.value = ""; blank.dataset.blank = "1";
  sel.appendChild(blank);
  DISTRICTS.forEach((d) => {
    const opt = document.createElement("option");
    opt.value = d; opt.textContent = d;
    sel.appendChild(opt);
  });
  relabelDistrictBlank();
}

function relabelDistrictBlank() {
  const blank = $("#v-district").querySelector('option[data-blank="1"]');
  if (blank) blank.textContent = tr("district_blank");
}

// ── Группы чипов с single-select (клик по выбранному — снимает выбор) ───────
// Строим из языконезависимых значений (MARKET_VALUES/…) — подпись кладём
// отдельно через relabelChipGroup(), чтобы смена языка не пересоздавала
// кнопки (и не теряла обработчики/выбранное состояние).
function buildChipGroup(hostId, values, stateKey) {
  const host = $(hostId);
  values.forEach((value) => {
    const b = document.createElement("button");
    b.type = "button";
    b.type = "button";
    b.className = "chip ds-chip";
    b.dataset.value = value;
    b.setAttribute("aria-pressed", "false");
    b.onclick = () => {
      const wasOn = b.getAttribute("aria-pressed") === "true";
      host.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
      state[stateKey] = wasOn ? null : value;
      if (!wasOn) b.setAttribute("aria-pressed", "true");
    };
    host.appendChild(b);
  });
}

function relabelChipGroup(hostId, labels) {
  $(hostId).querySelectorAll(".chip").forEach((b) => {
    b.textContent = labels[b.dataset.value] ?? b.dataset.value;
  });
}

// Программно выставляет чип по значению (или снимает выбор, если value == null) —
// переиспользует click() существующего чипа вместо дублирования его логики.
function setChipState(hostId, stateKey, value) {
  const host = $(hostId);
  const chips = Array.from(host.querySelectorAll(".chip"));
  chips.forEach((c) => c.setAttribute("aria-pressed", "false"));
  state[stateKey] = null;
  if (value == null) return;
  const target = chips.find((c) => c.dataset.value === value);
  if (target) target.click();
}

// ── Переключатель адрес / координаты / ссылка на Otodom ─────────────────────
// Три режима местоположения (см. valuate.html #loc-mode): "address", "coords",
// "link". В режиме "link" разделы «Квартира» и «Район/рынок/продавец/состояние»
// скрыты — их значения придут со страницы объявления, дублировать поля не нужно.
function setLocMode(mode) {
  const host = $("#loc-mode");
  host.querySelectorAll(".chip").forEach((c) => {
    c.setAttribute("aria-pressed", c.dataset.mode === mode ? "true" : "false");
  });
  state.locMode = mode;
  $("#loc-address").hidden = mode !== "address";
  $("#loc-coords").hidden = mode !== "coords";
  $("#loc-link").hidden = mode !== "link";
  $("#fgrp-apartment").hidden = mode === "link";
  $("#fgrp-categories").hidden = mode === "link";
  updateSubmitLabel();
}

function updateSubmitLabel() {
  $("#v-submit").textContent = state.locMode === "link" ? tr("submit_link") : tr("submit_default");
}

function buildLocModeToggle() {
  $("#loc-mode").querySelectorAll(".chip").forEach((b) => {
    b.onclick = () => setLocMode(b.dataset.mode);
  });
}

// ── Ползунки важности осей ──────────────────────────────────────────────────
// row.dataset.axisId хранит канонический (русский, для backend) ключ оси —
// отображаемая подпись меняется языком отдельно, см. relabelAxisRows().
function buildAxisSliders() {
  const host = $("#v-axes");
  AXIS_IDS.forEach((axisId) => {
    const row = document.createElement("div");
    row.className = "ds-range-row";
    row.dataset.axisId = axisId;
    const name = document.createElement("span");
    const input = document.createElement("input");
    input.type = "range"; input.className = "ds-range";
    input.min = "0"; input.max = "2"; input.step = "0.1"; input.value = "1";
    const val = document.createElement("span");
    val.textContent = "1.0×";
    input.oninput = () => {
      const v = parseFloat(input.value);
      state.axisWeights[axisId] = v;
      val.textContent = v.toFixed(1) + "×";
    };
    row.append(name, input, val);
    host.appendChild(row);
  });
  relabelAxisRows();
}

function relabelAxisRows() {
  $("#v-axes").querySelectorAll(".ds-range-row").forEach((row) => {
    row.firstElementChild.textContent = axisLabel(row.dataset.axisId);
  });
}

function axisLabel(axisId) {
  const i = AXIS_IDS.indexOf(axisId);
  const lang = document.documentElement.lang === "pl" ? "pl" : "ru";
  return T[lang].axes[i] ?? axisId;
}

// ── Сбор payload и его минимальная фронтовая валидация ──────────────────────
function numOrNull(id) {
  const v = $(id).value;
  return v === "" ? null : Number(v);
}

function buildPayload() {
  const payload = {
    area_m2: numOrNull("#v-area"),
    rooms: numOrNull("#v-rooms"),
    floor: numOrNull("#v-floor"),
    total_floors: numOrNull("#v-total-floors"),
    build_year: numOrNull("#v-year"),
    price: numOrNull("#v-price"),
    district: $("#v-district").value || null,
    market_type: state.market,
    user_type: state.seller,
    condition: state.cond,
    axis_weights: state.axisWeights,
  };
  if (state.locMode === "address") {
    payload.address = $("#v-address").value.trim();
  } else {
    payload.lat = numOrNull("#v-lat");
    payload.lon = numOrNull("#v-lon");
  }
  return payload;
}

function validateFront(payload) {
  if (state.locMode === "address") {
    if (!payload.address) return tr("err_no_address");
  } else {
    if (payload.lat == null || payload.lon == null) return tr("err_no_coords");
  }
  return null;
}

// ── Рендер результата ────────────────────────────────────────────────────────
function bar(name, value) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return `<span>${esc(name)}</span>
    <span class="ds-bars__track"><span class="ds-bars__fill" style="width:${v}%"></span></span>
    <span class="ds-bars__val">${v}</span>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

/* Короткий адрес для результата: что ввёл человек + район из ответа
 * геокодера. Полная строка Nominatim («Skyliner, 67, Prosta, Czyste, Wola,
 * Warszawa, województwo…, 00-838, Polska») нечитаема; она остаётся в title. */
function shortAddress(typed, resolved, district) {
  const d = district || DISTRICTS.find((x) => (resolved || "").includes(x));
  const base = (typed || "").trim() || (resolved || "").split(",").slice(0, 2).join(",").trim();
  return [base, d, "Warszawa"].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ");
}

function renderResult(data) {
  lastResultData = data;
  const host = $("#v-result");
  host.hidden = false;

  const scoreRow = data.score != null
    ? `<div class="ds-score"><span class="ds-score__num">${Math.round(data.score)}</span><span class="ds-score__label">${esc(tr("score_label"))}</span></div>`
    : `<div class="ds-score"><span class="ds-score__num">${Math.round(data.raw_score)}</span><span class="ds-score__label">${esc(tr("raw_score_label"))}</span></div>`;

  const axesRows = AXIS_IDS.map((axisId) => {
    const a = data.axes && data.axes[axisId];
    if (!a || a.pct_of_max == null) return "";
    return bar(axisLabel(axisId), a.pct_of_max);
  }).join("");

  const facts = [];
  const fact = (k, v, title) => facts.push(
    `<dt>${esc(k)}</dt><dd${title ? ` title="${esc(title)}"` : ""}>${esc(v)}</dd>`);
  if (data.parsed_from) {
    // Эхо того, что распознали на странице объявления (api.py: /valuate/from-link, "parsed_from")
    const p = data.parsed_from;
    const bits = [];
    if (p.rooms != null) bits.push(`${p.rooms}${tr("rooms_suffix")}`);
    if (p.area_m2 != null) bits.push(`${p.area_m2} м²`);
    if (p.floor != null) bits.push(`${tr("floor_prefix")}${p.floor}${p.total_floors != null ? `/${p.total_floors}` : ""}`);
    if (p.district) bits.push(p.district);
    fact(tr("f_link"), [p.title, bits.join(", ")].filter(Boolean).join(" — "));
    if (p.price != null) fact(tr("f_price_page"), `${Math.round(p.price).toLocaleString("ru-RU")} PLN`);
  }
  if (data.location && data.location.resolved_address) {
    const typed = state.locMode === "address" ? $("#v-address").value : "";
    fact(tr("f_addr"), shortAddress(typed, data.location.resolved_address, data.location.district),
         data.location.resolved_address);
  }
  if (data.location) {
    fact(tr("f_coords"), `${data.location.lat.toFixed(5)}, ${data.location.lon.toFixed(5)}`);
  }
  if (data.noise_lden != null) fact(tr("f_noise"), tr("noise_val")(data.noise_lden));
  if (data.gaps != null) fact(tr("f_gaps"), tr("gaps_val")(data.gaps));

  host.innerHTML = `
    <h2 class="val-result-title">${esc(tr("result_title"))}</h2>
    ${scoreRow}
    ${!data.norm_available ? `<p class="ds-note val-warn">${esc(data.norm_error || tr("norm_unavailable_default"))}</p>` : ""}
    <div class="ds-bars">${axesRows}</div>
    <dl class="ds-facts">${facts.join("")}</dl>
  `;
}

function renderError(message) {
  const err = $("#v-err");
  err.hidden = false;
  err.textContent = message;
}

// ── Отправка ──────────────────────────────────────────────────────────────────
async function submit() {
  const err = $("#v-err");
  err.hidden = true; err.textContent = "";

  const payload = buildPayload();
  const frontError = validateFront(payload);
  if (frontError) return renderError(frontError);

  const btn = $("#v-submit");
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = tr("submit_busy_manual");
  try {
    const resp = await fetch(`${API_BASE}/valuate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      renderError((data && data.error) || `Ошибка сервера (${resp.status})`);
      return;
    }
    renderResult(data);
  } catch (e) {
    renderError(tr("err_backend")(API_BASE, e.message));
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

// ── Отправка по ссылке на Otodom ─────────────────────────────────────────────
// Один запрос к 6.valuate/api.py::POST /valuate/from-link даёт СРАЗУ и
// найденные поля, и результат оценки (см. докстринг api.py) — не два
// отдельных шага. Бэкенд сам следит за безопасностью (лок скрапера/дневной
// бюджет/kill switch на антибот) — фронт просто показывает то, что пришло,
// и на "недоступно сейчас" (HTTP 409, fallback:"manual") не ломает страницу,
// а предлагает переключиться на ручной ввод.
async function submitFromLink() {
  const err = $("#v-err");
  err.hidden = true; err.textContent = "";

  const url = $("#v-otodom-url").value.trim();
  if (!url) return renderError(tr("err_no_link"));

  const btn = $("#v-submit");
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = tr("submit_busy_link");
  try {
    const resp = await fetch(`${API_BASE}/valuate/from-link`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ otodom_url: url, axis_weights: state.axisWeights }),
    });
    const data = await resp.json().catch(() => null);
    if (!resp.ok) {
      const baseMsg = (data && data.error) || `Ошибка сервера (${resp.status})`;
      if (resp.status === 409 && data && data.fallback === "manual") {
        renderError(baseMsg + tr("err_manual_hint"));
      } else {
        renderError(baseMsg);
      }
      return;
    }
    renderResult(data);
    applyParsedFromToManualFields(data);
  } catch (e) {
    renderError(tr("err_backend")(API_BASE, e.message));
  } finally {
    btn.disabled = false;
    btn.textContent = prevLabel;
  }
}

// После успешного автозаполнения по ссылке переносим найденные значения в
// обычные ручные поля и переключаемся на режим «Координаты вручную» — все
// ДАЛЬНЕЙШИЕ пересчёты (подвинуть ползунок оси → «Оценить» ещё раз) идут
// через локальный /valuate (GIS с диска + БД для нормализации), БЕЗ повторного
// запроса к Otodom. Это единственный сетевой поход за весь сеанс правок.
function applyParsedFromToManualFields(data) {
  const p = data.parsed_from;
  if (!p || !data.location) return;

  $("#v-lat").value = data.location.lat;
  $("#v-lon").value = data.location.lon;
  if (p.area_m2 != null) $("#v-area").value = p.area_m2;
  if (p.rooms != null) $("#v-rooms").value = p.rooms;
  if (p.floor != null) $("#v-floor").value = p.floor;
  if (p.total_floors != null) $("#v-total-floors").value = p.total_floors;
  if (p.build_year != null) $("#v-year").value = p.build_year;
  if (p.price != null) $("#v-price").value = p.price;
  if (p.district_recognized && p.district) $("#v-district").value = p.district;

  setChipState("#v-market", "market", p.market_type || null);
  setChipState("#v-seller", "seller", p.user_type_recognized ? p.user_type : null);

  setLocMode("coords");
}

function onLangChange() {
  relabelDistrictBlank();
  relabelChipGroup("#v-market", tr("market"));
  relabelChipGroup("#v-seller", tr("seller"));
  relabelChipGroup("#v-cond", tr("cond"));
  relabelAxisRows();
  updateSubmitLabel();
  // Результат уже посчитан — перерисовываем теми же данными, чтобы подписи
  // (не только форма) тоже переключились на новый язык, без повторного запроса.
  if (lastResultData) renderResult(lastResultData);
}

function init() {
  buildDistrictSelect();
  buildChipGroup("#v-market", MARKET_VALUES, "market");
  buildChipGroup("#v-seller", SELLER_VALUES, "seller");
  buildChipGroup("#v-cond", COND_VALUES, "cond");
  buildLocModeToggle();
  buildAxisSliders();
  $("#v-submit").onclick = () => {
    if (state.locMode === "link") submitFromLink();
    else submit();
  };

  initTheme();
  initProfile();
  const langApi = initLang(T, () => onLangChange());
  tr = langApi.tr;
  onLangChange();   // подписи чипов/осей выставлены выше на RU-заглушках — сразу подгоняем под сохранённый язык
}

init();
