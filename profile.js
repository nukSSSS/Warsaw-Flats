/* profile.js — «Мой профиль»: сборник по макету (канвас «Мой профиль —
 * макет», 29.09.2026). Без входа — всё из localStorage этого браузера
 * (избранное wf_fav, скрытые wf_hidden, места wf_places, «Важно для меня»
 * wf_want). Вход по личной ссылке из бота (/profile) — site-ui.js::
 * syncProfile(): места из профиля на сервере, избранное/скрытые объединены с
 * ботом, плюс поиск бота (фильтры и уведомления). Менять поиск — на сайте
 * (кнопка «Сохранить поиск» над списком; с 13.10.2026 поиск один на сайте и в боте —
 * блок «Мой поиск») или в самом боте. */
import { initTheme, initLang, initProfile, profileToken, forgetProfileToken, syncProfile, liveCount, srvMsg } from "./site-ui.js?v=202610241540";
import { API_BASE } from "./api-base.js?v=202610241540";

const T = {
  ru: {
    page_title: "Warsaw Flats — мой профиль",
    pf_header: "Мой профиль", pf_h1: "Мой профиль",
    pf_open: "Открыть в списке", pf_edit: "Изменить", pf_want: "Важно для меня",
    pf_fav_in: "В профиле: одинаково на всех устройствах и в боте.",
    pf_local: "Только в этом браузере.",
    pf_hidden_in: "Не показываются в списке и в уведомлениях бота.",
    pf_hidden_out: "Не показываются в списке.",
    pf_places_note: (n) => `Время на транспорте до них видно у каждой квартиры. По «${n}» — фильтр по времени в пути.`,
    pf_places_none: "Мест пока нет. Добавьте работу, школу — и у каждой квартиры будет время в пути до них.",
    pf_want_note: "Квартиры с этим — выше в списке. Меняется прямо над списком.",
    pf_want_none: "Ничего не выбрано.",
    pf_search_t: "Мой поиск", pf_search_tag: "на сайте и в боте", pf_show: "Показать квартиры",
    pf_notify_on: "Один поиск на сайте и в Telegram: по нему открывается список и приходят уведомления о новых квартирах — днём примерно каждые 2 часа (08:00–22:00), только когда есть новое.",
    pf_notify_off: "Один поиск на сайте и в Telegram: по нему открывается список. Уведомления о новых квартирах выключены — включить: /subscribe в боте или «Сохранить поиск» над списком.",
    pf_diff: "На сайте сейчас другой поиск:", pf_diff_tail: "Он не сохранён, бот о нём не знает.",
    pf_diff_save: "Сохранить как мой поиск", pf_diff_open: "Открыть его", pf_saving: "Сохраняю…",
    pf_save_err: "Не удалось сохранить — попробуйте ещё раз.",
    pf_no_filters: "Фильтры не заданы — все квартиры",
    pf_tg_note: "Профиль привязан к вашему чату с ботом. Избранное и скрытые объединяются с ботом при каждом открытии сайта.",
    pf_logout: "Выйти на этом устройстве",
    pf_offline: "Вход есть · сервер недоступен",
    pf_offline_text: "Сервер профиля сейчас не отвечает — вход сохранён, данные загрузятся, когда он вернётся. Обновите страницу через несколько минут.",
    pf_login_text: "Напишите боту команду <b>/profile</b> — он пришлёт ссылку для входа. После входа избранное, скрытые и места будут одинаковыми на всех устройствах и в боте, а здесь появится ваш поиск из бота.",
    pf_open_bot: "Открыть бота",
    rooms: (r) => `${r} комн.`, area: (a) => `от ${a} м²`, price: (p) => `до ${p} тыс. zł`,
    price_min: (p) => `от ${p} тыс. zł`, area_max: (a) => `до ${a} м²`, year: (y) => `год ${y}`,
    commute: (m) => `в пути ≤ ${m} мин`, axes: (n) => `оценки по осям: ${n}`,
    all_d: "все районы", districts: (n) => `${n} районов`,
    mt: { primary: "первичка", secondary: "вторичка" },
    cs: { ready_to_use: "под ключ", to_completion: "под отделку", to_renovation: "под ремонт" },
    wa: { g: "Сад", l: "Лифт", u: "Кладовка", b: "Балкон", t: "Терраса", ac: "Кондиционер", gr: "Гараж",
          n2: "Без двух уровней", na: "Без мансарды" },
    theme_t: "Светлая / тёмная тема",
  },
  pl: {
    page_title: "Warsaw Flats — mój profil",
    pf_header: "Mój profil", pf_h1: "Mój profil",
    pf_open: "Otwórz na liście", pf_edit: "Zmień", pf_want: "Ważne dla mnie",
    pf_fav_in: "W profilu: tak samo na wszystkich urządzeniach i w bocie.",
    pf_local: "Tylko w tej przeglądarce.",
    pf_hidden_in: "Nie są pokazywane na liście ani w powiadomieniach bota.",
    pf_hidden_out: "Nie są pokazywane na liście.",
    pf_places_note: (n) => `Czas dojazdu komunikacją do nich widać przy każdym mieszkaniu. Według „${n}” — filtr czasu dojazdu.`,
    pf_places_none: "Nie ma jeszcze miejsc. Dodaj pracę, szkołę — przy każdym mieszkaniu pojawi się czas dojazdu.",
    pf_want_note: "Mieszkania z tym są wyżej na liście. Zmienia się nad listą.",
    pf_want_none: "Nic nie wybrano.",
    pf_search_t: "Moje wyszukiwanie", pf_search_tag: "na stronie i w bocie", pf_show: "Pokaż mieszkania",
    pf_notify_on: "Jedno wyszukiwanie na stronie i w Telegramie: według niego otwiera się lista i przychodzą powiadomienia o nowych mieszkaniach — w ciągu dnia mniej więcej co 2 godziny (08:00–22:00), tylko gdy jest coś nowego.",
    pf_notify_off: "Jedno wyszukiwanie na stronie i w Telegramie: według niego otwiera się lista. Powiadomienia są wyłączone — włącz: /subscribe w bocie albo «Zapisz wyszukiwanie» nad listą.",
    pf_diff: "Na stronie jest teraz inne wyszukiwanie:", pf_diff_tail: "Nie jest zapisane, bot o nim nie wie.",
    pf_diff_save: "Zapisz jako moje wyszukiwanie", pf_diff_open: "Otwórz je", pf_saving: "Zapisuję…",
    pf_save_err: "Nie udało się zapisać — spróbuj jeszcze raz.",
    pf_no_filters: "Brak filtrów — wszystkie mieszkania",
    pf_tg_note: "Profil jest powiązany z Twoim czatem z botem. Ulubione i ukryte łączą się z botem przy każdym otwarciu strony.",
    pf_logout: "Wyloguj na tym urządzeniu",
    pf_offline: "Zalogowano · serwer niedostępny",
    pf_offline_text: "Serwer profilu teraz nie odpowiada — logowanie jest zachowane, dane wczytają się, gdy wróci. Odśwież stronę za kilka minut.",
    pf_login_text: "Napisz do bota <b>/profile</b> — przyśle link do logowania. Po zalogowaniu ulubione, ukryte i miejsca będą takie same na wszystkich urządzeniach i w bocie, a tutaj pojawi się Twoje wyszukiwanie z bota.",
    pf_open_bot: "Otwórz bota",
    rooms: (r) => `${r} pok.`, area: (a) => `od ${a} m²`, price: (p) => `do ${p} tys. zł`,
    price_min: (p) => `od ${p} tys. zł`, area_max: (a) => `do ${a} m²`, year: (y) => `rok ${y}`,
    commute: (m) => `dojazd ≤ ${m} min`, axes: (n) => `oceny osi: ${n}`,
    all_d: "wszystkie dzielnice", districts: (n) => `dzielnic: ${n}`,
    mt: { primary: "rynek pierwotny", secondary: "rynek wtórny" },
    cs: { ready_to_use: "do zamieszkania", to_completion: "do wykończenia", to_renovation: "do remontu" },
    wa: { g: "Ogródek", l: "Winda", u: "Komórka", b: "Balkon", t: "Taras", ac: "Klimatyzacja", gr: "Garaż",
          n2: "Bez dwóch poziomów", na: "Bez poddasza" },
    theme_t: "Jasny / ciemny motyw",
  },
};

