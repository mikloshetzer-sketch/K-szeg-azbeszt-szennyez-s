import json
import re
from io import StringIO
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd
import requests
from bs4 import BeautifulSoup


SOURCE_URL = "https://www.martinkepviselo.hu/azbesztveszely/kozerdekulista"

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DOCS_DATA_DIR = ROOT / "docs" / "data"

DATA_DIR.mkdir(parents=True, exist_ok=True)
DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)


def clean_text(value):
    if pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def get_text(url):
    headers = {
        "User-Agent": "Mozilla/5.0"
    }

    response = requests.get(url, headers=headers, timeout=60)
    response.raise_for_status()
    return response.text


def extract_iframe_url(html):
    soup = BeautifulSoup(html, "html.parser")
    iframe = soup.find("iframe")

    if not iframe or not iframe.get("src"):
        raise RuntimeError("Nem találtam Google Sheets iframe-et a forrásoldalon.")

    src = iframe["src"].replace("&amp;", "&")

    if src.startswith("//"):
        src = "https:" + src

    return src


def google_csv_url(sheet_url):
    parsed = urlparse(sheet_url)
    query = parse_qs(parsed.query)
    gid = query.get("gid", ["0"])[0]

    if "/pubhtml" in sheet_url:
        base = sheet_url.split("/pubhtml")[0]
        return f"{base}/pub?gid={gid}&single=true&output=csv"

    parts = parsed.path.split("/")

    try:
        doc_id = parts[parts.index("d") + 1]
    except Exception as exc:
        raise RuntimeError(
            f"Nem tudtam kinyerni a Google Sheet azonosítót: {sheet_url}"
        ) from exc

    return f"https://docs.google.com/spreadsheets/d/{doc_id}/export?format=csv&gid={gid}"


def normalize_columns(df):
    df = df.copy()
    df.columns = [clean_text(c) for c in df.columns]

    rename = {}

    for col in df.columns:
        low = col.lower()

        if low in ["év", "ev", "year"]:
            rename[col] = "year"
        elif low in ["hó", "ho", "month"]:
            rename[col] = "month"
        elif "felrakod" in low:
            rename[col] = "loading_place"
        elif "kirakod" in low:
            rename[col] = "destination"
        elif "menny" in low or "tonna" in low or "kg" in low:
            rename[col] = "quantity"

    return df.rename(columns=rename)


def fetch_table():
    html = get_text(SOURCE_URL)
    iframe_url = extract_iframe_url(html)
    csv_url = google_csv_url(iframe_url)

    print("Google Sheets iframe URL:", iframe_url)
    print("Google Sheets CSV URL:", csv_url)

    csv_text = get_text(csv_url)

    if "<html" in csv_text[:300].lower():
        raise RuntimeError(
            "CSV helyett HTML érkezett. Lehet, hogy a Google Sheets CSV export nem elérhető."
        )

    df = pd.read_csv(StringIO(csv_text))
    df = normalize_columns(df)

    return df, iframe_url, csv_url


def add_county_guess(destination):
    name = clean_text(destination).lower()

    vas = {
        "kőszeg", "koszeg", "bozsok", "szombathely", "sárvár", "sarvar",
        "rum", "bük", "buk", "csepreg", "vasvár", "vasvar", "körmend",
        "kormend", "celldömölk", "celldomolk", "őriszentpéter",
        "oriszentpeter", "répcelak", "repcelak", "nádasd", "nadasd",
        "pornóapáti", "pornoapati", "rábahídvég", "rabahidveg",
        "vaspör", "vaspor", "szentgotthárd", "szentgotthard"
    }

    zala = {
        "egervár", "egervar", "zalaegerszeg", "nagykanizsa", "keszthely",
        "zalalövő", "zalalovo", "lenti", "hévíz", "heviz", "zalaszentgrót",
        "zalaszentgrot", "fűzvölgy", "fuzvolgy", "letenye", "zalakomár",
        "zalakomar", "zalacsány", "zalacsany", "bagod", "pókaszepetk",
        "pokaszepetk"
    }

    gyms = {
        "sopron", "győr", "gyor", "mosonmagyaróvár", "mosonmagyarovar",
        "kapuvár", "kapuvar", "csorna", "fertőd", "fertod", "lébény",
        "lebeny", "pannonhalma", "tét", "tet"
    }

    if name in vas:
        return "Vas"
    if name in zala:
        return "Zala"
    if name in gyms:
        return "Győr-Moson-Sopron"

    return "Ismeretlen"


