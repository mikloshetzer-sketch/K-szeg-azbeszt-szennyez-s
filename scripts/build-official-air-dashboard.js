/**
 * Vas Vármegyei Kormányhivatal
 * Hivatalos azbeszt levegőmérések
 *
 * DASHBOARD DATA PROCESSOR – V1.0
 *
 * INPUT:
 *   data/official_air_measurements.json
 *
 * OUTPUT:
 *   data/official_air_dashboard.json
 *
 * Cél:
 * - a PDF parser által validált mérések átalakítása
 * - helyszínek normalizálása
 * - <100 típusú értékek helyes kezelése
 * - időrendi adatsor létrehozása
 * - térképes adatstruktúra létrehozása
 * - helyszínenkénti összesítés
 * - dashboard KPI-k előállítása
 *
 * FONTOS:
 * - ez a script NEM olvas PDF-et
 * - NEM módosítja a nyers hivatalos adatokat
 * - NEM talál ki hiányzó adatokat
 * - kizárólag az official_air_measurements.json
 *   elfogadott measurements rekordjait használja
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");

const INPUT_FILE = path.join(
  DATA_DIR,
  "official_air_measurements.json"
);

const OUTPUT_FILE = path.join(
  DATA_DIR,
  "official_air_dashboard.json"
);


/* =========================================================
   SEGÉDFÜGGVÉNYEK
   ========================================================= */

function nowIso() {
  return new Date().toISOString();
}


function round(value, digits = 0) {

  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ) {
    return null;
  }

  const factor =
    10 ** digits;

  return (
    Math.round(
      Number(value) * factor
    ) / factor
  );
}


function median(values) {

  const valid =
    values
      .filter(
        (value) =>
          Number.isFinite(value)
      )
      .sort(
        (a, b) =>
          a - b
      );

  if (!valid.length) {
    return null;
  }

  const middle =
    Math.floor(
      valid.length / 2
    );

  if (
    valid.length % 2 === 0
  ) {

    return (
      valid[middle - 1] +
      valid[middle]
    ) / 2;
  }

  return valid[middle];
}


function unique(values) {

  return [
    ...new Set(
      values.filter(
        (value) =>
          value !== null &&
          value !== undefined &&
          value !== ""
      )
    )
  ];
}


function normalizeSpace(value) {

  return String(
    value || ""
  )
    .replace(/\s+/g, " ")
    .trim();
}


/* =========================================================
   DÁTUMKEZELÉS
   ========================================================= */

function parseMeasurementDate(
  measurement
) {

  /*
   * Elsődleges:
   * start mező
   *
   * Példa:
   * 2026-07-30 11:39
   */

  if (
    measurement.start
  ) {

    const match =
      String(
        measurement.start
      ).match(
        /^(\d{4})-(\d{2})-(\d{2})/
      );

    if (match) {

      return (
        `${match[1]}-${match[2]}-${match[3]}`
      );
    }
  }


  /*
   * Másodlagos:
   * publication_date
   *
   * Ezt csak dokumentum-dátumként
   * tartjuk meg.
   */

  return null;
}


function getTimestamp(
  measurement
) {

  if (!measurement.start) {
    return null;
  }

  const raw =
    String(
      measurement.start
    ).trim();

  /*
   * 2026-07-30 11:39
   */

  const normalized =
    raw.replace(
      " ",
      "T"
    );

  const timestamp =
    Date.parse(
      normalized
    );

  return Number.isFinite(
    timestamp
  )
    ? timestamp
    : null;
}


/* =========================================================
   TELEPÜLÉS AZONOSÍTÁSA

   Csak a már meglévő location/source mezőből.
   ========================================================= */

