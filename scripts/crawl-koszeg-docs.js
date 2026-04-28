const fs = require("fs");
const path = require("path");

const OUTPUT_DIR = path.join(__dirname, "..", "data", "research");
const OUTPUT_FILE = path.join(OUTPUT_DIR, "koszeg-doc-search-results.json");

const START_URLS = [
  "https://koszeg.hu/hu/onkormanyzat/hirek/",
  "https://koszeg.hu/hu/onkormanyzat/testulet/ulesek/",
  "https://koszeg.hu/hu/onkormanyzat/projektek/"
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
  "m³",
  "tonna"
];

const MAX_PAGES = 80;

function normalizeUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).href.split("#")[0];
  } catch {
    return null;
  }
}

function isKoszegUrl(url) {
  return url.startsWith("https://koszeg.hu/");
}

function findKeywordMatches(text) {
  const lowerText = text.toLowerCase();

  return KEYWORDS.filter((keyword) =>
    lowerText.includes(keyword.toLowerCase())
  );
}

function extractLinks(html, baseUrl) {
  const links = [];
  const regex = /<a\s+(?:[^>]*?\s+)?href=["']([^"']+)["']/gi;

  let match;
  while ((match = regex.exec(html)) !== null) {
    const url = normalizeUrl(match[1], baseUrl);

    if (url && isKoszegUrl(url)) {
      links.push(url);
    }
  }

  return [...new Set(links)];
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "Koszeg-asbestos-research-bot/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return await response.text();
}

async function crawl() {
  const visited = new Set();
  const queue = [...START_URLS];
  const results = [];
  const pdfLinks = new Set();

  while (queue.length > 0 && visited.size < MAX_PAGES) {
    const url = queue.shift();

    if (visited.has(url)) continue;
    visited.add(url);

    console.log(`Ellenőrzés: ${url}`);

    try {
      const html = await fetchText(url);
      const matches = findKeywordMatches(html);
      const links = extractLinks(html, url);

      for (const link of links) {
        if (link.toLowerCase().endsWith(".pdf")) {
          pdfLinks.add(link);
        } else if (
          !visited.has(link) &&
          (
            link.includes("/hirek/") ||
            link.includes("/ulesek/") ||
            link.includes("/projektek/") ||
            link.includes("/downloadmanager/")
          )
        ) {
          queue.push(link);
        }
      }

      results.push({
        type: "html_page",
        url,
        checked_at: new Date().toISOString(),
        matched_keywords: matches,
        has_relevant_match: matches.length > 0,
        discovered_links: links.length
      });
    } catch (error) {
      results.push({
        type: "html_page",
        url,
        checked_at: new Date().toISOString(),
        error: error.message,
        matched_keywords: [],
        has_relevant_match: false
      });
    }
  }

  for (const pdfUrl of pdfLinks) {
    results.push({
      type: "pdf_link",
      url: pdfUrl,
      checked_at: new Date().toISOString(),
      matched_keywords: [],
      has_relevant_match: false,
      note: "PDF-link kigyűjtve, tartalmi elemzés következő lépésben."
    });
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(results, null, 2),
    "utf8"
  );

  console.log(`Kész: ${OUTPUT_FILE}`);
  console.log(`Bejárt oldalak: ${visited.size}`);
  console.log(`Talált PDF-ek: ${pdfLinks.size}`);
}

crawl();
