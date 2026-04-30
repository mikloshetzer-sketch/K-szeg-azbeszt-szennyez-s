const fs = require("fs");
const path = require("path");

const INPUT_FILE = path.join(__dirname, "data", "news.json");
const OUTPUT_FILE = path.join(__dirname, "data", "news_scores.json");

const SOURCE_WEIGHTS = {
  official: 1.25,
  civil: 1.15,
  media: 1.0,
  austrian: 1.0,
  other: 0.8
};

const NEGATIVE_RULES = [
  {
    category: "egeszsegugyi_kockazat",
    score: -5,
    keywords: ["azbesztveszely", "egeszsegugyi veszely", "rakkelto", "veszelyes por", "hatarertek-tullepes", "mergezik"]
  },
  {
    category: "szennyezes_vagy_gyanu",
    score: -4,
    keywords: ["azbesztszennyezes", "szennyezett", "azbeszttel szennyezett", "azbeszttartalmu", "szennyezes gyanuja"]
  },
  {
    category: "uj_erintett_terulet",
    score: -4,
    keywords: ["koszegre is", "bozsok", "erintett lehet", "juthatott", "kerulhetett", "tovabbi utcak"]
  },
  {
    category: "korlatozas",
    score: -2,
    keywords: ["lezarjak", "lezaras", "korlatozas", "10 km/h", "behajtas", "leallitjak"]
  },
  {
    category: "bizonytalansag_vita",
    score: -3,
    keywords: ["nincs is szennyezes", "vitatja", "bizonytalan", "ujranyitnanak", "forras nincs"]
  }
];

