const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "data", "research");
const OUTPUT_FILE = path.join(
  OUTPUT_DIR,
  "koszeg-doc-search-results.json"
);

const YEARS = [
  2015, 2016, 2017, 2018, 2019, 2020, 2021,
  2022, 2023, 2024, 2025, 2026
];

const START_URLS = [
  "https://koszeg.hu/hu/onkormanyzat/hirek/",
  "https://koszeg.hu/hu/onkormanyzat/projektek/",
  ...YEARS.map(
    (year) =>
      `https://koszeg.hu/hu/onkormanyzat/testulet/ulesek/index.php?ev=${year}`
  )
];

/*
 * Általános kutatási kulcsszavak.
 * Ezek megtartják a crawler korábbi funkcióját.
 */
const KEYWORDS = [
  "azbeszt",
  "zúzottkő",
  "zúzalék",
  "útalap",
  "kavics",
  "szerpentinit",
  "bernstein",
  "pilgersdorf",
  "rumpersdorf",
  "útfelújítás",
  "burkolatfelújítás",
  "aszfaltozás",
  "csapadékvíz",
  "kivitelező",
  "m3",
  "m³",
  "tonna",

  // Új mérési / környezetvédelmi kulcsszavak
  "rost/m³",
  "rost/m3",
  "rost",
  "azbesztrost",
  "azbesztrostok",
  "levegő",
  "levegőminta",
  "levegővizsgálat",
  "mintavétel",
  "mérési eredmény",
  "mérési eredmények",
  "határérték",
  "koncentráció",
  "24 órás",
  "24 óra",
  "krizotil",
  "tremolit",
  "amfibol",
  "sem",
  "elektronmikroszkóp",
  "laboratórium",
  "laborvizsgálat"
];

/*
 * Ezek erősebben utalnak arra, hogy az oldal
 * tényleges mérési információt tartalmazhat.
 */
const MEASUREMENT_KEYWORDS = [
  "rost/m³",
  "rost/m3",
  "azbesztrost",
  "levegőminta",
  "levegővizsgálat",
  "mintavétel",
  "mérési eredmény",
  "határérték",
  "koncentráció",
  "24 órás",
  "24 óra"
];

/*
 * Első körben ismert kőszegi helyszínnevek.
 * Ez NEM mérési adatbázis.
 *
 * Csak azt segíti, hogy a crawler felismerje
 * a forrásszövegben szereplő helyszínneveket.
 */
const LOCATION_PATTERNS = [
  "Hermina utca",
  "Hermina út",
  "Borostyánkő Gyermekotthon",
  "Borostyán Gyermekotthon",
  "Pocichter utca",
  "Vámház utca",
  "Rőtivölgyi utca",
  "Kőszeg",
  "Szombathely",
  "Oladi plató"
];

const MAX_PAGES = 300;

/*
 * Ennyi karaktert mentünk egy releváns találat körül.
 * Nem tároljuk el feleslegesen az egész weboldalt.
 */
const CONTEXT_RADIUS = 450;

/*
 * Maximum ennyi releváns kontextusrészlet kerül
 * egy oldalhoz.
 */
const MAX_CONTEXTS_PER_PAGE = 12;


/* =========================================================
   SEGÉDFÜGGVÉNYEK
   ========================================================= */

function normalizeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href.split("#")[0];
  } catch {
    return null;
  }
}

function isKoszegUrl(url) {
  return url.startsWith("https://koszeg.hu/");
}

function isDocumentLink(url) {
  const lower = url.toLowerCase();

  return (
    lower.endsWith(".pdf") ||
    lower.includes("download.php") ||
    lower.includes("eloterjesztes.php")
  );
}

function shouldFollowLink(url) {
  return (
    url.includes("/hirek/") ||
    url.includes("/ulesek/") ||
    url.includes("/projektek/") ||
    url.includes("content.php") ||
    url.includes("ules.php") ||
    url.includes("index.php?ev=")
  );
}

function decodeHtmlEntities(text) {
  if (!text) return "";

  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => {
      try {
        return String.fromCharCode(Number(code));
      } catch {
        return _;
      }
    });
}

