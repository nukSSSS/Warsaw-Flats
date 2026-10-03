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

import { API_BASE } from "./api-base.js?v=202610040158";
import { profileToken, syncProfile } from "./site-ui.js?v=202610040158";

// #places / #want — переход из «Мой профиль» («Изменить»). Запомнить до того,
// как apply() перепишет адрес фильтрами (replaceState без хэша).
const START_HASH = location.hash;

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
  profilePrefs: null,   // профиль с сервера (вход по ссылке из бота) — места пишутся туда
  activeArch: false,    // открыта карточка СНЯТОЙ квартиры (её нет в state.shown — apply() её не закрывает)
  favArchOpen: false,   // раскрыта ли строка «Сняты с продажи — N из избранного»
  bot: null,            // что знает бот (вход по ссылке): {query, subscribed, …} — кнопка «Уведомлять»
  hidden: new Set(),    // мой чёрный список: ключи групп/квартир (hideKey), хранится в localStorage
  showHidden: false,    // true — в списке ТОЛЬКО скрытые (посмотреть и вернуть)
  favorites: new Set(), // избранное: ключи групп/квартир (favKey), независимо от чёрного списка
  onlyFav: false,        // true — в списке ТОЛЬКО избранное (доп. фильтр, не режим просмотра)
};

let map, layer, canvas, markers = new Map();
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

/* ── Переводы ────────────────────────────────────────────────────────────────
 * Строки ИНТЕРФЕЙСА живут здесь: больше их нигде в проекте нет.
 * Подписи осей и GIS-слоёв сюда НЕ дублируются — они приходят в meta.i18n из
 * словаря бота и из карты, иначе три копии разъехались бы при первой правке.
 * Ключи короткие: их читает только этот файл и data-i18n в разметке. */