const POSITIVE_RULES = [
  {
    category: "hatosagi_intezkedes",
    score: 3,
    keywords: ["hatosagi eljaras", "rendorsegi eljaras", "vizsgalat indult", "intezkedes", "intezkedesek", "hatosagilag bezart"]
  },
  {
    category: "jogi_lepes",
    score: 2,
    keywords: ["feljelentest tett", "feljelentes", "jogi lepes"]
  },
  {
    category: "lakossagi_tajekoztatas",
    score: 2,
    keywords: ["lakossagi forum", "tajekoztato", "tajekoztatta", "lakossagi informaciok", "kozlemeny", "felhivas"]
  },
  {
    category: "karelhartas_megoldas",
    score: 5,
    keywords: ["karelharitas", "tisztitas", "mentesites", "megoldas", "elszallitas", "artalmatlanitas"]
  },
  {
    category: "monitoring_vizsgalat",
    score: 2,
    keywords: ["mintavetel", "laborvizsgalat", "meres", "ellenorzes", "eredmenyek", "asbest-messungen"]
  },
  {
    category: "ovintezkedes",
    score: 2,
    keywords: ["locsoljak az utakat", "maszkot osztanak", "ovintezkedes", "ovintezkedeseket"]
  }
];

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Nem található a bemeneti fájl: ${filePath}`);
  }

  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf8");
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function detectSourceType(article) {
  const source = normalizeText(article.source);
  const url = normalizeText(article.url);
  const existingType = normalizeText(article.source_type);

  if (existingType) return existingType;

  if (
    source.includes("kormanyhivatal") ||
    source.includes("onkormanyzat") ||
    source.includes("koszeg") ||
    url.includes("kormanyhivatalok.hu") ||
    url.includes("koszeg.hu")
  ) {
    return "official";
  }

  if (source.includes("greenpeace") || url.includes("greenpeace")) {
    return "civil";
  }

  if (
    source.includes("telex") ||
    source.includes("hvg") ||
    source.includes("444") ||
    source.includes("nyugat") ||
    source.includes("vaol") ||
    source.includes("24.hu") ||
    source.includes("euronews")
  ) {
    return "media";
  }

  if (
    source.includes("orf") ||
    source.includes("kurier") ||
    source.includes("standard") ||
    source.includes("burgenland") ||
    source.includes("meinbezirk") ||
    url.includes(".at")
  ) {
    return "austrian";
  }

  return "other";
}

function extractDateFromText(text) {
  const normalized = normalizeText(text);

  const isoMatch = normalized.match(/20\d{2}[-.]\d{1,2}[-.]\d{1,2}/);
  if (isoMatch) {
    return normalizeIsoDate(isoMatch[0]);
  }

  const hungarianMonths = {
    januar: "01",
    februar: "02",
    marcius: "03",
    aprilis: "04",
    majus: "05",
    junius: "06",
    julius: "07",
    augusztus: "08",
    szeptember: "09",
    oktober: "10",
    november: "11",
    december: "12"
  };

  const huMatch = normalized.match(/(20\d{2})\.?\s+(januar|februar|marcius|aprilis|majus|junius|julius|augusztus|szeptember|oktober|november|december)\s+(\d{1,2})/);

  if (huMatch) {
    const year = huMatch[1];
    const month = hungarianMonths[huMatch[2]];
    const day = String(huMatch[3]).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  return null;
}

function normalizeIsoDate(value) {
  const match = String(value || "").match(/(20\d{2})[-.](\d{1,2})[-.](\d{1,2})/);

  if (!match) {
    return null;
  }

  const year = match[1];
  const month = String(match[2]).padStart(2, "0");
  const day = String(match[3]).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function normalizeArticleDate(article) {
  const rawDate = String(article.date || "").trim();

  const exactDate = normalizeIsoDate(rawDate);
  if (exactDate) return exactDate;

  const extractedFromTitle = extractDateFromText(article.title);
  if (extractedFromTitle) return extractedFromTitle;

  const extractedFromSummary = extractDateFromText(article.summary);
  if (extractedFromSummary) return extractedFromSummary;

  return null;
}

function collectMatches(article, rules) {
  const combinedText = normalizeText(
    `${article.title || ""} ${article.source || ""} ${article.summary || ""} ${article.url || ""}`
  );

  const matched = [];
  let score = 0;

  for (const rule of rules) {
    const keywords = rule.keywords.filter((keyword) => {
      return combinedText.includes(normalizeText(keyword));
    });

    if (keywords.length > 0) {
      matched.push({
        category: rule.category,
        score: rule.score,
        keywords
      });

      score += rule.score;
    }
  }

  return { score, matched };
}

function calculateBaseScore(article) {
  const negativeResult = collectMatches(article, NEGATIVE_RULES);
  const positiveResult = collectMatches(article, POSITIVE_RULES);

  let baseScore = negativeResult.score + positiveResult.score;

  if (baseScore === 0 && negativeResult.matched.length === 0 && positiveResult.matched.length === 0) {
    baseScore = -1;
  }

  if (baseScore > 5) baseScore = 5;
  if (baseScore < -5) baseScore = -5;

  let category = "altalanos_media_megjelenes";

  if (baseScore > 0 && positiveResult.matched.length > 0) {
    category = positiveResult.matched[0].category;
  } else if (baseScore < 0 && negativeResult.matched.length > 0) {
    category = negativeResult.matched[0].category;
  } else if (positiveResult.matched.length > 0 && negativeResult.matched.length > 0) {
    category = "vegyes_hatasu_esemeny";
  }

  return {
    baseScore,
    category,
    negativeResult,
    positiveResult
  };
}

function calculateConfidence(negativeMatches, positiveMatches) {
  const total =
    negativeMatches.reduce((sum, item) => sum + item.keywords.length, 0) +
    positiveMatches.reduce((sum, item) => sum + item.keywords.length, 0);

  if (total === 0) return 0.7;
  if (total === 1) return 0.85;
  return 1.0;
}

function roundScore(value) {
  return Math.round(value * 100) / 100;
}

function articleToScoreItem(article) {
  const normalizedDate = normalizeArticleDate(article);

  if (!normalizedDate) {
    return null;
  }

  const sourceType = detectSourceType(article);
  const scoreData = calculateBaseScore(article);
  const sourceWeight = SOURCE_WEIGHTS[sourceType] || SOURCE_WEIGHTS.other;
  const confidence = calculateConfidence(
    scoreData.negativeResult.matched,
    scoreData.positiveResult.matched
  );

  const finalScore = roundScore(scoreData.baseScore * sourceWeight * confidence);

  return {
    date: normalizedDate,
    title: article.title || "Cím nélkül",
    source: article.source || "Ismeretlen forrás",
    source_type: sourceType,
    category: scoreData.category,
    base_score: scoreData.baseScore,
    source_weight: sourceWeight,
    confidence,
    final_score: finalScore,
    matched_negative_rules: scoreData.negativeResult.matched,
    matched_positive_rules: scoreData.positiveResult.matched,
    url: article.url || ""
  };
}

function sortItems(items) {
  return items.sort((a, b) => {
    return new Date(a.date) - new Date(b.date);
  });
}

function main() {
  const newsData = readJson(INPUT_FILE);
  const articles = Array.isArray(newsData.articles) ? newsData.articles : [];

  if (!articles.length) {
    throw new Error("A data/news.json nem tartalmaz articles tömböt vagy az üres.");
  }

  const skipped = [];
  const items = [];

  for (const article of articles) {
    const item = articleToScoreItem(article);

    if (item) {
      items.push(item);
    } else {
      skipped.push({
        title: article.title || "Cím nélkül",
        source: article.source || "Ismeretlen forrás",
        original_date: article.date || "",
        url: article.url || ""
      });
    }
  }

  const output = {
    generated_at: new Date().toISOString(),
    method: "balanced_keyword_rule_based_event_scoring_v3",
    description:
      "Automatikusan generált Kőszeg–azbeszt ügyindex a data/news.json alapján. A rendszer külön számolja a negatív kockázati és a pozitív intézkedési kulcsszavakat.",
    scoring_note:
      "Ez nem klasszikus hangulatelemzés. A negatív pont kockázatot vagy romló fejleményt, a pozitív pont intézkedést, tájékoztatást, monitoringot vagy megoldás felé mutató eseményt jelent.",
    source_weights: SOURCE_WEIGHTS,
    negative_rules: NEGATIVE_RULES,
    positive_rules: POSITIVE_RULES,
    skipped_without_valid_date: skipped,
    items: sortItems(items)
  };

  writeJson(OUTPUT_FILE, output);

  console.log(`Kész: ${OUTPUT_FILE}`);
  console.log(`Pontozott hírek száma: ${items.length}`);
  console.log(`Kihagyott, dátum nélküli hírek száma: ${skipped.length}`);
}

main();
