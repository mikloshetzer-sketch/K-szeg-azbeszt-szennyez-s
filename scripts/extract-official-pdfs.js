/**
 * extract-official-pdfs.js
 *
 * Vas Vármegyei Kormányhivatal – azbeszt monitor
 *
 * Feladat:
 *  - official_measurements.json beolvasása
 *  - hivatalos PDF-ek szövegének kinyerése
 *  - levegőmérési eredmények strukturált felismerése
 *  - régi rost/cm3 és új rost/m3 formátum támogatása
 *  - GPS-koordináták felismerése
 *  - azbeszttípusok felismerése
 *  - nyers kinyerés mentése
 *  - strukturált levegőmérések külön mentése
 */

const fs = require("fs");
const path = require("path");
const pdf = require("pdf-parse");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

const INPUT_FILE = path.join(DATA_DIR, "official_measurements.json");
const EXTRACTION_FILE = path.join(
  DATA_DIR,
  "official_measurement_extractions.json"
);
const AIR_OUTPUT_FILE = path.join(
  DATA_DIR,
  "official_air_measurements.json"
);

// ------------------------------------------------------------
// SEGÉDFÜGGVÉNYEK
// ------------------------------------------------------------

function normalizeText(text) {
  return String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n+/g, "\n")
    .replace(/rost\s*\/\s*m\s*3/gi, "rost/m3")
    .replace(/rost\s*\/\s*cm\s*3/gi, "rost/cm3")
    .trim();
}

