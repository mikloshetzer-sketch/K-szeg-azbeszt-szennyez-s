import json
import re
from pathlib import Path

import pandas as pd
import requests


ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DOCS_DATA_DIR = ROOT / "docs" / "data"

DATA_DIR.mkdir(parents=True, exist_ok=True)
DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)

# Hivatalos alap: KSH Helységnévtár.
# Ha a KSH letöltési URL változik, elég ezt az egy címet módosítani.
KSH_CANDIDATE_URLS = [
    "https://www.ksh.hu/docs/hun/hnk/hnk_2025.xlsx",
    "https://www.ksh.hu/docs/hun/hnk/hnk_2024.xlsx",
    "https://www.ksh.hu/docs/hun/hnk/hnk_2023.xlsx"
]


def clean_text(value):
    if pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_key(value):
    return clean_text(value).upper()


def download_first_available():
    headers = {"User-Agent": "Mozilla/5.0"}

    for url in KSH_CANDIDATE_URLS:
        try:
            response = requests.get(url, headers=headers, timeout=60)
            if response.ok and len(response.content) > 5000:
                print(f"KSH fájl letöltve: {url}")
                return url, response.content
        except Exception as exc:
            print(f"Nem sikerült: {url} – {exc}")

    raise RuntimeError("Nem találtam elérhető KSH Helységnévtár Excel fájlt.")


def find_columns(df):
    columns = [clean_text(c) for c in df.columns]

    settlement_col = None
    county_col = None

    for col in columns:
        low = col.lower()

        if settlement_col is None and (
            "helység" in low
            or "település" in low
            or "telepules" in low
            or "name" in low
        ):
            settlement_col = col

        if county_col is None and (
            "vármegye" in low
            or "megye" in low
            or "county" in low
        ):
            county_col = col

    return settlement_col, county_col


def extract_lookup_from_excel(content):
    # Több sheetet is megnézünk, mert a KSH fájl szerkezete évről évre változhat.
    xls = pd.ExcelFile(content)

    best_lookup = {}
    best_info = None

    for sheet in xls.sheet_names:
        try:
            df = pd.read_excel(xls, sheet_name=sheet, dtype=str)
        except Exception:
            continue

        df.columns = [clean_text(c) for c in df.columns]
        settlement_col, county_col = find_columns(df)

        if not settlement_col or not county_col:
            continue

        lookup = {}

        for _, row in df.iterrows():
            settlement = normalize_key(row.get(settlement_col, ""))
            county = clean_text(row.get(county_col, ""))

            if not settlement or not county:
                continue

            # Kerüljük a fejlécismétlődést és hibás sorokat.
            if settlement in {"HELYSÉG", "TELEPÜLÉS", "TELEPULES", "MEGNEVEZÉS"}:
                continue

            lookup[settlement] = county

        if len(lookup) > len(best_lookup):
            best_lookup = lookup
            best_info = {
                "sheet": sheet,
                "settlement_col": settlement_col,
                "county_col": county_col,
                "rows": len(lookup)
            }

    if len(best_lookup) < 2500:
        raise RuntimeError(
            f"A kinyert településlista túl rövid: {len(best_lookup)} sor. "
            f"Valószínűleg rossz sheetet vagy oszlopot olvastunk."
        )

    return best_lookup, best_info


def main():
    source_url, content = download_first_available()
    lookup, info = extract_lookup_from_excel(content)

    output = {
        "source": "KSH Helységnévtár",
        "source_url": source_url,
        "generated_from": info,
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
    print(f"Sheet: {info}")


if __name__ == "__main__":
    main()
