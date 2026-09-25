const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pdf = require("pdf-parse");

const ROOT_DIR = path.join(__dirname, "..");

const DOCUMENTS_FILE = path.join(
  ROOT_DIR,
  "data",
  "official_documents.json"
);

const MEASUREMENTS_FILE = path.join(
  ROOT_DIR,
  "data",
  "official_measurements.json"
);

const OUTPUT_FILE = path.join(
  ROOT_DIR,
  "data",
  "official_measurement_extractions.json"
);

const AUTHORITY =
  "Vas Vármegyei Kormányhivatal";

const USER_AGENT =
  "Koszeg-Asbestos-Monitor/1.1 (+GitHub Actions; public environmental monitoring)";


/* =========================================================
   ÁLTALÁNOS SEGÉDFÜGGVÉNYEK
   ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function loadJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) {
      return fallback;
    }

    return JSON.parse(
      fs.readFileSync(file, "utf8")
    );
  } catch (error) {
    console.warn(
      `Nem sikerült beolvasni: ${file}`
    );

    console.warn(error.message);

    return fallback;
  }
}

function saveJson(file, data) {
  fs.mkdirSync(
    path.dirname(file),
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

function normalizeWhitespace(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function normalizeInline(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(buffer) {
  return crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");
}


/* =========================================================
   PDF LETÖLTÉS
   ========================================================= */

async function downloadPdf(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept:
        "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  return {
    buffer:
      Buffer.from(arrayBuffer),

    finalUrl:
      response.url || url,

    contentType:
      response.headers.get(
        "content-type"
      ) || null
  };
}


/* =========================================================
   DÁTUMOK
   ========================================================= */

function normalizeDate(
  year,
  month,
  day
) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);

  if (
    !Number.isInteger(y) ||
    !Number.isInteger(m) ||
    !Number.isInteger(d)
  ) {
    return null;
  }

  if (
    y < 2000 ||
    y > 2100 ||
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > 31
  ) {
    return null;
  }

  return (
    `${String(y).padStart(4, "0")}-` +
    `${String(m).padStart(2, "0")}-` +
    `${String(d).padStart(2, "0")}`
  );
}

function extractDates(text) {
  const source =
    String(text || "");

  const results = [];
  const seen = new Set();

  const regex =
    /\b(20\d{2})\s*[.\-\/]\s*(\d{1,2})\s*[.\-\/]\s*(\d{1,2})\.?/g;

  let match;

  while (
    (match = regex.exec(source)) !== null
  ) {
    const normalized =
      normalizeDate(
        match[1],
        match[2],
        match[3]
      );

    if (
      normalized &&
      !seen.has(normalized)
    ) {
      seen.add(normalized);

      results.push({
        raw: match[0],
        date: normalized,
        index: match.index
      });
    }
  }

  return results;
}


/* =========================================================
   HELYSZÍNEK
   ========================================================= */

const KNOWN_LOCATIONS = [
  "Kőszeg",
  "Szombathely",
  "Sé",

  "Hermina utca",
  "Hermina út",

  "Borostyán Gyermekotthon",
  "Borostyánkő Gyermekotthon",

  "Oladi plató",
  "Oladi Plató",

  "Pocichter utca",
  "Vámház utca",
  "Rőtivölgyi utca"
];

function extractLocations(text) {
  const source =
    String(text || "");

  const lower =
    source.toLowerCase();

  const results = [];

  for (
    const location of KNOWN_LOCATIONS
  ) {
    const needle =
      location.toLowerCase();

    let start = 0;

    while (true) {
      const index =
        lower.indexOf(
          needle,
          start
        );

      if (index === -1) {
        break;
      }

      results.push({
        location,
        index
      });

      start =
        index + needle.length;
    }
  }

  return results;
}


/* =========================================================
   AZBESZTTÍPUSOK
   ========================================================= */

const ASBESTOS_TYPES = [
  "krizotil",
  "tremolit",
  "krokidolit",
  "amosit",
  "antofillit",
  "aktinolit"
];

function extractAsbestosTypes(text) {
  const source =
    String(text || "");

  const lower =
    source.toLowerCase();

  const found = [];

  for (
    const type of ASBESTOS_TYPES
  ) {
    if (
      lower.includes(type)
    ) {
      found.push(type);
    }
  }

  return [...new Set(found)];
}


