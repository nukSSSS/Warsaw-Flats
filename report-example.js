// report-example.html — лендинг «зачем» (20.10.2026): отчёт по квартире на обезличенном примере.
// Тема и язык — общий site-ui.js, как на market.html.

import { initTheme, initLang } from "./site-ui.js?v=202610312009";

const T = {
  ru: {
    page_title: "Warsaw Flats — отчёт по квартире",
    theme_t: "Светлая / тёмная тема",
    h1: "Сколько на самом деле стоит квартира, которую вы смотрите?",
    hero_p: "Пришлите ссылку на объявление — получите отчёт: за сколько реально продают похожие квартиры рядом, "
      + "во что обойдётся покупка целиком и с какой суммы начать торг. Бесплатно, в Telegram, за несколько секунд.",
    cta_bot: "Получить отчёт в Telegram", cta_site: "Смотреть квартиры",
    ex_h2: "Пример: реальная квартира, адрес скрыт",
    ex_t1: "4 комнаты", ex_t2: "около 62 м²", ex_t3: "первый этаж со своим садом", ex_t4: "новый дом",
    ex_t5: "север Варшавы", ex_t6: "продаёт хозяин", ex_t7: "в объявлении ≈ 1,05 млн zł",
    b1_l: "Цена", b1_v: "на 16% дороже сделок рядом", b1_s: "по нотариальным актам похожих квартир за последний год",
    b2_l: "Торг", b2_v: "есть куда", b2_s: "почти 3 месяца в продаже, цену снижали 3 раза",
    b3_l: "С чего начать", b3_v: "≈ 950 тыс. zł", b3_s: "цель — около 980 тыс.: это −70 тыс. к цене объявления",
    plan_t: "В этом же доме похожие квартиры продавали по ≈ 15 250 zł/м² — это ≈ 950 тыс. за такую площадь, а не 1,05 млн.",
    plan_s: "Этого не видно ни в объявлении, ни на портале: цифра — из реестра сделок (RCN), по нотариальным актам.",
    args_h: "Доводы для торга из отчёта",
    a1: "Сделки в этом доме — ≈ 950 тыс. за такую площадь.",
    a2: "Квартира на 16% дороже похожих сделок рядом.",
    a3: "В продаже почти 3 месяца; за это время цену снизили трижды, всего на 140 тыс.",
    cost_h: "Полная стоимость покупки",
    c_col1: "По цене объявления", c_col2: "Если сторгуетесь до 980 тыс.",
    c_flat: "Квартира", c_pcc: "Налог на покупку (PCC) 2%", c_pcc_s: "0 — если это ваше первое жильё",
    c_fees: "Нотариус, суд, банк", c_comm: "Комиссия агентства", c_comm_s: "продаёт хозяин", c_none: "нет",
    c_total: "Итого", c_park: "Место в гараже", c_park_s: "продаётся отдельно — цена из объявления",
    c_cash: "Нужно своих денег при взносе 10%", c_cash_s: "взнос + налог, нотариус, суд, банк",
    c_month: "Платёж в месяц при взносе 20%", c_month_s: "кредит 6,5%, 30 лет + czynsz 950 zł",
    ex_note: "Пример — настоящий отчёт по квартире из базы; адрес, фото и точные данные объявления скрыты. Суммы округлены.",
    what_h: "Что ещё есть в отчёте",
    w1_h: "Сделки, а не объявления", w1_p: "Цены по нотариальным актам: похожие квартиры рядом и в этом доме — по годам с 2006.",
    w2_h: "Вся стоимость покупки", w2_p: "Налог, нотариус, суд, банк, комиссия агентства, место в гараже, первый взнос и платёж в месяц.",
    w3_h: "План торга", w3_p: "С какой суммы начать, до какой цели идти, доводы и сильные стороны — ваши и продавца.",
    w4_h: "Окружение", w4_p: "Сколько идти до остановки, школы и магазина по улицам, парк, шум, что мешает рядом.",
    w5_h: "Вопросы продавцу", w5_p: "Чего нет в объявлении — czynsz, отопление, комиссия — списком вопросов на просмотр.",
    w6_h: "Что проверить на просмотре", w6_p: "Короткий чек-лист: свет, сырость, шум, общие части дома.",
    how_h: "Как получить",
    s1: "Найдите квартиру на otodom.pl и скопируйте ссылку на объявление.",
    s2: "Отправьте её боту @Flats_Warsaw_Bot в Telegram — в любой момент, без регистрации.",
    s3: "Через несколько секунд придёт итог отчёта и кнопка «Открыть отчёт». Его можно сохранить в PDF.",
    how_site: "Или откройте любую квартиру на сайте и нажмите «Отчёт» внизу карточки. Отчёт можно получить по любому объявлению Otodom "
      + "и по адресу — для квартиры без объявления (в боте «Отчёт по адресу» или «Оценить квартиру» на сайте).",
    src_h: "Откуда цифры",
    src_p: "Сделки — из государственного реестра цен (RCN, нотариальные акты). Объявления — с крупнейшего портала, без повторов "
      + "одной квартиры у разных агентств. Расстояния — пешком по улицам по картам OpenStreetMap. Это анализ открытых данных, "
      + "а не оценка rzeczoznawcy: точные суммы налога, нотариуса и кредита назовут нотариус и банк.",
    privacy: "Конфиденциальность",
  },
  pl: {
    page_title: "Warsaw Flats — raport o mieszkaniu",
    theme_t: "Jasny / ciemny motyw",
    h1: "Ile naprawdę jest warte mieszkanie, które oglądasz?",
    hero_p: "Wyślij link do ogłoszenia — dostaniesz raport: za ile naprawdę sprzedają się podobne mieszkania w okolicy, "
      + "ile wyniesie cały zakup i od jakiej kwoty zacząć negocjacje. Bezpłatnie, w Telegramie, w kilka sekund.",
    cta_bot: "Dostań raport w Telegramie", cta_site: "Zobacz mieszkania",
    ex_h2: "Przykład: prawdziwe mieszkanie, adres ukryty",
    ex_t1: "4 pokoje", ex_t2: "około 62 m²", ex_t3: "parter z własnym ogródkiem", ex_t4: "nowy budynek",
    ex_t5: "północ Warszawy", ex_t6: "sprzedaje właściciel", ex_t7: "w ogłoszeniu ≈ 1,05 mln zł",
    b1_l: "Cena", b1_v: "o 16% drożej niż transakcje w okolicy", b1_s: "według aktów notarialnych podobnych mieszkań z ostatniego roku",
    b2_l: "Negocjacje", b2_v: "jest pole", b2_s: "prawie 3 miesiące w sprzedaży, cenę obniżano 3 razy",
    b3_l: "Od czego zacząć", b3_v: "≈ 950 tys. zł", b3_s: "cel — około 980 tys.: to −70 tys. wobec ceny z ogłoszenia",
    plan_t: "W tym samym budynku podobne mieszkania sprzedawano po ≈ 15 250 zł/m² — to ≈ 950 tys. za taką powierzchnię, a nie 1,05 mln.",
    plan_s: "Tego nie widać ani w ogłoszeniu, ani na portalu: liczba pochodzi z rejestru transakcji (RCN), z aktów notarialnych.",
    args_h: "Argumenty do negocjacji z raportu",
    a1: "Transakcje w tym budynku — ≈ 950 tys. za taką powierzchnię.",
    a2: "Mieszkanie jest o 16% droższe niż podobne transakcje w okolicy.",
    a3: "W sprzedaży prawie 3 miesiące; w tym czasie cenę obniżono trzy razy, łącznie o 140 tys.",
    cost_h: "Pełny koszt zakupu",
    c_col1: "Według ceny z ogłoszenia", c_col2: "Jeśli wynegocjujesz 980 tys.",
    c_flat: "Mieszkanie", c_pcc: "Podatek od zakupu (PCC) 2%", c_pcc_s: "0 — jeśli to Twoje pierwsze mieszkanie",
    c_fees: "Notariusz, sąd, bank", c_comm: "Prowizja biura", c_comm_s: "sprzedaje właściciel", c_none: "brak",
    c_total: "Razem", c_park: "Miejsce w garażu", c_park_s: "sprzedawane osobno — cena z ogłoszenia",
    c_cash: "Potrzebne własne środki przy wkładzie 10%", c_cash_s: "wkład + podatek, notariusz, sąd, bank",
    c_month: "Rata miesięczna przy wkładzie 20%", c_month_s: "kredyt 6,5%, 30 lat + czynsz 950 zł",
    ex_note: "Przykład to prawdziwy raport o mieszkaniu z bazy; adres, zdjęcia i dokładne dane ogłoszenia są ukryte. Kwoty zaokrąglone.",
    what_h: "Co jeszcze jest w raporcie",
    w1_h: "Transakcje, nie ogłoszenia", w1_p: "Ceny z aktów notarialnych: podobne mieszkania w okolicy i w tym budynku — według lat od 2006.",
    w2_h: "Cały koszt zakupu", w2_p: "Podatek, notariusz, sąd, bank, prowizja biura, miejsce w garażu, wkład własny i rata miesięczna.",
    w3_h: "Plan negocjacji", w3_p: "Od jakiej kwoty zacząć, do jakiego celu dążyć, argumenty i mocne strony — Twoje i sprzedającego.",
    w4_h: "Otoczenie", w4_p: "Ile iść pieszo ulicami do przystanku, szkoły i sklepu, park, hałas, co przeszkadza w pobliżu.",
    w5_h: "Pytania do sprzedającego", w5_p: "Czego nie ma w ogłoszeniu — czynsz, ogrzewanie, prowizja — listą pytań na oglądanie.",
    w6_h: "Co sprawdzić na oglądaniu", w6_p: "Krótka lista: światło, wilgoć, hałas, części wspólne budynku.",
    how_h: "Jak go dostać",
    s1: "Znajdź mieszkanie na otodom.pl i skopiuj link do ogłoszenia.",
    s2: "Wyślij go botowi @Flats_Warsaw_Bot w Telegramie — w dowolnym momencie, bez rejestracji.",
    s3: "Po kilku sekundach przyjdzie podsumowanie raportu i przycisk „Otwórz raport”. Można go zapisać jako PDF.",
    how_site: "Albo otwórz dowolne mieszkanie na stronie i kliknij „Raport” na dole karty. Raport można dostać dla każdego ogłoszenia z Otodom "
      + "i po adresie — dla mieszkania bez ogłoszenia (w bocie „Raport po adresie” albo „Wyceń mieszkanie” na stronie).",
    src_h: "Skąd liczby",
    src_p: "Transakcje — z państwowego rejestru cen (RCN, akty notarialne). Ogłoszenia — z największego portalu, bez powtórzeń "
      + "jednego mieszkania u różnych agencji. Odległości — pieszo ulicami według map OpenStreetMap. To analiza otwartych danych, "
      + "a nie wycena rzeczoznawcy: dokładne kwoty podatku, notariusza i kredytu poda notariusz i bank.",
    privacy: "Prywatność",
  },
};

initTheme();
initLang(T);
