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

import { API_BASE } from "./api-base.js?v=202610312009";

/* Тексты меню профиля — общие для всех страниц; initLang() подмешивает их
 * под словарь страницы (ключи страницы главнее). */
const MENU_T = {
  ru: { profile_device: "Это устройство · без входа", profile_in: "Вошли через Telegram",
        profile_a: "Профиль: избранное, скрытые, мои места",
        menu_fav: "Избранное", menu_hidden: "Скрытые", menu_places: "Мои места",
        menu_profile: "Мой профиль", menu_login: "Войти через Telegram", menu_privacy: "Конфиденциальность" },
  pl: { profile_device: "To urządzenie · bez logowania", profile_in: "Zalogowano przez Telegram",
        profile_a: "Profil: ulubione, ukryte, moje miejsca",
        menu_fav: "Ulubione", menu_hidden: "Ukryte", menu_places: "Moje miejsca",
        menu_profile: "Mój profil", menu_login: "Zaloguj przez Telegram", menu_privacy: "Prywatność" },
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

/* Ошибки сервера (6.valuate) приходят по-русски — в польской версии переводим известные
 * и подставляем общую фразу для остальных; технические сообщения JS («Failed to fetch»,
 * «Unexpected token») посетителю не показываем (аудит 21.10.2026). */
const SRV_PL = [
  ["Точка вне Варшавы", "Punkt poza Warszawą"],
  ["Место вне Варшавы", "Miejsce poza Warszawą"],
  ["Адрес не найден в Варшаве", "Nie znaleziono adresu w Warszawie"],
  ["Введите адрес", "Wpisz adres"],
  ["Укажите адрес или ссылку", "Podaj adres albo link do ogłoszenia Otodom"],
  ["Укажите местоположение", "Podaj lokalizację: adres albo współrzędne"],
  ["Укажите адрес квартиры", "Podaj adres mieszkania"],
  ["Укажите, как к вам обращаться", "Podaj, jak się do Ciebie zwracać"],
  ["Пока разбираем только объявления Otodom", "Na razie analizujemy tylko ogłoszenia z Otodom. Wyślij adres mieszkania — zrobimy raport po adresie."],
  ["Это не похоже на ссылку на объявление", "To nie wygląda na link do ogłoszenia Otodom"],
  ["Объявление снято с публикации", "Ogłoszenie zostało zdjęte albo nie istnieje."],
  ["На странице объявления", "W ogłoszeniu nie ma współrzędnych — zrób raport po adresie."],
  ["Геокодирование недоступно", "Wyszukiwanie adresów jest chwilowo niedostępne — wpisz współrzędne"],
  ["Ссылка на профиль недействительна", "Link do profilu jest nieważny — wyślij do bota /profile"],
  ["Не удалось отправить заявку", "Nie udało się wysłać zgłoszenia, spróbuj później"],
];
export function srvMsg(text, fallback) {
  const s = String(text || "").trim();
  if (!s || /Failed to fetch|NetworkError|Unexpected token|JSON|Load failed/i.test(s)) return fallback;
  if (document.documentElement.lang !== "pl" || !/[а-яё]/i.test(s)) return s;
  const hit = SRV_PL.find(([ru]) => s.startsWith(ru));
  return hit ? hit[1] : fallback;
}

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
    // заголовок вкладки по-польски (аудит 21.10): страница с page_title в словаре
    if (T[LANG] && typeof T[LANG].page_title === "string") document.title = T[LANG].page_title;
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
/* Изменения избранного/скрытого → бот (POST /profile/sync). Тело — любые из
 * favorites/hidden/unfavorites/unhidden. Без входа — ничего. */
export async function pushLists(changes, tok = profileToken()) {
  if (!tok) return;
  try {
    await fetch(`${API_BASE}/profile/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Profile-Token": tok },
      body: JSON.stringify(changes),
    });
  } catch {}
}

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
    /* Сверка «трёх сторон» (17.10.2026): этот браузер, бот и последнее общее
     * состояние (wf_*_base). Раньше было только объединение — удалённое на одной
     * стороне возвращалось с другой: «Вернуть» из скрытых на сайте не держалось.
     * Было в общем состоянии, а в боте нет — удалили в боте; в браузере нет —
     * удалили здесь. Первая сверка (базы ещё нет): база = этот браузер, т.е. всё
     * здешнее, чего нет у бота, считается удалённым в боте. */
    const merged = {};
    for (const [key, name] of [["wf_fav", "favorites"], ["wf_hidden", "hidden"]]) {
      const mine = _stored(key).map(String);
      const theirs = (bot[name] || []).map(String);
      let base;
      try { base = JSON.parse(localStorage.getItem(`${key}_base`) || "null"); } catch { base = null; }
      if (!Array.isArray(base)) base = mine;
      const gone = new Set(base.map(String).filter((k) => !theirs.includes(k) || !mine.includes(k)));
      merged[name] = [...new Set([...mine, ...theirs])].filter((k) => !gone.has(k));
    }
    // избранное и скрытое исключают друг друга; «и там, и там» — остаётся избранным
    merged.hidden = merged.hidden.filter((k) => !merged.favorites.includes(k));
    const push = {};
    for (const [key, name, un] of [["wf_fav", "favorites", "unfavorites"], ["wf_hidden", "hidden", "unhidden"]]) {
      const theirs = (bot[name] || []).map(String);
      const add = merged[name].filter((k) => !theirs.includes(k));
      const del = theirs.filter((k) => !merged[name].includes(k));
      if (add.length) push[name] = add;
      if (del.length) push[un] = del;
      try {
        localStorage.setItem(key, JSON.stringify(merged[name]));
        localStorage.setItem(`${key}_base`, JSON.stringify(merged[name]));
      } catch {}
    }
    if (Object.keys(push).length) await pushLists(push, tok);
    // места из профиля — и в этот браузер (счётчик меню на любой странице)
    if (Array.isArray((data.prefs || {}).places)) {
      try { localStorage.setItem("wf_places", JSON.stringify(data.prefs.places)); } catch {}
    }
    return { prefs: data.prefs || {}, bot };
  })();
  return _sync;
}

/* Встроенный браузер Telegram (16.10.2026): у него своё хранилище, и «Открыть в
 * Chrome/Safari» уносит только адрес — если токен из адреса убран, вход в профиль
 * теряется. Признаки: Telegram подмешивает в свой браузер TelegramWebviewProxy
 * (Android и iOS) и пишет «Telegram» в User-Agent (Android). */
export function inTelegramBrowser() {
  return typeof window.TelegramWebviewProxy !== "undefined" || /Telegram/i.test(navigator.userAgent || "");
}

/* Токен личного профиля (profiles.py): бот выдаёт ссылку вида ...?t=<токен>.
 * Любая страница, открытая по такой ссылке, забирает токен в localStorage
 * (wf_ptoken) и убирает его из адресной строки — чтобы он не остался в
 * истории/закладках и не ушёл дальше при копировании ссылки. Исключение —
 * встроенный браузер Telegram: там токен остаётся в адресе (и возвращается
 * туда, если его уже нет), чтобы «Открыть в браузере» перенесло и вход. */
export function profileToken() {
  const p = new URLSearchParams(location.search);
  const t = p.get("t");
  if (t) {
    try { localStorage.setItem("wf_ptoken", t); } catch {}
    if (!inTelegramBrowser()) {
      p.delete("t");
      const q = p.toString();
      history.replaceState(null, "", location.pathname + (q ? `?${q}` : "") + location.hash);
    }
    return t;
  }
  let saved = null;
  try { saved = localStorage.getItem("wf_ptoken"); } catch {}
  if (saved && inTelegramBrowser()) {
    p.set("t", saved);
    history.replaceState(null, "", `${location.pathname}?${p}${location.hash}`);
  }
  return saved;
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
/* «Как считается время до мест» (19.10.2026) — то же окно, другой текст:
 * юзер: «значок с пояснением, как для рейтинга — всегда будет ясно, как время
 * рассчитано». Пункты — dt/dd, как оси. */
const RH_COMMUTE = {
  ru: {
    btn: "Как считается время", title: "Как считается время до мест", close: "Закрыть",
    intro: "От двери до двери по расписаниям ZTM, Koleje Mazowieckie и WKD: пешком до остановки, ожидание, поездка с пересадками и пешком от остановки до места. Берётся среднее двух утренних поездок — к месту к 9:00 и от места в 8:00.",
    axes: [
      ["Пешком до остановки", "уже входит в общее время. Остановки дальше предела из «Моих мест» (10, 15 или 20 мин) не учитываются; от 5 мин в списке — значок пешехода с минутами"],
      ["Метро, трамвай, электричка", "основные виды; на поезд закладывается 3 минуты запаса"],
      ["Автобус", "основным — только если без него не доехать. Если автобусом быстрее на 10+ мин — вторая строка «автобусом N мин»"],
      ["Пешком", "если до места ближе пешком, чем на транспорте"],
    ],
    not: "Не учитываются: опоздания, пробки и ремонты на линиях.", more: "Подробнее в гиде",
  },
  pl: {
    btn: "Jak liczony jest czas", title: "Jak liczony jest czas dojazdu", close: "Zamknij",
    intro: "Od drzwi do drzwi według rozkładów ZTM, Kolei Mazowieckich i WKD: pieszo do przystanku, oczekiwanie, przejazd z przesiadkami i pieszo od przystanku do miejsca. Średnia z dwóch porannych przejazdów — do miejsca na 9:00 i z miejsca o 8:00.",
    axes: [
      ["Pieszo do przystanku", "już wliczone w łączny czas. Przystanki dalej niż limit z „Moich miejsc” (10, 15 lub 20 min) nie są brane pod uwagę; od 5 min na liście — ikona pieszego z minutami"],
      ["Metro, tramwaj, kolej", "główne środki; na pociąg doliczamy 3 minuty zapasu"],
      ["Autobus", "jako główny — tylko gdy bez niego nie da się dojechać. Jeśli autobusem jest szybciej o 10+ min — druga linia „autobusem N min”"],
      ["Pieszo", "gdy pieszo jest szybciej niż komunikacją"],
    ],
    not: "Nie uwzględnia: opóźnień, korków i remontów linii.", more: "Więcej w przewodniku",
  },
};
const rhLang = () => (document.documentElement.lang === "pl" ? "pl" : "ru");

/** HTML значка ⓘ; клик обрабатывается делегированием ниже. */
// inCard — внутри карточки списка (сама карточка — кнопка): мышью кликается,
// но в порядок Tab не попадает, иначе 6 лишних остановок на карточку (аудит 10.10.2026)
export function rateHelpBtn(inCard = false, kind = "") {
  const t = (kind === "commute" ? RH_COMMUTE : RH)[rhLang()];
  return `<button type="button" class="rh-btn" data-rh="${kind}" aria-label="${t.btn}" title="${t.btn}"${inCard ? ' tabindex="-1"' : ""}>?</button>`;
}

export function openRateHelp(axis = null, kind = "") {
  const t = (kind === "commute" ? RH_COMMUTE : RH)[rhLang()];
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
  openRateHelp(el.dataset.rhAxis != null ? Number(el.dataset.rhAxis) : null, el.dataset.rh || "");
}, true);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const el = e.target.closest?.("[data-rh-axis]");
  if (!el) return;
  e.preventDefault();
  e.stopPropagation();
  openRateHelp(Number(el.dataset.rhAxis));
}, true);