const T = {
  ru: {
    sort: "Сортировка", s_p: "цена ↑", s_pd: "цена ↓", s_sc: "рейтинг ↓",
    work_s: "до работы", menu_profile: "Мой профиль →",
    amen: { lift: "лифт", garden: "сад", usable_room: "кладовка", balcony: "балкон",
            terrace: "терраса", air_conditioning: "кондиционер", basement: "подвал",
            garage: "гараж", separate_kitchen: "отдельная кухня", two_storey: "двухуровневая" },
    s_ppm: "цена за м² ↑", s_a: "площадь ↓", s_new: "новизна",
    theme_t: "Светлая / тёмная тема", reset: "Сброс", from: "от", to: "до",
    collapse_t: "Свернуть список", expand_t: "Развернуть список",
    f_axes: "Минимум по осям рейтинга",
    flt: "Фильтры", flt_done: "Готово",
    flt_more: "Ещё фильтры", reset_all: "Сбросить всё", reset_panel: "Сбросить",
    flt_show: (n) => `Показать ${n} квартир`,
    fg_quick: "Быстрые", fg_apt: "Квартира", fg_rating: "Рейтинг места",
    fg_seller: "Рынок и продавец", fg_loc: "Локация", fg_cond: "Состояние",
    fg_work: "До работы", fg_map: "С карты",
    fg_map_note: "Фильтр «рядом с остановкой» включается кликом по остановке на карте и показывается чипом над списком.",
    f_price_from: "Цена от, тыс.", f_area_from: "Площадь от, м²", f_year_from: "Год постройки от",
    f_work: "Работа", work_off: "Выключить", done: "Готово", close: "Закрыть", any: "любая",
    want_t: "Важно для меня", want_none: "не выбрано",
    my_places: "Мои места", fg_work: "Время в пути", transit: "общ. транспорт",
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
          n2: "Без двух уровней", na: "Без мансарды" },
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
    commute_calc_busy: "Считаю…", commute_ok: (n) => `Готово: посчитано для ${n} квартир`,
    commute_err_addr: "Введите адрес", commute_err_backend: "Локальный сервер недоступен (нужен 6.valuate/api.py)",
    commute_addr_ph: "например, Prosta 67",
    f_district: "Район", f_market: "Рынок", f_seller: "Продавец", f_cond: "Состояние",
    list_a: "Список квартир", close_a: "Закрыть",
    ut: { private: "Собственник", developer: "Застройщик", agency: "Агентство" },
    mt: { primary: "Первичка", secondary: "Вторичка" },
    cs: { ready_to_use: "Под ключ", to_completion: "Под отделку", to_renovation: "Под ремонт" },
    rooms_s: "комн.", min: "мин", days_u: "дн",
    rating: "рейтинг", cheaper: "дешевле рынка", pricier: "дороже рынка",
    f_ppm: "Цена за м²", f_area2: "Площадь", f_rooms2: "Комнаты", f_floor: "Этаж",
    f_of: "из", f_year2: "Год", f_seller2: "Продавец", f_market2: "Рынок",
    f_cond2: "Состояние", f_metro: "Метро пешком", f_noise: "Шум",
    f_school: "Школа E8", f_own: "Владение", f_since: "На рынке с",
    f_commute2: "Дорога до дома", noise_lt: "до 45 дБ", db: "дБ", mo: "zł/мес",
    otodom: "Открыть объявление", street: "Street View", devall: "Все квартиры ЖК",
    noaddr: "Без адреса", blur: (m) => `пин размыт продавцом (±${m} м) — адрес и рейтинг приблизительны`,
    gaps: (n) => `не указано параметров: ${n}`,
    dist: "Что рядом", pos: "Плюсы", neg: "Минусы", dwait: "расстояния загружаются…",
    dsort_dist: "расстояние", dsort_weight: "важность", dsort_label: "сортировка «Что рядом»",
    rem: "Ранее на продаже", roff: "снято", arch: "Архив объявления",
    l_apts: "Квартиры", l_rem: "Снятые с продажи",
    l_iso: "Доступность", l_gios: "Качество воздуха PM2.5 (GIOŚ)",
    l_airly: "Качество воздуха PM2.5 (Airly)",
    ns_air: "самолёты", ns_rail: "ж/д", ns_tram: "трамвай", ns_industry: "промышленность", ns_road: "дороги",
    l_tram: "Трамвай: линии и остановки", l_metro: "Метро: линии и станции",
    l_metro_construction: "🚧 Метро: строится",
    layers_t: "Слои карты", g_offers: "Предложения", g_transit: "Транспорт", g_noise: "Шум",
    g_air: "Воздух PM2.5", g_iso: "Изохроны",
    noise_src: "Источник", noise_off: "выключен", noise_leg: "Шум, дБ", per_day: "Сутки", per_night: "Ночь",
    nz_road: "Дороги", nz_rail: "Железная дорога", nz_air: "Самолёты", nz_tram: "Трамвай", nz_industry: "Промышленность",
    stop_near: "Квартир в радиусе", near_on: "Показать квартиры рядом", near_off: "Показать все квартиры",
    lines_title: "Линии", lines_hint: "нажми на номер или линию — выделить", lines_clear: "сбросить",
    tram_w: "Трамвай", metro_w: "Метро", station_w: "станция",
    metro_construction_w: "Метро (строится)",
    stop_tram: "Остановка трамвая", stop_metro: "Станция метро",
    stop_metro_construction: "Станция метро (строится)",
    metro_construction_note: "Станция строится, дата открытия не объявлена. Не учитывается в рейтинге пешей доступности.",
    hide: "Скрыть", unhide: "Вернуть", hide_t: "Скрыть эту квартиру (и её повторы) из моей выдачи",
    unhide_t: "Вернуть в выдачу", hid_toast: "Скрыто", undo: "Отменить",
    fav: "В избранное", unfav: "Убрать из избранного",
    fav_t: "Добавить эту квартиру (и её повторы) в избранное",
    unfav_t: "Убрать из избранного", fav_toast: "Добавлено в избранное", unfav_toast: "Убрано из избранного",
    f_checked: "Проверено", today: "сегодня", yesterday: "вчера", ago_d: (n) => `${n} дн назад`,
    stale_hint: "давно не проверялось — возможно, уже снято",
    dup_note: (n) => `+${n} похожих`, dups_t: (n) => `Похожие объявления (${n})`,
    dup_hint: "Повторы этой же квартиры: тот же дом, площадь, этаж и цена в пределах 4%. В списке скрыты, здесь — все ссылки.",
    legend: "PM2.5, µg/м³", err: "Не удалось загрузить данные.",
    m2: "м²", km: "км", m_u: "м", yr: "г.", ppm_u: "zł/м²", metro_s: "метро",
    shown_of: (n, all) => `${n} из ${all}`,
    empty_h: "Ничего не найдено — ослабь фильтры",
    gap_card: (n) => `в объявлении не хватает ${n} парам. — балл менее точен`,
    rem_tip: (n) => `Снято с продажи: ${n}`, rem_more: (n) => `+ ещё ${n}`,
    // снятая с продажи квартира — та же карточка с пометкой
    arch_tag: (d) => `Снято с продажи ${d}`, arch_tag_s: (d) => `Снято ${d}`, arch_last: "Последняя цена",
    arch_note: "Объявление снято с продажи. У квартир, снятых до 1 октября 2026, фото, оценки по осям и «Что рядом» не сохранились — только то, что ниже.",
    arch_period: "В продаже", arch_otodom: "Объявление на Otodom (может быть удалено)", arch_open: "Карточка",
    arch_fav: (n) => `Сняты с продажи — ${n} из избранного`, arch_here: "Снятые по этому адресу",
    // «Уведомлять» — поиск сайта → бот
    ntf_btn: "Уведомлять", ntf_on: "Уведомления вкл.",
    ntf_t: "Уведомлять о новых квартирах", ntf_on_t: "Уведомления включены",
    ntf_lead: "Бот в Telegram будет присылать новые квартиры по этому поиску:",
    ntf_lead_out: "Новые квартиры по этому поиску бот пришлёт в Telegram 4 раза в день. Нужен вход — один раз, через бота.",
    ntf_lead_on: "Бот присылает новые квартиры по этому поиску 4 раза в день:",
    ntf_now: "Сейчас в боте:", ntf_when: "Приходят 4 раза в день: 08:00, 13:00, 18:00, 22:00.",
    ntf_off_note: "Сейчас уведомления выключены — сохранение их включит.",
    ntf_on_note: "Поменяйте фильтры — кнопка снова станет «Уведомлять», и новый поиск можно будет сохранить.",
    ntf_login_note: "Напишите боту /profile — он пришлёт ссылку для входа. Потом вернитесь и нажмите «Уведомлять».",
    ntf_cancel: "Отмена", ntf_save: "Сохранить в бот", ntf_saving: "Сохраняю…", ntf_login: "Войти через Telegram",
    ntf_off: "Выключить уведомления", ntf_err: "Не удалось сохранить — попробуйте ещё раз.",
    ntf_all: "Все квартиры, без фильтров", ntf_price: "Цена", ntf_rooms: (v) => `Комнаты ${v}`,
    ntf_districts: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "район" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "района" : "районов"}`,
    err_h: "Запусти <code>venv/bin/python 5.web/export.py</code> и открой страницу через локальный сервер.",
  },
  pl: {
    sort: "Sortowanie", s_p: "cena ↑", s_pd: "cena ↓", s_sc: "ocena ↓",
    work_s: "do pracy", menu_profile: "Mój profil →",
    amen: { lift: "winda", garden: "ogródek", usable_room: "komórka", balcony: "balkon",
            terrace: "taras", air_conditioning: "klimatyzacja", basement: "piwnica",
            garage: "garaż", separate_kitchen: "oddzielna kuchnia", two_storey: "dwupoziomowe" },
    s_ppm: "cena za m² ↑", s_a: "powierzchnia ↓", s_new: "najnowsze",
    theme_t: "Jasny / ciemny motyw", reset: "Wyczyść", from: "od", to: "do",
    collapse_t: "Zwiń listę", expand_t: "Rozwiń listę",
    f_axes: "Minimum na osiach rankingu",
    flt: "Filtry", flt_done: "Gotowe",
    flt_more: "Więcej filtrów", reset_all: "Wyczyść wszystko", reset_panel: "Wyczyść",
    flt_show: (n) => `Pokaż ${n} mieszkań`,
    fg_quick: "Szybkie", fg_apt: "Mieszkanie", fg_rating: "Ocena miejsca",
    fg_seller: "Rynek i sprzedający", fg_loc: "Lokalizacja", fg_cond: "Stan",
    fg_work: "Do pracy", fg_map: "Z mapy",
    fg_map_note: "Filtr „w pobliżu przystanku” włącza się kliknięciem w przystanek na mapie i widać go jako znacznik nad listą.",
    f_price_from: "Cena od, tys.", f_area_from: "Powierzchnia od, m²", f_year_from: "Rok budowy od",
    f_work: "Praca", work_off: "Wyłącz", done: "Gotowe", close: "Zamknij", any: "dowolna",
    want_t: "Ważne dla mnie", want_none: "nic nie wybrano",
    my_places: "Moje miejsca", fg_work: "Czas dojazdu", transit: "kom. miejska",
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
          n2: "Bez dwóch poziomów", na: "Bez poddasza" },
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
    commute_calc_busy: "Liczę…", commute_ok: (n) => `Gotowe: policzono dla ${n} mieszkań`,
    commute_err_addr: "Podaj adres", commute_err_backend: "Lokalny serwer niedostępny (wymaga 6.valuate/api.py)",
    commute_addr_ph: "np. Prosta 67",
    f_district: "Dzielnica", f_market: "Rynek", f_seller: "Sprzedający", f_cond: "Stan",
    list_a: "Lista mieszkań", close_a: "Zamknij",
    ut: { private: "Właściciel", developer: "Deweloper", agency: "Biuro nieruchomości" },
    mt: { primary: "Pierwotny", secondary: "Wtórny" },
    cs: { ready_to_use: "Do zamieszkania", to_completion: "Do wykończenia", to_renovation: "Do remontu" },
    rooms_s: "pok.", min: "min", days_u: "dn.",
    rating: "ocena", cheaper: "taniej niż rynek", pricier: "drożej niż rynek",
    f_ppm: "Cena za m²", f_area2: "Powierzchnia", f_rooms2: "Pokoje", f_floor: "Piętro",
    f_of: "z", f_year2: "Rok", f_seller2: "Sprzedający", f_market2: "Rynek",
    f_cond2: "Stan", f_metro: "Metro pieszo", f_noise: "Hałas",
    f_school: "Szkoła E8", f_own: "Utrzymanie", f_since: "Na rynku od",
    f_commute2: "Dojazd do domu", noise_lt: "do 45 dB", db: "dB", mo: "zł/mies.",
    otodom: "Otwórz ogłoszenie", street: "Street View", devall: "Wszystkie mieszkania inwestycji",
    noaddr: "Bez adresu", blur: (m) => `pinezka rozmyta przez sprzedającego (±${m} m) — adres i ocena przybliżone`,
    gaps: (n) => `brakujących parametrów: ${n}`,
    dist: "Co w okolicy", pos: "Plusy", neg: "Minusy", dwait: "wczytywanie odległości…",
    dsort_dist: "odległość", dsort_weight: "ważność", dsort_label: "sortowanie „Co w okolicy”",
    rem: "Wcześniej w sprzedaży", roff: "zdjęto", arch: "Archiwum ogłoszenia",
    l_apts: "Mieszkania", l_rem: "Zdjęte ze sprzedaży",
    l_iso: "Dojazd", l_gios: "Jakość powietrza PM2.5 (GIOŚ)",
    l_airly: "Jakość powietrza PM2.5 (Airly)",
    ns_air: "samoloty", ns_rail: "kolej", ns_tram: "tramwaj", ns_industry: "przemysł", ns_road: "drogi",
    l_tram: "Tramwaj: linie i przystanki", l_metro: "Metro: linie i stacje",
    l_metro_construction: "🚧 Metro: w budowie",
    layers_t: "Warstwy mapy", g_offers: "Oferty", g_transit: "Transport", g_noise: "Hałas",
    g_air: "Powietrze PM2.5", g_iso: "Izochrony",
    noise_src: "Źródło", noise_off: "wyłączony", noise_leg: "Hałas, dB", per_day: "Doba", per_night: "Noc",
    nz_road: "Drogi", nz_rail: "Kolej", nz_air: "Samoloty", nz_tram: "Tramwaj", nz_industry: "Przemysł",
    stop_near: "Mieszkań w promieniu", near_on: "Pokaż mieszkania w pobliżu", near_off: "Pokaż wszystkie mieszkania",
    lines_title: "Linie", lines_hint: "kliknij numer lub linię — wyróżnij", lines_clear: "wyczyść",
    tram_w: "Tramwaj", metro_w: "Metro", station_w: "stacja",
    metro_construction_w: "Metro (w budowie)",
    stop_tram: "Przystanek tramwajowy", stop_metro: "Stacja metra",
    stop_metro_construction: "Stacja metra (w budowie)",
    metro_construction_note: "Stacja jest w budowie, data otwarcia nie jest znana. Nie liczy się do oceny dostępności pieszej.",
    hide: "Ukryj", unhide: "Przywróć", hide_t: "Ukryj to mieszkanie (i jego powtórzenia) z mojej listy",
    unhide_t: "Przywróć na listę", hid_toast: "Ukryto", undo: "Cofnij",
    fav: "Do ulubionych", unfav: "Usuń z ulubionych",
    fav_t: "Dodaj to mieszkanie (i jego powtórzenia) do ulubionych",
    unfav_t: "Usuń z ulubionych", fav_toast: "Dodano do ulubionych", unfav_toast: "Usunięto z ulubionych",
    f_checked: "Sprawdzono", today: "dzisiaj", yesterday: "wczoraj", ago_d: (n) => `${n} dn. temu`,
    stale_hint: "dawno nie sprawdzano — możliwe, że już zdjęte",
    dup_note: (n) => `+${n} podobnych`, dups_t: (n) => `Podobne ogłoszenia (${n})`,
    dup_hint: "Powtórzenia tego samego mieszkania: ten sam dom, powierzchnia, piętro i cena w granicach 4%. Na liście ukryte, tutaj — wszystkie linki.",
    legend: "PM2.5, µg/m³", err: "Nie udało się wczytać danych.",
    m2: "m²", km: "km", m_u: "m", yr: "r.", ppm_u: "zł/m²", metro_s: "metro",
    shown_of: (n, all) => `${n} z ${all}`,
    empty_h: "Nic nie znaleziono — poluzuj filtry",
    gap_card: (n) => `w ogłoszeniu brakuje ${n} param. — ocena mniej dokładna`,
    rem_tip: (n) => `Zdjęto ze sprzedaży: ${n}`, rem_more: (n) => `+ jeszcze ${n}`,
    arch_tag: (d) => `Zdjęto ze sprzedaży ${d}`, arch_tag_s: (d) => `Zdjęto ${d}`, arch_last: "Ostatnia cena",
    arch_note: "Ogłoszenie zdjęte ze sprzedaży. Dla mieszkań zdjętych przed 1 października 2026 zdjęcia, oceny osi i „Co w pobliżu” się nie zachowały — tylko to, co poniżej.",
    arch_period: "W sprzedaży", arch_otodom: "Ogłoszenie na Otodom (może być usunięte)", arch_open: "Karta",
    arch_fav: (n) => `Zdjęte ze sprzedaży — ${n} z ulubionych`, arch_here: "Zdjęte pod tym adresem",
    ntf_btn: "Powiadamiaj", ntf_on: "Powiadomienia wł.",
    ntf_t: "Powiadamiaj o nowych mieszkaniach", ntf_on_t: "Powiadomienia włączone",
    ntf_lead: "Bot w Telegramie będzie wysyłać nowe mieszkania z tego wyszukiwania:",
    ntf_lead_out: "Nowe mieszkania z tego wyszukiwania bot wyśle w Telegramie 4 razy dziennie. Potrzebne logowanie — raz, przez bota.",
    ntf_lead_on: "Bot wysyła nowe mieszkania z tego wyszukiwania 4 razy dziennie:",
    ntf_now: "Teraz w bocie:", ntf_when: "Przychodzą 4 razy dziennie: 08:00, 13:00, 18:00, 22:00.",
    ntf_off_note: "Powiadomienia są teraz wyłączone — zapisanie je włączy.",
    ntf_on_note: "Zmień filtry — przycisk znów pokaże «Powiadamiaj» i nowe wyszukiwanie będzie można zapisać.",
    ntf_login_note: "Napisz do bota /profile — wyśle link do logowania. Potem wróć i naciśnij «Powiadamiaj».",
    ntf_cancel: "Anuluj", ntf_save: "Zapisz w bocie", ntf_saving: "Zapisuję…", ntf_login: "Zaloguj przez Telegram",
    ntf_off: "Wyłącz powiadomienia", ntf_err: "Nie udało się zapisać — spróbuj jeszcze raz.",
    ntf_all: "Wszystkie mieszkania, bez filtrów", ntf_price: "Cena", ntf_rooms: (v) => `Pokoje ${v}`,
    ntf_districts: (n) => `${n} ${n === 1 ? "dzielnica" : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? "dzielnice" : "dzielnic"}`,
    err_h: "Uruchom <code>venv/bin/python 5.web/export.py</code> i otwórz stronę przez lokalny serwer.",
  },
};

/* Язык: ?lang= из ссылки бота → выбор прошлого визита → русский.
 * Ссылка главнее localStorage: бот шлёт lang= осознанно, под язык подписчика. */
let LANG = (() => {
  const q = new URLSearchParams(location.search).get("lang");
  if (q === "pl" || q === "ru") return q;
  try { return localStorage.getItem("wf_lang") || "ru"; } catch { return "ru"; }
})();

/* tr, а не L: L — глобальный объект Leaflet. Короткое имя его затеняло,
 * и падала вся карта разом (L.map переставал быть функцией). */
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
  readUrl();          // фильтры из ссылки — до первого apply()
  buildWant();
  initMap();
  apply();
  initMenu();
  loadPlaces();       // вход по ссылке из бота (избранное/скрытые с ботом) и «Мои места» — в фоне
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

function buildFilters() {
  ["3", "4", "5+"].forEach((r) => chip($("#f-rooms"), r, r === "5+" ? "5" : r, state.rooms, "rooms"));
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
  $("#sort").onchange = (e) => { state.sort = e.target.value; saveSort(); apply(); };
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
    if (!_liveCount(state.favorites, favKey)) return;
    state.onlyFav = !state.onlyFav;
    setProfileOpen(false);
    apply(false);   // не прыгать наверх — юзер переключает вид, не меняет критерии поиска
  };
  $("#menu-hidden").onclick = () => {
    if (!_liveCount(state.hidden, hideKey) && !state.showHidden) return;
    state.showHidden = !state.showHidden;
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
    // Leaflet мерит контейнер при инициализации; пока карта была скрыта,
    // её размер равен нулю — без пересчёта она останется серой
    if (which === "map") setTimeout(() => map?.invalidateSize(), 0);
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
  ["3", "4", "5+"].forEach((r) => chip($("#f-rooms"), r, r === "5+" ? "5" : r, state.rooms, "rooms"));
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
function rebuildLayerControl() {
  buildLayerControl();
}

/* Свернуть список — карта на всю ширину. Leaflet считает размер контейнера
 * при инициализации и сам не замечает, что тот стал шире: без invalidateSize
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
    map?.invalidateSize();
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

function readUrl() {
  const q = new URLSearchParams(location.search);
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
  if (sortQ && _SORT_VALUES.has(sortQ)) { state.sort = sortQ; $("#sort").value = sortQ; }

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
  ["iso", "lang"].forEach((k) => { if (cur.get(k)) p.set(k, cur.get(k)); });

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
function axesHtml(a, withScore = false) {
  if (!a.ax || a.ax.every((v) => v == null)) return "";

  const bar = (name, v, cls = "") =>
    `<span class="ax-name ${cls}">${name}</span>
     <span class="ax-track ${cls}"><span class="ax-fill" style="width:${v}%"></span></span>
     <span class="ax-val ${cls}">${v}</span>`;

  const head = (withScore && a.sc != null
    ? bar(esc(tr("f_score")), Math.round(a.sc), "ax-total") : "");

  // подпись оси — из meta.i18n (словарь бота), не из локального словаря
  const rows = state.meta.axes.map((_, i) => {
    const v = a.ax[i];
    return v == null ? "" : bar(esc(axisName(i)), v);
  }).join("");

  return `<div class="axes">${head}${rows}</div>`;
}

function fairHtml(a) {
  if (a.fp == null || Math.abs(a.fp) < 5) return "";
  const cheap = a.fp < 0;
  // Знак и слово обязательны: цвет один смысла не несёт
  return `<span class="fair ${cheap ? "good" : "bad"}">${cheap ? "▼" : "▲"} ${Math.abs(Math.round(a.fp))}% ${cheap ? tr("cheaper") : tr("pricier")}</span>`;
}

/* ── «Важно для меня» ─────────────────────────────────────────────────────────
 * Коды — как в export.py::_AMEN_CODE (удобства из Otodom target.Extras_types). */
const WANT_CODES = { g: 1, l: 1, u: 1, b: 1, t: 1, ac: 1, gr: 1, n2: 1, na: 1 };
/* «Без двух уровней» / «Без мансарды» (01.10.2026) — по признакам из текста
 * объявления (a.tx, export.py → textflags.py), а не по списку удобств a.ex */
const WANT_TX = { n2: "2l", na: "at" };

/* Есть ли у квартиры отмеченное: true / false / null — неизвестно (в
 * объявлении нет списка удобств): «неизвестно» не значит «нет» */
function wantHas(a, c) {
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
  try { localStorage.setItem("wf_want", JSON.stringify(state.want)); } catch {}
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
    if (yes == null || (yes && c in WANT_TX)) return "";
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
      return m != null ? `${esc(pl.name)} ${m} ${tr("min")}` : null;
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
    ${axesHtml(a, true)}
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
}

/* ── Избранное ────────────────────────────────────────────────────────────────
 * Та же архитектура, что и у чёрного списка (см. выше): ключ группо-осведомлён
 * (a.g || a.id), живёт в localStorage этого браузера, из бота приезжает
 * параметром ?fav=. В отличие от чёрного списка — НИЧЕГО не фильтрует сама по
 * себе: это просто закладка, отдельная от showHidden/hidden и независимая
 * от них (квартира может быть одновременно и скрыта, и в избранном). */
const favKey = (a) => a.g || a.id;

function saveFavorites() {
  try { localStorage.setItem("wf_fav", JSON.stringify([...state.favorites])); } catch {}
}

function loadFavorites() {
  try { JSON.parse(localStorage.getItem("wf_fav") || "[]").forEach((k) => state.favorites.add(String(k))); } catch {}
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
  saveHidden();
  // в режиме «Скрытые» после возврата последней квартиры выходим из режима — иначе пустой экран
  if (state.showHidden && !state.hidden.size) state.showHidden = false;
  // Юзер (2026-09-26): скрыл 10-ю карточку в отсортированном списке — не должно
  // подбрасывать в начало. Тот же resetScroll=false, что у переключателя вида
  // в меню профиля (см. #menu-hidden выше) — здесь даже важнее: это самое частое
  // действие при просмотре длинного списка, не разовое переключение вида.
  apply(false);
  hiddenTagRefresh();
  refreshSheetActions(a);
  toast(tr(wasHidden ? "unhide" : "hid_toast") + " · " + [a.d, a.st].filter(Boolean).join(", "),
        () => toggleHide(id));
}

function toggleFavorite(id) {
  const a = findApt(id);
  if (!a) return;
  const k = favKey(a);
  const was = state.favorites.has(k);
  was ? state.favorites.delete(k) : state.favorites.add(k);
  saveFavorites();
  // «только избранное» без единого избранного показывало бы пустой список
  if (state.onlyFav && !state.favorites.size) state.onlyFav = false;
  apply(false);   // не прыгать наверх — та же причина, что у toggleHide выше
  favTagRefresh();
  // apply() мог закрыть шторку сам (если «только избранное» и мы его только что
  // убрали) — refreshSheetActions сама проверяет state.activeId, ничего лишнего
  refreshSheetActions(a);
  toast(tr(was ? "unfav_toast" : "fav_toast") + " · " + [a.d, a.st].filter(Boolean).join(", "),
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

/* Плашка «+N похожих» в карточке списка */
function dupNote(a) {
  return a.dp?.length ? `<div class="dup-note">${esc(tr("dup_note")(a.dp.length))}</div>` : "";
}

/* Блок повторов в шторке: диапазон цен и ссылка на каждое объявление */
function dupsHtml(a) {
  if (!a.dp?.length) return "";
  const prices = [a.p, ...a.dp.map((d) => d[1])].filter((v) => v != null);
  const range = prices.length ? `${nf.format(Math.min(...prices))} – ${nf.format(Math.max(...prices))} PLN` : "";
  const items = a.dp.map(([u, p, ut, ag, seen]) => `<li>
      <a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${money(p)}</a>
      <span>${esc([LABEL.ut[ut], ag].filter(Boolean).join(" · "))}${seen ? ` · ${esc(fmtDate(seen))}` : ""}</span></li>`).join("");
  return `<details class="dups"><summary>${esc(tr("dups_t")(a.dp.length))}${range ? ` · ${range}` : ""}</summary>
      <ul>${items}</ul><small>${esc(tr("dup_hint"))}</small></details>`;
}

/* Шум квартиры: МАКСИМУМ по всем слоям (дороги, ж/д, трамвай, промышленность,
 * самолёты), см. 2.scoring/noise.py. nl — нижняя граница полосы Lden (55/60/65/70/75),
 * 0 = тихо. Показываем полосу («65–69 дБ», «75+ дБ») и источник максимума. */
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
/* Слои-подложки. Шум — официальная акустическая карта Варшавы 2022 (WMS).
 * В старой карте они жили внутри контрола Leaflet, вкрученного в самодельный
 * док, — оттуда и росли баги с чекбоксами. Здесь это обычный контрол Leaflet,
 * ничего не переносим и не пересобираем. */
const WMS = "https://wms.um.warszawa.pl/serwis";
// источник шума → часть имени слоя WMS: HALAS_<имя>_<LDWN|LN>_2022
const NOISE_SRC = { road: "DROGOWY", rail: "KOLEJOWY", air: "LOTNICZY", tram: "TRAMWAJOWY", industry: "PRZEMYSLOWY" };
// палитра карты города, от тихого к громкому (цвета сверены по картинке слоя)
const NOISE_BANDS = [["45–49", "#ffff00"], ["50–54", "#ffbf0f"], ["55–59", "#fc8a1e"], ["60–64", "#fd5805"],
                     ["65–69", "#de3e3e"], ["70–74", "#b17ed9"], ["75+", "#03abe2"]];

/* Подложки Esri (основа + отдельный слой подписей), светлая и тёмная — по паре
 * URL на тему. CARTO (light_all и dark_all) с сентября 2026 требует API-ключ и
 * рисует поверх карты «API KEY REQUIRED» — проверено вживую curl'ом на оба
 * варианта. Esri отдаёт плитки без ключа на обеих темах; родные плитки есть до
 * z16, дальше Leaflet растягивает (maxNativeZoom). */
const ESRI = "https://services.arcgisonline.com/ArcGIS/rest/services/Canvas";
const BASEMAPS = {
  light: { base: `${ESRI}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
           ref:  `${ESRI}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}` },
  dark:  { base: `${ESRI}/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
           ref:  `${ESRI}/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}` },
};
let baseTiles = null, labelTiles = null;   // текущие слои подложки — переключаем .setUrl(), не пересоздаём

/* Смена темы сайта → смена подложки карты, без перезагрузки страницы: тот же
 * L.tileLayer, но с URL другой темы (setUrl сам перерисует видимые плитки). */
function applyMapTheme(theme) {
  const bm = BASEMAPS[theme] || BASEMAPS.light;
  baseTiles?.setUrl(bm.base);
  labelTiles?.setUrl(bm.ref);
}

function initMap() {
  // zoomControl: false — свой ниже, в правом нижнем углу: сверху слева теперь
  // сидит открывающаяся панель фильтров, а сверху справа — кнопка «Слои»,
  // дефолтная позиция Leaflet (top-left) под них уже не годится.
  // zoomSnap=0 (истинно непрерывный зум, ближе к Google Maps) ПОПРОБОВАН
  // и ОТКАЧЕН (2026-09-27): при snap=0 Leaflet считает шаг колёсика не
  // округлением к сетке, а нелинейной sigmoid-функцией с накоплением по
  // таймеру (см. ScrollWheelZoom._performZoom в исходниках Leaflet) — юзер
  // словами «слишком резкий/рваный» + «лаг» поймал именно эту нелинейность:
  // отклик появляется не сразу (копится за debounce), а потом дёргается
  // непропорционально. zoomSnap=0.25 — дробные, но всё же СТУПЕНИ: тот же
  // код округляет (Math.ceil) к ближайшей четверти, отклик линейный и
  // предсказуемый — это и есть увиденный ранее «шаг хороший» вариант.
  // wheelPxPerZoomLevel регулирует скорость колёсика отдельно от шага/плавности.
  map = L.map("map", { zoomControl: false, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 20 })
    .setView([52.23, 21.01], 11);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  /* Подписи — в своей панели выше шумовых слоёв, иначе те закрашивали бы названия улиц. */
  const bm = BASEMAPS[currentTheme()];
  baseTiles = L.tileLayer(bm.base, {
    attribution: "Tiles &copy; Esri &mdash; Esri, HERE, Garmin, &copy; OpenStreetMap contributors",
    maxNativeZoom: 16, maxZoom: 19,
  }).addTo(map);
  map.createPane("pLabels").style.zIndex = 260;
  map.getPane("pLabels").style.pointerEvents = "none";
  labelTiles = L.tileLayer(bm.ref, {
    pane: "pLabels", maxNativeZoom: 16, maxZoom: 19,
  }).addTo(map);
  layer = L.layerGroup().addTo(map);

  /* Порядок отрисовки задаём панелями, а не порядком добавления слоёв:
   * включил-выключил слой — и порядок бы поехал. Снизу вверх:
   * снятые (история) → наши квартиры сверху.
   * Полигоны (изохроны, воздух) остаются в overlayPane = 400, то есть ниже.
   * Линии, остановки транспорта И снятые с продажи — на SVG, не на общем canvas
   * квартир: canvas — это один сплошной элемент на весь экран, и он перехватывает
   * мышь у ВСЕГО, что под ним, даже там, где на нём ничего не нарисовано (аудит
   * этой фичи, 2026-09-22: тултип точки «Снято с продажи» с добавленными деталями
   * молча переставал ловить наведение курсора именно по этой причине — pRemoved
   * ниже pApts, а маркер был на своём Canvas-рендерере). SVG-путь перехватывает
   * события только на самой фигуре, остальное проходит насквозь к квартирам —
   * поэтому у линий/остановок (ниже) и у снятых нет своего явного renderer:,
   * только pane: Leaflet сам заводит SVG-рендерер на пару с каждой панелью.
   * Квартир на порядок больше (до ~2000), поэтому именно они остаются на
   * выделенном Canvas — единственном элементе, который физически перехватывает
   * события везде, но зато не бывает медленным на такой плотности точек. */
  [["pRemoved", 435], ["pApts", 430], ["pLines", 440]].forEach(([name, z]) => {
    map.createPane(name).style.zIndex = z;
  });
  // padding — чтобы точки у края не пропадали при панораме до перерисовки
  canvas = L.canvas({ pane: "pApts", padding: 0.3 });

  initLegends();
  buildLayerControl();
  initLines();
}

/* ── Панель слоёв ─────────────────────────────────────────────────────────────
 * Заменяет стандартный L.control.layers: тот растёт плоским списком, и после линий,
 * остановок и семи слоёв шума панель перестала помещаться. Здесь слои разложены по
 * раскрывающимся секциям, а шум — ОДИН выбор «источник + сутки/ночь» вместо семи
 * галочек (слои шума всё равно закрашивают друг друга, читать два сразу нельзя).
 *
 * Что включено, хранится в layerOn по СТАБИЛЬНОМУ ключу (apts, tram…), а не по
 * названию или порядку: названия меняются со сменой языка, а динамические группы
 * (воздух, снятые) пересоздаются заново — ключ переживает и то и другое. */
const layerOn = new Set(["apts"]);
let layerDefs = [];                 // [{key, group, label, layer, dynamic}]
const noiseSel = { src: "", night: false };
const noiseTiles = {};              // "road:d" → WMS-слой, создаются лениво и живут постоянно
let noiseCur = null;
let lp = null;                      // контрол панели
const lpOpen = new Set((() => {
  try { return JSON.parse(localStorage.getItem("wf_lp_open") || '["offers"]'); } catch { return ["offers"]; }
})());

function setLayerOn(key, on) {
  const d = layerDefs.find((x) => x.key === key);
  if (!d) return;
  on ? layerOn.add(key) : layerOn.delete(key);
  on ? d.layer.addTo(map) : map.removeLayer(d.layer);
  refreshLegends();
}

function noiseApply() {
  if (noiseCur) { map.removeLayer(noiseCur); noiseCur = null; }
  if (noiseSel.src) {
    const k = `${noiseSel.src}:${noiseSel.night ? "n" : "d"}`;
    noiseCur = noiseTiles[k] ||= L.tileLayer.wms(WMS, {
      layers: `HALAS_${NOISE_SRC[noiseSel.src]}_${noiseSel.night ? "LN" : "LDWN"}_2022`,
      format: "image/png", transparent: true, version: "1.3.0", opacity: 0.6,
      attribution: "Mapa akustyczna Warszawy 2022",
    });
    noiseCur.addTo(map);
  }
  refreshLegends(true);
}

const LayersPanel = L.Control.extend({
  options: { position: "topright" },
  _open: false,

  onAdd() {
    const box = this._box = L.DomUtil.create("div", "lp");
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    box.addEventListener("click", (e) => {
      // render() заменяет innerHTML прямо здесь: к моменту, когда событие дошло бы до карты,
      // e.target уже вне DOM и проверка closest(".lp") её не узнаёт — карта закрыла бы панель
      // тут же. Поэтому клик внутри панели дальше не пускаем.
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
    this.render();
    return box;
  },

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
  },
});

/* Строится при старте и при КАЖДОЙ смене языка: подписи слоёв запечены в панели. */
function buildLayerControl() {
  // Динамические группы прошлой сборки снимаем с карты: buildDataLayers() создаёт
  // их заново, старые иначе остались бы поверх новых навсегда.
  layerDefs.filter((d) => d.dynamic).forEach((d) => map.removeLayer(d.layer));
  layerDefs = [{ key: "apts", group: "offers", label: tr("l_apts"), layer, dynamic: false },
               ...buildDataLayers()];
  layerDefs.forEach((d) => { if (layerOn.has(d.key)) d.layer.addTo(map); });
  if (lp) lp.render();
  else {
    lp = new LayersPanel().addTo(map);
    // Клик по карте закрывает панель. Клик ВНУТРИ панели картой не считается: disableClickPropagation
    // помечает только сам контейнер, а событие от вложенной svg-иконки всё равно доходит до карты
    map.on("click", (e) => {
      if (e.originalEvent?.target?.closest?.(".lp")) return;
      if (lp._open) { lp._open = false; lp.render(); }
    });
  }
  linesRedraw();
  refreshLegends(true);
}

/* Слои из layers.json. Качество воздуха и персональные изохроны — то, что в
 * старой карте запекалось прямо в HTML. Здесь это данные, поэтому слой можно
 * включить, выключить и переписать, не пересобирая страницу.
 *
 * Порядок вставки = порядок в контроле Leaflet, поэтому он задан явно и
 * повторяет старую карту: сначала наши квартиры, потом справочные слои. */

// Польский индекс качества воздуха PM2.5 (µg/m³): порог → цвет.
// Это регламентированная шкала, а не наша — цвета взяты как есть из
// прежней folium-карты (удалена 2026-09-21), чтобы цвета остались привычными.
// GIOŚ и Airly меряют одну величину, поэтому шкала у них общая.
const PM25_BANDS = [[13, "#57b108"], [35, "#b0dd10"], [55, "#ffd911"],
                    [75, "#e58100"], [110, "#e50000"], [Infinity, "#990000"]];
const pm25Color = (v) => PM25_BANDS.find(([thr]) => v <= thr)[1];

/* Слой воздуха: опционально векторная поверхность (полосы индекса), поверх
 * неё — сами сенсоры. Порядок важен: полигоны кладём первыми, иначе они
 * перекроют точки и по ним нельзя будет получить подсказку. */
function airGroup(pts, radius, bands) {
  const g = L.layerGroup();

  // От чистого к грязному — грязное поверх, как в старой карте
  (bands || []).forEach((b) => {
    L.geoJSON(b.geo, {
      interactive: false,
      // граница той же краской: полосы соседних уровней иначе сливаются в пятно
      style: { fillColor: b.color, color: b.color, weight: 1.5, opacity: .9, fillOpacity: .3 },
    }).addTo(g);
  });

  pts.forEach((p) => {
    const pm10 = p.pm10 != null ? ` · PM10: ${Math.round(p.pm10)}` : "";
    L.circleMarker([p.lat, p.lon], {
      radius, weight: 1, color: "#555",
      fillColor: pm25Color(p.v), fillOpacity: .95,
    }).bindTooltip(`${esc(p.addr || "")} · PM2.5: ${esc(p.v)} µg/m³${pm10}${p.hh ? ` (${esc(p.hh)})` : ""}`)
      .addTo(g);
  });
  return g;
}

/* Возвращает описания слоёв [{key, group, label, layer, dynamic}]. Порядок в списке
 * = порядок в панели внутри группы. Ключ стабильный (см. layerOn), поэтому включённое
 * переживает и смену языка, и пересоздание групп. */
function buildDataLayers() {
  const L_ = state.layers || {};
  const out = [];
  const add = (key, group, label, layerObj, dynamic = true) =>
    out.push({ key, group, label, layer: layerObj, dynamic });

  /* Снятые с продажи — только те адреса, где активных объявлений не осталось.
   * Где активные есть, снятые видны в их карточке, и вторая метка была бы
   * дублем. Метки приглушённые: это история, а не предложение.
   *
   * БЕЗ renderer: — важно. С явным L.canvas() (как было раньше) наведение
   * молча не срабатывало НИГДЕ на этом слое: Canvas — один сплошной элемент
   * на весь экран, и вышестоящая по z-index панель квартир (общий canvas)
   * перехватывала mousemove ДО того, как он доходил до canvas'а снятых, даже
   * там, где на квартирном canvas'е ничего не нарисовано (см. initMap: pane
   * pRemoved теперь ВЫШЕ pApts именно из-за этого). Без renderer: Leaflet сам
   * заводит SVG на пару с pane (getRenderer → _getPaneRenderer) — SVG-путь
   * перехватывает события только на самой фигуре, остальное проходит насквозь
   * к квартирам, так же как уже сделано для линий/остановок транспорта ниже.
   *
   * Тултип — функцией: детали (адрес/цена/площадь/дата) лежат в remData
   * (data/removed.json), который иначе грузится только при открытии карточки
   * квартиры (loadHeavy). Этот слой можно включить, ни разу не открыв ни
   * одной карточки, поэтому дозагружаем remData сами внутри removedTipHtml();
   * Leaflet вызывает функцию-контент заново при КАЖДОМ наведении
   * (DivOverlay._updateContent), так что как только фетч доедет — следующее
   * наведение покажет полный список без пересоздания слоя. */
  if (L_.removed_pts?.length) {
    const g = L.layerGroup();
    L_.removed_pts.forEach((r) => {
      L.circleMarker([r.lat, r.lon], {
        pane: "pRemoved", radius: 4, weight: 1,
        color: "#8b8a81", fillColor: "#8b8a81", fillOpacity: .5,
      }).bindTooltip(() => removedTipHtml(r.lat, r.lon, r.n), { sticky: true, className: "rem-tip" })
        .on("click", (e) => openRemovedAt(r.lat, r.lon, e.latlng))
        .addTo(g);
    });
    add("removed", "offers", `${tr("l_rem")} · ${L_.removed_pts.length}`, g);
  }

  // Трамвай и метро: группы ПОСТОЯННЫЕ (не пересоздаются), данные грузятся при первом включении
  add("tram", "transit", tr("l_tram"), linesState.group.tram, false);
  add("metro", "transit", tr("l_metro"), linesState.group.metro, false);
  // Строящееся продолжение M2 — справочный слой (не в скоринге), выключен по
  // умолчанию, как и остальные транспортные слои
  add("metro_construction", "transit", tr("l_metro_construction"), linesState.group.metro_construction, false);

  // Изохроны: зоны доступности от личного адреса подписчика
  (L_.iso || []).forEach((entry, i) => {
    const g = L.layerGroup();
    entry.bands.forEach((b) => {
      L.geoJSON(b.geo, {
        interactive: false,
        style: { color: b.color, fillColor: b.color, weight: 2, opacity: .9, fillOpacity: .22 },
      }).addTo(g);
    });
    add(`iso${i}`, "iso", `${tr("l_iso")} ${entry.bands.map((b) => b.min).join("/")} ${tr("min")}`, g);
  });

  // Госстанции: их мало, поэтому кружок крупнее — это опорные точки
  if (L_.gios?.length) add("gios", "air", tr("l_gios"), airGroup(L_.gios, 11));
  // Airly: плотная сеть бытовых сенсоров + интерполяционная поверхность
  if (L_.air?.length) add("airly", "air", tr("l_airly"), airGroup(L_.air, 5, L_.air_bands));

  return out;
}

/* ── Линии, остановки и станции ───────────────────────────────────────────────
 * data/lines.json (GTFS ZTM, ~95 КБ) грузится при первом включении трамвая или
 * метро. Группы слоёв создаются ОДИН раз: buildDataLayers() вызывается заново на
 * каждой смене языка и не должен их пересоздавать.
 *
 * Что можно делать.
 *  • Навести на линию — подсветка маршрута и подсказка с номером и направлением.
 *  • Нажать линию или номер в панели — маршрут закреплён, остальные приглушены.
 *    (Трамваи идут по общим путям, клик по пересечению выбрал бы только верхнюю
 *    линию — поэтому номера продублированы в панели.)
 *  • Нажать остановку или станцию — выбор: закрепляются все её маршруты, рисуется
 *    круг «рядом» (400 или 800 м пешком), в попапе — маршруты и число квартир
 *    в круге. Кнопка «Показать квартиры рядом» включает фильтр по этому кругу. */
const NEAR_R = [500, 1000];                  // метры: ~6 и ~12 минут пешком
const linesState = {
  group: { tram: L.layerGroup(), metro: L.layerGroup(), metro_construction: L.layerGroup() },
  data: null, loading: null,
  poly: {},               // id маршрута → [L.Polyline]
  kind: {},               // id маршрута → "tram" | "metro"
  color: {},              // id маршрута → цвет линии
  stops: [],              // [{s: остановка, m: маркер}]
  pinned: new Set(), hover: null, box: null,
  sel: null,              // {stop, r, circle} — выбранная остановка
  popup: null,
};

// Расстояние в метрах — плоское приближение, для радиусов до нескольких км точнее сотни метров не нужно
function distM(la1, lo1, la2, lo2) {
  return Math.hypot((la1 - la2) * 111320, (lo1 - lo2) * 111320 * Math.cos((la1 * Math.PI) / 180));
}
const nearOk = (a, n) => a.lat != null && a.lon != null && distM(a.lat, a.lon, n.p[0], n.p[1]) <= n.r;

/* «Рядом с остановкой» больше не отдельная кнопка-тег — это такой же активный
 * фильтр, как остальные (сужает выдачу), поэтому показывается чипом в общей
 * ленте активных фильтров (см. buildActiveChips ниже), с тем же ✕ = linesClearAll(). */

function linesStyle(id) {
  const on = linesState.pinned.has(id) || linesState.hover === id;
  const dim = linesState.pinned.size > 0 && !linesState.pinned.has(id) && linesState.hover !== id;
  const kind = linesState.kind[id];
  const metro = kind === "metro";
  const constr = kind === "metro_construction";
  const base = metro ? 5 : constr ? 4 : 3;
  return {
    weight: on ? base + 3 : base, opacity: on ? 1 : dim ? .18 : metro ? .9 : constr ? .6 : .7,
    // Строится — пунктир, а не сплошная: визуально «ещё не построено»,
    // отдельно от цвета (не полагаемся на один только серый — юзер мог
    // спутать с приглушённой действующей линией)
    ...(constr ? { dashArray: "2,8" } : {}),
  };
}

function stopStyle(s) {
  const metro = s.t === "metro";
  const constr = s.t === "metro_construction";
  const sel = linesState.sel?.stop === s;
  const dim = linesState.pinned.size > 0 && !s.r.some((r) => linesState.pinned.has(r));
  // Цвет остановки — цвет её маршрута из данных (тот же r.c, что у линии),
  // а не отдельный хардкод: раньше трамвайные остановки ВСЕГДА красились в
  // #b60000 независимо от маршрута — тот самый красный, что сливался с
  // веткой метро M2 (аудит юзера 2026-09-23). Фолбэк — только если у
  // маршрута почему-то нет цвета в данных.
  return {
    radius: sel ? 9 : metro || constr ? 6 : 4, weight: sel ? 4 : constr ? 2 : 3,
    color: sel ? "#2a78d6" : (linesState.color[s.r[0]] || (metro ? "#0000bb" : "#e08300")),
    fillColor: "#fff", fillOpacity: dim ? .3 : constr ? .6 : 1, opacity: dim ? .3 : 1,
    ...(constr ? { dashArray: "2,3" } : {}),
  };
}

function linesRestyle() {
  Object.entries(linesState.poly).forEach(([id, arr]) => arr.forEach((p) => p.setStyle(linesStyle(id))));
  linesState.stops.forEach(({ s, m }) => m.setStyle(stopStyle(s)));
  linesPanel();
  if (linesState.popup && linesState.sel) linesState.popup.setContent(stopPopupNode(linesState.sel.stop));
}

function linesPin(id) {
  const s = linesState.pinned;
  s.has(id) ? s.delete(id) : s.add(id);
  linesRestyle();
}

/* Снять выбор остановки (круг и попап), не трогая закреплённые маршруты и фильтр «рядом». */
function linesDropSel() {
  const sel = linesState.sel;
  if (sel) sel.circle.remove();
  linesState.sel = null;
  if (linesState.popup) { const p = linesState.popup; linesState.popup = null; map.closePopup(p); }
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
  const old = linesState.sel;
  if (old) old.circle.remove();
  linesState.sel = {
    stop: s, r: rad,
    circle: L.circle(s.p, {
      radius: rad, pane: "pLines", interactive: false, color: "#2a78d6", weight: 2, dashArray: "6 4",
      fillColor: "#2a78d6", fillOpacity: .07,
    }).addTo(map),
  };
  linesState.pinned = new Set(s.r);
  if (state.near) { state.near = { p: s.p, r: rad, name: s.n }; apply(); }   // фильтр следует за выбором
  linesState.stops.find((x) => x.s === s)?.m.bringToFront();
  linesRestyle();
  if (quiet) return;
  // Новый попап назначаем ДО открытия: openOn закроет прежний, и его popupclose не должен
  // принять за «пользователь закрыл попап» (иначе выбор сбросился бы на каждом переходе).
  const pop = L.popup({ offset: [0, -6], className: "stop-popup", maxWidth: 260 })
    .setLatLng(s.p).setContent(stopPopupNode(s));
  linesState.popup = pop;
  pop.openOn(map);
}

function stopPopupNode(s) {
  const sel = linesState.sel;
  const r = sel.r;
  // считаем по base — выдаче со всеми фильтрами КРОМЕ «рядом», иначе включённый фильтр обнулил бы счётчик
  const n = state.base.filter((a) => nearOk(a, { p: s.p, r })).length;
  const chips = s.r.map((id) =>
    `<button type="button" class="lchip${linesState.pinned.has(id) ? " on" : ""}" data-r="${esc(id)}"
       style="--c:${esc(linesState.color[id] || "#e08300")}" aria-pressed="${linesState.pinned.has(id)}">${esc(id)}</button>`).join("");
  const box = document.createElement("div");
  box.className = "stop-pop";
  // Название — отдельной крупной строкой, а над ним — что это: остановка трамвая или станция метро
  const constr = s.t === "metro_construction";
  box.innerHTML = `<small class="stop-kind">${esc(stopKindLabel(s.t))}</small>
    <div class="stop-name">${esc(s.n)}</div>
    ${constr ? `<div class="gap-note">${tr("metro_construction_note")}</div>` : ""}
    <div class="lchips">${chips}</div>
    <div class="seg-r" role="group">${NEAR_R.map((v) =>
      `<button type="button" class="ghost${v === r ? " on" : ""}" data-rad="${v}" aria-pressed="${v === r}">${v} ${tr("m_u")}</button>`).join("")}</div>
    <div class="near-n">${tr("stop_near")}: <b>${nf.format(n)}</b></div>
    <button type="button" class="pop-btn" data-act="near">${tr(state.near ? "near_off" : "near_on")}</button>`;
  box.addEventListener("click", (e) => {
    // Обработчики ниже пересобирают содержимое попапа. К моменту, когда Leaflet решает,
    // «клик по карте или по попапу», кнопка уже отсоединена от DOM, цепочка родителей
    // оборвана — и клик засчитывается картой, которая закрывает попап. Не пускаем его выше.
    e.stopPropagation();
    const chip = e.target.closest(".lchip");
    if (chip) return linesPin(chip.dataset.r);
    const rad = e.target.closest("[data-rad]");
    if (rad) return stopSelect(s, +rad.dataset.rad, true) ?? linesRestyle();
    if (e.target.closest("[data-act='near']")) {
      state.near = state.near ? null : { p: s.p, r: linesState.sel.r, name: s.n };
      apply();
      linesRestyle();
    }
  });
  return box;
}

