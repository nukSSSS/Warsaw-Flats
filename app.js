/* Warsaw Flats — прототип интерфейса.
 *
 * Данные приходят готовыми из 5.web/export.py (apartments.json + meta.json).
 * Питон здесь ничего не рисует: вся вёрстка живёт в html/css/js, поэтому правка
 * интерфейса не требует трогать пайплайн — ради этого модуль и заводился.
 *
 * Разделение обязанностей:
 *   state   — что выбрано пользователем
 *   apply() — единственное место, где считается «что показывать»
 *   render* — только рисуют, ничего не решают
 */

import { API_BASE } from "./api-base.js?v=202610241540";
import { profileToken, syncProfile, pushLists, trackEvent, rateHelpBtn } from "./site-ui.js?v=202610241540";

// #places / #want — переход из «Мой профиль» («Изменить»). Запомнить до того,
// как apply() перепишет адрес фильтрами (replaceState без хэша).
const START_HASH = location.hash;
/* ?card=<id> — открыть карточку квартиры сразу (18.10.2026: ссылка из бота на снятую
 * квартиру из «Избранного» — на Otodom объявления уже нет, у нас карточка осталась).
 * Запоминаем до первого syncUrl(), который перепишет адрес. */
const START_CARD = new URLSearchParams(location.search).get("card");

const $ = (s) => document.querySelector(s);

const state = {
  all: [], meta: null, shown: [],
  layers: {}, collapsed: false, axes: [],
  cmpId: null,          // первая отложенная квартира; вторая берётся из карточки
  rooms: new Set(), market: new Set(), districts: new Set(),
  seller: new Set(), cond: new Set(),
  sort: "p", activeId: null,
  base: [],             // выдача после всех фильтров, КРОМЕ «рядом с остановкой»
  near: null,           // {p:[lat,lon], r, name} — фильтр «квартиры рядом с остановкой»
  want: [],             // «Важно для меня»: коды удобств (AMEN) по важности — порядок, не фильтр
  places: [],           // «Мои места»: [{name, q, lat, lon}], первое — для фильтра «≤ N мин»
  placeTimes: [],       // [{otodom_id: минуты}] — по месту на элемент places
  placeWalk: [],        // [{otodom_id: мин}] — пешком до первой остановки у квартиры
  placeAlt: [],         // [{otodom_id: мин}] — автобусом, если быстрее основного пути на 10+ мин
  walkMax: (() => { try { const v = +localStorage.getItem("wf_walk_max"); return [10, 15, 20].includes(v) ? v : 15; } catch { return 15; } })(),
  placeModes: [],       // [{otodom_id: "mb"}] — каким транспортом это время (m метро, t трамвай, r поезд, b автобус; "" пешком)
  profilePrefs: null,   // профиль с сервера (вход по ссылке из бота) — места пишутся туда
  activeArch: false,    // открыта карточка СНЯТОЙ квартиры (её нет в state.shown — apply() её не закрывает)
  favArchOpen: false,   // раскрыта ли строка «Сняты с продажи — N из избранного»
  visited: {},          // «Посещённая»: {ключ квартиры: {v, at}} — localStorage wf_visited, при входе и профиль
  remoteNotes: {},      // заметки, как их последний раз прислал сервер, — для «сохранено в профиле»
  notes: {},            // «Моя заметка»: {ключ квартиры: {t, at}} — localStorage wf_notes, при входе и профиль
  bot: null,            // что знает бот (вход по ссылке): {query, subscribed, …} — кнопка «Уведомлять»
  hidden: new Set(),    // мой чёрный список: ключи групп/квартир (hideKey), хранится в localStorage
  showHidden: false,    // true — в списке ТОЛЬКО скрытые (посмотреть и вернуть)
  favorites: new Set(), // избранное: ключи групп/квартир (favKey), независимо от чёрного списка
  onlyFav: false,        // true — в списке ТОЛЬКО избранное (доп. фильтр, не режим просмотра)
};

let map;   // maplibregl.Map (см. «Карта»)
/* id квартиры, чья карточка открыла шторку — восстанавливаем фокус по НЕМУ,
 * а не по ссылке на DOM-узел: paintWindow() пересобирает карточки списка
 * через innerHTML при каждом select()/apply(), и любая захваченная ссылка на
 * узел становится отсоединённой раньше, чем шторку успевают закрыть. */
let sheetOpenerId = null;

/* Простой дебаунс: числовые фильтры дёргают apply() на каждый символ —
 * без задержки одна цифра гоняет полную фильтрацию+сортировку+перерисовку
 * списка+пересоздание маркеров+history.replaceState (см. аудит: Safari бросает
 * SecurityError при частых replaceState). */
function debounce(fn, ms = 200) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
const debouncedApply = debounce(() => apply(), 200);

// Бэкенд 6.valuate/api.py (/commute, /geocode, /profile) — адрес в api-base.js:
// localhost в исходниках, живой адрес Cloudflare Quick Tunnel в опубликованной
// копии. Секция видна всем посетителям сайта (защищено суточным лимитом на
// /commute, см. api.py::_check_and_increment_commute_budget).
const COMMUTE_API = API_BASE;

// ── Форматирование ──────────────────────────────────────────────────────────
const nf = new Intl.NumberFormat("ru-RU");
const money = (v) => (v == null ? "—" : nf.format(Math.round(v)) + " PLN");
const num = (v, unit = "") => (v == null ? "—" : nf.format(Math.round(v)) + unit);
// Бэкенд отдаёт даты как "YYYY-MM-DD" (isoformat().date()) — везде в интерфейсе
// нужен привычный дд.мм.гггг (аудит юзера 2026-09-23), не ISO-формат
const fmtDate = (iso) => {
  if (!iso) return null;
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}.${y}` : iso;
};
// Разница в днях между двумя "YYYY-MM-DD" — сколько суммарно квартира была
// в продаже (от first_seen_at до снятия), не по прямой разнице строк
const daysBetween = (isoFrom, isoTo) => {
  if (!isoFrom || !isoTo) return null;
  const a = new Date(isoFrom), b = new Date(isoTo);
  return Math.round((b - a) / 86400000);
};
// Снятые с продажи: "на рынке с <дата добавления> → снято <дата>" + суммарно
// дней. r.on (first_seen_at) есть у всех архивных записей начиная с этого
// добавления в экспорт (аудит юзера 2026-09-23) — на всякий случай не падаем,
// если когда-нибудь попадётся запись без него, просто без диапазона.
function removedPeriod(r) {
  const off = fmtDate(r.off);
  if (!r.on) return off ? `${tr("roff")} ${off}` : "—";
  const on = fmtDate(r.on);
  const days = daysBetween(r.on, r.off);
  return `${tr("f_since")} ${on} → ${tr("roff")} ${off}${days != null ? ` · ${days} ${tr("days_u")}` : ""}`;
}

/* Формы числа: 1 / 2–4 / 5+ (русский: 21 — как 1; польский: 1 — только сама единица) */
function ruP(n, one, few, many) {
  return n % 10 === 1 && n % 100 !== 11 ? one
    : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many;
}
function plP(n, one, few, many) {
  return n === 1 ? one : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? few : many;
}

/* ── Переводы ────────────────────────────────────────────────────────────────
 * Строки ИНТЕРФЕЙСА живут здесь: больше их нигде в проекте нет.
 * Подписи осей и GIS-слоёв сюда НЕ дублируются — они приходят в meta.i18n из
 * словаря бота и из карты, иначе три копии разъехались бы при первой правке.
 * Ключи короткие: их читает только этот файл и data-i18n в разметке. */
const T = {
  ru: {
    sort: "Сортировка", s_p: "цена ↑", s_pd: "цена ↓", s_sc: "рейтинг ↓",
    work_s: "до работы", menu_profile: "Мой профиль", menu_privacy: "Конфиденциальность",
    amen: { lift: "лифт", garden: "сад", usable_room: "кладовка", balcony: "балкон",
            terrace: "терраса", air_conditioning: "кондиционер", basement: "подвал",
            garage: "гараж", separate_kitchen: "отдельная кухня", two_storey: "двухуровневая" },
    s_ppm: "цена за м² ↑", s_a: "площадь ↓", s_new: "новизна",
    theme_t: "Светлая / тёмная тема", reset: "Сброс", from: "от", to: "до",
    collapse_t: "Свернуть список", expand_t: "Развернуть список",
    f_axes: "Минимум по осям рейтинга",
    flt: "Фильтры", flt_done: "Готово",
    flt_more: "Ещё фильтры", reset_all: "Сбросить всё", reset_panel: "Сбросить",
    flt_show: (n) => `Показать ${n} ${ruP(n, "квартиру", "квартиры", "квартир")}`,
    fg_quick: "Быстрые", fg_apt: "Квартира", fg_rating: "Рейтинг места",
    fg_seller: "Рынок и продавец", fg_loc: "Локация", fg_cond: "Состояние",
    fg_map: "С карты",
    fg_map_note: "Фильтр «рядом с остановкой» включается кликом по остановке на карте и показывается чипом над списком.",
    f_price_from: "Цена от, тыс.", f_area_from: "Площадь от, м²", f_year_from: "Год постройки от",
    f_work: "Работа", work_off: "Выключить", done: "Готово", close: "Закрыть", any: "любая",
    want_t: "Важно для меня", want_none: "не выбрано",
    my_places: "Мои места", fg_work: "Время в пути", transit: "общ. транспорт",
    split_t: "Потяните, чтобы изменить ширину списка",
    mode_w: { m: "метро", t: "трамвай", r: "электричка", b: "автобус", "": "пешком" },
    own_rata: "кредит",
    own_heat_ask: (h) => `отопление ${h ? h + " " : ""}— не в czynszu, расходы уточнить у продавца`,
    ht: { gas: "газовое", electrical: "электрическое", other: "своё", tiled_stove: "печное" },
    own_nocz: "без czynszu", own_desc: "czynsz — из описания объявления",
    own_excl: "свет и интернет не входят",
    own_excl_none: "вода, свет и интернет не входят — по счётчикам",
    own_cz_ask: "czynsz не указан в объявлении — уточнить на просмотре", own_from: "от",
    report_btn: "Отчёт", share_btn: "Поделиться", share_title: "Квартиры в Варшаве — мой поиск",
    share_copied: "Ссылка скопирована", share_copy: "Скопируйте ссылку:",
    share_gone: "Ссылка не открылась — показан обычный поиск",
    walk_to_stop: (w) => `до остановки ${w} мин пешком`, alt_bus: (m) => `автобусом ${m} мин`,
    walk_max_t: "Пешком до остановки", walk_max_v: (n) => `до ${n} мин`,
    walk_max_note: "Остановки дальше у квартиры не учитываются. Автобус — только если без него не доехать или он быстрее на 10+ мин.",
    places_intro: "Время на общественном транспорте до этих мест видно у каждой квартиры. По первому месту работает фильтр «≤ N мин».",
    places_where: "До 3 мест. Хранятся в этом браузере, а если открыть сайт по ссылке из бота (/profile) — в профиле, одинаково на всех устройствах.",
    place_add_t: "Добавить место", place_name: "Название", place_name_ph: "Работа, школа…",
    place_addr: "Адрес в Варшаве", place_addr_ph: "улица и номер дома", place_add: "Добавить",
    place_default: "Место", place_filter: "фильтр", place_make_first: "Для фильтра",
    place_remove: "Удалить место", places_none: "Мест пока нет — добавьте в «Мои места».",
    place_busy: "Ищу адрес…", place_times_busy: "Считаю время в пути…", place_max: "Можно до 3 мест.",
    place_need_addr: "Введите адрес.", place_err: "Сервер мест недоступен — попробуйте позже.",
    want_off: "Отметьте, что важно, — квартиры, где это есть, поднимутся выше.",
    want_on: "Квартиры, где есть отмеченное, — выше. Первое отмеченное важнее следующих.",
    wa: { g: "Сад", l: "Лифт", u: "Кладовка", b: "Балкон", t: "Терраса", ac: "Кондиционер", gr: "Гараж",
          n2: "Без двух уровней", na: "Без мансарды", vi: "Посещённая", nt: "Есть заметка" },
    wa_no: { n2: "Два уровня", na: "Мансарда" },   // подпись ✗ у «без …»-чипов
    commute_w: "Дорога", k_u: "тыс",
    chip_remove: (label) => `Убрать фильтр «${label}»`,
    brand_home_a: "Warsaw Flats — на главную",
    profile_a: "Профиль: избранное, скрытые, мои места",
    profile_device: "Это устройство · без входа", profile_in: "Вошли через Telegram",
    menu_fav: "Избранное", menu_hidden: "Скрытые", menu_places: "Мои места",
    menu_login: "Войти через Telegram",
    tab_list: "Список", tab_map: "Карта",
    // Формулировка обязана быть про перцентиль, а не про «баллы»: 70 значит
    // «лучше 70% квартир СЕГОДНЯШНЕЙ выдачи», и завтра порог отсечёт другое
    axes_hint: "Показывать квартиры, которые по оси лучше указанного % остальных",
    axes_ph: "лучше %",
    fresh: "Данные устарели", fresh_btn: "Обновить",
    cmp_pick: "Сравнить", cmp_with: "Сравнить с уже выбранной",
    cmp_drop: "Отменить сравнение", cmp_title: "Сравнение",
    cmp_back: "Закрыть сравнение",
    f_price: "Цена, тыс.", f_area: "Площадь, м²", f_score: "Рейтинг",
    f_commute: "Не дольше, мин", f_year: "Год", f_rooms: "Комнаты",
    f_commute_setup: "Адрес работы", commute_calc: "Посчитать",
    commute_calc_busy: "Считаю…", commute_ok: (n) => `Готово: посчитано для ${n} ${ruP(n, "квартиры", "квартир", "квартир")}`,
    commute_err_addr: "Введите адрес", commute_err_backend: "Локальный сервер недоступен (нужен 6.valuate/api.py)",
    commute_addr_ph: "например, Prosta 67",
    f_district: "Район", f_market: "Рынок", f_seller: "Продавец", f_cond: "Состояние",
    list_a: "Список квартир", close_a: "Закрыть",
    ut: { private: "Собственник", developer: "Застройщик", agency: "Агентство" },
    mt: { primary: "Первичка", secondary: "Вторичка" },
    cs: { ready_to_use: "Под ключ", to_completion: "Под отделку", to_renovation: "Под ремонт" },
    rooms_s: "комн.", min: "мин", days_u: "дн",
    rating: "рейтинг", cheaper: "дешевле похожих объявлений", pricier: "дороже похожих объявлений",
    cheaper_deals: "дешевле сделок рядом", pricier_deals: "дороже сделок рядом",
    deals_n: (n) => `по ${n} реальным сделкам рядом (нотариальные акты), свежие весомее`,
    f_ppm: "Цена за м²", f_area2: "Площадь", f_rooms2: "Комнаты", f_floor: "Этаж",
    f_of: "из", f_year2: "Год", f_seller2: "Продавец", f_market2: "Рынок",
    f_cond2: "Состояние", f_metro: "Метро пешком", f_noise: "Шум",
    f_school: "Школа E8", f_own: "Владение", f_since: "На рынке с", f_heat: "Отопление",
    f_comm: "Комиссия", f_park: { garage: "Место в гараже", surface: "Место на парковке", mixed: "Место на парковке", any: "Парковочное место" }, park_from: "от", park_sep: "отдельно", park_incl: "в цене квартиры", c_none: "нет",
    comm_s: { est: "не указана, уточнить", yes: "процент не указан, уточнить", pct: "указана в объявлении",
              none: "указано в объявлении", private: "продаёт хозяин", developer: "напрямую от застройщика" },
    ht_full: { urban: "Городское", boiler_room: "Котельная", gas: "Газовое", electrical: "Электрическое", other: "Другое", tiled_stove: "Печное" },
    f_commute2: "Дорога до дома", noise_lt: "до 45 дБ", db: "дБ", mo: "zł/мес",
    otodom: "Открыть объявление", street: "Street View", devall: "Все квартиры ЖК",
    noaddr: "Без адреса", blur: (m) => `пин размыт продавцом (±${m} м) — адрес и рейтинг приблизительны`,
    gaps: (n) => `не указано параметров: ${n}`,
    dist: "Что рядом", pos: "Плюсы", neg: "Минусы", dwait: "расстояния загружаются…",
    dsort_dist: "расстояние", dsort_weight: "важность", dsort_label: "сортировка «Что рядом»",
    rem: "Ранее на продаже", rem_same: "Прежние объявления этой квартиры", rem_other: "Другие квартиры в этом доме",
    rem_other_hint: "Снятые объявления соседних квартир по этому адресу — чтобы сравнить цены.", roff: "снято", arch: "Архив объявления",
    l_apts: "Квартиры", l_rem: "Снятые с продажи",
    l_iso: "Доступность", l_gios: "Качество воздуха PM2.5 (GIOŚ)",
    l_airly: "Качество воздуха PM2.5 (Airly)",
    ns_air: "самолёты", ns_rail: "ж/д", ns_tram: "трамвай", ns_industry: "промышленность", ns_road: "дороги",
    l_tram: "Трамвай: линии и остановки", l_metro: "Метро: линии и станции",
    l_metro_construction: "🚧 Метро: строится", l_rail: "Электрички: SKM, KM, WKD",
    layers_t: "Слои карты", map_err: "Карта не загрузилась — проверьте интернет и обновите страницу. Список квартир работает.", g_offers: "Предложения", g_transit: "Транспорт", g_noise: "Шум",
    g_air: "Воздух PM2.5", g_iso: "Изохроны",
    noise_src: "Источник", noise_off: "выключен", noise_leg: "Шум, дБ", per_day: "Сутки", per_night: "Ночь",
    nz_road: "Дороги", nz_rail: "Железная дорога", nz_air: "Самолёты", nz_tram: "Трамвай", nz_industry: "Промышленность",
    stop_near: "Квартир в радиусе", near_on: "Показать квартиры рядом", near_off: "Показать все квартиры",
    lines_title: "Линии", lines_hint: "нажми на номер или линию — выделить", lines_clear: "сбросить",
    tram_w: "Трамвай", metro_w: "Метро", station_w: "станция",
    metro_construction_w: "Метро (строится)", rail_w: "Электричка",
    stop_tram: "Остановка трамвая", stop_metro: "Станция метро",
    stop_metro_construction: "Станция метро (строится)",
    l_metro_planned: "Метро: планируется · M3, M4", metro_planned_w: "Метро (планируется)",
    metro_planned_note: "Линия в планах города — по данным OpenStreetMap; сроков строительства в данных нет. Не учитывается в рейтинге пешей доступности.",
    metro_construction_note: "Станция строится, дата открытия не объявлена. Не учитывается в рейтинге пешей доступности.",
    hide: "Скрыть", unhide: "Вернуть", hide_t: "Скрыть эту квартиру (и её повторы) из моей выдачи",
    unhide_t: "Вернуть в выдачу", hid_toast: "Скрыто из поиска", unhid_toast: "Возвращено в поиск", undo: "Отменить",
    fav: "В избранное", unfav: "Убрать из избранного",
    fav_t: "Добавить эту квартиру (и её повторы) в избранное",
    unfav_t: "Убрать из избранного", fav_toast: "Добавлено в избранное", unfav_toast: "Убрано из избранного",
    f_checked: "Проверено", today: "сегодня", yesterday: "вчера", ago_d: (n) => `${n} дн назад`,
    stale_hint: "давно не проверялось — возможно, уже снято",
    dup_note: (n) => `+${n} ${ruP(n, "дубль", "дубля", "дублей")}`, dup_note_series: (n) => `+${n} той же планировки`, dups_t: (n) => `Дубли этой квартиры (${n})`,
    dups_series: (n) => `Ещё ${n} ${n % 10 === 1 && n % 100 !== 11 ? "квартира" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "квартиры" : "квартир"} этой планировки`,
    dup_series_hint: "Соседние квартиры той же планировки в этом доме — разные, но почти одинаковые: другой этаж, подъезд или корпус. В списке показана одна, здесь — все.",
    fl_short: "эт.",
    dup_hint: "Та же квартира в других объявлениях: совпали адрес, площадь, этаж и цена (±4%) или одни и те же фото. В списке скрыты, здесь — все ссылки.",
    legend: "PM2.5, µg/м³", err: "Не удалось загрузить данные.",
    m2: "м²", km: "км", m_u: "м", yr: "г.", ppm_u: "zł/м²", metro_s: "метро",
    shown_of: (n, all) => `${n} из ${all}`,
    cnt_hidden: (n) => `🚫 ${n}`, cnt_hidden_s: (n) => `🚫 ${n}`, cnt_hidden_t: "Показать скрытые квартиры — их можно вернуть",
    cnt_back: "← ко всем", cnt_back_t: "Скрыть их снова и показать остальные",
    cnt_fav: (n) => `⭐ ${n}`, cnt_fav_s: (n) => `⭐ ${n}`, cnt_fav_t: "Показать избранное — все, без фильтров поиска",
    cnt_fav_back_t: "Вернуться к результатам поиска",
    empty_h: "Ничего не найдено — ослабь фильтры",
    gap_card: (n) => `в объявлении не хватает ${n} парам. — балл менее точен`,
    rem_tip: (n) => `Снято с продажи: ${n}`, rem_more: (n) => `+ ещё ${n}`,
    // «Торг»: аргументы из уже известного (04.10.2026)
    sum_t: "Сводка", sum_sub: "торг · заметка · цены · оценки", facts_t: "Параметры",
    dist_sub0: "транспорт, школы, магазины, парки и что мешает",
    dist_sub: (p, n) => `плюсы: ${p}${n ? ` · минусы: ${n}` : ""}`,
    ax_box: "Рейтинг", ax_sum: (b, bv, w, wv) => `↑ ${b} ${bv} · ↓ ${w} ${wv}`, trade_t: "Торг", trade_days: (n) => `в продаже ${n} ${ruP(n, "день", "дня", "дней")}`,
    trade_drops: (n, d, p) => `снижали ${n} ${ruP(n, "раз", "раза", "раз")}: итого −${d} PLN (−${p}%)`,
    trade_gap: (p) => `на ${p}% дороже сделок рядом`, trade_cheap: (p) => `на ${p}% дешевле сделок рядом`,
    trade_strong: "есть куда торговаться", trade_some: "можно попробовать поторговаться", trade_none: "торг вряд ли нужен",
    // «Объявление» — факты об истории объявления (14.10.2026)
    trade_times: (n) => `выставляют ${n}-й раз`, trade_copies: (n, s) => `сейчас ${n} ${ruP(n, "объявление", "объявления", "объявлений")}${s ? ` (${s})` : ""}`,
    trade_raised: (s) => `цену поднимали: ${s}`,
    // заметка к квартире и история цены (04.10.2026)
    note_t: "Моя заметка", note_add: "+ Добавить заметку", note_ph: "Например: звонил, торг до…, соседи…",
    note_hint: "Видно только вам · сохраняется в профиле, видна в боте",
    visit_l: "Просмотр", visit_t: "Отметить, что квартира посещена — синхронизируется между устройствами через профиль",
    note_save: "Сохранить", note_retry: "Повторить", note_saving: "Сохраняю…",
    note_dirty: "Не сохранено", note_err: "Нет связи — не сохранилось. Текст не потерян",
    note_ok: (t) => `✓ Сохранено в профиле · ${t}`, note_ok_local: (t) => `✓ Сохранено в этом браузере · ${t}`,
    note_not_sent: "Сохранено только здесь — в профиль ещё не ушло", note_hint_local: "Видно только вам · хранится в этом браузере",
    hist_t: "История цены", hist_since: (d) => `с ${d}`,
    hist_sum: (n, d) => `${d} · менялась ${n} ${n % 10 === 1 && n % 100 !== 11 ? "раз" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "раза" : "раз"}`,
    hist_today: "сегодня", k_short: "тыс",
    rcn_sum: (m, gap) => `${m}${gap ? ` · ${gap}` : ""}`,
    // цены реальных сделок рядом (RCN Варшавы, data/rcn.json)
    rcn_t: "Цены сделок рядом", rcn_src: "нотариальные акты · RCN Варшавы",
    rcn_med: (n, r, mk) => `медиана ${n} ${n % 10 === 1 && n % 100 !== 11 ? "продажи" : "продаж"} за год в ${r} м · ${mk}`,
    rcn_this: "Эта квартира", rcn_more: (p) => `на ${p}% дороже сделок`, rcn_less: (p) => `на ${p}% дешевле сделок`,
    rcn_similar: (n, r) => `медиана ${n} ${n % 10 === 1 && n % 100 !== 11 ? "сделки" : "сделок"} по похожим квартирам рядом${r ? ` (${r} комн., похожая площадь)` : ""} · свежие весомее`,
    rcn_all: (m, n, r) => `Все сделки в ${r} м за год: ${m} zł/м² (${n})`,
    rcn_same: "как сделки рядом",
    rcn_house: (n, m) => `В этом доме: ${n} ${n % 10 === 1 && n % 100 !== 11 ? "продажа" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "продажи" : "продаж"}, медиана ${m} zł/м²`,
    rcn_list: (n) => `Ближайшие сделки (${n})`, rcn_cols: ["Дата", "Площадь", "Комн.", "Эт.", "zł/м²", "Рядом"],
    rcn_years: "В этом доме по годам", rcn_years_note: "медиана zł/м² всех сделок в доме, оба рынка · справа — число сделок",
    rcn_growth: (y, p) => `с ${y}: ${p > 0 ? "+" : "−"}${Math.abs(p)}%`,
    // снятая с продажи квартира — та же карточка с пометкой
    arch_tag: (d) => `Снято с продажи ${d}`, arch_tag_s: (d) => `Снято ${d}`, arch_last: "Последняя цена",
    arch_note: "Объявление снято с продажи. У квартир, снятых до 1 октября 2026, фото, оценки по осям и «Что рядом» не сохранились — только то, что ниже.",
    arch_period: "В продаже", arch_otodom: "Объявление на Otodom (может быть удалено)", arch_open: "Карточка",
    arch_fav: (n) => `Сняты с продажи — ${n} из избранного`, arch_here: "Снятые по этому адресу",
    // «Сохранить поиск» (13.10.2026, было «Уведомлять») — поиск сайта = поиск бота, один
    ntf_btn: "Сохранить поиск", ntf_on: "Поиск сохранён",
    ntf_t: "Сохранить поиск", ntf_on_t: "Поиск сохранён",
    ntf_lead: "Этот поиск станет вашим — на сайте и в боте. Бот будет присылать по нему новые квартиры:",
    ntf_lead_out: "Сохранённый поиск — один на сайте и в боте: по нему бот присылает новые квартиры в Telegram днём примерно каждые 2 часа. Нужен вход — один раз, через бота.",
    ntf_lead_on: "Это ваш поиск — на сайте и в боте. Бот присылает по нему новые квартиры днём примерно каждые 2 часа:",
    ntf_now: "Сейчас сохранён:", ntf_when: "Приходят днём примерно каждые 2 часа (08:00–22:00), только когда есть новое.",
    ntf_off_note: "Сейчас уведомления выключены — сохранение их включит.",
    ntf_on_note: "Поменяйте фильтры — кнопка снова станет «Сохранить поиск», и новый поиск заменит этот.",
    ntf_login_note: "Напишите боту /profile — он пришлёт ссылку для входа. Потом вернитесь и нажмите «Сохранить поиск».",
    ntf_cancel: "Отмена", ntf_save: "Сохранить поиск", ntf_saving: "Сохраняю…", ntf_login: "Войти через Telegram",
    ntf_off: "Выключить уведомления", ntf_err: "Не удалось сохранить — попробуйте ещё раз.",
    ntf_all: "Все квартиры, без фильтров", ntf_price: "Цена", ntf_rooms: (v) => `Комнаты ${v}`,
    ntf_districts: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "район" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "района" : "районов"}`,
    err_h: "Запусти <code>venv/bin/python 5.web/export.py</code> и открой страницу через локальный сервер.",
    err_net: "Нет связи с сайтом", err_btn: "Повторить",
  },
  pl: {
    sort: "Sortowanie", s_p: "cena ↑", s_pd: "cena ↓", s_sc: "ocena ↓",
    work_s: "do pracy", menu_profile: "Mój profil", menu_privacy: "Prywatność",
    amen: { lift: "winda", garden: "ogródek", usable_room: "komórka", balcony: "balkon",
            terrace: "taras", air_conditioning: "klimatyzacja", basement: "piwnica",
            garage: "garaż", separate_kitchen: "oddzielna kuchnia", two_storey: "dwupoziomowe" },
    s_ppm: "cena za m² ↑", s_a: "powierzchnia ↓", s_new: "najnowsze",
    theme_t: "Jasny / ciemny motyw", reset: "Wyczyść", from: "od", to: "do",
    collapse_t: "Zwiń listę", expand_t: "Rozwiń listę",
    f_axes: "Minimum na osiach rankingu",
    flt: "Filtry", flt_done: "Gotowe",
    flt_more: "Więcej filtrów", reset_all: "Wyczyść wszystko", reset_panel: "Wyczyść",
    flt_show: (n) => `Pokaż ${n} ${plP(n, "mieszkanie", "mieszkania", "mieszkań")}`,
    fg_quick: "Szybkie", fg_apt: "Mieszkanie", fg_rating: "Ocena miejsca",
    fg_seller: "Rynek i sprzedający", fg_loc: "Lokalizacja", fg_cond: "Stan",
    fg_map: "Z mapy",
    fg_map_note: "Filtr „w pobliżu przystanku” włącza się kliknięciem w przystanek na mapie i widać go jako znacznik nad listą.",
    f_price_from: "Cena od, tys.", f_area_from: "Powierzchnia od, m²", f_year_from: "Rok budowy od",
    f_work: "Praca", work_off: "Wyłącz", done: "Gotowe", close: "Zamknij", any: "dowolna",
    want_t: "Ważne dla mnie", want_none: "nic nie wybrano",
    my_places: "Moje miejsca", fg_work: "Czas dojazdu", transit: "kom. miejska",
    split_t: "Przeciągnij, aby zmienić szerokość listy",
    mode_w: { m: "metro", t: "tramwaj", r: "pociąg", b: "autobus", "": "pieszo" },
    own_rata: "kredyt",
    own_heat_ask: (h) => `ogrzewanie ${h ? h + " " : ""}— poza czynszem, koszty ustalić ze sprzedającym`,
    ht: { gas: "gazowe", electrical: "elektryczne", other: "własne", tiled_stove: "piecowe" },
    own_nocz: "bez czynszu", own_desc: "czynsz — z opisu ogłoszenia",
    own_excl: "prąd i internet nie są wliczone",
    own_excl_none: "woda, prąd i internet nie są wliczone — wg liczników",
    own_cz_ask: "czynsz nie podany w ogłoszeniu — zapytać przy oglądaniu", own_from: "od",
    report_btn: "Raport", share_btn: "Udostępnij", share_title: "Mieszkania w Warszawie — moje wyszukiwanie",
    share_copied: "Link skopiowany", share_copy: "Skopiuj link:",
    share_gone: "Link się nie otworzył — pokazano zwykłe wyszukiwanie",
    walk_to_stop: (w) => `do przystanku ${w} min pieszo`, alt_bus: (m) => `autobusem ${m} min`,
    walk_max_t: "Pieszo do przystanku", walk_max_v: (n) => `do ${n} min`,
    walk_max_note: "Dalszych przystanków przy mieszkaniu nie bierzemy. Autobus — tylko gdy bez niego nie da się dojechać albo jest szybszy o 10+ min.",
    places_intro: "Czas dojazdu komunikacją miejską do tych miejsc widać przy każdym mieszkaniu. Filtr „≤ N min” działa według pierwszego miejsca.",
    places_where: "Do 3 miejsc. Zapisane w tej przeglądarce, a jeśli otworzysz stronę z linku z bota (/profile) — w profilu, tak samo na wszystkich urządzeniach.",
    place_add_t: "Dodaj miejsce", place_name: "Nazwa", place_name_ph: "Praca, szkoła…",
    place_addr: "Adres w Warszawie", place_addr_ph: "ulica i numer domu", place_add: "Dodaj",
    place_default: "Miejsce", place_filter: "filtr", place_make_first: "Do filtra",
    place_remove: "Usuń miejsce", places_none: "Nie ma jeszcze miejsc — dodaj w „Moje miejsca”.",
    place_busy: "Szukam adresu…", place_times_busy: "Liczę czas dojazdu…", place_max: "Można do 3 miejsc.",
    place_need_addr: "Wpisz adres.", place_err: "Serwer miejsc jest niedostępny — spróbuj później.",
    want_off: "Zaznacz, co jest ważne — mieszkania, które to mają, będą wyżej.",
    want_on: "Mieszkania z zaznaczonym są wyżej. Pierwsze zaznaczone jest ważniejsze od kolejnych.",
    wa: { g: "Ogródek", l: "Winda", u: "Komórka", b: "Balkon", t: "Taras", ac: "Klimatyzacja", gr: "Garaż",
          n2: "Bez dwóch poziomów", na: "Bez poddasza", vi: "Odwiedzone", nt: "Z notatką" },
    wa_no: { n2: "Dwa poziomy", na: "Poddasze" },
    commute_w: "Dojazd", k_u: "tys.",
    chip_remove: (label) => `Usuń filtr „${label}”`,
    brand_home_a: "Warsaw Flats — strona główna",
    profile_a: "Profil: ulubione, ukryte, moje miejsca",
    profile_device: "To urządzenie · bez logowania", profile_in: "Zalogowano przez Telegram",
    menu_fav: "Ulubione", menu_hidden: "Ukryte", menu_places: "Moje miejsca",
    menu_login: "Zaloguj przez Telegram",
    tab_list: "Lista", tab_map: "Mapa",
    axes_hint: "Pokaż mieszkania, które na danej osi są lepsze niż wskazany % pozostałych",
    axes_ph: "lepiej niż %",
    fresh: "Dane nieaktualne", fresh_btn: "Odśwież",
    cmp_pick: "Porównaj", cmp_with: "Porównaj z już wybranym",
    cmp_drop: "Anuluj porównanie", cmp_title: "Porównanie",
    cmp_back: "Zamknij porównanie",
    f_price: "Cena, tys.", f_area: "Powierzchnia, m²", f_score: "Ocena",
    f_commute: "Nie dłużej, min", f_year: "Rok", f_rooms: "Pokoje",
    f_commute_setup: "Adres pracy", commute_calc: "Oblicz",
    commute_calc_busy: "Liczę…", commute_ok: (n) => `Gotowe: policzono dla ${n} ${plP(n, "mieszkania", "mieszkań", "mieszkań")}`,
    commute_err_addr: "Podaj adres", commute_err_backend: "Lokalny serwer niedostępny (wymaga 6.valuate/api.py)",
    commute_addr_ph: "np. Prosta 67",
    f_district: "Dzielnica", f_market: "Rynek", f_seller: "Sprzedający", f_cond: "Stan",
    list_a: "Lista mieszkań", close_a: "Zamknij",
    ut: { private: "Właściciel", developer: "Deweloper", agency: "Biuro nieruchomości" },
    mt: { primary: "Pierwotny", secondary: "Wtórny" },
    cs: { ready_to_use: "Do zamieszkania", to_completion: "Do wykończenia", to_renovation: "Do remontu" },
    rooms_s: "pok.", min: "min", days_u: "dn.",
    rating: "ocena", cheaper: "taniej niż podobne oferty", pricier: "drożej niż podobne oferty",
    cheaper_deals: "taniej niż transakcje w pobliżu", pricier_deals: "drożej niż transakcje w pobliżu",
    deals_n: (n) => `według ${n} prawdziwych transakcji w pobliżu (akty notarialne), świeże ważą więcej`,
    f_ppm: "Cena za m²", f_area2: "Powierzchnia", f_rooms2: "Pokoje", f_floor: "Piętro",
    f_of: "z", f_year2: "Rok", f_seller2: "Sprzedający", f_market2: "Rynek",
    f_cond2: "Stan", f_metro: "Metro pieszo", f_noise: "Hałas",
    f_school: "Szkoła E8", f_own: "Utrzymanie", f_since: "Na rynku od", f_heat: "Ogrzewanie",
    f_comm: "Prowizja", f_park: { garage: "Miejsce w garażu", surface: "Miejsce parkingowe", mixed: "Miejsce parkingowe", any: "Miejsce postojowe" }, park_from: "od", park_sep: "osobno", park_incl: "w cenie mieszkania", c_none: "brak",
    comm_s: { est: "nie podano, do ustalenia", yes: "procent nie podany, do ustalenia", pct: "podana w ogłoszeniu",
              none: "podano w ogłoszeniu", private: "sprzedaje właściciel", developer: "bezpośrednio od dewelopera" },
    ht_full: { urban: "Miejskie", boiler_room: "Kotłownia", gas: "Gazowe", electrical: "Elektryczne", other: "Inne", tiled_stove: "Piecowe" },
    f_commute2: "Dojazd do domu", noise_lt: "do 45 dB", db: "dB", mo: "zł/mies.",
    otodom: "Otwórz ogłoszenie", street: "Street View", devall: "Wszystkie mieszkania inwestycji",
    noaddr: "Bez adresu", blur: (m) => `pinezka rozmyta przez sprzedającego (±${m} m) — adres i ocena przybliżone`,
    gaps: (n) => `brakujących parametrów: ${n}`,
    dist: "Co w okolicy", pos: "Plusy", neg: "Minusy", dwait: "wczytywanie odległości…",
    dsort_dist: "odległość", dsort_weight: "ważność", dsort_label: "sortowanie „Co w okolicy”",
    rem: "Wcześniej w sprzedaży", rem_same: "Wcześniejsze ogłoszenia tego mieszkania", rem_other: "Inne mieszkania w tym budynku",
    rem_other_hint: "Zdjęte ogłoszenia sąsiednich mieszkań pod tym adresem — do porównania cen.", roff: "zdjęto", arch: "Archiwum ogłoszenia",
    l_apts: "Mieszkania", l_rem: "Zdjęte ze sprzedaży",
    l_iso: "Dojazd", l_gios: "Jakość powietrza PM2.5 (GIOŚ)",
    l_airly: "Jakość powietrza PM2.5 (Airly)",
    ns_air: "samoloty", ns_rail: "kolej", ns_tram: "tramwaj", ns_industry: "przemysł", ns_road: "drogi",
    l_tram: "Tramwaj: linie i przystanki", l_metro: "Metro: linie i stacje",
    l_metro_construction: "🚧 Metro: w budowie", l_rail: "Kolej: SKM, KM, WKD",
    layers_t: "Warstwy mapy", map_err: "Mapa się nie wczytała — sprawdź internet i odśwież stronę. Lista mieszkań działa.", g_offers: "Oferty", g_transit: "Transport", g_noise: "Hałas",
    g_air: "Powietrze PM2.5", g_iso: "Izochrony",
    noise_src: "Źródło", noise_off: "wyłączony", noise_leg: "Hałas, dB", per_day: "Doba", per_night: "Noc",
    nz_road: "Drogi", nz_rail: "Kolej", nz_air: "Samoloty", nz_tram: "Tramwaj", nz_industry: "Przemysł",
    stop_near: "Mieszkań w promieniu", near_on: "Pokaż mieszkania w pobliżu", near_off: "Pokaż wszystkie mieszkania",
    lines_title: "Linie", lines_hint: "kliknij numer lub linię — wyróżnij", lines_clear: "wyczyść",
    tram_w: "Tramwaj", metro_w: "Metro", station_w: "stacja",
    metro_construction_w: "Metro (w budowie)", rail_w: "Pociąg",
    stop_tram: "Przystanek tramwajowy", stop_metro: "Stacja metra",
    stop_metro_construction: "Stacja metra (w budowie)",
    l_metro_planned: "Metro: planowane · M3, M4", metro_planned_w: "Metro (planowane)",
    metro_planned_note: "Linia w planach miasta — według OpenStreetMap; terminu budowy w danych nie ma. Nie liczy się do oceny dostępności pieszej.",
    metro_construction_note: "Stacja jest w budowie, data otwarcia nie jest znana. Nie liczy się do oceny dostępności pieszej.",
    hide: "Ukryj", unhide: "Przywróć", hide_t: "Ukryj to mieszkanie (i jego powtórzenia) z mojej listy",
    unhide_t: "Przywróć na listę", hid_toast: "Ukryto z wyszukiwania", unhid_toast: "Przywrócono do wyszukiwania", undo: "Cofnij",
    fav: "Do ulubionych", unfav: "Usuń z ulubionych",
    fav_t: "Dodaj to mieszkanie (i jego powtórzenia) do ulubionych",
    unfav_t: "Usuń z ulubionych", fav_toast: "Dodano do ulubionych", unfav_toast: "Usunięto z ulubionych",
    f_checked: "Sprawdzono", today: "dzisiaj", yesterday: "wczoraj", ago_d: (n) => `${n} dn. temu`,
    stale_hint: "dawno nie sprawdzano — możliwe, że już zdjęte",
    dup_note: (n) => `+${n} ${plP(n, "duplikat", "duplikaty", "duplikatów")}`, dup_note_series: (n) => `+${n} tego układu`, dups_t: (n) => `Duplikaty tego mieszkania (${n})`,
    dups_series: (n) => `Jeszcze ${n} ${n === 1 ? "mieszkanie" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "mieszkania" : "mieszkań"} tego układu`,
    dup_series_hint: "Sąsiednie mieszkania o tym samym układzie w tym budynku — różne, ale prawie identyczne: inne piętro, klatka lub budynek. Na liście pokazane jedno, tutaj — wszystkie.",
    fl_short: "p.",
    dup_hint: "To samo mieszkanie w innych ogłoszeniach: zgadzają się adres, powierzchnia, piętro i cena (±4%) albo te same zdjęcia. Na liście ukryte, tutaj — wszystkie linki.",
    legend: "PM2.5, µg/m³", err: "Nie udało się wczytać danych.",
    m2: "m²", km: "km", m_u: "m", yr: "r.", ppm_u: "zł/m²", metro_s: "metro",
    shown_of: (n, all) => `${n} z ${all}`,
    cnt_hidden: (n) => `🚫 ${n}`, cnt_hidden_s: (n) => `🚫 ${n}`, cnt_hidden_t: "Pokaż ukryte mieszkania — można je przywrócić",
    cnt_back: "← wszystkie", cnt_back_t: "Ukryj je ponownie i pokaż pozostałe",
    cnt_fav: (n) => `⭐ ${n}`, cnt_fav_s: (n) => `⭐ ${n}`, cnt_fav_t: "Pokaż ulubione — wszystkie, bez filtrów wyszukiwania",
    cnt_fav_back_t: "Wróć do wyników wyszukiwania",
    empty_h: "Nic nie znaleziono — poluzuj filtry",
    gap_card: (n) => `w ogłoszeniu brakuje ${n} param. — ocena mniej dokładna`,
    rem_tip: (n) => `Zdjęto ze sprzedaży: ${n}`, rem_more: (n) => `+ jeszcze ${n}`,
    sum_t: "Podsumowanie", sum_sub: "negocjacje · notatka · ceny · oceny", facts_t: "Parametry",
    dist_sub0: "komunikacja, szkoły, sklepy, parki i co przeszkadza",
    dist_sub: (p, n) => `plusy: ${p}${n ? ` · minusy: ${n}` : ""}`,
    ax_box: "Ocena", ax_sum: (b, bv, w, wv) => `↑ ${b} ${bv} · ↓ ${w} ${wv}`, trade_t: "Negocjacje", trade_days: (n) => `w sprzedaży ${n} dni`,
    trade_drops: (n, d, p) => `obniżano ${n} ${n === 1 ? "raz" : "razy"}: łącznie −${d} PLN (−${p}%)`,
    trade_gap: (p) => `o ${p}% drożej niż transakcje w pobliżu`, trade_cheap: (p) => `o ${p}% taniej niż transakcje w pobliżu`,
    trade_strong: "jest pole do negocjacji", trade_some: "warto spróbować negocjować", trade_none: "negocjacje raczej zbędne",
    trade_times: (n) => `wystawiane ${n}. raz`, trade_copies: (n, s) => `teraz ${n} ${plP(n, "ogłoszenie", "ogłoszenia", "ogłoszeń")}${s ? ` (${s})` : ""}`,
    trade_raised: (s) => `cenę podnoszono: ${s}`,
    note_t: "Moja notatka", note_add: "+ Dodaj notatkę", note_ph: "Np.: dzwoniłem, negocjacje do…, sąsiedzi…",
    note_hint: "Widzisz tylko ty · zapisane w profilu, widoczne w bocie",
    visit_l: "Oglądanie", visit_t: "Oznacz mieszkanie jako odwiedzone — synchronizuje się między urządzeniami przez profil",
    note_save: "Zapisz", note_retry: "Ponów", note_saving: "Zapisuję…",
    note_dirty: "Nie zapisano", note_err: "Brak połączenia — nie zapisano. Tekst nie zginął",
    note_ok: (t) => `✓ Zapisano w profilu · ${t}`, note_ok_local: (t) => `✓ Zapisano w tej przeglądarce · ${t}`,
    note_not_sent: "Zapisano tylko tutaj — jeszcze nie trafiło do profilu", note_hint_local: "Widzisz tylko ty · zapisane w tej przeglądarce",
    hist_t: "Historia ceny", hist_since: (d) => `od ${d}`,
    hist_sum: (n, d) => `${d} · zmieniana ${n} ${n === 1 ? "raz" : "razy"}`,
    hist_today: "dziś", k_short: "tys.",
    rcn_sum: (m, gap) => `${m}${gap ? ` · ${gap}` : ""}`,
    rcn_t: "Ceny transakcji w pobliżu", rcn_src: "akty notarialne · RCN Warszawy",
    rcn_med: (n, r, mk) => `mediana ${n} sprzedaży z roku w promieniu ${r} m · ${mk}`,
    rcn_this: "To mieszkanie", rcn_more: (p) => `o ${p}% drożej niż transakcje`, rcn_less: (p) => `o ${p}% taniej niż transakcje`,
    rcn_similar: (n, r) => `mediana ${n} transakcji podobnych mieszkań w pobliżu${r ? ` (${r} pok., podobny metraż)` : ""} · świeże ważą więcej`,
    rcn_all: (m, n, r) => `Wszystkie transakcje w promieniu ${r} m z roku: ${m} zł/m² (${n})`,
    rcn_same: "jak transakcje w pobliżu",
    rcn_house: (n, m) => `W tym budynku: ${n} ${n === 1 ? "sprzedaż" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "sprzedaże" : "sprzedaży"}, mediana ${m} zł/m²`,
    rcn_list: (n) => `Najbliższe transakcje (${n})`, rcn_cols: ["Data", "Pow.", "Pok.", "Piętro", "zł/m²", "Odl."],
    rcn_years: "W tym budynku według lat", rcn_years_note: "mediana zł/m² wszystkich transakcji w budynku, oba rynki · z prawej — liczba transakcji",
    rcn_growth: (y, p) => `od ${y}: ${p > 0 ? "+" : "−"}${Math.abs(p)}%`,
    arch_tag: (d) => `Zdjęto ze sprzedaży ${d}`, arch_tag_s: (d) => `Zdjęto ${d}`, arch_last: "Ostatnia cena",
    arch_note: "Ogłoszenie zdjęte ze sprzedaży. Dla mieszkań zdjętych przed 1 października 2026 zdjęcia, oceny osi i „Co w pobliżu” się nie zachowały — tylko to, co poniżej.",
    arch_period: "W sprzedaży", arch_otodom: "Ogłoszenie na Otodom (może być usunięte)", arch_open: "Karta",
    arch_fav: (n) => `Zdjęte ze sprzedaży — ${n} z ulubionych`, arch_here: "Zdjęte pod tym adresem",
    ntf_btn: "Zapisz wyszukiwanie", ntf_on: "Wyszukiwanie zapisane",
    ntf_t: "Zapisz wyszukiwanie", ntf_on_t: "Wyszukiwanie zapisane",
    ntf_lead: "To wyszukiwanie stanie się Twoim — na stronie i w bocie. Bot będzie wysyłać z niego nowe mieszkania:",
    ntf_lead_out: "Zapisane wyszukiwanie — jedno na stronie i w bocie: według niego bot wysyła nowe mieszkania w Telegramie mniej więcej co 2 godziny. Potrzebne logowanie — raz, przez bota.",
    ntf_lead_on: "To Twoje wyszukiwanie — na stronie i w bocie. Bot wysyła z niego nowe mieszkania mniej więcej co 2 godziny:",
    ntf_now: "Teraz zapisane:", ntf_when: "Przychodzą w ciągu dnia mniej więcej co 2 godziny (08:00–22:00), tylko gdy jest coś nowego.",
    ntf_off_note: "Powiadomienia są teraz wyłączone — zapisanie je włączy.",
    ntf_on_note: "Zmień filtry — przycisk znów pokaże «Zapisz wyszukiwanie», a nowe wyszukiwanie zastąpi to.",
    ntf_login_note: "Napisz do bota /profile — wyśle link do logowania. Potem wróć i naciśnij «Zapisz wyszukiwanie».",
    ntf_cancel: "Anuluj", ntf_save: "Zapisz wyszukiwanie", ntf_saving: "Zapisuję…", ntf_login: "Zaloguj przez Telegram",
    ntf_off: "Wyłącz powiadomienia", ntf_err: "Nie udało się zapisać — spróbuj jeszcze raz.",
    ntf_all: "Wszystkie mieszkania, bez filtrów", ntf_price: "Cena", ntf_rooms: (v) => `Pokoje ${v}`,
    ntf_districts: (n) => `${n} ${n === 1 ? "dzielnica" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "dzielnice" : "dzielnic"}`,
    err_h: "Uruchom <code>venv/bin/python 5.web/export.py</code> i otwórz stronę przez lokalny serwer.",
    err_net: "Brak połączenia ze stroną", err_btn: "Spróbuj ponownie",
  },
};

/* Язык: ?lang= из ссылки бота → выбор прошлого визита → русский.
 * Ссылка главнее localStorage: бот шлёт lang= осознанно, под язык подписчика. */
let LANG = (() => {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "pl" || q === "ru") return q;
  try { return localStorage.getItem("wf_lang") || "ru"; } catch { return "ru"; }
})();

/* tr, а не L: L был глобальным объектом Leaflet (до 18.10.2026) — короткое имя
 * его затеняло, и падала вся карта разом. Имя так и осталось tr. */
const tr = (k) => T[LANG][k] ?? T.ru[k] ?? k;
// Подписи осей и слоёв приходят из meta.i18n (словарь бота + карта)
const axisName = (i) => state.meta?.i18n?.[LANG]?.axes?.[i] ?? state.meta.axes[i];
const distName = (ru) => state.meta?.i18n?.[LANG]?.dist?.[ru] ?? ru;

const LABEL = {
  get ut() { return tr("ut"); },
  get mt() { return tr("mt"); },
  get cs() { return tr("cs"); },
};

/** Аннуитетный платёж — те же параметры, что в боте (config.MORTGAGE_*),
 *  чтобы «владение» на сайте и в Telegram совпадало до злотого. */
function monthly(price, cz) {
  const m = state.meta?.mortgage;
  if (!m || !price) return null;
  const loan = price * (1 - m.down), r = m.rate / 12, n = m.years * 12;
  return loan * r / (1 - Math.pow(1 + r, -n)) + (cz || 0);
}

/** Владение в месяц (19.10.2026): рата + czynsz из объявления. Только факты (юзер):
 *  czynszu нет в объявлении — оценку не подставляем; отопление не городское (газ, электро,
 *  «bezczynszowe») — его стоимость не выдумываем, пишем «уточнить у продавца». В обоих
 *  случаях итог — «от» (full=false). Свет и интернет не считаем — у всех разные. */
const HEAT_SEPARATE = { gas: 1, electrical: 1, other: 1, tiled_stove: 1 };
function ownCost(a) {
  const rata = monthly(a.p, 0);
  if (rata == null) return null;
  const czKnown = a.cz != null || a.czs === "none";
  const heatSep = a.czs === "none" || !!HEAT_SEPARATE[a.ht];
  return { rata, cz: a.cz || 0, czKnown, heatSep, full: czKnown && !heatSep, total: rata + (a.cz || 0) };
}

/** Строка «Владение» в карточке: итог + из чего он + откуда czynsz (HTML). */
function ownHtml(a) {
  const o = ownCost(a);
  if (!o) return "—";
  const f = (v) => nf.format(Math.round(v));
  const items = [`${tr("own_rata")}\u00a0${f(o.rata)}`];   // \u00a0 — сумма не отрывается от подписи
  if (a.czs === "none") items.push(tr("own_nocz"));
  else if (o.czKnown) items.push(`czynsz\u00a0${f(o.cz)}`);
  // строки: итог · из чего · чего нет в объявлении (уточнить) · что не входит
  const notes = [!o.czKnown ? tr("own_cz_ask") : a.czs === "desc" ? tr("own_desc") : "",
    o.heatSep ? tr("own_heat_ask")(tr("ht")[a.ht] || "") : ""].filter(Boolean);
  // итог — той же точности, что слагаемые (иначе «от ~4 440» при кредите 4 445)
  return esc(`${o.full ? "" : tr("own_from") + " "}${f(o.total)} ${tr("mo")}`) + `<span class="place-sub">${esc(items.join(" · "))}</span>` +
    notes.map((n) => `<span class="place-sub">${esc(n)}</span>`).join("") +
    `<span class="place-sub own-note">${esc(tr(a.czs === "none" ? "own_excl_none" : "own_excl"))}</span>`;
}

// ── Загрузка ────────────────────────────────────────────────────────────────
async function load() {
  /* Токен личного профиля (?t= из бота) — забрать ДО readUrl(): тот
   * переписывает адресную строку фильтрами и ?t= потерялся бы. */
  profileToken();
  /* Личные зоны — только по токену из ссылки. Нет токена или файл не найден
   * (чужой/устаревший токен) — молча остаёмся без них: фильтр «Дорога» сам
   * спрячется, а карточка не покажет строку про дорогу до дома. */
  const isoTok = new URLSearchParams(location.search).get("iso");
  const isoReq = isoTok && /^[0-9a-f]{6,32}$/.test(isoTok)
    ? fetch(`data/iso/${isoTok}.json?v=${Date.now()}`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
    : Promise.resolve(null);

  /* GitHub Pages отдаёт всё с max-age=600: браузер десять минут не спрашивает
   * сервер вообще, и после прогона страница показывала вчерашние цены.
   *
   * Схема: сперва тянем meta.json МИМО кеша (4 КБ, дёшево), берём из него
   * generated и подставляем как версию ко всем остальным файлам. Пока данные
   * те же — работает обычный кеш; пересобрался пайплайн — версия изменилась,
   * и браузер честно перекачает. Гасить кеш у всех файлов подряд нельзя:
   * это 1.5 МБ квартир на каждое обновление страницы. */
  const meta = await fetch(`data/meta.json?_=${Date.now()}`, { cache: "no-store" })
    .then((r) => r.json());
  const v = encodeURIComponent(meta.generated || "");
  BUILD = v;

  const [apts, layers] = await Promise.all([
    fetch(`data/apartments.json?v=${v}`).then((r) => r.json()),
    fetch(`data/layers.json?v=${v}`).then((r) => r.json()).catch(() => ({})),
  ]);
  state.all = apts;
  state.meta = meta;
  state.layers = layers;
  const iso = await isoReq;
  if (iso) {
    // приводим к тому же виду, что был у общей выгрузки — остальной код не знает
    // и не должен знать, откуда зоны взялись
    state.layers.iso = [{ tok: isoTok, bands: iso.bands }];
    state.layers.tt = { [isoTok]: iso.tt };
  }
  buildFilters();
  bindPlaces();
  bindNotify();
  bindArchLinks();
  measureChrome();
  initGutter();
  watchFreshness();
  loadHidden();       // чёрный список из localStorage — ДО readUrl(): ?hide= из бота дольётся в него
  loadFavorites();    // избранное из localStorage — ДО readUrl(): ?fav= из бота дольётся в него
  loadWant();         // «Важно для меня» из localStorage — ДО readUrl(): ?want= из ссылки главнее
  loadSort();         // сортировка из localStorage — ДО readUrl(): ?sort= из ссылки может переопределить
  $("#sort").value = state.sort;
  fitSort();
  await resolveShort();   // ?s=<код> — короткая ссылка: подставить сохранённый поиск
  readUrl();          // фильтры из ссылки — до первого apply()
  loadVisited();      // «Посещённая» — localStorage; с профилем сливается в loadPlaces
  loadNotes();        // «Моя заметка» — localStorage; с профилем сливается в loadPlaces
  relistCarry();      // избранное/скрытое/заметки — на новые id переразмещённых квартир
  buildWant();
  initMap();
  apply();
  initMenu();
  loadPlaces();       // вход по ссылке из бота (избранное/скрытые с ботом) и «Мои места» — в фоне
  // ?report=<id> — отчёт по квартире; читаем адрес заново: короткая ?s=<код> раскрывается выше (resolveShort)
  const repId = new URLSearchParams(location.search).get("report") || START_REPORT;
  if (repId) { openReport(repId); return; }
  if (START_CARD) {   // в продаже — обычная карточка, снятая — карточка из архива
    const a = state.all.find((x) => x.id === START_CARD);
    a ? select(a.id) : openArch(START_CARD);
  }
}

/* Меню профиля (разметка общая для всех страниц, см. site-ui.js): строка
 * «вошли / без входа», ссылка входа, «Мои места» открывает окно мест здесь
 * же. Переход с других страниц — app.html#places. */
function initMenu() {
  const logged = !!profileToken();
  $("#menu-status").dataset.i18n = logged ? "profile_in" : "profile_device";
  $("#menu-status").textContent = tr($("#menu-status").dataset.i18n);
  $("#menu-login-foot").hidden = logged;
  $("#menu-places").onclick = () => { setProfileOpen(false); setPlacesOpen(true); };
  if (START_HASH === "#places") {
    setPlacesOpen(true);
  } else if (START_HASH === "#want") {
    $("#want-toggle").click();
    $("#want").scrollIntoView({ block: "center" });
  }
}

// ── Фильтры ─────────────────────────────────────────────────────────────────
/* Кнопки чипов в реестре: URL умеет их не только читать, но и включать.
 * Ключ — имя набора в state (rooms/market/seller/cond). */
const chipBtns = {};

function chip(host, label, value, set, name) {
  (chipBtns[name] ||= {})[value] = null;
  const b = document.createElement("button");
  b.type = "button";
  b.className = "chip ds-chip";
  chipBtns[name][value] = b;
  b.textContent = label;
  b.setAttribute("aria-pressed", "false");
  b.onclick = () => {
    const on = b.getAttribute("aria-pressed") === "true";
    b.setAttribute("aria-pressed", String(!on));
    on ? set.delete(value) : set.add(value);
    apply();
  };
  host.appendChild(b);
}

/* Плейсхолдеры границ (год/цена/площадь) — берём из meta.ranges, а не хардкодим,
 * иначе плейсхолдер врал бы про диапазон при первом же изменении данных.
 * Вызывается и из buildFilters(), и из applyLang(): общий цикл [data-i18n-ph]
 * в applyLang() иначе стирал бы число обратно на голое «от»/«od» при смене языка. */
/* Плейсхолдер — голое число, без «от»/«до»: то теперь пишут ВИДИМЫЕ подписи
 * рядом с полем (см. разметку панели в app.html), а вторая копия того же
 * слова внутри поля читалась бы как дубль. */
function labelRangePlaceholders() {
  const set = (id, txt) => { const el = $(id); if (el) el.placeholder = txt; };
  const [ymin, ymax] = state.meta.ranges.year;
  set("#f-ymin", `${ymin}`);
  set("#f-ymax", `${ymax}`);
  const [pmin, pmax] = state.meta.ranges.price;
  set("#f-pmin", `${Math.round(pmin / 1000)}`);
  set("#f-pmax", `${Math.round(pmax / 1000)}`);
  const [amin, amax] = state.meta.ranges.area;
  set("#f-amin", `${Math.round(amin)}`);
  // «до» — «любая»: максимум по базе ломает одно кривое объявление (7542 м²)
  set("#f-amax", tr("any"));
  set("#f-smin", "0");
  set("#f-smax", "100");
}

/* Пары «от/до» в полосе фильтров: <label> связан только с ПЕРВЫМ input'ом,
 * у второго подпись — placeholder, который для скринридера исчезает при вводе.
 * aria-label собираем из уже существующих переводов (название поля + from/to),
 * новых ключей в словаре заводить не пришлось. */
const PAIR_LABELS = [
  ["#f-pmin", "f_price", "from"], ["#f-pmax", "f_price", "to"],
  ["#f-amin", "f_area", "from"], ["#f-amax", "f_area", "to"],
  ["#f-smin", "f_score", "from"], ["#f-smax", "f_score", "to"],
  ["#f-ymin", "f_year", "from"], ["#f-ymax", "f_year", "to"],
];
function labelPairedInputs() {
  PAIR_LABELS.forEach(([id, fieldKey, dirKey]) => {
    const el = $(id);
    if (el) el.setAttribute("aria-label", `${tr(fieldKey)} ${tr(dirKey)}`);
  });
}

// Чипы комнат. «2» — с 12.10.2026, когда скрапер начал брать двушки (config.ROOMS_MIN).
const ROOM_CHIPS = ["2", "3", "4", "5+"];

function buildFilters() {
  ROOM_CHIPS.forEach((r) => chip($("#f-rooms"), r, r === "5+" ? "5" : r, state.rooms, "rooms"));
  Object.entries(LABEL.mt).forEach(([k, v]) => chip($("#f-market"), v, k, state.market, "market"));
  Object.entries(LABEL.ut).forEach(([k, v]) => chip($("#f-seller"), v, k, state.seller, "seller"));
  Object.entries(LABEL.cs).forEach(([k, v]) => chip($("#f-cond"), v, k, state.cond, "cond"));

  buildDistrictFilters();
  buildAxisFilters();

  /* «Дорога, мин» есть только в личной сборке: в публичной изохрон нет, и
   * фильтр по ним отсеял бы всё в ноль. Прячем поле целиком (подпись + ввод),
   * а не оставляем мёртвым. */
  if (!hasCommute()) {
    const f = $("#f-tmax");
    f.value = "";
    f.disabled = true;
    $("#commute-field")?.setAttribute("hidden", "");
  }

  labelRangePlaceholders();
  labelPairedInputs();

  // Дебаунс: см. debounce() выше — без него один введённый символ гоняет
  // полную перерисовку списка и карты и может засыпать history.replaceState
  ["#f-pmin", "#f-pmax", "#f-amin", "#f-amax", "#f-smin", "#f-tmax",
   "#f-ymin", "#f-ymax", "#f-smax"].forEach((id) => {
    $(id).oninput = debouncedApply;
  });
  $("#sort").onchange = (e) => { state.sort = e.target.value; saveSort(); fitSort(); apply(); };
  $("#reset").onclick = resetAll;
  $("#panel-reset").onclick = resetAll;
  // Название сайта — теперь обычная ссылка на homepage.html (юзер 2026-09-26),
  // как на остальных страницах (market/valuate/list-apartment). Раньше кнопка
  // сбрасывала фильтры и оставалась на app.html — эта возможность никуда не
  // делась, она отдельной кнопкой «Сбросить всё» в панели фильтров (#reset/
  // #panel-reset), поэтому обработчик клика здесь просто не нужен.
  $("#menu-fav").onclick = () => {
    // Живой счётчик (см. _liveCount) — иначе кнопка включила бы «только избранное»
    // ради списка, где реально нет ни одной строки (избранное всё снято с продажи)
    if (!_liveCount(state.favorites, favKey) && !state.onlyFav) return;
    state.onlyFav = !state.onlyFav;
    if (state.onlyFav) state.showHidden = false;     // «Избранное» и «Скрытые» — разные виды
    setProfileOpen(false);
    apply(false);   // не прыгать наверх — юзер переключает вид, не меняет критерии поиска
  };
  $("#count-hidden").onclick = () => $("#menu-hidden").onclick();
  $("#count-fav").onclick = () => $("#menu-fav").onclick();
  $("#menu-hidden").onclick = () => {
    if (!_liveCount(state.hidden, hideKey) && !state.showHidden) return;
    state.showHidden = !state.showHidden;
    if (state.showHidden) state.onlyFav = false;
    setProfileOpen(false);
    apply(false);   // тот же приём, что и «Избранное» выше
  };
  $("#theme").onclick = () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("wf_theme", next); } catch {}
    refreshThemeBtn();
    applyMapTheme(next);
  };
  refreshThemeBtn();
  $("#sheet-close").onclick = closeSheet;

  /* Сортировка живёт в строке над списком (.list-head) на любой ширине.
   * Раньше на телефоне узел переносился в начало шторки фильтров и стоял
   * там над заголовком «Фильтры» без оформления (29.09 — убрано). */

  layoutFilters();
  window.addEventListener("resize", layoutFilters);

  /* Телефон: список и карта — ВКЛАДКИ, а не две полосы одного экрана.
   * Делить 6-дюймовый экран между ними бессмысленно: обе половины неудобны.
   * На широком экране вкладки скрыты (CSS), там работает разделитель. */
  const showTab = (which) => {
    document.body.classList.toggle("tab-map", which === "map");
    $("#tab-list").setAttribute("aria-selected", String(which !== "map"));
    $("#tab-map").setAttribute("aria-selected", String(which === "map"));
    // Карта мерит контейнер при инициализации; пока она была скрыта,
    // её размер равен нулю — без пересчёта останется пустой
    if (which === "map") setTimeout(() => map?.resize(), 0);
    else {
      rowMeasuredNormal = 0; rowMeasuredGap = 0;
      paintWindow();
      // Докручиваем отложенную с прошлого раза цель (см. scrollListTo) —
      // список только что снова стал видим, clientHeight настоящий.
      if (pendingScrollId != null) {
        const id = pendingScrollId;
        pendingScrollId = null;
        scrollListTo(id);
        paintWindow();
      }
    }
  };
  $("#tab-list").onclick = () => showTab("list");
  $("#tab-map").onclick = () => showTab("map");
  // Стрелки влево/вправо переключают вкладки — стандартная клавиатурная
  // навигация для role="tablist" (WAI-ARIA Authoring Practices)
  $("#tabs")?.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const tabs = [...document.querySelectorAll("#tabs .tab")];
    const idx = tabs.indexOf(document.activeElement);
    if (idx < 0) return;
    e.preventDefault();
    const next = tabs[(idx + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    next.focus();
    next.click();
  });

  $("#flt-done").onclick = () => {
    document.body.classList.remove("flt-open");
    refreshFilterBtn();
    setTimeout(measureChrome, 0);
  };

  $("#flt-toggle").onclick = () => {
    document.body.classList.toggle("flt-open");
    refreshFilterBtn();
    setTimeout(measureChrome, 210);   // полоса появилась/исчезла — верх шторки другой
  };

  $("#collapse").onclick = () => setCollapsed(!state.collapsed);
  // Выбор прошлого визита: свернул список — он и остался свёрнутым. ТОЛЬКО
  // на ширине, где вообще есть кнопка разворота (аудит, веб-4): на телефоне
  // (≤700px, см. app.css) #collapse скрыт медиазапросом, а .split там уже не
  // грид — body.collapsed .list-col{overflow:hidden} всё равно применяется
  // глобально и запирает список без единого способа выйти из интерфейса.
  // Свернул на десктопе → открыл ту же ссылку на телефоне — раньше залипало
  // намертво, спасало только вручную чистить localStorage.
  try {
    if (localStorage.getItem("wf_collapsed") === "1" && window.innerWidth > 700) setCollapsed(true);
  } catch {}

  $("#lang").onclick = () => setLang(LANG === "ru" ? "pl" : "ru");

  initFilterPopovers();
  applyLang();
}

/* ── Поповеры компактной строки, полная панель, меню профиля ────────────────
 * Один открыт — остальные закрыты (как соседние всплывающие панели в проекте,
 * см. LayersPanel в initMap: тот же приём — stopPropagation внутри панели,
 * закрытие по клику снаружи документа). Клик ВНУТРИ любой из них не должен
 * доходить до document, иначе она гасла бы сама на каждом чипе/чекбоксе. */
function closeAllFilterUI() {
  ["price", "rooms", "district", "work"].forEach((k) => {
    $(`#pop-${k}-box`).hidden = true;
    $(`#pill-${k}`).setAttribute("aria-expanded", "false");
  });
  setPanelOpen(false);
  setProfileOpen(false);
}

function togglePop(key) {
  const box = $(`#pop-${key}-box`);
  const willOpen = box.hidden;
  closeAllFilterUI();
  if (!willOpen) return;
  box.hidden = false;
  $(`#pill-${key}`).setAttribute("aria-expanded", "true");
  if (key === "district") moveDistrictHome(box);
}

function setPanelOpen(on) {
  const panel = $("#flt-panel"), btn = $("#btn-more"), ov = $("#flt-overlay");
  panel.hidden = !on;
  btn.setAttribute("aria-expanded", String(on));
  const wide = window.innerWidth > 700;
  if (on && wide) {
    // Окно — под кнопкой «Ещё фильтры», не шире экрана (как на макете)
    const host = $("#filters").getBoundingClientRect();
    const b = btn.getBoundingClientRect();
    const w = Math.min(460, host.width - 32);
    panel.style.left = `${Math.max(16, Math.min(b.left - host.left, host.width - w - 16))}px`;
    panel.style.top = `${b.bottom - host.top + 6}px`;
    // затемнение — всё, что ниже полосы фильтров
    ov.style.top = `${host.bottom}px`;
  } else {
    panel.style.left = panel.style.top = "";
  }
  ov.hidden = !(on && wide);
  if (on && !wide) moveDistrictHome($("#fgrp-loc"));
}

function togglePanel() {
  const willOpen = $("#flt-panel").hidden;
  closeAllFilterUI();
  if (willOpen) setPanelOpen(true);
}

function setProfileOpen(on) {
  $("#profile-menu").hidden = !on;
  $("#profile-btn").setAttribute("aria-expanded", String(on));
}

function toggleProfile() {
  const willOpen = $("#profile-menu").hidden;
  closeAllFilterUI();
  if (willOpen) setProfileOpen(true);
}

function initFilterPopovers() {
  ["price", "rooms", "district", "work"].forEach((k) => {
    $(`#pill-${k}`).onclick = (e) => { e.stopPropagation(); togglePop(k); };
    $(`#pop-${k}-box`).addEventListener("click", (e) => e.stopPropagation());
  });
  $("#btn-more").onclick = (e) => { e.stopPropagation(); togglePanel(); };
  $("#panel-close").onclick = () => {
    if (window.innerWidth <= 700) $("#flt-done").click();
    else setPanelOpen(false);
  };
  // «Работа»: ползунок пишет в прежнее скрытое #f-tmax (его читает фильтр)
  $("#work-range").oninput = (e) => {
    $("#f-tmax").value = e.target.value;
    $("#work-range-val").textContent = `${e.target.value} ${tr("min")}`;
    debouncedApply();
  };
  $("#work-off").onclick = () => { $("#f-tmax").value = ""; apply(); closeAllFilterUI(); };
  $("#work-done").onclick = () => {
    if (hasCommute() && $("#f-tmax").value === "") { $("#f-tmax").value = $("#work-range").value; apply(); }
    closeAllFilterUI();
  };
  $("#flt-panel").addEventListener("click", (e) => e.stopPropagation());
  // Чипы активных фильтров лежат СНАРУЖИ поповеров/панели (это отдельная строка
  // под компактной строкой), но крестик на них не должен гасить открытую
  // «Ещё фильтры» как случайный клик по пустому месту.
  $("#flt-chips").addEventListener("click", (e) => e.stopPropagation());
  $("#panel-apply").onclick = () => {
    // На телефоне «полная панель» — это и есть вся шторка фильтров, поэтому
    // «Показать N квартир» закрывает её целиком, как раньше делала «Готово».
    if (window.innerWidth <= 700) $("#flt-done").click();
    else setPanelOpen(false);
  };
  $("#profile-btn").onclick = (e) => { e.stopPropagation(); toggleProfile(); };
  $("#profile-menu").addEventListener("click", (e) => e.stopPropagation());
  // Клик где угодно ещё (карта, список, шапка) закрывает всё открытое —
  // клики ВНУТРИ панелей сюда не доходят благодаря stopPropagation выше.
  document.addEventListener("click", closeAllFilterUI);
}

/* Единственные поля, которые физически существуют в двух местах разметки
 * (поповер пилюли ⇄ секция полной панели): переносим DOM-узел, а не
 * пересоздаём — второй копии тех же #f-district чекбоксов не заводим,
 * иначе состояние (какая галочка отмечена) разъехалось бы между копиями. */
function moveDistrictHome(container) {
  const node = $("#qf-district");
  if (node && node.parentElement !== container) container.appendChild(node);
}

/* Цена и Комнаты — поля есть ТОЛЬКО в поповерах пилюль на широком экране;
 * на телефоне поповеров нет вовсе, и те же узлы возвращаются в секцию
 * «Быстрые» полной панели (она на телефоне всегда развёрнута, см. app.css). */
function moveQuickFields() {
  const narrow = window.innerWidth <= 700;
  const priceHome = narrow ? $("#fgrp-quick") : $("#pop-price-box");
  const roomsHome = narrow ? $("#fgrp-quick") : $("#pop-rooms-box");
  const qp = $("#qf-price"), qr = $("#qf-rooms");
  if (qp && qp.parentElement !== priceHome) priceHome.appendChild(qp);
  if (qr && qr.parentElement !== roomsHome) roomsHome.appendChild(qr);
  const workHome = narrow ? $("#fgrp-loc") : $("#pop-work-box");
  const qc = $("#qf-commute");
  if (qc && qc.parentElement !== workHome) workHome.appendChild(qc);
  // Район на телефоне переносится не по клику (поповеров нет), а сразу домой
  if (narrow) moveDistrictHome($("#fgrp-loc"));
}

function layoutFilters() {
  moveQuickFields();
}

/* ── Значения на пилюлях компактной строки ───────────────────────────────── */
const roomLabel = (v) => (v === "5" ? "5+" : v);

function refreshPillLabels() {
  const pmin = $("#f-pmin").value, pmax = $("#f-pmax").value;
  const priceVal = pmin && pmax ? `${pmin}–${pmax} ${tr("k_u")}`
    : pmin ? `≥ ${pmin} ${tr("k_u")}` : pmax ? `≤ ${pmax} ${tr("k_u")}` : "";
  $("#pill-price-val").textContent = priceVal;
  $("#pill-price").classList.toggle("pill-on", !!priceVal);

  const roomsVal = [...state.rooms].sort().map(roomLabel).join(", ");
  $("#pill-rooms-val").textContent = roomsVal;
  $("#pill-rooms").classList.toggle("pill-on", !!roomsVal);

  const districts = [...state.districts];
  const distVal = districts.length
    ? (districts.length === 1 ? districts[0] : `${districts[0]} +${districts.length - 1}`) : "";
  $("#pill-district-val").textContent = distVal;
  $("#pill-district").classList.toggle("pill-on", !!distVal);

  const pillName = $("#pill-work > span");
  if (pillName) pillName.textContent = state.places[0]?.name || tr("f_work");
  const tmax = val("#f-tmax");
  const workOn = tmax != null && hasCommute();
  $("#pill-work-val").textContent = workOn ? `≤ ${tmax} ${tr("min")}` : "";
  $("#pill-work").setAttribute("aria-pressed", String(workOn));
  syncAxisSliders();
}

/* ── Активные фильтры — чипами под компактной строкой ────────────────────────
 * Цена/Комнаты/Район сюда НЕ попадают — они и так видны значением на своих
 * пилюлях (refreshPillLabels выше). Здесь — всё остальное: и то, что считает
 * бейдж «Ещё фильтры N» (extraCount), и «рядом с остановкой» — тот не входит
 * в полную панель, но тоже сужает выдачу, поэтому тоже чип, просто без счёта в N. */
/* «Площадь 55–90 м²» / «Площадь ≥ 55 м²» / «≤ 90 м²»; ничего не задано — null.
 * Общая для чипов над списком и сводки поиска в окне «Уведомлять». */
function rangeText(label, min, max, unit) {
  if (min == null && max == null) return null;
  const u = unit ? ` ${unit}` : "";
  return min != null && max != null ? `${label} ${min}–${max}${u}`
    : min != null ? `${label} ≥ ${min}${u}` : `${label} ≤ ${max}${u}`;
}

function buildActiveChips() {
  const host = $("#flt-chips");
  const items = [];

  const addRange = (idMin, idMax, label, unit) => {
    const text = rangeText(label, val(idMin), val(idMax), unit);
    if (text) items.push({ text, remove: () => { $(idMin).value = ""; $(idMax).value = ""; apply(); } });
  };
  addRange("#f-amin", "#f-amax", tr("f_area2"), tr("m2"));
  addRange("#f-ymin", "#f-ymax", tr("f_year2"), "");
  addRange("#f-smin", "#f-smax", tr("f_score"), "");

  axIds().forEach((id, i) => {
    const v = val(id);
    if (v == null) return;
    items.push({ text: `${axisName(i)} ≥ ${v}`, remove: () => { $(id).value = ""; apply(); } });
  });

  // «до работы ≤ N мин» — не чип: значение видно на своей кнопке «Работа»

  [["market", LABEL.mt], ["seller", LABEL.ut], ["cond", LABEL.cs]].forEach(([name, labels]) => {
    [...state[name]].forEach((v) => {
      items.push({
        text: labels[v] || v,
        remove: () => {
          state[name].delete(v);
          chipBtns[name]?.[v]?.setAttribute("aria-pressed", "false");
          apply();
        },
      });
    });
  });

  const extraCount = items.length;

  if (state.near) {
    items.push({
      text: `📍 ${state.near.name} · ${state.near.r} ${tr("m_u")}`,
      remove: () => linesClearAll(),
    });
  }

  host.innerHTML = "";
  host.hidden = items.length === 0;
  items.forEach((it) => {
    const chip = document.createElement("span");
    chip.className = "achip";
    const label = document.createElement("span");
    label.textContent = it.text;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", tr("chip_remove")(it.text));
    btn.textContent = "✕";
    btn.onclick = it.remove;
    chip.appendChild(label);
    chip.appendChild(btn);
    host.appendChild(chip);
  });

  const badge = $("#more-badge");
  badge.hidden = extraCount === 0;
  badge.textContent = String(extraCount);
  $("#btn-more").classList.toggle("pill-on", extraCount > 0);
}

/* ── Переключение языка ──────────────────────────────────────────────────────
 * Перерисовываем всё, что уже отрендерено: статическую разметку по data-i18n,
 * чипы, контрол слоёв и список. Старая карта переводила готовый HTML регулярками
 * (plTx) — отсюда росли баги с чекбоксами Leaflet, которые ловились неделю.
 * Здесь текста в разметке нет вообще: есть ключ, есть словарь. */
function setLang(l) {
  LANG = l;
  try { localStorage.setItem("wf_lang", l); } catch {}
  // lang= в адресе: ссылка должна открыться на том же языке
  const q = new URLSearchParams(location.search);
  q.set("lang", l);
  history.replaceState(null, "", `?${q}`);
  applyLang();
  apply();                 // список, счётчик и маркеры — с новыми подписями
}

function applyLang() {
  document.documentElement.lang = LANG;
  buildWant();   // подписи чипов «Важно для меня» — из словаря
  refreshWorkUI(); renderPlaces();
  $("#lang").textContent = LANG === "ru" ? "PL" : "RU";

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = tr(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = tr(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = tr(el.dataset.i18nPh);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", tr(el.dataset.i18nAria));
  });

  refreshCollapseBtn();
  refreshFilterBtn();
  refreshThemeBtn();
  setTimeout(measureChrome, 0);   // подписи сменились — полоса могла перенестись
  if (state.meta) {
    const keep = axIds().map((id) => $(id)?.value ?? "");
    buildAxisFilters();
    axIds().forEach((id, i) => { if ($(id)) $(id).value = keep[i]; });
    // ПОСЛЕ общего цикла [data-i18n-ph] выше — иначе он стирает число обратно на голое «от»
    labelRangePlaceholders();
    labelPairedInputs();
  }
  rowMeasuredNormal = 0; rowMeasuredGap = 0;    // подписи другого языка могут менять переносы и высоту
  rebuildChips();
  hiddenTagRefresh();
  favTagRefresh();
  fitSort();                                    // подпись выбранной сортировки на другом языке другой длины
  if (map) rebuildLayerControl();
}

/* Чипы пересобираем целиком: подписи меняются, а выбранные значения должны
 * пережить смену языка — они лежат в state, не в кнопках. */
function rebuildChips() {
  [["#f-rooms", "rooms"], ["#f-market", "market"],
   ["#f-seller", "seller"], ["#f-cond", "cond"]].forEach(([host, name]) => {
    $(host).innerHTML = "";
    delete chipBtns[name];
  });
  ROOM_CHIPS.forEach((r) => chip($("#f-rooms"), r, r === "5+" ? "5" : r, state.rooms, "rooms"));
  Object.entries(LABEL.mt).forEach(([k, v]) => chip($("#f-market"), v, k, state.market, "market"));
  Object.entries(LABEL.ut).forEach(([k, v]) => chip($("#f-seller"), v, k, state.seller, "seller"));
  Object.entries(LABEL.cs).forEach(([k, v]) => chip($("#f-cond"), v, k, state.cond, "cond"));
  // вернуть нажатое состояние из state
  Object.entries(chipBtns).forEach(([name, btns]) =>
    Object.entries(btns).forEach(([v, b]) =>
      b.setAttribute("aria-pressed", String(state[name].has(v)))));
}

/* Подписи слоёв запечены в панели, поэтому на смену языка её собираем заново.
 * Включённые слои помнятся по ключу в layerOn — см. панель слоёв. */
/* Ширина сортировки — по ВЫБРАННОМУ варианту (18.10.2026, юзер: «разъехалась, не
 * пропорционально контенту»): обычный <select> берёт ширину самого длинного пункта
 * («цена за м² ↑»), и «цена ↑» сидела в рамке вдвое шире текста. Меряем текст тем же
 * шрифтом + поля + стрелка браузера. */
let _sortCtx = null;
function fitSort() {
  const sel = $("#sort");
  if (!sel) return;
  const opt = sel.options[sel.selectedIndex];
  if (!opt) return;
  const cs = getComputedStyle(sel);
  _sortCtx ||= document.createElement("canvas").getContext("2d");
  _sortCtx.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const text = _sortCtx.measureText(opt.textContent).width;
  const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
  sel.style.width = `${Math.ceil(text + pad + 32)}px`;   // 32 — стрелка списка и зазор до неё (в Safari она шире, чем в Chrome)
}

function rebuildLayerControl() {
  buildLayerControl();
}

/* Свернуть список — карта на всю ширину. Карта считает размер контейнера
 * при инициализации и сам не замечает, что тот стал шире: без resize()
 * половина карты осталась бы серой. Ждём конца перехода, иначе замер попадёт
 * на середину анимации. */
function setCollapsed(on) {
  state.collapsed = on;
  document.body.classList.add("animating");
  document.body.classList.toggle("collapsed", on);
  setTimeout(() => document.body.classList.remove("animating"), 260);
  refreshCollapseBtn();
  try { localStorage.setItem("wf_collapsed", on ? "1" : "0"); } catch {}
  setTimeout(() => {
    map?.resize();
    if (!on) { rowMeasuredNormal = 0; rowMeasuredGap = 0; paintWindow(); }   // ширина другая → перенос строк другой
  }, 210);
}

/* Подпись кнопки зависит и от состояния, и от языка, поэтому её нельзя
 * помечать статическим data-i18n-title: applyLang перетирала бы «развернуть»
 * на «свернуть» при каждой смене языка. Обновляем из одного места. */
/* На телефоне полоса фильтров переносилась в 5-6 рядов и съедала весь экран.
 * Прячем её за кнопкой; на широком экране кнопка не показывается вовсе (CSS). */
function refreshFilterBtn() {
  const b = $("#flt-toggle");
  if (!b) return;
  // Только слово. Ни счётчика, ни подсветки: «Фильтры · 15» распирало шапку,
  // а заливка спорила с вкладками, где она означает «раздел открыт».
  b.textContent = tr("flt");
  b.setAttribute("aria-expanded", String(document.body.classList.contains("flt-open")));
}

function refreshCollapseBtn() {
  const b = $("#collapse");
  if (!b) return;
  b.setAttribute("aria-pressed", String(state.collapsed));
  b.textContent = state.collapsed ? "▣" : "◧";
  b.title = tr(state.collapsed ? "expand_t" : "collapse_t");
  b.setAttribute("aria-label", b.title);
}

/* Тема, которая реально видна на экране: явный выбор (атрибут) важнее системного.
 * Без этого первый клик по кнопке при тёмной ОС не давал эффекта — код считал
 * «сейчас светлая» (атрибута нет), хотя страница уже была тёмной через
 * prefers-color-scheme, и ставил data-theme="dark" поверх уже тёмной темы. */
function currentTheme() {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "dark" || attr === "light") return attr;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function refreshThemeBtn() {
  const b = $("#theme");
  if (!b) return;
  b.setAttribute("aria-pressed", String(currentTheme() === "dark"));
}

/* Пять порогов по осям рейтинга. Поля строим в JS, а не в разметке: подписи
 * приходят из meta.i18n (общий словарь с ботом) и меняются вместе с языком. */
function buildAxisFilters() {
  const box = $("#f-axes").querySelector(".axf-box");
  box.innerHTML = "";

  // Ползунок — видимый, а читает фильтрация прежнее скрытое поле #f-axN:
  // 0 на ползунке = пустое поле = ось не ограничена (иначе «≥ 0» висел бы
  // чипом и в ссылке). Обратно (сброс, ?ax= из ссылки) — syncAxisSliders().
  (state.meta.axes || []).forEach((_, i) => {
    const row = document.createElement("label");
    row.className = "ds-range-row";

    const name = document.createElement("span");
    name.textContent = axisName(i);

    const range = document.createElement("input");
    range.type = "range";
    range.className = "ds-range";
    range.id = `f-axr${i}`;
    range.min = "0"; range.max = "100"; range.step = "5"; range.value = "0";
    range.setAttribute("aria-label", axisName(i));

    const shown = document.createElement("span");
    shown.id = `f-axv${i}`;

    const inp = document.createElement("input");
    inp.type = "number";
    inp.id = `f-ax${i}`;
    inp.hidden = true;

    range.oninput = () => {
      inp.value = range.value === "0" ? "" : range.value;
      shown.textContent = axisShown(range.value);
      debouncedApply();
    };
    row.append(name, range, shown, inp);
    box.appendChild(row);
  });
  syncAxisSliders();
}

const axisShown = (v) => (String(v) === "0" || v === "" ? "—" : `${tr("from")} ${v}`);

/* Скрытые поля → ползунки: после сброса, чтения ссылки, смены языка */
function syncAxisSliders() {
  (state.meta?.axes || []).forEach((_, i) => {
    const inp = $(`#f-ax${i}`), range = $(`#f-axr${i}`), shown = $(`#f-axv${i}`);
    if (!inp || !range) return;
    range.value = inp.value === "" ? "0" : inp.value;
    shown.textContent = axisShown(inp.value);
  });
  const t = $("#f-tmax"), wr = $("#work-range");
  if (t && wr) {
    if (t.value !== "") wr.value = t.value;
    $("#work-range-val").textContent = `${wr.value} ${tr("min")}`;
  }
}

const axIds = () => (state.meta.axes || []).map((_, i) => `#f-ax${i}`);

/* Район: чекбоксы вместо <select multiple size="1"> (аудит 2026-09-22 —
 * множественный выбор в нативном select почти никто не понимает без
 * зажатого Ctrl/Cmd). Названия районов не переводятся (топонимы), поэтому
 * список строится один раз и не пересобирается при смене языка. */
function buildDistrictFilters() {
  const box = $("#f-district");
  box.innerHTML = "";
  (state.meta.districts || []).forEach((d) => {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = d;
    cb.checked = state.districts.has(d);
    cb.onchange = () => {
      cb.checked ? state.districts.add(d) : state.districts.delete(d);
      apply();
    };
    const span = document.createElement("span");
    span.textContent = d;
    label.appendChild(cb);
    label.appendChild(span);
    box.appendChild(label);
  });
}

const val = (id) => { const v = $(id).value; return v === "" ? null : +v; };

/* Есть ли вообще данные о времени в пути. В публичной сборке их нет (адрес не
 * выгружается), и фильтр по ним обнулил бы выдачу — в том числе по ссылке с
 * ?commute=30, где поле спрятано и человек не понял бы, почему пусто. */
const hasCommute = () =>
  !!state.layers?.tt && Object.keys(state.layers.tt).length > 0;

/* ── Синхронизация фильтров с URL ────────────────────────────────────────────
 * Имена параметров — контракт со старой картой и ботом (_filter_to_query
 * в 4.bot/notifier.py). Менять их нельзя: по этим ссылкам ходят подписчики.
 * Осторожно с асимметрией — она историческая, но живая:
 *   price     = МАКСИМУМ цены, в ТЫСЯЧАХ;  price_min — минимум, тоже в тысячах
 *   area      = МИНИМУМ площади;           area_max  — максимум
 *   score/year = МИНИМУМ;                  score_max/year_max — максимум
 * commute — наш новый параметр, в старой карте его нет. */
const URL_NUM_BASE = [
  ["price_min", "#f-pmin"], ["price",     "#f-pmax"],
  ["area",      "#f-amin"], ["area_max",  "#f-amax"],
  ["score",     "#f-smin"], ["score_max", "#f-smax"],
  ["year",      "#f-ymin"], ["year_max",  "#f-ymax"],
  ["commute",   "#f-tmax"],
];
/* ax0..axN — позиционные, как ax_0..ax_N в БД и порядок SCORE_AXES. Строим по
 * реальному числу осей из meta (axIds()), а не хардкодим 0..4: добавят ось —
 * ссылки бота и адресная строка сами подхватят новый параметр. */
const urlNumAll = () => [...URL_NUM_BASE, ...axIds().map((id, i) => [`ax${i}`, id])];
const URL_SET = [["rooms", "rooms"], ["mt", "market"], ["ut", "seller"], ["cs", "cond"]];

/* Последний поиск (13.10.2026): app.html без фильтров в адресе (логотип,
 * главная, закладка, вкладка, которую браузер перезагрузил) открывался пустым,
 * и свой поиск приходилось заново выбирать в профиле. Теперь фильтры из адреса
 * запоминаются в этом браузере (syncUrl), а адрес без фильтров их подставляет.
 * «Сбросить всё» тоже запоминается — пустой поиск остаётся пустым. */
const LAST_Q = "wf_last_q";
function hasFilterParams(q) {
  return [...urlNumAll().map(([k]) => k), ...URL_SET.map(([k]) => k), "district", "view"].some((k) => q.has(k));
}

function readUrl() {
  const q = new URLSearchParams(location.search);
  /* Источник правды — только адрес (13.10.2026). Браузер при «Назад» и при
   * перезагрузке выгруженной вкладки сам возвращает значения в поля — и кладёт
   * их не туда: поля без имён, часть переезжает между попапами и панелью.
   * Так «площадь от 55» становилась ещё и «площадь до 55» и «год 55–55» —
   * 0 квартир, а фильтр выглядел пропавшим. Сначала чистим, потом читаем. */
  urlNumAll().forEach(([, id]) => { const el = $(id); if (el) el.value = ""; });
  $("#f-district")?.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
  if (!hasFilterParams(q)) {
    try {
      new URLSearchParams(localStorage.getItem(LAST_Q) || "").forEach((v, k) => { if (!q.has(k)) q.set(k, v); });
    } catch {}
  }
  urlNumAll().forEach(([k, id]) => { if (q.get(k)) $(id).value = q.get(k); });

  URL_SET.forEach(([k, name]) => {
    (q.get(k) || "").split(",").filter(Boolean).forEach((v) => {
      state[name].add(v);
      // кнопка есть не всегда: район из ссылки может отсутствовать в выдаче дня
      chipBtns[name]?.[v]?.setAttribute("aria-pressed", "true");
    });
  });

  // ?hide=… — чёрный список из бота: вливаем в локальный и сохраняем (параметр из адреса
  // пропадёт при первой же перезаписи строки запроса)
  const fromBot = (q.get("hide") || "").split(",").filter(Boolean);
  if (fromBot.length) { fromBot.forEach((k) => state.hidden.add(k)); saveHidden(); }

  // ?fav=… — избранное из бота: та же схема, что и ?hide= выше
  const favFromBot = (q.get("fav") || "").split(",").filter(Boolean);
  if (favFromBot.length) { favFromBot.forEach((k) => state.favorites.add(k)); saveFavorites(); }

  // ?sort=… — если стоит в самой ссылке (например, юзер поделился ей), она
  // главнее того, что лежит в localStorage этого браузера — как и остальные
  // фильтры выше.
  const wantQ = (q.get("want") || "").split(",").filter((c) => c in WANT_CODES);
  if (wantQ.length) { state.want = wantQ; saveWant(); }

  const sortQ = q.get("sort");
  if (sortQ && _SORT_VALUES.has(sortQ)) { state.sort = sortQ; $("#sort").value = sortQ; fitSort(); }

  // ?view=fav|hidden — глубокая ссылка из меню профиля новых страниц
  // (homepage/market/valuate/list-apartment, см. site-ui.js::initProfile):
  // там своего списка квартир нет, пункты меню просто ведут сюда с этим
  // параметром, чтобы открыть нужный фильтр сразу, а не на пустом app.html.
  const view = q.get("view");
  if (view === "fav") state.onlyFav = true;
  else if (view === "hidden") state.showHidden = true;

  const distBox = $("#f-district");
  (q.get("district") || "").split(",").filter(Boolean).forEach((d) => {
    state.districts.add(d);
    // чекбокс есть не всегда: район из ссылки может отсутствовать в выдаче дня
    const cb = [...distBox.querySelectorAll('input[type="checkbox"]')].find((c) => c.value === d);
    if (cb) cb.checked = true;
  });
}

/* Только фильтры поиска (без сортировки, «Важно для меня», языка): их же
 * кнопка «Уведомлять» отдаёт боту (bot_filters.py на сервере). */
function filterParams() {
  const p = new URLSearchParams();
  urlNumAll().forEach(([k, id]) => { if ($(id).value !== "") p.set(k, $(id).value); });
  URL_SET.forEach(([k, name]) => { if (state[name].size) p.set(k, [...state[name]].join(",")); });
  if (state.districts.size) p.set("district", [...state.districts].join(","));
  return p;
}

function syncUrl() {
  const p = filterParams();
  if (state.sort !== "p") p.set("sort", state.sort);   // "p" — дефолт, не засоряем ссылку
  if (state.want.length) p.set("want", state.want.join(","));

  // Токен изохрон и язык переживают перезапись: они не фильтры, но теряются,
  // если просто затереть строку запроса. "v" — одноразовый анти-кеш из кнопки
  // «Обновить» (location.replace) — он своё дело уже сделал при переходе и не
  // должен навсегда оседать в адресе, поэтому его НЕ переносим дальше.
  const cur = new URLSearchParams(location.search);
  // t — токен профиля: в адресе он живёт только во встроенном браузере Telegram
  // (site-ui.js::profileToken), чтобы «Открыть в браузере» перенесло вход
  ["iso", "lang", "t", "report"].forEach((k) => { if (cur.get(k)) p.set(k, cur.get(k)); });

  // «Избранное»/«Скрытые» (?view=) — не поиск: запомненный поиск не затираем
  if (!state.onlyFav && !state.showHidden) {
    try { localStorage.setItem(LAST_Q, filterParams().toString()); } catch {}
  }

  const qs = p.toString();
  // replaceState, а не push: фильтры не должны засорять историю «Назад»
  history.replaceState(null, "", qs ? `?${qs}` : location.pathname);
}

/* Сброс всех фильтров — общий для «Сбросить всё» в компактной строке и
 * «Сброс» в подвале полной панели (см. buildFilters): та же логика, два
 * пути к ней, а не два разных обработчика с расходящимся поведением. */
function resetAll() {
  document.querySelectorAll(".chip").forEach((c) => c.setAttribute("aria-pressed", "false"));
  state.rooms.clear(); state.market.clear(); state.districts.clear();
  state.seller.clear(); state.cond.clear();
  $("#f-district").querySelectorAll('input[type="checkbox"]').forEach((cb) => (cb.checked = false));
  ["#f-pmin", "#f-pmax", "#f-amin", "#f-amax", "#f-smin", "#f-tmax",
   "#f-ymin", "#f-ymax", "#f-smax", ...axIds()].forEach((id) => ($(id).value = ""));
  if (state.near) linesClearAll();
  state.showHidden = false;
  state.onlyFav = false;
  apply();
}

/** Единственное место, где решается «что показывать». Фильтр по полю с
 *  отсутствующим значением исключает квартиру — как в боте: активный
 *  фильтр не должен пропускать то, про что мы ничего не знаем. */
// На телефоне «1 957 из 1 957» съедало 100 px шапки — там показываем одно число.
// Раньше решалось только внутри apply() — при изменении фильтров, но не при
// изменении САМОЙ ширины окна (ресайз/поворот экрана без смены фильтров
// оставлял формат счётчика от предыдущей ширины, аудит веб-«мелкое и мёртвое»).
function refreshCount() {
  $("#count").textContent = window.innerWidth <= 700
    ? nf.format(state.shown.length)
    : tr("shown_of")(nf.format(state.shown.length), nf.format(state.all.length));
  fitCountHidden();
}

function apply(resetScroll = true) {
  const pmin = val("#f-pmin"), pmax = val("#f-pmax");
  const amin = val("#f-amin"), amax = val("#f-amax");
  const smin = val("#f-smin"), smax = val("#f-smax");
  const tmax = val("#f-tmax");   // минут пешком+транспортом до личного адреса
  const ymin = val("#f-ymin"), ymax = val("#f-ymax");
  // пороги по осям: null = ось не ограничена
  const axMin = axIds().map(val);

  state.base = state.all.filter((a) => {
    // Чёрный список: показываем либо только не скрытые, либо (режим «Скрытые») только скрытые
    if (state.showHidden !== state.hidden.has(hideKey(a))) return false;
    // Избранное — независимый ДОПОЛНИТЕЛЬНЫЙ фильтр, а не режим просмотра: ничего
    // не исключает само по себе, кроме случая, когда явно включена галочка «только избранное»
    if (state.onlyFav && !state.favorites.has(favKey(a))) return false;
    // «Избранное» и «Скрытые» показывают ВСЁ своё, без фильтров поиска (17.10.2026:
    // иначе в меню 15 избранных, а в списке 14 — одна не подходила под комнаты)
    if (state.onlyFav || state.showHidden) return true;
    if (pmin != null && !(a.p != null && a.p >= pmin * 1000)) return false;
    if (pmax != null && !(a.p != null && a.p <= pmax * 1000)) return false;
    if (amin != null && !(a.a != null && a.a >= amin)) return false;
    if (amax != null && !(a.a != null && a.a <= amax)) return false;
    if (smin != null && !(a.sc != null && a.sc >= smin)) return false;
    if (smax != null && !(a.sc != null && a.sc <= smax)) return false;
    // дорога до дома: те же минуты, по которым строятся зоны 15/30/45 на карте
    if (tmax != null && hasCommute()) {
      const t = commute(a.id);
      if (t == null || t > tmax) return false;
    }
    if (state.rooms.size && !(a.r != null && matchRooms(a.r))) return false;
    if (ymin != null && !(a.by != null && a.by >= ymin)) return false;
    if (ymax != null && !(a.by != null && a.by <= ymax)) return false;
    // Ось без значения не проходит активный порог — как и все прочие поля:
    // фильтруешь по зелени, квартиры без оценки зелени скрываются
    for (let i = 0; i < axMin.length; i++) {
      if (axMin[i] == null) continue;
      if (!(a.ax?.[i] != null && a.ax[i] >= axMin[i])) return false;
    }
    if (state.market.size && !state.market.has(a.mt)) return false;
    if (state.seller.size && !state.seller.has(a.ut)) return false;
    if (state.cond.size && !state.cond.has(a.cs)) return false;
    if (state.districts.size && !state.districts.has(a.d)) return false;
    return true;
  });
  // «Рядом с остановкой» — отдельно от базы: число квартир в попапе остановки считается
  // по base, иначе включённый фильтр обнулял бы собственный счётчик
  state.shown = state.near ? state.base.filter((a) => nearOk(a, state.near)) : state.base;
  hiddenTagRefresh();
  favTagRefresh();

  const key = state.sort.replace("-", ""), desc = state.sort.startsWith("-");
  // «Важно для меня»: сначала те, где есть отмеченное (первое — важнее всех
  // следующих вместе: веса 2^n), внутри — выбранная сортировка
  const wantW = (a) => {
    if (!state.want.length) return 0;
    const n = state.want.length;
    return state.want.reduce((w, c, i) => w + (wantHas(a, c) ? 2 ** (n - i) : 0), 0);
  };
  state.shown.sort((x, y) => {
    const dw = wantW(y) - wantW(x);
    if (dw) return dw;
    const a = x[key], b = y[key];
    if (a == null && b == null) return 0;
    if (a == null) return 1;            // нет данных — всегда в конец
    if (b == null) return -1;
    if (a === b) return 0;
    return desc ? (a < b ? 1 : -1) : (a > b ? 1 : -1);
  });

  // Доля gap-note карточек могла смениться вместе с самим фильтром (см.
  // computeRowH) — пересчитываем ДО renderList(), иначе первый кадр после
  // смены фильтра рисуется по устаревшему весу.
  computeRowH();
  refreshCount();
  /* Отложенная для сравнения квартира могла выпасть из выдачи новым фильтром —
   * иначе кнопки продолжали бы звать «Сравнить с уже выбранной» тем, чего не
   * видно, а открыть сравнение можно было бы с квартирой мимо текущих фильтров.
   * Гасим ДО renderList(), чтобы кнопки в перерисованных карточках это учли. */
  if (state.cmpId && !state.shown.some((a) => a.id === state.cmpId)) {
    state.cmpId = null;
  }
  renderList(resetScroll);
  /* Выбранная квартира могла выпасть из выдачи новым фильтром. Её карточка
   * висела бы поверх списка, в котором её уже нет, и маркера на карте тоже —
   * а activeId продолжал бы жить и подсвечивать её при возврате фильтра.
   * Состояние не должно переживать то, что его породило. */
  if (state.activeId && !state.activeArch && !state.shown.some((a) => a.id === state.activeId)) {
    state.activeId = null;
    hideSheetOnly();   // не closeSheet(): это автоматическое закрытие фильтром,
                        // а не действие человека — фокус трогать не нужно (он
                        // может в этот момент печатать в поле фильтра)
  }

  renderMarkers();
  refreshFilterBtn();
  refreshPillLabels();
  buildActiveChips();
  $("#panel-apply").textContent = tr("flt_show")(state.shown.length);
  syncUrl();
  refreshNotify();
}

const matchRooms = (r) => [...state.rooms].some((v) => (v === "5" ? r >= 5 : r === +v));

// ── Список ──────────────────────────────────────────────────────────────────
/* Шкалы рейтинга. withScore=true добавляет ПЕРВОЙ строкой общий рейтинг —
 * в списке иначе видно только оси, а итогового числа нет. В карточке объекта
 * он не нужен: там рейтинг и так написан цифрой над шкалами.
 *
 * Общая шкала — та же величина (0-100) и тот же цвет, отличается подписью и
 * разделителем: это сумма осей, а не шестая ось. */
function axesHtml(a, withScore = false, inCard = false) {
  if (!a.ax || a.ax.every((v) => v == null)) return "";

  // название оси — кнопкой-подсказкой (site-ui.js: data-rh-axis → окно «Как считается»)
  const bar = (name, v, cls = "", i = null) =>
    `<span class="ax-name ${cls}"${i != null ? ` data-rh-axis="${i}"${inCard ? "" : ` role="button" tabindex="0"`}` : ""}>${name}</span>
     <span class="ax-track ${cls}"><span class="ax-fill" style="width:${v}%"></span></span>
     <span class="ax-val ${cls}">${v}</span>`;

  const head = (withScore && a.sc != null
    ? bar(esc(tr("f_score")) + rateHelpBtn(inCard), Math.round(a.sc), "ax-total") : "");

  // подпись оси — из meta.i18n (словарь бота), не из локального словаря
  const rows = state.meta.axes.map((_, i) => {
    const v = a.ax[i];
    return v == null ? "" : bar(esc(axisName(i)), v, "", i);
  }).join("");

  return `<div class="axes">${head}${rows}</div>`;
}

// «Оценки по осям» — строка сводки: лучшая и худшая ось в свёрнутом виде,
// шкалы и оговорки (размытый пин, пробелы данных) — по раскрытию
function axesBoxHtml(a) {
  const ax = axesHtml(a, true);       // первой строкой — общий рейтинг, как в списке
  if (!ax) return "";
  const vals = a.ax.map((v, i) => [v, i]).filter(([v]) => v != null);
  const best = vals.reduce((m, x) => (x[0] > m[0] ? x : m)), worst = vals.reduce((m, x) => (x[0] < m[0] ? x : m));
  return `<details class="srow fold axes-row" data-fold="ax"${foldOpen("ax") ? " open" : ""}>
    <summary><span class="ds-section-label">${tr("ax_box")}</span>
      <span class="fold-sum">${a.sc != null ? `<b>${Math.round(a.sc)}/100</b> · ` : ""}${tr("ax_sum")(esc(axisName(best[1])), best[0], esc(axisName(worst[1])), worst[0])}</span></summary>
    <div class="fold-body">${ax}
      ${a.blur >= 100 ? `<div class="gap-note">${tr("blur")(a.blur)}</div>` : ""}
      ${a.gap ? `<div class="gap-note">${tr("gaps")(a.gap)}</div>` : ""}</div></details>`;
}

/* Дешевле/дороже: к похожим объявлениям (fp) и к сделкам RCN рядом (dp, 18.10.2026).
 * Показываем от 1% (юзер: «на 1,5 млн каждый процент на счету для торга»; меньше
 * 1% — не показывать). Знак и слово обязательны: цвет один смысла не несёт;
 * до 5% — приглушённым цветом (в пределах обычного разброса). */
function fairHtml(a) {
  const part = (v, cheapK, pricierK, title) => {
    if (v == null || Math.abs(v) < 1) return "";
    const cheap = v < 0, av = Math.abs(v);
    return `<span class="fair ${cheap ? "good" : "bad"}${av < 5 ? " soft" : ""}"${title ? ` title="${esc(title)}"` : ""}>${cheap ? "▼" : "▲"} ${Math.round(av)}% ${tr(cheap ? cheapK : pricierK)}</span>`;
  };
  return [part(a.fp, "cheaper", "pricier"),
          part(a.dl, "cheaper_deals", "pricier_deals", a.dln ? tr("deals_n")(a.dln) : "")]
    .filter(Boolean).join('<span class="sep"> · </span>');
}

/* ── «Важно для меня» ─────────────────────────────────────────────────────────
 * Коды — как в export.py::_AMEN_CODE (удобства из Otodom target.Extras_types). */
const WANT_CODES = { g: 1, l: 1, u: 1, b: 1, t: 1, ac: 1, gr: 1, n2: 1, na: 1, vi: 1, nt: 1 };
/* «Посещённая» / «Есть заметка» (17.10.2026) — отметки самого юзера, не объявления:
 * всегда известны, тег — только ✓ (✗ «Не посещённая» стоял бы почти у всех) */
const WANT_SELF = { vi: 1, nt: 1 };
/* «Без двух уровней» / «Без мансарды» (01.10.2026) — по признакам из текста
 * объявления (a.tx, export.py → textflags.py), а не по списку удобств a.ex */
const WANT_TX = { n2: "2l", na: "at" };

/* Есть ли у квартиры отмеченное: true / false / null — неизвестно (в
 * объявлении нет списка удобств): «неизвестно» не значит «нет» */
function wantHas(a, c) {
  if (c === "vi") return isVisited(a);
  if (c === "nt") return !!noteOf(a);
  if (c in WANT_TX) return a.tx ? !a.tx.includes(WANT_TX[c]) : null;
  return a.ex ? a.ex.includes(c) : null;
}

function loadWant() {
  try {
    const v = JSON.parse(localStorage.getItem("wf_want") || "[]");
    if (Array.isArray(v)) state.want = v.filter((c) => c in WANT_CODES);
  } catch {}
}
function saveWant() {
  try {
    localStorage.setItem("wf_want", JSON.stringify(state.want));
    localStorage.setItem("wf_want_at", String(Date.now()));
  } catch {}
  saveWantRemote();
}

/* «Важно для меня» при входе живёт и в профиле (prefs.want) — бот ставит теги
 * ✓/✗ под квартирами в уведомлениях. Слияние браузера и профиля — по времени
 * правки (wf_want_at / prefs.want_at): берётся более свежий выбор. */
function wantAt() { try { return +localStorage.getItem("wf_want_at") || 0; } catch { return 0; } }

async function saveWantRemote() {
  const tok = profileToken();
  if (!tok || !state.profilePrefs) return;
  const prefs = { ...state.profilePrefs, want: state.want, want_at: wantAt() || Date.now() };
  delete prefs.work;
  try {
    const r = await fetch(`${API_BASE}/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Profile-Token": tok },
      body: JSON.stringify({ prefs }),
    });
    if (r.ok) state.profilePrefs = (await r.json()).prefs;
  } catch {}
}

function mergeWant(prefs) {
  const remoteAt = prefs?.want_at || 0, localAt = wantAt();
  if (Array.isArray(prefs?.want) && remoteAt > localAt) {
    state.want = prefs.want.filter((c) => c in WANT_CODES);
    try {
      localStorage.setItem("wf_want", JSON.stringify(state.want));
      localStorage.setItem("wf_want_at", String(remoteAt));
    } catch {}
    buildWant(); apply(false);
  } else if (localAt > remoteAt) {
    saveWantRemote();
  }
}

function buildWant() {
  const host = $("#want-chips");
  if (!host) return;
  host.textContent = "";
  Object.keys(WANT_CODES).forEach((c) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ds-chip";   // не .chip: «Сбросить всё» сбрасывает фильтры, а это не фильтр
    const i = state.want.indexOf(c);
    b.textContent = i >= 0 ? `${i + 1}. ${tr("wa")[c]}` : tr("wa")[c];
    b.setAttribute("aria-pressed", String(i >= 0));
    b.onclick = () => {
      const k = state.want.indexOf(c);
      if (k >= 0) state.want.splice(k, 1); else state.want.push(c);
      saveWant();
      buildWant();
      // на карточках появилась/исчезла строка тегов — высоту строк меряем заново
      rowMeasuredNormal = 0; rowMeasuredGap = 0;
      apply();
    };
    host.appendChild(b);
  });
  $("#want-note").textContent = tr(state.want.length ? "want_on" : "want_off");
  $("#want-sum").textContent = state.want.length
    ? state.want.map((c) => tr("wa")[c].toLowerCase()).join(", ") : tr("want_none");
  const t = $("#want-toggle");
  if (t && !t.onclick) {
    t.onclick = () => {
      const open = t.getAttribute("aria-expanded") !== "true";
      t.setAttribute("aria-expanded", String(open));
      $("#want-body").hidden = !open;
    };
  }
}

/* Теги совпадений: ✓ есть / ✗ нет — по отмеченному в «Важно для меня».
 * Нет списка удобств в объявлении — ничего: «неизвестно» не значит «нет». */
function wantTagsHtml(a) {
  const tags = state.want.map((c) => {
    const yes = wantHas(a, c);
    // «без …»: ✓ «Без мансарды» стояло бы у 95% квартир — показываем только ✗
    if (yes == null || (yes && c in WANT_TX) || (!yes && c in WANT_SELF)) return "";
    const label = yes ? tr("wa")[c] : (tr("wa_no")[c] ?? tr("wa")[c]);   // ✗ у «без …» — «✗ Мансарда»
    return `<span class="ds-tag ${yes ? "ds-tag--yes" : "ds-tag--no"}">${yes ? "✓" : "✗"} ${esc(label)}</span>`;
  }).join("");
  return tags ? `<div class="card-tags">${tags}</div>` : "";
}

function cardHtml(a) {
  const arch = !!a.off;   // снятая — только в строке внизу «Избранного» (favArchHtml)
  const loc = [a.d, a.st].filter(Boolean).join(", ") || "—";
  const sub = [
    `${num(a.a, " " + tr("m2"))}`,
    `${a.r ?? "?"} ${tr("rooms_s")}`,
    a.by ? `${a.by} ${tr("yr")}` : null,
    a.ppm ? `${nf.format(Math.round(a.ppm))} ${tr("ppm_u")}` : null,
    a.wm != null ? `${tr("metro_s")} ${a.wm} ${tr("min")}` : null,
    ...state.places.map((pl, i) => {
      const m = state.placeTimes[i]?.[a.id];
      const ic = modeIcons(placeModes(i, a.id));
      const w = state.placeWalk[i]?.[a.id];
      // пешая часть до остановки — рядом со значками (19.10.2026): «54 мин ▣Ⓜ · 🚶15»
      const walk = w != null && w >= 5 ? ` <span class="mode-walk" title="${esc(tr("walk_to_stop")(w))}">${MODE_SVG.w}${w}</span>` : "";
      return m != null ? `${esc(pl.name)} ${m} ${tr("min")}${ic ? ` <span class="mode-ic" title="${esc(modeWords(placeModes(i, a.id)))}">${ic}${walk}</span>` : ""}${i === 0 ? rateHelpBtn(true, "commute") : ""}` : null;
    }),
  ].filter(Boolean).join(' <span class="sep">·</span> ');

  return `<article class="card" data-id="${esc(a.id)}" tabindex="0" role="button"
      ${a.id === state.activeId ? 'data-active="1"' : ""}>
    <div class="card-head">
      <span class="loc">${esc(loc)}</span>
      ${arch ? "" : `<button class="cmp-btn card-cmp" data-cmp="${esc(a.id)}"
              aria-pressed="${state.cmpId === a.id}">${
        esc(tr(state.cmpId === a.id ? "cmp_drop"
             : state.cmpId ? "cmp_with" : "cmp_pick"))}</button>`}
      <button class="fav-btn card-fav" data-fav="${esc(a.id)}" title="${esc(tr(state.favorites.has(favKey(a)) ? "unfav_t" : "fav_t"))}"
              aria-label="${esc(tr(state.favorites.has(favKey(a)) ? "unfav" : "fav"))}">${state.favorites.has(favKey(a)) ? "✓" : "⭐"}</button>
      <button class="hide-btn card-hide" data-hide="${esc(a.id)}" title="${esc(tr(state.showHidden ? "unhide_t" : "hide_t"))}"
              aria-label="${esc(tr(state.showHidden ? "unhide" : "hide"))}">${state.showHidden ? "↩" : "🚫"}</button>
      <span class="price${arch ? " price--arch" : ""}">${money(a.p)}</span>
    </div>
    <div class="card-sub">${arch ? archTagHtml(tr("arch_tag_s")(fmtDate(a.off).slice(0, 5))) : ""}${sub} ${fairHtml(a)}</div>
    ${dupNote(a)}
    ${wantTagsHtml(a)}
    ${axesHtml(a, true, true)}
    ${a.gap ? `<div class="gap-note">${tr("gap_card")(a.gap)}</div>` : ""}
  </article>`;
}

/* Виртуализация: в DOM живут только карточки видимого окна плюс запас.
 * 2000 карточек × ~20 узлов = 40 000 элементов — браузер начинает заикаться на
 * прокрутке и фильтрации. Держим ~40 и подменяем их при скролле; общая высота
 * задаётся распорками сверху и снизу, поэтому полоса прокрутки честная. */
/* Высоту строки НЕ хардкодим: она зависит от шрифта, масштаба страницы и от
 * того, есть ли у карточки примечание о неполных данных (у 18% есть, они
 * заметно выше обычных — ~186px против ~132px).
 *
 * Раньше был ОДИН средний rowH, намеренный по локально видимым карточкам —
 * если в окне видимости в этот момент оказывалось больше или меньше
 * gap-note-карточек, чем в среднем по всей выдаче, оценка съезжала и
 * scrollTop/распорки чуть расходились с реальной высотой контента —
 * скроллбар слегка подрагивал при быстрой прокрутке длинного списка (аудит
 * «мелкое и мёртвое», веб-2). Тут не полноценная per-row-виртуализация
 * (это отдельный, более крупный рефакторинг), а дешёвое улучшение оценки:
 * меряем ДВЕ высоты по факту (обычная/с примечанием) и взвешиваем их по
 * РЕАЛЬНОЙ доле gap-note-карточек в текущей выдаче (computeRowH, зовётся
 * из apply() при каждом изменении фильтров) — вместо доли в случайном
 * окне из ~20 видимых карточек. */
let rowHNormal = 132, rowHGap = 186;
let rowMeasuredNormal = 0, rowMeasuredGap = 0;   // сколько раз уточняли каждую — страховка от зацикливания
let rowH = rowHNormal;      // производная: пересчитывается computeRowH(), см. там
const OVERSCAN = 6;         // запас сверху/снизу, чтобы не мигало при быстрой прокрутке

/* rowH = средневзвешенное rowHNormal/rowHGap по ФАКТИЧЕСКОЙ доле gap-note
 * карточек в текущей выдаче (state.shown) — не в произвольном окне видимости. */
function computeRowH() {
  const total = state.shown.length;
  if (!total) return;
  let nGap = 0;
  for (const a of state.shown) if (a.gap) nGap++;
  rowH = (((total - nGap) * rowHNormal) + (nGap * rowHGap)) / total;
}

/* Уточняет rowHNormal/rowHGap по факту отрисованных карточек. Шаг между
 * соседними offsetTop относим к ТОЙ карточке, что выше (её содержимое и
 * margin-bottom формируют этот шаг), а не усредняем всё окно одним числом —
 * так обычные и gap-note карточки не портят оценку друг друга. */
function measureRow(host) {
  if (rowMeasuredNormal > 3 && rowMeasuredGap > 3) return false;
  const cards = host.querySelectorAll(":scope > .card");
  if (cards.length < 2) return false;
  let changed = false;
  for (let i = 0; i < cards.length - 1; i++) {
    const step = cards[i + 1].offsetTop - cards[i].offsetTop;
    if (!(step > 20)) continue;
    const isGap = !!cards[i].querySelector(".gap-note");
    if (isGap && rowMeasuredGap <= 3 && Math.abs(step - rowHGap) > 2) {
      rowHGap = step; rowMeasuredGap++; changed = true;
    } else if (!isGap && rowMeasuredNormal <= 3 && Math.abs(step - rowHNormal) > 2) {
      rowHNormal = step; rowMeasuredNormal++; changed = true;
    }
  }
  if (changed) computeRowH();
  return changed;
}

function renderList(resetScroll = true) {
  const host = $("#list");
  if (!state.shown.length) {
    host.innerHTML = `<p class="empty">${tr("empty_h")}</p>` + favArchHtml();
    bindFavArch(host);
    return;
  }
  if (!host.dataset.virt) {
    host.dataset.virt = "1";
    host.addEventListener("scroll", () => paintWindow(), { passive: true });
  }
  if (resetScroll) {
    host.scrollTop = 0;
  } else {
    // Переключатель «Избранное»/«Скрытые» в меню профиля НЕ должен подбрасывать
    // список наверх — юзер мог быть глубоко проскроллен и просто хочет
    // взглянуть, что уже отмечено (юзер 2026-09-26: «список слева не должен
    // прыгать вверх»). Но список мог стать КОРОЧЕ нового набора — если
    // scrollTop оставить как есть, окно виртуализации уедет за реальный
    // контент и покажет пустоту, неотличимую от «ничего не найдено».
    // Клампим к последней валидной позиции вместо взгляда в пустоту.
    const maxScroll = Math.max(0, state.shown.length * rowH - host.clientHeight);
    if (host.scrollTop > maxScroll) host.scrollTop = maxScroll;
  }
  paintWindow();
}

/* «Избранное»: в списке только то, что продаётся; снятые из избранного —
 * свёрнутой строкой в самом низу (решение юзера 01.10.2026: список чистый,
 * но ничего не пропадает молча). Раскрыта ли — state.favArchOpen: окно
 * виртуализации пересобирает #list на каждый скролл. */
function favArchList() {
  if (!state.onlyFav || state.showHidden) return [];
  if (!remData) { loadRemoved().then(() => renderList(false)); return []; }
  return [...archIndex().values()]
    .filter((a) => state.favorites.has(favKey(a)))
    .sort((x, y) => (y.off || "").localeCompare(x.off || ""));
}

function favArchHtml() {
  const list = favArchList();
  if (!list.length) return "";
  return `<details class="fav-arch"${state.favArchOpen ? " open" : ""}>
    <summary class="ds-pill fav-arch__sum">${esc(tr("arch_fav")(list.length))}</summary>
    ${state.favArchOpen ? list.map(cardHtml).join("") : ""}
  </details>`;
}

/* Строка снятых внизу «Избранного»: раскрытие и клики по их карточкам
 * (открыть карточку, убрать из избранного, скрыть) */
function bindFavArch(host) {
  const fa = host.querySelector(".fav-arch");
  if (!fa) return;
  fa.ontoggle = () => { if (fa.open !== state.favArchOpen) { state.favArchOpen = fa.open; renderList(false); } };
  fa.querySelectorAll(".card").forEach((el) => {
    const open = () => { sheetOpenerId = null; openArch(el.dataset.id); };
    el.onclick = (e) => {
      const h = e.target.closest?.(".card-hide");
      if (h) { e.stopPropagation(); return toggleHide(h.dataset.hide); }
      const fv = e.target.closest?.(".card-fav");
      if (fv) { e.stopPropagation(); return toggleFavorite(fv.dataset.fav); }
      open();
    };
    el.onkeydown = (e) => {
      if (e.target === el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(); }
    };
  });
}

function paintWindow() {
  const host = $("#list");
  const total = state.shown.length;
  // renderList() уже показал сообщение «Ничего не найдено» — не затираем его
  // распорками пустого окна на каждый скролл/вкладку/сворачивание списка
  if (total === 0) return;
  const first = Math.max(0, Math.floor(host.scrollTop / rowH) - OVERSCAN);
  const fit = Math.ceil(host.clientHeight / rowH) + OVERSCAN * 2;
  const last = Math.min(total, first + fit);

  const padTop = first * rowH;
  const padBottom = Math.max(0, (total - last) * rowH);
  // innerHTML на скроллящемся контейнере на миг опустошает его (scrollHeight
  // падает до 0) и браузер сам клампит scrollTop к 0 — ниже возвращаем как было.
  // Иначе действия, которые НЕ должны листать список (кнопка «Сравнить» и т.п.,
  // они и так не трогают host.scrollTop сами), всё равно подбрасывали бы его
  // наверх этим побочным эффектом перерисовки.
  const keepScroll = host.scrollTop;
  host.innerHTML =
    `<div style="height:${padTop}px;flex:none"></div>` +
    state.shown.slice(first, last).map(cardHtml).join("") +
    `<div style="height:${padBottom}px;flex:none"></div>` + favArchHtml();
  host.scrollTop = keepScroll;
  bindFavArch(host);

  // Опекуна фокуса (куда вернуть фокус при закрытии шторки) ставим ЗДЕСЬ —
  // ДО любого вызова select()/pickCompare(), которые сами дёргают paintWindow()
  // и этим рвут фокус на исходном элементе (innerHTML пересобирает DOM). Если
  // сохранить document.activeElement уже ПОСЛЕ этой перерисовки — там будет body.
  const captureOpener = (el) => { if ($("#sheet").hidden) sheetOpenerId = el.dataset.id; };

  host.querySelectorAll(":scope > .card").forEach((el) => {
    el.onclick = (e) => {
      // Кнопка сравнения внутри карточки: не даём клику всплыть и открыть шторку
      const c = e.target.closest?.(".card-cmp");
      if (c) { e.stopPropagation(); captureOpener(el); return pickCompare(c.dataset.cmp); }
      const h = e.target.closest?.(".card-hide");
      if (h) { e.stopPropagation(); return toggleHide(h.dataset.hide); }
      const fv = e.target.closest?.(".card-fav");
      if (fv) { e.stopPropagation(); return toggleFavorite(fv.dataset.fav); }
      captureOpener(el);
      select(el.dataset.id, true);
    };
    // Клавиатура: карточка — тоже кнопка (role="button" tabindex="0" в cardHtml).
    // e.target !== el — чтобы Enter/Space на вложенных «Сравнить»/«Скрыть»
    // (у них есть родной click от Enter/Space) не открывали ЕЩЁ и карточку
    el.onkeydown = (e) => {
      if (e.target !== el) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        captureOpener(el);
        select(el.dataset.id, true);
      }
    };
  });

  // Первая отрисовка даёт настоящую высоту — перерисовываем с ней один раз
  if (measureRow(host)) paintWindow();
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/* Ссылки из данных (Otodom) пускаем в href только если это http(s).
 * esc() экранирует кавычки, но не схему: `javascript:…` прошёл бы как есть, и
 * достаточно одного такого поля во внешнем источнике, чтобы получить XSS
 * на публичной странице. */
const safeUrl = (u) => (/^https?:\/\//i.test(String(u ?? "")) ? String(u) : "#");

/* ── Чёрный список и повторы объявлений ───────────────────────────────────────
 * Агентства размножают одно и то же объявление (2.scoring… 1.scraper/db.py, mark_offer_duplicates):
 * видимой остаётся одна карточка, остальные лежат в её поле dp. Скрыть квартиру
 * значит скрыть ГРУППУ: ключ — a.g (общий для всех повторов), а не id карточки, иначе
 * при смене «главной» скрытая квартира вернулась бы в выдачу под другим номером.
 * Список живёт в localStorage этого браузера; из бота он приезжает параметром ?hide=. */
const hideKey = (a) => a.g || a.id;

/* Счётчик на кнопке профиля раньше показывал state.hidden.size/state.favorites.size
 * напрямую — сырое число ключей в localStorage. Юзер поймал живьём (2026-09-26):
 * бейдж «Избранное» показывал 23, а в самом списке было видно только 19 — квартиры,
 * которые сняли с продажи, остаются ключом в localStorage навсегда (никто их оттуда
 * не убирает — вдруг вернутся), но пропадают из state.all, поэтому список из них
 * их не покажет НИКОГДА, только бейдж продолжал их считать. Живой счётчик —
 * пересечение сохранённых ключей с реально существующими сейчас квартирами. */
function _liveCount(keySet, keyFn) {
  if (!keySet.size) return 0;
  let n = 0;
  for (const a of state.all) if (keySet.has(keyFn(a))) n++;
  return n;
}

function saveHidden() {
  try { localStorage.setItem("wf_hidden", JSON.stringify([...state.hidden])); } catch {}
}

function loadHidden() {
  try { JSON.parse(localStorage.getItem("wf_hidden") || "[]").forEach((k) => state.hidden.add(String(k))); } catch {}
}

/* Раньше отдельная кнопка-тег в полосе фильтров, теперь пункт меню профиля
 * (см. #menu-hidden в app.html): тот же счётчик и то же «нажатое» состояние,
 * просто в другом месте разметки — самого переключателя showHidden это не
 * касается. */
function hiddenTagRefresh() {
  const b = $("#menu-hidden");
  if (!b) return;
  const n = _liveCount(state.hidden, hideKey);
  const badge = b.querySelector(".menu-badge");
  badge.hidden = n === 0;
  badge.textContent = String(n);
  b.setAttribute("aria-pressed", String(state.showHidden));
  refreshProfileDot();
  // То же переключение — ссылкой у счётчика над списком
  const c = $("#count-hidden");
  if (c) {
    c.hidden = (n === 0 && !state.showHidden) || state.onlyFav;
    c.dataset.n = String(n);
    c.title = tr(state.showHidden ? "cnt_back_t" : "cnt_hidden_t");
    c.setAttribute("aria-pressed", String(state.showHidden));
    fitCountHidden();
  }
}

// Полная подпись «🚫 79 скрыто», а если строка над списком не вмещает её вместе
// с «Уведомлять» и сортировкой (колонка 340–380 px) — короткая «🚫 79»
function fitCountHidden() {
  const c = $("#count-hidden"), f = $("#count-fav"), head = c?.parentElement;
  if (!head) return;
  const n = nf.format(Number(c.dataset.n || 0)), nfav = nf.format(Number(f?.dataset.n || 0));
  if (!c.hidden) c.textContent = state.showHidden ? tr("cnt_back") : tr("cnt_hidden")(n);
  if (f && !f.hidden) f.textContent = state.onlyFav ? tr("cnt_back") : tr("cnt_fav")(nfav);
  for (const x of [c, f]) if (x) x.setAttribute("aria-label", x.textContent);
  const over = () => head.scrollWidth > head.clientWidth;
  $("#count").title = "";        // подсказка — только пока число сокращено (аудит 21.10)
  // сначала счётчик — одним числом, как на телефоне («из M» остаётся в подсказке)…
  if (over()) {
    const cnt = $("#count");
    cnt.title = cnt.textContent;
    cnt.textContent = nf.format(state.shown.length);
  }
  // …и только если всё ещё тесно — короткие подписи «⭐ 15» и «🚫 79»
  if (over() && f && !f.hidden && !state.onlyFav) f.textContent = tr("cnt_fav_s")(nfav);
  if (over() && !c.hidden && !state.showHidden) c.textContent = tr("cnt_hidden_s")(n);
}

/* ── Избранное ────────────────────────────────────────────────────────────────
 * Та же архитектура, что и у чёрного списка (см. выше): ключ группо-осведомлён
 * (a.g || a.id), живёт в localStorage этого браузера, из бота приезжает
 * параметром ?fav=. В отличие от чёрного списка — НИЧЕГО не фильтрует сама по
 * себе: это просто закладка, отдельная от showHidden/hidden и независимая
 * от них. С 17.10.2026 избранное и скрытое исключают друг друга (toggle*, синхронизация). */
const favKey = (a) => a.g || a.id;

function saveFavorites() {
  try { localStorage.setItem("wf_fav", JSON.stringify([...state.favorites])); } catch {}
}

function loadFavorites() {
  try { JSON.parse(localStorage.getItem("wf_fav") || "[]").forEach((k) => state.favorites.add(String(k))); } catch {}
}

/* Переразмещённая квартира (продавец снял и выставил заново — у Otodom новый
 * id, db.link_relisted) несёт старые ключи в a.ak: избранное и скрытое
 * переходят на её новый ключ. Старые ключи не удаляем — их знает бот. */
function relistCarry() {
  let fav = false, hid = false;
  for (const a of state.all) {
    if (!a.ak) continue;
    if (!state.favorites.has(favKey(a)) && a.ak.some((k) => state.favorites.has(k))) { state.favorites.add(favKey(a)); fav = true; }
    if (!state.hidden.has(hideKey(a)) && a.ak.some((k) => state.hidden.has(k))) { state.hidden.add(hideKey(a)); hid = true; }
    const oldNote = !state.notes[favKey(a)] && a.ak.map((k) => state.notes[k]).find((n) => n?.t);
    if (oldNote) { state.notes[favKey(a)] = oldNote; try { localStorage.setItem("wf_notes", JSON.stringify(state.notes)); } catch {} }
  }
  if (fav) saveFavorites();
  if (hid) saveHidden();
}

/* ── Сортировка списка ───────────────────────────────────────────────────────
 * Раньше жила только в state (сброс на дефолт "p" при каждой перезагрузке
 * страницы — юзер 2026-09-27: «перезагрузка сайта сбрасывает сортировку»).
 * Тот же паттерн, что у wf_theme: localStorage, не URL — это персональная
 * привычка просмотра, не часть шаринг-ссылки на конкретную выдачу (хотя
 * ?sort= в самой ссылке тоже уважается, см. readUrl — просто не пишется
 * туда автоматически при каждом apply(), в отличие от price/area/rooms). */
const _SORT_VALUES = new Set(["p", "-p", "-sc", "ppm", "-a", "-seen"]);

function saveSort() {
  try { localStorage.setItem("wf_sort", state.sort); } catch {}
}

function loadSort() {
  try {
    const v = localStorage.getItem("wf_sort");
    if (v && _SORT_VALUES.has(v)) state.sort = v;
  } catch {}
}

/* Тот же переезд, что и у hiddenTagRefresh выше: было #fav-tag в полосе
 * фильтров, стало #menu-fav в меню профиля. */
function favTagRefresh() {
  const b = $("#menu-fav");
  if (!b) return;
  const n = _liveCount(state.favorites, favKey);
  const badge = b.querySelector(".menu-badge");
  badge.hidden = n === 0;
  badge.textContent = String(n);
  b.setAttribute("aria-pressed", String(state.onlyFav));
  refreshProfileDot();
  const c = $("#count-fav");
  if (c) {
    c.hidden = (n === 0 && !state.onlyFav) || state.showHidden;
    c.dataset.n = String(n);
    c.title = tr(state.onlyFav ? "cnt_fav_back_t" : "cnt_fav_t");
    c.setAttribute("aria-pressed", String(state.onlyFav));
    fitCountHidden();
  }
}

/* Точка-индикатор на кнопке профиля: есть что показать (избранное и/или
 * скрытые не пусты), даже когда меню закрыто. Живой счётчик — см. _liveCount:
 * точка не должна гореть, если ВСЁ избранное/скрытое — снятые с продажи квартиры,
 * которых юзер всё равно не увидит ни в одном из этих списков. */
function refreshProfileDot() {
  const dot = $("#profile-dot");
  if (dot) dot.hidden = !(_liveCount(state.favorites, favKey) || _liveCount(state.hidden, hideKey));
}

let toastTimer = 0;
function toast(text, undo) {
  let t = $("#toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast"; t.setAttribute("role", "status");
    document.body.appendChild(t);
  }
  t.innerHTML = `<span>${esc(text)}</span>${undo ? `<button type="button">${esc(tr("undo"))}</button>` : ""}`;
  t.hidden = false;
  if (undo) t.querySelector("button").onclick = () => { undo(); t.hidden = true; };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 7000);
}

/* Иконки скрыть/избранное в шапке открытой карточки (те же компоненты, что
 * в списке слева, юзер попросил 2026-09-27) — карточка не перерисовывается
 * целиком при переключении (это сбросило бы фокус/скролл/раскрытые
 * <details> «Что рядом»), поэтому правим точечно отсюда. Нижние текстовые
 * кнопки-дублёры (.sheet-links #hide-btn/#fav-btn) убраны тем же днём —
 * иконки в шапке признаны достаточными (юзер: «теперь можно убрать»). */
function refreshSheetActions(a) {
  if (state.activeId !== a.id) return;
  const isFav = state.favorites.has(favKey(a));
  const isHidden = state.hidden.has(hideKey(a));
  const favIcon = $("#sheet-fav-icon");
  if (favIcon) {
    favIcon.textContent = isFav ? "✓" : "⭐";
    favIcon.title = tr(isFav ? "unfav_t" : "fav_t");
    favIcon.setAttribute("aria-label", tr(isFav ? "unfav" : "fav"));
  }
  const hideIcon = $("#sheet-hide-icon");
  if (hideIcon) {
    hideIcon.textContent = isHidden ? "↩" : "🚫";
    hideIcon.title = tr(isHidden ? "unhide_t" : "hide_t");
    hideIcon.setAttribute("aria-label", tr(isHidden ? "unhide" : "hide"));
  }
}

function toggleHide(id) {
  const a = findApt(id);
  if (!a) return;
  const k = hideKey(a);
  const wasHidden = state.hidden.has(k);
  wasHidden ? state.hidden.delete(k) : state.hidden.add(k);
  // скрыть — значит, не в избранном (17.10.2026: «и там, и там» пропадали с сайта)
  const unfav = !wasHidden && state.favorites.delete(favKey(a));
  saveHidden();
  if (unfav) { saveFavorites(); favTagRefresh(); }
  pushLists(wasHidden ? { unhidden: [k] } : { hidden: [k], ...(unfav ? { unfavorites: [favKey(a)] } : {}) });
  // в режиме «Скрытые» после возврата последней квартиры выходим из режима — иначе пустой экран
  if (state.showHidden && !state.hidden.size) state.showHidden = false;
  // Юзер (2026-09-26): скрыл 10-ю карточку в отсортированном списке — не должно
  // подбрасывать в начало. Тот же resetScroll=false, что у переключателя вида
  // в меню профиля (см. #menu-hidden выше) — здесь даже важнее: это самое частое
  // действие при просмотре длинного списка, не разовое переключение вида.
  apply(false);
  hiddenTagRefresh();
  refreshSheetActions(a);
  toast(tr(wasHidden ? "unhid_toast" : "hid_toast"),
        () => toggleHide(id));
}

function toggleFavorite(id) {
  const a = findApt(id);
  if (!a) return;
  const k = favKey(a);
  const was = state.favorites.has(k);
  was ? state.favorites.delete(k) : state.favorites.add(k);
  const unhid = !was && state.hidden.delete(hideKey(a));
  saveFavorites();
  if (unhid) { saveHidden(); hiddenTagRefresh(); }
  pushLists(was ? { unfavorites: [k] } : { favorites: [k], ...(unhid ? { unhidden: [hideKey(a)] } : {}) });
  // «только избранное» без единого избранного показывало бы пустой список
  if (state.onlyFav && !state.favorites.size) state.onlyFav = false;
  apply(false);   // не прыгать наверх — та же причина, что у toggleHide выше
  favTagRefresh();
  // apply() мог закрыть шторку сам (если «только избранное» и мы его только что
  // убрали) — refreshSheetActions сама проверяет state.activeId, ничего лишнего
  refreshSheetActions(a);
  toast(tr(was ? "unfav_toast" : "fav_toast"),
        () => toggleFavorite(id));
}

/* Когда квартиру последний раз проверяли на Otodom. Снятая с продажи находится ревизией
 * с задержкой (порядка суток и больше), поэтому давность показываем и предупреждаем, если
 * она большая. В базе только ДЕНЬ проверки (scraped_at — DATE), часы недоступны. */
const STALE_DAYS = 3;
function checkedText(a) {
  if (!a.ck) return "—";
  const days = Math.max(0, Math.round((Date.now() - new Date(a.ck + "T00:00:00").getTime()) / 86400000));
  const txt = days === 0 ? tr("today") : days === 1 ? tr("yesterday") : tr("ago_d")(days);
  return days >= STALE_DAYS ? `⚠ ${txt} · ${tr("stale_hint")}` : txt;
}

/* Плашка «+N дублей» в карточке списка (до 16.10.2026 — «+N похожих») */
function dupNote(a) {
  return a.dp?.length ? `<div class="dup-note">${esc(tr(a.sr ? "dup_note_series" : "dup_note")(a.dp.length))}</div>` : "";
}

/* Блок повторов в шторке: диапазон цен и ссылка на каждое объявление */
function dupsHtml(a) {
  if (!a.dp?.length) return "";
  const prices = [a.p, ...a.dp.map((d) => d[1])].filter((v) => v != null);
  const range = prices.length ? `${nf.format(Math.min(...prices))} – ${nf.format(Math.max(...prices))} PLN` : "";
  // Ряд соседних квартир одной планировки (export: sr, 05.10.2026) — у каждой
  // строки площадь и этаж (иначе 36 строк неотличимы), список по площади
  const series = !!a.sr;
  const m2 = (v) => v == null ? "" : `${v.toLocaleString(LANG === "pl" ? "pl-PL" : "ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${tr("m2")}`;
  const flr = (f) => f == null ? "" : `${tr("fl_short")} ${f}`;
  // у ряда продавец обычно один — пишем его раз под списком, а не в каждой строке
  const sellers = [...new Set(a.dp.map((d) => [LABEL.ut[d[2]], d[3]].filter(Boolean).join(" · ")))];
  const oneSeller = series && sellers.length === 1;
  const items = a.dp.map(([u, p, ut, ag, seen, ar, fl]) => `<li>
      ${series ? `<span class="dup-m2">${esc([m2(ar), flr(fl)].filter(Boolean).join(" · "))}</span>` : ""}
      <a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${money(p)}</a>
      <span>${oneSeller ? "" : esc([LABEL.ut[ut], ag].filter(Boolean).join(" · "))}${seen ? `${oneSeller ? "" : " · "}${esc(fmtDate(seen))}` : ""}</span></li>`).join("");
  const areas = series ? [a.a, ...a.dp.map((d) => d[5])].filter((v) => v != null) : [];
  const areaRange = areas.length ? ` · ${m2(Math.min(...areas)).replace(` ${tr("m2")}`, "")}–${m2(Math.max(...areas))}` : "";
  return `<details class="dups${series ? " dups--series" : ""}"><summary>${esc(tr(series ? "dups_series" : "dups_t")(a.dp.length))}${areaRange}${range ? ` · ${range}` : ""}</summary>
      <ul>${items}</ul><small>${oneSeller ? `${esc(sellers[0])}. ` : ""}${esc(tr(series ? "dup_series_hint" : "dup_hint"))}</small></details>`;
}

/* Шум квартиры: МАКСИМУМ по всем слоям (дороги, ж/д, трамвай, промышленность,
 * самолёты), см. 2.scoring/noise.py. nl — нижняя граница полосы Lden (55/60/65/70/75),
 * 0 = тихо. Показываем полосу («65–69 дБ», «75+ дБ») и источник максимума. */
/** «≈ 30 800 zł (2%) — не указана, уточнить» / «нет — продаёт хозяин» (cm, cms из export.py) */
function commText(a) {
  const why = tr("comm_s")[a.cms];
  if (!a.cm) return `${tr("c_none")}${why ? ` — ${why}` : ""}`;
  const pct = String(a.cm).replace(".", ",");
  return `${a.p ? `≈ ${nf.format(ROUNDH(a.p * a.cm / 100))} zł (${pct}%)` : `${pct}%`}${why ? ` — ${why}` : ""}`;
}

function noiseText(a) {
  if (a.nl == null) return "—";
  // Источник — ДО ветвления по громкости: раньше «тихая» ветка (< 55 дБ)
  // источник просто не подставляла, хотя он мог быть известен для реально
  // размеченных тихих точек (аудит юзера 2026-09-23: «не всегда отображается
  // источник»). 0 — теперь честно «тише 45 дБ или нет данных» (было «тише 55»
  // — см. noise_wms.py::sample_db, полосы 45-49/50-54 раньше схлопывались в 0
  // ещё на этапе выборки, до карточки дело не доходило).
  const src = a.ns ? ` · ${tr("ns_" + a.ns)}` : "";
  if (a.nl === 0) return `${tr("noise_lt")}${src}`;
  const band = a.nl >= 75 ? "75+" : `${a.nl}–${a.nl + 4}`;
  return `${band} ${tr("db")}${src}`;
}

// ── Карта ───────────────────────────────────────────────────────────────────
/* С 18.10.2026 — MapLibre GL (векторные плитки OpenFreeMap, без ключа) вместо
 * Leaflet + растровых плиток Esri. Юзер: «карта очень рвано работает, прошлые
 * попытки не исправили» — рывки давал сам растровый зум Leaflet (плитки
 * растягиваются и подгружаются ступенями), настройки колёсика это не лечили.
 * MapLibre рисует на видеокарте: зум плавный, подписи чёткие на любом масштабе.
 * Подложка — Bright+ (выбор юзера по прототипу map-proto.html): Bright, у которого
 * значки и подписи на ступень зума раньше и номера домов с z16; тёмная тема —
 * та же Bright+ с инвертированной яркостью цветов (darkStyle).
 *
 * Модуль грузится динамически: если CDN не ответил, список квартир работает,
 * а на месте карты — понятное сообщение. Всё, что рисует сайт (квартиры, снятые,
 * линии, остановки, шум, воздух, изохроны), — свои источники и слои поверх
 * подложки; при смене темы стиль меняется целиком, и они добавляются заново
 * (addOwnLayers на style.load). */
const WMS = "https://wms.um.warszawa.pl/serwis";
// источник шума → часть имени слоя WMS: HALAS_<имя>_<LDWN|LN>_2022
const NOISE_SRC = { road: "DROGOWY", rail: "KOLEJOWY", air: "LOTNICZY", tram: "TRAMWAJOWY", industry: "PRZEMYSLOWY" };
// палитра карты города, от тихого к громкому (цвета сверены по картинке слоя)
const NOISE_BANDS = [["45–49", "#ffff00"], ["50–54", "#ffbf0f"], ["55–59", "#fc8a1e"], ["60–64", "#fd5805"],
                     ["65–69", "#de3e3e"], ["70–74", "#b17ed9"], ["75+", "#03abe2"]];

const MAPLIBRE_JS = "https://unpkg.com/maplibre-gl@6.11.0/dist/maplibre-gl.mjs";
const OFM_STYLE = "https://tiles.openfreemap.org/styles/bright";
let ml = null;              // модуль maplibre-gl
let mapReady = false;       // стиль загружен и свои слои добавлены
const styleCache = {};      // "light" | "dark" → объект стиля
let firstLabel = null;      // id первого слоя подписей подложки — шум/воздух/изохроны кладём под него

/* Bright+: значки и подписи на ступень зума раньше, номера домов с z16 */
function brightPlus(st) {
  const z = { poi_r1: 14, poi_r7: 15, poi_r20: 16, "highway-name-minor": 14, "highway-name-path": 15 };
  st.layers.forEach((l) => { if (z[l.id] != null) l.minzoom = z[l.id]; });
  const at = st.layers.findIndex((l) => l.id === "poi_r20");
  st.layers.splice(at < 0 ? st.layers.length : at, 0, {
    id: "housenumber", type: "symbol", source: "openmaptiles", "source-layer": "housenumber", minzoom: 16,
    layout: { "text-field": ["get", "housenumber"], "text-font": ["Noto Sans Regular"], "text-size": 10 },
    paint: { "text-color": "#8a8580", "text-halo-color": "#ffffff", "text-halo-width": 1 },
  });
  return st;
}

/* Тёмная Bright+: у Bright тёмного варианта нет, а юзер живёт в тёмной теме.
 * Каждый цвет стиля (в т.ч. внутри выражений) — инверсия светлоты с сохранением
 * оттенка: вода остаётся синей, парки зелёными, белые подписи становятся светлыми
 * на тёмном. Насыщенность чуть ниже — тёмная карта не должна «светиться». */
const NAMED = { white: "#ffffff", black: "#000000", transparent: "rgba(0,0,0,0)" };
function parseColor(s) {
  s = NAMED[s] || s;
  let m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((c) => c + c).join("");
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(s);
  if (m) { const p = m[1].split(",").map((x) => parseFloat(x)); return [p[0], p[1], p[2], p[3] ?? 1]; }
  m = /^hsla?\(([^)]+)\)$/i.exec(s);
  if (m) {
    const p = m[1].split(",").map((x) => parseFloat(x));
    const [h, sat, l] = [p[0] / 360, p[1] / 100, p[2] / 100];
    const q = l < .5 ? l * (1 + sat) : l + sat - l * sat, pp = 2 * l - q;
    const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? pp + (q - pp) * 6 * t : t < .5 ? q : t < 2 / 3 ? pp + (q - pp) * (2 / 3 - t) * 6 : pp; };
    return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255, p[3] ?? 1];
  }
  return null;
}
/* Тёмная Bright+ — своя холодная графитовая палитра (18.10.2026; до этого
 * преобразования светлой давали то «болотно-зелёную», то бурую карту — юзеру не
 * зашло). Цвет светлой схемы только подсказывает РОЛЬ (вода, зелень, дорога,
 * подпись) и порядок светлоты; оттенок задаём сами, как в тёмных Apple/Google:
 *   земля — графит с лёгкой синевой (11–14%), здания чуть светлее;
 *   зелень — едва заметно зеленее земли; вода — глубокая синяя;
 *   улицы — серые, главные дороги светлее; подписи — светло-серые. */
function hsl(s) {
  const c = parseColor(s);
  if (!c) return null;
  const [r, g, b] = c.map((v, i) => i < 3 ? v / 255 : v);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let h = 0, sat = 0;
  if (d) {
    sat = l > .5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
  }
  return [h, sat, l, c[3]];
}
const isBlue = (h, sat) => sat > .15 && h >= 185 && h <= 250;
const isGreen = (h, sat) => sat > .12 && h >= 60 && h <= 170;
const hslStr = (h, s_, l, a) => `hsla(${Math.round(h)},${Math.round(s_ * 100)}%,${Math.round(l * 100)}%,${a})`;
function darkColor(s, role) {
  const c = hsl(s);
  if (!c) return s;
  const [h, sat, l, a] = c;
  if (role === "halo") return hslStr(220, .12, .09, a);
  if (role === "text") return isBlue(h, sat) ? hslStr(210, .45, .68, a)
    : sat > .3 ? hslStr(h, sat * .45, .72, a) : hslStr(220, .08, .12 + .72 * (1 - l), a);
  if (role === "line") {
    if (isBlue(h, sat)) return hslStr(212, .4, .24, a);                 // реки, каналы
    if (sat > .3 && h >= 20 && h <= 65) return hslStr(220, .06, .37 + .08 * (l - .5), a);  // главные дороги — светлее улиц, без бежевого
    return hslStr(220, .07, .17 + .14 * l, a);                         // улицы, обводки, пути
  }
  if (isBlue(h, sat)) return hslStr(212, .45, .18 + .05 * (1 - l), a);   // вода
  if (isGreen(h, sat)) return hslStr(160, .1, .125 + .04 * (1 - l), a);  // парки, леса, газоны — едва зелёные
  return hslStr(220, .1, .1 + .09 * (1 - l), a);                        // земля, застройка, здания
}
function darkStyle(st) {
  const walk = (v, role) => typeof v === "string" ? (parseColor(v) ? darkColor(v, role) : v)
    : Array.isArray(v) ? v.map((x) => walk(x, role)) : v;
  st.layers.forEach((l) => {
    if (!l.paint) return;
    const water = /water|river|ocean|lake/.test(l.id);
    l.paint = Object.fromEntries(Object.entries(l.paint).map(([k, v]) => {
      const role = /halo-color$/.test(k) ? "halo" : /^(text|icon)-/.test(k) ? "text"
        : k.startsWith("line-") && !water ? "line" : "fill";
      return [k, walk(v, role)];
    }));
  });
  return st;
}

/* Свои цвета (линии, остановки, снятые) — с контрастом к подложке не ниже 4:1 (WCAG)
 * в обеих темах (18.10.2026). Тёмная: тёмно-синяя M1, коричневые электрички на
 * графите не видны — светлоту поднимаем. Светлая: бирюзовый трамвай (2,9:1), серое
 * строящееся метро (2:1), снятые — на бежевой застройке Bright бледные — опускаем.
 * Фон — самый частый под точками: графит (тёмная) и застройка #eae5e0 (светлая). */
function onMap(c) {
  const dark = currentTheme() === "dark";
  const x = hsl(c);
  if (!x) return c;
  const [h, sat, l0, a] = x;
  const s2 = dark ? Math.max(sat, .45) : sat;
  const rgb = (L) => {   // hsl → [r,g,b] 0..1
    const q = L < .5 ? L * (1 + s2) : L + s2 - L * s2, p = 2 * L - q;
    const f = (t) => { t = (t % 1 + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < .5 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
    return [f(h / 360 + 1 / 3), f(h / 360), f(h / 360 - 1 / 3)];
  };
  const lum = ([r, g, b]) => [r, g, b].map((v) => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((acc, v, i) => acc + v * [.2126, .7152, .0722][i], 0);
  const bg = lum(dark ? [.0945, .1035, .1155] : [.918, .898, .878]);
  const ratio = (L) => { const v = lum(rgb(L)); return (Math.max(v, bg) + .05) / (Math.min(v, bg) + .05); };
  let L = l0;
  if (dark) while (L < .9 && ratio(L) < 4) L += .02;
  else while (L > .1 && ratio(L) < 4) L -= .02;
  return L === l0 ? c : hslStr(h, s2, L, a);
}

async function loadStyle(theme) {
  if (!styleCache.light) {
    const st = brightPlus(await fetch(OFM_STYLE).then((r) => r.json()));
    styleCache.light = st;
    styleCache.dark = darkStyle(structuredClone(st));
  }
  return structuredClone(styleCache[theme] || styleCache.light);
}

/* Смена темы сайта → смена подложки без перезагрузки страницы. Свои слои
 * вернутся сами (style.load → addOwnLayers). */
function applyMapTheme(theme) {
  if (!map) return;
  loadStyle(theme).then((st) => { mapReady = false; map.setStyle(st, { diff: false }); });
}

// точки квартир: на тёмной — светлее акцента сайта, на светлой — акцент с контрастом ≥ 4:1 (onMap)
const accentColor = () => currentTheme() === "dark" ? "#4f97ec"
  : onMap(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#2a78d6");
const fc = (features) => ({ type: "FeatureCollection", features });
const pt = (lon, lat, props = {}) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lon, lat] }, properties: props });

function initMap() {
  initMapAsync().catch((e) => {
    console.error("Карта не загрузилась", e);
    const box = $("#map");
    if (box) box.innerHTML = `<div class="map-err">${esc(tr("map_err"))}</div>`;
  });
}

async function initMapAsync() {
  const mod = await import(MAPLIBRE_JS);
  ml = mod.default ?? mod;
  const style = await loadStyle(currentTheme());
  map = new ml.Map({
    container: "map", style, center: [21.01, 52.23], zoom: 11, maxZoom: 19,
    attributionControl: { compact: true },
    dragRotate: false, pitchWithRotate: false, touchPitch: false,   // 3D и поворот юзеру не нужны
  });
  window.__wfmap = map;      // для проверок (playwright, design_check): двигать карту из теста
  map.touchZoomRotate.disableRotation();
  map.keyboard.disableRotation?.();
  map.addControl(new ml.NavigationControl({ showCompass: false }), "bottom-right");
  map.on("style.load", addOwnLayers);
  map.once("idle", attribMin);
  map.on("resize", () => legLayout());
  // Клик по карте закрывает панель слоёв (сама панель — вне холста карты, её клики сюда не доходят)
  map.on("click", () => { if (lp?._open) { lp._open = false; lp.render(); } });
  initLegends();
  buildLayerControl();
  initLines();
}

/* Подсказка при наведении (мышь). Одна на всю карту. */
let tip = null;
function hoverTip(layerId, html, opts = {}) {
  map.on("mousemove", layerId, (e) => {
    const f = e.features?.[0];
    if (!f) return;
    map.getCanvas().style.cursor = "pointer";
    const h = html(f, e);
    if (!h) return;
    tip ||= new ml.Popup({ closeButton: false, closeOnClick: false, offset: 10, className: "map-tip", maxWidth: "280px" });
    tip.setLngLat(opts.sticky ? e.lngLat : f.geometry.type === "Point" ? f.geometry.coordinates : e.lngLat).setHTML(h).addTo(map);
    if (opts.cls) tip.addClassName(opts.cls); else tip.removeClassName("rem-tip");
  });
  map.on("mouseleave", layerId, () => { map.getCanvas().style.cursor = ""; tip?.remove(); });
}
let tipsBound = false;

/* Свои источники и слои — после каждой загрузки стиля (старт, смена темы). */
function addOwnLayers() {
  firstLabel = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
  const accent = accentColor();
  const add = (src, data) => map.getSource(src) || map.addSource(src, { type: "geojson", data });
  // снизу вверх: (шум, воздух, изохроны — под подписями) → снятые → гало → квартиры → линии → остановки → круг «рядом»
  add("removed", fc([]));
  map.addLayer({ id: "removed", type: "circle", source: "removed", layout: { visibility: "none" },
    paint: { "circle-radius": 4, "circle-color": onMap("#8b8a81"), "circle-opacity": currentTheme() === "dark" ? .7 : .85,
             "circle-stroke-width": 1.5, "circle-stroke-color": currentTheme() === "dark" ? "#0f1114" : "#ffffff" } });
  add("halo", fc([]));
  map.addLayer({ id: "halo", type: "circle", source: "halo",
    paint: { "circle-radius": 15, "circle-color": accent, "circle-opacity": .18, "circle-stroke-width": 2, "circle-stroke-color": accent } });
  add("apts", fc([]));
  map.addLayer({ id: "apts", type: "circle", source: "apts",
    // Все точки одного размера (18.10.2026, юзер: раньше размер шёл от рейтинга — убрать);
    // на весь город мельче, иначе сливаются в пятно
    paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 3.5, 14, 6, 17, 7],
             "circle-color": accent, "circle-opacity": .85,
             "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 10, 1, 14, 2],
             "circle-stroke-color": currentTheme() === "dark" ? "#0f1114" : "#fcfcfb" } });
  add("lines", fc([]));
  /* Обводка линий в цвет темы (18.10.2026): поверх шума (жёлтый…фиолетовый) и воздуха
   * любой цвет линии с какой-то полосой сливается — контраст падал до 1,1:1. Белая
   * (светлая тема) или почти чёрная (тёмная) кайма отделяет линию от любой подложки. */
  const caseColor = currentTheme() === "dark" ? "#0f1114" : "#ffffff";
  map.addLayer({ id: "lines-case", type: "line", source: "lines", filter: ["!=", ["get", "t"], "metro_construction"],
    layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": caseColor } });
  map.addLayer({ id: "lines", type: "line", source: "lines", filter: ["!", ["in", ["get", "t"], ["literal", ["metro_construction", "metro_planned"]]]],
    layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "c"] } });
  map.addLayer({ id: "lines-constr", type: "line", source: "lines", filter: ["in", ["get", "t"], ["literal", ["metro_construction", "metro_planned"]]],
    layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": ["get", "c"], "line-dasharray": [0.5, 2] } });
  add("stops", fc([]));
  map.addLayer({ id: "stops", type: "circle", source: "stops", paint: { "circle-color": currentTheme() === "dark" ? "#1b1e23" : "#ffffff" } });
  add("near", fc([]));
  map.addLayer({ id: "near-fill", type: "fill", source: "near", paint: { "fill-color": "#2a78d6", "fill-opacity": .07 } });
  map.addLayer({ id: "near-line", type: "line", source: "near", paint: { "line-color": "#2a78d6", "line-width": 2, "line-dasharray": [3, 2] } });

  if (!tipsBound) {   // обработчики событий по id слоя переживают смену стиля — вешаем один раз
    tipsBound = true;
    hoverTip("apts", (f) => {
      const a = aptById.get(f.properties.id);
      return a ? `${money(a.p)} · ${num(a.a, " " + tr("m2"))} · ${tr("rating")} ${Math.round(a.sc)}` : "";
    });
    map.on("click", "apts", (e) => {
      const id = e.features?.[0]?.properties?.id;
      if (!id) return;
      if ($("#sheet").hidden) sheetOpenerId = null;
      select(id, false);
    });
    hoverTip("removed", (f) => removedTipHtml(f.properties.lat, f.properties.lon, f.properties.n), { cls: "rem-tip" });
    map.on("click", "removed", (e) => {
      const p = e.features?.[0]?.properties;
      if (p) openRemovedAt(p.lat, p.lon, e.lngLat);
    });
    bindLinesEvents();
    ["gios-pt", "airly-pt"].forEach((id) => hoverTip(id, (f) => f.properties.tip));
  }
  mapReady = true;
  renderMarkers();
  if (state.activeId) highlightMarker(state.activeId);
  buildLayerControl();          // данные слоёв (снятые, воздух, изохроны) — заново в новом стиле
  noiseApply();
  if (linesState.data) linesSetData();
  linesRestyle();
  linesNearDraw();
}

/* ── Панель слоёв ─────────────────────────────────────────────────────────────
 * Слои разложены по раскрывающимся секциям, шум — ОДИН выбор «источник + сутки/ночь»
 * (слои шума всё равно закрашивают друг друга, читать два сразу нельзя).
 * Что включено, хранится в layerOn по СТАБИЛЬНОМУ ключу (apts, tram…), а не по
 * названию или порядку: названия меняются со сменой языка, а группы данных
 * (воздух, снятые) пересоздаются заново — ключ переживает и то и другое. */
const layerOn = new Set(["apts"]);
let layerDefs = [];                 // [{key, group, label, ids}]
const noiseSel = { src: "", night: false };
let lp = null;                      // контрол панели
const lpOpen = new Set((() => {
  try { return JSON.parse(localStorage.getItem("wf_lp_open") || '["offers"]'); } catch { return ["offers"]; }
})());

const LINE_KINDS = ["tram", "metro", "rail", "metro_construction", "metro_planned"];
function setVis(ids, on) {
  if (!mapReady) return;
  ids.forEach((id) => { if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", on ? "visible" : "none"); });
}
function setLayerOn(key, on) {
  const d = layerDefs.find((x) => x.key === key);
  if (!d) return;
  on ? layerOn.add(key) : layerOn.delete(key);
  if (LINE_KINDS.includes(key)) linesKindsChanged();
  else setVis(d.ids, on);
  refreshLegends();
}

/* Подпись источников карты — свёрнутой кнопкой «i». MapLibre раскрывает её при старте и
 * при новом источнике (карта шума), и на телефоне она ложилась поверх «Линий» (20.10.2026) */
function attribMin() {
  const el = document.querySelector("#map .maplibregl-ctrl-attrib.maplibregl-compact");
  if (!el) return;
  el.classList.remove("maplibregl-compact-show");
  el.removeAttribute("open");
}

function noiseApply() {
  if (!mapReady) return;
  if (map.getLayer("noise")) map.removeLayer("noise");
  if (map.getSource("noise")) map.removeSource("noise");
  if (noiseSel.src) {
    const lay = `HALAS_${NOISE_SRC[noiseSel.src]}_${noiseSel.night ? "LN" : "LDWN"}_2022`;
    map.addSource("noise", {
      type: "raster", tileSize: 256, attribution: "Mapa akustyczna Warszawy 2022",
      tiles: [`${WMS}?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=${lay}&STYLES=&CRS=EPSG:3857` +
              "&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true"],
    });
    map.addLayer({ id: "noise", type: "raster", source: "noise", paint: { "raster-opacity": .6 } }, firstLabel);
    map.once("idle", attribMin);
  }
  refreshLegends(true);
}

/* Контрол MapLibre — объект с onAdd/onRemove, сам ставит в угол карты */
class LayersPanel {
  constructor() { this._open = false; }
  onAdd() {
    const box = this._box = document.createElement("div");
    box.className = "lp maplibregl-ctrl";
    box.addEventListener("click", (e) => {
      // render() заменяет innerHTML прямо здесь — клик дальше не пускаем
      e.stopPropagation();
      if (e.target.closest(".lp-btn")) { this._open = !this._open; this.render(); }
    });
    box.addEventListener("change", (e) => {
      const el = e.target;
      const focus = el.dataset.k ? `[data-k="${el.dataset.k}"]` : el.dataset.noise ? "[data-noise]" : `[name="${el.name}"][value="${el.value}"]`;
      if (el.dataset.k) setLayerOn(el.dataset.k, el.checked);
      else if (el.dataset.noise) { noiseSel.src = el.value; noiseApply(); }
      else if (el.name === "lp-per") { noiseSel.night = el.value === "night"; noiseApply(); }
      this.render();
      box.querySelector(focus)?.focus();      // перерисовка не должна ронять фокус клавиатуры
    });
    // toggle у <details> не всплывает — ловим на погружении
    box.addEventListener("toggle", (e) => {
      const g = e.target.dataset?.g;
      if (!g) return;
      e.target.open ? lpOpen.add(g) : lpOpen.delete(g);
      try { localStorage.setItem("wf_lp_open", JSON.stringify([...lpOpen])); } catch {}
    }, true);
    // колесо и перетаскивание внутри панели не должны двигать карту
    ["wheel", "touchstart", "mousedown", "dblclick"].forEach((t) => box.addEventListener(t, (e) => e.stopPropagation()));
    this.render();
    return box;
  }
  onRemove() { this._box?.remove(); }

  render() {
    const box = this._box;
    if (!box) return;
    const inGroup = (g) => layerDefs.filter((d) => d.group === g);
    const item = (d) => `<label class="lp-i"><input type="checkbox" data-k="${esc(d.key)}"${layerOn.has(d.key) ? " checked" : ""}>
        <span>${esc(d.label)}</span></label>`;
    const sec = (g, inner, badge = 0) => inner
      ? `<details class="lp-g" data-g="${g}"${lpOpen.has(g) ? " open" : ""}>
           <summary>${tr("g_" + g)}${badge ? `<em>${badge}</em>` : ""}</summary>${inner}</details>` : "";
    const cnt = (g) => inGroup(g).filter((d) => layerOn.has(d.key)).length;

    const noise = `<label class="lp-sel"><span>${tr("noise_src")}</span>
        <select data-noise="src"><option value="">${tr("noise_off")}</option>${
          Object.keys(NOISE_SRC).map((k) =>
            `<option value="${k}"${noiseSel.src === k ? " selected" : ""}>${tr("nz_" + k)}</option>`).join("")}</select></label>
      <div class="lp-seg" role="radiogroup">
        <label><input type="radio" name="lp-per" value="day"${noiseSel.night ? "" : " checked"}> ${tr("per_day")}</label>
        <label><input type="radio" name="lp-per" value="night"${noiseSel.night ? " checked" : ""}> ${tr("per_night")}</label>
      </div>`;

    const active = layerDefs.filter((d) => d.key !== "apts" && layerOn.has(d.key)).length + (noiseSel.src ? 1 : 0);
    box.innerHTML = `
      <button type="button" class="lp-btn" aria-expanded="${this._open}" aria-label="${tr("layers_t")}" title="${tr("layers_t")}">
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 3 2 8.5l10 5.5 10-5.5L12 3Zm0 13.2-8.2-4.5L2 12.7l10 5.5 10-5.5-1.8-1-8.2 4.5Zm0 4-8.2-4.5L2 16.7l10 5.5 10-5.5-1.8-1-8.2 4.5Z" fill="currentColor"/></svg>
        ${active ? `<i class="lp-n">${active}</i>` : ""}
      </button>
      <div class="lp-body"${this._open ? "" : " hidden"}>
        ${sec("offers", inGroup("offers").map(item).join(""), cnt("offers") - (layerOn.has("apts") ? 1 : 0))}
        ${sec("transit", inGroup("transit").map(item).join(""), cnt("transit"))}
        ${sec("noise", noise, noiseSel.src ? 1 : 0)}
        ${sec("air", inGroup("air").map(item).join(""), cnt("air"))}
        ${sec("iso", inGroup("iso").map(item).join(""), cnt("iso"))}
      </div>`;
  }
}

/* Строится при старте, на каждой смене языка и после загрузки стиля: подписи слоёв
 * и данные снятых/воздуха/изохрон приходят позже карты (layers.json). */
function buildLayerControl() {
  if (!map) return;
  layerDefs = [{ key: "apts", group: "offers", label: tr("l_apts"), ids: ["apts", "halo"] }, ...buildDataLayers()];
  if (mapReady) layerDefs.forEach((d) => { if (!LINE_KINDS.includes(d.key)) setVis(d.ids, layerOn.has(d.key)); });
  if (lp) lp.render();
  else { lp = new LayersPanel(); map.addControl(lp, "top-right"); }
  linesRedraw();
  refreshLegends(true);
}

// Польский индекс качества воздуха PM2.5 (µg/m³): порог → цвет (регламентированная шкала).
// GIOŚ и Airly меряют одну величину, поэтому шкала у них общая.
const PM25_BANDS = [[13, "#57b108"], [35, "#b0dd10"], [55, "#ffd911"],
                    [75, "#e58100"], [110, "#e50000"], [Infinity, "#990000"]];
const pm25Color = (v) => PM25_BANDS.find(([thr]) => v <= thr)[1];

/* Полосы (воздух, изохроны) — GeoJSON полос с цветом в свойствах */
const bandsFc = (bands) => fc((bands || []).flatMap((b) => {
  const g = b.geo;
  const feats = g?.type === "FeatureCollection" ? g.features : g?.type === "Feature" ? [g] : g ? [{ type: "Feature", geometry: g, properties: {} }] : [];
  return feats.map((f) => ({ ...f, properties: { ...(f.properties || {}), color: b.color } }));
}));

/* Источник + слои одного набора данных; ids — для включения/выключения */
function dataLayer(id, data, layers, under = false) {
  if (!mapReady) return layers.map((l) => l.id);
  if (map.getSource(id)) map.getSource(id).setData(data);
  else map.addSource(id, { type: "geojson", data });
  layers.forEach((l) => { if (!map.getLayer(l.id)) map.addLayer({ source: id, layout: { visibility: "none" }, ...l }, under ? firstLabel : "halo"); });
  return layers.map((l) => l.id);
}

/* Возвращает описания слоёв [{key, group, label, ids}]. Порядок в списке = порядок в панели. */
function buildDataLayers() {
  const L_ = state.layers || {};
  const out = [];
  const add = (key, group, label, ids) => out.push({ key, group, label, ids });

  /* Снятые с продажи — только адреса, где активных объявлений не осталось (иначе
   * снятые видны в карточке активной). Приглушённые: это история, а не предложение.
   * Подсказка — функцией (removedTipHtml): детали дозагружаются при наведении. */
  if (L_.removed_pts?.length) {
    if (mapReady) map.getSource("removed")?.setData(fc(L_.removed_pts.map((r) => pt(r.lon, r.lat, { lat: r.lat, lon: r.lon, n: r.n }))));
    add("removed", "offers", `${tr("l_rem")} · ${L_.removed_pts.length}`, ["removed"]);
  }

  // Трамвай и метро — данные грузятся при первом включении (linesEnsure)
  add("tram", "transit", tr("l_tram"), ["lines", "stops"]);
  add("metro", "transit", tr("l_metro"), ["lines", "stops"]);
  // Электрички SKM/KM/WKD (18.10.2026) — из тех же lines.json (sitedata._rail_routes_stops)
  add("rail", "transit", tr("l_rail"), ["lines", "stops"]);
  // Строящееся продолжение M2 — справочный слой (не в скоринге)
  add("metro_construction", "transit", tr("l_metro_construction"), ["lines-constr", "stops"]);
  // Планируемые M3 и M4 (21.10.2026) — справочно, не в скоринге; пунктир с каймой
  add("metro_planned", "transit", tr("l_metro_planned"), ["lines-constr", "stops"]);

  // Изохроны: зоны доступности от личного адреса подписчика
  (L_.iso || []).forEach((entry, i) => {
    const ids = dataLayer(`iso${i}`, bandsFc(entry.bands), [
      { id: `iso${i}-fill`, type: "fill", paint: { "fill-color": ["get", "color"], "fill-opacity": .22 } },
      { id: `iso${i}-line`, type: "line", paint: { "line-color": ["get", "color"], "line-width": 2, "line-opacity": .9 } },
    ], true);
    add(`iso${i}`, "iso", `${tr("l_iso")} ${entry.bands.map((b) => b.min).join("/")} ${tr("min")}`, ids);
  });

  const airPts = (pts) => fc(pts.map((p) => pt(p.lon, p.lat, {
    c: pm25Color(p.v),
    tip: `${esc(p.addr || "")} · PM2.5: ${esc(p.v)} µg/m³${p.pm10 != null ? ` · PM10: ${Math.round(p.pm10)}` : ""}${p.hh ? ` (${esc(p.hh)})` : ""}`,
  })));
  const ptLayer = (id, r) => ({ id, type: "circle", paint: { "circle-radius": r, "circle-color": ["get", "c"], "circle-opacity": .95,
                                                            "circle-stroke-width": 1, "circle-stroke-color": "#555555" } });
  // Госстанции: их мало, поэтому кружок крупнее — это опорные точки
  if (L_.gios?.length) add("gios", "air", tr("l_gios"), dataLayer("gios", airPts(L_.gios), [ptLayer("gios-pt", 11)]));
  // Airly: плотная сеть бытовых сенсоров + интерполяционная поверхность (полосы — под точками и подписями)
  if (L_.air?.length) {
    const band = dataLayer("airly-bands", bandsFc(L_.air_bands), [
      { id: "airly-band", type: "fill", paint: { "fill-color": ["get", "color"], "fill-opacity": .3, "fill-outline-color": ["get", "color"] } }], true);
    add("airly", "air", tr("l_airly"), [...band, ...dataLayer("airly", airPts(L_.air), [ptLayer("airly-pt", 5)])]);
  }
  return out;
}

/* ── Линии, остановки и станции ───────────────────────────────────────────────
 * data/lines.json (GTFS ZTM, ~95 КБ) грузится при первом включении трамвая или метро.
 *  • Навести на линию — подсветка маршрута и подсказка с номером и направлением.
 *  • Нажать линию или номер в панели — маршрут закреплён, остальные приглушены.
 *  • Нажать остановку или станцию — выбор: закрепляются все её маршруты, рисуется
 *    круг «рядом» (500 или 1000 м), в попапе — маршруты и число квартир в круге.
 *    Кнопка «Показать квартиры рядом» включает фильтр по этому кругу. */
const NEAR_R = [500, 1000];                  // метры: ~6 и ~12 минут пешком
const linesState = {
  data: null, loading: null,
  kind: {},               // id маршрута → "tram" | "metro" | "metro_construction"
  color: {},              // id маршрута → цвет линии
  stops: [],              // [остановка] — индекс в массиве = свойство k у точки
  pinned: new Set(), hover: null, box: null,
  sel: null,              // {stop, r} — выбранная остановка
  popup: null,
};

// Расстояние в метрах — плоское приближение, для радиусов до нескольких км точнее сотни метров не нужно
function distM(la1, lo1, la2, lo2) {
  return Math.hypot((la1 - la2) * 111320, (lo1 - lo2) * 111320 * Math.cos((la1 * Math.PI) / 180));
}
const nearOk = (a, n) => a.lat != null && a.lon != null && distM(a.lat, a.lon, n.p[0], n.p[1]) <= n.r;

const kindsOn = () => LINE_KINDS.filter((k) => layerOn.has(k));

/* Данные линий и остановок в источники (после загрузки lines.json и после смены стиля) */
function linesSetData() {
  const d = linesState.data;
  if (!d || !mapReady) return;
  map.getSource("lines")?.setData(fc(d.routes.flatMap((r) => r.g.map((geom) => ({
    type: "Feature", geometry: { type: "LineString", coordinates: geom.map(([la, lo]) => [lo, la]) },
    properties: { i: r.i, t: r.t, c: onMap(r.c), n: r.n } })))));
  map.getSource("stops")?.setData(fc(linesState.stops.map((s, k) =>
    pt(s.p[1], s.p[0], { k, t: s.t, c: onMap(linesState.color[s.r[0]] || (s.t === "metro" ? "#0000bb" : "#e08300")) }))));
}

/* Стиль линий и остановок — выражениями от закреплённых, наведённой и выбранной */
function linesRestyle() {
  if (mapReady && map.getLayer("lines")) {
    const pinned = ["literal", [...linesState.pinned]];
    const on = ["any", ["in", ["get", "i"], pinned], ["==", ["get", "i"], linesState.hover ?? ""]];
    const dim = linesState.pinned.size > 0;
    const base = ["match", ["get", "t"], "metro", 5, "rail", 4, "metro_construction", 4, "metro_planned", 4, 3];
    const width = ["case", on, ["+", base, 3], base];
    const op = ["case", on, 1, dim ? .18 : ["match", ["get", "t"], "metro", .9, "rail", .85, "metro_construction", .6, "metro_planned", 1, .7]];
    ["lines", "lines-constr"].forEach((id) => {
      map.setPaintProperty(id, "line-width", width);
      map.setPaintProperty(id, "line-opacity", op);
    });
    map.setPaintProperty("lines-case", "line-width", ["+", width, 3]);
    map.setPaintProperty("lines-case", "line-opacity", op);
    const kinds = ["literal", kindsOn()];
    map.setFilter("lines", ["all", ["!", ["in", ["get", "t"], ["literal", ["metro_construction", "metro_planned"]]]], ["in", ["get", "t"], kinds]]);
    map.setFilter("lines-case", ["all", ["!=", ["get", "t"], "metro_construction"], ["in", ["get", "t"], kinds]]);
    map.setFilter("lines-constr", ["all", ["in", ["get", "t"], ["literal", ["metro_construction", "metro_planned"]]], ["in", ["get", "t"], kinds]]);
    map.setFilter("stops", ["in", ["get", "t"], kinds]);
    ["lines-case", "lines", "lines-constr", "stops"].forEach((id) => map.setLayoutProperty(id, "visibility", kindsOn().length ? "visible" : "none"));
    // остановка приглушена, если ни один её маршрут не закреплён
    const selK = linesState.sel ? linesState.stops.indexOf(linesState.sel.stop) : -1;
    const stopDim = dim ? ["!", ["in", ["get", "k"], ["literal",
      linesState.stops.map((s, k) => s.r.some((r) => linesState.pinned.has(r)) ? k : -1).filter((k) => k >= 0)]]] : false;
    const sel = ["==", ["get", "k"], selK];
    map.setPaintProperty("stops", "circle-radius", ["case", sel, 9, ["match", ["get", "t"], "tram", 4, "rail", 5, 6]]);
    map.setPaintProperty("stops", "circle-stroke-width", ["case", sel, 4, ["match", ["get", "t"], "metro_construction", 2, "metro_planned", 2.5, 3]]);
    map.setPaintProperty("stops", "circle-stroke-color", ["case", sel, "#2a78d6", ["get", "c"]]);
    map.setPaintProperty("stops", "circle-opacity", ["case", stopDim, .3, 1]);
    map.setPaintProperty("stops", "circle-stroke-opacity", ["case", stopDim, .3, 1]);
  }
  linesPanel();
  if (linesState.popup && linesState.sel) linesState.popup.setDOMContent(stopPopupNode(linesState.sel.stop));
}

function linesPin(id) {
  const s = linesState.pinned;
  s.has(id) ? s.delete(id) : s.add(id);
  linesRestyle();
}

/* Круг «рядом» вокруг выбранной остановки — многоугольник в метрах */
function linesNearDraw() {
  if (!mapReady) return;
  const sel = linesState.sel;
  if (!sel) { map.getSource("near")?.setData(fc([])); return; }
  const [la, lo] = sel.stop.p, k = 111320, c = Math.cos((la * Math.PI) / 180);
  const ring = Array.from({ length: 65 }, (_, i) => {
    const t = (i / 64) * 2 * Math.PI;
    return [lo + (sel.r * Math.sin(t)) / (k * c), la + (sel.r * Math.cos(t)) / k];
  });
  map.getSource("near")?.setData(fc([{ type: "Feature", geometry: { type: "Polygon", coordinates: [ring] }, properties: {} }]));
}

/* Снять выбор остановки (круг и попап), не трогая закреплённые маршруты и фильтр «рядом». */
function linesDropSel() {
  linesState.sel = null;
  linesNearDraw();
  if (linesState.popup) { const p = linesState.popup; linesState.popup = null; p.remove(); }
}

/* Сбросить всё: выбор, закрепление и фильтр «рядом». */
function linesClearAll() {
  linesDropSel();
  linesState.pinned.clear();
  if (state.near) { state.near = null; apply(); }
  linesRestyle();
}

function stopSelect(s, r, quiet = false) {
  const keep = linesState.sel?.stop === s ? linesState.sel.r : NEAR_R[0];
  const rad = r || keep;
  linesState.sel = { stop: s, r: rad };
  linesState.pinned = new Set(s.r);
  if (state.near) { state.near = { p: s.p, r: rad, name: s.n }; apply(); }   // фильтр следует за выбором
  linesNearDraw();
  linesRestyle();
  if (quiet) return;
  // Прежний попап снимаем ДО открытия нового: его close не должен принять
  // за «пользователь закрыл попап» (иначе выбор сбросился бы на каждом переходе)
  const old = linesState.popup;
  linesState.popup = null;
  old?.remove();
  const pop = new ml.Popup({ offset: 8, className: "stop-popup", maxWidth: "260px" })
    .setLngLat([s.p[1], s.p[0]]).setDOMContent(stopPopupNode(s));
  pop.on("close", () => {
    if (linesState.popup !== pop) return;
    linesState.popup = null;
    if (!state.near) linesClearAll();   // закрыл попап, а фильтр «рядом» не включал — выбор снимается целиком
  });
  linesState.popup = pop;
  pop.addTo(map);
}

function stopPopupNode(s) {
  const r = linesState.sel.r;
  // считаем по base — выдаче со всеми фильтрами КРОМЕ «рядом», иначе включённый фильтр обнулил бы счётчик
  const n = state.base.filter((a) => nearOk(a, { p: s.p, r })).length;
  const chips = s.r.map((id) =>
    `<button type="button" class="lchip${linesState.pinned.has(id) ? " on" : ""}" data-r="${esc(id)}"
       style="--c:${esc(onMap(linesState.color[id] || "#e08300"))}" aria-pressed="${linesState.pinned.has(id)}">${esc(id)}</button>`).join("");
  const box = document.createElement("div");
  box.className = "stop-pop";
  const constr = s.t === "metro_construction";
  box.innerHTML = `<small class="stop-kind">${esc(stopKindLabel(s.t))}</small>
    <div class="stop-name">${esc(s.n)}</div>
    ${constr ? `<div class="gap-note">${tr("metro_construction_note")}</div>` : ""}
    ${s.t === "metro_planned" ? `<div class="gap-note">${tr("metro_planned_note")}</div>` : ""}
    <div class="lchips">${chips}</div>
    <div class="seg-r" role="group">${NEAR_R.map((v) =>
      `<button type="button" class="ghost${v === r ? " on" : ""}" data-rad="${v}" aria-pressed="${v === r}">${v} ${tr("m_u")}</button>`).join("")}</div>
    <div class="near-n">${tr("stop_near")}: <b>${nf.format(n)}</b></div>
    <button type="button" class="pop-btn" data-act="near">${tr(state.near ? "near_off" : "near_on")}</button>`;
  box.addEventListener("click", (e) => {
    e.stopPropagation();
    const chip = e.target.closest(".lchip");
    if (chip) return linesPin(chip.dataset.r);
    const rad = e.target.closest("[data-rad]");
    if (rad) return stopSelect(s, +rad.dataset.rad, true);
    if (e.target.closest("[data-act='near']")) {
      state.near = state.near ? null : { p: s.p, r: linesState.sel.r, name: s.n };
      apply();
      linesRestyle();
    }
  });
  return box;
}

// "Трамвай"/"Метро"/"Метро (строится)" — для подсказок линии и остановки и попапа остановки
const stopKindLabel = (t) =>
  tr(t === "metro" ? "metro_w" : t === "metro_construction" ? "metro_construction_w" : t === "metro_planned" ? "metro_planned_w" : t === "rail" ? "rail_w" : "tram_w");

function linesDraw(d) {
  d.routes.forEach((r) => { linesState.kind[r.i] = r.t; linesState.color[r.i] = r.c; });
  linesState.stops = d.stops;
  linesSetData();
}

/* События линий и остановок — один раз (переживают смену стиля) */
function bindLinesEvents() {
  ["lines", "lines-constr"].forEach((id) => {
    hoverTip(id, (f) => `${esc(stopKindLabel(f.properties.t))} ${esc(f.properties.i)}${
      f.properties.n && f.properties.n !== f.properties.i ? ` · ${esc(f.properties.n)}` : ""}`, { sticky: true });
    map.on("mousemove", id, (e) => {
      const i = e.features?.[0]?.properties?.i;
      if (i && linesState.hover !== i) { linesState.hover = i; linesRestyle(); }
    });
    map.on("mouseleave", id, () => { if (linesState.hover) { linesState.hover = null; linesRestyle(); } });
    map.on("click", id, (e) => {
      if (map.queryRenderedFeatures(e.point, { layers: ["stops"] }).length) return;   // клик по остановке над линией — её
      const i = e.features?.[0]?.properties?.i;
      if (i) linesPin(i);
    });
  });
  hoverTip("stops", (f) => {
    const s = linesState.stops[f.properties.k];
    return s ? `${esc(stopKindLabel(s.t))} · ${esc(s.n)} · ${s.r.map(esc).join(", ")}` : "";
  });
  map.on("click", "stops", (e) => {
    const s = linesState.stops[e.features?.[0]?.properties?.k];
    if (s) stopSelect(s);
  });
}

/* Смена языка: подсказки строятся на лету, перерисовывать нечего — только панель */
function linesRedraw() {
  if (!linesState.data) return;
  linesRestyle();
}

function linesEnsure() {
  if (linesState.data || linesState.loading) return;
  linesState.loading = fetch(`data/lines.json?v=${BUILD}`).then((r) => r.json())
    .then((d) => { linesState.data = d; linesDraw(d); linesRestyle(); })
    .catch(() => { linesState.loading = null; });   // сеть упала — повторим при следующем включении
}

/* Включили/выключили трамвай/метро/стройку */
function linesKindsChanged() {
  if (kindsOn().length) linesEnsure();
  // выключили слой — выбор его остановки теряет смысл
  if (linesState.sel && !layerOn.has(linesState.sel.stop.t)) linesDropSel();
  linesRestyle();
}

/* Панель номеров маршрутов. Видна, пока включён хотя бы один из слоёв. */
function linesPanel() {
  const box = linesState.box;
  if (!box) return;
  const d = linesState.data;
  const on = kindsOn();
  if (!d || !on.length) { box.style.display = "none"; return; }
  const chips = d.routes
    .filter((r) => on.includes(r.t))
    .map((r) => {
      const pin = linesState.pinned.has(r.i);
      return `<button type="button" class="lchip${pin ? " on" : ""}" data-r="${esc(r.i)}"
                style="--c:${esc(onMap(r.c))}" aria-pressed="${pin}" title="${esc(r.n)}">${esc(r.i)}</button>`;
    }).join("");
  box.innerHTML = `${legHead("lines", tr("lines_title"))}<div class="lchips">${chips}</div>
    <small>${tr("lines_hint")}${linesState.pinned.size || state.near
      ? ` · <a href="#" data-clear="1">${tr("lines_clear")}</a>` : ""}</small>`;
  legApply(box);
  box.style.display = "";
  legLayout();
}

/* Простой контрол MapLibre: готовый DOM-узел в углу карты */
const boxControl = (box) => ({ onAdd: () => box, onRemove: () => box.remove() });

function initLines() {
  const box = linesState.box = document.createElement("div");
  box.className = "legend lines-box maplibregl-ctrl";
  box.style.display = "none";
  legClicks(box);
  ["wheel", "touchstart", "mousedown", "dblclick"].forEach((t) => box.addEventListener(t, (e) => e.stopPropagation()));
  box.addEventListener("click", (e) => {
    e.stopPropagation();          // панель перерисовывается в обработчике — см. попап остановки
    const chip = e.target.closest(".lchip");
    if (chip) return linesPin(chip.dataset.r);
    if (e.target.closest("[data-clear]")) { e.preventDefault(); linesClearAll(); }
  });
  map.addControl(boxControl(box), "bottom-left");
}

/* ── Легенды ──────────────────────────────────────────────────────────────────
 * PM2.5 — шкала из шести полос, где цвет и есть смысл, без подписи её не прочитать.
 * Шум — семь полос карты города. Каждая видна, пока включён соответствующий слой. */
const legends = { air: null, noise: null };

/* Обе легенды — в одном контроле рядом, а не друг над другом: столбиком они
 * поднимались до панели слоёв и залезали на неё (18.10.2026) */
let legendsBox = null, legendsCtl = null;
function initLegends() {
  legendsBox = document.createElement("div");
  legendsBox.className = "legends maplibregl-ctrl";
  legendsCtl = boxControl(legendsBox);
  const mk = (html) => {
    const box = document.createElement("div");
    box.className = "legend";
    legClicks(box);
    return { box, html, on: false };
  };
  legends.air = mk(() => legHead("air", tr("legend")) + [
    ["0–13", 0], ["13–35", 1], ["35–55", 2], ["55–75", 3], ["75–110", 4], ["&gt;110", 5],
  ].map(([lbl, i]) => `<span><i style="background:${PM25_BANDS[i][1]}"></i>${lbl}</span>`).join(""));
  legends.noise = mk(() => legHead("noise", `${tr("noise_leg")} · ${tr(noiseSel.night ? "per_night" : "per_day")}`) +
    NOISE_BANDS.map(([lbl, c]) => `<span><i style="background:${c}"></i>${lbl}</span>`).join(""));
}

/* Свернуть легенду до заголовка (20.10.2026, юзер: «сворачивание окон с легендой»).
 * Заголовок — кнопка «▾/▸»; свёрнутые — в localStorage, на телефоне по умолчанию свёрнуты:
 * легенды и «Линии» закрывали там треть карты. */
const LEG_KEY = "wf_leg_min";
function legMin() {
  try { const v = localStorage.getItem(LEG_KEY); if (v != null) return new Set(JSON.parse(v)); } catch (e) { /* приватный режим */ }
  return new Set(matchMedia("(max-width: 640px)").matches ? ["air", "noise", "lines"] : []);
}
function legHead(key, title) {
  const min = legMin().has(key);
  return `<button type="button" class="leg-head" data-leg="${key}" aria-expanded="${!min}">${esc(title)}<span aria-hidden="true">${min ? "▸" : "▾"}</span></button>`;
}
function legApply(box) {
  const h = box.querySelector(".leg-head");
  if (h) box.classList.toggle("legend--min", legMin().has(h.dataset.leg));
}
function legClicks(box) {
  box.addEventListener("click", (e) => {
    const h = e.target.closest(".leg-head");
    if (!h) return;
    e.stopPropagation();
    const set = legMin(), k = h.dataset.leg;
    set.has(k) ? set.delete(k) : set.add(k);
    try { localStorage.setItem(LEG_KEY, JSON.stringify([...set])); } catch (err) { /* без памяти — только до перезагрузки */ }
    box.classList.toggle("legend--min", set.has(k));
    h.setAttribute("aria-expanded", String(!set.has(k)));
    h.lastElementChild.textContent = set.has(k) ? "▸" : "▾";
    legLayout();
  }, true);
}

/* Легенды шума и PM2.5 — внизу, в одну линию с «Линиями», слева от кнопок зума (юзер 20.10).
 * Если при этом налезают на «Линии» (узкий экран, развёрнутые номера) — встают над ними. */
function legLayout() {
  if (!legendsBox) return;
  legendsBox.style.bottom = "";
  const lb = linesState.box;
  if (!legendsCtl?._on || !lb || lb.style.display === "none") return;
  const a = lb.getBoundingClientRect(), b = legendsBox.getBoundingClientRect();
  if (b.left < a.right + 6) legendsBox.style.bottom = `${Math.ceil(a.height) + 10}px`;
}

/* force — пересобрать текст (сменился язык или период шума), иначе только показать/спрятать */
function refreshLegends(force = false) {
  if (!legends.air || !map) return;
  const airOn = layerDefs.some((d) => (d.key === "gios" || d.key === "airly") && layerOn.has(d.key));
  [[legends.noise, !!noiseSel.src], [legends.air, airOn]].forEach(([lg, on]) => {
    if (on && (force || !lg.on)) { lg.box.innerHTML = lg.html(); legApply(lg.box); }
    if (on && !lg.on) { legendsBox.append(lg.box); lg.on = true; }
    if (!on && lg.on) { lg.box.remove(); lg.on = false; }
  });
  const any = legends.air.on || legends.noise.on;
  if (any && !legendsCtl._on) { map.addControl(legendsCtl, "bottom-right"); legendsCtl._on = true; }
  if (!any && legendsCtl._on) { map.removeControl(legendsCtl); legendsCtl._on = false; }
  legLayout();
}

/* Рисуем ВСЕ отфильтрованные квартиры, без потолка: карта обязана показывать то же,
 * что список (раньше slice(0, 800) выглядел как баг — центр «пропадал»). Две
 * тысячи точек для MapLibre — пустяк: один слой на видеокарте. Размер у всех
 * одинаковый (18.10.2026; раньше рос с рейтингом). */
const aptById = new Map();
function renderMarkers() {
  aptById.clear();
  state.shown.forEach((a) => aptById.set(a.id, a));
  if (!mapReady) return;
  map.getSource("apts")?.setData(fc(state.shown.filter((a) => a.lat != null)
    .map((a) => pt(a.lon, a.lat, { id: a.id, sc: a.sc ?? 0 }))));
  // после смены фильтров — гало вернуть (или убрать, если квартира выпала)
  highlightMarker(state.activeId);
}

// ── Выбор квартиры ──────────────────────────────────────────────────────────
/* ── Выбор квартиры ──────────────────────────────────────────────────────────
 * Три вещи должны совпасть: карточка в списке подсвечена, список прокручен к
 * ней, маркер на карте выделен. Раньше каждая работала через раз. */
/* Закрыть шторку без управления фокусом — для АВТОМАТИЧЕСКИХ закрытий (квартира
 * выпала из фильтра в apply()), где человек мог в этот момент печатать в поле
 * фильтра: красть у него фокус обратно на карточку было бы грубо. */
function hideSheetOnly() {
  $("#sheet").hidden = true;
  galleryKeys = null;      // галерея закрытой карточки не должна ловить стрелки
}

/* Закрыть шторку по ДЕЙСТВИЮ человека (крестик, Escape) — с возвратом фокуса
 * туда, откуда шторку открыли (a11y). Ищем карточку ЗАНОВО по id — см.
 * комментарий у sheetOpenerId: сохранённая ссылка на узел была бы уже
 * отсоединена. Если карточка сейчас вне окна виртуализации (проскроллили) —
 * просто не найдётся, и фокус остаётся как есть — не ошибка. */
function closeSheet() {
  hideSheetOnly();
  if (sheetOpenerId) {
    const el = document.querySelector(`.card[data-id="${CSS.escape(sheetOpenerId)}"]`);
    if (el) el.focus();
  }
  sheetOpenerId = null;
}

function select(id, fromList) {
  const a = state.all.find((x) => x.id === id);
  if (!a) {                     // снятая с продажи (строка внизу «Избранного») — только карточка
    const ar = archIndex()?.get(id);
    if (ar) openSheet(ar);
    return;                     // неизвестный id — не портим state раньше проверки
  }
  state.activeId = id;

  if (fromList && a.lat != null && mapReady) {
    map.easeTo({ center: [a.lon, a.lat], zoom: Math.max(map.getZoom(), 15), duration: 400 });
  }
  // Прокручиваем не «когда клик был с карты», а когда карточки НЕ ВИДНО.
  // Клик из списка обычно виден и так, но после сравнения, смены языка или
  // возврата фильтра выбранная может оказаться далеко за пределами окна.
  scrollListTo(id);

  // Подсветку карточки даёт ПЕРЕРИСОВКА окна, а не правка атрибута: карточки
  // может не быть в DOM (виртуализация), а toggleAttribute ставил data-active=""
  // вместо "1", и селектор [data-active="1"] не срабатывал вовсе
  paintWindow();
  highlightMarker(id);
  openSheet(a);
}

/* Прокрутка к карточке по НОМЕРУ в выдаче, а не через scrollIntoView: нужного
 * узла в DOM обычно нет — в окне живут ~40 карточек из двух тысяч. Считаем
 * позицию сами и перерисовываем окно.
 *
 * На телефоне #list — вкладка (см. showTab): пока активна «Карта», у списка
 * clientHeight===0 (аудит «мелкое и мёртвое», веб-1). Присвоение scrollTop
 * элементу нулевой высоты браузер тихо игнорирует — команда терялась
 * бесследно, и при возврате на «Список» карточка оставалась не докручена.
 * Раньше не чинил вслепую (нужен реальный телефон) — но баг чисто
 * логический: он воспроизводится и в headless-браузере через
 * clientHeight:0, реальное устройство тут ни при чём. Фикс — не считать
 * позицию по нулевой высоте, а запомнить цель и докрутить, когда вкладка
 * «Список» станет видимой снова (см. showTab("list")). */
let pendingScrollId = null;

function scrollListTo(id) {
  const host = $("#list");
  const idx = state.shown.findIndex((x) => x.id === id);
  if (idx < 0) return;                       // квартира вне текущего фильтра

  if (host.clientHeight === 0) {             // список сейчас скрыт (вкладка «Карта»)
    pendingScrollId = id;
    return;
  }

  const top = idx * rowH;
  const seen = host.scrollTop;
  // уже целиком в окне — не дёргаем прокрутку под рукой у человека
  if (top >= seen && top + rowH <= seen + host.clientHeight) return;

  host.scrollTop = Math.max(0, top - (host.clientHeight - rowH) / 2);
}

/* Выделение маркера. При двух тысячах точек «где я» иначе не понять.
 * Гало — отдельный круг под точками (слой halo): увеличить саму точку мало,
 * в плотной застройке она теряется среди соседей. */
function highlightMarker(id) {
  if (!mapReady) return;
  const a = id && aptById.get(id);
  map.getSource("halo")?.setData(fc(a && a.lat != null ? [pt(a.lon, a.lat)] : []));
}

/* Минуты до личного адреса. В layers.json это {токен: {id: минуты}} — токен
 * один (адрес в config), но структура от старой карты, где их было несколько. */
function commute(id) {
  const tt = state.layers?.tt;
  if (!tt) return null;
  for (const tok in tt) if (tt[tok][id] != null) return tt[tok][id];
  return null;
}

/* ── «Мои места» ─────────────────────────────────────────────────────────────
 * До 3 мест с названием. Адрес → координаты один раз при добавлении
 * (api.py /geocode), время на транспорте до всех квартир — по координатам
 * (/commute-times) и кэшируется в браузере до следующей выгрузки данных
 * (ключ — координаты мест + meta.generated). Хранение: вход по ссылке из
 * бота → профиль на сервере (prefs.places), иначе localStorage (wf_places).
 * Первое место — для фильтра «≤ N мин» (#f-tmax читает commute()). */
async function loadPlaces() {
  let places = null;
  const prof = await syncProfile();   // вход по ссылке из бота: профиль + избранное/скрытые с ботом
  if (prof) {
    state.profilePrefs = prof.prefs;
    state.bot = prof.bot;
    refreshNotify();
    places = state.profilePrefs.places
      || (state.profilePrefs.work ? [{ name: tr("f_work"), ...state.profilePrefs.work }] : null);
    if ([10, 15, 20].includes(state.profilePrefs.walk_max)) state.walkMax = state.profilePrefs.walk_max;
    // бот мог прислать своё избранное/скрытые — site-ui.js дописал их в localStorage
    loadHidden(); loadFavorites();
    mergeNotes(prof.prefs?.notes);
    mergeVisited(prof.prefs?.visited);
    mergeWant(prof.prefs);
    relistCarry();
    if (state.all.length) paintWindow();   // строки заметок в карточках списка
  } else if (!profileToken()) {
    $("#menu-status").dataset.i18n = "profile_device";   // ссылка отозвана — уже без входа
    $("#menu-status").textContent = tr("profile_device");
    $("#menu-login-foot").hidden = false;
  }
  if (!places) {
    try { places = JSON.parse(localStorage.getItem("wf_places") || "[]"); } catch { places = []; }
  }
  state.places = Array.isArray(places) ? places.slice(0, 3) : [];
  renderPlaces();
  await refreshPlaceTimes();
}

async function savePlaces() {
  try { localStorage.setItem("wf_places", JSON.stringify(state.places)); } catch {}
  const tok = profileToken();
  if (!tok || !state.profilePrefs) return;
  const prefs = { ...state.profilePrefs, places: state.places, walk_max: state.walkMax };
  delete prefs.work;   // адрес работы теперь — первое место
  try {
    const r = await fetch(`${API_BASE}/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Profile-Token": tok },
      body: JSON.stringify({ prefs }),
    });
    if (r.ok) state.profilePrefs = (await r.json()).prefs;
  } catch {}
}

async function refreshPlaceTimes() {
  const msg = $("#place-msg");
  if (!state.places.length) {
    state.placeTimes = []; state.placeModes = []; state.placeWalk = []; state.placeAlt = [];
    if (state.layers.tt) delete state.layers.tt.places;
    refreshWorkUI(); apply();
    return;
  }
  const key = JSON.stringify([state.places.map((p) => [(+p.lat).toFixed(5), (+p.lon).toFixed(5)]), BUILD, state.walkMax]);
  let times = null, modes = [], walks = [], alts = [];
  try {
    const c = JSON.parse(localStorage.getItem("wf_ptimes") || "null");
    if (c && c.key === key) { times = c.times; modes = c.modes || []; walks = c.walks || []; alts = c.alts || []; }
  } catch {}
  if (!times) {
    if (msg) msg.textContent = tr("place_times_busy");
    try {
      const r = await fetch(`${API_BASE}/commute-times`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ places: state.places.map((p) => ({ lat: p.lat, lon: p.lon })), walk_max: state.walkMax }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { if (msg) msg.textContent = data.error || tr("place_err"); return; }
      times = data.times;
      modes = data.modes || []; walks = data.walk || []; alts = data.alt || [];
      try { localStorage.setItem("wf_ptimes", JSON.stringify({ key, times, modes, walks, alts })); } catch {}
    } catch { if (msg) msg.textContent = tr("place_err"); return; }
    if (msg) msg.textContent = "";
  }
  state.placeTimes = times;
  state.placeModes = modes; state.placeWalk = walks; state.placeAlt = alts;
  // фильтр «≤ N мин» и commute() читают state.layers.tt — там только первое место
  state.layers.tt = { places: times[0] };
  const f = $("#f-tmax");
  f.disabled = false;
  $("#commute-field")?.removeAttribute("hidden");
  rowMeasuredNormal = 0; rowMeasuredGap = 0;   // в карточке появилась/сменилась строка
  refreshWorkUI(); apply();
  // открытая карточка (например, по ссылке ?card= из бота) успела открыться раньше,
  // чем пришло время до мест, — перерисовываем, иначе строки «Работа» в ней нет
  if (!$("#sheet").hidden && state.activeId) { const a = findApt(state.activeId); if (a) openSheet(a); }
  reportRerender?.();   // отчёт: время до «Моих мест» пришло позже
}

/* Каким транспортом время до места (17.10.2026): значки в строке карточки,
 * словами — в «Сводке». Старый ответ сервера без modes — ничего не показываем.
 * Значки — свои SVG (эмодзи на ноутбуке не разобрать — юзер); автобус — только
 * запасной вариант, когда иначе не доехать: текстом «(автобус)». */
const MODE_SVG = {
  m: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M4.6 11.2V5l3.4 4 3.4-4v6.2" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  t: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 1.5h4M8 1.5v2.2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><rect x="3.6" y="3.7" width="8.8" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.6 8h8.8" stroke="currentColor" stroke-width="1.4"/><path d="M5 14.8l1-2.1M11 14.8l-1-2.1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  r: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 12V5.5C3.5 3 5.5 1.8 8 1.8s4.5 1.2 4.5 3.7V12z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><path d="M3.5 7.6h9" stroke="currentColor" stroke-width="1.4"/><circle cx="5.8" cy="10" r=".9" fill="currentColor"/><circle cx="10.2" cy="10" r=".9" fill="currentColor"/><path d="M5 14.6l1-2.4M11 14.6l-1-2.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  w: '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8.6" cy="2.6" r="1.5" fill="currentColor"/><path d="M8.3 5.2 6.6 9.6l2.2 1.8.9 3.4M6.6 9.6l-1.3 5.2M8.3 5.2l2.4 2.4 2 .4M8.3 5.2 5.8 6.6 4.6 8.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
function placeModes(i, id) {
  const m = state.placeModes[i]?.[id];
  return typeof m === "string" ? m : null;
}
function modeIcons(m) {
  if (m == null) return "";
  const rail = [...m].filter((c) => MODE_SVG[c] && c !== "w");
  const icons = (rail.length ? rail : m.includes("b") ? [] : ["w"]).map((c) => MODE_SVG[c]).join("");
  return icons + (m.includes("b") ? ` <span class="mode-bus">(${tr("mode_w").b})</span>` : "");
}
const modeWords = (m) => m == null ? tr("transit") : (m ? [...m].map((c) => tr("mode_w")[c]).join(" + ") : tr("mode_w")[""]);

function refreshWorkUI() {
  const pl = state.places[0];
  const host = $("#work-place");
  if (host) {
    host.textContent = "";
    if (pl) {
      const b = document.createElement("b");
      b.textContent = pl.name;
      host.append(b, ` · ${pl.q ? pl.q + " · " : ""}${tr("transit")}`);
    } else {
      host.textContent = tr("places_none");
    }
  }
  if (!pl) $("#commute-field")?.setAttribute("hidden", "");
}

function renderPlaces() {
  const list = $("#places-list");
  if (!list) return;
  list.textContent = "";
  state.places.forEach((pl, i) => {
    const row = document.createElement("div");
    row.className = "ds-box places-row";
    const txt = document.createElement("div");
    txt.className = "places-row__text";
    const n = document.createElement("b"); n.textContent = pl.name;
    const q = document.createElement("span"); q.className = "ds-note"; q.textContent = pl.q || "";
    txt.append(n, q);
    row.appendChild(txt);
    if (i === 0) {
      const tag = document.createElement("span");
      tag.className = "ds-tag"; tag.textContent = tr("place_filter");
      row.appendChild(tag);
    } else {
      const up = document.createElement("button");
      up.type = "button"; up.className = "ds-btn ds-btn--link"; up.textContent = tr("place_make_first");
      up.onclick = async () => { state.places.unshift(...state.places.splice(i, 1)); await placesChanged(); };
      row.appendChild(up);
    }
    const del = document.createElement("button");
    del.type = "button"; del.className = "ds-icon-btn"; del.textContent = "×";
    del.setAttribute("aria-label", `${tr("place_remove")}: ${pl.name}`);
    del.onclick = async () => { state.places.splice(i, 1); await placesChanged(); };
    row.appendChild(del);
    list.appendChild(row);
  });
  $("#places-add").hidden = state.places.length >= 3;
  const wm = $("#walk-max");
  const wt = $("#walk-max-t");   // «?» после заголовка: data-i18n перезаписывает textContent — кнопку вне h3
  if (wt && !wt.nextElementSibling?.classList.contains("rh-btn")) wt.insertAdjacentHTML("afterend", rateHelpBtn(false, "commute"));
  if (wm) {
    wm.textContent = "";
    [10, 15, 20].forEach((n) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "ds-chip"; b.textContent = tr("walk_max_v")(n);
      b.setAttribute("aria-pressed", String(state.walkMax === n));
      b.onclick = async () => {
        if (state.walkMax === n) return;
        state.walkMax = n;
        try { localStorage.setItem("wf_walk_max", String(n)); } catch {}
        renderPlaces();
        await savePlaces();
        await refreshPlaceTimes();
      };
      wm.appendChild(b);
    });
  }
  const badge = $("#menu-places .menu-badge");
  badge.hidden = !state.places.length;
  badge.textContent = String(state.places.length);
}

async function placesChanged() {
  renderPlaces();
  await savePlaces();
  await refreshPlaceTimes();
}

function setPlacesOpen(on) {
  $("#places-dlg").hidden = !on;
  $("#places-overlay").hidden = !on;
  if (on) { closeAllFilterUI(); renderPlaces(); $("#place-name").focus(); }
}

function bindPlaces() {
  $("#open-places").onclick = (e) => { e.stopPropagation(); setPlacesOpen(true); };
  $("#places-close").onclick = () => setPlacesOpen(false);
  $("#places-overlay").onclick = () => setPlacesOpen(false);
  $("#places-dlg").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#places-dlg").hidden) setPlacesOpen(false); });
  $("#place-add").onclick = async () => {
    const msg = $("#place-msg");
    const addr = $("#place-addr").value.trim();
    if (!addr) { msg.textContent = tr("place_need_addr"); return; }
    if (state.places.length >= 3) { msg.textContent = tr("place_max"); return; }
    const btn = $("#place-add");
    btn.disabled = true; msg.textContent = tr("place_busy");
    try {
      const r = await fetch(`${API_BASE}/geocode`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ address: addr }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { msg.textContent = data.error || tr("place_err"); return; }
      state.places.push({ name: $("#place-name").value.trim() || tr("place_default"),
                          q: addr, lat: data.lat, lon: data.lon });
      $("#place-name").value = ""; $("#place-addr").value = ""; msg.textContent = "";
      await placesChanged();
    } catch {
      msg.textContent = tr("place_err");
    } finally {
      btn.disabled = false;
    }
  };
}

/* ── «Уведомлять по этому поиску» ─────────────────────────────────────────────
 * Кнопка над списком сохраняет текущие фильтры сайта в бот (POST
 * /profile/search → бот применит и подтвердит в Telegram). Бот хранит поиск
 * своими полями, сервер отдаёт его и параметрами сайта (bot.query) — их и
 * сравниваем. Макет — холст «Warsaw Flats — Мои места и профиль», страница
 * «Уведомлять по поиску». Состояния: без входа → «Войти через Telegram»;
 * поиск ≠ боту → «Сохранить в бот»; совпадает и подписан → «Уведомления вкл.». */
const NTF_LIST = new Set(["rooms", "mt", "ut", "cs", "district"]);

/* Параметры поиска в сравнимом виде: числа — числами, списки — отсортированы */
function normQuery(q) {
  const out = {};
  Object.entries(q).forEach(([k, v]) => {
    if (v == null || v === "") return;
    out[k] = NTF_LIST.has(k) ? String(v).split(",").filter(Boolean).sort().join(",") : +v;
  });
  return JSON.stringify(Object.keys(out).sort().map((k) => [k, out[k]]));
}

/* Сводка поиска для окна: те же подписи, что у чипов и кнопок фильтров */
function querySummary(q) {
  const n = (k) => (q[k] == null || q[k] === "" ? null : +q[k]);
  const list = (k) => String(q[k] || "").split(",").filter(Boolean);
  const bits = [];
  const rooms = list("rooms").sort().map((r) => (r === "5" ? "5+" : r));
  if (rooms.length) bits.push(tr("ntf_rooms")(rooms.join(", ")));
  [[tr("ntf_price"), "price_min", "price", tr("k_u")], [tr("f_area2"), "area", "area_max", tr("m2")],
   [tr("f_year2"), "year", "year_max", ""], [tr("f_score"), "score", "score_max", ""]]
    .forEach(([label, lo, hi, unit]) => { const t = rangeText(label, n(lo), n(hi), unit); if (t) bits.push(t); });
  Object.keys(q).filter((k) => /^ax\d+$/.test(k)).sort()
    .forEach((k) => bits.push(`${axisName(+k.slice(2))} ≥ ${q[k]}`));
  const d = list("district");
  if (d.length) bits.push(d.length <= 2 ? d.map(distName).join(", ") : tr("ntf_districts")(d.length));
  [["mt", LABEL.mt], ["ut", LABEL.ut], ["cs", LABEL.cs]].forEach(([k, labels]) =>
    list(k).forEach((v) => bits.push(labels[v] || v)));
  if (n("commute") != null) bits.push(`${state.places[0]?.name || tr("f_work")} ≤ ${n("commute")} ${tr("min")}`);
  return bits;
}

function currentQuery() { return Object.fromEntries(filterParams()); }

/* Совпадает ли поиск сайта с ботом и включены ли уведомления */
function notifyOn() {
  const bot = state.bot;
  return !!bot?.subscribed && normQuery(currentQuery()) === normQuery(bot.query || {});
}

function refreshNotify() {
  const on = notifyOn();
  const btn = $("#notify-btn");
  btn.setAttribute("aria-pressed", String(on));
  $("#notify-btn-t").dataset.i18n = on ? "ntf_on" : "ntf_btn";
  $("#notify-btn-t").textContent = tr(on ? "ntf_on" : "ntf_btn");
  if (!$("#notify-pop").hidden) renderNotify();   // окно открыто — фильтры или язык сменились
}

function renderNotify() {
  const logged = !!state.bot, on = notifyOn();
  const bits = querySummary(currentQuery());
  $("#notify-t").textContent = tr(on ? "ntf_on_t" : "ntf_t");
  $("#notify-lead").textContent = tr(!logged ? "ntf_lead_out" : on ? "ntf_lead_on" : "ntf_lead");
  $("#notify-sum").textContent = bits.length ? bits.join(" · ") : tr("ntf_all");
  // «Сейчас в боте»: что пропадёт при сохранении — зачёркнуто
  const diff = $("#notify-diff");
  const botBits = logged && !on ? querySummary(state.bot.query || {}) : [];
  diff.hidden = !botBits.length;
  diff.replaceChildren(document.createTextNode(`${tr("ntf_now")} `));
  botBits.forEach((b, i) => {
    if (i) diff.append(" · ");
    const el = document.createElement(bits.includes(b) ? "span" : "s");
    el.textContent = b;
    diff.append(el);
  });
  $("#notify-note").textContent = tr(!logged ? "ntf_login_note" : on ? "ntf_on_note"
    : state.bot.subscribed ? "ntf_when" : "ntf_off_note");
  $("#notify-sec").textContent = tr(on ? "ntf_off" : "ntf_cancel");
  $("#notify-main").textContent = tr(on ? "done" : "ntf_save");
  $("#notify-main").hidden = !logged;
  $("#notify-login").hidden = logged;
}

function setNotifyOpen(open) {
  const pop = $("#notify-pop"), btn = $("#notify-btn");
  pop.hidden = !open;
  $("#notify-overlay").hidden = !open;
  btn.setAttribute("aria-expanded", String(open));
  if (!open) return;
  closeAllFilterUI();
  $("#notify-err").hidden = true;
  renderNotify();
  // под кнопкой, левым краем немного левее неё, но не за край экрана;
  // на телефоне CSS делает из окна шторку снизу и эти координаты не действуют
  const r = btn.getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${Math.max(12, Math.min(r.left - 60, innerWidth - pop.offsetWidth - 12))}px`;
  (state.bot ? $("#notify-main") : $("#notify-login")).focus();
}

async function postSearch(body) {
  const r = await fetch(`${API_BASE}/profile/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Profile-Token": profileToken() },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || !data.ok) throw new Error(data.error || "");
  return data;
}

/* ── Короткие ссылки (19.10.2026) ────────────────────────────────────────────
 * «Поделиться» отдаёт ссылку вида app.html?s=k3J9xQ: строка поиска хранится в
 * 6.valuate (/short), личное (?t= — ключ профиля, iso) туда не попадает. Сервер
 * недоступен — делимся полной ссылкой, тоже без личного. */
// «Отчёт» в карточке (19.10.2026) — вместо значка «Поделиться»: делятся отчётом, в его шапке есть ссылка на объявление
const REPORT_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/><path d="M8 13h8M8 17h5"/></svg>`;
const SHARE_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7"/><path d="M16 6l-4-4-4 4"/><path d="M12 2v13"/></svg>`;

function shareQuery() {
  const p = filterParams();
  if (state.sort !== "p") p.set("sort", state.sort);
  if (state.want.length) p.set("want", state.want.join(","));
  p.set("lang", LANG);
  return p;
}

async function shareOut(url, title) {
  // телефон — системное меню (WhatsApp, Telegram…); компьютер — в буфер обмена
  if (navigator.share && matchMedia("(pointer: coarse)").matches) {
    try { await navigator.share({ url, title }); return; } catch (e) { if (e.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(url); toast(tr("share_copied")); }
  catch { prompt(tr("share_copy"), url); }
}

/** Короткая ссылка ?s=<код> на строку q (/short); сервер спит — полная ссылка. */
async function shortUrl(q) {
  const base = `${location.origin}${location.pathname}`;
  try {
    const r = await fetch(`${API_BASE}/short`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: q.toString() }), signal: AbortSignal.timeout(5000),
    });
    const j = r.ok ? await r.json() : null;
    if (j?.code) return `${base}?s=${j.code}`;
  } catch {}
  return `${base}?${q}`;
}

async function shareSearch() {
  shareOut(await shortUrl(shareQuery()), tr("share_title"));
}

/** ?s=<код> → сохранённая строка поиска в адресе (до readUrl). Не нашлась или
 *  сервер спит — открываем обычный поиск и говорим об этом. */
async function resolveShort() {
  const cur = new URLSearchParams(location.search);
  const code = cur.get("s");
  if (!code) return;
  let q = null;
  try {
    const r = await fetch(`${API_BASE}/short/${encodeURIComponent(code)}`, { signal: AbortSignal.timeout(5000) });
    q = r.ok ? (await r.json()).q : null;
  } catch {}
  if (q == null) { cur.delete("s"); history.replaceState(null, "", `?${cur}`); toast(tr("share_gone")); return; }
  const p = new URLSearchParams(q);
  if (p.get("lang") && p.get("lang") !== LANG) { location.replace(`?${p}`); await new Promise(() => {}); }
  history.replaceState(null, "", `?${p}`);
}

function bindNotify() {
  const sb = $("#share-btn");
  if (sb) { sb.addEventListener("click", shareSearch); sb.setAttribute("aria-label", tr("share_btn")); sb.title = tr("share_btn"); }
  $("#notify-btn").onclick = (e) => { e.stopPropagation(); setNotifyOpen($("#notify-pop").hidden); };
  $("#notify-overlay").onclick = () => setNotifyOpen(false);
  $("#notify-pop").addEventListener("click", (e) => e.stopPropagation());
  document.addEventListener("click", () => { if (!$("#notify-pop").hidden) setNotifyOpen(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("#notify-pop").hidden) { setNotifyOpen(false); $("#notify-btn").focus(); }
  });
  const busy = async (btn, body, after) => {
    const err = $("#notify-err"), label = btn.textContent;
    btn.disabled = true; btn.textContent = tr("ntf_saving"); err.hidden = true;
    try {
      after(await postSearch(body));
      setNotifyOpen(false);
      refreshNotify();
    } catch (e) {
      err.textContent = e.message || tr("ntf_err");
      err.hidden = false;
      btn.textContent = label;
    } finally {
      btn.disabled = false;
    }
  };
  $("#notify-main").onclick = () => {
    if (notifyOn()) { setNotifyOpen(false); return; }   // «Готово»
    busy($("#notify-main"), { query: currentQuery() },
         (d) => { state.bot.query = d.query; state.bot.subscribed = true; });
  };
  $("#notify-sec").onclick = () => {
    if (!notifyOn()) { setNotifyOpen(false); return; }  // «Отмена»
    busy($("#notify-sec"), { subscribe: false }, () => { state.bot.subscribed = false; });
  };
}

/* ── Сравнение двух квартир ──────────────────────────────────────────────────
 * Только две: при двух колонках таблица влезает в шторку и отдельный экран не
 * нужен. Расстояния до GIS-слоёв сюда НЕ идут — там 34 строки, они утопят
 * то, ради чего сравнение затевалось.
 *
 * Ход: в карточке жмём «Сравнить» — квартира откладывается. Открываем вторую,
 * там уже «Сравнить с уже выбранной».
 *
 * Направление «лучше» задано ЯВНО и только там, где оно объективно. У этажа,
 * года, района, продавца его нет: пометка «лучше» на строке «этаж» — это
 * таблица, которая уверенно врёт. Площадь тоже без направления — больше метров
 * за большую цену не лучше; направление даёт цена за м², она в списке есть. */
const CMP_ROWS = [
  ["f_price",    (a) => a.p,            "min", (v) => money(v)],
  ["f_ppm",      (a) => a.ppm,          "min", (v) => `${nf.format(Math.round(v))} ${tr("ppm_u")}`],
  ["f_own",      (a) => ownCost(a)?.total, "min", (v) => `~${nf.format(Math.round(v))} ${tr("mo")}`],
  ["fair",       (a) => a.fp,           "min", (v) => `${v > 0 ? "+" : ""}${Math.round(v)}%`],
  ["rating",     (a) => a.sc,           "max", (v) => Math.round(v)],
  ["f_area2",    (a) => a.a,            null,  (v) => num(v, " " + tr("m2"))],
  ["f_rooms2",   (a) => a.r,            null,  (v) => v],
  ["f_floor",    (a) => a.fl,           null,  (v) => v],
  ["f_year2",    (a) => a.by,           null,  (v) => v],
  ["f_district", (a) => a.d,            null,  (v) => v],
  ["f_seller2",  (a) => LABEL.ut[a.ut], null,  (v) => v],
  ["f_market2",  (a) => LABEL.mt[a.mt], null,  (v) => v],
  ["f_cond2",    (a) => LABEL.cs[a.cs], null,  (v) => v],
  ["f_commute2", (a) => commute(a.id),  "min", (v) => `${v} ${tr("min")}`],
  ["f_metro",    (a) => a.wm,           "min", (v) => `${v} ${tr("min")}`],
  // 0 — «тише 45 дБ», не буквально ноль (см. noiseText) — та же путаница,
  // что была в карточке, здесь же в таблице сравнения (аудит юзера 2026-09-23)
  ["f_noise",    (a) => a.nl,           "min", (v) => v === 0 ? tr("noise_lt") : `${v} ${tr("db")}`],
  ["f_school",   (a) => a.se,           "max", (v) => `${Math.round(v)}%`],
  ["f_since",    (a) => a.seen,         null,  (v) => fmtDate(v)],
];

function cmpHtml(a, b) {
  const axes = (state.meta.axes || []).map((_, i) =>
    [axisName(i), a.ax?.[i], b.ax?.[i], "max", (v) => v]);

  const rows = [
    ...CMP_ROWS.map(([key, get, dir, fmt]) => [tr(key), get(a), get(b), dir, fmt]),
    ...axes,
  ];

  const body = rows.map(([name, va, vb, dir, fmt]) => {
    if (va == null && vb == null) return "";
    const same = va === vb;
    // Кто лучше — только для строк с заданным направлением и разными числами
    let best = 0;
    if (dir && !same && typeof va === "number" && typeof vb === "number") {
      best = dir === "min" ? (va < vb ? 1 : 2) : (va > vb ? 1 : 2);
    }
    const cell = (v, side) =>
      `<td class="${best === side ? "cmp-best" : ""}">${
        v == null ? "—" : esc(String(fmt(v)))}${best === side ? " ★" : ""}</td>`;
    // Одинаковое гасим: сравнение — про то, чем квартиры отличаются
    return `<tr class="${same ? "cmp-same" : ""}">
      <th>${esc(name)}</th>${cell(va, 1)}${cell(vb, 2)}</tr>`;
  }).join("");

  const head = (x) => esc([x.d, x.st].filter(Boolean).join(", ") || tr("noaddr"));
  return `<h2 id="sheet-h2">${esc(tr("cmp_title"))}</h2>
    <table class="cmp">
      <tr><th></th><th>${head(a)}</th><th>${head(b)}</th></tr>
      ${body}
    </table>
    <div class="sheet-links">
      <a href="${esc(safeUrl(a.u))}" target="_blank" rel="noopener">${tr("otodom")} 1</a>
      <a href="${esc(safeUrl(b.u))}" target="_blank" rel="noopener">${tr("otodom")} 2</a>
      <button class="ghost" id="cmp-close">${tr("cmp_back")}</button>
    </div>`;
}

/* Выбор из списка: первый клик откладывает, второй по другой карточке —
 * открывает сравнение, повторный по той же — отменяет. */
function pickCompare(id) {
  // Список не менялся — незачем прыгать наверх и заново мерить высоту строки,
  // поэтому обновляем окно точечно (paintWindow), а не renderList()
  if (state.cmpId === id) { state.cmpId = null; return paintWindow(); }
  if (state.cmpId) {
    // Ищем в ВИДИМОЙ выдаче: отложенная квартира могла выпасть из фильтров
    // (см. сброс state.cmpId в apply()) — сравнивать с тем, чего не видно, нельзя
    const a = state.shown.find((x) => x.id === state.cmpId);
    const b = state.shown.find((x) => x.id === id);
    state.cmpId = null;
    if (a && b) { paintWindow(); return openCompare(a, b); }
    // отложенная квартира устарела — эта карточка становится новым первым выбором
  }
  state.cmpId = id;
  paintWindow();
}

/* Кнопка сравнения. Пусто — «Сравнить» (отложить). Уже отложена другая —
 * «Сравнить с уже выбранной». Отложена ЭТА же — «Отменить сравнение». */
function bindCompare(a) {
  const btn = $("#cmp-btn");
  if (!btn) return;
  // В ВИДИМОЙ выдаче: отложенная квартира могла выпасть из фильтров — тогда
  // «other» не находится, и кнопка ведёт себя как первый пик, а не сравнение с призраком
  const other = state.cmpId && state.cmpId !== a.id
    ? state.shown.find((x) => x.id === state.cmpId) : null;

  btn.textContent = other ? tr("cmp_with")
    : state.cmpId === a.id ? tr("cmp_drop") : tr("cmp_pick");

  btn.onclick = () => {
    if (other) return openCompare(other, a);
    state.cmpId = state.cmpId === a.id ? null : a.id;
    bindCompare(a);
    paintWindow();          // отметка в списке должна совпадать со шторкой, скролл не трогаем
  };
}

function openCompare(a, b) {
  // Опекуна фокуса здесь НЕ трогаем: его должен был поставить вызывающий код
  // (клик по .card-cmp в paintWindow()) ДО того, как что-либо перерисовало
  // список — иначе document.activeElement к этому моменту уже "body" (см.
  // комментарий у openSheet() ниже).
  $("#sheet-body").innerHTML = cmpHtml(a, b);
  $("#sheet").hidden = false;
  $("#sheet-close").focus();
  $("#cmp-close").onclick = () => { state.cmpId = null; openSheet(a); };
}

/* ── Расстояния до GIS-объектов ──────────────────────────────────────────────
 * Из чего сложился рейтинг: ~44 слоя с метрами до ближайшего объекта.
 * Файл data/dist.json пишет export.py (sitedata.build_dist). Весит 3.3 МБ, поэтому грузим лениво, при первом
 * открытии карточки, а не вместе со страницей.
 * Формат записи: [индекс_слоя, метры, название, "lat,lon", минут_пешком];
 * подпись/знак/вес лежат отдельно в dist.layers, чтобы не дублироваться
 * в каждой из ~170 тысяч записей. */
let BUILD = "";     // версия сборки данных (meta.generated) — гасит кеш точечно
let distData = null, remData = null, heavyLoading = null;
// Сортировка «Что рядом» — юзер выбирает между "distance" (по умолчанию,
// ближайшее сверху) и "weight" (как в старой карте: важные слои сверху,
// внутри — ближние). Один режим на всю сессию и на обе секции (плюсы/минусы),
// не привязан к конкретной квартире — так проще и предсказуемее для юзера.
let distSortMode = "distance";
let distTab = null;   // «Что рядом»: открыт список плюсов (pos) / минусов (neg) / ни одного
let photoData = null, photoLoading = null;
let galleryKeys = null;

/* Фото грузим ОТДЕЛЬНО от расстояний: файл 4.2 МБ, и если тянуть его одним
 * пакетом, то блок «Что рядом» ждал бы картинки, хотя нужен раньше. */
/* Планировки (raw.floorPlans) — только для отчёта, отдельным файлом (20.10.2026) */
let planData = null, planLoading = null;
function loadPlans() {
  planLoading ||= fetch(`data/plans.json?v=${BUILD}`)
    .then((r) => r.json())
    .then((d) => (planData = d))
    .catch(() => (planData = {}));
  return planLoading;
}

function loadPhotos() {
  photoLoading ||= fetch(`data/photos.json?v=${BUILD}`)
    .then((r) => r.json())
    .then((d) => (photoData = d))
    .catch(() => (photoData = {}));
  return photoLoading;
}

/* Галерея: крупный кадр + лента миниатюр. Переключение — на самой странице,
 * без модалок: карточка и так узкая, лишний слой поверх мешал бы. */
function galleryHtml(a) {
  const pics = a.ph || photoData?.[a.id];   // у снятой — фото из снимка карточки   // [[полный размер, миниатюра], …] — см. build_photos()
  if (!pics?.length) return a.img ? `<img class="ph-main" src="${esc(a.img)}" alt="" loading="lazy">` : "";
  const many = pics.length > 1;
  const thumbs = !many ? "" : `<div class="ph-strip">${
    pics.map(([, th], i) => `<img src="${esc(th)}" alt="" loading="lazy" data-i="${i}"
                        class="ph-th${i ? "" : " on"}">`).join("")}</div>`;
  // Стрелки только когда есть куда листать; кадры зациклены — с последнего на первый
  const arrows = !many ? "" :
    `<button class="ph-nav prev" data-d="-1" aria-label="←">‹</button>
     <button class="ph-nav next" data-d="1" aria-label="→">›</button>`;
  return `<div class="ph">
    <img class="ph-main" src="${esc(pics[0][0])}" alt="" loading="lazy">
    ${arrows}
    ${many ? `<div class="ph-n"><span>1</span> / ${pics.length}</div>` : ""}
    ${thumbs}
  </div>`;
}

/* Клик по миниатюре меняет крупный кадр. Вешаем один обработчик на контейнер:
 * карточка перерисовывается целиком, и переподписываться на каждую картинку
 * пришлось бы каждый раз.
 *
 * Миниатюры — отдельные маленькие URL (poля "thumbnail" у Otodom, ~184×138),
 * а не те же полноразмерные "medium" (655×491), уменьшенные CSS до 58×44:
 * иначе открытие галереи тянуло бы до десяти полноразмерных снимков ради
 * крохотной ленты. Крупный кадр при переключении берём из pics (полный
 * размер по тому же индексу), а не из src самой миниатюры. */
function bindGallery(a) {
  const box = $("#sheet-body").querySelector(".ph");
  if (!box) { galleryKeys = null; return; }   // нет галереи у этой карточки — гасим старое замыкание
  const thumbs = [...box.querySelectorAll(".ph-th")];
  if (!thumbs.length) { galleryKeys = null; return; }   // один кадр — стрелок и лент нет
  const pics = a.ph || photoData?.[a.id] || [];
  let cur = 0;

  const show = (i) => {
    cur = (i + thumbs.length) % thumbs.length;   // зацикливаем в обе стороны
    box.querySelector(".ph-main").src = pics[cur]?.[0] ?? thumbs[cur].src;
    thumbs.forEach((t, k) => t.classList.toggle("on", k === cur));
    const n = box.querySelector(".ph-n span");
    if (n) n.textContent = String(cur + 1);
    // держим активную миниатюру в поле зрения ленты
    thumbs[cur].scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };

  box.onclick = (e) => {
    const nav = e.target.closest?.(".ph-nav");
    if (nav) return show(cur + +nav.dataset.d);
    const th = e.target.closest?.(".ph-th");
    if (th) show(thumbs.indexOf(th));
  };

  // Стрелки клавиатуры работают, пока открыта карточка И галерея ещё в DOM —
  // вторая проверка страхует от висячего замыкания на отсоединённый узел
  galleryKeys = (e) => {
    if ($("#sheet").hidden || !document.body.contains(box)) return;
    if (e.key === "ArrowLeft") show(cur - 1);
    else if (e.key === "ArrowRight") show(cur + 1);
  };
}


/* removed.json (детали по каждой снятой квартире) нужен в ДВУХ местах:
 * блоку «Что рядом» в карточке активной квартиры (лениво при её первом
 * открытии, вместе с dist.json — см. loadHeavy) и тултипу точек «Снято с
 * продажи» на карте (может понадобиться и без единой открытой карточки).
 * Поэтому фетч у него свой, с отдельным кэширующим промисом — loadHeavy()
 * его переиспользует, а не дублирует запрос. */
let remLoading = null;
function loadRemoved() {
  remLoading ||= fetch(`data/removed.json?v=${BUILD}`).then((r) => r.json())
    .then((d) => (remData = d)).catch(() => (remData = {}));
  return remLoading;
}

/* Снятые с продажи как квартиры для той же карточки (01.10.2026): id → объект
 * в полях apartments.json. Снятые после 01.10 несут снимок полной карточки
 * (snap: фото, оси, удобства — export.py::save_snapshots), раньше — только
 * то, что хранит listings_history. a.off — признак снятой во всём коде. */
let archById = null;
function archIndex() {
  if (archById || !remData) return archById;
  archById = new Map();
  Object.entries(remData).forEach(([key, rows]) => {
    const [lat, lon] = key.split(",").map(Number);
    rows.forEach(({ snap, ...r }) => archById.set(r.id, { ...(snap || {}), ...r, lat, lon, full: !!snap }));
  });
  return archById;
}

/* Клик по серой точке «Снято с продажи»: одна квартира — сразу её карточка,
 * несколько по адресу — список на выбор (всплывающее окно карты) */
let remPopup = null;
function openRemovedAt(lat, lon, latlng) {
  loadRemoved().then(() => {
    const rows = remData?.[locKey(lat, lon)] || [];
    if (rows.length === 1) return openArch(rows[0].id);
    if (!rows.length) return;
    const items = rows.map((r) => `<button type="button" class="rem-pick" data-arch="${esc(r.id)}">
        <b>${money(r.p)}</b> · ${num(r.a, " " + tr("m2"))} · ${r.r ?? "?"} ${tr("rooms_s")}<br>
        <span>${esc(removedPeriod(r))}</span></button>`).join("");
    remPopup?.remove();
    remPopup = new ml.Popup({ maxWidth: "300px", className: "rem-pop" }).setLngLat(latlng)
      .setHTML(`<div class="rem-pick-t">${esc(tr("arch_here"))}</div><div class="rem-pick-list">${items}</div>`)
      .addTo(map);
  });
}

/* «Карточка» у снятых — в «Что рядом» карточки и в списке на карте */
function bindArchLinks() {
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.(".rem-open, .rem-pick");
    if (!b) return;
    if (b.classList.contains("rem-pick")) remPopup?.remove();
    openArch(b.dataset.arch);
  });
}

/* Квартира по id: в продаже или снятая (карточки, избранное, скрытые) */
const findApt = (id) => state.all.find((x) => x.id === id) || archIndex()?.get(id);

/* Карточка снятой квартиры: та же шторка, что у активной (openSheet) */
function openArch(id) {
  return loadRemoved().then(() => { const a = archIndex()?.get(id); if (a) openSheet(a); });
}

/* Тяжёлые файлы (dist.json 3.3 МБ + removed.json ~1.6 МБ) нужны только внутри
 * секции «Что рядом» — тянем их не при открытии карточки (это давало бы
 * ~8,45 МБ разом с photos.json на первую же карточку, аудит веб-11), а
 * только когда юзер реально раскрыл эту секцию (см. distShellHtml/
 * bindDistLazyLoad ниже). Одно обещание на всех: два быстрых клика не дадут
 * двух загрузок, а если данные уже подтянуты для прошлой карточки — новая
 * открывается с готовым содержимым, без повторного фетча и без задержки. */
function loadHeavy() {
  heavyLoading ||= Promise.all([
    fetch(`data/dist.json?v=${BUILD}`).then((r) => r.json()).catch(() => ({ layers: [], apts: {} })),
    loadRemoved(),
  ]).then(([d]) => { distData = d; });
  return heavyLoading;
}

// Ключ точки — те же 5 знаков, что в export.py: активные и снятые
// объявления по одному адресу должны попадать в одну корзину
const locKey = (lat, lon) => `${lat.toFixed(5)},${lon.toFixed(5)}`;

/* Снятые с продажи по этому же адресу. Единственный источник истории цен
 * по дому: сколько просили за соседние квартиры и когда объявление ушло. */
/* Снятые в точке квартиры + её прежние объявления (a.ak) с другой меткой —
 * та же выборка, что export.py (rm/rms). */
let remById = null;
function remRowsFor(a) {
  if (!remData) return null;
  remById ||= new Map(Object.values(remData).flat().map((r) => [r.id, r]));
  const rows = remData[locKey(a.lat, a.lon)] || [];
  const ids = new Set(rows.map((r) => r.id));
  return rows.concat((a.ak || []).filter((k) => !ids.has(k)).map((k) => remById.get(k)).filter(Boolean));
}

function removedHtml(a, part = null) {
  if (a.lat == null) return "";
  let rows = remRowsFor(a);
  if (part) rows = rows?.filter((r) => sameFlat(a, r) === (part === "same"));
  if (!rows?.length) return "";
  const other = part === "other";
  const items = rows.map((r) => `
    <div class="rrow">
      <span class="roff">${esc(removedPeriod(r))}</span>
      <div>${money(r.p)}${r.ppm ? ` · ${nf.format(Math.round(r.ppm))} ${tr("ppm_u")}` : ""}</div>
      <div>${num(r.a, " " + tr("m2"))} · ${esc(r.r ?? "?")} ${tr("rooms_s")}${other && r.fl != null ? ` · ${tr("fl_short")} ${r.fl}` : ""}${r.sc != null ? ` · ${tr("rating")} ${Math.round(r.sc)}` : ""}</div>
      <button type="button" class="ds-btn ds-btn--link rem-open" data-arch="${esc(r.id)}">${tr("arch_open")}</button>
      <a href="${esc(safeUrl(r.u))}" target="_blank" rel="noopener">${tr("arch")}</a>
    </div>`).join("");
  const title = part ? tr(part === "same" ? "rem_same" : "rem_other") : tr("rem");
  return `<details class="ds-box fold rem" data-rem="${part || ""}"><summary><span class="ds-section-label">${title} · ${rows.length}</span></summary><div class="fold-body">${items}${other ? `<small class="rem-hint">${tr("rem_other_hint")}</small>` : ""}</div></details>`;
}

/* Тултип точки слоя «Снято с продажи» на карте: до дозагрузки remData —
 * только счётчик (r.n, посчитан заранее в export.py), как было раньше;
 * loadRemoved() запускаем тут же — идемпотентно (см. remLoading), так что
 * повторные наведения ничего лишнего не шлют. Как только remData доедет,
 * ближайшее следующее наведение покажет адрес/цену/площадь/дату по каждой
 * квартире в этой точке (до 8 штук, дальше — «+ ещё N»), как в блоке «Что
 * рядом» карточки активной квартиры (removedHtml выше). */
function removedTipHtml(lat, lon, n) {
  loadRemoved();
  const rows = remData?.[locKey(lat, lon)];
  if (!rows?.length) return esc(tr("rem_tip")(n));
  const LIMIT = 8;
  const items = rows.slice(0, LIMIT).map((r) => {
    const addr = esc([r.d, r.st].filter(Boolean).join(", ") || tr("noaddr"));
    const bits = [num(r.a, " " + tr("m2")), r.r != null ? `${r.r} ${tr("rooms_s")}` : null,
                  r.off ? esc(removedPeriod(r)) : null].filter(Boolean).join(" · ");
    return `<div class="rem-tip-row"><b>${money(r.p)}</b> · ${addr}<br>${bits}</div>`;
  }).join("");
  const more = rows.length > LIMIT ? `<div class="rem-tip-more">${tr("rem_more")(rows.length - LIMIT)}</div>` : "";
  return `<div class="rem-tip-list">${items}${more}</div>`;
}

const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(1).replace(".", ",") + " " + tr("km") : Math.round(m) + " " + tr("m_u"));

function distRow(d, layers) {
  // подпись слоя переводим через meta.i18n (PLDIST из старой карты)
  const label = distName((layers[d[0]] || ["?"])[0]);
  const walk = d[4] != null ? ` <span class="dw">· ${d[4]} ${tr("min")}</span>` : "";
  // Название кликабельно: ведёт в Google Maps по координатам объекта
  const name = d[2]
    ? (d[3] ? `<a href="https://www.google.com/maps?q=${encodeURIComponent(d[3]).replace(/%2C/gi, ",")}" target="_blank" rel="noopener">${esc(d[2])}</a>`
            : esc(d[2]))
    : "";
  return `<div class="drow"><span>${esc(label)}${name ? `<br>${name}` : ""}</span>
          <b>${fmtM(d[1])}${walk}</b></div>`;
}

// Вызывается только когда distData уже загружен (см. distSlotHtml) — до
// загрузки на его месте показывается distShellHtml()
function distHtml(id) {
  const { layers, apts } = distData;
  const rows = apts?.[id];
  if (!rows?.length) return "";

  // Знак слоя (плюс/минус) лежит в мете, а не в записи
  const pos = rows.filter((d) => (layers[d[0]] || [0, true])[1]);
  const neg = rows.filter((d) => !(layers[d[0]] || [0, true])[1]);

  // По умолчанию — от ближайшего объекта (юзер попросил 2026-09-26). Режим
  // "weight" возвращает старое поведение старой карты (важные слои сверху,
  // внутри — ближние) — юзер попросил вернуть выбор (2026-09-27), переключатель
  // ниже (bindDistSort), состояние в distSortMode переживает переоткрытие
  // карточек в рамках сессии.
  const byDist = (arr) => [...arr].sort((x, y) => x[1] - y[1]);
  const byWeight = (arr) => [...arr].sort((x, y) =>
    (layers[y[0]]?.[2] ?? 1) - (layers[x[0]]?.[2] ?? 1) || x[1] - y[1]);
  const sorted = distSortMode === "weight" ? byWeight : byDist;

  // Плюсы и минусы — две кнопки в ряд, под ними список выбранной (19.10.2026, юзер:
  // «на одном уровне по горизонтали, при нажатии раскрывается список»). Выбор — distTab.
  const tab = (arr, title, cls) => arr.length
    ? `<button type="button" class="dtab ${cls}${distTab === cls ? " on" : ""}" data-dt="${cls}" aria-expanded="${distTab === cls}">${title} <span>${arr.length}</span></button>` : "";
  const panel = (arr, cls) => arr.length && distTab === cls
    ? `<div class="dsec ${cls}">${sorted(arr).map((d) => distRow(d, layers)).join("")}</div>` : "";

  const sortToggle = `<div class="dsort" role="group" aria-label="${esc(tr("dsort_label"))}">
    <button type="button" class="dsort-btn${distSortMode === "distance" ? " on" : ""}" data-sort="distance">${tr("dsort_dist")}</button>
    <button type="button" class="dsort-btn${distSortMode === "weight" ? " on" : ""}" data-sort="weight">${tr("dsort_weight")}</button>
  </div>`;

  return `<details class="ds-box fold dist"><summary><span class="ds-section-label">${tr("dist")}</span><span class="fold-sum">${tr("dist_sub0")}</span></summary>
    <div class="fold-body"><div class="dtabs">${tab(pos, tr("pos"), "pos")}${tab(neg, tr("neg"), "neg")}</div>
    ${distTab ? sortToggle : ""}${panel(pos, "pos")}${panel(neg, "neg")}</div></details>`;
}

/* «Полка» вместо реального содержимого «Что рядом», пока dist.json/removed.json
 * ещё не загружены: сворачиваемый блок раскрывается как обычно, но данных
 * внутри до раскрытия ещё нет — фетч начинается ИЗ toggle-обработчика
 * (bindDistLazyLoad), не здесь. Число объектов заранее неизвестно (оно и есть
 * в ещё не скачанном dist.json), поэтому в заголовке — без счётчика. */
function distShellHtml() {
  return `<details class="ds-box fold dist" id="dist-lazy"><summary><span class="ds-section-label">${tr("dist")}</span><span class="fold-sum">${tr("dist_sub0")}</span></summary>
    <div class="fold-body"><div class="gap-note">${tr("dwait")}</div></div></details>`;
}

// dist-slot целиком: реальные данные, если уже загружены (например, юзер
// открывал «Что рядом» у другой квартиры этим же сеансом), иначе полка
function distSlotHtml(a) {
  return distData ? distHtml(a.id) : distShellHtml();
}

/* «Снято с продажи (N)» — отдельным блоком сразу за «Что рядом» (09.10.2026,
 * раньше появлялся только после раскрытия «Что рядом»). N — из apartments.json
 * (a.rm), сами объявления — removed.json, грузится при раскрытии этого блока. */
// 10.10.2026: два блока — прежние объявления ЭТОЙ квартиры и соседи по дому
// (раньше одним «Ранее на продаже»: у половины квартир вторички там были соседи)
function remSlotHtml(a) {
  if (!a.rm) return "";
  if (remData) return removedHtml(a, "same") + removedHtml(a, "other");
  const nSame = a.rms || 0, nOther = a.rm - nSame;
  const shell = (part, n) => n ? `<details class="ds-box fold rem" data-rem="${part}"><summary><span class="ds-section-label">${tr(part === "same" ? "rem_same" : "rem_other")} · ${n}</span></summary>
    <div class="fold-body"><div class="gap-note">${tr("dwait")}</div></div></details>` : "";
  return shell("same", nSame) + shell("other", nOther);
}

function bindRemLazyLoad(a) {
  $("#rem-slot")?.querySelectorAll("details[data-rem]").forEach((det) => {
    det.addEventListener("toggle", () => {
      if (!det.open) return;
      const part = det.dataset.rem;
      // remData мог доехать другим путём (слой снятых на карте, список) уже после
      // отрисовки заглушки — раньше тогда выходили, и «загружается» висело навсегда
      // (аудит 10.10.2026): перерисовываем и в этом случае
      loadRemoved().then(() => {
        const slot = $("#rem-slot");
        if (state.activeId !== a.id || !slot) return;
        slot.innerHTML = remSlotHtml(a);
        const d = slot.querySelector(`details[data-rem="${part}"]`);
        if (d) d.open = true;
      });
    });
  });
}

// та же проверка, что export.py::_same_flat
function sameFlat(a, r) {
  if ((a.ak || []).includes(r.id)) return true;
  if (r.a == null || a.a == null || r.r !== a.r) return false;
  return Math.abs(r.a - a.a) <= 1.0 && (r.fl == null || r.fl === a.fl);
}

/* Догружает dist.json+removed.json (аудит веб-11) не раньше, чем юзер сам
 * раскрыл «Что рядом» — открытие карточки остаётся дешёвым (только
 * apartments.json + photos.json). Обработчик живёт до подмены innerHTML
 * (тогда старого <details> уже нет); повторное раскрытие до загрузки безвредно. */
function bindDistLazyLoad(a) {
  const det = $("#dist-slot")?.querySelector("#dist-lazy");
  if (!det) return;
  det.addEventListener("toggle", () => {
    if (!det.open) return;          // distData мог доехать после заглушки — всё равно перерисовать
    loadHeavy().then(() => {
      if (state.activeId !== a.id) return;   // юзер уже смотрит другую квартиру
      const slot = $("#dist-slot");
      if (!slot) return;
      slot.innerHTML = distSlotHtml(a);
      // innerHTML сбрасывает open — раскрываем заново, чтобы контент не
      // "захлопнулся" перед носом у того, кто его только что раскрыл
      const first = slot.querySelector("details");
      if (first) first.open = true;
    });
  });
}

/* Клик по кнопкам сортировки «Что рядом» — переключает distSortMode и
 * перерисовывает #dist-slot, сохраняя раскрытые/свёрнутые <details> (иначе
 * при каждом клике всё бы схлопывалось, включая ту секцию, которую юзер
 * только что открыл, чтобы посмотреть список). Слушатель висит на самом
 * #dist-slot (его innerHTML подменяется, а сам узел — нет), поэтому
 * переживает и подмену контента из bindDistLazyLoad. */
function bindDistSort(a) {
  const slot = $("#dist-slot");
  if (!slot) return;
  slot.addEventListener("click", (e) => {
    const t = e.target.closest(".dtab");
    if (t && distData) {   // повторное нажатие на открытую — свернуть
      distTab = distTab === t.dataset.dt ? null : t.dataset.dt;
      slot.innerHTML = distSlotHtml(a);
      const d = slot.querySelector("details"); if (d) d.open = true;
      return;
    }
    const btn = e.target.closest(".dsort-btn");
    if (!btn || !distData) return;
    const mode = btn.dataset.sort;
    if (mode === distSortMode) return;
    distSortMode = mode;
    const open = [...slot.querySelectorAll("details")].map((d) => d.open);
    slot.innerHTML = distSlotHtml(a);
    slot.querySelectorAll("details").forEach((d, i) => { d.open = open[i] ?? false; });
  });
}

let cardTracked = false;   // воронка: «открыл квартиру» — один раз за открытие страницы
function openSheet(a) {
  if (!cardTracked) { cardTracked = true; trackEvent("card"); }
  state.activeId = a.id;   // единственный источник истины: и select(), и #cmp-close идут сюда
  // Снятая с продажи (a.off): та же карточка с пометкой «Снято», серой
  // последней ценой и сроком продажи; без сравнения и «Что рядом». Снятая до
  // 01.10.2026 (нет снимка, a.full=false) — без фото и осей, с пояснением.
  const arch = !!a.off;
  state.activeArch = arch;
  // Опекуна фокуса (sheetOpener) здесь НЕ ставим: к моменту вызова openSheet()
  // document.activeElement часто уже "body" — select() успевает вызвать
  // paintWindow() раньше (тот целиком пересобирает DOM карточек через innerHTML
  // и рвёт фокус на исходном элементе). Значение выставляет вызывающий код
  // (обработчики клика/Enter в paintWindow(), см. ниже) ДО этой перерисовки.

  const rows = [
    [tr("f_ppm"), a.ppm ? `${nf.format(Math.round(a.ppm))} zł` : "—"],
    [tr("f_area2"), a.a != null ? `${a.a.toLocaleString(LANG === "pl" ? "pl-PL" : "ru-RU", { maximumFractionDigits: 2 })} ${tr("m2")}` : "—"],
    [tr("f_rooms2"), a.r ?? "—"],
    [tr("f_floor"), a.fl != null ? `${a.fl}${a.tf ? ` ${tr("f_of")} ${a.tf}` : ""}` : "—"],
    [tr("f_year2"), a.by ?? "—"],
    [tr("f_seller2"), LABEL.ut[a.ut] ?? "—"],
    // комиссия и место в гараже — из текста объявления (costs.py, 19.10.2026); не указанная
    // комиссия агентства — 2% с пометкой «уточнить» (юзер 19.10)
    ...(a.cms ? [[tr("f_comm"), commText(a)]] : []),
    // подпись — по виду места из объявления (pkt: garage/surface/any/mixed, 20.10.2026)
    ...(a.pk || a.pki ? [[tr("f_park")[a.pkt] || tr("f_park").any,
      a.pk ? `${a.pkt === "mixed" ? tr("park_from") + " " : ""}${nf.format(a.pk)} zł — ${tr("park_sep")}` : tr("park_incl")]] : []),
    [tr("f_market2"), LABEL.mt[a.mt] ?? "—"],
    [tr("f_cond2"), LABEL.cs[a.cs] ?? "—"],
    [tr("f_heat"), tr("ht_full")[a.ht] ?? "—"],   // отопление — как в боте (19.10.2026)
    [tr("f_metro"), a.wm != null ? `${a.wm} ${tr("min")}${a.mn ? ` (${a.mn})` : ""}` : "—"],
    [tr("f_noise"), noiseText(a)],
    [tr("f_school"), a.se != null ? `${Math.round(a.se)}%` : "—"],
    [tr("f_own"), ownCost(a) ? { html: ownHtml(a) } : "—"],
    ...(arch ? [[tr("arch_period"), archPeriod(a)]]
      : [[tr("f_since"), fmtDate(a.seen) ?? "—"], [tr("f_checked"), checkedText(a)]]),
  ].filter(([k, v]) => !arch || (v !== "—" && k !== tr("f_own")));   // у снятой — без пустых строк и расчёта владения
  // «Дорога до дома» — только в личной сборке: в публичной изохрон нет
  if (!arch) state.places.forEach((pl, i) => {
    const m = state.placeTimes[i]?.[a.id];
    if (m == null) return;
    const w = state.placeWalk[i]?.[a.id], alt = state.placeAlt[i]?.[a.id];
    // значение — готовый HTML ({html}): основная строка + пешая часть + автобус второй строкой
    rows.push([esc(pl.name), { html: esc(`${m} ${tr("min")} · ${modeWords(placeModes(i, a.id))}`) + rateHelpBtn(false, "commute") +   // имя места вводит юзер — экранируем
      (w != null && w >= 1 ? `<span class="place-sub">${esc(tr("walk_to_stop")(w))}</span>` : "") +
      (alt != null ? `<span class="place-sub">${esc(tr("alt_bus")(alt))}</span>` : "") }]);
  });
  // личная сборка с ?iso= (зоны от адреса из бота) — если мест нет
  if (!arch && !state.places.length) {
    const cm = commute(a.id);
    if (cm != null) rows.push([tr("f_commute2"), `${cm} ${tr("min")}`]);
  }

  $("#sheet-body").innerHTML = `
    ${arch ? archTagHtml(tr("arch_tag")(fmtDate(a.off))) : ""}
    <h2 id="sheet-h2">${esc([a.d, a.st].filter(Boolean).join(", ") || tr("noaddr"))}</h2>
    <div class="price-row">
      <span class="price${arch ? " price--arch" : ""}">${money(a.p)}</span>
      <div class="price-actions">
        <button class="fav-btn card-fav" id="sheet-fav-icon" title="${esc(tr(state.favorites.has(favKey(a)) ? "unfav_t" : "fav_t"))}"
                aria-label="${esc(tr(state.favorites.has(favKey(a)) ? "unfav" : "fav"))}">${state.favorites.has(favKey(a)) ? "✓" : "⭐"}</button>
        <button class="hide-btn card-hide" id="sheet-hide-icon" title="${esc(tr(state.hidden.has(hideKey(a)) ? "unhide_t" : "hide_t"))}"
                aria-label="${esc(tr(state.hidden.has(hideKey(a)) ? "unhide" : "hide"))}">${state.hidden.has(hideKey(a)) ? "↩" : "🚫"}</button>
        ${arch ? "" : '<button class="cmp-btn" id="cmp-btn"></button>'}
      </div>
    </div>
    <div class="card-sub">${arch ? `${tr("arch_last")} · ` : ""}${a.sc != null ? `${tr("rating")} ${Math.round(a.sc)}/100` : ""} ${fairHtml(a)}</div>
    ${arch && !a.full ? `<p class="ds-box arch-note">${esc(tr("arch_note"))}</p>` : ""}
    <details class="ds-box sumbox" data-fold="sum"${foldOpen("sum", true) ? " open" : ""}>
      <summary><span class="ds-section-label">${tr("sum_t")}</span><span class="fold-sum sum-sub">${tr("sum_sub")}</span></summary>
      ${arch ? "" : `<div id="trade-slot">${rcnData && histData ? tradeHtml(a) : ""}</div>`}
      ${visitHtml(a)}
      ${noteHtml(a)}
      ${arch ? "" : `<div id="hist-slot">${histData ? histHtml(a) : ""}</div>`}
      ${arch ? "" : `<div id="rcn-slot">${rcnData ? rcnHtml(a) : ""}</div>`}
      ${axesBoxHtml(a)}
    </details>
    ${wantTagsHtml(a)}
    <div id="ph-slot">${galleryHtml(a)}</div>
    <section class="ds-box facts-box"><span class="ds-section-label">${tr("facts_t")}</span>
      <dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v && typeof v === "object" ? v.html : esc(v)}</dd>`).join("")}</dl></section>
    ${dupsHtml(a)}
    ${arch ? "" : `<div id="dist-slot">${distSlotHtml(a)}</div><div id="rem-slot">${remSlotHtml(a)}</div>`}
    <div class="sheet-links">
      <a href="${esc(safeUrl(a.u))}" target="_blank" rel="noopener">${tr(arch ? "arch_otodom" : "otodom")}</a>
      <a href="https://www.google.com/maps?layer=c&cbll=${a.lat},${a.lon}" target="_blank" rel="noopener">${tr("street")}</a>
      ${a.dev ? `<a href="${esc(safeUrl(a.dev))}" target="_blank" rel="noopener">${tr("devall")}</a>` : ""}
      ${arch ? "" : `<a href="?report=${encodeURIComponent(a.id)}&lang=${LANG}" target="_blank" rel="noopener" class="report-link">${REPORT_SVG}${tr("report_btn")}</a>`}
    </div>`;
  $("#sheet").hidden = false;
  $("#sheet-close").focus();
  if (!arch) bindCompare(a);
  bindGallery(a);
  bindDistSort(a);
  $("#sheet-hide-icon").onclick = () => toggleHide(a.id);
  $("#sheet-fav-icon").onclick = () => toggleFavorite(a.id);
  /* Фото/дистанции при первом открытии карточки; пришли — дорисовываем, ЕСЛИ:
   *  1) пользователь всё ещё смотрит ТУ ЖЕ квартиру (activeId не сменился)
   *  2) шторка всё ещё в режиме карточки, а не переключена на сравнение —
   *     openCompare() кладёт в #sheet-body таблицу БЕЗ #ph-slot/#dist-slot,
   *     и querySelector вернул бы null; .innerHTML на null бросил бы
   *     необработанное исключение внутри промиса. Проверяем реальное наличие
   *     узла, а не только activeId. */
  if (!photoData && !arch) {
    loadPhotos().then(() => {
      const slot = $("#ph-slot");
      if (state.activeId === a.id && slot) {
        slot.innerHTML = galleryHtml(a);
        bindGallery(a);
      }
    });
  }

  // dist.json/removed.json (3,3+1,6 МБ) НЕ грузим здесь — только когда юзер
  // сам раскроет «Что рядом» (аудит веб-11, см. bindDistLazyLoad). Если они
  // уже загружены прошлой карточкой, distSlotHtml() выше и так вставила
  // готовый контент — вешать полку/обработчик незачем.
  if (!distData && !arch) {
    bindDistLazyLoad(a);
  }
  if (!remData && !arch) bindRemLazyLoad(a);
  // сделки рядом и история цены: файлы маленькие — грузим при первом открытии карточки
  if (!rcnData && !arch) {
    loadRcn().then(() => {
      const slot = $("#rcn-slot");
      if (state.activeId === a.id && slot) { slot.innerHTML = rcnHtml(a); bindFold(slot); }
    });
  }
  if (!histData && !arch) {
    loadHist().then(() => {
      const slot = $("#hist-slot");
      if (state.activeId === a.id && slot) { slot.innerHTML = histHtml(a); bindFold(slot); }
    });
  }
  bindFold($("#sheet-body"));
  bindNote(a);
  bindVisit(a);
  if (!arch && !(rcnData && histData)) {
    Promise.all([loadRcn(), loadHist()]).then(() => {
      const slot = $("#trade-slot");
      if (state.activeId === a.id && slot) { slot.innerHTML = tradeHtml(a); bindFold(slot); }
    });
  }
}

/* ── «Торг» — одна строка аргументов из того, что уже известно ──────────────
 * Срок в продаже (a.seen — с учётом переразмещений), снижения цены (hist.json)
 * и цена против сделок рядом (rcn.json). Два и больше аргумента — «есть куда
 * торговаться»; цена заметно ниже сделок — «торг вряд ли нужен»; без
 * аргументов строки нет (не шумим). Как отчёт для торга у Podkluczyk, но из
 * открытых данных. */
const TRADE_DAYS = 45, TRADE_GAP = 5;
/** Доводы «Торга» — общие для карточки (tradeHtml) и отчёта (reportHtml). */
function tradeInfo(a) {
  const args = [];
  const days = a.seen ? Math.floor((Date.now() - Date.parse(a.seen + "T00:00:00")) / 86400000) : 0;
  if (days >= TRADE_DAYS) args.push(tr("trade_days")(days));
  // Довод — ИТОГОВОЕ снижение от первой цены к текущей, не сумма шагов: цену
  // поднимали и снижали (610 → 650 → 610 тыс.) — раньше «снижали 2 раза
  // (−41 000)», хотя цена та же (10.10.2026)
  const pts = histPts(a);
  const drops = pts.filter((p, i) => i && p[1] < pts[i - 1][1]).length;
  const net = pts.length > 1 ? pts[0][1] - pts[pts.length - 1][1] : 0;
  // меньше 0,5% от первой цены — не уступка, а «освежить объявление» (904 782 → 904 781)
  if (drops && net >= pts[0][1] * 0.005)
    args.push(tr("trade_drops")(drops, nf.format(net), (net / pts[0][1] * 100).toFixed(1).replace(/\.0$/, "")));
  // История объявления (14.10.2026, в «Торг», а не отдельной строкой — решение юзера):
  // перевыставление прячет срок на рынке и историю цены — это довод для торга;
  // подъём цены и копии объявления — факты, на вывод «Торга» не влияют
  if (a.rl) args.push(tr("trade_times")(a.rl + 1));
  const facts = [];
  const ups = pts.filter((p, i) => i && p[1] > pts[i - 1][1] * 1.01);
  if (ups.length) facts.push(tr("trade_raised")(ups.map((p) => `${nf.format(pts[pts.indexOf(p) - 1][1])} → ${nf.format(p[1])}`).join(", ")));
  const dups = a.sr ? [] : a.dp || [];
  if (dups.length) {
    const who = [...new Set([a.ag || LABEL.ut[a.ut], ...dups.map((d) => d[3] || LABEL.ut[d[2]])].filter(Boolean))];
    facts.push(tr("trade_copies")(dups.length + 1, who.join(", ")));
  }
  const gap = dealGap(a);
  if (gap != null && gap >= TRADE_GAP) args.push(tr("trade_gap")(gap));
  let verdict, cls;
  if (gap != null && gap <= -TRADE_GAP && args.length < 2) {
    args.push(tr("trade_cheap")(-gap)); verdict = tr("trade_none"); cls = "";
  } else if (args.length >= 2) { verdict = tr("trade_strong"); cls = "good"; }
  else if (args.length === 1) { verdict = tr("trade_some"); cls = ""; }
  else if (facts.length) { verdict = facts.shift(); cls = ""; }
  else return null;
  return { args, facts, verdict, cls, days, drops, net, pts };
}

function tradeHtml(a) {
  const t = tradeInfo(a);
  if (!t) return "";
  const { args, facts, verdict, cls } = t;
  // Строка сводки (05.10.2026): вывод — в свёрнутом виде, доводы — по раскрытию
  return `<details class="srow fold trade" data-fold="trade"${foldOpen("trade") ? " open" : ""}>
    <summary><span class="ds-section-label">${tr("trade_t")}</span><span class="fold-sum blk-main ${cls}">${verdict}</span></summary>
    <div class="fold-body blk-sub">${[...args, ...facts].map(esc).join(" · ")}</div></details>`;
}

/* ── Свёрнутые блоки карточки (04.10.2026) ────────────────────────────────────
 * «История цены» и «Цены сделок рядом» — <details> с итогом в строке summary.
 * Раскрыт ли блок, помним (wf_fold): открыл раз — открыт и у следующих квартир. */
function foldOpen(name, dflt = false) {
  try {
    const st = JSON.parse(localStorage.getItem("wf_fold") || "{}");
    return name in st ? !!st[name] : dflt;
  } catch { return dflt; }
}
function bindFold(root) {
  root?.querySelectorAll("details[data-fold]").forEach((d) => {
    d.ontoggle = () => {
      try {
        const st = JSON.parse(localStorage.getItem("wf_fold") || "{}");
        st[d.dataset.fold] = d.open;
        localStorage.setItem("wf_fold", JSON.stringify(st));
      } catch {}
    };
  });
}

/* ── «Посещённая» (17.10.2026) ─────────────────────────────────────────────────
 * Отметка «был на просмотре» — ставит сам юзер в карточке. Ключ и хранение —
 * как у заметки: localStorage wf_visited {ключ: {v, at}}, при входе по ссылке
 * из бота — ещё профиль (prefs.visited), слияние по времени правки at; снятая
 * отметка — {v: false, at}, чтобы другое устройство не вернуло её. */
function loadVisited() {
  try { state.visited = JSON.parse(localStorage.getItem("wf_visited") || "{}") || {}; } catch { state.visited = {}; }
}
const isVisited = (a) => !!state.visited?.[favKey(a)]?.v;

function visitHtml(a) {
  const on = isVisited(a);
  return `<div class="srow visit-row">
    <span class="ds-section-label">${tr("visit_l")}</span>
    <button type="button" class="ds-chip visit-btn" id="visit-btn" aria-pressed="${on}" title="${esc(tr("visit_t"))}">${on ? "✓ " : ""}${esc(tr("wa").vi)}</button>
  </div>`;
}

function bindVisit(a) {
  const b = $("#visit-btn");
  if (!b) return;
  b.onclick = () => {
    const on = !isVisited(a);
    state.visited[favKey(a)] = { v: on, at: Date.now() };
    try { localStorage.setItem("wf_visited", JSON.stringify(state.visited)); } catch {}
    b.setAttribute("aria-pressed", String(on));
    b.textContent = (on ? "✓ " : "") + tr("wa").vi;
    if (state.want.includes("vi")) { rowMeasuredNormal = 0; rowMeasuredGap = 0; apply(false); }
    saveNotesRemote();
  };
}

function mergeVisited(remote) {
  let push = false;
  for (const [k, v] of Object.entries(remote || {})) {
    if (!state.visited[k] || state.visited[k].at < v.at) state.visited[k] = v;
  }
  for (const [k, v] of Object.entries(state.visited)) {
    if (!remote?.[k] || remote[k].at < v.at) push = true;
  }
  try { localStorage.setItem("wf_visited", JSON.stringify(state.visited)); } catch {}
  if (push) saveNotesRemote();
}

/* ── «Моя заметка» ────────────────────────────────────────────────────────────
 * Ключ — как у избранного (favKey): заметка переживает смену главной карточки
 * группы дублей и переразмещение (relistCarry). Хранение: localStorage wf_notes,
 * при входе по ссылке из бота — ещё и профиль на сервере (prefs.notes), слияние
 * по времени правки at. Бот показывает заметку в /favorites и уведомлениях. */
const NOTE_PREVIEW = 90, NOTE_LEN = 4000;   // NOTE_LEN — как в profiles.py
function loadNotes() {
  try { state.notes = JSON.parse(localStorage.getItem("wf_notes") || "{}") || {}; } catch { state.notes = {}; }
  pruneNoteTombstones();
}
const noteOf = (a) => state.notes[favKey(a)]?.t || "";

function noteHtml(a) {
  const t = noteOf(a), draft = noteDraft(a), val = draft ?? t;
  const sum = t ? `<span class="note-sum__text">${esc(t.length > NOTE_PREVIEW ? t.slice(0, NOTE_PREVIEW) + "…" : t)}</span>`
                : `<span class="note-sum__add">${tr("note_add")}</span>`;
  return `<details class="srow fold note-box"${draft != null ? " open" : ""}>
    <summary><span class="ds-section-label">${tr("note_t")}</span><span class="fold-sum note-sum">${PEN_SVG}${sum}</span></summary>
    <div class="fold-body">
      <textarea class="ds-input note-input" id="note-input" rows="3" maxlength="${NOTE_LEN}"
                aria-label="${esc(tr("note_t"))}" placeholder="${esc(tr("note_ph"))}">${esc(val)}</textarea>
      <div class="note-bar">
        <span class="note-status" id="note-status" role="status" aria-live="polite"></span>
        <span class="note-count" id="note-count"></span>
        <button type="button" class="ds-btn ds-btn--primary note-save" id="note-save">${tr("note_save")}</button>
      </div>
      <p class="ds-note">${tr(profileToken() ? "note_hint" : "note_hint_local")}</p>
    </div>
  </details>`;
}
const PEN_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"
  stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;

/* Сохранение явное (17.10.2026): раньше заметка уходила сама по таймеру, и
 * когда сохранение молча не доходило (обрезка до 1000 знаков), это было не
 * видно — часть текста пропала. Теперь: кнопка «Сохранить» (и ⌘/Ctrl+Enter),
 * под полем — что с заметкой сейчас. Пока не сохранено, текст живёт черновиком
 * в этом браузере (wf_note_drafts): закрыл карточку или вкладку — не потерял. */
function loadDrafts() { try { return JSON.parse(localStorage.getItem("wf_note_drafts") || "{}") || {}; } catch { return {}; } }
function noteDraft(a) { const d = loadDrafts()[favKey(a)]; return typeof d === "string" ? d : null; }
function putDraft(k, text) {
  const d = loadDrafts();
  text == null ? delete d[k] : (d[k] = text);
  try { localStorage.setItem("wf_note_drafts", JSON.stringify(d)); } catch {}
}

function bindNote(a) {
  const box = $("#sheet-body .note-box"), ta = $("#note-input"), btn = $("#note-save");
  if (!box || !ta || !btn) return;
  const k = favKey(a);
  const fit = () => { ta.style.height = "auto"; ta.style.height = Math.min(ta.scrollHeight + 2, innerHeight * 0.6) + "px"; };
  box.ontoggle = () => { if (box.open) { fit(); ta.focus(); } };
  const keepDraft = debounce(() => putDraft(k, ta.value.trim() === noteOf(a) ? null : ta.value), 300);
  ta.oninput = () => { keepDraft(); fit(); noteBar(a); };
  ta.onkeydown = (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); btn.click(); } };
  btn.onclick = async () => {
    btn.disabled = true;
    noteBar(a, "saving");
    const res = await setNote(a, ta.value);
    if (res !== "error") putDraft(k, null);
    noteBar(a, res === "error" ? "error" : null);
  };
  if (box.open) fit();
  noteBar(a);
}

function noteBar(a, mode) {
  const ta = $("#note-input"), st = $("#note-status"), cnt = $("#note-count"), btn = $("#note-save");
  if (!ta || !st || !btn) return;
  const dirty = ta.value.trim() !== noteOf(a);
  cnt.textContent = ta.value.length > NOTE_LEN * 0.8 ? `${ta.value.length} / ${NOTE_LEN}` : "";
  let cls = "", text = "", retry = mode === "error";
  if (mode === "saving") text = tr("note_saving");
  else if (mode === "error") { cls = "is-bad"; text = tr("note_err"); }
  else if (dirty) { cls = "is-warn"; text = tr("note_dirty"); }
  else if (noteOf(a)) {
    // Всегда видно, где лежит заметка (17.10.2026: «не понимаю, сохранилась или нет»):
    // «в профиле» — только если сервер прислал её с тем же временем правки
    const at = state.notes[favKey(a)].at, d = new Date(at);
    const when = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}, ${d.toTimeString().slice(0, 5)}`;
    const onServer = (state.remoteNotes[favKey(a)]?.at || 0) >= at;
    if (!profileToken()) { cls = "is-ok"; text = tr("note_ok_local")(when); }
    else if (onServer) { cls = "is-ok"; text = tr("note_ok")(when); }
    else { cls = "is-warn"; text = tr("note_not_sent"); retry = true; }
  }
  st.className = "note-status " + cls;
  st.textContent = text;
  btn.textContent = tr(retry ? "note_retry" : "note_save");
  btn.disabled = mode === "saving" || (!dirty && !retry);
}

/* Сохранить заметку: в этот браузер и, если есть профиль, на сервер.
 * Ответ: "profile" — сервер подтвердил; "local" — профиля нет, только браузер;
 * "error" — на сервер не дошло (браузер помнит, черновик остаётся). */
async function setNote(a, text) {
  const k = favKey(a), t = text.trim().slice(0, NOTE_LEN);
  if ((state.notes[k]?.t || "") !== t) {
    // удаление — пустая заметка со временем правки: иначе профиль/другое устройство
    // при слиянии возвращали её (аудит 10.10.2026)
    state.notes[k] = { t, at: Date.now() };
    try { localStorage.setItem("wf_notes", JSON.stringify(state.notes)); } catch {}
    // строка заметки в карточке списка; с чипом «Есть заметка» — и порядок
    if (state.want.includes("nt")) { rowMeasuredNormal = 0; rowMeasuredGap = 0; apply(false); } else paintWindow();
    // и подпись summary в карточке, не трогая открытое поле ввода
    const lab = $("#sheet-body .note-sum");
    if (lab) {
      lab.querySelectorAll(".note-sum__text, .note-sum__add").forEach((n) => n.remove());
      lab.insertAdjacentHTML("beforeend", t ? `<span class="note-sum__text">${esc(t.length > NOTE_PREVIEW ? t.slice(0, NOTE_PREVIEW) + "…" : t)}</span>`
                                            : `<span class="note-sum__add">${tr("note_add")}</span>`);
    }
  }
  return saveNotesRemote();
}

/* Заметки с сервера (профиль) + этого браузера: по каждой квартире — более
 * свежая правка. Если у браузера было новее — отправляем профилю. */
/* Метки удалённых заметок ({t:"", at}) сервер хранит 90 дней (profiles.py,
 * NOTE_TOMBSTONE_DAYS); браузер — столько же, иначе каждая загрузка заново
 * слала бы профилю метку, которую тот уже выбросил (проверка 10.10.2026). */
function pruneNoteTombstones() {
  const old = Date.now() - 90 * 86400000;
  let gone = false;
  for (const [k, v] of Object.entries(state.notes)) if (!v?.t && !(v?.at >= old)) { delete state.notes[k]; gone = true; }
  if (gone) try { localStorage.setItem("wf_notes", JSON.stringify(state.notes)); } catch {}
}

function mergeNotes(remote) {
  state.remoteNotes = remote || {};
  let push = false;
  for (const [k, v] of Object.entries(remote || {})) {
    if (!state.notes[k] || state.notes[k].at < v.at) state.notes[k] = v;
  }
  pruneNoteTombstones();
  for (const [k, v] of Object.entries(state.notes)) {
    if (!remote?.[k] || remote[k].at < v.at) push = true;
  }
  try { localStorage.setItem("wf_notes", JSON.stringify(state.notes)); } catch {}
  if (push) saveNotesRemote();
}

async function saveNotesRemote() {
  const tok = profileToken();
  if (!tok) return "local";
  if (!state.profilePrefs) return "error";     // профиль ещё не загрузился — сохранять поверх нечего
  const prefs = { ...state.profilePrefs, notes: state.notes, visited: state.visited };
  delete prefs.work;
  try {
    const r = await fetch(`${API_BASE}/profile`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "X-Profile-Token": tok },
      body: JSON.stringify({ prefs }),
    });
    if (!r.ok) return "error";
    state.profilePrefs = (await r.json()).prefs;
    state.remoteNotes = state.profilePrefs.notes || {};
    const open = state.activeId && findApt(state.activeId);
    if (open) noteBar(open);           // фоновая отправка (слияние при входе) — статус открытой карточки
    return "profile";
  } catch { return "error"; }
}

/* ── История цены (data/hist.json, export.build_price_history) ─────────────────
 * Ступенчатая линия одной серии: легенды нет (её называет заголовок), подписаны
 * только первая и последняя цена; у каждой точки — подсказка (hit-зона 24px),
 * а список изменений под графиком — его табличный вид. */
let histData = null, histLoading = null;
function loadHist() {
  histLoading ||= fetch(`data/hist.json?v=${BUILD}`).then((r) => r.json())
    .then((d) => (histData = d)).catch(() => (histData = {}));
  return histLoading;
}

/* Точки истории цены ЭТОЙ квартиры: у объявлений застройщика по очереди
 * показываются разные квартиры (58,65 → 53,12 → 74,33 м²), цена «скачет» вместе
 * с площадью. Точки с площадью дальше ±5% от текущей — другая квартира (правка
 * площади той же квартиры — 65,7 → 63,5 м² — укладывается),
 * пропускаем; подряд одинаковые цены склеиваем (10.10.2026, export.py пишет
 * площадь третьим полем). */
function histPts(a) {
  // застройщик «крутит» в объявлении соседние квартиры (53,27 / 55,72 м²) — у него
  // допуск узкий; у остальных правка площади той же квартиры бывает до ~2 м²
  const tol = a.a == null ? Infinity : a.ut === "developer" ? 0.5 : Math.max(1, a.a * 0.05);
  const out = [];
  for (const p of histData?.[a.id] || []) {
    if (p[2] != null && Math.abs(p[2] - a.a) > tol) continue;
    if (!out.length || out[out.length - 1][1] !== p[1]) out.push(p);
  }
  return out;
}

function histHtml(a) {
  const pts = histPts(a);
  if (!pts || pts.length < 2) return "";
  const k = (v) => `${nf.format(Math.round(v / 1000))} ${tr("k_short")}`;
  const dm = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
  const day = (iso) => Date.parse(iso + "T00:00:00") / 86400000;
  const W = 440, H = 120, L = 8, R = 96, T = 14, B = 22;
  const d0 = day(pts[0][0]), d1 = Math.max(day(new Date().toISOString().slice(0, 10)), day(pts[pts.length - 1][0]) + 1);
  const vals = pts.map((p) => p[1]), lo = Math.min(...vals), hi = Math.max(...vals);
  const pad = (hi - lo) * 0.15 || hi * 0.02;
  const y = (v) => T + (hi + pad - v) / (hi + pad - (lo - pad)) * (H - T - B);
  const x = (iso) => L + (day(iso) - d0) / Math.max(1, d1 - d0) * (W - L - R);
  const xe = W - R;
  let path = "";
  pts.forEach(([iso, v], i) => { path += i ? `H${x(iso).toFixed(1)}V${y(v).toFixed(1)}` : `M${x(iso).toFixed(1)},${y(v).toFixed(1)}`; });
  path += `H${xe}`;
  const dots = pts.map(([iso, v], i) => {
    const chg = i ? v - pts[i - 1][1] : 0;
    const tip = `${dm(iso)}.${iso.slice(2, 4)} — ${nf.format(v)} PLN${i ? ` (${chg < 0 ? "−" : "+"}${nf.format(Math.abs(chg))})` : ""}`;
    return `<g class="ph-pt"><circle cx="${x(iso).toFixed(1)}" cy="${y(v).toFixed(1)}" r="12" class="ph-hit"><title>${tip}</title></circle>
      <circle cx="${x(iso).toFixed(1)}" cy="${y(v).toFixed(1)}" r="4" class="ph-dot"/></g>`;
  }).join("");
  const tot = vals[vals.length - 1] - vals[0];
  const totTxt = `<b class="${tot < 0 ? "good" : tot > 0 ? "bad" : ""}">${tot < 0 ? "−" : "+"}${nf.format(Math.abs(tot))} PLN (${tot < 0 ? "−" : "+"}${Math.abs(tot / vals[0] * 100).toFixed(1)}%)</b>`;
  const rows = pts.slice(1).map(([iso, v], i) => {
    const prev = pts[i][1], d = v - prev;
    return `<li><span class="ph-d">${dm(iso)}</span> ${nf.format(prev)} → <b>${nf.format(v)}</b> <span class="${d < 0 ? "good" : "bad"}">${d < 0 ? "−" : "+"}${nf.format(Math.abs(d))}</span></li>`;
  }).reverse().slice(0, 8).join("");
  return `<details class="srow phist fold" data-fold="hist"${foldOpen("hist") ? " open" : ""}>
    <summary><span class="ds-section-label">${tr("hist_t")}</span><span class="fold-sum">${tr("hist_sum")(pts.length - 1, totTxt)}</span></summary>
    <div class="fold-body">
      <div class="ds-note">${tr("hist_since")(`${dm(pts[0][0])}.${pts[0][0].slice(2, 4)}`)}</div>
      <svg viewBox="0 0 ${W} ${H}" class="phist-svg" role="img" aria-label="${esc(tr("hist_t"))}">
        <line x1="${L}" x2="${xe}" y1="${H - B}" y2="${H - B}" class="ph-axis"/>
        <path d="${path}V${H - B}H${L}Z" class="ph-area"/><path d="${path}" class="ph-line"/>${dots}
        <text x="${x(pts[0][0]).toFixed(1)}" y="${(y(vals[0]) - 8).toFixed(1)}" class="ph-lab">${k(vals[0])}</text>
        <text x="${xe + 6}" y="${(y(vals[vals.length - 1]) + 4).toFixed(1)}" class="ph-lab">${k(vals[vals.length - 1])}</text>
        <text x="${L}" y="${H - 6}" class="ph-date">${dm(pts[0][0])}</text>
        <text x="${xe}" y="${H - 6}" class="ph-date" text-anchor="end">${tr("hist_today")}</text>
      </svg>
      <ul class="phist-list">${rows}</ul>
    </div>
  </details>`;
}

/* ── Цены реальных сделок рядом (RCN Варшавы, 04.10.2026) ────────────────────
 * data/rcn.json пишет export.py (2.scoring/rcn.py::nearby): медиана zł/м²
 * сделок своего рынка за год вокруг квартиры, «в этом доме» и 8 ближайших.
 * Объявление — цена, которую просят; сделка — за сколько продали. */
let rcnData = null, rcnLoading = null;
function loadRcn() {
  rcnLoading ||= fetch(`data/rcn.json?v=${BUILD}`).then((r) => r.json())
    .then((d) => (rcnData = d)).catch(() => (rcnData = {}));
  return rcnLoading;
}

/* «В этом доме по годам» — медиана zł/м² сделок в доме за все годы реестра
 * (2006+). Одна величина по годам: тонкая полоса той же шкалы + подпись
 * значения, легенды нет — её называет заголовок. */
function rcnYearsHtml(v) {
  const ys = v.y;
  if (!ys || ys.length < 2) return "";
  const max = Math.max(...ys.map((y) => y[1]));
  // рост — между крайними годами, где сделок хотя бы две: одна продажа — не цена дома
  const solid = ys.filter((y) => y[2] >= 2);
  const first = solid[0], last = solid[solid.length - 1];
  const growth = solid.length >= 2 ? Math.round((last[1] - first[1]) / first[1] * 100) : null;
  const rows = ys.map(([y, m, n]) => `<div class="ry-row"><span class="ry-y">${y}</span>
      <span class="ry-bar"><span style="width:${Math.max(4, m / max * 100).toFixed(1)}%"></span></span>
      <span class="ry-v">${nf.format(m)}</span><span class="ry-n">${n}</span></div>`).join("");
  return `<div class="rcn-years">
      <div class="ry-head"><b>${tr("rcn_years")}</b>${growth == null ? "" : ` <span class="${growth >= 0 ? "" : "good"}">${tr("rcn_growth")(first[0], growth)}</span>`}</div>
      <div class="ds-note">${tr("rcn_years_note")}</div>${rows}</div>`;
}

/* «Дороже/дешевле сделок» — ОДНА цифра на всю карточку (19.10.2026, юзер: в шапке 7%,
 * ниже 11%): сделки по похожим квартирам (fair_price.deals_pct — те же комнаты, похожая
 * площадь, свежие весомее), если их нет — медиана всех сделок рядом (rcn.json). */
function dealGap(a) {
  if (a.dl != null) return Math.round(a.dl);
  const v = rcnData?.[a.id];
  return v && a.ppm ? Math.round((a.ppm - v.m) / v.m * 100) : null;
}

function rcnHtml(a) {
  const v = rcnData?.[a.id];
  if (!v && a.dlm == null) return "";
  const gap = dealGap(a);
  const gapTxt = gap == null ? "" : Math.abs(gap) < 1 ? `<b>${tr("rcn_same")}</b>`
    : `<b class="${gap > 0 ? "bad" : "good"}">${tr(gap > 0 ? "rcn_more" : "rcn_less")(Math.abs(gap))}</b>`;
  const main = a.dlm != null ? a.dlm : v.m;
  const d = (iso) => `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(2, 4)}`;
  const area = (x) => x.toLocaleString(LANG === "pl" ? "pl-PL" : "ru-RU", { maximumFractionDigits: 2 });
  const rows = (v?.s || []).map(([iso, ar, ppm, rooms, floor, dist]) =>
    `<tr><td>${d(iso)}</td><td>${area(ar)} ${tr("m2")}</td><td>${rooms ?? "—"}</td><td>${floor ?? "—"}</td>` +
    `<td><b>${nf.format(ppm)}</b></td><td>${dist} ${tr("m_u")}</td></tr>`).join("");
  return `<details class="srow rcn fold" data-fold="rcn"${foldOpen("rcn") ? " open" : ""}>
    <summary><span class="ds-section-label">${tr("rcn_t")}</span><span class="fold-sum">${tr("rcn_sum")(`<b>${nf.format(main)} ${tr("ppm_u")}</b>`, gap == null ? "" : gapTxt)}</span></summary>
    <div class="fold-body">
    <div class="rcn-head"><span class="ds-note">${tr("rcn_src")}</span></div>
    <div class="rcn-main"><b>${nf.format(main)} ${tr("ppm_u")}</b><span>${esc(a.dlm != null
      ? tr("rcn_similar")(a.dln, a.r) : tr("rcn_med")(v.n, v.r, (LABEL.mt[a.mt] || "").toLowerCase()))}</span></div>
    ${gap == null ? "" : `<div class="rcn-gap">${tr("rcn_this")}: ${nf.format(Math.round(a.ppm))} ${tr("ppm_u")} — ${gapTxt}</div>`}
    ${a.dlm != null && v ? `<div class="rcn-house">${tr("rcn_all")(nf.format(v.m), v.n, v.r)}</div>` : ""}
    ${v?.h ? `<div class="rcn-house">${tr("rcn_house")(v.h[0], nf.format(v.h[1]))}</div>` : ""}
    ${v ? rcnYearsHtml(v) : ""}
    ${rows ? `<details class="rcn-list" open><summary>${tr("rcn_list")(v.s.length)}</summary>
      <table><thead><tr>${tr("rcn_cols").map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table>
    </details>` : ""}
    </div>
  </details>`;
}

/* Пометка «Снято …» (ds-tag + значок архива) — шторка и карточка в списке */
function archTagHtml(text) {
  return `<span class="ds-tag arch-tag"><svg width="12" height="12" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect
    x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9M10 13h4"/></svg>${esc(text)}</span>`;
}

/* «20.07 → 24.07.2026 · 4 дн.» — сколько снятая провисела в продаже */
function archPeriod(a) {
  const off = fmtDate(a.off);
  if (!a.on) return off ?? "—";
  const days = daysBetween(a.on, a.off);
  return `${fmtDate(a.on).slice(0, 5)} → ${off}${days != null ? ` · ${days} ${tr("days_u")}` : ""}`;
}

// Тема из прошлого визита — до первой отрисовки, чтобы не мигало
try {
  const t = localStorage.getItem("wf_theme");
  if (t) document.documentElement.setAttribute("data-theme", t);
} catch {}

/* ── Свежесть данных ─────────────────────────────────────────────────────────
 * Вкладка живёт открытой сутками, а пайплайн пересобирает данные 4-5 раз в
 * день. Раз в 5 минут спрашиваем meta.json (4 КБ) и сравниваем поле generated.
 *
 * Страницу НЕ перезагружаем сами: человек мог отфильтровать выдачу и изучать
 * конкретную квартиру — выдёргивать её из-под него грубо. Показываем плашку,
 * решает он.
 *
 * Анти-кеш в запросе обязателен: GitHub Pages держит ассеты 10 минут, без
 * него опрос возвращал бы ту же копию и обновление заметилось бы с опозданием. */
const FRESH_EVERY_MS = 5 * 60 * 1000;

function watchFreshness() {
  const mine = state.meta?.generated;
  if (!mine) return;
  setInterval(async () => {
    try {
      const r = await fetch(`data/meta.json?_=${Date.now()}`, { cache: "no-store" });
      if (!r.ok) return;
      const m = await r.json();
      if (m.generated && m.generated !== mine) showFresh();
    } catch { /* сеть моргнула — молча ждём следующей попытки */ }
  }, FRESH_EVERY_MS);
}

function showFresh() {
  if ($("#fresh")) return;              // плашка уже висит — не плодим
  const box = document.createElement("div");
  box.id = "fresh";
  box.className = "fresh";
  box.innerHTML = `<span>${tr("fresh")}</span>
                   <button class="ghost">${tr("fresh_btn")}</button>`;
  box.querySelector("button").onclick = () => {
    // Просто reload() отдал бы страницу и скрипты из кеша — те самые 10 минут.
    // Меняем параметр v, и браузер вынужден сходить на сервер.
    const q = new URLSearchParams(location.search);
    q.set("v", String(Date.now()));
    location.replace(`${location.pathname}?${q}`);
  };
  document.body.appendChild(box);
}

/* Высота шапки и полосы фильтров — в CSS-переменную, от неё считается верх
 * шторки. Хардкодить нельзя: полоса фильтров переносится на второй ряд при
 * узком окне и на польском (подписи длиннее), и карточка накрыла бы её. */
/* ── Ширина списка ───────────────────────────────────────────────────────────
 * Тянем разделитель — меняется колонка списка. По умолчанию 380 px, а не
 * половина экрана: на широком мониторе список съедал половину площади.
 * Значение живёт в localStorage, пределы — 340 px и 60% ширины окна, иначе
 * список можно утащить в ноль или закрыть им карту целиком. 340, а не 280:
 * уже на 320 цена от миллиона («1 740 000 PLN») обрезалась краем карточки
 * (29.09). По умолчанию было фактически 280: --list-w в :root не задан, и
 * initGutter() падал на LIST_MIN вместо задуманных 380. */
const LIST_MIN = 340;
const LIST_DEFAULT = 380;
const listMax = () => Math.max(LIST_MIN, window.innerWidth * 0.6);

function setListWidth(px, save = true) {
  const w = Math.round(Math.min(listMax(), Math.max(LIST_MIN, px)));
  document.documentElement.style.setProperty("--list-w", `${w}px`);
  // role="separator" — значения обязаны отражать реальные пределы и текущую
  // ширину, раз она меняется стрелками и перетаскиванием (a11y)
  const g = $("#gutter");
  if (g) {
    g.setAttribute("aria-valuenow", String(w));
    g.setAttribute("aria-valuemin", String(LIST_MIN));
    g.setAttribute("aria-valuemax", String(Math.round(listMax())));
  }
  if (save) { try { localStorage.setItem("wf_listw", String(w)); } catch {} }
  map?.resize();
}

function initGutter() {
  const g = $("#gutter");
  if (!g) return;
  // setListWidth() вызываем ВСЕГДА, не только при сохранённой ширине — иначе
  // role="separator" остаётся без aria-valuenow/min/max до первого перетаскивания
  let saved = 0;
  try { saved = +localStorage.getItem("wf_listw") || 0; } catch {}
  const initial = saved || LIST_DEFAULT;
  setListWidth(initial, false);

  const move = (e) => setListWidth(e.clientX ?? e.touches?.[0]?.clientX ?? 0, false);
  const stop = () => {
    document.body.classList.remove("dragging");
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    // сохраняем один раз в конце, а не на каждый пиксель движения
    const cur = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue("--list-w"), 10);
    if (cur) setListWidth(cur);
  };
  g.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
  });
  // Клавиатура: разделитель — тоже управляющий элемент
  g.addEventListener("keydown", (e) => {
    const cur = parseInt(getComputedStyle(document.documentElement)
      .getPropertyValue("--list-w"), 10) || LIST_MIN;
    if (e.key === "ArrowLeft") setListWidth(cur - 32);
    else if (e.key === "ArrowRight") setListWidth(cur + 32);
  });
}

function measureChrome() {
  const top = document.querySelector(".top");
  const flt = document.querySelector(".filters");
  if (!top || !flt) return;
  const h = top.getBoundingClientRect().height + flt.getBoundingClientRect().height;
  // Разумные пределы: одна строка фильтров ~80 px, три ряда ~200. Значение вне
  // диапазона означает, что померили не то (скрытый элемент, не догрузился
  // шрифт) — тогда лучше оставить запасное из CSS, чем увести шторку за экран.
  if (h >= 40 && h <= 320) {
    document.documentElement.style.setProperty("--chrome-h", `${Math.round(h)}px`);
  }
  // отдельно высота ТОЛЬКО шапки: от неё начинается панель фильтров на телефоне
  const th = top.getBoundingClientRect().height;
  if (th >= 30 && th <= 120) {
    document.documentElement.style.setProperty("--head-h", `${Math.round(th)}px`);
  }
}

window.addEventListener("resize", measureChrome);
// --list-w посчитан на текущую ширину окна: при УМЕНЬШЕНИИ окна сохранённое
// с широкого монитора значение (например 1800px) не переклампливалось само
// собой — колонка списка оставалась шире вьюпорта, карта получала 0 ширины
window.addEventListener("resize", debounce(() => {
  const cur = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--list-w"), 10);
  if (cur) setListWidth(cur, false);   // та же listMax(), не переписываем сохранённое пользователем значение
}, 120));
// Формат счётчика («N» / «N из M») завязан на innerWidth в момент apply() —
// поворот экрана или ресайз БЕЗ смены фильтров не пересчитывал его сам
window.addEventListener("resize", debounce(refreshCount, 120));

document.addEventListener("keydown", (e) => {
  galleryKeys?.(e);
  // Esc в окне «Как считается рейтинг» закрывает только его, не карточку под ним
  if (e.key === "Escape" && document.getElementById("rh-dlg")?.open) return;
  if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
  if (e.key === "Escape") closeAllFilterUI();
});

/* Данные не загрузились (13.10.2026): чаще всего вкладка, которую браузер
 * перезагрузил сразу после сна Mac, раньше, чем поднялась сеть. Раньше здесь
 * была подсказка для разработчика («запусти export.py»), а фильтры выглядели
 * пропавшими. Теперь — понятный текст и повтор сам: когда вернулась сеть,
 * когда вкладку снова открыли, и раз в 30 с. Адрес с фильтрами не трогаем. */
const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
/* Запрос после сна может не упасть, а повиснуть — страница застревала на
 * «загрузка…» с пустыми фильтрами. Не пришло за LOAD_TIMEOUT_MS — тот же экран. */
const LOAD_TIMEOUT_MS = 20000;
let loaded = false;
Promise.race([
  load().then(() => { loaded = true; }),
  new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), LOAD_TIMEOUT_MS)),
]).catch((e) => {
  if (loaded) return;
  if (LOCAL) {
    $("#list").innerHTML = `<p class="empty">${tr("err")}<br>${esc(e.message)}<br><br>
      ${tr("err_h")}</p>`;
    return;
  }
  $("#count").textContent = "";       // не «загрузка…» — загрузка уже не идёт
  $("#list").innerHTML = `<div class="empty"><p>${tr("err_net")}</p>
    <button type="button" class="ds-btn" id="err-retry">${tr("err_btn")}</button></div>`;
  const retry = () => { if (!loaded) location.reload(); };
  $("#err-retry").onclick = retry;
  window.addEventListener("online", retry);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && navigator.onLine) retry(); });
  setInterval(() => { if (navigator.onLine) retry(); }, 30000);
});

/* ── Отчёт по квартире (19.10.2026) ──────────────────────────────────────────
 * app.html?report=<id> — отдельный вид поверх тех же данных, что карточка: макет
 * «Отчёт по квартире» (v8) и «Отчёт: где открыть» на холсте. Только факты из
 * данных (юзер): без слов владельцев и личных заметок; чего нет в объявлении —
 * в «Спросить продавца». Расходы при покупке — тарифы 2026 года (налог PCC,
 * нотариус по максимальной таксе + VAT, суд, банк). Печать = «Сохранить PDF». */
const START_REPORT = new URLSearchParams(location.search).get("report");
const RP = {
  ru: {
    title: "Отчёт по квартире", share: "Поделиться", pdf: "Сохранить PDF", open: "Открыть объявление",
    from: (d) => `Отчёт от ${d}`, visited: "отмечена как посещённая", back: "← Ко всем квартирам",
    rooms: (n) => `${n} ${ruP(n, "комната", "комнаты", "комнат")}`, floor: (f, t) => `этаж ${f}${t ? ` из ${t}` : ""}`,
    house: (y) => `год постройки ${y}`, heat: { urban: "Городское отопление", boiler_room: "Котельная", gas: "Газовое отопление", electrical: "Электроотопление" },
    b_price: "Цена", b_trade: "Торг", b_rate: "Рейтинг",
    deals_more: (p) => `на ${p}% дороже реальных сделок рядом`, deals_less: (p) => `на ${p}% дешевле реальных сделок рядом`, deals_same: "на уровне реальных сделок рядом",
    comps: (p) => p == null ? "" : Math.abs(p) < 1 ? "и на уровне похожих объявлений в продаже" : `похожие объявления в продаже: эта квартира ${p > 0 ? "на " + p + "% дороже" : "на " + -p + "% дешевле"}`,
    rate_of: (v) => `${v} из 100`, rate_weak: (a, b) => `слабее всего — ${a}${b ? ` и ${b}` : ""}`,
    s_price: "Цена", s_trade: "Торг", s_pros: "Плюсы и минусы", s_photos: "Фото", s_plan: "Планировка", s_rate: "Рейтинг и окружение",
    s_ask: "Спросить продавца", s_ask_lead: "Чего нет в объявлении", s_check: "Проверить на просмотре", s_check_lead: "Пока стоишь в квартире и у дома",
    l_market: "Цена квартиры против сделок на рынке", l_total: "Полная стоимость покупки", l_month: "Первый взнос и ежемесячный платёж", l_args: "Аргументы, чтобы снизить цену",
    f_price: "Цена в объявлении", f_house: "Реальные сделки в этом доме", f_near: "Реальные сделки рядом", f_comps: "Похожие объявления в продаже", f_hist: "История цены объявления", f_relist: "Объявление",
    per_flat: (v) => `столько стоила бы эта квартира по сделкам в доме: ≈ ${v}`, deals_n: (n) => `${n} ${ruP(n, "сделка", "сделки", "сделок")}`,
    this_more: (p) => `эта квартира на ${p}% дороже`, this_less: (p) => `эта квартира на ${p}% дешевле`, this_same: "на уровне этой квартиры",
    near_sub: (r) => r ? `${r}-комнатные квартиры похожей площади; недавние сделки учитываются сильнее` : "недавние сделки учитываются сильнее",
    comps_sub: "квартиры неподалёку, похожие по площади, году постройки и числу комнат",
    hist_sub: (n, d, p) => `цену снижали ${n} ${ruP(n, "раз", "раза", "раз")}, всего на ${d} (${p}%)`,
    relisted: (n) => `выставляют ${n}-й раз — история цены и срок на рынке частично скрыты`,
    col_list: "По цене объявления", col_target: (t) => `Если сторгуетесь до ${t}`,
    r_flat: "Квартира", r_pcc: "Налог на покупку (PCC) 2%", r_pcc_s: "0 — если это ваше первое жильё", r_pcc_prim: "в цене застройщика уже VAT",
    r_not: "Нотариус", r_not_s: "оплата нотариуса с VAT и копии договора", r_court: "Суд", r_court_s: "запись нового владельца и ипотеки в księdze wieczystej (реестре недвижимости)",
    r_bank: "Банк", r_bank_s: "оценка квартиры для банка; комиссия за кредит 0–2% — зависит от банка", r_agency: "Комиссия агентства", r_agency_ask: "уточнить",
    r_agency_s: { est: "в объявлении не указана — обычно 2%, уточните у агентства", yes: "агентство берёт комиссию, процент не указан — обычно 2%, уточните",
                  pct: "указана в объявлении", none: "указано в объявлении", private: "продаёт хозяин", developer: "напрямую от застройщика" },
    r_park_s: { garage: "продаётся отдельно — цена из объявления", surface: "на улице или на территории дома — продаётся отдельно, цена из объявления",
                any: "где именно — в объявлении не сказано; продаётся отдельно", mixed: "в объявлении есть места и в гараже, и на улице — здесь самое дешёвое" },
    r_park_in: "в цене квартиры",
    r_total_park: { garage: "Итого с местом в гараже", surface: "Итого с местом на парковке", mixed: "Итого с местом на парковке", any: "Итого с парковочным местом" },
    r_none: "нет", r_total: "Итого стоимость покупки", r_total_s: "без комиссии агентства",
    r_cash: (p) => `Нужно своих денег при первоначальном взносе ${p}%`, r_cash_s: "первоначальный взнос + налог, нотариус, суд, банк", r_cash_s_c: "первоначальный взнос + налог, нотариус, суд, банк, комиссия агентства",
    r_loan: (p) => `Кредит — первоначальный взнос ${p}%`, r_loan_s: "платёж банку в месяц", r_cz: "Czynsz — плата за дом", r_cz_ad: "управление, ремонтный фонд, вода, мусор; указан в объявлении", r_cz_desc: "управление, ремонтный фонд, вода, мусор; указан в описании объявления", r_cz_none: "czynszu нет — вода и отопление по счётчикам",
    r_cz_ask: "не указан — уточнить", r_month: (p) => `Ежемесячный платёж при взносе ${p}%`,
    foot_loan: (r, y) => `Кредит: ставка ${r}% годовых, срок ${y} лет. Первые ~5 лет банк обязательно включает страховку, дальше — по желанию; её сумму назовёт банк, в платёж она здесь не входит. Свет и интернет не входят — у всех разные.`,
    foot_heat: (h) => `Отопление ${h} — не в czynszu, расходы уточнить у продавца.`,
    plan: (s, t) => `Предложить сначала ${s} — столько стоят такие квартиры по реальным сделкам. Цель — около ${t}.`,
    plan_none: "Цена уже на уровне реальных сделок — торговаться можно по мелочам, на 1–2%.",
    plan_sub_house: "Опора — реальные сделки в этом же доме: это цифры, а не мнение.", plan_sub_near: "Опора — реальные сделки по похожим квартирам рядом.",
    a_house: (v) => [`Реальные сделки в этом доме ниже:`, `≈ ${v} за такую площадь.`], a_near: (p) => [`Реальные сделки рядом ниже:`, `похожие квартиры продавали на ${p}% дешевле.`],
    a_days: (d) => [`Долго продаётся:`, `${d} ${ruP(d, "день", "дня", "дней")} на рынке.`], a_drops: (n, d) => [`Цену уже снижали:`, `${n} ${ruP(n, "раз", "раза", "раз")}, всего на ${d}.`],
    a_relist: (n) => [`Объявление перевыставляли:`, `выставляют ${n}-й раз.`], a_noise: (v, s) => [`Шумно:`, `${v} дБ днём${s ? `, ${s}` : ""}.`],
    a_neg: (t) => [`Минусы окружения:`, `${t}.`], a_metro: (m) => [`Далеко от метро:`, `${m}.`], a_lift: (f) => [`Без лифта:`, `${f}-й этаж.`],
    c_sel_s: "Сильные стороны продавца", c_sel_w: "Слабые стороны продавца", c_buy_s: "Ваши сильные стороны", c_buy_w: "Ваши слабые стороны",
    sel_garden: "Свой сад — редкость среди похожих квартир.", sel_terrace: "Терраса — редкость среди похожих квартир.",
    sel_new: (y) => `Новый дом — ${y}.`, sel_ready: "Готова к проживанию.", sel_comps: "Похожие объявления просят столько же или больше — скажут «рынок такой».",
    sel_quiet: "Тихо для Варшавы.", sel_metro: (m) => `Метро рядом — ${m}.`,
    sel_days: (d) => `${d} ${ruP(d, "день", "дня", "дней")} на рынке — по этой цене покупателей нет.`, sel_drops: "Цену уже снижали — готовы уступать.",
    sel_deals: "Реальные сделки рядом ниже их цены.", sel_relist: "Перевыставляли объявление — продажа затянулась.",
    buy_date: "Можно подстроиться под их дату переезда.", buy_fast: "С решением банка на руках — быстрая сделка.", buy_data: "Цифры сделок — аргумент, а не мнение.",
    buy_rare: "Похожих квартир с садом или террасой мало — мало альтернатив.", buy_cheap: "Цена уже ниже похожих объявлений — сильно сбить не получится.",
    buy_none: "Слабых мест по данным не видно.",
    c_pros: "Плюсы", c_mid: "Нейтрально", c_cons: "Минусы", p_amen: "Удобства",
    p_new: (y) => ["Новый дом", `${y}`], p_school: (v) => ["Сильная школа рядом", `экзамен после 8 класса (egzamin ósmoklasisty) — ${v}%`], p_metro: (m, n) => ["Метро рядом", `${n ? n + " — " : ""}${m}`],
    p_quiet: (v) => ["Тихо", `${v} дБ днём — для Варшавы тихо`], p_park: (n, m) => ["Парк рядом", `${n ? n + " — " : ""}${m}`],
    p_kids: (t) => ["Садик и школа рядом", t], p_cheap: (p) => ["Дешевле сделок", `на ${p}% ниже сделок рядом`],
    n_mid_noise: (v) => ["Шум средний", `${v} дБ днём`], n_metro: (m) => ["Метро не близко", m], n_place: (n, m) => [`${n} — ${m} мин`, "на общественном транспорте"],
    m_more: (p) => ["Дороже реальных сделок", `на ${p}% дороже сделок рядом`], m_noise: (v, s) => ["Шумно", `${v} дБ днём${s ? `, ${s}` : ""}`],
    m_metro: (m) => ["Далеко от метро", m], m_neg: (t) => ["Рядом с домом", t], m_lift: (f) => ["Без лифта", `${f}-й этаж`],
    none_here: "—",
    rf_place: (n) => n, on_foot: "пешком", rf_transport: "Транспорт рядом", rf_kids: "Для детей", rf_shop: "Магазины", rf_park: "Парк", rf_noise: "Шум", rf_neg: "Минусы окружения", in_m: (m) => `в ${m}`, and: " и ",
    noise_v: (v, s) => `${v} дБ днём${s ? ` — ${s}` : ""}`, noise_low: "до 45 дБ",
    q_cz: (v) => v ? `Что входит в ${v} zł и сколько платят зимой?` : "Какой czynsz и что в него входит?",
    q_heat: "Сколько уходит на отопление зимой и летом?", q_agency: "Какая комиссия агентства?", q_kw: "Номер księgi wieczystej (реестра недвижимости) — есть ли долги перед wspólnotą (товариществом жильцов)?",
    q_why: "Почему продаёте и когда сможете освободить?", q_garage: "Место в гараже — входит в цену или отдельно?", q_repair: "Что нужно доделать, сколько это стоит?",
    q_dev: "Сроки сдачи, гарантия, штрафы за задержку — по договору?",
    k_stop: "Пройти до остановки и засечь время", k_noise: (s) => `Слышно ли ${s} в комнатах`, k_neg: (t) => `Что за ${t} и как это мешает днём`,
    k_light: "Свет в комнатах на нижнем этаже", k_garden: "Сток воды в саду после дождя", k_roof: "Последний этаж — следы протечек на потолке",
    k_damp: "Влажность в углах и у окон", k_common: "Подъезд, лифт и двор — в каком состоянии",
    sources: "Источники: объявление и его история, реестр цен сделок Варшавы (RCN), карта шума города, расписания ZTM, KM и WKD, OpenStreetMap, BDOT10k.",
    disclaimer: "Расходы при покупке — по тарифам 2026 года; точные суммы назовут нотариус и банк. Это анализ открытых данных, а не оценка rzeczoznawcy majątkowego (лицензированного оценщика) — для банка не подходит.",
    notfound: "Этой квартиры нет в базе — возможно, её сняли с продажи.",
    tg: "Открыть в Telegram", tg_toast: "Открыть в Telegram — бот пришлёт отчёт в чат",
    ext_link: (d) => `<b>Этой квартиры нет в нашей базе</b> — мы не наблюдали её цену и не знаем, выставляли ли её раньше.${d ? ` Объявление на портале опубликовано ${d}.` : ""} По возможности узнайте, как давно квартира на рынке на самом деле: поищите прежние объявления по адресу и фото, спросите агента.`,
    ext_addr: "<b>Отчёт по адресу — без объявления.</b> Чем больше полей заполните, тем полнее отчёт: с площадью и комнатами — сколько стоит такая квартира по сделкам; с ценой — полная стоимость покупки, платёж в месяц и торг. Сделки в доме и рядом, окружение и рейтинг будут в любом случае.",
    ef_area: "Площадь, м²", ef_price: "Цена, PLN", ef_rooms: "Комнаты", ef_floor: "Этаж", ef_tf: "Этажей в доме", ef_year: "Год дома",
    ef_market: "Рынок", ef_sec: "вторичный", ef_prim: "первичный", ef_go: "Обновить отчёт", ef_wait: "Считаем…", ef_err: "Не получилось — попробуйте ещё раз",
    no_price: "Укажите цену выше — появятся полная стоимость покупки, платёж в месяц и план торга.",
    no_price_ad: "Цены в объявлении нет — полную стоимость и план торга посчитать нельзя. Спросите цену у продавца.",
    addr_title: "Отчёт о доме и районе",
  },
  pl: {
    title: "Raport o mieszkaniu", share: "Udostępnij", pdf: "Zapisz PDF", open: "Otwórz ogłoszenie",
    from: (d) => `Raport z ${d}`, visited: "oznaczone jako obejrzane", back: "← Do wszystkich mieszkań",
    rooms: (n) => `${n} ${plP(n, "pokój", "pokoje", "pokoi")}`, floor: (f, t) => `piętro ${f}${t ? ` z ${t}` : ""}`,
    house: (y) => `rok budowy ${y}`, heat: { urban: "Ogrzewanie miejskie", boiler_room: "Kotłownia", gas: "Ogrzewanie gazowe", electrical: "Ogrzewanie elektryczne" },
    b_price: "Cena", b_trade: "Negocjacje", b_rate: "Ocena",
    deals_more: (p) => `o ${p}% drożej niż rzeczywiste transakcje w pobliżu`, deals_less: (p) => `o ${p}% taniej niż rzeczywiste transakcje w pobliżu`, deals_same: "na poziomie rzeczywistych transakcji w pobliżu",
    comps: (p) => p == null ? "" : Math.abs(p) < 1 ? "i na poziomie podobnych ofert w sprzedaży" : `podobne oferty w sprzedaży: to mieszkanie ${p > 0 ? "o " + p + "% drożej" : "o " + -p + "% taniej"}`,
    rate_of: (v) => `${v} na 100`, rate_weak: (a, b) => `najsłabiej — ${a}${b ? ` i ${b}` : ""}`,
    s_price: "Cena", s_trade: "Negocjacje", s_pros: "Plusy i minusy", s_photos: "Zdjęcia", s_plan: "Rzut mieszkania", s_rate: "Ocena i otoczenie",
    s_ask: "Zapytać sprzedającego", s_ask_lead: "Czego nie ma w ogłoszeniu", s_check: "Sprawdzić przy oglądaniu", s_check_lead: "Na miejscu, w mieszkaniu i przy budynku",
    l_market: "Cena mieszkania a transakcje na rynku", l_total: "Pełny koszt zakupu", l_month: "Wkład własny i rata miesięczna", l_args: "Argumenty, by obniżyć cenę",
    f_price: "Cena w ogłoszeniu", f_house: "Rzeczywiste transakcje w tym budynku", f_near: "Rzeczywiste transakcje w pobliżu", f_comps: "Podobne oferty w sprzedaży", f_hist: "Historia ceny ogłoszenia", f_relist: "Ogłoszenie",
    per_flat: (v) => `tyle kosztowałoby to mieszkanie wg transakcji w budynku: ≈ ${v}`, deals_n: (n) => `${n} ${plP(n, "transakcja", "transakcje", "transakcji")}`,
    this_more: (p) => `to mieszkanie o ${p}% drożej`, this_less: (p) => `to mieszkanie o ${p}% taniej`, this_same: "na poziomie tego mieszkania",
    near_sub: (r) => r ? `mieszkania ${r}-pokojowe o podobnej powierzchni; nowsze transakcje ważą więcej` : "nowsze transakcje ważą więcej",
    comps_sub: "mieszkania w pobliżu o podobnej powierzchni, roku budowy i liczbie pokoi",
    hist_sub: (n, d, p) => `cenę obniżano ${n} ${n === 1 ? "raz" : "razy"}, łącznie o ${d} (${p}%)`,
    relisted: (n) => `wystawiane ${n}. raz — historia ceny i czas na rynku częściowo ukryte`,
    col_list: "Po cenie z ogłoszenia", col_target: (t) => `Jeśli wynegocjujesz ${t}`,
    r_flat: "Mieszkanie", r_pcc: "Podatek od zakupu (PCC) 2%", r_pcc_s: "0 — jeśli to Twoje pierwsze mieszkanie", r_pcc_prim: "w cenie dewelopera jest już VAT",
    r_not: "Notariusz", r_not_s: "wynagrodzenie notariusza z VAT i wypisy umowy", r_court: "Sąd", r_court_s: "wpis własności i hipoteki do księgi wieczystej",
    r_bank: "Bank", r_bank_s: "wycena mieszkania dla banku; prowizja za kredyt 0–2% — zależy od banku", r_agency: "Prowizja biura", r_agency_ask: "do ustalenia",
    r_agency_s: { est: "nie podano w ogłoszeniu — zwykle 2%, zapytaj biuro", yes: "biuro pobiera prowizję, procent nie podany — zwykle 2%, zapytaj",
                  pct: "podana w ogłoszeniu", none: "podano w ogłoszeniu", private: "sprzedaje właściciel", developer: "bezpośrednio od dewelopera" },
    r_park_s: { garage: "sprzedawane osobno — cena z ogłoszenia", surface: "na zewnątrz lub na terenie osiedla — sprzedawane osobno, cena z ogłoszenia",
                any: "gdzie dokładnie — ogłoszenie nie podaje; sprzedawane osobno", mixed: "w ogłoszeniu są miejsca w garażu i na zewnątrz — tu najtańsze" },
    r_park_in: "w cenie mieszkania",
    r_total_park: { garage: "Razem z miejscem w garażu", surface: "Razem z miejscem parkingowym", mixed: "Razem z miejscem parkingowym", any: "Razem z miejscem postojowym" },
    r_none: "brak", r_total: "Razem koszt zakupu", r_total_s: "bez prowizji biura",
    r_cash: (p) => `Potrzebne własne środki przy wkładzie ${p}%`, r_cash_s: "wkład własny + podatek, notariusz, sąd, bank", r_cash_s_c: "wkład własny + podatek, notariusz, sąd, bank, prowizja biura",
    r_loan: (p) => `Kredyt — wkład własny ${p}%`, r_loan_s: "rata dla banku miesięcznie", r_cz: "Czynsz — opłata za budynek", r_cz_ad: "zarząd, fundusz remontowy, woda, śmieci; podany w ogłoszeniu", r_cz_desc: "zarząd, fundusz remontowy, woda, śmieci; podany w opisie ogłoszenia", r_cz_none: "bez czynszu — wszystko wg liczników",
    r_cz_ask: "nie podano — zapytać", r_month: (p) => `Rata miesięczna przy wkładzie ${p}%`,
    foot_loan: (r, y) => `Kredyt: oprocentowanie ${r}% rocznie, ${y} lat. Przez pierwsze ~5 lat bank wymaga ubezpieczenia, potem — dobrowolnie; kwotę poda bank, nie jest tu wliczona. Prąd i internet nie są wliczone — u każdego inne.`,
    foot_heat: (h) => `Ogrzewanie ${h} — poza czynszem, koszty ustalić ze sprzedającym.`,
    plan: (s, t) => `Zaproponować najpierw ${s} — tyle kosztują takie mieszkania wg rzeczywistych transakcji. Cel — około ${t}.`,
    plan_none: "Cena już na poziomie transakcji — negocjować drobiazgi, 1–2%.",
    plan_sub_house: "Oparcie — transakcje w tym samym budynku: to liczby, nie opinia.", plan_sub_near: "Oparcie — transakcje podobnych mieszkań w pobliżu.",
    a_house: (v) => [`Transakcje w tym budynku niższe:`, `≈ ${v} za tę powierzchnię.`], a_near: (p) => [`Transakcje w pobliżu niższe:`, `podobne mieszkania — o ${p}% taniej.`],
    a_days: (d) => [`Długo w sprzedaży:`, `${d} dni na rynku.`], a_drops: (n, d) => [`Cenę już obniżano:`, `${n} ${n === 1 ? "raz" : "razy"}, łącznie o ${d}.`],
    a_relist: (n) => [`Ogłoszenie wystawiano ponownie:`, `wystawiane ${n}. raz.`], a_noise: (v, s) => [`Głośno:`, `${v} dB w dzień${s ? `, ${s}` : ""}.`],
    a_neg: (t) => [`Minusy otoczenia:`, `${t}.`], a_metro: (m) => [`Daleko do metra:`, `${m}.`], a_lift: (f) => [`Bez windy:`, `${f}. piętro.`],
    c_sel_s: "Mocne strony sprzedającego", c_sel_w: "Słabe strony sprzedającego", c_buy_s: "Twoje mocne strony", c_buy_w: "Twoje słabe strony",
    sel_garden: "Własny ogródek — rzadkość wśród podobnych.", sel_terrace: "Taras — rzadkość wśród podobnych.",
    sel_new: (y) => `Nowy budynek — ${y}.`, sel_ready: "Do zamieszkania.", sel_comps: "Podobne oferty kosztują tyle samo lub więcej — powiedzą „taki rynek”.",
    sel_quiet: "Cicho jak na Warszawę.", sel_metro: (m) => `Metro blisko — ${m}.`,
    sel_days: (d) => `${d} dni na rynku — po tej cenie nie ma kupców.`, sel_drops: "Cenę już obniżali — są gotowi ustąpić.",
    sel_deals: "Rzeczywiste transakcje w pobliżu — poniżej ich ceny.", sel_relist: "Ogłoszenie wystawiano ponownie — sprzedaż się przeciąga.",
    buy_date: "Można dopasować się do ich terminu przeprowadzki.", buy_fast: "Z decyzją banku w ręku — szybka transakcja.", buy_data: "Liczby transakcji — argument, nie opinia.",
    buy_rare: "Podobnych mieszkań z ogródkiem lub tarasem jest mało — mało alternatyw.", buy_cheap: "Cena już niższa niż podobne oferty — dużo nie zbijesz.",
    buy_none: "W danych nie widać słabych stron.",
    c_pros: "Plusy", c_mid: "Neutralnie", c_cons: "Minusy", p_amen: "Udogodnienia",
    p_new: (y) => ["Nowy budynek", `${y}`], p_school: (v) => ["Mocna szkoła w pobliżu", `egzamin ósmoklasisty — ${v}%`], p_metro: (m, n) => ["Metro blisko", `${n ? n + " — " : ""}${m}`],
    p_quiet: (v) => ["Cicho", `${v} dB w dzień — cicho jak na Warszawę`], p_park: (n, m) => ["Park blisko", `${n ? n + " — " : ""}${m}`],
    p_kids: (t) => ["Przedszkole i szkoła blisko", t], p_cheap: (p) => ["Taniej niż transakcje", `o ${p}% poniżej transakcji w pobliżu`],
    n_mid_noise: (v) => ["Średni hałas", `${v} dB w dzień`], n_metro: (m) => ["Metro niezbyt blisko", m], n_place: (n, m) => [`${n} — ${m} min`, "komunikacją miejską"],
    m_more: (p) => ["Drożej niż transakcje", `o ${p}% powyżej transakcji w pobliżu`], m_noise: (v, s) => ["Głośno", `${v} dB w dzień${s ? `, ${s}` : ""}`],
    m_metro: (m) => ["Daleko do metra", m], m_neg: (t) => ["Obok budynku", t], m_lift: (f) => ["Bez windy", `${f}. piętro`],
    none_here: "—",
    rf_place: (n) => n, on_foot: "pieszo", rf_transport: "Komunikacja w pobliżu", rf_kids: "Dla dzieci", rf_shop: "Sklepy", rf_park: "Park", rf_noise: "Hałas", rf_neg: "Minusy otoczenia", in_m: (m) => `${m} stąd`, and: " i ",
    noise_v: (v, s) => `${v} dB w dzień${s ? ` — ${s}` : ""}`, noise_low: "do 45 dB",
    q_cz: (v) => v ? `Co wchodzi w ${v} zł i ile płacicie zimą?` : "Jaki jest czynsz i co obejmuje?",
    q_heat: "Ile kosztuje ogrzewanie zimą i latem?", q_agency: "Jaka jest prowizja biura?", q_kw: "Numer księgi wieczystej — czy są zaległości wobec wspólnoty?",
    q_why: "Dlaczego sprzedajecie i kiedy możecie się wyprowadzić?", q_garage: "Miejsce w garażu — w cenie czy osobno?", q_repair: "Co trzeba dokończyć i ile to kosztuje?",
    q_dev: "Termin oddania, gwarancja, kary za opóźnienie — w umowie?",
    k_stop: "Przejść do przystanku i zmierzyć czas", k_noise: (s) => `Czy w pokojach słychać ${s}`, k_neg: (t) => `Co to za ${t} i czy przeszkadza w dzień`,
    k_light: "Światło w pokojach na niskim piętrze", k_garden: "Odpływ wody w ogródku po deszczu", k_roof: "Ostatnie piętro — ślady przecieków na suficie",
    k_damp: "Wilgoć w narożnikach i przy oknach", k_common: "Klatka, winda i podwórko — w jakim stanie",
    sources: "Źródła: ogłoszenie i jego historia, rejestr cen transakcyjnych Warszawy (RCN), mapa hałasu miasta, rozkłady ZTM, KM i WKD, OpenStreetMap, BDOT10k.",
    disclaimer: "Koszty zakupu — wg stawek z 2026 roku; dokładne kwoty poda notariusz i bank. To analiza otwartych danych, a nie wycena rzeczoznawcy majątkowego — nie nadaje się dla banku.",
    notfound: "Tego mieszkania nie ma w bazie — możliwe, że zostało zdjęte ze sprzedaży.",
    tg: "Otwórz w Telegramie", tg_toast: "Otwórz w Telegramie — bot wyśle raport na czat",
    ext_link: (d) => `<b>Tego mieszkania nie ma w naszej bazie</b> — nie obserwowaliśmy jego ceny i nie wiemy, czy było wystawiane wcześniej.${d ? ` Ogłoszenie opublikowano na portalu ${d}.` : ""} Jeśli możesz, sprawdź, jak długo mieszkanie naprawdę jest na rynku: poszukaj wcześniejszych ogłoszeń po adresie i zdjęciach, zapytaj agenta.`,
    ext_addr: "<b>Raport po adresie — bez ogłoszenia.</b> Im więcej pól wypełnisz, tym pełniejszy raport: z powierzchnią i pokojami — ile kosztuje takie mieszkanie według transakcji; z ceną — pełny koszt zakupu, rata miesięczna i negocjacje. Transakcje w budynku i w okolicy, otoczenie i ocena będą zawsze.",
    ef_area: "Powierzchnia, m²", ef_price: "Cena, PLN", ef_rooms: "Pokoje", ef_floor: "Piętro", ef_tf: "Pięter w budynku", ef_year: "Rok budowy",
    ef_market: "Rynek", ef_sec: "wtórny", ef_prim: "pierwotny", ef_go: "Odśwież raport", ef_wait: "Liczymy…", ef_err: "Nie wyszło — spróbuj jeszcze raz",
    no_price: "Podaj cenę powyżej — pojawi się pełny koszt zakupu, rata miesięczna i plan negocjacji.",
    no_price_ad: "W ogłoszeniu nie ma ceny — nie da się policzyć pełnego kosztu i planu negocjacji. Zapytaj sprzedającego o cenę.",
    addr_title: "Raport o budynku i okolicy",
  },
};
const rt = (k) => (RP[LANG] || RP.ru)[k];

/** Максимальная такса нотариуса (rozporządzenie MS) + VAT 23% + ~400 zł выписки. */
function notaryFee(v) {
  const t = v <= 3000 ? 100 : v <= 10000 ? 100 + 0.03 * (v - 3000) : v <= 30000 ? 310 + 0.02 * (v - 10000)
    : v <= 60000 ? 710 + 0.01 * (v - 30000) : v <= 1e6 ? 1010 + 0.004 * (v - 60000)
    : v <= 2e6 ? 4770 + 0.002 * (v - 1e6) : 6770 + 0.0025 * (v - 2e6);
  return Math.min(t, 10000) * 1.23 + 400;
}

/* Слои dist.json по смыслу (индексы — порядок layers в export.py, см. «Что рядом») */
const RL = { metro: 0, stop: 1, train: 2, park: 4, play: 6, kinder: 10, school: 11, nursery: 13, shop: 15 };
const ROUND5K = (v) => Math.round(v / 5000) * 5000;
// «Промышленные здания» → «промышленные здания», но «ЛЭП …» остаётся ЛЭП
const lc1 = (t) => (t && t[1] && t[1] === t[1].toLowerCase() ? t[0].toLowerCase() + t.slice(1) : t);

function reportData(a) {
  const m = state.meta.mortgage;
  const k = (v) => nf.format(Math.round(v));
  const rc = rcnData?.[a.id];
  const house = rc?.h && rc.h[0] >= 2 && a.a ? rc.h[1] * a.a : null;     // сделки в доме → цена этой площади
  const near = a.dlm && a.a ? a.dlm * a.a : rc?.m && a.a ? rc.m * a.a : null;
  const anchor = house ?? near;
  const tradeOk = anchor != null && anchor < a.p * 0.97;
  const start = tradeOk ? Math.floor(anchor / 5000) * 5000 : null;
  const target = tradeOk ? ROUND5K(start + (a.p - start) * 0.3) : null;
  const dist = distData?.apts?.[a.id] || [];
  const layers = distData?.layers || [];
  const nearest = (li) => dist.filter((d) => d[0] === li).sort((x, y) => x[1] - y[1])[0];
  const neg = dist.filter((d) => layers[d[0]] && !layers[d[0]][1] && d[1] <= 300 && (layers[d[0]][2] ?? 1) >= 1)
    .sort((x, y) => x[1] - y[1]);
  // дальше получаса пешком — расстоянием («3.6 км»), а не «74 мин пешком»
  // минуты — всегда с «пешком» (юзер 19.10: «нет указания, пешком или на транспорте»)
  const walkTxt = (d) => d ? (d[4] != null && d[4] <= 30 ? `${d[4]} ${tr("min")} ${rt("on_foot")}` : fmtM(d[1])) : null;
  const costs = (price) => {
    const pcc = a.mt === "primary" ? 0 : price * 0.02;
    const notary = notaryFee(price), court = 700, bank = 700;
    const comm = a.cm ? price * a.cm / 100 : 0;   // комиссия агентства: из текста или 2% (costs.py)
    return { price, pcc, notary, court, bank, comm, total: price + pcc + notary + court + bank + comm };
  };
  const rata = (price, down) => {
    const loan = price * (1 - down), r = m.rate / 12, n = m.years * 12;
    return loan * r / (1 - Math.pow(1 + r, -n));
  };
  return { m, k, rc, house, near, anchor, tradeOk, start, target, dist, layers, nearest, neg, walkTxt, costs, rata,
           trade: tradeInfo(a), gap: dealGap(a), heatSep: a.czs === "none" || !!HEAT_SEPARATE[a.ht] };
}

function reportHtml(a) {
  const D = reportData(a), { k } = D;
  const f2 = (x) => esc(x);
  const facts = (rows) => `<dl class="rp-facts rp-panel">${rows.filter(Boolean).map(([t, v, sub]) =>
    `<dt>${esc(t)}</dt><dd>${v}${sub ? `<span class="rp-sub">${esc(sub)}</span>` : ""}</dd>`).join("")}</dl>`;
  const card = (title, dot, items) => `<div class="rp-card"><h3><span class="rp-dot rp-dot--${dot}"></span>${esc(title)}</h3>
    <ul>${items.length ? items.map((i) => Array.isArray(i) ? `<li>${esc(i[0])}<span class="rp-sub">${esc(i[1])}</span></li>` : `<li>${esc(i)}</li>`).join("")
      : `<li class="rp-empty">${rt("none_here")}</li>`}</ul></div>`;
  const pct = (v) => Math.abs(Math.round(v));
  const gap = D.gap;
  const pts = histPts(a);
  const days = a.seen ? Math.floor((Date.now() - Date.parse(a.seen + "T00:00:00")) / 86400000) : 0;
  const drops = pts.filter((p, i) => i && p[1] < pts[i - 1][1]).length;
  const net = pts.length > 1 ? pts[0][1] - pts[pts.length - 1][1] : 0;
  const noiseSrc = a.ns ? tr("ns_" + a.ns) : "";
  // «промышленные здания в 183 м, шумозащитный экран в 212 м и производство в 260 м»
  const negList = D.neg.slice(0, 3).map((d) => `${lc1(distName(D.layers[d[0]][0]))} ${rt("in_m")(fmtM(d[1]))}`);
  const negTxt = negList.length > 1 ? `${negList.slice(0, -1).join(", ")}${rt("and")}${negList[negList.length - 1]}` : negList[0] || "";
  const metro = D.nearest(RL.metro);
  const metroTxt = metro ? D.walkTxt(metro) : null;
  const metroMin = metro?.[4];
  const hasEx = (c) => a.ex?.includes(c);

  // ── шапка
  const chips = [...(a.ex || []).filter((c) => tr("wa")[c]).map((c) => `<span class="ds-tag ds-tag--yes">${esc(tr("wa")[c])}</span>`),
    rt("heat")[a.ht] ? `<span class="ds-tag ${D.heatSep ? "ds-tag--no" : "ds-tag--yes"}">${esc(rt("heat")[a.ht])}</span>` : ""].join("");
  const today = new Date();
  const dd = `${String(today.getDate()).padStart(2, "0")}.${String(today.getMonth() + 1).padStart(2, "0")}.${today.getFullYear()}`;
  const line = [a.a ? `${a.a.toLocaleString(LANG === "pl" ? "pl-PL" : "ru-RU", { maximumFractionDigits: 2 })} ${tr("m2")}` : "", a.r ? rt("rooms")(a.r) : "", a.fl != null ? rt("floor")(a.fl, a.tf) : "",
    a.by ? rt("house")(a.by) : "", LABEL.cs[a.cs] ? LABEL.cs[a.cs].toLowerCase() : "", LABEL.ut[a.ut] || ""].filter(Boolean).join(" · ");
  const weak = a.ax ? a.ax.map((v, i) => [v, i]).filter(([v]) => v != null).sort((x, y) => x[0] - y[0]).slice(0, 2) : [];
  const head = `
    <section class="rp-hero">
      ${a.img ? `<img src="${esc(a.img)}" alt="">` : ""}
      <div class="rp-hero-txt">
        <div class="rp-hero-meta">${a.u ? `<a class="rp-link" href="${esc(safeUrl(a.u))}" target="_blank" rel="noopener">${rt("open")}</a>` : ""}
          <span>${rt("from")(dd)}${isVisited(a) ? ` · ${rt("visited")}` : ""}</span></div>
        <h1>${esc([a.d, a.st].filter(Boolean).join(", ") || "—")}</h1>
        ${a.p ? `<span class="rp-price">${k(a.p)} PLN</span>` : ""}
        <span class="rp-line">${esc(line)}</span>
        ${chips ? `<div class="ds-chips">${chips}</div>` : ""}
      </div>
    </section>
    <section class="rp-grid rp-grid--3 rp-boxes">
      <div class="ds-box"><span class="ds-section-label">${rt("b_price")}</span>
        <b class="${gap == null ? "" : gap >= 1 ? "bad" : gap <= -1 ? "good" : ""}">${gap == null ? "—" : Math.abs(gap) < 1 ? rt("deals_same") : rt(gap > 0 ? "deals_more" : "deals_less")(pct(gap))}</b>
        <span>${esc(rt("comps")(a.fp != null ? Math.round(a.fp) : null))}</span></div>
      <div class="ds-box"><span class="ds-section-label">${rt("b_trade")}</span>
        <b class="${a.p ? D.trade?.cls || "" : ""}">${a.p ? esc(D.trade?.verdict || tr("trade_none")) : "—"}</b>
        <span>${a.p ? esc((D.trade?.args || []).slice(0, 2).join(" · ")) : ""}</span></div>
      <div class="ds-box"><span class="ds-section-label">${rt("b_rate")}</span>
        <b>${a.sc != null ? rt("rate_of")(Math.round(a.sc)) : "—"}</b>
        <span>${weak.length ? esc(rt("rate_weak")(axisName(weak[0][1]).toLowerCase(), weak[1] ? axisName(weak[1][1]).toLowerCase() : "")) : ""}</span></div>
    </section>`;

  // ── цена
  const thisGap = (ref) => { const g = Math.round((a.p - ref) / ref * 100); return Math.abs(g) < 1 ? rt("this_same") : rt(g > 0 ? "this_more" : "this_less")(Math.abs(g)); };
  const compsPpm = a.fp != null && a.ppm ? a.ppm / (1 + a.fp / 100) : null;
  const market = facts([
    a.p ? [rt("f_price"), `${k(a.p)} PLN · ${k(a.ppm)} ${tr("ppm_u")}`] : null,
    // отчёт по адресу без площади — сделки за м², без пересчёта на квартиру
    !a.a && D.rc?.h ? [rt("f_house"), `${k(D.rc.h[1])} ${tr("ppm_u")} — ${rt("deals_n")(D.rc.h[0])}`] : null,
    !a.a && D.rc?.m ? [rt("f_near"), `${k(D.rc.m)} ${tr("ppm_u")} — ${rt("deals_n")(D.rc.n)}`] : null,
    D.house ? [rt("f_house"), `${k(D.rc.h[1])} ${tr("ppm_u")} — ${rt("deals_n")(D.rc.h[0])}${a.p ? `, ${thisGap(D.house)}` : ""}`, rt("per_flat")(k(ROUNDH(D.house, 1000)))] : null,
    D.near ? [rt("f_near"), `${k(a.dlm ?? D.rc.m)} ${tr("ppm_u")} — ${rt("deals_n")(a.dln ?? D.rc.n)}${a.p ? `, ${thisGap(D.near)}` : ""}`, rt("near_sub")(a.dlm ? a.r : null)] : null,
    compsPpm ? [rt("f_comps"), `≈ ${k(compsPpm)} ${tr("ppm_u")}, ${Math.abs(a.fp) < 1 ? rt("this_same") : rt(a.fp > 0 ? "this_more" : "this_less")(pct(a.fp))}`, rt("comps_sub")] : null,
    pts.length > 1 ? [rt("f_hist"), pts.map((p) => k(p[1])).join(" → "),
      `${pts.map((p) => `${p[0].slice(8, 10)}.${p[0].slice(5, 7)}`).join(" → ")}${drops ? ` · ${rt("hist_sub")(drops, k(net), (net / pts[0][1] * 100).toFixed(1).replace(/\.0$/, "").replace(".", ","))}` : ""}`] : null,
    a.rl ? [rt("f_relist"), esc(rt("relisted")(a.rl + 1))] : null,
  ]);
  const cL = D.costs(a.p), cT = D.target ? D.costs(D.target) : null;
  const col = (fn) => `<td>${fn(cL)}</td>${cT ? `<td>${fn(cT)}</td>` : ""}`;
  const head2 = `<thead><tr><th></th><th>${rt("col_list")}</th>${cT ? `<th>${esc(rt("col_target")(k(D.target)))}</th>` : ""}</tr></thead>`;
  const tr2 = (label, sub, fn) => `<tr><td>${esc(label)}${sub ? `<span class="rp-sub">${esc(sub)}</span>` : ""}</td>${col(fn)}</tr>`;
  const agency = a.ut === "agency";
  const pkt = tr("f_park")[a.pkt] ? a.pkt : "any", parkLbl = tr("f_park")[pkt];   // вид места (export.py: pkt)
  const total = `<div class="rp-panel"><table class="rp-table">${head2}<tbody>
    ${tr2(rt("r_flat"), "", (c) => k(c.price))}
    ${tr2(rt("r_pcc"), a.mt === "primary" ? rt("r_pcc_prim") : rt("r_pcc_s"), (c) => c.pcc ? k(c.pcc) : rt("r_none"))}
    ${tr2(rt("r_not"), rt("r_not_s"), (c) => `≈ ${k(ROUNDH(c.notary))}`)}
    ${tr2(rt("r_court"), rt("r_court_s"), (c) => `≈ ${k(c.court)}`)}
    ${tr2(rt("r_bank"), rt("r_bank_s"), (c) => `≈ ${k(c.bank)}`)}
    ${a.cms ? tr2(a.cm ? `${rt("r_agency")} ${String(a.cm).replace(".", ",")}%` : rt("r_agency"), rt("r_agency_s")[a.cms],
                  (c) => c.comm ? `≈ ${k(ROUNDH(c.comm))}` : rt("r_none"))
      : tr2(rt("r_agency"), "", () => agency ? rt("r_agency_ask") : rt("r_none"))}
    <tr class="rp-total"><td>${rt("r_total")}${agency && !a.cms ? `<span class="rp-sub">${rt("r_total_s")}</span>` : ""}</td>${col((c) => `≈ ${k(ROUNDH(c.total))}`)}</tr>
    ${a.pk ? `<tr class="rp-gap"><td></td><td></td>${cT ? "<td></td>" : ""}</tr>
    ${tr2(`${parkLbl}${pkt === "mixed" ? ` · ${tr("park_from")} ${k(a.pk)}` : ""}`, rt("r_park_s")[pkt], () => `+ ${k(a.pk)}`)}
    <tr class="rp-total"><td>${rt("r_total_park")[pkt]}</td>${col((c) => `≈ ${k(ROUNDH(c.total + a.pk))}`)}</tr>`
      : a.pki ? tr2(parkLbl, "", () => rt("r_park_in")) : ""}
  </tbody></table></div>`;
  const czKnown = a.cz != null || a.czs === "none";
  const czCell = a.czs === "none" ? rt("r_none") : a.cz != null ? k(a.cz) : rt("r_cz_ask");
  const month = (c, down) => D.rata(c.price, down) + (a.cz || 0);
  const full = czKnown && !D.heatSep;
  const monthCell = (c, down) => `${full ? "≈ " : tr("own_from") + " "}${k(ROUNDH(month(c, down) , 10))} zł`;
  const cash = (c, down) => c.price * down + c.pcc + c.notary + c.court + c.bank + c.comm;
  const monthly = `<div class="rp-panel"><table class="rp-table">${head2}<tbody>
    ${tr2(rt("r_cash")(10), rt(cL.comm ? "r_cash_s_c" : "r_cash_s"), (c) => `≈ ${k(ROUNDH(cash(c, 0.1)))}`)}
    ${tr2(rt("r_cash")(20), "", (c) => `≈ ${k(ROUNDH(cash(c, 0.2)))}`)}
    <tr class="rp-gap"><td></td><td></td>${cT ? "<td></td>" : ""}</tr>
    ${tr2(rt("r_loan")(10), rt("r_loan_s"), (c) => k(D.rata(c.price, 0.1)))}
    ${tr2(rt("r_loan")(20), rt("r_loan_s"), (c) => k(D.rata(c.price, 0.2)))}
    ${tr2(rt("r_cz"), a.czs === "none" ? rt("r_cz_none") : a.czs === "desc" ? rt("r_cz_desc") : a.cz != null ? rt("r_cz_ad") : "", () => czCell)}
    <tr class="rp-total"><td>${rt("r_month")(10)}</td>${col((c) => monthCell(c, 0.1))}</tr>
    <tr class="rp-total"><td>${rt("r_month")(20)}</td>${col((c) => monthCell(c, 0.2))}</tr>
  </tbody></table></div>
  <p class="rp-foot">${esc(rt("foot_loan")((D.m.rate * 100).toFixed(1).replace(/\.0$/, "").replace(".", LANG === "pl" ? "," : ","), D.m.years))}${D.heatSep && a.ht ? " " + esc(rt("foot_heat")((tr("ht")[a.ht] || ""))) : ""}</p>`;

  // ── торг
  const args = [];
  if (D.house && D.house < a.p * 0.97) args.push(rt("a_house")(k(ROUNDH(D.house, 1000))));
  if (gap != null && gap >= TRADE_GAP) args.push(rt("a_near")(gap));
  if (days >= TRADE_DAYS) args.push(rt("a_days")(days));
  if (drops && net >= pts[0][1] * 0.005) args.push(rt("a_drops")(drops, k(net)));
  if (a.rl) args.push(rt("a_relist")(a.rl + 1));
  if (a.nl >= 60) args.push(rt("a_noise")(a.nl, noiseSrc));
  if (negTxt) args.push(rt("a_neg")(negTxt));
  if (metroMin != null && metroMin > 20) args.push(rt("a_metro")(metroTxt, metroMin <= 30));
  if (!hasEx("l") && a.fl >= 4) args.push(rt("a_lift")(a.fl));
  const rare = hasEx("g") || hasEx("t");
  const selS = [hasEx("g") && rt("sel_garden"), !hasEx("g") && hasEx("t") && rt("sel_terrace"),
    a.by >= today.getFullYear() - 6 && rt("sel_new")(a.by), a.cs === "ready_to_use" && rt("sel_ready"),
    a.fp != null && a.fp <= 2 && rt("sel_comps"), a.nl != null && a.nl < 60 && rt("sel_quiet"),
    metroMin != null && metroMin <= 12 && rt("sel_metro")(metroTxt)].filter(Boolean);
  const selW = [days >= TRADE_DAYS && rt("sel_days")(days), drops && net >= pts[0][1] * 0.005 && rt("sel_drops"),
    gap != null && gap >= TRADE_GAP && rt("sel_deals"), a.rl && rt("sel_relist")].filter(Boolean);
  const buyS = [a.ut !== "developer" && rt("buy_date"), rt("buy_fast"), (D.house || D.near) && rt("buy_data")].filter(Boolean);
  const buyW = [rare && rt("buy_rare"), a.fp != null && a.fp <= -5 && rt("buy_cheap")].filter(Boolean);
  const trade = `
    <div class="rp-plan"><strong>${esc(D.tradeOk ? rt("plan")(k(D.start), k(D.target)) : rt("plan_none"))}</strong>
      ${D.tradeOk ? `<span>${esc(rt(D.house ? "plan_sub_house" : "plan_sub_near"))}</span>` : ""}</div>
    ${args.length ? `<div class="rp-blk"><h3 class="rp-label">${rt("l_args")}</h3>
      <ul class="rp-items rp-panel">${args.map(([b, t]) => `<li><b>${esc(b)}</b> ${esc(t)}</li>`).join("")}</ul></div>` : ""}
    <div class="rp-grid rp-grid--2">
      ${card(rt("c_sel_s"), "good", selS)}${card(rt("c_sel_w"), "bad", selW)}
      ${card(rt("c_buy_s"), "good", buyS)}${card(rt("c_buy_w"), "bad", buyW.length ? buyW : [rt("buy_none")])}
    </div>`;

  // ── плюсы и минусы
  const park = D.nearest(RL.park), kinder = D.nearest(RL.kinder), school = D.nearest(RL.school);
  const pros = [], mid = [], cons = [];
  const amen = (a.ex || []).filter((c) => ["g", "t", "b", "l", "gr", "ac", "u"].includes(c)).map((c) => tr("wa")[c]);
  if (amen.length) pros.push([rt("p_amen"), amen.map((x, i) => (i ? x.toLowerCase() : x)).join(", ")]);
  if (a.by >= today.getFullYear() - 6) pros.push(rt("p_new")(a.by));
  if (metroMin != null && metroMin <= 12) pros.push(rt("p_metro")(metroTxt, metro[2]));
  else if (metroMin != null && metroMin <= 20) mid.push(rt("n_metro")(metroTxt));
  else if (metro) cons.push(rt("m_metro")(metroTxt, metroMin <= 30));
  if (a.nl != null && a.nl < 55) pros.push(rt("p_quiet")(a.nl));
  else if (a.nl != null && a.nl < 60) pros.push(rt("p_quiet")(a.nl));
  else if (a.nl != null) cons.push(rt("m_noise")(a.nl, noiseSrc));
  if (park && park[4] != null && park[4] <= 12) pros.push(rt("p_park")(park[2], D.walkTxt(park)));
  if (kinder && school && kinder[4] != null && school[4] != null && kinder[4] <= 12 && school[4] <= 12)
    pros.push(rt("p_kids")(`${lc1(distName(D.layers[RL.kinder][0]))} ${kinder[4]} ${tr("min")}, ${lc1(distName(D.layers[RL.school][0]))} ${school[4]} ${tr("min")} ${rt("on_foot")}`));
  if (a.se != null && a.se >= 70) pros.push(rt("p_school")(Math.round(a.se)));
  if (gap != null && gap <= -TRADE_GAP) pros.push(rt("p_cheap")(-gap));
  if (gap != null && gap >= TRADE_GAP) cons.push(rt("m_more")(gap));
  if (negTxt) cons.push(rt("m_neg")(negTxt));
  if (!hasEx("l") && a.fl >= 4) cons.push(rt("m_lift")(a.fl));
  state.places.forEach((pl, i) => { const t = state.placeTimes[i]?.[a.id]; if (t != null) mid.push(rt("n_place")(pl.name, t)); });
  const prosHtml = `<div class="rp-grid rp-grid--3">${card(rt("c_pros"), "good", pros.map(([t, s]) => s ? [t, s] : t))}${card(rt("c_mid"), "mid", mid)}${card(rt("c_cons"), "bad", cons)}</div>`;

  // ── фото
  const pics = photoData?.[a.id] || [];
  const photos = pics.length > 1 ? `<div class="rp-photos">${pics.slice(0, 9).map(([full]) => `<img src="${esc(full)}" alt="">`).join("")}</div>` : "";
  // планировка — после фото, крупно (у Otodom — отдельное поле объявления, в галерею не входит)
  const planUrls = planData?.[a.id] || [];
  const plans = planUrls.length ? `<div class="rp-plans">${planUrls.map((u) => `<img src="${esc(u)}" alt="${esc(rt("s_plan"))}">`).join("")}</div>` : "";

  // ── рейтинг и окружение
  const bars = a.ax ? `<div class="rp-bars">${a.ax.map((v, i) => v == null ? "" :
    `<span>${esc(axisName(i))}</span><span class="rp-track"><span class="rp-fill" style="width:${v}%"></span></span><span class="rp-val">${v}</span>`).join("")}</div>` : "";
  const placesRows = state.places.map((pl, i) => {
    const t = state.placeTimes[i]?.[a.id];
    if (t == null) return null;
    const w = state.placeWalk[i]?.[a.id], alt = state.placeAlt[i]?.[a.id];
    return [pl.name, `${t} ${tr("min")} · ${modeWords(placeModes(i, a.id))}`,
      [w != null && w >= 1 ? tr("walk_to_stop")(w) : "", alt != null ? tr("alt_bus")(alt) : ""].filter(Boolean).join(" · ")];
  });
  // окружение — строками «название · вид — расстояние», по одной на объект: в строку через «·»
  // текст рвался неровно (юзер 19.10: «длинная строка, потом короткая и по новой»)
  const kv = (d) => {
    const kind = distName(D.layers[d[0]][0]);
    return `<div class="rp-kv"><span>${esc(d[2] || kind)}${d[2] ? ` <i>${esc(lc1(kind))}</i>` : ""}</span><b>${esc(D.walkTxt(d))}</b></div>`;
  };
  const kvs = (lis) => lis.map((li) => D.nearest(li)).filter(Boolean).map(kv).join("");
  const tRow = kvs([RL.metro, RL.stop, RL.train]), kRow = kvs([RL.play, RL.school, RL.kinder, RL.nursery]);
  const negRows = D.neg.slice(0, 5).map((d) => `<div class="rp-kv"><span>${esc(distName(D.layers[d[0]][0]))}${d[2] ? ` <i>${esc(d[2])}</i>` : ""}</span><b>${esc(fmtM(d[1]))}</b></div>`).join("");
  const env = `<div class="rp-panel rp-env">${bars}${facts([
    ...placesRows,
    tRow ? [rt("rf_transport"), tRow] : null,
    kRow ? [rt("rf_kids"), kRow] : null,
    D.nearest(RL.shop) ? [rt("rf_shop"), kvs([RL.shop])] : null,
    D.nearest(RL.park) ? [rt("rf_park"), kvs([RL.park])] : null,
    a.nl != null ? [rt("rf_noise"), esc(rt("noise_v")(a.nl, noiseSrc))] : [rt("rf_noise"), esc(rt("noise_low"))],
    negRows ? [rt("rf_neg"), negRows] : null,
  ]).replace('class="rp-facts rp-panel"', 'class="rp-facts"')}</div>`;

  // ── вопросы и проверка
  const ask = [rt("q_cz")(a.cz != null ? k(a.cz) : null), D.heatSep && rt("q_heat"), agency && rt("q_agency"),
    hasEx("gr") && rt("q_garage"), a.cs && a.cs !== "ready_to_use" && rt("q_repair"),
    a.ut === "developer" ? rt("q_dev") : rt("q_kw"), a.ut !== "developer" && rt("q_why")].filter(Boolean);
  const firstNeg = D.neg[0];
  const check = [state.places.length && rt("k_stop"), a.nl >= 55 && noiseSrc && rt("k_noise")(noiseSrc),
    firstNeg && rt("k_neg")(`${lc1(distName(D.layers[firstNeg[0]][0]))} ${rt("in_m")(fmtM(firstNeg[1]))}`),
    a.fl != null && a.fl <= 1 && rt("k_light"), hasEx("g") && rt("k_garden"), a.fl != null && a.tf && a.fl === a.tf && rt("k_roof"),
    rt("k_damp"), rt("k_common")].filter(Boolean);

  const sec = (title, body, lead = "") => `<section class="rp-sec"><div class="rp-head"><h2 class="rp-h2">${esc(title)}</h2>${lead ? `<p class="rp-lead">${esc(lead)}</p>` : ""}</div>${body}</section>`;
  // отчёт вне базы (id «x…»): пометка, что известно; по адресу — поля, чем больше, тем полнее
  const ext = a.id?.startsWith("x") && EXT ? (EXT.kind === "addr"
    ? `<div class="rp-note">ⓘ <span>${rt("ext_addr")}</span></div>${extFormHtml()}`
    : `<div class="rp-note">ⓘ <span>${rt("ext_link")(a.seen ? fmtDate(a.seen) : "")}</span></div>`) : "";
  return `${head}${ext}
    ${sec(rt("s_price"), `<div class="rp-blk"><h3 class="rp-label">${rt("l_market")}</h3>${market}</div>
      ${a.p ? `<div class="rp-blk"><h3 class="rp-label">${rt("l_total")}</h3>${total}</div>
      <div class="rp-blk"><h3 class="rp-label">${rt("l_month")}</h3>${monthly}</div>` : `<p class="rp-lead">${esc(rt(EXT?.kind === "addr" ? "no_price" : "no_price_ad"))}</p>`}`)}
    ${a.p ? sec(rt("s_trade"), trade) : ""}
    ${sec(rt("s_pros"), prosHtml)}
    ${photos ? sec(rt("s_photos"), photos) : ""}
    ${plans ? sec(rt("s_plan"), plans) : ""}
    ${sec(rt("s_rate"), env)}
    <section class="rp-sec rp-two">
      <div class="rp-blk"><div class="rp-head"><h2 class="rp-h2">${rt("s_ask")}</h2><p class="rp-lead">${rt("s_ask_lead")}</p></div>
        <ol class="rp-ol rp-panel">${ask.map((q) => `<li>${esc(q)}</li>`).join("")}</ol></div>
      <div class="rp-blk"><div class="rp-head"><h2 class="rp-h2">${rt("s_check")}</h2><p class="rp-lead">${rt("s_check_lead")}</p></div>
        <div class="rp-panel rp-checks">${check.map((c) => `<label class="ds-check"><input type="checkbox"> ${esc(c)}</label>`).join("")}</div></div>
    </section>
    <footer class="rp-footer"><span>${esc(rt("sources"))}</span><span>${esc(rt("disclaimer"))}</span></footer>`;
}
const ROUNDH = (v, step = 100) => Math.round(v / step) * step;

/* Отчёт вне базы (20.10.2026): id «x<код>» — данные с сервера (6.valuate /report/ext/<код>):
 * объявление Otodom не из базы (kind=link) или адрес (kind=addr) — та же запись, что у
 * квартиры сайта, плюс сделки, «Что рядом» и фото; подмешиваются в общие словари отчёта. */
let EXT = null;
async function loadExt(id) {
  try {
    const r = await fetch(`${API_BASE}/report/ext/${encodeURIComponent(id.slice(1))}`);
    EXT = r.ok ? await r.json() : null;
  } catch (e) { EXT = null; }
}
function extInject(id) {
  if (!EXT) return;
  rcnData = rcnData || {}; if (EXT.rcn) rcnData[id] = EXT.rcn;
  if (distData) { distData.apts = distData.apts || {}; distData.apts[id] = EXT.dist || []; }
  photoData = photoData || {}; photoData[id] = (EXT.photos || []).map((u) => [u, u]);
  planData = planData || {}; planData[id] = EXT.plans || [];
}
function extFormHtml() {
  const f = EXT?.fields || {};
  const inp = (key, label, step = "1") => `<label>${esc(rt(label))}<input type="number" inputmode="decimal" step="${step}" min="0" name="${key}" value="${f[key] ?? ""}"></label>`;
  return `<form class="rp-ext-form rp-panel" id="rp-ext-form">${inp("area", "ef_area", "0.01")}${inp("price", "ef_price")}${inp("rooms", "ef_rooms")}
    ${inp("floor", "ef_floor")}${inp("total_floors", "ef_tf")}${inp("build_year", "ef_year")}
    <label>${esc(rt("ef_market"))}<select name="market"><option value="secondary"${f.market !== "primary" ? " selected" : ""}>${esc(rt("ef_sec"))}</option><option value="primary"${f.market === "primary" ? " selected" : ""}>${esc(rt("ef_prim"))}</option></select></label>
    <button type="submit" class="ds-btn ds-btn--primary">${esc(rt("ef_go"))}</button><span class="rp-ext-msg" aria-live="polite"></span></form>`;
}
function bindExtForm() {
  const form = $("#rp-ext-form");
  if (!form || !EXT) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const msg = form.querySelector(".rp-ext-msg");
    msg.textContent = rt("ef_wait");
    const body = { lat: EXT.apt.lat, lon: EXT.apt.lon, address: EXT.apt.st };
    new FormData(form).forEach((v, k) => { if (v !== "") body[k] = v; });
    try {
      const r = await fetch(`${API_BASE}/report/ext`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok || !j.code) throw new Error(j.error || "");
      location.replace(`?report=x${j.code}&lang=${LANG}`);
    } catch (err) { msg.textContent = err.message || rt("ef_err"); }
  };
}

async function openReport(id) {
  document.body.classList.add("report-mode");
  let host = $("#report");
  if (!host) { host = document.createElement("div"); host.id = "report"; document.body.appendChild(host); }
  const isExt = id.startsWith("x");
  if (isExt) await loadExt(id);
  const render = () => {
    if (isExt) extInject(id);
    const a = state.all.find((x) => x.id === id) || (isExt && EXT ? EXT.apt : null);
    const title = isExt && EXT?.kind === "addr" ? rt("addr_title") : rt("title");
    const bar = `<header class="rp-top"><div class="rp-brand"><a href="${location.pathname}?lang=${LANG}">Warsaw Flats</a><span>${title}</span></div>
      <div class="rp-actions"><button type="button" class="ds-btn" id="rp-share" aria-label="${rt("share")}">${SHARE_SVG}<span>${rt("share")}</span></button>
        <button type="button" class="ds-btn" id="rp-tg" aria-label="${rt("tg")}">${SHARE_SVG}<span class="rp-l">${rt("tg")}</span><span class="rp-s">Telegram</span></button>
        <button type="button" class="ds-btn" id="rp-pdf" aria-label="${rt("pdf")}"><span class="rp-l">${rt("pdf")}</span><span class="rp-s">PDF</span></button></div></header>`;
    // телефон: «Поделиться» — значком, «Открыть в Telegram» → «Telegram», «Сохранить PDF» → «PDF»
    // (CSS .rp-l/.rp-s; раньше кнопки наезжали на название сайта, аудит 21.10)
    // квартиры нет (сняли, ссылка из бота) — без кнопок «поделиться», зато путь к списку
    const notFound = `<p class="rp-lead">${rt("notfound")}</p><p><a class="ds-btn" href="${location.pathname}?lang=${LANG}">${rt("back")}</a></p>`;
    host.innerHTML = (a ? bar : bar.replace(/<div class="rp-actions">[\s\S]*<\/div><\/header>/, "</header>"))
      + `<main class="rp">${a ? reportHtml(a) : notFound}</main>`;
    document.title = a ? `${rt("title")} — ${[a.st || a.d].filter(Boolean).join("")}` : rt("title");
    if (!a) return;
    $("#rp-pdf").onclick = () => window.print();
    // «Открыть в Telegram» (макет «Отчёт: версии и Telegram», 20.10.2026): бот пришлёт этот отчёт в чат
    $("#rp-tg").onclick = () => {
      toast(rt("tg_toast"));
      setTimeout(() => { location.href = `https://t.me/Flats_Warsaw_Bot?start=r_${encodeURIComponent(id)}`; }, 600);
    };
    bindExtForm();
    $("#rp-share").onclick = async () => shareOut(await shortUrl(new URLSearchParams({ report: id, lang: LANG })),
      a ? `${rt("title")}: ${[a.d, a.st].filter(Boolean).join(", ")}` : rt("title"));
  };
  render();
  await Promise.all([loadRcn(), loadHist(), loadHeavy(), loadPhotos(), loadPlans()]);
  render();
  reportRerender = render;
}
let reportRerender = null;