def safe_int_min(series):
    if len(series) == 0:
        return None
    return int(series.min())


def safe_int_max(series):
    if len(series) == 0:
        return None
    return int(series.max())


def main():
    df, iframe_url, csv_url = fetch_table()

    required = ["year", "month", "loading_place", "destination"]
    missing = [col for col in required if col not in df.columns]

    if missing:
        raise RuntimeError(
            f"Hiányzó kötelező oszlopok: {missing}. "
            f"Elérhető oszlopok: {list(df.columns)}"
        )

    for col in df.columns:
        df[col] = df[col].map(clean_text)

    df = df[df["year"].astype(str).str.match(r"^\d{4}$", na=False)].copy()

    df["year"] = df["year"].astype(int)
    df["month"] = pd.to_numeric(df["month"], errors="coerce").fillna(0).astype(int)

    df["quarry"] = df["loading_place"].str.upper()
    df["destination"] = df["destination"].map(clean_text)
    df["county_guess"] = df["destination"].map(add_county_guess)

    if "quantity" in df.columns:
        df["quantity_raw"] = df["quantity"]
    else:
        df["quantity_raw"] = ""

    records = df.to_dict(orient="records")

    county_destination_counts = (
        df.groupby("county_guess")["destination"]
        .nunique()
        .sort_values(ascending=False)
        .to_dict()
    )

    quarry_destination_counts = (
        df.groupby("quarry")["destination"]
        .nunique()
        .sort_values(ascending=False)
        .to_dict()
    )

    year_record_counts = (
        df.groupby("year")
        .size()
        .to_dict()
    )

    quarry_county_matrix = (
        df.groupby(["quarry", "county_guess"])
        .size()
        .reset_index(name="records")
        .to_dict(orient="records")
    )

    top_destinations_by_records = (
        df.groupby("destination")
        .size()
        .sort_values(ascending=False)
        .head(30)
        .to_dict()
    )

    summary = {
        "source_url": SOURCE_URL,
        "google_sheet_iframe_url": iframe_url,
        "google_sheet_csv_url": csv_url,
        "record_count": len(records),
        "year_min": safe_int_min(df["year"]) if len(df) else None,
        "year_max": safe_int_max(df["year"]) if len(df) else None,
        "unique_destinations": int(df["destination"].nunique()),
        "unique_quarries": int(df["quarry"].nunique()),
        "quarries": sorted(df["quarry"].dropna().unique().tolist()),
        "county_destination_counts": county_destination_counts,
        "quarry_destination_counts": quarry_destination_counts,
        "year_record_counts": year_record_counts,
        "quarry_county_matrix": quarry_county_matrix,
        "top_destinations_by_records": top_destinations_by_records,
        "method_note": (
            "A megyei bontás jelenleg településnév-alapú becslés. "
            "Pontosításhoz teljes település–megye törzsadat szükséges."
        )
    }

    outputs = {
        DATA_DIR / "known_shipments.json": records,
        DOCS_DATA_DIR / "known_shipments.json": records,
        DATA_DIR / "ekaer_dashboard_summary.json": summary,
        DOCS_DATA_DIR / "ekaer_dashboard_summary.json": summary,
    }

    for path, payload in outputs.items():
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

    print("EKÁER adatletöltés kész.")
    print(f"Rekordok száma: {summary['record_count']}")
    print(f"Egyedi céltelepülések: {summary['unique_destinations']}")
    print(f"Forrásbányák: {', '.join(summary['quarries'])}")
    print("Megyei becsült településszám:")
    print(summary["county_destination_counts"])


if __name__ == "__main__":
    main()
