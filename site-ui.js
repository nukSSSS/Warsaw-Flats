// site-ui.js — общий модуль для новых страниц (homepage/market/valuate/
// list-apartment): тема, переключатель языка (RU/PL) и кнопка профиля.
//
// Общий файл вместо копии в каждой странице: тема уже была продублирована
// один в один в homepage.js/market.js, дублировать туда же ещё и язык, и
// профиль было бы той же ошибкой в третий и четвёртый раз. Свой, более
// простой набор функций — а не импорт app.js целиком: там логика карты и
// списка квартир, которой здесь нет, а словарь языка и меню профиля жёстко
// привязаны к разметке app.html (см. #tabs/#flt-panel/т.п.).
//
// Меню профиля (одна разметка на всех страницах, по макету «Мой профиль»)
// здесь только показывает счётчики избранного/скрытых/мест из localStorage;
// пункты — ссылки на app.html?view=fav|hidden и app.html#places. Вход по
// личной ссылке из бота (/profile) — syncProfile(): объединяет избранное и
// скрытые сайта с ботом (6.valuate/api.py: GET /profile, POST /profile/sync).
//
// Внешний файл, не инлайн-скрипт: CSP всех четырёх страниц — script-src
// 'self' без 'unsafe-inline', инлайн-скрипт эти страницы не пропустят.

import { API_BASE } from "./api-base.js?v=202610102210";

/* Тексты меню профиля — общие для всех страниц; initLang() подмешивает их
 * под словарь страницы (ключи страницы главнее). */
const MENU_T = {
  ru: { profile_device: "Это устройство · без входа", profile_in: "Вошли через Telegram",
        profile_a: "Профиль: избранное, скрытые, мои места",
        menu_fav: "Избранное", menu_hidden: "Скрытые", menu_places: "Мои места",
        menu_profile: "Мой профиль →", menu_login: "Войти через Telegram", menu_privacy: "Конфиденциальность" },
  pl: { profile_device: "To urządzenie · bez logowania", profile_in: "Zalogowano przez Telegram",
        profile_a: "Profil: ulubione, ukryte, moje miejsca",
        menu_fav: "Ulubione", menu_hidden: "Ukryte", menu_places: "Moje miejsca",
        menu_profile: "Mój profil →", menu_login: "Zaloguj przez Telegram", menu_privacy: "Prywatność" },
};
export const BOT_URL = "https://t.me/Flats_Warsaw_Bot";

/* Счётчик посещений (site_stats.py, api.py POST /hit): одна запись на
 * открытие страницы — страница, откуда пришли (домен) и метка ссылки ?src=
 * (например, ссылка, разосланная знакомым: ...?src=friends). Ни адреса, ни
 * cookie сайт не хранит. sendBeacon text/plain — без предварительного CORS-
 * запроса и не задерживает страницу. Локальная проверка (serve.py) не
 * считается. Модуль подключают все страницы — вызов здесь, один раз. */
/* Метка ссылки ?src= живёт всё посещение (sessionStorage): человек приходит
 * на главную, переходит в список — шаги воронки остаются за его меткой. */
function srcTag() {
  let s = (new URLSearchParams(location.search).get("src") || "").replace(/[^a-z0-9_-]/gi, "").slice(0, 20);
  try {
    if (s) sessionStorage.setItem("wf_src", s);
    else s = sessionStorage.getItem("wf_src") || "";
  } catch {}
  return s;
}

function trackVisit() {
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return;
  const page = (location.pathname.split("/").pop() || "index").replace(/\.html$/, "");
  let ref = "";
  try { const r = new URL(document.referrer); if (r.hostname !== host) ref = r.hostname; } catch {}
  const src = srcTag();
  try {
    navigator.sendBeacon(`${API_BASE}/hit`,
      new Blob([JSON.stringify({ p: page, r: ref, s: src })], { type: "text/plain" }));
  } catch {}
}
trackVisit();

/* Воронка (site_stats.py): шаги после открытия страницы — 'card' (открыл
 * карточку квартиры, шлёт app.js) и 'bot' (нажал ссылку на бота). Ссылкам на
 * бота дописываем ?start=web_<метка>: бот увидит её при первом /start и
 * запишет, что человек пришёл с сайта. */
export function trackEvent(e) {
  const host = location.hostname;
  if (host === "localhost" || host === "127.0.0.1") return;
  const page = (location.pathname.split("/").pop() || "index").replace(/\.html$/, "");
  const src = srcTag();
  try {
    navigator.sendBeacon(`${API_BASE}/hit`,
      new Blob([JSON.stringify({ p: page, s: src, e })], { type: "text/plain" }));
  } catch {}
}
document.addEventListener("click", (ev) => {
  const a = ev.target.closest?.('a[href^="https://t.me/Flats_Warsaw_Bot"]');
  if (!a) return;
  trackEvent("bot");
  try {
    const u = new URL(a.href);
    if (!u.searchParams.get("start")) {
      const src = srcTag();
      u.searchParams.set("start", src ? `web_${src}` : "web");
      a.href = u.toString();
    }
  } catch {}
}, true);

