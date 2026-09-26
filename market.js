// market.html — тема, язык (RU/PL), профиль и живой счётчик квартир.
// Переиспользует общий site-ui.js (решение юзера 2026-09-23: язык и профиль
// нужны на всех новых страницах, не только на app.html) — внешний модуль,
// не инлайн-скрипт: CSP страницы (script-src 'self', без 'unsafe-inline')
// инлайн-скрипт всё равно бы не пустила.

import { initTheme, initLang, initProfile } from "./site-ui.js";

const T = {
  ru: {
    theme_t: "Светлая / тёмная тема",
    profile_a: "Профиль: избранное и скрытые", profile_device: "Это устройство · без входа",
    menu_fav: "Избранное", menu_hidden: "Скрытые",
    menu_listings: "Мои объявления", menu_soon: "скоро",
    hero_h1: "Ищете квартиру в Варшаве?",
    hero_p: "Собрали объявления по всему городу и оценили каждую квартиру честно — "
      + "не только цена и метраж, а шум, дорога до метро, зелень рядом, "
      + "инфраструктура. Бесплатно, без регистрации.",
    cta_view: "Смотреть квартиры", cta_valuate: "Оценить конкретную квартиру",
    stat_count: "квартир в базе прямо сейчас",
    stat_criteria: "критерия в рейтинге: транспорт, шум, зелень, инфраструктура",
    stat_free: "бесплатно, без регистрации и скрытых условий",
    how_title: "Как это работает",
    how_p1: "Каждая квартира получает рейтинг 0–100 по пяти направлениям: транспорт, "
      + "инфраструктура, зелень и тишина, соседство, сама квартира и дом. Видно "
      + "не только «сколько метров», а честно — рядом ли шумная дорога или "
      + "аэропорт, далеко ли до ближайшей школы, сколько идти до метро пешком.",
    how_p2_pre: "Нашли квартиру не в нашей базе (на другом сайте или по объявлению)? Можно",
    how_p2_link: "оценить её отдельно",
    how_p2_post: " — вставить ссылку или ввести параметры вручную и получить тот же честный анализ.",
    soon_p: "Продаёте или сдаёте квартиру? Оставьте заявку — мы свяжемся с вами.",
    soon_cta: "Разместить объявление",
    foot_link: "Перейти к полному списку и карте →",
  },
  pl: {
    theme_t: "Jasny / ciemny motyw",
    profile_a: "Profil: ulubione i ukryte", profile_device: "To urządzenie · bez logowania",
    menu_fav: "Ulubione", menu_hidden: "Ukryte",
    menu_listings: "Moje ogłoszenia", menu_soon: "wkrótce",
    hero_h1: "Szukasz mieszkania w Warszawie?",
    hero_p: "Zebraliśmy ogłoszenia z całego miasta i oceniliśmy każde mieszkanie uczciwie — "
      + "nie tylko cenę i metraż, ale hałas, dojazd do metra, zieleń w pobliżu, "
      + "infrastrukturę. Bezpłatnie, bez rejestracji.",
    cta_view: "Zobacz mieszkania", cta_valuate: "Wyceń konkretne mieszkanie",
    stat_count: "mieszkań w bazie w tej chwili",
    stat_criteria: "kryteria w rankingu: transport, hałas, zieleń, infrastruktura",
    stat_free: "bezpłatnie, bez rejestracji i ukrytych warunków",
    how_title: "Jak to działa",
    how_p1: "Każde mieszkanie otrzymuje ranking 0–100 w pięciu kierunkach: transport, "
      + "infrastruktura, zieleń i cisza, sąsiedztwo, samo mieszkanie i budynek. Widać "
      + "nie tylko „ile metrów”, ale uczciwie — czy blisko jest ruchliwa droga albo "
      + "lotnisko, jak daleko do najbliższej szkoły, ile iść pieszo do metra.",
    how_p2_pre: "Znalazłeś mieszkanie spoza naszej bazy (na innej stronie albo z ogłoszenia)? Możesz",
    how_p2_link: "wycenić je osobno",
    how_p2_post: " — wklej link albo wpisz parametry ręcznie i otrzymaj tę samą uczciwą analizę.",
    soon_p: "Sprzedajesz albo wynajmujesz mieszkanie? Zostaw zgłoszenie — skontaktujemy się z Tobą.",
    soon_cta: "Dodaj ogłoszenie",
    foot_link: "Przejdź do pełnej listy i mapy →",
  },
};

initTheme();
initProfile();
initLang(T);

// meta.json уже публикуется для app.html — переиспользуем то же поле count.
fetch("data/meta.json").then((r) => r.json()).then((m) => {
  if (m && m.count) {
    document.getElementById("mkt-count").textContent =
      new Intl.NumberFormat("ru-RU").format(m.count);
  }
}).catch(() => {});
