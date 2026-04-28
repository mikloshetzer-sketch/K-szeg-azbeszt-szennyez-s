const fs = require("fs");
const path = require("path");

const INPUT_FILE = path.join(
  __dirname,
  "..",
  "data",
  "research",
  "koszeg-doc-search-results.json"
);

const OUTPUT_FILE = path.join(
  __dirname,
  "..",
  "data",
  "research",
  "koszeg-research-summary.json"
);

const IMPORTANT_KEYWORDS = [
  "azbeszt",
  "zúzottkő",
  "zúzalék",
  "útalap",
  "szerpentinit",
  "Bernstein",
  "Pilgersdorf",
  "Rumpersdorf",
  "útfelújítás",
  "burkolatfelújítás",
  "aszfaltozás",
  "csapadékvíz",
  "kivitelező",
  "m3",
  "m³",
  "tonna"
];

function scoreItem(item) {
  if (!item.matched_keywords || item.matched_keywords.length === 0) {
    return 0;
  }

  let score = 0;

  for (const keyword of item.matched_keywords) {
    if (
      [
        "azbeszt",
        "szerpentinit",
        "Bernstein",
        "Pilgersdorf",
        "Rumpersdorf"
      ].includes(keyword)
    ) {
      score += 5;
    } else if (
      [
        "zúzottkő",
        "zúzalék",
        "útalap"
      ].includes(keyword)
    ) {
      score += 4;
    } else if (
      [
        "útfelújítás",
        "burkolatfelújítás",
        "aszfaltozás",
        "csapadékvíz"
      ].includes(keyword)
    ) {
      score += 2;
    } else {
      score += 1;
    }
  }

  return score;
}

function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Nem találom a bemeneti fájlt: ${INPUT_FILE}`);
  }

  const raw = fs.readFileSync(INPUT_FILE, "utf8");
  const data = JSON.parse(raw);

  const relevantPages = data
    .filter((item) => item.type === "html_page")
    .filter((item) => item.has_relevant_match)
    .map((item) => ({
      type: item.type,
      url: item.url,
      score: scoreItem(item),
      matched_keywords: item.matched_keywords || [],
      checked_at: item.checked_at
    }))
    .sort((a, b) => b.score - a.score);

  const documentLinks = data
    .filter((item) => item.type === "document_link")
    .map((item) => ({
      type: item.type,
      url: item.url,
      checked_at: item.checked_at
    }));

  const keywordStats = {};

  for (const item of data) {
    for (const keyword of item.matched_keywords || []) {
      keywordStats[keyword] = (keywordStats[keyword] || 0) + 1;
    }
  }

  const summary = {
    generated_at: new Date().toISOString(),
    total_items: data.length,
    total_relevant_pages: relevantPages.length,
    total_document_links: documentLinks.length,
    keyword_stats: Object.fromEntries(
      Object.entries(keywordStats).sort((a, b) => b[1] - a[1])
    ),
    top_relevant_pages: relevantPages.slice(0, 50),
    document_links: documentLinks
  };

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log(`Kész: ${OUTPUT_FILE}`);
  console.log(`Összes rekord: ${summary.total_items}`);
  console.log(`Releváns oldalak: ${summary.total_relevant_pages}`);
  console.log(`Dokumentumlinkek: ${summary.total_document_links}`);
}

main();