function numberHU(value) {
  if (value === null || value === undefined) return null;

  const cleaned = String(value)
    .replace(/\*/g, "")
    .replace(/\s+/g, "")
    .replace(",", ".")
    .trim();

  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function normalizeCoordinate(value) {
  if (!value) return null;

  const n = Number(String(value).replace(",", "."));

  return Number.isFinite(n) ? n : null;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();

  return items.filter((item) => {
    const key = keyFn(item);

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });
}

function detectAsbestosTypes(text) {
  const lower = text.toLowerCase();

  const definitions = [
    ["krizotil", ["krizotil", "chrysotile"]],
    ["tremolit", ["tremolit", "tremolite"]],
    ["aktinolit", ["aktinolit", "actinolite"]],
    ["amozit", ["amozit", "amosite"]],
    ["krokidolit", ["krokidolit", "crocidolite"]],
    ["antofillit", ["antofillit", "anthophyllite"]],
  ];

  const found = [];

  for (const [canonical, aliases] of definitions) {
    if (aliases.some((alias) => lower.includes(alias))) {
      found.push(canonical);
    }
  }

  return found;
}

// ------------------------------------------------------------
// GPS
// ------------------------------------------------------------

function extractCoordinates(text) {
  const results = [];

  const regex =
    /(?:GPS[- ]?koordináták[^:]*:\s*)?(\d{2}[.,]\d{3,6})\s*[,;]\s*(\d{2}[.,]\d{3,6})/gi;

  let match;

  while ((match = regex.exec(text)) !== null) {
    const lat = normalizeCoordinate(match[1]);
    const lon = normalizeCoordinate(match[2]);

    if (
      lat !== null &&
      lon !== null &&
      lat >= 45 &&
      lat <= 49 &&
      lon >= 15 &&
      lon <= 23
    ) {
      results.push({
        lat,
        lon,
      });
    }
  }

  return results;
}

// ------------------------------------------------------------
// MINTAAZONOSÍTÓ
// ------------------------------------------------------------

function findSamplePositions(text) {
  /*
   * Példák:
   *
   * 2026_792_L/1_1
   * 2026_792_2_L/1_1
   * 2026_792_5_L/3_8
   * 2026_792_6_L/1_1
   */

  const regex =
    /\b20\d{2}_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_L\/\d+_\d+\b/g;

  const positions = [];

  let match;

  while ((match = regex.exec(text)) !== null) {
    positions.push({
      sampleId: match[0],
      index: match.index,
    });
  }

  return positions;
}

function splitIntoSampleBlocks(text) {
  const positions = findSamplePositions(text);

  if (!positions.length) return [];

  const blocks = [];

  for (let i = 0; i < positions.length; i++) {
    const current = positions[i];

    const next =
      i + 1 < positions.length
        ? positions[i + 1].index
        : text.length;

    blocks.push({
      sampleId: current.sampleId,
      text: text.slice(current.index, next).trim(),
    });
  }

  return blocks;
}

// ------------------------------------------------------------
// HELYSZÍN + GPS
// ------------------------------------------------------------

function extractLocationFromBlock(block, sampleId) {
  let work = block;

  if (work.startsWith(sampleId)) {
    work = work.slice(sampleId.length).trim();
  }

  const gpsIndex = work.search(/GPS[- ]?koordináták/i);

  if (gpsIndex !== -1) {
    let location = work.slice(0, gpsIndex).trim();

    location = location
      .replace(/\s+/g, " ")
      .replace(/[,;:\-]+$/, "")
      .trim();

    return location || null;
  }

  return null;
}

function extractGpsFromBlock(block) {
  const regex =
    /GPS[- ]?koordináták\s*\(?(?:WGS84)?\)?\s*:\s*(\d{2}[.,]\d{3,6})\s*,\s*(\d{2}[.,]\d{3,6})/i;

  const match = block.match(regex);

  if (!match) return null;

  const lat = normalizeCoordinate(match[1]);
  const lon = normalizeCoordinate(match[2]);

  if (lat === null || lon === null) return null;

  return { lat, lon };
}

// ------------------------------------------------------------
// MÉRTÉKEGYSÉG
// ------------------------------------------------------------

function detectConcentrationUnit(text) {
  if (/Koncentr\.\s*\(rost\/m3\)/i.test(text)) {
    return "fibres_m3";
  }

  if (/Koncentr\.\s*\(rost\/cm3\)/i.test(text)) {
    return "fibres_cm3";
  }

  if (/rost\/m3/i.test(text)) {
    return "fibres_m3";
  }

  if (/rost\/cm3/i.test(text)) {
    return "fibres_cm3";
  }

  return null;
}

// ------------------------------------------------------------
// RÉGI FORMÁTUM
// ------------------------------------------------------------

function extractLegacyConcentration(block) {
  /*
   * Példa:
   *
   * 0,0077 (7700 rost/m3)
   *
   * vagy
   *
   * < 0,0001
   */

  let match = block.match(
    /([<>]?\s*\d+[.,]\d+)\s*\(\s*([\d\s]+)\s*rost\/m3\s*\)/i
  );

  if (match) {
    const cm3Text = match[1];
    const m3Text = match[2];

    const belowDetection = cm3Text.includes("<");

    return {
      concentration_fibres_m3: numberHU(m3Text),
      concentration_fibres_cm3: numberHU(
        cm3Text.replace(/[<>]/g, "")
      ),
      below_detection_limit: belowDetection,
      source_format: "legacy_cm3_with_m3",
    };
  }

  return null;
}

// ------------------------------------------------------------
// ÚJ FORMÁTUM – ROST/M3
// ------------------------------------------------------------

function extractModernM3Concentration(block) {
  /*
   * A blokk felépítése:
   *
   * GPS ...
   * kezdő idő
   * dátum
   * vég idő
   * dátum
   * térfogatáram
   * Környezeti levegő vizsgálat
   * 473
   *
   * A "Környezeti levegő vizsgálat" utáni első
   * megfelelő szám a koncentráció.
   */

  const marker = block.search(/Környezeti levegő vizsgálat/i);

  if (marker === -1) return null;

  const tail = block.slice(marker);

  const afterMarker = tail.replace(
    /^.*?Környezeti levegő vizsgálat/i,
    ""
  );

  // < érték
  let match = afterMarker.match(
    /^\s*<\s*([\d\s]+(?:[.,]\d+)?)/i
  );

  if (match) {
    return {
      concentration_fibres_m3: numberHU(match[1]),
      concentration_fibres_cm3: null,
      below_detection_limit: true,
      source_format: "modern_m3",
    };
  }

  // normál érték
  match = afterMarker.match(
    /^\s*([\d\s]+(?:[.,]\d+)?)/i
  );

  if (!match) return null;

  const value = numberHU(match[1]);

  if (value === null) return null;

  return {
    concentration_fibres_m3: value,
    concentration_fibres_cm3: null,
    below_detection_limit: false,
    source_format: "modern_m3",
  };
}

// ------------------------------------------------------------
// IDŐPONTOK
// ------------------------------------------------------------

function extractDatesAndTimes(block) {
  const dates = [
    ...block.matchAll(
      /\b(20\d{2})[.\-](\d{2})[.\-](\d{2})\.?/g
    ),
  ].map((m) => `${m[1]}-${m[2]}-${m[3]}`);

  const times = [
    ...block.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g),
  ].map((m) => `${m[1].padStart(2, "0")}:${m[2]}`);

  let start = null;
  let end = null;

  if (dates.length >= 2 && times.length >= 2) {
    start = `${dates[0]} ${times[0]}`;
    end = `${dates[1]} ${times[1]}`;
  } else if (dates.length === 1 && times.length >= 2) {
    start = `${dates[0]} ${times[0]}`;
    end = `${dates[0]} ${times[1]}`;
  }

  return {
    start,
    end,
    dates,
    times,
  };
}