export function initTheme() {
  const btn = document.getElementById("theme");
  if (!btn) return;
  try {
    const saved = localStorage.getItem("wf_theme");
    const theme = saved || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    document.documentElement.setAttribute("data-theme", theme);
    btn.setAttribute("aria-pressed", String(theme === "dark"));
  } catch {}
  btn.onclick = () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    btn.setAttribute("aria-pressed", String(next === "dark"));
    try { localStorage.setItem("wf_theme", next); } catch {}
  };
}

/* T — {ru:{...}, pl:{...}}, свой на каждой странице (текст там разный).
 * onChange(lang, tr) — необязательный хук для текста, которого нет в
 * разметке как data-i18n* (например, текст, который страница сама
 * генерирует в JS — сообщения об ошибках, подписи результата). Вызывается
 * и сразу при загрузке (с сохранённым языком), и при каждом переключении.
 *
 * ?lang= в адресе главнее localStorage — тот же паритет, что в app.js
 * (комментарий там: «бот шлёт lang= осознанно, под язык подписчика»). Без
 * этого будущая диплинк-ссылка бота на любую из этих страниц игнорировала
 * бы выбранный подписчиком язык. */
export function initLang(T, onChange) {
  const btn = document.getElementById("lang");
  let LANG;
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "pl" || q === "ru") {
    LANG = q;
  } else {
    try { LANG = localStorage.getItem("wf_lang") || "ru"; } catch { LANG = "ru"; }
  }
  T = { ru: { ...MENU_T.ru, ...T.ru }, pl: { ...MENU_T.pl, ...T.pl } };
  const tr = (k) => (T[LANG] && T[LANG][k] !== undefined ? T[LANG][k] : T.ru[k]) ?? k;

  function apply() {
    document.documentElement.lang = LANG;
    if (btn) btn.textContent = LANG === "ru" ? "PL" : "RU";
    document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = tr(el.dataset.i18n); });
    document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = tr(el.dataset.i18nPh); });
    document.querySelectorAll("[data-i18n-title]").forEach((el) => { el.title = tr(el.dataset.i18nTitle); });
    document.querySelectorAll("[data-i18n-aria]").forEach((el) => { el.setAttribute("aria-label", tr(el.dataset.i18nAria)); });
    if (onChange) onChange(LANG, tr);
  }

  if (btn) {
    btn.onclick = () => {
      LANG = LANG === "ru" ? "pl" : "ru";
      try { localStorage.setItem("wf_lang", LANG); } catch {}
      // lang= в адресе — та же ссылка на эту страницу дальше открывается
      // на выбранном языке (скопировал/переслал — язык не потерялся).
      const p = new URLSearchParams(location.search);
      p.set("lang", LANG);
      history.replaceState(null, "", `?${p}`);
      apply();
    };
  }
  apply();
  return { lang: () => LANG, tr };
}

/* Кнопка профиля и её меню. Вызывать ДО initLang(): здесь выбирается ключ
 * строки состояния (вошли / без входа), текст подставит initLang(). */
export function initProfile() {
  const btn = document.getElementById("profile-btn");
  const menu = document.getElementById("profile-menu");
  if (!btn || !menu) return;
  const logged = !!profileToken();
  const status = document.getElementById("menu-status");
  if (status) status.dataset.i18n = logged ? "profile_in" : "profile_device";
  const foot = document.getElementById("menu-login-foot");
  if (foot) foot.hidden = logged;

  function setOpen(on) {
    menu.hidden = !on;
    btn.setAttribute("aria-expanded", String(on));
  }
  btn.onclick = (e) => { e.stopPropagation(); setOpen(menu.hidden); };
  menu.addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => setOpen(false));

  refreshMenuBadges();
  // вошли — избранное/скрытые из бота доливаются к себе, счётчики обновятся
  if (logged) syncProfile().then(() => refreshMenuBadges());
}

