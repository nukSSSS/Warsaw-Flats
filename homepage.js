// homepage.html — тема, язык (RU/PL), профиль и живой счётчик квартир.
// Переиспользует общий site-ui.js (решение юзера 2026-09-23: язык и профиль
// нужны на всех новых страницах, не только на app.html) — внешний модуль,
// не инлайн-скрипт, т.к. CSP страницы (script-src 'self', без
// 'unsafe-inline') инлайн-скрипт всё равно бы не пустила.

import { initTheme, initLang, initProfile } from "./site-ui.js";

const T = {
  ru: {
    theme_t: "Светлая / тёмная тема",
    profile_a: "Профиль: избранное и скрытые", profile_device: "Это устройство · без входа",
    menu_fav: "Избранное", menu_hidden: "Скрытые",
    menu_listings: "Мои объявления", menu_soon: "скоро",
    eyebrow: "Квартиры в Варшаве",
    hero_h1: "Честный рейтинг вместо красивых фотографий",
    hero_p: "Три инструмента в одном месте: смотрите готовую базу с рейтингом, "
      + "оцените любую квартиру по своим критериям или разместите своё объявление.",
    stat_count: "квартир в базе", stat_criteria: "критерия в рейтинге", stat_free: "без регистрации и оплаты",
    card1_h2: "База квартир",
    card1_p: "Собранные объявления по всей Варшаве с рейтингом 0–100 по 44 "
      + "критериям — транспорт, шум, зелень, инфраструктура. Список, карта, фильтры.",
    card1_stat: "Список, карта, фильтры", card1_go: "Смотреть базу →",
    card2_h2: "Оценить квартиру",
    card2_p: "Квартира не из нашей базы? Вставьте ссылку на объявление (Otodom) "
      + "или введите параметры вручную — получите тот же честный анализ, с "
      + "собственными весами критериев.",
    card2_stat: "Ссылка или ручной ввод", card2_go: "Оценить →",
    card3_h2: "Разместить объявление",
    card3_p: "Продаёте или сдаёте квартиру в Варшаве? Оставьте заявку — мы "
      + "свяжемся с вами вручную по указанному контакту.",
    card3_stat: "Без регистрации", card3_go: "Оставить заявку →",
    foot_p: "Бесплатно, без регистрации и скрытых условий.",
  },
  pl: {
    theme_t: "Jasny / ciemny motyw",
    profile_a: "Profil: ulubione i ukryte", profile_device: "To urządzenie · bez logowania",
    menu_fav: "Ulubione", menu_hidden: "Ukryte",
    menu_listings: "Moje ogłoszenia", menu_soon: "wkrótce",
    eyebrow: "Mieszkania w Warszawie",
    hero_h1: "Uczciwy ranking zamiast ładnych zdjęć",
    hero_p: "Trzy narzędzia w jednym miejscu: przeglądaj gotową bazę z rankingiem, "
      + "wyceń dowolne mieszkanie według własnych kryteriów albo dodaj swoje ogłoszenie.",
    stat_count: "mieszkań w bazie", stat_criteria: "kryteria w rankingu", stat_free: "bez rejestracji i opłat",
    card1_h2: "Baza mieszkań",
    card1_p: "Zebrane ogłoszenia z całej Warszawy z rankingiem 0–100 według 44 "
      + "kryteriów — transport, hałas, zieleń, infrastruktura. Lista, mapa, filtry.",
    card1_stat: "Lista, mapa, filtry", card1_go: "Zobacz bazę →",
    card2_h2: "Wyceń mieszkanie",
    card2_p: "Mieszkania nie ma w naszej bazie? Wklej link do ogłoszenia (Otodom) "
      + "albo wpisz parametry ręcznie — otrzymasz tę samą uczciwą analizę, z "
      + "własnymi wagami kryteriów.",
    card2_stat: "Link albo ręczne wprowadzanie", card2_go: "Wyceń →",
    card3_h2: "Dodaj ogłoszenie",
    card3_p: "Sprzedajesz albo wynajmujesz mieszkanie w Warszawie? Zostaw zgłoszenie — "
      + "skontaktujemy się z Tobą ręcznie, podanym kontaktem.",
    card3_stat: "Bez rejestracji", card3_go: "Zostaw zgłoszenie →",
    foot_p: "Bezpłatnie, bez rejestracji i ukrytych warunków.",
  },
};

initTheme();
initProfile();
initLang(T);

// Подпись «квартир в базе» уже в разметке (.lnd-stats .t) — сюда только число.
fetch("data/meta.json").then((r) => r.json()).then((m) => {
  if (m && m.count) {
    document.getElementById("lnd-count").textContent = new Intl.NumberFormat("ru-RU").format(m.count);
  }
}).catch(() => {});