// ------------------------------------------------------------
// TÉRFOGATÁRAM
// ------------------------------------------------------------

function extractFlowRate(block) {
  /*
   * A GPS + időadatok után általában:
   *
   * 8,21 Környezeti levegő vizsgálat
   */

  const marker = block.search(/Környezeti levegő vizsgálat/i);

  if (marker === -1) return null;

  const before = block.slice(0, marker);

  const matches = [
    ...before.matchAll(/\b(\d{1,2}[.,]\d{1,2})\b/g),
  ];

  if (!matches.length) return null;

  for (let i = matches.length - 1; i >= 0; i--) {
    const value = numberHU(matches[i][1]);

    if (value >= 5 && value <= 15) {
      return value;
    }
  }

  return null;
}

// ------------------------------------------------------------
// EGY LEVEGŐMÉRÉSI MINTA
// ------------------------------------------------------------

function parseAirSample(block, documentMeta, documentUnit) {
  const sampleIdMatch = block.match(
    /\b20\d{2}_[A-Za-z0-9]+(?:_[A-Za-z0-9]+)*_L\/\d+_\d+\b/
  );

  if (!sampleIdMatch) return null;

  const sampleId = sampleIdMatch[0];

  const gps = extractGpsFromBlock(block);

  const location = extractLocationFromBlock(
    block,
    sampleId
  );

  let concentration = extractLegacyConcentration(block);

  if (!concentration && documentUnit === "fibres_m3") {
    concentration = extractModernM3Concentration(block);
  }

  /*
   * Régi cm3 táblázatokban előfordulhat, hogy nincs
   * zárójelben megadva a rost/m3 érték.
   */

  if (!concentration && documentUnit === "fibres_cm3") {
    const marker = block.search(
      /Környezeti levegő vizsgálat/i
    );

    if (marker !== -1) {
      const tail = block.slice(marker);

      const match = tail.match(
        /Környezeti levegő vizsgálat\s*([<>]?\s*\d+[.,]\d+)/i
      );

      if (match) {
        const raw = match[1];
        const cm3 = numberHU(raw.replace(/[<>]/g, ""));

        concentration = {
          concentration_fibres_cm3: cm3,
          concentration_fibres_m3:
            cm3 !== null ? Math.round(cm3 * 1000000) : null,
          below_detection_limit: raw.includes("<"),
          source_format: "legacy_cm3",
        };
      }
    }
  }

  if (!concentration) return null;

  const dateTime = extractDatesAndTimes(block);

  return {
    sample_id: sampleId,

    location,

    lat: gps?.lat ?? null,
    lon: gps?.lon ?? null,

    start: dateTime.start,
    end: dateTime.end,

    flow_rate_l_min: extractFlowRate(block),

    concentration_fibres_m3:
      concentration.concentration_fibres_m3,

    concentration_fibres_cm3:
      concentration.concentration_fibres_cm3,

    below_detection_limit:
      concentration.below_detection_limit,

    source_format:
      concentration.source_format,

    document_title:
      documentMeta.title || null,

    document_date:
      documentMeta.date || null,

    source_url:
      documentMeta.url || null,

    source:
      "Vas Vármegyei Kormányhivatal",
  };
}

