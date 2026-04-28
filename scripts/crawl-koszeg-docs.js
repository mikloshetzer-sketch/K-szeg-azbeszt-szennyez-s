const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "data", "research");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "koszeg-doc-search-results.json");

const SOURCES = [
  {
    name: "Kőszeg hivatalos oldal",
    urls: [
      "https://koszeg.hu/hu/onkormanyzat/hirek/",
      "https://koszeg.hu/hu/onkormanyzat/testulet/ulesek/",
      "https://koszeg.hu/hu/onkormanyzat/projektek/"
    ]
  }
];

const KEYWORDS = [
  "azbeszt",
  "zúzottkő",
  "zúzalék",
  "útalap",
  "kavics",
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
  "tonna"
];

async function fetchText(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Nem sikerült letölteni: ${url} (${response.status})`);
  }

  return await response.text();
}

function findKeywordMatches(text) {
  const lowerText = text.toLowerCase();

  return KEYWORDS.filter((keyword) =>
    lowerText.includes(keyword.toLowerCase())
  );
}

async function crawl() {
  const results = [];

  for (const source of SOURCES) {
    for (const url of source.urls) {
      console.log(`Letöltés: ${url}`);

      try {
        const html = await fetchText(url);
        const matches = findKeywordMatches(html);

        results.push({
          source: source.name,
          url,
          checked_at: new Date().toISOString(),
          matched_keywords: matches,
          has_relevant_match: matches.length > 0
        });
      } catch (error) {
        results.push({
          source: source.name,
          url,
          checked_at: new Date().toISOString(),
          error: error.message,
          matched_keywords: [],
          has_relevant_match: false
        });
      }
    }
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(results, null, 2),
    "utf8"
  );

  console.log(`Kész: ${OUTPUT_FILE}`);
}

crawl();