// "Трамвай"/"Метро"/"Метро (строится)" — общий подписчик для тултипов линии и
// остановки, и для строки-заголовка в попапе остановки (stopPopupNode)
const stopKindLabel = (t) =>
  tr(t === "metro" ? "metro_w" : t === "metro_construction" ? "metro_construction_w" : "tram_w");

function linesDraw(d) {
  d.routes.forEach((r) => {
    linesState.kind[r.i] = r.t;
    linesState.color[r.i] = r.c;
    linesState.poly[r.i] = r.g.map((geom) =>
      L.polyline(geom, { pane: "pLines", color: r.c, ...linesStyle(r.i), lineCap: "round", lineJoin: "round" })
        .bindTooltip(`${esc(stopKindLabel(r.t))} ${esc(r.i)} · ${esc(r.n)}`, { sticky: true })
        .on("mouseover", () => { linesState.hover = r.i; linesRestyle(); })
        .on("mouseout",  () => { linesState.hover = null; linesRestyle(); })
        .on("click",     (e) => { L.DomEvent.stopPropagation(e); linesPin(r.i); })
        .addTo(linesState.group[r.t]));
  });
  // Остановки — ПОСЛЕ линий: маркер должен лежать сверху, иначе клик уйдёт в линию под ним
  linesState.stops = d.stops.map((s) => {
    const m = L.circleMarker(s.p, { pane: "pLines", ...stopStyle(s) })
      .bindTooltip(`${esc(stopKindLabel(s.t))} · ${esc(s.n)} · ${s.r.map(esc).join(", ")}`)
      .on("click", (e) => { L.DomEvent.stopPropagation(e); stopSelect(s); })
      .addTo(linesState.group[s.t]);
    return { s, m };
  });
}

