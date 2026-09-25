const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const pdf = require("pdf-parse");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

const INPUT_FILE = path.join(
  DATA_DIR,
  "official_measurements.json"
);

const EXTRACTION_FILE = path.join(
  DATA_DIR,
  "official_measurement_extractions.json"
);

const AIR_OUTPUT_FILE = path.join(
  DATA_DIR,
  "official_air_measurements.json"
);

const AUTHORITY =
  "Vas Vármegyei Kormányhivatal";

const USER_AGENT =
  "Koszeg-Asbestos-Monitor/2.1 (+GitHub Actions)";


/* =========================================================
   SEGÉDFÜGGVÉNYEK
   ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/rost\s*\/\s*m\s*[³3]/gi, "rost/m3")
    .replace(/rost\s*\/\s*cm\s*[³3]/gi, "rost/cm3")
    .trim();
}

function inline(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function sha256(buffer) {
  return crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");
}

function parseNumber(raw) {
  if (
    raw === null ||
    raw === undefined
  ) {
    return null;
  }

  let value = String(raw)
    .replace(/\u00a0/g, " ")
    .replace(/[<>*]/g, "")
    .trim();

  /*
   * szóközös ezres tagolás
   * 7 700 -> 7700
   */
  value = value.replace(/\s+/g, "");

  /*
   * Magyar tizedesjel
   */
  if (
    /^\d+,\d+$/.test(value)
  ) {
    value = value.replace(",", ".");
  }

  /*
   * 7.700 lehet ezres tagolás.
   */
  if (
    /^\d{1,3}(?:\.\d{3})+$/.test(value)
  ) {
    value = value.replace(/\./g, "");
  }

  const number = Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}

