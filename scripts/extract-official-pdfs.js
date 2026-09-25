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
  "Koszeg-Asbestos-Monitor/1.0 (+GitHub Actions; public environmental monitoring)";


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
   DÁTUMOK FELISMERÉSE
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

  /*
   * 2026. 08. 12.
   * 2026.08.12
   * 2026-08-12
   * 2026/08/12
   */
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

/*
 * Ez nem mérési adat.
 *
 * Csak ismert helynevek felismerésére szolgáló
 * szótár. A tényleges mérési kapcsolatot később
 * a szövegkörnyezet alapján állapítjuk meg.
 */

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
   MÉRÉSI ÉRTÉKEK
   ========================================================= */

function parseHungarianInteger(raw) {
  if (!raw) {
    return null;
  }

  let value =
    String(raw)
      .replace(/\u00a0/g, " ")
      .trim();

  /*
   * 40 246
   * 76 254
   */
  value =
    value.replace(/\s+/g, "");

  /*
   * 40.246 / 40,246 esetén
   * valószínű ezres tagolás.
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

function extractMeasurementValues(text) {
  const source =
    String(text || "");

  const results = [];

  /*
   * Első körben az azbeszt szempontjából
   * legfontosabb rost/m³ értékeket keressük.
   */

  const patterns = [
    {
      unit: "rost/m³",

      regex:
        /(\d{1,3}(?:[\s\u00a0.,]\d{3})+|\d+)\s*(?:rost|szál)\s*\/\s*m(?:³|3)/gi
    },

    {
      unit: "fibres/m³",

      regex:
        /(\d{1,3}(?:[\s\u00a0.,]\d{3})+|\d+)\s*(?:fibres|fibers)\s*\/\s*m(?:³|3)/gi
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
          match[0],

        raw_value:
          match[1],

        value:
          parseHungarianInteger(
            match[1]
          ),

        unit:
          pattern.unit,

        index:
          match.index
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
      index: match.index
    });
  }

  return results;
}


/* =========================================================
   GPS / KOORDINÁTA JELÖLTEK
   ========================================================= */

function extractCoordinateCandidates(
  text
) {
  const source =
    String(text || "");

  const results = [];

  /*
   * Egyszerű WGS84 jelöltek:
   * 47.389123, 16.541234
   * 47,389123 16,541234
   *
   * Csak Vas vármegye környezetére életszerű
   * koordinátákat engedünk át.
   */

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
        raw: match[0],
        lat,
        lon,
        index: match.index
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

  return normalizeWhitespace(
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
  document,
  previousExtraction
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

    /*
     * Ha a PDF hash-e nem változott és
     * korábban már sikeresen feldolgoztuk,
     * felhasználhatjuk a korábbi eredményt.
     */

    if (
      previousExtraction &&
      previousExtraction
        .document_sha256 === hash &&
      previousExtraction
        .extraction_status ===
        "success"
    ) {
      console.log(
        "  ↳ változatlan dokumentum, korábbi kinyerés megtartva"
      );

      return {
        ...previousExtraction,

        last_checked:
          nowIso(),

        reused:
          true
      };
    }

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

      /*
       * A teljes PDF-szöveget szándékosan
       * nem mentjük a repóba.
       *
       * Csak a releváns találatokhoz
       * tartozó rövid kontextust őrizzük.
       */

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
          asbestosTypes.length
      },

      extraction_status:
        "success",

      extraction_started_at:
        startedAt,

      extracted_at:
        nowIso(),

      last_checked:
        nowIso(),

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
    "=========================================="
  );


  /* -------------------------------------------------------
     Forrásfájlok
     ------------------------------------------------------- */

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

  const previous =
    loadJson(
      OUTPUT_FILE,
      {
        extractions: []
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


  /* -------------------------------------------------------
     Korábbi feldolgozás index
     ------------------------------------------------------- */

  const previousByUrl =
    new Map();

  for (
    const item of
      previous.extractions || []
  ) {
    if (
      item.source_document
    ) {
      previousByUrl.set(
        item.source_document,
        item
      );
    }
  }


  /* -------------------------------------------------------
     Dokumentum metaadat index
     ------------------------------------------------------- */

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


  /* -------------------------------------------------------
     Feldolgozás
     ------------------------------------------------------- */

  const extractions = [];

  let successCount = 0;
  let errorCount = 0;
  let reusedCount = 0;

  let totalMeasurementValues = 0;
  let totalCoordinates = 0;

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

    const previousExtraction =
      previousByUrl.get(
        measurement.source_document
      );

    const extraction =
      await processDocument(
        measurement,
        document,
        previousExtraction
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

    if (
      extraction.reused
    ) {
      reusedCount++;
    }

    totalMeasurementValues +=
      extraction.statistics
        ?.measurement_values || 0;

    totalCoordinates +=
      extraction.statistics
        ?.coordinates || 0;

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
  }


  /* -------------------------------------------------------
     Kimenet
     ------------------------------------------------------- */

  const output = {
    schema_version:
      "1.0",

    generated_at:
      nowIso(),

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
        reusedCount,

      detected_measurement_values:
        totalMeasurementValues,

      detected_coordinates:
        totalCoordinates
    },

    extractions
  };

  saveJson(
    OUTPUT_FILE,
    output
  );


  /* -------------------------------------------------------
     Konzol összegzés
     ------------------------------------------------------- */

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
    `Cache-ből megtartva: ${reusedCount}`
  );

  console.log(
    `Talált mérési értékek: ${totalMeasurementValues}`
  );

  console.log(
    `Talált koordináták: ${totalCoordinates}`
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