/* Смена языка: подсказки запечены в слоях при создании, поэтому линии и остановки
 * рисуются заново. Выбор остановки и закрепление переживают — они лежат в linesState. */
function linesRedraw() {
  if (!linesState.data) return;
  const pinned = new Set(linesState.pinned);
  const sel = linesState.sel;
  Object.values(linesState.group).forEach((g) => g.clearLayers());
  linesState.poly = {};
  linesDraw(linesState.data);
  linesState.pinned = pinned;
  if (sel) {
    const s2 = linesState.stops.find((x) => x.s.p[0] === sel.stop.p[0] && x.s.p[1] === sel.stop.p[1] && x.s.t === sel.stop.t)?.s;
    sel.circle.remove();
    linesState.sel = null;
    if (s2) stopSelect(s2, sel.r, true);
  }
  linesRestyle();
}

function linesEnsure() {
  if (linesState.data || linesState.loading) return;
  linesState.loading = fetch(`data/lines.json?v=${BUILD}`).then((r) => r.json())
    .then((d) => { linesState.data = d; linesDraw(d); linesPanel(); })
    .catch(() => { linesState.loading = null; });   // сеть упала — повторим при следующем включении
}

/* Панель номеров маршрутов. Видна, пока включён хотя бы один из слоёв. */
function linesPanel() {
  const box = linesState.box;
  if (!box) return;
  const d = linesState.data;
  const showTram = map.hasLayer(linesState.group.tram);
  const showMetro = map.hasLayer(linesState.group.metro);
  const showConstr = map.hasLayer(linesState.group.metro_construction);
  if (!d || (!showTram && !showMetro && !showConstr)) { box.style.display = "none"; return; }
  const chips = d.routes
    .filter((r) => (r.t === "tram" && showTram) || (r.t === "metro" && showMetro) ||
                    (r.t === "metro_construction" && showConstr))
    .map((r) => {
      const on = linesState.pinned.has(r.i);
      return `<button type="button" class="lchip${on ? " on" : ""}" data-r="${esc(r.i)}"
                style="--c:${esc(r.c)}" aria-pressed="${on}" title="${esc(r.n)}">${esc(r.i)}</button>`;
    }).join("");
  box.innerHTML = `<b>${tr("lines_title")}</b><div class="lchips">${chips}</div>
    <small>${tr("lines_hint")}${linesState.pinned.size || state.near
      ? ` · <a href="#" data-clear="1">${tr("lines_clear")}</a>` : ""}</small>`;
  box.style.display = "";
}