function uniqueBy(items, keyFunction) {
  const seen = new Set();

  return items.filter((item) => {
    const key = keyFunction(item);

    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
}


/* =========================================================
   PDF LETÖLTÉS
   ========================================================= */

async function downloadPdf(url) {
  if (!url) {
    throw new Error(
      "A source_document mező hiányzik."
    );
  }

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
      `PDF letöltési hiba: HTTP ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  return {
    buffer,
    finalUrl: response.url || url,
    contentType:
      response.headers.get(
        "content-type"
      ) || null
  };
}


/* =========================================================
   AZBESZTTÍPUSOK
   ========================================================= */

function detectAsbestosTypes(text) {
  const lower =
    String(text).toLowerCase();

  const definitions = [
    ["krizotil", ["krizotil", "chrysotile"]],
    ["tremolit", ["tremolit", "tremolite"]],
    ["aktinolit", ["aktinolit", "actinolite"]],
    ["amozit", ["amozit", "amosite"]],
    ["krokidolit", ["krokidolit", "crocidolite"]],
    ["antofillit", ["antofillit", "anthophyllite"]]
  ];

  const result = [];

  for (
    const [canonical, aliases]
    of definitions
  ) {
    if (
      aliases.some(
        (alias) =>
          lower.includes(alias)
      )
    ) {
      result.push(canonical);
    }
  }

  return result;
}


/* =========================================================
   KOORDINÁTÁK
   ========================================================= */

function extractCoordinates(text) {
  const results = [];

  const regex =
    /\b(4[6-8][.,]\d{3,8})\s*[,;/ ]+\s*(1[5-7][.,]\d{3,8})\b/g;

  let match;

  while (
    (match = regex.exec(text)) !== null
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
        lat,
        lon,
        index: match.index,
        raw: match[0]
      });
    }
  }

  return results;
}


/* =========================================================
   MINTAAZONOSÍTÓK
   ========================================================= */

function findSamplePositions(text) {
  /*
   * Példák:
   *
   * 2026_792_6_L/1_1
   * 2026_792_5_L/3_8
   */

  const regex =
    /\b20\d{2}_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_L\/\d+_\d+\b/g;

  const results = [];

  let match;

  while (
    (match = regex.exec(text)) !== null
  ) {
    results.push({
      sampleId: match[0],
      index: match.index
    });
  }

  return results;
}


function splitIntoSampleBlocks(text) {
  const positions =
    findSamplePositions(text);

  if (!positions.length) {
    return [];
  }

  const blocks = [];

  for (
    let i = 0;
    i < positions.length;
    i++
  ) {
    const current =
      positions[i];

    const nextIndex =
      i + 1 < positions.length
        ? positions[i + 1].index
        : text.length;

    blocks.push({
      sampleId:
        current.sampleId,

      text:
        text
          .slice(
            current.index,
            nextIndex
          )
          .trim()
    });
  }

  return blocks;
}


/* =========================================================
   GPS EGY MINTABLOKKBÓL
   ========================================================= */

function extractGpsFromBlock(block) {
  /*
   * Több lehetséges alakot támogatunk.
   */

  const patterns = [
    /GPS[- ]?koordináták[^0-9]*(4[6-8][.,]\d{3,8})\s*[,;/ ]+\s*(1[5-7][.,]\d{3,8})/i,

    /\b(4[6-8][.,]\d{3,8})\s*[,;/ ]+\s*(1[5-7][.,]\d{3,8})\b/
  ];

  for (
    const regex of patterns
  ) {
    const match =
      block.match(regex);

    if (match) {
      return {
        lat:
          Number(
            match[1]
              .replace(",", ".")
          ),

        lon:
          Number(
            match[2]
              .replace(",", ".")
          )
      };
    }
  }

  return null;
}


/* =========================================================
   DÁTUM ÉS IDŐ
   ========================================================= */

function extractDateTimes(block) {
  const dateRegex =
    /\b(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})\.?/g;

  const timeRegex =
    /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;

  const dates = [];
  const times = [];

  let match;

  while (
    (match = dateRegex.exec(block)) !== null
  ) {
    dates.push(
      `${match[1]}-${String(
        match[2]
      ).padStart(2, "0")}-${String(
        match[3]
      ).padStart(2, "0")}`
    );
  }

  while (
    (match = timeRegex.exec(block)) !== null
  ) {
    times.push(
      `${String(
        match[1]
      ).padStart(2, "0")}:${match[2]}`
    );
  }

  let start = null;
  let end = null;

  if (
    dates.length >= 2 &&
    times.length >= 2
  ) {
    start =
      `${dates[0]} ${times[0]}`;

    end =
      `${dates[1]} ${times[1]}`;
  } else if (
    dates.length >= 1 &&
    times.length >= 2
  ) {
    start =
      `${dates[0]} ${times[0]}`;

    end =
      `${dates[0]} ${times[1]}`;
  }

  return {
    dates,
    times,
    start,
    end
  };
}


/* =========================================================
   HELYSZÍN
   ========================================================= */

function extractLocationFromBlock(
  block,
  sampleId
) {
  let source =
    String(block);

  const sampleIndex =
    source.indexOf(sampleId);

  if (sampleIndex !== -1) {
    source =
      source.slice(
        sampleIndex +
        sampleId.length
      );
  }

  /*
   * GPS előtt található szöveg
   * jó helyszínjelölt.
   */

  const gpsIndex =
    source.search(
      /GPS[- ]?koordináták/i
    );

  if (
    gpsIndex > 0 &&
    gpsIndex < 500
  ) {
    const candidate =
      inline(
        source.slice(
          0,
          gpsIndex
        )
      )
        .replace(
          /^[\s:;,\-]+/,
          ""
        )
        .replace(
          /[\s:;,\-]+$/,
          ""
        );

    if (
      candidate.length >= 3 &&
      candidate.length <= 300
    ) {
      return candidate;
    }
  }

  return null;
}


/* =========================================================
   RÉGI LEVEGŐMÉRÉSI FORMÁTUM
   ========================================================= */

function extractLegacyConcentration(block) {
  /*
   * Példa:
   *
   * 0,0077 (7700 rost/m3)
   */

  const regex =
    /([<>]?\s*\d+[.,]\d+)\s*\(\s*([\d\s.,]+)\s*rost\/m3\s*\)/i;

  const match =
    block.match(regex);

  if (!match) {
    return null;
  }

  const cm3Raw =
    match[1];

  const m3Raw =
    match[2];

  return {
    concentration_fibres_cm3:
      parseNumber(cm3Raw),

    concentration_fibres_m3:
      parseNumber(m3Raw),

    below_detection_limit:
      cm3Raw.includes("<"),

    source_format:
      "legacy_cm3_with_m3",

    raw:
      match[0]
  };
}


/* =========================================================
   ÚJ LEVEGŐMÉRÉSI FORMÁTUM
   ========================================================= */

function extractModernConcentration(block) {
  /*
   * Az új dokumentumban a mértékegység
   * a táblázat fejlécében található,
   * ezért a mintasor végén csak a szám áll.
   *
   * Elsőként a "Környezeti levegő vizsgálat"
   * után keresünk.
   */

  const markerRegex =
    /Környezeti\s+levegő\s+vizsgálat/i;

  const marker =
    markerRegex.exec(block);

  if (marker) {
    const after =
      block.slice(
        marker.index +
        marker[0].length
      );

    /*
     * A következő rövid tartományból
     * vesszük az első koncentrációjelöltet.
     */

    const candidate =
      after
        .slice(0, 250)
        .match(
          /(?:^|[\s\n])(<\s*)?(\d{1,6})(?:[.,](\d+))?(?=$|[\s\n])/m
        );

    if (candidate) {
      const raw =
        `${candidate[1] || ""}${candidate[2]}${
          candidate[3]
            ? "," + candidate[3]
            : ""
        }`;

      const value =
        parseNumber(raw);

      if (
        value !== null &&
        value >= 0 &&
        value <= 10000000
      ) {
        return {
          concentration_fibres_m3:
            value,

          concentration_fibres_cm3:
            null,

          below_detection_limit:
            Boolean(candidate[1]),

          source_format:
            "modern_table_m3",

          raw
        };
      }
    }
  }

  return null;
}


/* =========================================================
   FALLBACK – ROST/M3 KÖZVETLENÜL
   ========================================================= */

function extractDirectM3(block) {
  const regex =
    /([<>]?\s*\d{1,3}(?:[\s.,]\d{3})*|[<>]?\s*\d+)\s*rost\/m3/i;

  const match =
    block.match(regex);

  if (!match) {
    return null;
  }

  return {
    concentration_fibres_m3:
      parseNumber(match[1]),

    concentration_fibres_cm3:
      null,

    below_detection_limit:
      match[1].includes("<"),

    source_format:
      "direct_m3",

    raw:
      match[0]
  };
}


/* =========================================================
   TÉRFOGATÁRAM
   ========================================================= */

function extractFlowRate(block) {
  const marker =
    block.search(
      /Környezeti\s+levegő\s+vizsgálat/i
    );

  if (marker === -1) {
    return null;
  }

  const before =
    block.slice(
      Math.max(
        0,
        marker - 500
      ),
      marker
    );

  const regex =
    /\b(\d{1,2}[.,]\d{1,3})\b/g;

  const values = [];

  let match;

  while (
    (match = regex.exec(before)) !== null
  ) {
    const value =
      parseNumber(match[1]);

    if (
      value !== null &&
      value >= 5 &&
      value <= 15
    ) {
      values.push(value);
    }
  }

  if (!values.length) {
    return null;
  }

  return values[
    values.length - 1
  ];
}


/* =========================================================
   DOKUMENTUM M3 FORMÁTUM FELISMERÉS
   ========================================================= */

function documentUsesM3(text) {
  return (
    /Koncentr\w*\s*\([^)]*rost\/m3/i.test(
      text
    ) ||
    /rost\/m3/i.test(text)
  );
}


/* =========================================================
   MINTA FELDOLGOZÁSA
   ========================================================= */

function parseAirSample(
  blockData,
  document,
  fullText
) {
  const block =
    blockData.text;

  const sampleId =
    blockData.sampleId;

  const gps =
    extractGpsFromBlock(
      block
    );

  const dateTimes =
    extractDateTimes(
      block
    );

  const location =
    extractLocationFromBlock(
      block,
      sampleId
    );

  let concentration =
    extractLegacyConcentration(
      block
    );

  if (
    !concentration &&
    documentUsesM3(fullText)
  ) {
    concentration =
      extractModernConcentration(
        block
      );
  }

  if (!concentration) {
    concentration =
      extractDirectM3(
        block
      );
  }

  /*
   * Ha nincs koncentráció,
   * nem készítünk mérési rekordot.
   */

  if (!concentration) {
    return null;
  }

  return {
    sample_id:
      sampleId,

    measurement_category:
      "air",

    location,

    lat:
      gps?.lat ?? null,

    lon:
      gps?.lon ?? null,

    start:
      dateTimes.start,

    end:
      dateTimes.end,

    flow_rate_l_min:
      extractFlowRate(
        block
      ),

    concentration_fibres_m3:
      concentration
        .concentration_fibres_m3,

    concentration_fibres_cm3:
      concentration
        .concentration_fibres_cm3,

    below_detection_limit:
      concentration
        .below_detection_limit,

    source_format:
      concentration
        .source_format,

    raw_concentration:
      concentration.raw,

    source_title:
      document.source_title,

    publication_date:
      document.publication_date,

    source_document:
      document.source_document,

    source_class:
      "primary_official",

    authority:
      AUTHORITY
  };
}


/* =========================================================
   LEVEGŐMÉRÉSEK KINYERÉSE
   ========================================================= */

function extractAirMeasurements(
  text,
  document
) {
  if (
    document
      .measurement_category !==
    "air"
  ) {
    return [];
  }

  const blocks =
    splitIntoSampleBlocks(
      text
    );

  const results = [];

  for (
    const block of blocks
  ) {
    const parsed =
      parseAirSample(
        block,
        document,
        text
      );

    if (parsed) {
      results.push(parsed);
    }
  }

  return uniqueBy(
    results,
    (item) =>
      [
        item.source_document,
        item.sample_id,
        item.concentration_fibres_m3
      ].join("|")
  );
}


/* =========================================================
   DOKUMENTUM FELDOLGOZÁSA
   ========================================================= */

async function processDocument(
  document
) {
  const url =
    document.source_document;

  const downloaded =
    await downloadPdf(url);

  const pdfResult =
    await pdf(
      downloaded.buffer
    );

  const text =
    normalizeText(
      pdfResult.text || ""
    );

  const coordinates =
    extractCoordinates(
      text
    );

  const asbestosTypes =
    detectAsbestosTypes(
      text
    );

  const airMeasurements =
    extractAirMeasurements(
      text,
      document
    );

  return {
    id:
      document.id,

    source_title:
      document.source_title,

    source_document:
      document.source_document,

    publication_date:
      document.publication_date,

    measurement_category:
      document.measurement_category,

    source_class:
      "primary_official",

    authority:
      AUTHORITY,

    final_url:
      downloaded.finalUrl,

    content_type:
      downloaded.contentType,

    document_sha256:
      sha256(
        downloaded.buffer
      ),

    pdf_pages:
      pdfResult.numpages || null,

    text_length:
      text.length,

    detected_coordinates:
      coordinates,

    detected_asbestos_types:
      asbestosTypes,

    air_measurements:
      airMeasurements,

    statistics: {
      coordinates:
        coordinates.length,

      asbestos_types:
        asbestosTypes.length,

      structured_air_measurements:
        airMeasurements.length
    },

    extraction_status:
      "success",

    extracted_at:
      nowIso()
  };
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
    "STRUKTURÁLT LEVEGŐMÉRÉSEK – V2.1"
  );

  console.log(
    "=========================================="
  );


  if (
    !fs.existsSync(INPUT_FILE)
  ) {
    throw new Error(
      `Hiányzó fájl: ${INPUT_FILE}`
    );
  }


  const input =
    JSON.parse(
      fs.readFileSync(
        INPUT_FILE,
        "utf8"
      )
    );


  /*
   * FONTOS:
   * A meglévő adatstruktúránk:
   *
   * {
   *   measurements: [...]
   * }
   */

  const documents =
    Array.isArray(
      input.measurements
    )
      ? input.measurements
      : [];


  if (!documents.length) {
    throw new Error(
      "Az official_measurements.json measurements tömbje üres vagy hiányzik."
    );
  }


  console.log(
    `Feldolgozandó mérési dokumentumok: ${documents.length}`
  );

  console.log("");


  const extractions = [];
  const allAirMeasurements = [];

  let success = 0;
  let failed = 0;


  for (
    let i = 0;
    i < documents.length;
    i++
  ) {
    const document =
      documents[i];

    console.log(
      `[${i + 1}/${documents.length}] ${document.source_title}`
    );

    console.log(
      `  URL: ${document.source_document}`
    );


    try {
      const result =
        await processDocument(
          document
        );

      extractions.push(
        result
      );

      allAirMeasurements.push(
        ...result.air_measurements
      );

      success++;


      console.log(
        `  ↳ kategória: ${document.measurement_category}`
      );

      console.log(
        `  ↳ PDF oldalak: ${result.pdf_pages}`
      );

      console.log(
        `  ↳ koordináták: ${result.statistics.coordinates}`
      );

      console.log(
        `  ↳ strukturált levegőmérések: ${result.statistics.structured_air_measurements}`
      );


      if (
        result.air_measurements.length
      ) {
        for (
          const measurement
          of result.air_measurements
        ) {
          console.log(
            `     ${measurement.sample_id}: ` +
            `${measurement.concentration_fibres_m3} rost/m3` +
            `${
              measurement.lat &&
              measurement.lon
                ? ` | ${measurement.lat}, ${measurement.lon}`
                : ""
            }`
          );
        }
      }


      if (
        result
          .detected_asbestos_types
          .length
      ) {
        console.log(
          `  ↳ azbeszttípusok: ${result.detected_asbestos_types.join(", ")}`
        );
      }

    } catch (error) {
      failed++;

      console.error(
        `  ✗ HIBA: ${error.message}`
      );

      extractions.push({
        id:
          document.id,

        source_title:
          document.source_title,

        source_document:
          document.source_document,

        publication_date:
          document.publication_date,

        measurement_category:
          document.measurement_category,

        extraction_status:
          "error",

        error:
          error.message
      });
    }

    console.log("");
  }


  /* =======================================================
     DUPLIKÁCIÓK
     ======================================================= */

  const uniqueAirMeasurements =
    uniqueBy(
      allAirMeasurements,
      (item) =>
        [
          item.source_document,
          item.sample_id,
          item.concentration_fibres_m3
        ].join("|")
    );


  /* =======================================================
     EXTRACTION OUTPUT
     ======================================================= */

  const extractionOutput = {
    schema_version:
      "2.1",

    generated_at:
      nowIso(),

    source_class:
      "primary_official",

    authority:
      AUTHORITY,

    statistics: {
      total_documents:
        documents.length,

      successful_extractions:
        success,

      failed_extractions:
        failed,

      structured_air_measurements:
        uniqueAirMeasurements.length
    },

    extractions
  };


  fs.writeFileSync(
    EXTRACTION_FILE,
    JSON.stringify(
      extractionOutput,
      null,
      2
    ),
    "utf8"
  );


  /* =======================================================
     TISZTA LEVEGŐMÉRÉSI ADATBÁZIS
     ======================================================= */

  const airOutput = {
    schema_version:
      "1.0",

    generated_at:
      nowIso(),

    source_class:
      "primary_official",

    authority:
      AUTHORITY,

    unit:
      "rost/m3",

    measurement_count:
      uniqueAirMeasurements.length,

    measurements:
      uniqueAirMeasurements
  };


  fs.writeFileSync(
    AIR_OUTPUT_FILE,
    JSON.stringify(
      airOutput,
      null,
      2
    ),
    "utf8"
  );


  /* =======================================================
     ÖSSZEGZÉS
     ======================================================= */

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
    `Dokumentumok: ${documents.length}`
  );

  console.log(
    `Sikeres: ${success}`
  );

  console.log(
    `Hibás: ${failed}`
  );

  console.log(
    `Strukturált levegőmérések: ${uniqueAirMeasurements.length}`
  );

  console.log("");

  console.log(
    `Mentve: ${EXTRACTION_FILE}`
  );

  console.log(
    `Mentve: ${AIR_OUTPUT_FILE}`
  );

  console.log(
    "=========================================="
  );


  /*
   * Csak akkor állunk le hibával,
   * ha egyetlen PDF-et sem sikerült
   * feldolgozni.
   */

  if (
    success === 0
  ) {
    process.exitCode = 2;
  }
}


main().catch(
  (error) => {
    console.error("");
    console.error(
      "VÉGZETES HIBA:"
    );

    console.error(error);

    process.exit(1);
  }
);