// ------------------------------------------------------------
// DOKUMENTUM FELDOLGOZÁSA
// ------------------------------------------------------------

function extractStructuredAirMeasurements(
  text,
  documentMeta
) {
  const normalized = normalizeText(text);

  const unit = detectConcentrationUnit(normalized);

  const blocks = splitIntoSampleBlocks(normalized);

  const measurements = [];

  for (const block of blocks) {
    const parsed = parseAirSample(
      block.text,
      documentMeta,
      unit
    );

    if (parsed) {
      measurements.push(parsed);
    }
  }

  return uniqueBy(
    measurements,
    (item) =>
      `${item.document_title}|${item.sample_id}`
  );
}

// ------------------------------------------------------------
// PDF LETÖLTÉS / BEOLVASÁS
// ------------------------------------------------------------

async function loadPdfBuffer(document) {
  /*
   * A korábbi rendszer eltérő mezőneveket használhat.
   * Ezért több lehetőséget támogatunk.
   */

  const localPath =
    document.local_path ||
    document.localPath ||
    document.pdf_path ||
    document.file;

  if (localPath) {
    const fullPath = path.isAbsolute(localPath)
      ? localPath
      : path.join(ROOT, localPath);

    if (fs.existsSync(fullPath)) {
      return fs.readFileSync(fullPath);
    }
  }

  const url =
    document.url ||
    document.pdf_url ||
    document.download_url;

  if (!url) {
    throw new Error(
      "Nincs PDF URL vagy helyi PDF elérési út."
    );
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `PDF letöltési hiba: HTTP ${response.status}`
    );
  }

  const arrayBuffer = await response.arrayBuffer();

  return Buffer.from(arrayBuffer);
}

// ------------------------------------------------------------
// MAIN
// ------------------------------------------------------------

