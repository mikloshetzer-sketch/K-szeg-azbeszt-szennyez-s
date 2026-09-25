/**
 * Vas Vármegyei Kormányhivatal
 * Hivatalos levegő-azbesztmérések feldolgozása
 *
 * V4.2 – MODERN TÁBLÁZATOS LEVEGŐMÉRÉSEK
 *
 * Cél:
 * - kizárólag a hivatalos Kormányhivatal-források feldolgozása
 * - régi explicit levegőmérések automatikus felismerése
 * - modern táblázatos PDF-ek szerkezetének feltérképezése
 * - bizonytalan koncentráció nem kerülhet automatikusan az adatbázisba
 * - modern PDF-eknél részletes diagnosztikai log készül
 *
 * FONTOS:
 * - önálló parser
 * - nem használja a régi kőzetminta-adatbázist
 * - nem használja a repo korábbi PDF-jeit adatforrásként
 * - nem tartalmaz kézzel rögzített mérési eredményeket
 */

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
  "Koszeg-Asbestos-Air-Monitor/4.2 (+GitHub Actions)";


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
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")

    // Mértékegységek normalizálása
    .replace(
      /rost\s*\/\s*m\s*[³3]/gi,
      "rost/m3"
    )
    .replace(
      /rost\s*\/\s*cm\s*[³3]/gi,
      "rost/cm3"
    )

    // Whitespace normalizálás
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{4,}/g, "\n\n")

    .trim();
}


function inline(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}


function parseNumber(raw) {

  if (
    raw === undefined ||
    raw === null
  ) {
    return null;
  }

  let value = String(raw)
    .replace(/\u00a0/g, "")
    .replace(/[<>*]/g, "")
    .replace(/\s+/g, "")
    .trim();

  /*
   * Magyar tizedesjel.
   *
   * Példa:
   * 0,0077
   * 8,21
   */

  if (/^\d+,\d+$/.test(value)) {
    value =
      value.replace(",", ".");
  }

  const number =
    Number(value);

  return Number.isFinite(number)
    ? number
    : null;
}