function initLines() {
  const ctl = L.control({ position: "bottomleft" });
  ctl.onAdd = () => {
    const box = linesState.box = L.DomUtil.create("div", "legend lines-box");
    box.style.display = "none";
    L.DomEvent.disableClickPropagation(box);
    L.DomEvent.disableScrollPropagation(box);
    box.addEventListener("click", (e) => {
      e.stopPropagation();          // панель перерисовывается в обработчике — см. попап остановки
      const chip = e.target.closest(".lchip");
      if (chip) return linesPin(chip.dataset.r);
      if (e.target.closest("[data-clear]")) { e.preventDefault(); linesClearAll(); }
    });
    return box;
  };
  ctl.addTo(map);
  Object.values(linesState.group).forEach((g) => {
    g.on("add", () => { linesEnsure(); linesPanel(); });
    g.on("remove", () => {
      // выключили слой — выбор его остановки теряет смысл
      if (linesState.sel && !map.hasLayer(linesState.group[linesState.sel.stop.t])) linesDropSel();
      linesPanel();
    });
  });
  // Закрыл попап остановки, а фильтр «рядом» не включал — выбор снимается целиком
  map.on("popupclose", (e) => {
    if (e.popup === linesState.popup) {
      linesState.popup = null;
      if (!state.near) linesClearAll();
    }
  });
}

