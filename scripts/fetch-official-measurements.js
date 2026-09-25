const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SOURCE_PAGE =
  "https://kormanyhivatalok.hu/kormanyhivatalok/vas/megye/hirek/hir/azbesztszennyezes-legfontosabb-lakossagi-informaciok";

const OUTPUT_DIR = path.join(__dirname, "..", "data");

const DOCUMENTS_FILE = path.join(
  OUTPUT_DIR,
  "official_documents.json"
);

const MEASUREMENTS_FILE = path.join(
  OUTPUT_DIR,
  "official_measurements.json"
);

const AUTHORITY = "Vas Vármegyei Kormányhivatal";

const USER_AGENT =
  "Koszeg-Asbestos-Monitor/1.0 (+GitHub Actions; public environmental monitoring)";


/* =========================================================
   SEGÉDFÜGGVÉNYEK
   ========================================================= */

function nowIso() {
  return new Date().toISOString();
}

function normalizeWhitespace(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => {
      const n = Number(code);
      return Number.isFinite(n)
        ? String.fromCharCode(n)
        : _;
    });
}

function stripTags(html) {
  return normalizeWhitespace(
    decodeHtmlEntities(
      String(html || "")
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
    )
  );
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return null;
  }
}

function sha256(buffer) {
  return crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");
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
      `Nem sikerült beolvasni: ${file}`,
      error.message
    );

    return fallback;
  }
}

function saveJson(file, data) {
  fs.mkdirSync(
    path.dirname(file),
    { recursive: true }
  );

  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}


/* =========================================================
   HTTP
   ========================================================= */

async function fetchPage(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${url}`
    );
  }

  return await response.text();
}

async function fetchBinary(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "*/*"
    },
    redirect: "follow"
  });

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${url}`
    );
  }

  const arrayBuffer =
    await response.arrayBuffer();

  return {
    buffer: Buffer.from(arrayBuffer),
    contentType:
      response.headers.get("content-type") || null,
    finalUrl: response.url || url
  };
}


/* =========================================================
   DÁTUMFELISMERÉS
   ========================================================= */

function normalizeDate(text) {
  if (!text) return null;

  const match = String(text).match(
    /(20\d{2})[.\-\/]\s*(\d{1,2})[.\-\/]\s*(\d{1,2})/
  );

  if (!match) {
    return null;
  }

  const year = match[1];
  const month = String(match[2]).padStart(2, "0");
  const day = String(match[3]).padStart(2, "0");

  return `${year}-${month}-${day}`;
}


/* =========================================================
   DOKUMENTUMTÍPUS
   ========================================================= */

function classifyDocument(title) {
  const text =
    String(title || "").toLowerCase();

  if (
    text.includes("levegő") ||
    text.includes("mérési eredmény")
  ) {
    return "air_measurement";
  }

  if (
    text.includes("kőzetvizsgálat") ||
    text.includes("kőzetvizsgalat")
  ) {
    return "rock_measurement";
  }

  if (text.includes("hatósági")) {
    return "authority_document";
  }

  if (text.includes("szakértői")) {
    return "expert_document";
  }

  if (text.includes("tájékoztató")) {
    return "information";
  }

  if (text.includes("térkép")) {
    return "map";
  }

  return "other";
}

function detectPlaces(title) {
  const text =
    String(title || "").toLowerCase();

  const places = [];

  const knownPlaces = [
    ["Kőszeg", "kőszeg"],
    ["Szombathely", "szombathely"],
    ["Oladi plató", "oladi plató"],
    ["Sé", "sé"]
  ];

  for (const [name, needle] of knownPlaces) {
    if (text.includes(needle)) {
      places.push(name);
    }
  }

  return [...new Set(places)];
}


/* =========================================================
   LINK + DÁTUM KINYERÉS
   ========================================================= */

function extractOfficialDocuments(html) {
  /*
   * A dátumok és a linkek sorrendjét is megőrizzük.
   * A dokumentum az előtte utoljára látott YYYY.MM.DD.
   * dátumot kapja publikálási dátumként.
   */

  const tokenRegex =
    /((?:20\d{2})\.\s*\d{1,2}\.\s*\d{1,2}\.)|<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;

  let currentDate = null;
  let match;

  const documents = [];
  const seenUrls = new Set();

  while (
    (match = tokenRegex.exec(html)) !== null
  ) {
    if (match[1]) {
      currentDate =
        normalizeDate(match[1]);

      continue;
    }

    const href = match[2];
    const title =
      stripTags(match[3]);

    if (!href || !title) {
      continue;
    }

    const url =
      absoluteUrl(href, SOURCE_PAGE);

    if (!url) {
      continue;
    }

    /*
     * Csak a Kormányhivatal saját oldalához/
     * dokumentumtárához tartozó tartalmak.
     */
    let host;

    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }

    if (
      host !== "kormanyhivatalok.hu" &&
      !host.endsWith(".kormanyhivatalok.hu")
    ) {
      continue;
    }

    /*
     * Az oldal navigációs linkjeit nem akarjuk
     * dokumentumként eltárolni.
     */
    const relevantTitle =
      /azbeszt|kőzet|kőzetvizsg|mér|levegő|hatóság|szakért|tájékozt|fórum|maszk|térkép|kőszeg|szombathely|oladi|sé/i
        .test(title);

    if (!relevantTitle) {
      continue;
    }

    if (seenUrls.has(url)) {
      continue;
    }

    seenUrls.add(url);

    documents.push({
      title,
      url,
      publication_date: currentDate,
      document_type:
        classifyDocument(title),
      places:
        detectPlaces(title)
    });
  }

  return documents;
}