function detectSettlement(
  measurement
) {

  const existing =
    normalizeSpace(
      measurement.settlement
    );

  if (existing) {
    return existing;
  }


  const text =
    [
      measurement.location,
      measurement.source_title
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();


  if (
    text.includes("kőszeg") ||
    text.includes("koszeg") ||
    text.includes("hermina") ||
    text.includes("borostyán")
  ) {

    return "Kőszeg";
  }


  if (
    text.includes("sé ") ||
    text.startsWith("sé") ||
    text.includes(" sé,") ||
    text.includes("sé-")
  ) {

    return "Sé";
  }


  if (
    text.includes("szombathely") ||
    text.includes("oladi") ||
    text.includes("síp utca") ||
    text.includes("sáfrány") ||
    text.includes("menta utca") ||
    text.includes("márton áron")
  ) {

    return "Szombathely";
  }


  return null;
}


/* =========================================================
   HELYSZÍN NORMALIZÁLÁSA

   Nem találunk ki új helyszínt.
   Csak a parser által kinyert szöveget
   tisztítjuk.
   ========================================================= */

function normalizeLocation(
  measurement
) {

  const location =
    normalizeSpace(
      measurement.location
    );

  if (!location) {
    return null;
  }

  return location
    .replace(
      /\s*,\s*/g,
      ", "
    )
    .replace(
      /\s*;\s*/g,
      "; "
    )
    .trim();
}


/* =========================================================
   MÉRÉSI ÉRTÉK

   Nagyon fontos:

   <100 NEM egyenlő 100-zal.

   A raw numeric value megmarad 100-nak,
   de külön mező jelzi, hogy ez csak
   felső kimutatási határ.

   Elemzési átlagba alapértelmezés szerint
   NEM tesszük bele.
   ========================================================= */

function normalizeConcentration(
  measurement
) {

  const rawValue =
    Number(
      measurement
        .concentration_fibres_m3
    );


  if (
    !Number.isFinite(rawValue)
  ) {

    return {

      value:
        null,

      display:
        null,

      below_detection_limit:
        false,

      detection_limit:
        null,

      numeric_for_statistics:
        null
    };
  }


  const belowLimit =
    measurement
      .below_detection_limit === true;


  if (belowLimit) {

    return {

      /*
       * A forrásból kiolvasott
       * határérték.
       */

      value:
        rawValue,

      /*
       * Dashboardon így jelenjen meg.
       */

      display:
        `<${rawValue}`,

      below_detection_limit:
        true,

      detection_limit:
        rawValue,

      /*
       * Nem kezeljük 100-as
       * tényleges mérésként.
       */

      numeric_for_statistics:
        null
    };
  }


  return {

    value:
      rawValue,

    display:
      String(
        rawValue
      ),

    below_detection_limit:
      false,

    detection_limit:
      null,

    numeric_for_statistics:
      rawValue
  };
}


/* =========================================================
   STABIL HELYSZÍN-AZONOSÍTÓ

   GPS alapján.

   Így ugyanaz a mérőhely akkor is
   összekapcsolható, ha a location
   szöveg kissé eltér.
   ========================================================= */

function buildSiteId(
  measurement,
  settlement
) {

  const lat =
    Number(
      measurement.lat
    );

  const lon =
    Number(
      measurement.lon
    );


  if (
    Number.isFinite(lat) &&
    Number.isFinite(lon)
  ) {

    return (
      `${settlement || "unknown"}_` +
      `${lat.toFixed(5)}_` +
      `${lon.toFixed(5)}`
    )
      .toLowerCase()
      .replace(
        /[^a-z0-9áéíóöőúüű_.-]+/gi,
        "_"
      );
  }


  const location =
    normalizeLocation(
      measurement
    );


  return (
    `${settlement || "unknown"}_` +
    `${location || measurement.sample_id || "unknown"}`
  )
    .toLowerCase()
    .replace(
      /[^a-z0-9áéíóöőúüű_.-]+/gi,
      "_"
    );
}


/* =========================================================
   EGY MÉRÉSI REKORD ÁTALAKÍTÁSA
   ========================================================= */

function buildMeasurementRecord(
  measurement,
  index
) {

  const settlement =
    detectSettlement(
      measurement
    );


  const location =
    normalizeLocation(
      measurement
    );


  const concentration =
    normalizeConcentration(
      measurement
    );


  const date =
    parseMeasurementDate(
      measurement
    );


  const timestamp =
    getTimestamp(
      measurement
    );


  const siteId =
    buildSiteId(
      measurement,
      settlement
    );


  return {

    id:
      `air_${String(index + 1).padStart(4, "0")}`,

    sample_id:
      measurement.sample_id || null,

    site_id:
      siteId,

    settlement,

    location,

    coordinates: {

      lat:
        Number.isFinite(
          Number(
            measurement.lat
          )
        )
          ? Number(
              measurement.lat
            )
          : null,

      lon:
        Number.isFinite(
          Number(
            measurement.lon
          )
        )
          ? Number(
              measurement.lon
            )
          : null
    },

    date,

    start:
      measurement.start || null,

    end:
      measurement.end || null,

    timestamp,

    concentration: {

      value:
        concentration.value,

      display:
        concentration.display,

      unit:
        "rost/m3",

      below_detection_limit:
        concentration
          .below_detection_limit,

      detection_limit:
        concentration
          .detection_limit,

      numeric_for_statistics:
        concentration
          .numeric_for_statistics
    },

    parser:
      measurement.parser || null,

    confidence:
      measurement.confidence || null,

    source: {

      authority:
        measurement.authority || null,

      title:
        measurement.source_title || null,

      publication_date:
        measurement.publication_date || null,

      document:
        measurement.source_document || null
    }
  };
}


/* =========================================================
   HELYSZÍN ÖSSZESÍTÉS
   ========================================================= */

function buildSites(
  measurements
) {

  const groups =
    new Map();


  for (
    const measurement
    of measurements
  ) {

    if (
      !groups.has(
        measurement.site_id
      )
    ) {

      groups.set(
        measurement.site_id,
        []
      );
    }


    groups
      .get(
        measurement.site_id
      )
      .push(
        measurement
      );
  }


  const sites = [];


  for (
    const [siteId, rows]
    of groups.entries()
  ) {

    const sorted =
      [...rows]
        .sort(
          (a, b) => {

            if (
              a.timestamp === null &&
              b.timestamp === null
            ) {
              return 0;
            }

            if (
              a.timestamp === null
            ) {
              return 1;
            }

            if (
              b.timestamp === null
            ) {
              return -1;
            }

            return (
              a.timestamp -
              b.timestamp
            );
          }
        );


    const statisticalValues =
      sorted
        .map(
          (row) =>
            row
              .concentration
              .numeric_for_statistics
        )
        .filter(
          (value) =>
            Number.isFinite(value)
        );


    const belowLimitCount =
      sorted.filter(
        (row) =>
          row
            .concentration
            .below_detection_limit
      ).length;


    const latest =
      sorted.length
        ? sorted[
            sorted.length - 1
          ]
        : null;


    const first =
      sorted.length
        ? sorted[0]
        : null;


    const maxValue =
      statisticalValues.length
        ? Math.max(
            ...statisticalValues
          )
        : null;


    const minValue =
      statisticalValues.length
        ? Math.min(
            ...statisticalValues
          )
        : null;


    const average =
      statisticalValues.length
        ? statisticalValues
            .reduce(
              (sum, value) =>
                sum + value,
              0
            ) /
          statisticalValues.length
        : null;


    sites.push({

      site_id:
        siteId,

      settlement:
        first?.settlement || null,

      location:
        first?.location || null,

      coordinates:
        first?.coordinates || {
          lat: null,
          lon: null
        },

      measurement_count:
        sorted.length,

      numeric_measurement_count:
        statisticalValues.length,

      below_detection_limit_count:
        belowLimitCount,

      first_measurement_date:
        first?.date || null,

      latest_measurement_date:
        latest?.date || null,

      statistics: {

        min_fibres_m3:
          round(
            minValue
          ),

        max_fibres_m3:
          round(
            maxValue
          ),

        mean_fibres_m3:
          round(
            average
          ),

        median_fibres_m3:
          round(
            median(
              statisticalValues
            )
          )
      },

      latest_measurement:
        latest
          ? {

              sample_id:
                latest.sample_id,

              date:
                latest.date,

              start:
                latest.start,

              concentration:
                latest.concentration
            }
          : null,

      measurement_ids:
        sorted.map(
          (row) =>
            row.id
        )
    });
  }


  return sites.sort(
    (a, b) => {

      const settlementCompare =
        String(
          a.settlement || ""
        ).localeCompare(
          String(
            b.settlement || ""
        ),
        "hu"
        );


      if (
        settlementCompare !== 0
      ) {
        return settlementCompare;
      }


      return String(
        a.location || ""
      ).localeCompare(
        String(
          b.location || ""
        ),
        "hu"
      );
    }
  );
}


/* =========================================================
   TELEPÜLÉS ÖSSZESÍTÉS
   ========================================================= */

function buildSettlements(
  measurements
) {

  const groups =
    new Map();


  for (
    const row
    of measurements
  ) {

    const key =
      row.settlement ||
      "Ismeretlen";


    if (
      !groups.has(key)
    ) {

      groups.set(
        key,
        []
      );
    }


    groups
      .get(key)
      .push(row);
  }


  const output = [];


  for (
    const [settlement, rows]
    of groups.entries()
  ) {

    const numeric =
      rows
        .map(
          (row) =>
            row
              .concentration
              .numeric_for_statistics
        )
        .filter(
          (value) =>
            Number.isFinite(value)
        );


    const dates =
      rows
        .map(
          (row) =>
            row.date
        )
        .filter(Boolean)
        .sort();


    output.push({

      settlement,

      measurement_count:
        rows.length,

      site_count:
        unique(
          rows.map(
            (row) =>
              row.site_id
          )
        ).length,

      below_detection_limit_count:
        rows.filter(
          (row) =>
            row
              .concentration
              .below_detection_limit
        ).length,

      first_measurement_date:
        dates[0] || null,

      latest_measurement_date:
        dates.length
          ? dates[
              dates.length - 1
            ]
          : null,

      statistics: {

        min_fibres_m3:
          numeric.length
            ? Math.min(
                ...numeric
              )
            : null,

        max_fibres_m3:
          numeric.length
            ? Math.max(
                ...numeric
              )
            : null,

        mean_fibres_m3:
          numeric.length
            ? round(
                numeric.reduce(
                  (sum, value) =>
                    sum + value,
                  0
                ) /
                numeric.length
              )
            : null,

        median_fibres_m3:
          round(
            median(
              numeric
            )
          )
      }
    });
  }


  return output.sort(
    (a, b) =>
      a.settlement.localeCompare(
        b.settlement,
        "hu"
      )
  );
}


/* =========================================================
   IDŐSOR
   ========================================================= */

function buildTimeline(
  measurements
) {

  return [...measurements]
    .sort(
      (a, b) => {

        if (
          a.timestamp === null &&
          b.timestamp === null
        ) {
          return 0;
        }

        if (
          a.timestamp === null
        ) {
          return 1;
        }

        if (
          b.timestamp === null
        ) {
          return -1;
        }

        return (
          a.timestamp -
          b.timestamp
        );
      }
    )
    .map(
      (row) => ({

        id:
          row.id,

        sample_id:
          row.sample_id,

        date:
          row.date,

        start:
          row.start,

        end:
          row.end,

        settlement:
          row.settlement,

        location:
          row.location,

        site_id:
          row.site_id,

        lat:
          row.coordinates.lat,

        lon:
          row.coordinates.lon,

        concentration_fibres_m3:
          row
            .concentration
            .value,

        display_value:
          row
            .concentration
            .display,

        below_detection_limit:
          row
            .concentration
            .below_detection_limit,

        source_document:
          row
            .source
            .document
      })
    );
}


/* =========================================================
   TÉRKÉP ADAT
   ========================================================= */

function buildMapPoints(
  sites
) {

  return sites
    .filter(
      (site) =>
        Number.isFinite(
          site.coordinates.lat
        ) &&
        Number.isFinite(
          site.coordinates.lon
        )
    )
    .map(
      (site) => ({

        site_id:
          site.site_id,

        settlement:
          site.settlement,

        location:
          site.location,

        lat:
          site.coordinates.lat,

        lon:
          site.coordinates.lon,

        measurement_count:
          site.measurement_count,

        below_detection_limit_count:
          site
            .below_detection_limit_count,

        max_fibres_m3:
          site
            .statistics
            .max_fibres_m3,

        mean_fibres_m3:
          site
            .statistics
            .mean_fibres_m3,

        median_fibres_m3:
          site
            .statistics
            .median_fibres_m3,

        latest_measurement:
          site.latest_measurement
      })
    );
}


/* =========================================================
   KPI
   ========================================================= */

function buildKpis(
  measurements,
  sites,
  settlements
) {

  const numeric =
    measurements
      .map(
        (row) =>
          row
            .concentration
            .numeric_for_statistics
      )
      .filter(
        (value) =>
          Number.isFinite(value)
      );


  const dates =
    measurements
      .map(
        (row) =>
          row.date
      )
      .filter(Boolean)
      .sort();


  return {

    total_measurements:
      measurements.length,

    numeric_measurements:
      numeric.length,

    below_detection_limit_measurements:
      measurements.filter(
        (row) =>
          row
            .concentration
            .below_detection_limit
      ).length,

    mapped_measurements:
      measurements.filter(
        (row) =>
          Number.isFinite(
            row.coordinates.lat
          ) &&
          Number.isFinite(
            row.coordinates.lon
          )
      ).length,

    site_count:
      sites.length,

    settlement_count:
      settlements.length,

    first_measurement_date:
      dates[0] || null,

    latest_measurement_date:
      dates.length
        ? dates[
            dates.length - 1
          ]
        : null,

    maximum_measured_fibres_m3:
      numeric.length
        ? Math.max(
            ...numeric
          )
        : null,

    minimum_measured_fibres_m3:
      numeric.length
        ? Math.min(
            ...numeric
          )
        : null,

    mean_measured_fibres_m3:
      numeric.length
        ? round(
            numeric.reduce(
              (sum, value) =>
                sum + value,
              0
            ) /
            numeric.length
          )
        : null,

    median_measured_fibres_m3:
      round(
        median(
          numeric
        )
      )
  };
}


/* =========================================================
   ADATMINŐSÉG
   ========================================================= */

function buildDataQuality(
  measurements
) {

  return {

    missing_coordinates:
      measurements
        .filter(
          (row) =>
            !Number.isFinite(
              row.coordinates.lat
            ) ||
            !Number.isFinite(
              row.coordinates.lon
            )
        )
        .map(
          (row) =>
            row.sample_id
        ),

    missing_measurement_date:
      measurements
        .filter(
          (row) =>
            !row.date
        )
        .map(
          (row) =>
            row.sample_id
        ),

    missing_location:
      measurements
        .filter(
          (row) =>
            !row.location
        )
        .map(
          (row) =>
            row.sample_id
        ),

    missing_settlement:
      measurements
        .filter(
          (row) =>
            !row.settlement
        )
        .map(
          (row) =>
            row.sample_id
        ),

    below_detection_limit:
      measurements
        .filter(
          (row) =>
            row
              .concentration
              .below_detection_limit
        )
        .map(
          (row) => ({

            sample_id:
              row.sample_id,

            display:
              row
                .concentration
                .display
          })
        )
  };
}


/* =========================================================
   MAIN
   ========================================================= */

function main() {

  console.log(
    "=========================================="
  );

  console.log(
    "HIVATALOS AZBESZT LEVEGŐMÉRÉSEK"
  );

  console.log(
    "DASHBOARD DATA PROCESSOR – V1.0"
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
      `Hiányzó input fájl: ${INPUT_FILE}`
    );
  }


  const input =
    JSON.parse(
      fs.readFileSync(
        INPUT_FILE,
        "utf8"
      )
    );


  const sourceMeasurements =
    Array.isArray(
      input.measurements
    )
      ? input.measurements
      : [];


  if (
    !sourceMeasurements.length
  ) {

    throw new Error(
      "Az official_air_measurements.json nem tartalmaz measurements rekordokat."
    );
  }


  console.log(
    `Forrás mérések: ${sourceMeasurements.length}`
  );


  /* =======================================================
     NORMALIZÁLÁS
     ======================================================= */

  const measurements =
    sourceMeasurements.map(
      (
        measurement,
        index
      ) =>
        buildMeasurementRecord(
          measurement,
          index
        )
    );


  /* =======================================================
     ÖSSZESÍTÉSEK
     ======================================================= */

  const sites =
    buildSites(
      measurements
    );


  const settlements =
    buildSettlements(
      measurements
    );


  const timeline =
    buildTimeline(
      measurements
    );


  const mapPoints =
    buildMapPoints(
      sites
    );


  const kpis =
    buildKpis(
      measurements,
      sites,
      settlements
    );


  const dataQuality =
    buildDataQuality(
      measurements
    );


  /* =======================================================
     OUTPUT
     ======================================================= */

  const output = {

    schema_version:
      "1.0",

    generated_at:
      nowIso(),

    dataset:
      "Vas Vármegyei Kormányhivatal – hivatalos azbeszt levegőmérések",

    authority:
      input.authority ||
      "Vas Vármegyei Kormányhivatal",

    source_file:
      "official_air_measurements.json",

    source_parser_version:
      input.parser_version || null,

    measurement_type:
      "air",

    unit:
      "rost/m3",

    notes: {

      detection_limit:
        "A kimutatási határ alatti értékeket a rendszer nem kezeli tényleges numerikus mérésként. Például a <100 érték display formában <100 marad, és nem kerül bele az átlag-, medián-, minimum- vagy maximumszámításba.",

      statistics:
        "A statisztikai mutatók kizárólag a számszerűen meghatározott mérési eredményekből készülnek.",

      provenance:
        "A dashboard adatfájl kizárólag az official_air_measurements.json elfogadott mérési rekordjaiból épül fel."
    },

    kpis,

    settlements,

    sites,

    map_points:
      mapPoints,

    timeline,

    measurements,

    data_quality:
      dataQuality
  };


  fs.writeFileSync(

    OUTPUT_FILE,

    JSON.stringify(
      output,
      null,
      2
    ),

    "utf8"
  );


  /* =======================================================
     VALIDÁCIÓ
     ======================================================= */

  const written =
    JSON.parse(
      fs.readFileSync(
        OUTPUT_FILE,
        "utf8"
      )
    );


  if (
    written.measurements.length !==
    sourceMeasurements.length
  ) {

    throw new Error(
      "Validációs hiba: a kimeneti mérésszám eltér a forrástól."
    );
  }


  console.log("");

  console.log(
    "=========================================="
  );

  console.log(
    "DASHBOARD ADAT ELKÉSZÜLT"
  );

  console.log(
    "=========================================="
  );

  console.log(
    `Mérések: ${measurements.length}`
  );

  console.log(
    `Mérőhelyek: ${sites.length}`
  );

  console.log(
    `Települések: ${settlements.length}`
  );

  console.log(
    `Térképezhető helyek: ${mapPoints.length}`
  );

  console.log(
    `Kimutatási határ alatti mérések: ${kpis.below_detection_limit_measurements}`
  );

  console.log(
    `Hiányzó koordináták: ${dataQuality.missing_coordinates.length}`
  );

  console.log(
    `Hiányzó dátumok: ${dataQuality.missing_measurement_date.length}`
  );

  console.log(
    `Hiányzó helyszínek: ${dataQuality.missing_location.length}`
  );

  console.log("");

  console.log(
    `Mentve: ${OUTPUT_FILE}`
  );

  console.log(
    "=========================================="
  );
}


/* =========================================================
   INDÍTÁS
   ========================================================= */

try {

  main();

} catch (error) {

  console.error("");

  console.error(
    "=========================================="
  );

  console.error(
    "DASHBOARD PROCESSOR HIBA"
  );

  console.error(
    "=========================================="
  );

  console.error(
    error
  );

  process.exit(1);
}