/* ── Легенды ──────────────────────────────────────────────────────────────────
 * PM2.5 — шкала из шести полос, где цвет и есть смысл, без подписи её не прочитать.
 * Шум — семь полос карты города. Каждая видна, пока включён соответствующий слой. */
const legends = { air: null, noise: null };

function initLegends() {
  const mk = (html) => {
    const c = L.control({ position: "bottomright" });
    c.onAdd = () => {
      const box = L.DomUtil.create("div", "legend");
      box.innerHTML = html();
      return box;
    };
    return c;
  };
  legends.air = mk(() => `<b>${tr("legend")}</b>` + [
    ["0–13", 0], ["13–35", 1], ["35–55", 2], ["55–75", 3], ["75–110", 4], ["&gt;110", 5],
  ].map(([lbl, i]) => `<span><i style="background:${PM25_BANDS[i][1]}"></i>${lbl}</span>`).join(""));
  legends.noise = mk(() => `<b>${tr("noise_leg")} · ${tr(noiseSel.night ? "per_night" : "per_day")}</b>` +
    NOISE_BANDS.map(([lbl, c]) => `<span><i style="background:${c}"></i>${lbl}</span>`).join(""));
}

/* force — пересобрать текст (сменился язык или период шума), иначе только показать/спрятать */
function refreshLegends(force = false) {
  if (!legends.air) return;
  const airOn = layerDefs.some((d) => (d.key === "gios" || d.key === "airly") && layerOn.has(d.key));
  [[legends.air, airOn], [legends.noise, !!noiseSel.src]].forEach(([ctl, on]) => {
    if (ctl._map && (force || !on)) ctl.remove();
    if (on && !ctl._map) ctl.addTo(map);
  });
}

