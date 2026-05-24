import json
import re
from pathlib import Path

import requests


SOURCE_URL = "https://raw.githubusercontent.com/ferenci-tamas/IrszHnk/master/IrszHnk.json"

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DOCS_DATA_DIR = ROOT / "docs" / "data"

DATA_DIR.mkdir(parents=True, exist_ok=True)
DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)


def clean_text(value):
    if value is None:
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_key(value):
    return clean_text(value).upper()


def fetch_json():
    response = requests.get(
        SOURCE_URL,
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=60
    )
    response.raise_for_status()
    return response.json()


def main():
    rows = fetch_json()
    lookup = {}

    for row in rows:
        settlement = normalize_key(row.get("Helység.megnevezése"))
        county = clean_text(row.get("Vármegye.megnevezése"))

        if not settlement or not county:
            continue

        lookup[settlement] = county

    output = {
        "source": "Ferenci Tamás IrszHnk – KSH Helységnévtár-alapú adat",
        "source_url": SOURCE_URL,
        "settlement_count": len(lookup),
        "lookup": lookup
    }

    for path in [
        DATA_DIR / "settlement_county_lookup.json",
        DOCS_DATA_DIR / "settlement_county_lookup.json"
    ]:
        path.write_text(
            json.dumps(output, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

    print("Település–vármegye törzsadat elkészült.")
    print(f"Települések száma: {len(lookup)}")


if __name__ == "__main__":
    main()