/* =========================================================
   MEGLÉVŐ NYILVÁNTARTÁS
   ========================================================= */

function previousDocumentsByUrl(existing) {
  const map = new Map();

  for (
    const item of existing.documents || []
  ) {
    if (item.url) {
      map.set(item.url, item);
    }
  }

  return map;
}


/* =========================================================
   DOKUMENTUM ELLENŐRZÉS
   ========================================================= */

async function inspectDocument(
  document,
  previous
) {
  const checkedAt = nowIso();

  try {
    const downloaded =
      await fetchBinary(document.url);

    const hash =
      sha256(downloaded.buffer);

    const changed =
      previous
        ? previous.sha256 !== hash
        : false;

    return {
      ...document,

      source_class:
        "primary_official",

      authority:
        AUTHORITY,

      source_page:
        SOURCE_PAGE,

      final_url:
        downloaded.finalUrl,

      content_type:
        downloaded.contentType,

      size_bytes:
        downloaded.buffer.length,

      sha256: hash,

      first_seen:
        previous?.first_seen ||
        checkedAt,

      last_checked:
        checkedAt,

      changed_since_previous:
        changed,

      previous_sha256:
        changed
          ? previous?.sha256 || null
          : null,

      download_status:
        "ok"
    };

  } catch (error) {
    console.warn(
      `Dokumentum letöltési hiba: ${document.url} -> ${error.message}`
    );

    return {
      ...document,

      source_class:
        "primary_official",

      authority:
        AUTHORITY,

      source_page:
        SOURCE_PAGE,

      first_seen:
        previous?.first_seen ||
        checkedAt,

      last_checked:
        checkedAt,

      sha256:
        previous?.sha256 || null,

      content_type:
        previous?.content_type || null,

      size_bytes:
        previous?.size_bytes || null,

      changed_since_previous:
        false,

      download_status:
        "error",

      error:
        error.message
    };
  }
}


/* =========================================================
   MÉRÉSI INDEX
   ========================================================= */

