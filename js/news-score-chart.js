const fs = require("fs");
const path = require("path");

const INPUT_FILE = path.join(__dirname, "data", "news.json");
const OUTPUT_FILE = path.join(__dirname, "data", "news_scores.json");

const SOURCE_WEIGHTS = {
  official: 1.35,
  civil: 1.2,
  media: 1.0,
  austrian: 1.0,
  other: 0.8
};

const NEGATIVE_RULES = [
  {
    category: "egeszsegugyi_kockazat",
    score: -5,
    keywords: ["azbesztveszely", "egeszsegugyi veszely", "rakkelto", "veszelyes por", "sulyos veszely"]
  },
  {
    category: "szennyezes_vagy_gyanu",
    score: -4,
    keywords: ["szennyezes", "azbesztszennyezes", "szennyezett", "azbeszttel szennyezett", "azbeszttartalmu"]
  },
  {
    category: "uj_erintett_terulet",
    score: -4,
    keywords: ["koszegre is", "bozsok", "erintett lehet", "tovabbi utcak", "kerulhetett", "juthatott"]
  },
  {
    category: "korlatozas",
    score: -2,
    keywords: ["lezarjak", "lezaras", "korlatozas", "10 km/h", "behajtas", "parkolo", "leallitjak"]
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
    keywords: ["hatosagi eljaras", "rendorsegi eljaras", "vizsgalat indult", "intezkedes", "intezkedesek"]
  },
  {
    category: "jogi_lepes",
    score: 2,
    keywords: ["feljelentest tett", "feljelentes", "jogi lepes"]
  },
  {
    category: "lakossagi_tajekoztatas",
    score: 2,
    keywords: ["lakossagi forum", "tajekoztato", "lakossagi informaciok", "kozlemeny"]
  },
  {
    category: "karelhartas_megoldas",
    score: 5,
    keywords: ["karelharitas", "tisztitas", "mentesites", "megoldas", "elszallitas", "artalmatlanitas"]
  },
  {
    category: "monitoring_vizsgalat",
    score: 2,
    keywords: ["mintavetel", "laborvizsgalat", "meres", "ellenorzes", "vizsgalat"]
  }
];

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Nem található a bemeneti fájl: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw);
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

  if (existingType) {
    return existingType;
  }

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
    url.includes(".at")
  ) {
    return "austrian";
  }

  return "other";
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
        keywords: keywords
      });

      score += rule.score;
    }
  }

  return {
    score,
    matched
  };
}

function chooseMainCategory(negativeResult, positiveResult, finalBaseScore) {
  if (finalBaseScore > 0 && positiveResult.matched.length > 0) {
    return positiveResult.matched[0].category;
  }

  if (finalBaseScore < 0 && negativeResult.matched.length > 0) {
    return negativeResult.matched[0].category;
  }

  if (positiveResult.matched.length > 0 && negativeResult.matched.length > 0) {
    return "vegyes_hatasu_esemeny";
  }

  return "altalanos_media_megjelenes";
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

function calculateBaseScore(article) {
  const negativeResult = collectMatches(article, NEGATIVE_RULES);
  const positiveResult = collectMatches(article, POSITIVE_RULES);

  let baseScore = negativeResult.score + positiveResult.score;

  if (baseScore === 0 && negativeResult.matched.length === 0 && positiveResult.matched.length === 0) {
    baseScore = -1;
  }

  if (baseScore > 5) baseScore = 5;
  if (baseScore < -5) baseScore = -5;

  const category = chooseMainCategory(negativeResult, positiveResult, baseScore);

  return {
    baseScore,
    category,
    negativeResult,
    positiveResult
  };
}

function articleToScoreItem(article) {
  const sourceType = detectSourceType(article);
  const scoreData = calculateBaseScore(article);
  const sourceWeight = SOURCE_WEIGHTS[sourceType] || SOURCE_WEIGHTS.other;
  const confidence = calculateConfidence(
    scoreData.negativeResult.matched,
    scoreData.positiveResult.matched
  );

  const finalScore = roundScore(scoreData.baseScore * sourceWeight * confidence);

  return {
    date: article.date || "ismeretlen",
    title: article.title || "Cím nélkül",
    source: article.source || "Ismeretlen forrás",
    source_type: sourceType,
    category: scoreData.category,
    base_score: scoreData.baseScore,
    source_weight: sourceWeight,
    confidence: confidence,
    final_score: finalScore,
    matched_negative_rules: scoreData.negativeResult.matched,
    matched_positive_rules: scoreData.positiveResult.matched,
    url: article.url || ""
  };
}

function sortItems(items) {
  return items.sort((a, b) => {
    const dateA = new Date(a.date);
    const dateB = new Date(b.date);

    if (Number.isNaN(dateA.getTime())) return 1;
    if (Number.isNaN(dateB.getTime())) return -1;

    return dateA - dateB;
  });
}

function main() {
  const newsData = readJson(INPUT_FILE);
  const articles = Array.isArray(newsData.articles) ? newsData.articles : [];

  if (!articles.length) {
    throw new Error("A data/news.json nem tartalmaz articles tömböt vagy az üres.");
  }

  const items = sortItems(articles.map(articleToScoreItem));

  const output = {
    generated_at: new Date().toISOString(),
    method: "balanced_keyword_rule_based_event_scoring_v2",
    description:
      "Automatikusan generált Kőszeg–azbeszt ügyindex a data/news.json alapján. A rendszer külön számolja a kockázati és az intézkedési kulcsszavakat.",
    scoring_note:
      "Ez nem klasszikus hangulatelemzés. A negatív pont kockázatot vagy romló fejleményt, a pozitív pont intézkedést, tájékoztatást vagy megoldás felé mutató eseményt jelent.",
    source_weights: SOURCE_WEIGHTS,
    negative_rules: NEGATIVE_RULES,
    positive_rules: POSITIVE_RULES,
    items: items
  };

  writeJson(OUTPUT_FILE, output);

  console.log(`Kész: ${OUTPUT_FILE}`);
  console.log(`Pontozott hírek száma: ${items.length}`);
}

main();