/* =========================================================
   SZÁMÉRTÉK NORMALIZÁLÁS
   ========================================================= */

function parseNumericValue(raw) {
  if (!raw) {
    return null;
  }

  let value =
    String(raw)
      .replace(/\u00a0/g, " ")
      .trim();

  value =
    value.replace(/\s+/g, "");

  /*
   * 40.246 vagy 40,246
   * lehet ezres tagolás.
   */
  if (
    /^\d{1,3}(?:[.,]\d{3})+$/.test(
      value
    )
  ) {
    value =
      value.replace(/[.,]/g, "");
  } else {
    value =
      value.replace(",", ".");
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


/* =========================================================
   MÉRÉSI ÉRTÉKEK – SZIGORÚ FELISMERÉS
   ========================================================= */

function extractMeasurementValues(text) {
  const source =
    String(text || "");

  const results = [];

  /*
   * A PDF-konverzió miatt több whitespace-t
   * engedünk a szám és a mértékegység között.
   */

  const patterns = [
    {
      unit: "rost/m³",

      regex:
        /(\d{1,3}(?:[\s\u00a0.,]\d{3})+|\d+)[\s\n\r]*(?:rost(?:ok)?|szál(?:ak)?)[\s\n\r]*\/?[\s\n\r]*m(?:³|3)/gi
    },

    {
      unit: "fibres/m³",

      regex:
        /(\d{1,3}(?:[\s\u00a0.,]\d{3})+|\d+)[\s\n\r]*(?:fibres|fibers)[\s\n\r]*\/?[\s\n\r]*m(?:³|3)/gi
    }
  ];

  for (
    const pattern of patterns
  ) {
    let match;

    while (
      (match =
        pattern.regex.exec(source)) !==
      null
    ) {
      results.push({
        raw:
          normalizeInline(
            match[0]
          ),

        raw_value:
          match[1],

        value:
          parseNumericValue(
            match[1]
          ),

        unit:
          pattern.unit,

        index:
          match.index,

        detection_method:
          "strict_unit_match"
      });
    }
  }

  return results;
}


/* =========================================================
   SZÁZALÉKOK
   ========================================================= */

function extractPercentages(text) {
  const source =
    String(text || "");

  const results = [];

  const regex =
    /(\d+(?:[.,]\d+)?)\s*%/g;

  let match;

  while (
    (match = regex.exec(source)) !==
    null
  ) {
    const value =
      Number(
        match[1].replace(",", ".")
      );

    results.push({
      raw: match[0],

      value:
        Number.isFinite(value)
          ? value
          : null,

      unit: "%",

      index:
        match.index
    });
  }

  return results;
}


/* =========================================================
   GPS / KOORDINÁTÁK
   ========================================================= */

function extractCoordinateCandidates(
  text
) {
  const source =
    String(text || "");

  const results = [];

  const regex =
    /\b(4[6-8][.,]\d{3,8})\s*[,;/ ]+\s*(1[5-7][.,]\d{3,8})\b/g;

  let match;

  while (
    (match = regex.exec(source)) !==
    null
  ) {
    const lat =
      Number(
        match[1].replace(",", ".")
      );

    const lon =
      Number(
        match[2].replace(",", ".")
      );

    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon)
    ) {
      results.push({
        raw:
          match[0],

        lat,

        lon,

        index:
          match.index
      });
    }
  }

  return results;
}


/* =========================================================
   KONTEXTUS
   ========================================================= */

function getContext(
  text,
  index,
  radius = 350
) {
  const source =
    String(text || "");

  const start =
    Math.max(
      0,
      index - radius
    );

  const end =
    Math.min(
      source.length,
      index + radius
    );

  return normalizeInline(
    source.slice(start, end)
  );
}

function attachContexts(
  text,
  values
) {
  return values.map(
    (item) => ({
      ...item,

      context:
        getContext(
          text,
          item.index
        )
    })
  );
}


/* =========================================================
   ÚJ: DIAGNOSZTIKAI KULCSSZAVAK
   ========================================================= */

const DIAGNOSTIC_TERMS = [
  "rost",
  "rost/m",
  "azbesztrost",
  "azbeszt rost",
  "szálló azbeszt",
  "koncentráció",
  "koncentracio",
  "24 ór",
  "24 óra",
  "24h",
  "24 h",
  "fibres",
  "fibers",
  "fibre",
  "fiber",
  "asbestos",
  "asbest",
  "m³",
  "m3",
  "SEM",
  "elektronmikroszkóp",
  "elektronmikroszkop"
];