/* Рисуем ВСЕ отфильтрованные квартиры, без потолка.
 * Раньше стоял slice(0, 800) «ради скорости» — и это читалось как баг карты:
 * при сортировке по цене в 800 дешёвых попадали окраины, центр оставался
 * пустым, а любой фильтр менял состав выборки и центр внезапно «появлялся».
 * Обрезать выдачу молча нельзя: карта обязана показывать то же, что список.
 * Скорость держит canvas-рендерер — две тысячи точек он тянет без нагрузки,
 * в отличие от SVG, где каждая точка это отдельный элемент DOM. */
function renderMarkers() {
  layer.clearLayers();
  markers.clear();
  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent").trim();
  // Размер точки кратен рейтингу: величина в размере, а не в цвете
  state.shown.forEach((a) => {
    if (a.lat == null) return;
    const r = 4 + (a.sc ?? 0) / 100 * 6;
    const m = L.circleMarker([a.lat, a.lon], {
      renderer: canvas, pane: "pApts",
      radius: r, weight: 2, color: "#fcfcfb",
      fillColor: accent, fillOpacity: .85,
    }).addTo(layer);
    m.bindTooltip(`${money(a.p)} · ${num(a.a, " " + tr("m2"))} · ${tr("rating")} ${Math.round(a.sc)}`);
    // У маркера на canvas нет DOM-узла, куда вернуть фокус — явно гасим
    // опекуна (а не оставляем случайный от прошлой карточки)
    m.on("click", () => { if ($("#sheet").hidden) sheetOpenerId = null; select(a.id, false); });
    markers.set(a.id, m);
  });
  // после смены фильтров маркеры пересозданы — гало тоже надо вернуть
  if (state.activeId) highlightMarker(state.activeId);
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

  if (fromList && a.lat != null) {
    map.setView([a.lat, a.lon], Math.max(map.getZoom(), 15));
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
 * Гало отдельным кругом под маркером: увеличить сам маркер мало — в плотной
 * застройке он теряется среди соседей. */
let halo = null;

function highlightMarker(id) {
  const m = markers.get(id);
  if (halo) { layer.removeLayer(halo); halo = null; }
  if (!m) return;                            // маркера нет: квартира отфильтрована

  const accent = getComputedStyle(document.documentElement)
    .getPropertyValue("--accent").trim() || "#2a78d6";
  const ll = m.getLatLng();
  halo = L.circleMarker(ll, {
    renderer: canvas, pane: "pApts",
    radius: 15, weight: 2, color: accent,
    fillColor: accent, fillOpacity: .18, interactive: false,
  }).addTo(layer);
  halo.bringToBack();                        // под маркерами, а не поверх них
  m.bringToFront();
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
    // бот мог прислать своё избранное/скрытые — site-ui.js дописал их в localStorage
    loadHidden(); loadFavorites();
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
  const prefs = { ...state.profilePrefs, places: state.places };
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
    state.placeTimes = [];
    if (state.layers.tt) delete state.layers.tt.places;
    refreshWorkUI(); apply();
    return;
  }
  const key = JSON.stringify([state.places.map((p) => [(+p.lat).toFixed(5), (+p.lon).toFixed(5)]), BUILD]);
  let times = null;
  try {
    const c = JSON.parse(localStorage.getItem("wf_ptimes") || "null");
    if (c && c.key === key) times = c.times;
  } catch {}
  if (!times) {
    if (msg) msg.textContent = tr("place_times_busy");
    try {
      const r = await fetch(`${API_BASE}/commute-times`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ places: state.places.map((p) => ({ lat: p.lat, lon: p.lon })) }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { if (msg) msg.textContent = data.error || tr("place_err"); return; }
      times = data.times;
      try { localStorage.setItem("wf_ptimes", JSON.stringify({ key, times })); } catch {}
    } catch { if (msg) msg.textContent = tr("place_err"); return; }
    if (msg) msg.textContent = "";
  }
  state.placeTimes = times;
  // фильтр «≤ N мин» и commute() читают state.layers.tt — там только первое место
  state.layers.tt = { places: times[0] };
  const f = $("#f-tmax");
  f.disabled = false;
  $("#commute-field")?.removeAttribute("hidden");
  rowMeasuredNormal = 0; rowMeasuredGap = 0;   // в карточке появилась/сменилась строка
  refreshWorkUI(); apply();
}

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

function bindNotify() {
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
  ["f_own",      (a) => monthly(a.p, a.cz), "min", (v) => `~${nf.format(Math.round(v))} ${tr("mo")}`],
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
let photoData = null, photoLoading = null;
let galleryKeys = null;

/* Фото грузим ОТДЕЛЬНО от расстояний: файл 4.2 МБ, и если тянуть его одним
 * пакетом, то блок «Что рядом» ждал бы картинки, хотя нужен раньше. */
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
function openRemovedAt(lat, lon, latlng) {
  loadRemoved().then(() => {
    const rows = remData?.[locKey(lat, lon)] || [];
    if (rows.length === 1) return openArch(rows[0].id);
    if (!rows.length) return;
    const items = rows.map((r) => `<button type="button" class="rem-pick" data-arch="${esc(r.id)}">
        <b>${money(r.p)}</b> · ${num(r.a, " " + tr("m2"))} · ${r.r ?? "?"} ${tr("rooms_s")}<br>
        <span>${esc(removedPeriod(r))}</span></button>`).join("");
    L.popup({ maxWidth: 300, className: "rem-pop" }).setLatLng(latlng)
      .setContent(`<div class="rem-pick-t">${esc(tr("arch_here"))}</div><div class="rem-pick-list">${items}</div>`)
      .openOn(map);
  });
}

/* «Карточка» у снятых — в «Что рядом» карточки и в списке на карте */
function bindArchLinks() {
  document.addEventListener("click", (e) => {
    const b = e.target.closest?.(".rem-open, .rem-pick");
    if (!b) return;
    if (b.classList.contains("rem-pick")) map.closePopup();
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
function removedHtml(a) {
  if (a.lat == null) return "";
  const rows = remData?.[locKey(a.lat, a.lon)];
  if (!rows?.length) return "";
  const items = rows.map((r) => `
    <div class="rrow">
      <span class="roff">${esc(removedPeriod(r))}</span>
      <div>${money(r.p)}${r.ppm ? ` · ${nf.format(Math.round(r.ppm))} ${tr("ppm_u")}` : ""}</div>
      <div>${num(r.a, " " + tr("m2"))} · ${esc(r.r ?? "?")} ${tr("rooms_s")}${r.sc != null ? ` · ${tr("rating")} ${Math.round(r.sc)}` : ""}</div>
      <button type="button" class="ds-btn ds-btn--link rem-open" data-arch="${esc(r.id)}">${tr("arch_open")}</button>
      <a href="${esc(safeUrl(r.u))}" target="_blank" rel="noopener">${tr("arch")}</a>
    </div>`).join("");
  return `<details class="rem"><summary>${tr("rem")} (${rows.length})</summary>${items}</details>`;
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

const fmtM = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " " + tr("km") : Math.round(m) + " " + tr("m_u"));

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

  const sec = (arr, title, cls) => arr.length
    ? `<details class="dsec ${cls}"><summary>${title} (${arr.length})</summary>
       ${sorted(arr).map((d) => distRow(d, layers)).join("")}</details>` : "";

  const sortToggle = `<div class="dsort" role="group" aria-label="${esc(tr("dsort_label"))}">
    <button type="button" class="dsort-btn${distSortMode === "distance" ? " on" : ""}" data-sort="distance">${tr("dsort_dist")}</button>
    <button type="button" class="dsort-btn${distSortMode === "weight" ? " on" : ""}" data-sort="weight">${tr("dsort_weight")}</button>
  </div>`;

  return `<details class="dist"><summary>${tr("dist")}</summary>
    ${sortToggle}${sec(pos, tr("pos"), "pos")}${sec(neg, tr("neg"), "neg")}</details>`;
}

/* «Полка» вместо реального содержимого «Что рядом», пока dist.json/removed.json
 * ещё не загружены: сворачиваемый блок раскрывается как обычно, но данных
 * внутри до раскрытия ещё нет — фетч начинается ИЗ toggle-обработчика
 * (bindDistLazyLoad), не здесь. Число объектов заранее неизвестно (оно и есть
 * в ещё не скачанном dist.json), поэтому в заголовке — без счётчика. */
function distShellHtml() {
  return `<details class="dist" id="dist-lazy"><summary>${tr("dist")}</summary>
    <div class="gap-note">${tr("dwait")}</div></details>`;
}

// dist-slot целиком: реальные данные, если уже загружены (например, юзер
// открывал «Что рядом» у другой квартиры этим же сеансом), иначе полка
function distSlotHtml(a) {
  return distData ? (distHtml(a.id) + removedHtml(a)) : distShellHtml();
}

/* Догружает dist.json+removed.json (аудит веб-11) не раньше, чем юзер сам
 * раскрыл «Что рядом» — открытие карточки остаётся дешёвым (только
 * apartments.json + photos.json). {once:true}: вешать заново после
 * подмены innerHTML не нужно — уже подставлен настоящий контент. */
function bindDistLazyLoad(a) {
  const det = $("#dist-slot")?.querySelector("#dist-lazy");
  if (!det) return;
  det.addEventListener("toggle", () => {
    if (!det.open || distData) return;
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
  }, { once: true });
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

function openSheet(a) {
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

  const own = monthly(a.p, a.cz);
  const rows = [
    [tr("f_ppm"), a.ppm ? `${nf.format(Math.round(a.ppm))} zł` : "—"],
    [tr("f_area2"), num(a.a, " " + tr("m2"))],
    [tr("f_rooms2"), a.r ?? "—"],
    [tr("f_floor"), a.fl != null ? `${a.fl}${a.tf ? ` ${tr("f_of")} ${a.tf}` : ""}` : "—"],
    [tr("f_year2"), a.by ?? "—"],
    [tr("f_seller2"), LABEL.ut[a.ut] ?? "—"],
    [tr("f_market2"), LABEL.mt[a.mt] ?? "—"],
    [tr("f_cond2"), LABEL.cs[a.cs] ?? "—"],
    [tr("f_metro"), a.wm != null ? `${a.wm} ${tr("min")}${a.mn ? ` (${a.mn})` : ""}` : "—"],
    [tr("f_noise"), noiseText(a)],
    [tr("f_school"), a.se != null ? `${Math.round(a.se)}%` : "—"],
    [tr("f_own"), own ? `~${nf.format(Math.round(own))} ${tr("mo")}` : "—"],
    ...(arch ? [[tr("arch_period"), archPeriod(a)]]
      : [[tr("f_since"), fmtDate(a.seen) ?? "—"], [tr("f_checked"), checkedText(a)]]),
  ].filter(([k, v]) => !arch || (v !== "—" && k !== tr("f_own")));   // у снятой — без пустых строк и расчёта владения
  // «Дорога до дома» — только в личной сборке: в публичной изохрон нет
  if (!arch) state.places.forEach((pl, i) => {
    const m = state.placeTimes[i]?.[a.id];
    if (m != null) rows.push([pl.name, `${m} ${tr("min")} · ${tr("transit")}`]);
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
    ${wantTagsHtml(a)}
    ${a.blur >= 100 ? `<div class="gap-note">${tr("blur")(a.blur)}</div>` : ""}
    ${axesHtml(a)}
    ${a.gap ? `<div class="gap-note">${tr("gaps")(a.gap)}</div>` : ""}
    <div id="ph-slot">${galleryHtml(a)}</div>
    <dl class="facts">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    ${dupsHtml(a)}
    ${arch ? "" : `<div id="dist-slot">${distSlotHtml(a)}</div>`}
    <div class="sheet-links">
      <a href="${esc(safeUrl(a.u))}" target="_blank" rel="noopener">${tr(arch ? "arch_otodom" : "otodom")}</a>
      <a href="https://www.google.com/maps?layer=c&cbll=${a.lat},${a.lon}" target="_blank" rel="noopener">${tr("street")}</a>
      ${a.dev ? `<a href="${esc(safeUrl(a.dev))}" target="_blank" rel="noopener">${tr("devall")}</a>` : ""}
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
  map?.invalidateSize();
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
  if (e.key === "Escape" && !$("#sheet").hidden) closeSheet();
  if (e.key === "Escape") closeAllFilterUI();
});

load().catch((e) => {
  $("#list").innerHTML = `<p class="empty">${tr("err")}<br>${esc(e.message)}<br><br>
    ${tr("err_h")}</p>`;
});