const state = { prof: null };
let tr = (k) => T.ru[k] ?? k;

function stored(key) {
  try { const v = JSON.parse(localStorage.getItem(key) || "[]"); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

/* «4–5+ комн. · от 60 м² · до 900 тыс. zł · все районы» из фильтров бота
 * (settings.json → filters[chat_id], те же ключи, что читает notifier.py). */
function searchSummary(f) {
  const bits = [];
  const rooms = asList(f.rooms).map(String).sort();
  if (rooms.length) {
    const lab = (r) => (r === "5" ? "5+" : r);
    const consecutive = rooms.every((r, i) => i === 0 || +r === +rooms[i - 1] + 1);
    bits.push(tr("rooms")(rooms.length > 1 && consecutive
      ? `${lab(rooms[0])}–${lab(rooms[rooms.length - 1])}` : rooms.map(lab).join(", ")));
  }
  if (f.area_min) bits.push(tr("area")(f.area_min));
  if (f.area_max != null) bits.push(tr("area_max")(f.area_max));
  const k = (v) => Math.round(v / 1000).toLocaleString("ru-RU");
  if (f.price_min != null) bits.push(tr("price_min")(k(f.price_min)));
  if (f.price_max) bits.push(tr("price")(k(f.price_max)));
  if (f.year_min != null || f.year_max != null) bits.push(tr("year")(
    f.year_min != null && f.year_max != null ? `${f.year_min}–${f.year_max}` : f.year_min != null ? `≥ ${f.year_min}` : `≤ ${f.year_max}`));
  if (f.commute_max != null) bits.push(tr("commute")(f.commute_max));
  const nAx = Object.keys(f.axes_min || {}).length;
  if (nAx) bits.push(tr("axes")(nAx));
  asList(f.market_type).forEach((v) => bits.push(tr("mt")[v] ?? v));
  asList(f.construction_status).forEach((v) => bits.push(tr("cs")[v] ?? v));
  const d = asList(f.district);
  bits.push(!d.length ? tr("all_d") : d.length <= 2 ? d.join(", ") : tr("districts")(d.length));
  return Object.keys(f).some((key) => key !== "addr") ? bits.join(" · ") : tr("pf_no_filters");
}

/* Поиск сайта (параметры адреса app.html) → поля бота — зеркало
 * bot_filters.from_query, только для подписи и сравнения (без проверок). */
const Q_NUM = { price_min: ["price_min", 1000], price: ["price_max", 1000], area: ["area_min", 1],
  area_max: ["area_max", 1], score: ["score", 1], score_max: ["score_max", 1], year: ["year_min", 1],
  year_max: ["year_max", 1], commute: ["commute_max", 1] };
const Q_SET = { rooms: "rooms", district: "district", mt: "market_type", ut: "user_type", cs: "construction_status" };
function queryToFilters(q) {
  const f = {};
  Object.entries(Q_NUM).forEach(([k, [field, mult]]) => { if (q[k] != null && q[k] !== "") f[field] = +q[k] * mult; });
  Object.entries(Q_SET).forEach(([k, field]) => {
    const v = String(q[k] || "").split(",").filter(Boolean);
    if (v.length) f[field] = v;
  });
  const ax = {};
  Object.keys(q).filter((k) => /^ax\d+$/.test(k)).forEach((k) => { ax[k.slice(2)] = +q[k]; });
  if (Object.keys(ax).length) f.axes_min = ax;
  return f;
}

/* Сравнимый вид поиска — как app.js::normQuery (списки отсортированы, числа числами) */
const LIST_KEYS = new Set(Object.keys(Q_SET));
function normQuery(q) {
  const out = {};
  Object.entries(q || {}).forEach(([k, v]) => {
    if (v == null || v === "" || !(k in Q_NUM || LIST_KEYS.has(k) || /^ax\d+$/.test(k))) return;
    out[k] = LIST_KEYS.has(k) ? String(v).split(",").filter(Boolean).sort().join(",") : +v;
  });
  return JSON.stringify(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/* Поиск, открытый на сайте в этом браузере (app.js пишет его в wf_last_q);
 * null — сайт здесь ещё не открывали. */
function siteQuery() {
  let raw = null;
  try { raw = localStorage.getItem("wf_last_q"); } catch {}
  return raw == null ? null : Object.fromEntries(new URLSearchParams(raw));
}

/* Та же ссылка, что шлёт бот: параметры сайта сервер собрал из фильтров бота
 * (bot_filters.to_query) — сайт откроется уже с этим поиском. */
function searchUrl(query) {
  const q = new URLSearchParams(query || {}).toString();
  return "app.html" + (q ? `?${q}` : "");
}

function render() {
  const prof = state.prof;
  const logged = !!prof;
  const status = document.getElementById("pf-status");
  // токен есть, а сервер не ответил — не «без входа» (аудит 21.10)
  status.textContent = tr(logged ? "profile_in" : state.offline ? "pf_offline" : "profile_device");

  // только квартиры, которые сейчас в продаже (снятые список всё равно не покажет)
  liveCount("wf_fav").then((n) => { document.getElementById("pf-fav").textContent = String(n); });
  liveCount("wf_hidden").then((n) => { document.getElementById("pf-hidden").textContent = String(n); });
  document.getElementById("pf-fav-note").textContent = tr(logged ? "pf_fav_in" : "pf_local");
  document.getElementById("pf-hidden-note").textContent = tr(logged ? "pf_hidden_in" : "pf_hidden_out");

  const places = (logged && Array.isArray(prof.prefs.places) ? prof.prefs.places : stored("wf_places")).slice(0, 3);
  const host = document.getElementById("pf-places");
  host.textContent = "";
  places.forEach((pl) => {
    const row = document.createElement("span");
    const b = document.createElement("b");
    b.textContent = pl.name || "";
    row.append(b, pl.q ? ` · ${pl.q}` : "");
    host.appendChild(row);
  });
  host.hidden = !places.length;
  document.getElementById("pf-places-note").textContent =
    places.length ? tr("pf_places_note")(places[0].name || "") : tr("pf_places_none");

  const want = stored("wf_want").filter((c) => c in T.ru.wa);
  const wantHost = document.getElementById("pf-want");
  wantHost.textContent = "";
  want.forEach((c, i) => {
    const tag = document.createElement("span");
    tag.className = "ds-tag ds-tag--yes";
    tag.textContent = `${i + 1}. ${tr("wa")[c]}`;
    wantHost.appendChild(tag);
  });
  if (!want.length) {
    const none = document.createElement("span");
    none.className = "ds-note";
    none.textContent = tr("pf_want_none");
    wantHost.appendChild(none);
  }

  document.getElementById("pf-search-box").hidden = !logged;
  document.getElementById("pf-tg").hidden = !logged;
  document.getElementById("pf-login").hidden = logged;
  document.getElementById("pf-login-text").innerHTML = tr(state.offline ? "pf_offline_text" : "pf_login_text");   // свой текст словаря
  if (logged) {
    const f = prof.bot.filters || {};
    document.getElementById("pf-search").textContent = searchSummary(f);
    document.getElementById("pf-notify").textContent = tr(prof.bot.subscribed ? "pf_notify_on" : "pf_notify_off");
    document.getElementById("pf-search-open").href = searchUrl(prof.bot.query);
    // На сайте открыт другой поиск — предложить сделать его своим
    const site = siteQuery();
    const diff = site != null && normQuery(site) !== normQuery(prof.bot.query || {});
    document.getElementById("pf-diff").hidden = !diff;
    document.getElementById("pf-search-open").classList.toggle("ds-btn--primary", !diff);
    if (diff) {
      const text = document.getElementById("pf-diff-text");
      const b = document.createElement("b");
      b.textContent = searchSummary(queryToFilters(site));
      text.replaceChildren(`${tr("pf_diff")} `, b, `. ${tr("pf_diff_tail")}`);
      document.getElementById("pf-diff-open").href = searchUrl(site);
    }
  }
}

/* «Сохранить как мой поиск» — то же, что «Сохранить поиск» над списком
 * (POST /profile/search): поиск сайта становится поиском бота. */
async function saveSiteSearch() {
  const btn = document.getElementById("pf-diff-save"), err = document.getElementById("pf-diff-err");
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = tr("pf_saving"); err.hidden = true;
  try {
    const r = await fetch(`${API_BASE}/profile/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Profile-Token": profileToken() },
      body: JSON.stringify({ query: siteQuery() || {} }),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error(data.error || "");
    const addr = state.prof.bot.filters?.addr;
    state.prof.bot = { ...state.prof.bot, query: data.query, subscribed: true,
                       filters: { ...queryToFilters(data.query), ...(addr ? { addr } : {}) } };
    render();
  } catch (e) {
    err.textContent = srvMsg(e.message, tr("pf_save_err"));
    err.hidden = false;
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}

initTheme();
initProfile();
const langApi = initLang(T, (_lang, t) => { tr = t; render(); });
tr = langApi.tr;
render();

document.getElementById("pf-diff-save").onclick = saveSiteSearch;

document.getElementById("pf-logout").onclick = () => {
  forgetProfileToken();
  location.reload();
};

if (profileToken()) {
  syncProfile().then((prof) => {
    state.prof = prof;
    state.offline = !prof && !!profileToken();   // 401 токен уже стёр — тогда это не «нет связи»
    render();
  });
}