/* =========================================================
   ÚJ: DIAGNOSZTIKAI SZÖVEGRÉSZEK
   ========================================================= */

function extractDiagnosticContexts(
  text
) {
  const source =
    String(text || "");

  const lower =
    source.toLowerCase();

  const results = [];
  const seen = new Set();

  for (
    const term of DIAGNOSTIC_TERMS
  ) {
    const needle =
      term.toLowerCase();

    let start = 0;

    while (true) {
      const index =
        lower.indexOf(
          needle,
          start
        );

      if (index === -1) {
        break;
      }

      const context =
        getContext(
          source,
          index,
          500
        );

      /*
       * Ugyanazt a táblázatrészletet ne
       * mentsük el tízszer különböző
       * kulcsszavak miatt.
       */
      const signature =
        context
          .toLowerCase()
          .replace(/\s+/g, " ")
          .slice(0, 250);

      if (
        !seen.has(signature)
      ) {
        seen.add(signature);

        results.push({
          term,
          index,
          context
        });
      }

      /*
       * Dokumentumonként maximum 30
       * diagnosztikai részlet.
       */
      if (
        results.length >= 30
      ) {
        return results;
      }

      start =
        index + needle.length;
    }
  }

  return results;
}


/* =========================================================
   ÚJ: SZÁMJELÖLTEK A MÉRÉSI KONTEXTUSBAN
   ========================================================= */

function extractNumericCandidatesFromContext(
  context
) {
  const source =
    String(context || "");

  const results = [];

  /*
   * 40246
   * 40 246
   * 40.246
   * 40,246
   * 10300
   *
   * Itt MÉG NEM állítjuk, hogy ezek
   * mérési értékek.
   */

  const regex =
    /\b\d{1,3}(?:[ \u00a0.,]\d{3})+\b|\b\d{4,8}\b/g;

  let match;

  while (
    (match = regex.exec(source)) !==
    null
  ) {
    const raw =
      match[0];

    const value =
      parseNumericValue(raw);

    /*
     * Évszámok kiszűrése.
     */
    if (
      value >= 2000 &&
      value <= 2100 &&
      raw.length === 4
    ) {
      continue;
    }

    results.push({
      raw,
      value
    });
  }

  return results;
}


/* =========================================================
   ÚJ: DIAGNOSZTIKAI BLOKK FELÉPÍTÉSE
   ========================================================= */

function buildMeasurementDiagnostics(
  text
) {
  const contexts =
    extractDiagnosticContexts(
      text
    );

  return contexts.map(
    (item) => ({
      ...item,

      numeric_candidates:
        extractNumericCandidatesFromContext(
          item.context
        )
    })
  );
}


/* =========================================================
   PDF SZÖVEGKINYERÉS
   ========================================================= */

async function extractPdfText(buffer) {
  const result =
    await pdf(buffer);

  return {
    text:
      normalizeWhitespace(
        result.text || ""
      ),

    pages:
      Number.isFinite(
        result.numpages
      )
        ? result.numpages
        : null,

    info:
      result.info || null,

    metadata:
      result.metadata || null
  };
}


/* =========================================================
   EGY DOKUMENTUM FELDOLGOZÁSA
   ========================================================= */