function uniqueBy(items, keyFn) {

  const seen = new Set();

  return items.filter((item) => {

    const key =
      keyFn(item);

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
      "Hiányzó source_document URL."
    );
  }

  const response =
    await fetch(
      url,
      {
        headers: {
          "User-Agent":
            USER_AGENT,

          Accept:
            "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8"
        },

        redirect:
          "follow"
      }
    );

  if (!response.ok) {

    throw new Error(
      `PDF letöltési hiba: HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  return {

    buffer,

    finalUrl:
      response.url || url,

    contentType:
      response.headers.get(
        "content-type"
      ) || null
  };
}


/* =========================================================
   MINTAAZONOSÍTÓK
   ========================================================= */

function extractSampleIds(text) {

  /*
   * Példák:
   *
   * 2026_792_6_L/1_1
   * 2026_792_6_L/1_2
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

      sample_id:
        match[0],

      index:
        match.index
    });
  }

  return uniqueBy(
    results,
    (item) =>
      item.sample_id
  );
}


/* =========================================================
   KOORDINÁTÁK
   ========================================================= */

function extractCoordinates(text) {

  const regex =
    /\b(4[6-8][.,]\d{3,8})\s*[,;/ ]+\s*(1[5-7][.,]\d{3,8})\b/g;

  const results = [];

  let match;

  while (
    (match = regex.exec(text)) !== null
  ) {

    const lat =
      Number(
        match[1]
          .replace(",", ".")
      );

    const lon =
      Number(
        match[2]
          .replace(",", ".")
      );

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon)
    ) {
      continue;
    }

    results.push({

      lat,

      lon,

      index:
        match.index,

      raw:
        match[0]
    });
  }

  return results;
}


/* =========================================================
   AZBESZTTÍPUSOK
   ========================================================= */

function extractAsbestosTypes(text) {

  const lower =
    text.toLowerCase();

  const definitions = [

    [
      "krizotil",
      [
        "krizotil",
        "chrysotile"
      ]
    ],

    [
      "tremolit",
      [
        "tremolit",
        "tremolite"
      ]
    ],

    [
      "aktinolit",
      [
        "aktinolit",
        "actinolite"
      ]
    ],

    [
      "amozit",
      [
        "amozit",
        "amosite"
      ]
    ],

    [
      "krokidolit",
      [
        "krokidolit",
        "crocidolite"
      ]
    ],

    [
      "antofillit",
      [
        "antofillit",
        "anthophyllite"
      ]
    ]
  ];

  const found = [];

  for (
    const [name, aliases]
    of definitions
  ) {

    if (
      aliases.some(
        (alias) =>
          lower.includes(alias)
      )
    ) {

      found.push(name);
    }
  }

  return found;
}


/* =========================================================
   RÉGI EXPLICIT LEVEGŐMÉRÉS

   Példa:

   0,0077 (7700 rost/m3)

   Ez közvetlen kapcsolatot jelent,
   ezért magas megbízhatóságú.
   ========================================================= */

function extractExplicitLegacyMeasurements(
  text
) {

  const regex =
    /([<>]?\s*\d+[.,]\d+)\s*\(\s*([\d\s]+)\s*rost\/m3\s*\)/gi;

  const results = [];

  let match;

  while (
    (match = regex.exec(text)) !== null
  ) {

    const cm3 =
      parseNumber(
        match[1]
      );

    const m3 =
      parseNumber(
        match[2]
      );

    if (
      cm3 === null ||
      m3 === null
    ) {
      continue;
    }

    results.push({

      index:
        match.index,

      concentration_fibres_cm3:
        cm3,

      concentration_fibres_m3:
        m3,

      below_detection_limit:
        match[1].includes("<"),

      raw:
        inline(
          match[0]
        ),

      parser:
        "explicit_legacy_pair",

      confidence:
        "high"
    });
  }

  return results;
}


/* =========================================================
   MODERN KONCENTRÁCIÓS FEJLÉCEK
   ========================================================= */

function findConcentrationHeaders(text) {

  const patterns = [

    /Koncentr[^()\n]{0,50}\(\s*rost\/m3\s*\)/gi,

    /Koncentr[^\n]{0,50}rost\/m3/gi,

    /azbesztrost[^\n]{0,50}rost\/m3/gi
  ];

  const results = [];

  for (
    const regex
    of patterns
  ) {

    let match;

    while (
      (match = regex.exec(text)) !== null
    ) {

      results.push({

        index:
          match.index,

        text:
          inline(
            match[0]
          )
      });
    }
  }

  return uniqueBy(
    results,
    (item) =>
      item.index
  );
}


/* =========================================================
   LEVEGŐVIZSGÁLATI MARKEREK
   ========================================================= */

function findAirMarkers(text) {

  const regex =
    /Környezeti\s+levegő\s+vizsgálat/gi;

  const results = [];

  let match;

  while (
    (match = regex.exec(text)) !== null
  ) {

    results.push({

      index:
        match.index,

      text:
        match[0]
    });
  }

  return results;
}


/* =========================================================
   NUMERIKUS TOKENEK

   FONTOS:
   Ezek önmagukban NEM mérési eredmények.

   Csak diagnosztikai számjelöltek.
   ========================================================= */

function extractNumericTokens(text) {

  const regex =
    /(?:^|[\s\n])(<\s*)?(\d+(?:[.,]\d+)?)(?=$|[\s\n])/g;

  const results = [];

  let match;

  while (
    (match = regex.exec(text)) !== null
  ) {

    const value =
      parseNumber(
        match[2]
      );

    if (
      value === null
    ) {
      continue;
    }

    results.push({

      value,

      raw:
        `${match[1] || ""}${match[2]}`,

      below_detection_limit:
        Boolean(
          match[1]
        ),

      index:
        match.index
    });
  }

  return results;
}


/* =========================================================
   MODERN DOKUMENTUM SZERKEZET
   ========================================================= */

function analyseModernStructure(text) {

  const samples =
    extractSampleIds(text);

  const headers =
    findConcentrationHeaders(text);

  const airMarkers =
    findAirMarkers(text);

  const numericTokens =
    extractNumericTokens(text);

  return {

    samples,

    headers,

    airMarkers,

    numericTokens
  };
}


/* =========================================================
   V4.1 – MODERN PDF DIAGNOSZTIKA

   Ez a rész NEM változtat az adatokon.

   Feladata:
   - megmutatni a koncentrációs fejlécet
   - megmutatni annak környezetét
   - megmutatni a mintaazonosítókat
   - megmutatni a minták környezetét
   - megmutatni a numerikus tokenek sorrendjét
   ========================================================= */

function printModernTableDiagnostics(
  text,
  document,
  structure
) {

  console.log("");

  console.log(
    "  ========================================"
  );

  console.log(
    "  V4.1 MODERN TABLE DIAGNOSZTIKA"
  );

  console.log(
    "  ========================================"
  );

  console.log(
    `  Dokumentum: ${document.source_title}`
  );

  console.log(
    `  Minták száma: ${structure.samples.length}`
  );

  console.log(
    `  Koncentráció fejlécek: ${structure.headers.length}`
  );

  console.log(
    `  Levegővizsgálat markerek: ${structure.airMarkers.length}`
  );

  console.log(
    `  Numerikus tokenek: ${structure.numericTokens.length}`
  );


  /* =======================================================
     MINTAAZONOSÍTÓK
     ======================================================= */

  console.log("");

  console.log(
    "  ----- MINTAAZONOSÍTÓK -----"
  );

  structure.samples.forEach(
    (sample, index) => {

      console.log(
        `  ${String(index + 1).padStart(2, "0")} | ` +
        `${sample.sample_id} | ` +
        `pozíció=${sample.index}`
      );
    }
  );


  /* =======================================================
     KONCENTRÁCIÓS FEJLÉCEK
     ======================================================= */

  console.log("");

  console.log(
    "  ----- KONCENTRÁCIÓS FEJLÉCEK -----"
  );

  if (
    !structure.headers.length
  ) {

    console.log(
      "  Nincs koncentrációs fejléc."
    );

  } else {

    structure.headers.forEach(
      (header, index) => {

        console.log("");

        console.log(
          `  Fejléc ${index + 1}`
        );

        console.log(
          `  pozíció=${header.index}`
        );

        console.log(
          `  szöveg=${header.text}`
        );
      }
    );
  }


  /* =======================================================
     KONCENTRÁCIÓS FEJLÉC KÖRNYEZETE
     ======================================================= */

  for (
    let i = 0;
    i < structure.headers.length;
    i++
  ) {

    const header =
      structure.headers[i];

    const beforeStart =
      Math.max(
        0,
        header.index - 2500
      );

    const afterEnd =
      Math.min(
        text.length,
        header.index + 7000
      );

    const before =
      text.slice(
        beforeStart,
        header.index
      );

    const after =
      text.slice(
        header.index,
        afterEnd
      );


    console.log("");

    console.log(
      `  ===== FEJLÉC ${i + 1} ELŐTT =====`
    );

    console.log(before);

    console.log(
      `  ===== FEJLÉC ${i + 1} =====`
    );

    console.log(
      header.text
    );

    console.log(
      `  ===== FEJLÉC ${i + 1} UTÁN =====`
    );

    console.log(after);

    console.log(
      `  ===== FEJLÉC ${i + 1} VÉGE =====`
    );
  }


  /* =======================================================
     LEVEGŐVIZSGÁLATI MARKEREK
     ======================================================= */

  console.log("");

  console.log(
    "  ----- LEVEGŐVIZSGÁLATI MARKEREK -----"
  );

  if (
    !structure.airMarkers.length
  ) {

    console.log(
      "  Nincs levegővizsgálati marker."
    );

  } else {

    structure.airMarkers.forEach(
      (marker, index) => {

        const start =
          Math.max(
            0,
            marker.index - 500
          );

        const end =
          Math.min(
            text.length,
            marker.index + 1500
          );


        console.log("");

        console.log(
          `  >>> MARKER ${index + 1} | pozíció=${marker.index}`
        );

        console.log(
          text.slice(
            start,
            end
          )
        );

        console.log(
          `  <<< MARKER ${index + 1} VÉGE`
        );
      }
    );
  }


  /* =======================================================
     MINTAKÖRNYEZETEK

     Maximum 12 mintát írunk ki.

     Hermina:
     mind a 8 megjelenik.

     Oladi:
     az első 12 elég a struktúra vizsgálatához.
     ======================================================= */

  console.log("");

  console.log(
    "  ----- MINTAKÖRNYEZETEK -----"
  );

  const sampleLimit =
    Math.min(
      structure.samples.length,
      12
    );

  for (
    let i = 0;
    i < sampleLimit;
    i++
  ) {

    const sample =
      structure.samples[i];

    const nextSample =
      structure.samples[i + 1] || null;

    const start =
      sample.index;

    const end =
      nextSample
        ? Math.min(
            nextSample.index,
            start + 1800
          )
        : Math.min(
            text.length,
            start + 1800
          );


    console.log("");

    console.log(
      `  >>> MINTA ${i + 1}: ${sample.sample_id}`
    );

    console.log(
      text.slice(
        start,
        end
      )
    );

    console.log(
      `  <<< MINTA ${i + 1} VÉGE`
    );
  }


  /* =======================================================
     NUMERIKUS TOKENEK A KONCENTRÁCIÓS FEJLÉC UTÁN

     Maximum 150 tokent írunk ki.

     Ezek továbbra sem minősülnek mérésnek.
     ======================================================= */

  console.log("");

  console.log(
    "  ----- NUMERIKUS TOKENEK A FEJLÉC UTÁN -----"
  );

  if (
    structure.headers.length
  ) {

    const firstHeader =
      structure.headers[0];

    const tokensAfterHeader =
      structure.numericTokens
        .filter(
          (token) =>
            token.index >
            firstHeader.index
        )
        .slice(
          0,
          150
        );


    tokensAfterHeader.forEach(
      (token, index) => {

        console.log(
          `  ${String(index + 1).padStart(3, "0")} | ` +
          `pozíció=${token.index} | ` +
          `raw=${token.raw} | ` +
          `value=${token.value}`
        );
      }
    );

  } else {

    console.log(
      "  Nincs fejléc, ezért nincs fejléc utáni tokenlista."
    );
  }


  console.log("");

  console.log(
    "  ========================================"
  );

  console.log(
    "  V4.1 DIAGNOSZTIKA VÉGE"
  );

  console.log(
    "  ========================================"
  );

  console.log("");
}


/* =========================================================
   MINTA KÖRNYEZETE
   ========================================================= */

function getSampleContext(
  text,
  sample,
  nextSample
) {

  const start =
    sample.index;

  const end =
    nextSample
      ? nextSample.index
      : Math.min(
          text.length,
          start + 4000
        );

  return text.slice(
    start,
    end
  );
}


/* =========================================================
   GPS HOZZÁRENDELÉS

   Csak akkor fogadjuk el automatikusan,
   ha pontosan egy egyedi koordinátapár
   található a minta környezetében.
   ========================================================= */

function assignCoordinateToSample(
  context
) {

  const coords =
    extractCoordinates(
      context
    );

  const unique =
    uniqueBy(
      coords,
      (item) =>
        `${item.lat}|${item.lon}`
    );

  if (
    unique.length !== 1
  ) {
    return null;
  }

  return {

    lat:
      unique[0].lat,

    lon:
      unique[0].lon
  };
}


/* =========================================================
   DÁTUM ÉS IDŐ
   ========================================================= */

function extractDateTimes(context) {

  const dates = [];

  const times = [];

  let match;


  const dateRegex =
    /\b(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})\.?/g;


  while (
    (match = dateRegex.exec(context)) !== null
  ) {

    dates.push(
      `${match[1]}-${String(match[2]).padStart(2, "0")}-${String(match[3]).padStart(2, "0")}`
    );
  }


  const timeRegex =
    /\b([01]?\d|2[0-3]):([0-5]\d)\b/g;


  while (
    (match = timeRegex.exec(context)) !== null
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
   HELYSZÍN
   ========================================================= */

function extractLocation(
  context,
  sampleId
) {

  let source =
    context;

  const samplePos =
    source.indexOf(
      sampleId
    );

  if (
    samplePos !== -1
  ) {

    source =
      source.slice(
        samplePos +
        sampleId.length
      );
  }


  const gpsPos =
    source.search(
      /GPS[- ]?koordináták/i
    );


  if (
    gpsPos > 0 &&
    gpsPos < 600
  ) {

    const candidate =
      inline(
        source.slice(
          0,
          gpsPos
        )
      )
        .replace(
          /^[,;:\-\s]+/,
          ""
        )
        .replace(
          /[,;:\-\s]+$/,
          ""
        );


    if (
      candidate.length >= 3 &&
      candidate.length <= 350
    ) {

      return candidate;
    }
  }


  return null;
}


/* =========================================================
   RÉGI FORMÁTUM FELDOLGOZÁSA
   ========================================================= */

function parseLegacyDocument(
  text,
  document
) {

  const samples =
    extractSampleIds(
      text
    );

  const concentrations =
    extractExplicitLegacyMeasurements(
      text
    );


  if (
    !samples.length ||
    !concentrations.length
  ) {

    return {

      accepted: [],

      review: [],

      diagnostics: null
    };
  }


  const accepted = [];

  const review = [];


  /*
   * Minden explicit koncentrációhoz
   * a legközelebbi korábbi mintaazonosítót
   * keressük.
   */

  for (
    const concentration
    of concentrations
  ) {

    const preceding =
      samples
        .filter(
          (sample) =>
            sample.index <
            concentration.index
        )
        .sort(
          (a, b) =>
            b.index - a.index
        );


    if (
      !preceding.length
    ) {
      continue;
    }


    const sample =
      preceding[0];


    const sampleIndex =
      samples.findIndex(
        (item) =>
          item.sample_id ===
          sample.sample_id
      );


    const nextSample =
      sampleIndex >= 0
        ? samples[
            sampleIndex + 1
          ]
        : null;


    const context =
      getSampleContext(
        text,
        sample,
        nextSample
      );


    const gps =
      assignCoordinateToSample(
        context
      );


    const dateTime =
      extractDateTimes(
        context
      );


    accepted.push({

      status:
        "accepted",

      sample_id:
        sample.sample_id,

      settlement:
        null,

      location:
        extractLocation(
          context,
          sample.sample_id
        ),

      lat:
        gps?.lat ?? null,

      lon:
        gps?.lon ?? null,

      start:
        dateTime.start,

      end:
        dateTime.end,

      measurement_type:
        "air",

      concentration_fibres_m3:
        concentration
          .concentration_fibres_m3,

      concentration_fibres_cm3:
        concentration
          .concentration_fibres_cm3,

      below_detection_limit:
        concentration
          .below_detection_limit,

      unit:
        "rost/m3",

      parser:
        concentration.parser,

      confidence:
        "high",

      source_title:
        document.source_title,

      publication_date:
        document.publication_date,

      source_document:
        document.source_document,

      authority:
        AUTHORITY
    });
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

    review,

    diagnostics:
      null
  };
}


/* =========================================================
   MODERN DOKUMENTUM FELDOLGOZÁSA

   V4.1:
   - diagnosztikai mód
   - modern koncentrációt még nem publikálunk
   - minden modern minta review státuszú
   ========================================================= */

function extractModernConcentration(context) {

  /*
   * A modern jegyzőkönyvek egy mintasora a diagnosztika alapján:
   *
   *   ... dátum
   *   8,18 Környezeti levegő vizsgálat
   *   1 520
   *   Átszívott levegő mennyisége ...
   *
   * vagy a további sorokban:
   *
   *   ... dátum
   *   8,29 500
   *   Átszívott levegő mennyisége ...
   *
   * A koncentráció tehát az "Átszívott levegő mennyisége"
   * marker előtti utolsó numerikus érték. Előtte közvetlenül
   * a térfogatáram áll (tipikusan 7–9 l/perc).
   *
   * A "< 100*" alakot detection-limit értékként kezeljük.
   */

  const markerMatch =
    /Átszívott\s+levegő\s+mennyisége/i.exec(context);

  if (!markerMatch) {
    return null;
  }

  let prefix =
    context.slice(0, markerMatch.index);

  prefix = prefix
    .replace(
      /Környezeti\s+levegő\s+vizsgálat/gi,
      " "
    )
    .trim();

  const tail =
    prefix.slice(
      Math.max(0, prefix.length - 350)
    );

  const tokenRegex =
    /(<\s*)?(\d{1,3}(?:\s\d{3})+|\d+(?:[.,]\d+)?)(\s*\*)?/g;

  const tokens = [];

  let match;

  while (
    (match = tokenRegex.exec(tail)) !== null
  ) {

    const raw =
      `${match[1] || ""}${match[2]}${match[3] || ""}`;

    const numeric =
      parseNumber(
        match[2].replace(/\s+/g, "")
      );

    if (numeric === null) {
      continue;
    }

    tokens.push({
      raw: inline(raw),
      value: numeric,
      below_detection_limit:
        Boolean(match[1]),
      index: match.index
    });
  }

  if (!tokens.length) {
    return null;
  }

  /*
   * A dátumok és időpontok sok numerikus tokent hoznak létre,
   * ezért a markerhez legközelebbi értékből indulunk visszafelé.
   *
   * A koncentráció:
   * - egész szám, vagy "< egész szám"
   * - a modern táblákban közvetlenül a volume marker előtt van
   * - a térfogatáram jellemzően tizedes szám, ezért azt kihagyjuk.
   */

  for (
    let i = tokens.length - 1;
    i >= 0;
    i--
  ) {

    const token =
      tokens[i];

    const raw =
      token.raw.replace(/\*/g, "").trim();

    const isIntegerLike =
      token.below_detection_limit ||
      /^\d{1,3}(?:\s\d{3})+$/.test(raw) ||
      /^\d+$/.test(raw);

    if (!isIntegerLike) {
      continue;
    }

    /*
     * Biztonsági korlát:
     * 0 nem lehet elfogadott koncentráció.
     * A hivatalos táblákban a kimutatási határ "< 100".
     */

    if (
      token.value <= 0
    ) {
      continue;
    }

    return {
      concentration_fibres_m3:
        token.value,

      below_detection_limit:
        token.below_detection_limit,

      raw:
        token.raw,

      parser:
        "modern_table_row",

      confidence:
        "high"
    };
  }

  return null;
}


function parseModernDocument(
  text,
  document
) {

  const structure =
    analyseModernStructure(
      text
    );

  const accepted = [];

  const review = [];

  const samples =
    structure.samples;


  for (
    let i = 0;
    i < samples.length;
    i++
  ) {

    const sample =
      samples[i];

    const nextSample =
      samples[i + 1] || null;


    const context =
      getSampleContext(
        text,
        sample,
        nextSample
      );


    const gps =
      assignCoordinateToSample(
        context
      );


    const dateTime =
      extractDateTimes(
        context
      );


    const concentration =
      extractModernConcentration(
        context
      );


    const location =
      extractLocation(
        context,
        sample.sample_id
      );


    /*
     * Automatikus elfogadás csak akkor történik,
     * ha a mintasor szerkezete egyértelmű:
     *
     * - mintaazonosító
     * - pontosan egy koordinátapár
     * - kezdő és záró időpont
     * - az Átszívott levegő marker előtti koncentráció
     *
     * Ha ezek közül bármi hiányzik, review_queue.
     */

    const missing = [];

    if (!gps) {
      missing.push("coordinate");
    }

    if (
      !dateTime.start ||
      !dateTime.end
    ) {
      missing.push("datetime");
    }

    if (!concentration) {
      missing.push("concentration");
    }


    if (missing.length) {

      review.push({

        status:
          "review",

        sample_id:
          sample.sample_id,

        settlement:
          null,

        location,

        lat:
          gps?.lat ?? null,

        lon:
          gps?.lon ?? null,

        start:
          dateTime.start,

        end:
          dateTime.end,

        measurement_type:
          "air",

        reason:
          "modern_table_incomplete_row",

        missing_fields:
          missing,

        context:
          inline(
            context.slice(
              0,
              1800
            )
          ),

        source_title:
          document.source_title,

        publication_date:
          document.publication_date,

        source_document:
          document.source_document,

        authority:
          AUTHORITY
      });

      continue;
    }


    accepted.push({

      status:
        "accepted",

      sample_id:
        sample.sample_id,

      settlement:
        null,

      location,

      lat:
        gps.lat,

      lon:
        gps.lon,

      start:
        dateTime.start,

      end:
        dateTime.end,

      measurement_type:
        "air",

      concentration_fibres_m3:
        concentration
          .concentration_fibres_m3,

      concentration_fibres_cm3:
        concentration
          .concentration_fibres_m3 /
        1000000,

      below_detection_limit:
        concentration
          .below_detection_limit,

      unit:
        "rost/m3",

      raw_concentration:
        concentration.raw,

      parser:
        concentration.parser,

      confidence:
        concentration.confidence,

      source_title:
        document.source_title,

      publication_date:
        document.publication_date,

      source_document:
        document.source_document,

      authority:
        AUTHORITY
    });
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
            item.sample_id,
            item.reason
          ].join("|")
      ),

    diagnostics: {

      sample_count:
        structure.samples.length,

      concentration_headers:
        structure.headers,

      air_marker_count:
        structure.airMarkers.length,

      numeric_token_count:
        structure.numericTokens.length,

      accepted_rows:
        accepted.length,

      review_rows:
        review.length
    }
  };
}

/* =========================================================
   DOKUMENTUM FORMÁTUMÁNAK FELISMERÉSE
   ========================================================= */

function detectDocumentFormat(text) {

  const legacy =
    extractExplicitLegacyMeasurements(
      text
    );


  if (
    legacy.length
  ) {

    return {

      type:
        "legacy_explicit",

      confidence:
        "high"
    };
  }


  const headers =
    findConcentrationHeaders(
      text
    );

  const samples =
    extractSampleIds(
      text
    );

  const hasModernTableHeader =
    /Minta\s+száma[\s\S]{0,500}Koncentr[\s\S]{0,100}\(\s*rost\/m3\s*\)/i
      .test(text);

  const hasAirVolumeMarker =
    /Átszívott\s+levegő\s+mennyisége/i
      .test(text);


  if (
    headers.length ||
    (
      samples.length &&
      hasModernTableHeader &&
      hasAirVolumeMarker
    )
  ) {

    return {

      type:
        "modern_table",

      confidence:
        "high"
    };
  }


  return {

    type:
      "unknown",

    confidence:
      "low"
  };
}


/* =========================================================
   EGY PDF FELDOLGOZÁSA
   ========================================================= */

async function processDocument(
  document
) {

  const downloaded =
    await downloadPdf(
      document.source_document
    );


  const parsed =
    await pdf(
      downloaded.buffer
    );


  const text =
    normalizeText(
      parsed.text || ""
    );


  const format =
    detectDocumentFormat(
      text
    );


  let result;


  /*
   * A kőzetvizsgálati dokumentumokat
   * ez a parser nem dolgozza fel.
   */

  if (
    document.measurement_category !==
    "air"
  ) {

    result = {

      accepted: [],

      review: [],

      diagnostics:
        null
    };

  } else if (
    format.type ===
    "legacy_explicit"
  ) {

    result =
      parseLegacyDocument(
        text,
        document
      );

  } else if (
    format.type ===
    "modern_table"
  ) {

    result =
      parseModernDocument(
        text,
        document
      );

  } else {

    result = {

      accepted: [],

      review: [
        {

          status:
            "review",

          sample_id:
            null,

          reason:
            "unknown_document_format",

          source_title:
            document.source_title,

          publication_date:
            document.publication_date,

          source_document:
            document.source_document,

          authority:
            AUTHORITY
        }
      ],

      diagnostics:
        null
    };
  }


  return {

    id:
      document.id,

    source_title:
      document.source_title,

    publication_date:
      document.publication_date,

    measurement_category:
      document.measurement_category,

    source_document:
      document.source_document,

    final_url:
      downloaded.finalUrl,

    document_sha256:
      sha256(
        downloaded.buffer
      ),

    pdf_pages:
      parsed.numpages || null,

    text_length:
      text.length,

    format,

    asbestos_types:
      extractAsbestosTypes(
        text
      ),

    coordinate_count:
      extractCoordinates(
        text
      ).length,

    accepted_air_measurements:
      result.accepted,

    review_air_measurements:
      result.review,

    diagnostics:
      result.diagnostics || null,

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
    "VAS KORMÁNYHIVATAL – AZBESZT MONITOR"
  );

  console.log(
    "ÖNÁLLÓ LEVEGŐMÉRÉS PARSER – V4.2"
  );

  console.log(
    "MODERN PDF STRUKTURÁLT KINYERÉS"
  );

  console.log(
    "=========================================="
  );


  if (
    !fs.existsSync(
      INPUT_FILE
    )
  ) {

    throw new Error(
      `Hiányzó input: ${INPUT_FILE}`
    );
  }


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


  if (
    !documents.length
  ) {

    throw new Error(
      "Az official_measurements.json nem tartalmaz measurement rekordokat."
    );
  }


  console.log(
    `Mérési dokumentumok: ${documents.length}`
  );

  console.log("");


  const extractions = [];

  const accepted = [];

  const review = [];

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


    try {

      const result =
        await processDocument(
          document
        );


      extractions.push(
        result
      );


      accepted.push(
        ...result
          .accepted_air_measurements
      );


      review.push(
        ...result
          .review_air_measurements
      );


      success++;


      console.log(
        `  ↳ kategória: ${document.measurement_category}`
      );

      console.log(
        `  ↳ formátum: ${result.format.type}`
      );

      console.log(
        `  ↳ PDF oldalak: ${result.pdf_pages}`
      );

      console.log(
        `  ↳ koordináták: ${result.coordinate_count}`
      );

      console.log(
        `  ↳ elfogadott levegőmérések: ${result.accepted_air_measurements.length}`
      );

      console.log(
        `  ↳ review: ${result.review_air_measurements.length}`
      );


      if (
        result.diagnostics
      ) {

        console.log(
          `  ↳ minták: ${result.diagnostics.sample_count}`
        );

        console.log(
          `  ↳ koncentráció fejlécek: ${result.diagnostics.concentration_headers.length}`
        );

        console.log(
          `  ↳ levegővizsgálat markerek: ${result.diagnostics.air_marker_count}`
        );

        console.log(
          `  ↳ numerikus tokenek: ${result.diagnostics.numeric_token_count}`
        );
      }


      for (
        const measurement
        of result
          .accepted_air_measurements
      ) {

        console.log(
          `     ✓ ${measurement.sample_id}: ` +
          `${measurement.concentration_fibres_m3} rost/m3`
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

        extraction_status:
          "error",

        error:
          error.message
      });
    }


    console.log("");
  }


  /* =======================================================
     DUPLIKÁCIÓK KISZŰRÉSE
     ======================================================= */

  const acceptedUnique =
    uniqueBy(
      accepted,
      (item) =>
        [
          item.source_document,
          item.sample_id,
          item.concentration_fibres_m3
        ].join("|")
    );


  const reviewUnique =
    uniqueBy(
      review,
      (item) =>
        [
          item.source_document,
          item.sample_id,
          item.reason
        ].join("|")
    );


  /* =======================================================
     TECHNIKAI EXTRACTION OUTPUT
     ======================================================= */

  const extractionOutput = {

    schema_version:
      "4.2",

    parser:
      "independent_official_air_parser",

    parser_mode:
      "modern_table_extraction",

    generated_at:
      nowIso(),

    authority:
      AUTHORITY,

    statistics: {

      total_documents:
        documents.length,

      successful_documents:
        success,

      failed_documents:
        failed,

      accepted_air_measurements:
        acceptedUnique.length,

      review_items:
        reviewUnique.length
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

     FONTOS:
     modern_table rekord csak akkor kerülhet
     automatikusan a measurements tömbbe,
     ha a mintasor szerkezeti ellenőrzése sikeres.
     ======================================================= */

  const airOutput = {

    schema_version:
      "3.0",

    parser_version:
      "4.2",

    generated_at:
      nowIso(),

    authority:
      AUTHORITY,

    measurement_type:
      "air",

    unit:
      "rost/m3",

    methodology:
      "Only measurements structurally linked to an official sample row are published. Modern table rows are accepted only when sample ID, coordinates, dates/times and a concentration immediately preceding the air-volume marker can be identified.",

    measurement_count:
      acceptedUnique.length,

    review_count:
      reviewUnique.length,

    measurements:
      acceptedUnique,

    review_queue:
      reviewUnique
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
     VÉGSŐ ÖSSZEGZÉS
     ======================================================= */

  console.log("");

  console.log(
    "=========================================="
  );

  console.log(
    "V4.2 FELDOLGOZÁS KÉSZ"
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
    `Elfogadott levegőmérések: ${acceptedUnique.length}`
  );

  console.log(
    `Review: ${reviewUnique.length}`
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


  if (
    success === 0
  ) {
    process.exitCode = 2;
  }
}


/* =========================================================
   INDÍTÁS
   ========================================================= */

main().catch(
  (error) => {

    console.error("");

    console.error(
      "=========================================="
    );

    console.error(
      "VÉGZETES HIBA"
    );

    console.error(
      "=========================================="
    );

    console.error(
      error
    );

    process.exit(1);
  }
);
