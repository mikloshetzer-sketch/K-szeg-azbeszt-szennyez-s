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

const AUTHORITY = "Vas Vármegyei Kormányhivatal";

const USER_AGENT =
  "Koszeg-Asbestos-Monitor/3.0 (+GitHub Actions)";

/* =========================================================
   ALAP SEGÉDFÜGGVÉNYEK
   ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function sha256(buffer) {
  return crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");
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

function parseNumber(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }

  let value = String(raw)
    .replace(/\u00a0/g, " ")
    .replace(/[<>*]/g, "")
    .trim();

  value = value.replace(/\s+/g, "");

  if (/^\d+,\d+$/.test(value)) {
    value = value.replace(",", ".");
  } else if (/^\d{1,3}(?:[.,]\d{3})+$/.test(value)) {
    value = value.replace(/[.,]/g, "");
  } else {
    value = value.replace(",", ".");
  }

  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();

  return items.filter((item) => {
    const key = keyFn(item);

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
    throw new Error("Hiányzó source_document URL.");
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

  return {
    buffer: Buffer.from(
      await response.arrayBuffer()
    ),

    finalUrl:
      response.url || url,

    contentType:
      response.headers.get("content-type") || null
  };
}

/* =========================================================
   AZBESZTTÍPUSOK
   ========================================================= */