async function processDocument(
  measurement,
  document
) {
  const startedAt =
    nowIso();

  const url =
    measurement.source_document;

  console.log(
    `PDF feldolgozás: ${measurement.source_title}`
  );

  try {
    const downloaded =
      await downloadPdf(url);

    const hash =
      sha256(
        downloaded.buffer
      );

    const pdfResult =
      await extractPdfText(
        downloaded.buffer
      );

    const text =
      pdfResult.text;

    const dates =
      attachContexts(
        text,
        extractDates(text)
      );

    const locations =
      attachContexts(
        text,
        extractLocations(text)
      );

    const measurements =
      attachContexts(
        text,
        extractMeasurementValues(
          text
        )
      );

    const percentages =
      attachContexts(
        text,
        extractPercentages(
          text
        )
      );

    const coordinates =
      attachContexts(
        text,
        extractCoordinateCandidates(
          text
        )
      );

    const asbestosTypes =
      extractAsbestosTypes(text);

    /*
     * ÚJ diagnosztikai blokk.
     *
     * Akkor is elkészül, ha a szigorú
     * measurement parser 0 értéket talál.
     */
    const measurementDiagnostics =
      buildMeasurementDiagnostics(
        text
      );

    return {
      id:
        measurement.id,

      source_class:
        "primary_official",

      authority:
        AUTHORITY,

      measurement_category:
        measurement
          .measurement_category,

      source_title:
        measurement.source_title,

      source_document:
        url,

      final_url:
        downloaded.finalUrl,

      publication_date:
        measurement
          .publication_date,

      document_sha256:
        hash,

      source_document_sha256:
        document?.sha256 || null,

      content_type:
        downloaded.contentType,

      pdf_pages:
        pdfResult.pages,

      pdf_text_extracted:
        text.length > 0,

      text_length:
        text.length,

      detected_dates:
        dates,

      detected_locations:
        locations,

      detected_measurement_values:
        measurements,

      detected_percentages:
        percentages,

      detected_coordinates:
        coordinates,

      detected_asbestos_types:
        asbestosTypes,

      /*
       * ÚJ:
       * a mérési kifejezések körüli
       * tényleges PDF-szöveg.
       */
      measurement_diagnostics:
        measurementDiagnostics,

      statistics: {
        dates:
          dates.length,

        locations:
          locations.length,

        measurement_values:
          measurements.length,

        percentages:
          percentages.length,

        coordinates:
          coordinates.length,

        asbestos_types:
          asbestosTypes.length,

        diagnostic_contexts:
          measurementDiagnostics.length
      },

      extraction_status:
        "success",

      extraction_started_at:
        startedAt,

      extracted_at:
        nowIso(),

      last_checked:
        nowIso(),

      /*
       * Diagnosztikai verzióban mindig
       * újrafeldolgozzuk a dokumentumot.
       */
      reused:
        false
    };

  } catch (error) {
    console.warn(
      `  ↳ HIBA: ${error.message}`
    );

    return {
      id:
        measurement.id,

      source_class:
        "primary_official",

      authority:
        AUTHORITY,

      measurement_category:
        measurement
          .measurement_category,

      source_title:
        measurement.source_title,

      source_document:
        url,

      publication_date:
        measurement
          .publication_date,

      document_sha256:
        document?.sha256 || null,

      pdf_text_extracted:
        false,

      detected_dates: [],

      detected_locations: [],

      detected_measurement_values: [],

      detected_percentages: [],

      detected_coordinates: [],

      detected_asbestos_types: [],

      measurement_diagnostics: [],

      statistics: {
        dates: 0,
        locations: 0,
        measurement_values: 0,
        percentages: 0,
        coordinates: 0,
        asbestos_types: 0,
        diagnostic_contexts: 0
      },

      extraction_status:
        "error",

      error:
        error.message,

      extraction_started_at:
        startedAt,

      last_checked:
        nowIso(),

      reused:
        false
    };
  }
}


/* =========================================================
   DIAGNOSZTIKA KIÍRÁSA A LOGBA
   ========================================================= */

function printDiagnostics(
  extraction
) {
  const diagnostics =
    extraction
      .measurement_diagnostics ||
    [];

  console.log(
    `  ↳ diagnosztikai részletek: ${diagnostics.length}`
  );

  if (
    diagnostics.length === 0
  ) {
    return;
  }

  /*
   * A GitHub logot nem akarjuk
   * több ezer sorosra növelni.
   *
   * Dokumentumonként maximum 5 részlet.
   */

  console.log("");
  console.log(
    "  --- MÉRÉSI DIAGNOSZTIKA ---"
  );

  for (
    const item of
      diagnostics.slice(0, 5)
  ) {
    console.log("");

    console.log(
      `  Kulcsszó: ${item.term}`
    );

    console.log(
      `  Kontextus: ${item.context}`
    );

    if (
      item.numeric_candidates
        ?.length
    ) {
      console.log(
        "  Számjelöltek:",
        item.numeric_candidates
          .slice(0, 20)
          .map(
            (candidate) =>
              `${candidate.raw} -> ${candidate.value}`
          )
          .join(" | ")
      );
    } else {
      console.log(
        "  Számjelöltek: nincs"
      );
    }
  }

  console.log("");
  console.log(
    "  --- DIAGNOSZTIKA VÉGE ---"
  );
}


/* =========================================================
   MAIN
   ========================================================= */