function _stored(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

/* Ключи квартир, которые сейчас в продаже (как в app.js: a.g || a.id).
 * Избранное/скрытые хранят и снятые с продажи — считать их нельзя: список
 * их всё равно не покажет. Тот же приём с версией, что в app.js::load():
 * meta.json мимо кеша, apartments.json — по его версии (обычно уже в кеше
 * браузера после списка). Не загрузилось — null, считаем все сохранённые. */
let _live = null;
export function liveKeys() {
  if (_live) return _live;
  _live = (async () => {
    try {
      const meta = await fetch(`data/meta.json?_=${Date.now()}`, { cache: "no-store" }).then((r) => r.json());
      const apts = await fetch(`data/apartments.json?v=${encodeURIComponent(meta.generated || "")}`).then((r) => r.json());
      return new Set(apts.map((a) => String(a.g || a.id)));
    } catch { return null; }
  })();
  return _live;
}

/* Сколько сохранённых (wf_fav / wf_hidden) сейчас в продаже. */
export async function liveCount(key) {
  const keys = await liveKeys();
  const saved = _stored(key).map(String);
  return keys ? saved.filter((k) => keys.has(k)).length : saved.length;
}

/* Счётчики меню. На app.html свои живые счётчики — там эта функция не
 * вызывается. */
export async function refreshMenuBadges() {
  const counts = { "menu-fav": await liveCount("wf_fav"), "menu-hidden": await liveCount("wf_hidden"),
                   "menu-places": _stored("wf_places").length };
  for (const [id, n] of Object.entries(counts)) {
    const b = document.querySelector(`#${id} .menu-badge`);
    if (b) { b.hidden = n === 0; b.textContent = String(n); }
  }
  const dot = document.getElementById("profile-dot");
  if (dot) dot.hidden = !(counts["menu-fav"] || counts["menu-hidden"]);
}

/* Вход по личной ссылке: профиль с сервера + объединение избранного и
 * скрытых с ботом (в обе стороны, объединением — удаление на одной стороне
 * другую не трогает). Один раз на загрузку страницы. Возвращает
 * {prefs, bot} или null (нет входа, ссылка отозвана, сервер недоступен).
 * Отозванная ссылка (401) — забываем токен: дальше страница без входа. */
let _sync = null;
export function syncProfile() {
  if (_sync) return _sync;
  _sync = (async () => {
    const tok = profileToken();
    if (!tok) return null;
    let data;
    try {
      const r = await fetch(`${API_BASE}/profile`, { headers: { "X-Profile-Token": tok } });
      if (r.status === 401) { forgetProfileToken(); return null; }
      if (!r.ok) return null;
      data = await r.json();
    } catch { return null; }
    const bot = data.bot || {};
    const push = {};
    for (const [key, name] of [["wf_fav", "favorites"], ["wf_hidden", "hidden"]]) {
      const mine = _stored(key).map(String);
      const theirs = (bot[name] || []).map(String);
      const merged = mine.concat(theirs.filter((k) => !mine.includes(k)));
      if (merged.length !== mine.length) {
        try { localStorage.setItem(key, JSON.stringify(merged)); } catch {}
      }
      const missing = mine.filter((k) => !theirs.includes(k));
      if (missing.length) push[name] = missing;
    }
    if (Object.keys(push).length) {
      try {
        await fetch(`${API_BASE}/profile/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Profile-Token": tok },
          body: JSON.stringify(push),
        });
      } catch {}
    }
    // места из профиля — и в этот браузер (счётчик меню на любой странице)
    if (Array.isArray((data.prefs || {}).places)) {
      try { localStorage.setItem("wf_places", JSON.stringify(data.prefs.places)); } catch {}
    }
    return { prefs: data.prefs || {}, bot };
  })();
  return _sync;
}

/* Токен личного профиля (profiles.py): бот выдаёт ссылку вида ...?t=<токен>.
 * Любая страница, открытая по такой ссылке, забирает токен в localStorage
 * (wf_ptoken) и убирает его из адресной строки — чтобы он не остался в
 * истории/закладках и не ушёл дальше при копировании ссылки. */
export function profileToken() {
  const p = new URLSearchParams(location.search);
  const t = p.get("t");
  if (t) {
    try { localStorage.setItem("wf_ptoken", t); } catch {}
    p.delete("t");
    const q = p.toString();
    history.replaceState(null, "", location.pathname + (q ? `?${q}` : "") + location.hash);
    return t;
  }
  try { return localStorage.getItem("wf_ptoken"); } catch { return null; }
}

export function forgetProfileToken() {
  try { localStorage.removeItem("wf_ptoken"); } catch {}
}

/* ── «Как считается рейтинг» (06.10.2026) ────────────────────────────────────
 * Один значок ⓘ у слова «Рейтинг» (список, карточка, «Оценить квартиру») и
 * нажатие на название оси открывают одно окно: что такое общий рейтинг и что
 * входит в каждую из пяти осей. Окно — <dialog> (Esc и клик мимо закрывают),
 * на телефоне — шторкой снизу (CSS). Порядок осей — SCORE_AXES. */
const GUIDE_URL = "https://worried-vibraphone-a1e.notion.site/Warsaw-Flats-3b2e528dc81880b48635e9b13d2ee44a";
const RH = {
  ru: {
    btn: "Как считается рейтинг", title: "Как считается рейтинг", close: "Закрыть",
    intro: "Общий рейтинг — среднее пяти оценок. Каждая показывает, лучше скольких квартир в базе эта квартира по своей теме: 70 — лучше 70%. Расстояния — пешком по улицам, а не по прямой.",
    axes: [
      ["Транспорт", "метро, трамвай, автобус, электричка и велодорожки рядом"],
      ["Инфраструктура", "магазины, детские сады, школы, вузы, больницы, спортзалы"],
      ["Зелень и тишина", "парки, лес, спортплощадки и уровень шума"],
      ["Соседство", "нет ли рядом крупных дорог, железной дороги, промзон, ЛЭП, аэропорта"],
      ["Квартира и дом", "цена за метр, площадь, комнаты, этаж, год постройки, удобства"],
    ],
    not: "Не учитывается: ремонт, вид из окна, планировка.", more: "Подробнее в гиде",
  },
  pl: {
    btn: "Jak liczona jest ocena", title: "Jak liczona jest ocena", close: "Zamknij",
    intro: "Ocena łączna to średnia pięciu ocen. Każda pokazuje, od ilu mieszkań w bazie to mieszkanie jest lepsze w danym obszarze: 70 — lepsze niż 70%. Odległości — pieszo ulicami, nie w linii prostej.",
    axes: [
      ["Transport", "metro, tramwaj, autobus, kolej i ścieżki rowerowe w pobliżu"],
      ["Infrastruktura", "sklepy, przedszkola, szkoły, uczelnie, szpitale, siłownie"],
      ["Zieleń i cisza", "parki, las, boiska i poziom hałasu"],
      ["Sąsiedztwo", "czy w pobliżu nie ma dużych dróg, kolei, przemysłu, linii wysokiego napięcia, lotniska"],
      ["Mieszkanie i budynek", "cena za metr, powierzchnia, pokoje, piętro, rok budowy, udogodnienia"],
    ],
    not: "Nie uwzględnia: wykończenia, widoku z okna, układu.", more: "Więcej w przewodniku",
  },
};
const rhLang = () => (document.documentElement.lang === "pl" ? "pl" : "ru");

/** HTML значка ⓘ; клик обрабатывается делегированием ниже. */
// inCard — внутри карточки списка (сама карточка — кнопка): мышью кликается,
// но в порядок Tab не попадает, иначе 6 лишних остановок на карточку (аудит 10.10.2026)
export function rateHelpBtn(inCard = false) {
  const t = RH[rhLang()];
  return `<button type="button" class="rh-btn" data-rh="" aria-label="${t.btn}" title="${t.btn}"${inCard ? ' tabindex="-1"' : ""}>?</button>`;
}

export function openRateHelp(axis = null) {
  const t = RH[rhLang()];
  let dlg = document.getElementById("rh-dlg");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "rh-dlg";
    dlg.className = "rh";
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });   // клик по подложке
    document.body.appendChild(dlg);
  }
  dlg.setAttribute("aria-labelledby", "rh-title");
  dlg.innerHTML = `<div class="rh-body">
      <div class="rh-head"><h2 id="rh-title">${t.title}</h2>
        <button type="button" class="rh-close" aria-label="${t.close}">✕</button></div>
      <p class="rh-intro">${t.intro}</p>
      <dl class="rh-axes">${t.axes.map(([n, d], i) =>
        `<div class="rh-ax${axis === i ? " rh-ax--on" : ""}"><dt>${n}</dt><dd>${d}</dd></div>`).join("")}</dl>
      <p class="rh-not">${t.not} <a href="${GUIDE_URL}" target="_blank" rel="noopener">${t.more}</a></p>
    </div>`;
  dlg.querySelector(".rh-close").onclick = () => dlg.close();
  if (!dlg.open) dlg.showModal();
  dlg.querySelector(".rh-ax--on")?.scrollIntoView({ block: "nearest" });
}

// ⓘ и названия осей (data-rh-axis="0…4") — в любом месте страницы; не даём клику
// дойти до карточки/строки сводки (иначе она бы раскрылась или выбралась)
document.addEventListener("click", (e) => {
  const el = e.target.closest?.("[data-rh], [data-rh-axis]");
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  openRateHelp(el.dataset.rhAxis != null ? Number(el.dataset.rhAxis) : null);
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.target.closest?.("[data-rh-axis]");
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  openRateHelp(Number(el.dataset.rhAxis));
}, true);