function detectAsbestosTypes(text) {
  const lower = text.toLowerCase();

  const definitions = [
    ["krizotil", ["krizotil", "chrysotile"]],
    ["tremolit", ["tremolit", "tremolite"]],
    ["aktinolit", ["aktinolit", "actinolite"]],
    ["amozit", ["amozit", "amosite"]],
    ["krokidolit", ["krokidolit", "crocidolite"]],
    ["antofillit", ["antofillit", "anthophyllite"]]
  ];

  const result = [];

  for (const [name, aliases] of definitions) {
    if (
      aliases.some(
        (alias) => lower.includes(alias)
      )
    ) {
      result.push(name);
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

  while ((match = regex.exec(text)) !== null) {
    const lat =
      Number(match[1].replace(",", "."));

    const lon =
      Number(match[2].replace(",", "."));

    if (
      Number.isFinite(lat) &&
      Number.isFinite(lon)
    ) {
      results.push({
        lat,
        lon,
        index: match.index
      });
    }
  }

  return results;
}

/* =========================================================
   MINTAAZONOSÍTÓ
   ========================================================= */

function findSamplePositions(text) {
  const regex =
    /\b20\d{2}_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_L\/\d+_\d+\b/g;

  const results = [];

  let match;

  while ((match = regex.exec(text)) !== null) {
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

  const blocks = [];

  for (let i = 0; i < positions.length; i++) {
    const current = positions[i];

    const next =
      i + 1 < positions.length
        ? positions[i + 1].index
        : text.length;

    blocks.push({
      sampleId:
        current.sampleId,

      text:
        text
          .slice(current.index, next)
          .trim()
    });
  }

  return blocks;
}

/* =========================================================
   GPS
   ========================================================= */

function extractGps(block) {
  const match =
    block.match(
      /\b(4[6-8][.,]\d{3,8})\s*[,;/ ]+\s*(1[5-7][.,]\d{3,8})\b/
    );

  if (!match) {
    return null;
  }

  return {
    lat:
      Number(match[1].replace(",", ".")),

    lon:
      Number(match[2].replace(",", "."))
  };
}

/* =========================================================
   HELYSZÍN
   ========================================================= */

function extractLocation(block, sampleId) {
  let source = block;

  const position =
    source.indexOf(sampleId);

  if (position !== -1) {
    source =
      source.slice(
        position + sampleId.length
      );
  }

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
        source.slice(0, gpsIndex)
      )
        .replace(/^[,;:\-\s]+/, "")
        .replace(/[,;:\-\s]+$/, "");

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
   DÁTUM / IDŐ
   ========================================================= */

function extractDateTimes(block) {
  const dates = [];

  const times = [];

  let match;

  const dateRegex =
    /\b(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})\.?/g;

  while (
    (match = dateRegex.exec(block)) !== null
  ) {
    dates.push(
      `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`
    );
  }

  const timeRegex =
    /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;

  while (
    (match = timeRegex.exec(block)) !== null
  ) {
    times.push(
      `${String(match[1]).padStart(2, "0")}:${match[2]}`
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
    start,
    end
  };
}

/* =========================================================
   RÉGI FORMÁTUM
   ========================================================= */

function extractLegacyMeasurement(block) {
  /*
   * Csak olyan értéket fogadunk el,
   * ahol a PDF maga összekapcsolja:
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

  const cm3 =
    parseNumber(match[1]);

  const m3 =
    parseNumber(match[2]);

  if (
    cm3 === null ||
    m3 === null
  ) {
    return null;
  }

  return {
    concentration_fibres_cm3:
      cm3,

    concentration_fibres_m3:
      m3,

    below_detection_limit:
      match[1].includes("<"),

    parser:
      "explicit_legacy_pair",

    confidence:
      "high",

    raw:
      inline(match[0])
  };
}

/* =========================================================
   MODERN TÁBLÁZAT

   FONTOS:
   Nem keresünk egyszerűen egy számot a
   "Környezeti levegő vizsgálat" után.

   Csak olyan blokkot fogadunk el, amelyben:
   - van mintaazonosító
   - van GPS
   - van levegővizsgálati jelölés
   - a dokumentumban létezik koncentráció fejléc
   ========================================================= */

function hasModernConcentrationHeader(fullText) {
  return (
    /Koncentr[^()\n]{0,30}\(\s*rost\/m3\s*\)/i.test(
      fullText
    ) ||
    /Koncentr[^()\n]{0,30}rost\/m3/i.test(
      fullText
    )
  );
}

/* =========================================================
   MODERN SOR SZÁMÉRTÉKEI
   ========================================================= */

function getModernNumericTail(block) {
  const marker =
    block.search(
      /Környezeti\s+levegő\s+vizsgálat/i
    );

  if (marker === -1) {
    return [];
  }

  const tail =
    block.slice(marker);

  /*
   * Szándékosan csak korlátozott tartomány.
   * Így kisebb eséllyel csúszunk át egy
   * következő táblázatra vagy összesítő mezőre.
   */

  const limited =
    tail.slice(0, 400);

  const results = [];

  const regex =
    /(?:^|\s)(<\s*)?(\d+(?:[.,]\d+)?)(?=\s|$)/g;

  let match;

  while (
    (match = regex.exec(limited)) !== null
  ) {
    const value =
      parseNumber(match[2]);

    if (value === null) {
      continue;
    }

    results.push({
      raw:
        `${match[1] || ""}${match[2]}`,

      value,

      below:
        Boolean(match[1]),

      index:
        match.index
    });
  }

  return results;
}

/* =========================================================
   MODERN MÉRÉS – SZIGORÚ MÓD

   A V2 hibája az volt, hogy automatikusan
   az első/utolsó számot választotta.

   A V3 csak akkor enged automatikus rekordot,
   ha a sor szerkezete egyértelmű.

   Ha több számjelölt van, review státuszt kap.
   ========================================================= */

function extractModernMeasurement(
  block,
  fullText
) {
  if (
    !hasModernConcentrationHeader(
      fullText
    )
  ) {
    return {
      accepted: false,
      reason:
        "missing_concentration_header"
    };
  }

  if (
    !/Környezeti\s+levegő\s+vizsgálat/i.test(
      block
    )
  ) {
    return {
      accepted: false,
      reason:
        "missing_air_measurement_marker"
    };
  }

  const candidates =
    getModernNumericTail(block);

  /*
   * Ha pontosan egy jelölt van a
   * koncentrációs tartományban, elfogadjuk.
   */

  if (candidates.length === 1) {
    return {
      accepted: true,

      concentration_fibres_m3:
        candidates[0].value,

      concentration_fibres_cm3:
        null,

      below_detection_limit:
        candidates[0].below,

      parser:
        "strict_modern_single_candidate",

      confidence:
        "high",

      raw:
        candidates[0].raw,

      candidates
    };
  }

  /*
   * Több jelölt esetén NEM találgatunk.
   */

  return {
    accepted: false,

    reason:
      candidates.length === 0
        ? "no_concentration_candidate"
        : "ambiguous_concentration_candidates",

    candidates
  };
}

/* =========================================================
   TÉRFOGATÁRAM – CSAK METAADAT
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
      Math.max(0, marker - 500),
      marker
    );

  const matches = [
    ...before.matchAll(
      /\b(\d{1,2}[.,]\d{1,3})\b/g
    )
  ];

  for (
    let i = matches.length - 1;
    i >= 0;
    i--
  ) {
    const value =
      parseNumber(matches[i][1]);

    if (
      value !== null &&
      value >= 5 &&
      value <= 15
    ) {
      return value;
    }
  }

  return null;
}

/* =========================================================
   EGY MINTA
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
    extractGps(block);

  const dateTimes =
    extractDateTimes(block);

  const location =
    extractLocation(
      block,
      sampleId
    );

  /*
   * Elsőbbséget élvez a régi explicit formátum.
   */

  const legacy =
    extractLegacyMeasurement(
      block
    );

  if (legacy) {
    return {
      status:
        "accepted",

      sample_id:
        sampleId,

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
        extractFlowRate(block),

      ...legacy,

      source_title:
        document.source_title,

      publication_date:
        document.publication_date,

      source_document:
        document.source_document,

      authority:
        AUTHORITY
    };
  }

  /*
   * Modern formátum.
   */

  const modern =
    extractModernMeasurement(
      block,
      fullText
    );

  if (modern.accepted) {
    return {
      status:
        "accepted",

      sample_id:
        sampleId,

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
        extractFlowRate(block),

      concentration_fibres_m3:
        modern
          .concentration_fibres_m3,

      concentration_fibres_cm3:
        modern
          .concentration_fibres_cm3,

      below_detection_limit:
        modern
          .below_detection_limit,

      parser:
        modern.parser,

      confidence:
        modern.confidence,

      raw_concentration:
        modern.raw,

      source_title:
        document.source_title,

      publication_date:
        document.publication_date,

      source_document:
        document.source_document,

      authority:
        AUTHORITY
    };
  }

  /*
   * Bizonytalan rekord:
   * nem kerül a dashboard-adatbázisba.
   */

  return {
    status:
      "review",

    sample_id:
      sampleId,

    location,

    lat:
      gps?.lat ?? null,

    lon:
      gps?.lon ?? null,

    start:
      dateTimes.start,

    end:
      dateTimes.end,

    reason:
      modern.reason,

    candidates:
      modern.candidates || [],

    context:
      inline(
        block.slice(0, 1200)
      ),

    source_title:
      document.source_title,

    publication_date:
      document.publication_date,

    source_document:
      document.source_document
  };
}

/* =========================================================
   LEVEGŐMÉRÉSEK
   ========================================================= */

function extractAirMeasurements(
  text,
  document
) {
  if (
    document.measurement_category !==
    "air"
  ) {
    return {
      accepted: [],
      review: []
    };
  }

  const blocks =
    splitIntoSampleBlocks(text);

  const accepted = [];
  const review = [];

  for (const block of blocks) {
    const parsed =
      parseAirSample(
        block,
        document,
        text
      );

    if (
      parsed.status ===
      "accepted"
    ) {
      accepted.push(parsed);
    } else {
      review.push(parsed);
    }
  }

  return {
    accepted:
      uniqueBy(
        accepted,
        (item) =>
          [
            item.source_document,
            item.sample_id,
            item.concentration_fibres_m3
          ].join("|")
      ),

    review:
      uniqueBy(
        review,
        (item) =>
          [
            item.source_document,
            item.sample_id
          ].join("|")
      )
  };
}

/* =========================================================
   DOKUMENTUM
   ========================================================= */

async function processDocument(
  document
) {
  const downloaded =
    await downloadPdf(
      document.source_document
    );

  const pdfResult =
    await pdf(
      downloaded.buffer
    );

  const text =
    normalizeText(
      pdfResult.text || ""
    );

  const coordinates =
    extractCoordinates(text);

  const asbestosTypes =
    detectAsbestosTypes(text);

  const air =
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

    final_url:
      downloaded.finalUrl,

    document_sha256:
      sha256(downloaded.buffer),

    pdf_pages:
      pdfResult.numpages || null,

    text_length:
      text.length,

    detected_coordinates:
      coordinates,

    detected_asbestos_types:
      asbestosTypes,

    accepted_air_measurements:
      air.accepted,

    review_air_measurements:
      air.review,

    statistics: {
      coordinates:
        coordinates.length,

      asbestos_types:
        asbestosTypes.length,

      accepted_air_measurements:
        air.accepted.length,

      review_air_measurements:
        air.review.length
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
    "SZIGORÚ STRUKTURÁLT PARSER – V3.0"
  );

  console.log(
    "=========================================="
  );

  const input =
    JSON.parse(
      fs.readFileSync(
        INPUT_FILE,
        "utf8"
      )
    );

  const documents =
    Array.isArray(
      input.measurements
    )
      ? input.measurements
      : [];

  if (!documents.length) {
    throw new Error(
      "Nincs feldolgozható measurement rekord."
    );
  }

  const extractions = [];

  const acceptedMeasurements = [];

  const reviewMeasurements = [];

  let success = 0;
  let failed = 0;

  console.log(
    `Feldolgozandó dokumentumok: ${documents.length}`
  );

  console.log("");

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

    try {
      const result =
        await processDocument(
          document
        );

      extractions.push(result);

      acceptedMeasurements.push(
        ...result
          .accepted_air_measurements
      );

      reviewMeasurements.push(
        ...result
          .review_air_measurements
      );

      success++;

      console.log(
        `  ↳ kategória: ${document.measurement_category}`
      );

      console.log(
        `  ↳ PDF oldalak: ${result.pdf_pages}`
      );

      console.log(
        `  ↳ elfogadott levegőmérések: ${result.statistics.accepted_air_measurements}`
      );

      console.log(
        `  ↳ ellenőrzendő sorok: ${result.statistics.review_air_measurements}`
      );

      for (
        const measurement of
        result.accepted_air_measurements
      ) {
        console.log(
          `     ✓ ${measurement.sample_id}: ` +
          `${measurement.concentration_fibres_m3} rost/m3` +
          ` | ${measurement.confidence}`
        );
      }

      for (
        const review of
        result.review_air_measurements
          .slice(0, 10)
      ) {
        console.log(
          `     ? ${review.sample_id}: ${review.reason}`
        );

        if (
          review.candidates?.length
        ) {
          console.log(
            `       jelöltek: ${
              review.candidates
                .map(
                  (candidate) =>
                    candidate.raw
                )
                .join(", ")
            }`
          );
        }
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

        extraction_status:
          "error",

        error:
          error.message
      });
    }

    console.log("");
  }

  const accepted =
    uniqueBy(
      acceptedMeasurements,
      (item) =>
        [
          item.source_document,
          item.sample_id,
          item.concentration_fibres_m3
        ].join("|")
    );

  const review =
    uniqueBy(
      reviewMeasurements,
      (item) =>
        [
          item.source_document,
          item.sample_id
        ].join("|")
    );

  /* =======================================================
     TELJES EXTRACTION
     ======================================================= */

  const extractionOutput = {
    schema_version:
      "3.0",

    generated_at:
      nowIso(),

    authority:
      AUTHORITY,

    statistics: {
      total_documents:
        documents.length,

      successful_extractions:
        success,

      failed_extractions:
        failed,

      accepted_air_measurements:
        accepted.length,

      review_air_measurements:
        review.length
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
     DASHBOARD ADATFÁJL

     CSAK HIGH CONFIDENCE / ACCEPTED.
     ======================================================= */

  const airOutput = {
    schema_version:
      "2.0",

    generated_at:
      nowIso(),

    authority:
      AUTHORITY,

    unit:
      "rost/m3",

    policy:
      "Only measurements with unambiguous source-to-value association are included.",

    measurement_count:
      accepted.length,

    review_count:
      review.length,

    measurements:
      accepted,

    review_queue:
      review
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

  console.log(
    "=========================================="
  );

  console.log(
    "V3 FELDOLGOZÁS KÉSZ"
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
    `Elfogadott levegőmérések: ${accepted.length}`
  );

  console.log(
    `Ellenőrzendő sorok: ${review.length}`
  );

  console.log(
    `Mentve: ${AIR_OUTPUT_FILE}`
  );

  if (success === 0) {
    process.exitCode = 2;
  }
}

main().catch(
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