async function main() {
  console.log("==========================================");
  console.log("HIVATALOS AZBESZT PDF ADATKINYERÉS");
  console.log("STRUKTURÁLT LEVEGŐMÉRÉSEK – V2.0");
  console.log("==========================================");

  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(
      `Hiányzó input fájl: ${INPUT_FILE}`
    );
  }

  const input = JSON.parse(
    fs.readFileSync(INPUT_FILE, "utf8")
  );

  const documents = Array.isArray(input)
    ? input
    : input.documents ||
      input.measurements ||
      input.items ||
      [];

  console.log(
    `Feldolgozandó mérési dokumentumok: ${documents.length}`
  );
  console.log("");

  const extractionResults = [];
  const allAirMeasurements = [];

  let success = 0;
  let failed = 0;

  for (let i = 0; i < documents.length; i++) {
    const document = documents[i];

    const title =
      document.title ||
      document.name ||
      `Dokumentum ${i + 1}`;

    console.log(`[${i + 1}/${documents.length}] ${title}`);

    try {
      const buffer = await loadPdfBuffer(document);

      const pdfResult = await pdf(buffer);

      const rawText = pdfResult.text || "";
      const normalizedText = normalizeText(rawText);

      const coordinates =
        extractCoordinates(normalizedText);

      const asbestosTypes =
        detectAsbestosTypes(normalizedText);

      const structuredAir =
        extractStructuredAirMeasurements(
          normalizedText,
          document
        );

      allAirMeasurements.push(...structuredAir);

      extractionResults.push({
        title,
        date: document.date || null,
        category:
          document.category ||
          document.type ||
          null,

        url:
          document.url ||
          document.pdf_url ||
          null,

        status: "success",

        pages: pdfResult.numpages || null,

        text_length: normalizedText.length,

        coordinates,

        asbestos_types: asbestosTypes,

        air_measurements:
          structuredAir,

        air_measurement_count:
          structuredAir.length,
      });

      success++;

      console.log(
        `  ↳ strukturált levegőmérések: ${structuredAir.length}`
      );

      console.log(
        `  ↳ koordináták: ${coordinates.length}`
      );

      console.log(
        `  ↳ azbeszttípusok: ${
          asbestosTypes.length
            ? asbestosTypes.join(", ")
            : "nincs"
        }`
      );

      if (structuredAir.length) {
        for (const measurement of structuredAir) {
          console.log(
            `     ${measurement.sample_id}: ` +
              `${measurement.concentration_fibres_m3} rost/m3`
          );
        }
      }
    } catch (error) {
      failed++;

      console.error(
        `  ✗ HIBA: ${error.message}`
      );

      extractionResults.push({
        title,
        date: document.date || null,
        category:
          document.category ||
          document.type ||
          null,
        status: "error",
        error: error.message,
      });
    }

    console.log("");
  }

  // ----------------------------------------------------------
  // DUPLIKÁCIÓK KISZŰRÉSE
  // ----------------------------------------------------------

  const uniqueAirMeasurements = uniqueBy(
    allAirMeasurements,
    (item) =>
      [
        item.sample_id,
        item.lat,
        item.lon,
        item.start,
        item.concentration_fibres_m3,
      ].join("|")
  );

  // ----------------------------------------------------------
  // NYERS / DOKUMENTUMSZINTŰ EREDMÉNY
  // ----------------------------------------------------------

  const extractionOutput = {
    generated_at: new Date().toISOString(),

    source:
      "Vas Vármegyei Kormányhivatal",

    document_count: documents.length,

    success_count: success,

    error_count: failed,

    structured_air_measurement_count:
      uniqueAirMeasurements.length,

    documents: extractionResults,
  };

  fs.writeFileSync(
    EXTRACTION_FILE,
    JSON.stringify(extractionOutput, null, 2),
    "utf8"
  );

  // ----------------------------------------------------------
  // DASHBOARDHOZ HASZNÁLHATÓ TISZTA ADATFÁJL
  // ----------------------------------------------------------

  const airOutput = {
    generated_at: new Date().toISOString(),

    source:
      "Vas Vármegyei Kormányhivatal",

    description:
      "Hivatalos környezeti levegő azbesztrost-koncentráció mérések.",

    unit: "rost/m3",

    measurement_count:
      uniqueAirMeasurements.length,

    measurements:
      uniqueAirMeasurements,
  };

  fs.writeFileSync(
    AIR_OUTPUT_FILE,
    JSON.stringify(airOutput, null, 2),
    "utf8"
  );

  console.log("==========================================");
  console.log("PDF ADATKINYERÉS KÉSZ");
  console.log("==========================================");

  console.log(`Dokumentumok: ${documents.length}`);
  console.log(`Sikeres: ${success}`);
  console.log(`Hibás: ${failed}`);

  console.log(
    `Strukturált levegőmérések: ${uniqueAirMeasurements.length}`
  );

  console.log("");
  console.log(`Mentve: ${EXTRACTION_FILE}`);
  console.log(`Mentve: ${AIR_OUTPUT_FILE}`);

  console.log("==========================================");

  if (!uniqueAirMeasurements.length) {
    console.warn("");
    console.warn(
      "FIGYELEM: egyetlen strukturált levegőmérés sem került felismerésre."
    );

    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error("");
  console.error("VÉGZETES HIBA:");
  console.error(error);

  process.exit(1);
});
