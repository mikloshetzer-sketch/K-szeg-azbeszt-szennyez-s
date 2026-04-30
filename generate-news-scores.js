const fs = require("fs");
const path = require("path");

const INPUT_FILE = path.join(__dirname, "data", "news.json");
const OUTPUT_FILE = path.join(__dirname, "data", "news_scores.json");

const SOURCE_WEIGHTS = {
  official: 1.5,
  civil: 1.2,
  media: 1.0,
  austrian: 1.0,
  other: 0.8
};

const RULES = [
  {
    category: "egeszsegugyi_kockazat",
    score: -5,
    keywords: ["egészségügyi veszély", "azbesztveszély", "veszély", "rákkeltő", "por", "szennyezés"]
  },
  {
    category: "uj_erintett_terulet",
    score: -4,
    keywords: ["kőszegre is", "bozsok", "új terület", "érintett lehet", "további utcák", "kerülhetett"]
  },
  {
    category: "hatosagi_vagy_jogi_eljaras",
    score: 2,
    keywords: ["hatósági eljárás", "rendőrségi eljárás", "vizsgálat indult", "feljelentést tett", "feljelentés"]
  },
  {
    category: "lakossagi_tajekoztatas",
    score: 1,
    keywords: ["lakossági fórum", "tájékoztató", "lakossági információk", "közlemény"]
  },
  {
    category: "korlatozas_kockazatkezeles",
    score: -2,
    keywords: ["lezárják", "lezárás", "korlátozás", "10 km/h", "behajtás", "parkoló"]
  },
  {
    category: "karelhartas_vagy_megoldas",
    score: 4,
    keywords: ["kárelhárítás", "tisztítás", "mentesítés", "megoldás", "elszállítás", "ártalmatlanítás"]
  },
  {
    category: "bizonytalansag_vita",
    score: -3,
    keywords: ["nincs is szennyezés", "vitatja", "bizonytalan", "újranyitnának", "forrás nincs"]
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
    .replace(/[\u0300-\u036f]/g, "");
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

function findBestRule(article) {
  const combinedText = normalizeText(
    `${article.title || ""} ${article.source || ""} ${article.summary || ""} ${article.url || ""}`
  );

  let bestRule = null;
  let bestHits = 0;

  for (const rule of RULES) {
    const hits = rule.keywords.filter((keyword) => {
      return combinedText.includes(normalizeText(keyword));
    }).length;

    if (hits > bestHits) {
      bestRule = rule;
      bestHits = hits;
    }
  }

  if (!bestRule) {
    return {
      category: "altalanos_media_megjelenes",
      score: -1,
      matched_keywords: []
    };
  }

  return {
    category: bestRule.category,
    score: bestRule.score,
    matched_keywords: bestRule.keywords.filter((keyword) => {
      return combinedText.includes(normalizeText(keyword));
    })
  };
}

function calculateConfidence(matchedKeywords) {
  if (!matchedKeywords || matchedKeywords.length === 0) {
    return 0.7;
  }

  if (matchedKeywords.length === 1) {
    return 0.85;
  }

  return 1.0;
}

function roundScore(value) {
  return Math.round(value * 100) / 100;
}

function articleToScoreItem(article) {
  const sourceType = detectSourceType(article);
  const rule = findBestRule(article);
  const sourceWeight = SOURCE_WEIGHTS[sourceType] || SOURCE_WEIGHTS.other;
  const confidence = calculateConfidence(rule.matched_keywords);
  const finalScore = roundScore(rule.score * sourceWeight * confidence);

  return {
    date: article.date || "ismeretlen",
    title: article.title || "Cím nélkül",
    source: article.source || "Ismeretlen forrás",
    source_type: sourceType,
    category: rule.category,
    base_score: rule.score,
    source_weight: sourceWeight,
    confidence: confidence,
    final_score: finalScore,
    matched_keywords: rule.matched_keywords,
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
    method: "keyword_rule_based_event_scoring_v1",
    description:
      "Automatikusan generált Kőszeg–azbeszt ügyindex a data/news.json alapján. Negatív érték: kockázat, romló helyzet, új probléma. Pozitív érték: intézkedés, tájékoztatás, kárelhárítás vagy megoldás felé mutató esemény.",
    scoring_note:
      "Ez nem klasszikus hangulatelemzés, hanem kulcsszavas, eseményalapú pontozás. Az eredményt érdemes emberileg ellenőrizni.",
    source_weights: SOURCE_WEIGHTS,
    rules: RULES,
    items: items
  };

  writeJson(OUTPUT_FILE, output);

  console.log(`Kész: ${OUTPUT_FILE}`);
  console.log(`Pontozott hírek száma: ${items.length}`);
}

main();