function buildMeasurementIndex(
  documents,
  existingMeasurements
) {
  /*
   * Ebben az első stabil verzióban
   * NEM találunk ki mérési értékeket.
   *
   * A measurement index a hivatalosan
   * azonosított mérési dokumentumokat
   * tartja nyilván.
   *
   * A következő modul fogja a PDF-ekből
   * a tényleges értékeket kinyerni.
   */

  const measurementDocuments =
    documents.filter(
      (doc) =>
        doc.document_type ===
          "air_measurement" ||
        doc.document_type ===
          "rock_measurement"
    );

  const previous =
    new Map();

  for (
    const item of
      existingMeasurements.measurements || []
  ) {
    if (item.source_document) {
      previous.set(
        item.source_document,
        item
      );
    }
  }

  const measurements =
    measurementDocuments.map(
      (doc) => {
        const old =
          previous.get(doc.url);

        return {
          id:
            old?.id ||
            crypto
              .createHash("sha1")
              .update(doc.url)
              .digest("hex")
              .slice(0, 16),

          measurement_category:
            doc.document_type ===
            "air_measurement"
              ? "air"
              : "rock",

          places:
            doc.places || [],

          publication_date:
            doc.publication_date,

          source_class:
            "primary_official",

          authority:
            AUTHORITY,

          source_page:
            SOURCE_PAGE,

          source_document:
            doc.url,

          source_title:
            doc.title,

          document_sha256:
            doc.sha256,

          document_status:
            doc.download_status,

          extraction_status:
            "pending",

          /*
           * Ezeket a következő,
           * PDF-adatkinyerő modul tölti fel.
           */
          measurement_date:
            old?.measurement_date || null,

          location:
            old?.location || null,

          coordinates:
            old?.coordinates || null,

          values:
            old?.values || [],

          asbestos_types:
            old?.asbestos_types || [],

          first_seen:
            old?.first_seen ||
            doc.first_seen,

          last_checked:
            doc.last_checked
        };
      }
    );

  return {
    schema_version: "1.0",

    generated_at:
      nowIso(),

    source_class:
      "primary_official",

    authority:
      AUTHORITY,

    source_page:
      SOURCE_PAGE,

    total_measurement_documents:
      measurements.length,

    measurements
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
    "=========================================="
  );

  console.log(
    `Forrás: ${SOURCE_PAGE}`
  );

  console.log("");


  /* -------------------------------------------------------
     1. Korábbi állapot
     ------------------------------------------------------- */

  const existingDocuments =
    loadJson(
      DOCUMENTS_FILE,
      {
        documents: []
      }
    );

  const existingMeasurements =
    loadJson(
      MEASUREMENTS_FILE,
      {
        measurements: []
      }
    );

  const oldByUrl =
    previousDocumentsByUrl(
      existingDocuments
    );


  /* -------------------------------------------------------
     2. Hivatalos oldal
     ------------------------------------------------------- */

  console.log(
    "Hivatalos azbesztoldal letöltése..."
  );

  const html =
    await fetchPage(SOURCE_PAGE);


  /* -------------------------------------------------------
     3. Teljes történeti dokumentumlista
     ------------------------------------------------------- */

  const discovered =
    extractOfficialDocuments(html);

  console.log(
    `Azonosított releváns hivatalos dokumentumok: ${discovered.length}`
  );


  /* -------------------------------------------------------
     4. Dokumentumok ellenőrzése
     ------------------------------------------------------- */

  const documents = [];

  let newCount = 0;
  let changedCount = 0;
  let errorCount = 0;

  for (
    let i = 0;
    i < discovered.length;
    i++
  ) {
    const doc =
      discovered[i];

    const previous =
      oldByUrl.get(doc.url);

    if (!previous) {
      newCount++;
    }

    console.log(
      `[${i + 1}/${discovered.length}] ${doc.publication_date || "nincs dátum"} | ${doc.title}`
    );

    const inspected =
      await inspectDocument(
        doc,
        previous
      );

    if (
      inspected.changed_since_previous
    ) {
      changedCount++;
    }

    if (
      inspected.download_status ===
      "error"
    ) {
      errorCount++;
    }

    documents.push(inspected);
  }


  /* -------------------------------------------------------
     5. Dokumentumnyilvántartás
     ------------------------------------------------------- */

  const officialDocuments = {
    schema_version: "1.0",

    generated_at:
      nowIso(),

    source_class:
      "primary_official",

    authority:
      AUTHORITY,

    source_page:
      SOURCE_PAGE,

    statistics: {
      total_documents:
        documents.length,

      new_documents:
        newCount,

      changed_documents:
        changedCount,

      download_errors:
        errorCount,

      air_measurement_documents:
        documents.filter(
          (d) =>
            d.document_type ===
            "air_measurement"
        ).length,

      rock_measurement_documents:
        documents.filter(
          (d) =>
            d.document_type ===
            "rock_measurement"
        ).length
    },

    documents
  };


  /* -------------------------------------------------------
     6. Mérési dokumentum-index
     ------------------------------------------------------- */

  const officialMeasurements =
    buildMeasurementIndex(
      documents,
      existingMeasurements
    );


  /* -------------------------------------------------------
     7. Mentés
     ------------------------------------------------------- */

  saveJson(
    DOCUMENTS_FILE,
    officialDocuments
  );

  saveJson(
    MEASUREMENTS_FILE,
    officialMeasurements
  );


  /* -------------------------------------------------------
     8. Összegzés
     ------------------------------------------------------- */

  console.log("");
  console.log(
    "=========================================="
  );

  console.log(
    "FELDOLGOZÁS KÉSZ"
  );

  console.log(
    "=========================================="
  );

  console.log(
    `Hivatalos dokumentumok: ${documents.length}`
  );

  console.log(
    `Új dokumentumok: ${newCount}`
  );

  console.log(
    `Megváltozott dokumentumok: ${changedCount}`
  );

  console.log(
    `Letöltési hibák: ${errorCount}`
  );

  console.log(
    `Levegőmérési dokumentumok: ${
      officialDocuments.statistics
        .air_measurement_documents
    }`
  );

  console.log(
    `Kőzetvizsgálati dokumentumok: ${
      officialDocuments.statistics
        .rock_measurement_documents
    }`
  );

  console.log(
    `Mérési dokumentumok összesen: ${
      officialMeasurements
        .total_measurement_documents
    }`
  );

  console.log("");
  console.log(
    `Mentve: ${DOCUMENTS_FILE}`
  );

  console.log(
    `Mentve: ${MEASUREMENTS_FILE}`
  );

  console.log(
    "=========================================="
  );
}


main().catch((error) => {
  console.error(
    "Végzetes hiba:",
    error
  );

  process.exitCode = 1;
});