/*
 * HTML -> egyszerű kereshető szöveg.
 *
 * Nem akarunk teljes DOM-parser függőséget bevezetni,
 * ezért az első verzió dependency-free marad.
 */
function htmlToText(html) {
  if (!html) return "";

  return decodeHtmlEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<\/li>/gi, "\n")
      .replace(/<\/h[1-6]>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function findKeywordMatches(text, keywords = KEYWORDS) {
  const lowerText = String(text || "").toLowerCase();

  return keywords.filter((keyword) =>
    lowerText.includes(keyword.toLowerCase())
  );
}

function findLocations(text) {
  const lowerText = String(text || "").toLowerCase();

  return LOCATION_PATTERNS.filter((location) =>
    lowerText.includes(location.toLowerCase())
  );
}


/* =========================================================
   MÉRÉSI ÉRTÉKEK FELISMERÉSE
   ========================================================= */

/*
 * Az első verzió szándékosan konzervatív.
 *
 * Csak olyan számokat tekintünk mérési értéknek,
 * amelyekhez közvetlenül mértékegység kapcsolódik.
 *
 * Példák:
 *   40 246 rost/m³
 *   76254 rost/m3
 *   1.430 rost/m³
 *   2 591 rost / m³
 *
 * A parser NEM állítja, hogy az érték határérték,
 * 24 órás átlag vagy rövid mérés.
 * Ezt később a research builder minősíti.
 */
function extractMeasurementValues(text) {
  const source = String(text || "");

  const patterns = [
    {
      unit: "rost/m³",
      regex:
        /(\d{1,3}(?:[\s\u00A0.,]\d{3})+|\d+)\s*(?:rost|szál)\s*\/\s*m(?:³|3)/gi
    },
    {
      unit: "µg/m³",
      regex:
        /(\d+(?:[.,]\d+)?)\s*(?:µg|μg|ug)\s*\/\s*m(?:³|3)/gi
    },
    {
      unit: "mg/m³",
      regex:
        /(\d+(?:[.,]\d+)?)\s*mg\s*\/\s*m(?:³|3)/gi
    }
  ];

  const values = [];

  for (const pattern of patterns) {
    let match;

    while ((match = pattern.regex.exec(source)) !== null) {
      const rawNumber = match[1];

      /*
       * Magyar ezres elválasztás kezelése.
       *
       * A "40 246" -> 40246.
       * A "1.430" ebben a környezetben potenciálisan
       * 1430 is lehet, ezért a raw értéket is megtartjuk.
       *
       * A későbbi builder a kontextus alapján tudja
       * véglegesíteni.
       */
      const normalizedNumber = normalizeMeasurementNumber(
        rawNumber,
        pattern.unit
      );

      values.push({
        raw: match[0],
        raw_value: rawNumber,
        value: normalizedNumber,
        unit: pattern.unit,
        index: match.index
      });
    }
  }

  return values;
}

function normalizeMeasurementNumber(raw, unit) {
  if (!raw) return null;

  let value = String(raw)
    .replace(/\u00A0/g, " ")
    .trim();

  /*
   * Rost/m³ esetén az értékek jellemzően egész
   * darabszám-koncentrációk.
   */
  if (unit === "rost/m³") {
    value = value.replace(/\s/g, "");

    /*
     * 40.246 vagy 40,246 jellegű ezres csoportosítás.
     */
    if (/^\d{1,3}([.,]\d{3})+$/.test(value)) {
      value = value.replace(/[.,]/g, "");
    } else {
      value = value.replace(",", ".");
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : null;
  }

  /*
   * Tömegkoncentrációnál vessző lehet tizedesjel.
   */
  value = value
    .replace(/\s/g, "")
    .replace(",", ".");

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : null;
}


/* =========================================================
   KONTEXTUS KINYERÉSE
   ========================================================= */

function extractContextAroundIndex(
  text,
  index,
  radius = CONTEXT_RADIUS
) {
  const source = String(text || "");

  const start = Math.max(0, index - radius);
  const end = Math.min(
    source.length,
    index + radius
  );

  return source
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
}

function extractRelevantContexts(text) {
  const source = String(text || "");
  const lower = source.toLowerCase();

  const contexts = [];
  const seen = new Set();

  const searchTerms = [
    ...MEASUREMENT_KEYWORDS,
    "azbeszt",
    "krizotil",
    "tremolit",
    "szerpentinit"
  ];

  for (const term of searchTerms) {
    const needle = term.toLowerCase();

    let startIndex = 0;

    while (true) {
      const index = lower.indexOf(
        needle,
        startIndex
      );

      if (index === -1) break;

      const context =
        extractContextAroundIndex(source, index);

      const key = context
        .toLowerCase()
        .slice(0, 220);

      if (!seen.has(key)) {
        seen.add(key);
        contexts.push(context);
      }

      if (
        contexts.length >=
        MAX_CONTEXTS_PER_PAGE
      ) {
        return contexts;
      }

      startIndex = index + needle.length;
    }
  }

  return contexts;
}


/* =========================================================
   MÉRÉSI JELÖLTEK
   ========================================================= */

function buildMeasurementCandidates(text) {
  const values = extractMeasurementValues(text);

  if (!values.length) {
    return [];
  }

  return values.map((measurement) => {
    const context = extractContextAroundIndex(
      text,
      measurement.index
    );

    const measurementKeywords =
      findKeywordMatches(
        context,
        MEASUREMENT_KEYWORDS
      );

    const asbestosKeywords =
      findKeywordMatches(context, [
        "azbeszt",
        "azbesztrost",
        "krizotil",
        "tremolit",
        "amfibol"
      ]);

    const locations = findLocations(context);

    /*
     * Confidence itt csak gépi jelölés.
     * Nem tudományos/hatósági minősítés.
     */
    let confidence = "low";

    if (
      measurementKeywords.length > 0 &&
      asbestosKeywords.length > 0
    ) {
      confidence = "high";
    } else if (
      measurementKeywords.length > 0 ||
      asbestosKeywords.length > 0
    ) {
      confidence = "medium";
    }

    return {
      raw: measurement.raw,
      raw_value: measurement.raw_value,
      value: measurement.value,
      unit: measurement.unit,
      locations,
      measurement_keywords:
        measurementKeywords,
      asbestos_keywords:
        asbestosKeywords,
      confidence,
      context
    };
  });
}


/* =========================================================
   LINK KINYERÉS
   ========================================================= */

function extractLinks(html, baseUrl) {
  const links = [];

  const regex =
    /<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["']/gi;

  let match;

  while ((match = regex.exec(html)) !== null) {
    const url = normalizeUrl(
      match[1],
      baseUrl
    );

    if (url && isKoszegUrl(url)) {
      links.push(url);
    }
  }

  return [...new Set(links)];
}


/* =========================================================
   HTTP
   ========================================================= */

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent":
        "Koszeg-asbestos-research-bot/2.0",
      Accept:
        "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  return await response.text();
}


/* =========================================================
   HTML OLDAL FELDOLGOZÁSA
   ========================================================= */

function analyseHtmlPage(html, url) {
  const text = htmlToText(html);

  const matches =
    findKeywordMatches(text);

  const measurementMatches =
    findKeywordMatches(
      text,
      MEASUREMENT_KEYWORDS
    );

  const locations =
    findLocations(text);

  const measurementCandidates =
    buildMeasurementCandidates(text);

  const relevantContexts =
    matches.length > 0
      ? extractRelevantContexts(text)
      : [];

  return {
    type: "html_page",
    url,
    checked_at:
      new Date().toISOString(),

    matched_keywords: matches,

    measurement_keywords:
      measurementMatches,

    detected_locations:
      locations,

    has_relevant_match:
      matches.length > 0,

    has_measurement_signal:
      measurementMatches.length > 0,

    has_measurement_candidate:
      measurementCandidates.length > 0,

    measurement_candidates:
      measurementCandidates,

    relevant_contexts:
      relevantContexts
  };
}


/* =========================================================
   CRAWLER
   ========================================================= */

async function crawl() {
  const visited = new Set();
  const queued = new Set(START_URLS);

  const queue = [...START_URLS];

  const results = [];
  const documentLinks = new Set();

  let measurementCandidateCount = 0;

  while (
    queue.length > 0 &&
    visited.size < MAX_PAGES
  ) {
    const url = queue.shift();
    queued.delete(url);

    if (visited.has(url)) {
      continue;
    }

    visited.add(url);

    console.log(
      `Ellenőrzés (${visited.size}/${MAX_PAGES}): ${url}`
    );

    try {
      const html =
        await fetchText(url);

      const analysis =
        analyseHtmlPage(html, url);

      const links =
        extractLinks(html, url);

      analysis.discovered_links =
        links.length;

      for (const link of links) {
        if (isDocumentLink(link)) {
          documentLinks.add(link);
          continue;
        }

        if (
          !visited.has(link) &&
          !queued.has(link) &&
          shouldFollowLink(link)
        ) {
          queue.push(link);
          queued.add(link);
        }
      }

      measurementCandidateCount +=
        analysis.measurement_candidates.length;

      /*
       * Megtartjuk minden oldal rekordját,
       * így kompatibilisek maradunk a korábbi
       * research builderrel.
       */
      results.push(analysis);

    } catch (error) {
      console.warn(
        `Hiba: ${url} -> ${error.message}`
      );

      results.push({
        type: "html_page",
        url,
        checked_at:
          new Date().toISOString(),
        error: error.message,
        matched_keywords: [],
        measurement_keywords: [],
        detected_locations: [],
        has_relevant_match: false,
        has_measurement_signal: false,
        has_measurement_candidate: false,
        measurement_candidates: [],
        relevant_contexts: []
      });
    }
  }


  /* =======================================================
     DOKUMENTUMLINKEK
     ======================================================= */

  for (const docUrl of documentLinks) {
    results.push({
      type: "document_link",
      url: docUrl,
      checked_at:
        new Date().toISOString(),

      matched_keywords: [],
      measurement_keywords: [],
      detected_locations: [],

      has_relevant_match: false,
      has_measurement_signal: false,
      has_measurement_candidate: false,

      measurement_candidates: [],
      relevant_contexts: [],

      /*
       * Fontos:
       * PDF-et ebben a verzióban még nem próbálunk
       * response.text()-tel elemezni, mert az bináris
       * dokumentumnál hibás eredményt adna.
       *
       * A következő modul végzi majd a dokumentum
       * tartalmi feldolgozását.
       */
      document_analysis_status:
        "pending",

      note:
        "Dokumentumlink azonosítva. A bináris/PDF tartalom elemzését külön dokumentumfeldolgozó modul végzi."
    });
  }


  /* =======================================================
     KIMENET
     ======================================================= */

  fs.mkdirSync(
    OUTPUT_DIR,
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(
      results,
      null,
      2
    ),
    "utf8"
  );


  /* =======================================================
     FUTÁSI ÖSSZEGZÉS
     ======================================================= */

  const relevantPages =
    results.filter(
      (item) =>
        item.type === "html_page" &&
        item.has_relevant_match
    ).length;

  const measurementPages =
    results.filter(
      (item) =>
        item.type === "html_page" &&
        item.has_measurement_candidate
    ).length;

  console.log("");
  console.log("=================================");
  console.log("KŐSZEG RESEARCH CRAWLER – KÉSZ");
  console.log("=================================");
  console.log(
    `Kimenet: ${OUTPUT_FILE}`
  );
  console.log(
    `Bejárt oldalak: ${visited.size}`
  );
  console.log(
    `Releváns oldalak: ${relevantPages}`
  );
  console.log(
    `Mérési jelöltet tartalmazó oldalak: ${measurementPages}`
  );
  console.log(
    `Mérési jelöltek: ${measurementCandidateCount}`
  );
  console.log(
    `Talált dokumentumlinkek: ${documentLinks.size}`
  );
  console.log("=================================");
}


/* =========================================================
   INDÍTÁS
   ========================================================= */

crawl().catch((error) => {
  console.error(
    "Crawler végzetes hiba:",
    error
  );

  process.exitCode = 1;
});