async function main() {
  console.log(
    "=========================================="
  );

  console.log(
    "HIVATALOS AZBESZT PDF ADATKINYERÉS"
  );

  console.log(
    "DIAGNOSZTIKAI VERZIÓ 1.1"
  );

  console.log(
    "=========================================="
  );


  const documents =
    loadJson(
      DOCUMENTS_FILE,
      {
        documents: []
      }
    );

  const measurementIndex =
    loadJson(
      MEASUREMENTS_FILE,
      {
        measurements: []
      }
    );


  if (
    !Array.isArray(
      measurementIndex.measurements
    )
  ) {
    throw new Error(
      "Az official_measurements.json measurements mezője hiányzik."
    );
  }


  const documentsByUrl =
    new Map();

  for (
    const document of
      documents.documents || []
  ) {
    if (document.url) {
      documentsByUrl.set(
        document.url,
        document
      );
    }
  }


  const extractions = [];

  let successCount = 0;
  let errorCount = 0;

  let totalMeasurementValues = 0;
  let totalCoordinates = 0;
  let totalDiagnostics = 0;

  const measurements =
    measurementIndex.measurements;


  console.log(
    `Feldolgozandó mérési dokumentumok: ${measurements.length}`
  );

  console.log("");


  for (
    let i = 0;
    i < measurements.length;
    i++
  ) {
    const measurement =
      measurements[i];

    console.log(
      `[${i + 1}/${measurements.length}] ${measurement.source_title}`
    );

    const document =
      documentsByUrl.get(
        measurement.source_document
      );

    const extraction =
      await processDocument(
        measurement,
        document
      );

    extractions.push(
      extraction
    );


    if (
      extraction.extraction_status ===
      "success"
    ) {
      successCount++;
    } else {
      errorCount++;
    }


    totalMeasurementValues +=
      extraction.statistics
        ?.measurement_values || 0;

    totalCoordinates +=
      extraction.statistics
        ?.coordinates || 0;

    totalDiagnostics +=
      extraction.statistics
        ?.diagnostic_contexts || 0;


    console.log(
      `  ↳ mérési értékek: ${
        extraction.statistics
          ?.measurement_values || 0
      }`
    );

    console.log(
      `  ↳ koordináták: ${
        extraction.statistics
          ?.coordinates || 0
      }`
    );

    console.log(
      `  ↳ azbeszttípusok: ${
        (
          extraction
            .detected_asbestos_types ||
          []
        ).join(", ") || "nincs"
      }`
    );


    /*
     * A levegőméréseknél különösen
     * fontos a diagnosztika.
     */
    if (
      measurement
        .measurement_category ===
      "air"
    ) {
      printDiagnostics(
        extraction
      );
    }


    console.log("");
  }


  const output = {
    schema_version:
      "1.1",

    generated_at:
      nowIso(),

    mode:
      "measurement_diagnostics",

    source_class:
      "primary_official",

    authority:
      AUTHORITY,

    source_documents_file:
      "data/official_documents.json",

    measurement_index_file:
      "data/official_measurements.json",

    statistics: {
      total_documents:
        measurements.length,

      successful_extractions:
        successCount,

      failed_extractions:
        errorCount,

      reused_extractions:
        0,

      detected_measurement_values:
        totalMeasurementValues,

      detected_coordinates:
        totalCoordinates,

      diagnostic_contexts:
        totalDiagnostics
    },

    extractions
  };


  saveJson(
    OUTPUT_FILE,
    output
  );


  console.log("");
  console.log(
    "=========================================="
  );

  console.log(
    "PDF ADATKINYERÉS KÉSZ"
  );

  console.log(
    "=========================================="
  );

  console.log(
    `Dokumentumok: ${measurements.length}`
  );

  console.log(
    `Sikeres: ${successCount}`
  );

  console.log(
    `Hibás: ${errorCount}`
  );

  console.log(
    `Talált mérési értékek: ${totalMeasurementValues}`
  );

  console.log(
    `Talált koordináták: ${totalCoordinates}`
  );

  console.log(
    `Diagnosztikai szövegrészletek: ${totalDiagnostics}`
  );

  console.log(
    `Mentve: ${OUTPUT_FILE}`
  );

  console.log(
    "=========================================="
  );
}


main().catch(
  (error) => {
    console.error(
      "Végzetes PDF-feldolgozási hiba:",
      error
    );

    process.exitCode = 1;
  }
);
