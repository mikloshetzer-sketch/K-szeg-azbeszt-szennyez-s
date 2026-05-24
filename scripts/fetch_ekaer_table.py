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

LOOKUP_PATHS = [
    DATA_DIR / "settlement_county_lookup.json",
    DOCS_DATA_DIR / "settlement_county_lookup.json"
]

DATA_DIR.mkdir(parents=True, exist_ok=True)
DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)


def fix_mojibake(text):
    value = str(text)
    try:
        value = value.encode("latin1").decode("utf-8")
    except Exception:
        pass
    return value


def clean_text(value):
    if pd.isna(value):
        return ""
    value = fix_mojibake(value)
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_key(value):
    return clean_text(value).upper()


def get_text(url):
    response = requests.get(
        url,
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=60
    )
    response.raise_for_status()
    return response.text


def extract_iframe_url(html):
    soup = BeautifulSoup(html, "html.parser")
    iframe = soup.find("iframe")

    if not iframe or not iframe.get("src"):
        raise RuntimeError("Nem találtam Google Sheets iframe-et.")

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
        low = clean_text(col).lower()

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


def extract_year(value):
    text = clean_text(value)
    match = re.search(r"(20\d{2}|19\d{2})", text)
    if match:
        return int(match.group(1))
    return None


def extract_month(value):
    text = clean_text(value)
    match = re.search(r"\d+", text)
    if match:
        month = int(match.group(0))
        if 1 <= month <= 12:
            return month
    return 0


def parse_number(value):
    text = clean_text(value)

    if text == "":
        return 0.0

    text = text.replace("\u00a0", "")
    text = text.replace(" ", "")
    text = text.replace(",", ".")

    try:
        return float(text)
    except Exception:
        return 0.0


def load_county_lookup():
    for path in LOOKUP_PATHS:
        if path.exists():
            payload = json.loads(path.read_text(encoding="utf-8"))
            lookup = payload.get("lookup", payload)

            if isinstance(lookup, dict) and lookup:
                normalized = {
                    normalize_key(k): clean_text(v)
                    for k, v in lookup.items()
                    if k and v
                }

                print(f"Település-vármegye lookup betöltve: {path}")
                print(f"Lookup elemek száma: {len(normalized)}")
                return normalized

    print("FIGYELEM: Nem találtam settlement_county_lookup.json fájlt.")
    return {}


def fetch_table():
    html = get_text(SOURCE_URL)
    iframe_url = extract_iframe_url(html)
    csv_url = google_csv_url(iframe_url)

    print("Google Sheets iframe URL:", iframe_url)
    print("Google Sheets CSV URL:", csv_url)

    response = requests.get(
        csv_url,
        headers={"User-Agent": "Mozilla/5.0"},
        timeout=60
    )
    response.raise_for_status()

    raw = response.content

    csv_text = None
    for encoding in ["utf-8-sig", "utf-8", "latin1", "cp1250"]:
        try:
            csv_text = raw.decode(encoding)
            break
        except Exception:
            continue

    if not csv_text:
        raise RuntimeError("Nem sikerült dekódolni a CSV-t.")

    if "<html" in csv_text[:300].lower():
        raise RuntimeError("CSV helyett HTML érkezett.")

    df = pd.read_csv(StringIO(csv_text), dtype=str)
    df = normalize_columns(df)

    print("Beolvasott oszlopok:", list(df.columns))
    print("Első 5 sor:")
    print(df.head(5).to_string())

    return df, iframe_url, csv_url


def main():
    county_lookup = load_county_lookup()
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

    df["year_parsed"] = df["year"].map(extract_year)
    df["month_parsed"] = df["month"].map(extract_month)

    before = len(df)
    df = df[df["year_parsed"].notna()].copy()
    after = len(df)

    print(f"Sorok szűrés előtt: {before}")
    print(f"Sorok év alapján szűrés után: {after}")

    df["year"] = df["year_parsed"].astype(int)
    df["month"] = df["month_parsed"].astype(int)

    df["quarry"] = df["loading_place"].str.upper()
    df["destination"] = df["destination"].map(clean_text)

    df["destination_key"] = df["destination"].map(normalize_key)
    df["county"] = df["destination_key"].map(county_lookup).fillna("Ismeretlen")

    quantity_columns = [
        col for col in df.columns
        if re.fullmatch(r"\d{6,8}", str(col))
    ]

    if quantity_columns:
        for col in quantity_columns:
            df[col] = df[col].map(parse_number)

        # A forrás mennyiségi mezői kg-ban vannak kezelve.
        df["quantity_total_kg"] = df[quantity_columns].sum(axis=1)
        df["quantity_total_t"] = df["quantity_total_kg"] / 1000.0
    else:
        df["quantity_total_kg"] = 0.0
        df["quantity_total_t"] = 0.0

    df = df.drop(columns=["year_parsed", "month_parsed"], errors="ignore")

    records = df.to_dict(orient="records")

    county_destination_counts = (
        df.groupby("county")["destination"]
        .nunique()
        .sort_values(ascending=False)
        .to_dict()
    )

    county_record_counts = (
        df.groupby("county")
        .size()
        .sort_values(ascending=False)
        .to_dict()
    )

    county_quantity_totals_t = (
        df.groupby("county")["quantity_total_t"]
        .sum()
        .sort_values(ascending=False)
        .to_dict()
    )

    quarry_county_matrix = (
        df.groupby(["quarry", "county"])
        .agg(
            records=("destination", "size"),
            unique_destinations=("destination", "nunique"),
            quantity_total_t=("quantity_total_t", "sum"),
            quantity_total_kg=("quantity_total_kg", "sum")
        )
        .reset_index()
        .to_dict(orient="records")
    )

    unknown_destinations = sorted(
        df.loc[df["county"] == "Ismeretlen", "destination"]
        .dropna()
        .unique()
        .tolist()
    )

    summary = {
        "source_url": SOURCE_URL,
        "google_sheet_iframe_url": iframe_url,
        "google_sheet_csv_url": csv_url,

        "record_count": len(records),
        "year_min": int(df["year"].min()) if len(df) else None,
        "year_max": int(df["year"].max()) if len(df) else None,

        "unique_destinations": int(df["destination"].nunique()) if len(df) else 0,
        "unique_quarries": int(df["quarry"].nunique()) if len(df) else 0,
        "quarries": sorted(df["quarry"].dropna().unique().tolist()) if len(df) else [],

        "quantity_columns": quantity_columns,
        "quantity_source_unit": "kg",
        "quantity_display_unit": "t",
        "quantity_conversion": "kg / 1000 = t",

        "quantity_total_kg": float(df["quantity_total_kg"].sum()) if len(df) else 0.0,
        "quantity_total_t": float(df["quantity_total_t"].sum()) if len(df) else 0.0,

        # Régi kompatibilitás miatt meghagyva, de már tonnában.
        "quantity_total": float(df["quantity_total_t"].sum()) if len(df) else 0.0,

        "county_destination_counts": county_destination_counts,
        "county_record_counts": county_record_counts,
        "county_quantity_totals": county_quantity_totals_t,
        "county_quantity_totals_t": county_quantity_totals_t,

        "quarry_destination_counts": (
            df.groupby("quarry")["destination"]
            .nunique()
            .sort_values(ascending=False)
            .to_dict()
            if len(df) else {}
        ),

        "quarry_record_counts": (
            df.groupby("quarry")
            .size()
            .sort_values(ascending=False)
            .to_dict()
            if len(df) else {}
        ),

        "quarry_quantity_totals": (
            df.groupby("quarry")["quantity_total_t"]
            .sum()
            .sort_values(ascending=False)
            .to_dict()
            if len(df) else {}
        ),

        "quarry_quantity_totals_t": (
            df.groupby("quarry")["quantity_total_t"]
            .sum()
            .sort_values(ascending=False)
            .to_dict()
            if len(df) else {}
        ),

        "year_record_counts": (
            df.groupby("year")
            .size()
            .to_dict()
            if len(df) else {}
        ),

        "year_quantity_totals": (
            df.groupby("year")["quantity_total_t"]
            .sum()
            .to_dict()
            if len(df) else {}
        ),

        "year_quantity_totals_t": (
            df.groupby("year")["quantity_total_t"]
            .sum()
            .to_dict()
            if len(df) else {}
        ),

        "quarry_county_matrix": quarry_county_matrix,

        "top_destinations_by_records": (
            df.groupby("destination")
            .size()
            .sort_values(ascending=False)
            .head(30)
            .to_dict()
            if len(df) else {}
        ),

        "top_destinations_by_quantity": (
            df.groupby("destination")["quantity_total_t"]
            .sum()
            .sort_values(ascending=False)
            .head(30)
            .to_dict()
            if len(df) else {}
        ),

        "top_destinations_by_quantity_t": (
            df.groupby("destination")["quantity_total_t"]
            .sum()
            .sort_values(ascending=False)
            .head(30)
            .to_dict()
            if len(df) else {}
        ),

        "unknown_destination_count": len(unknown_destinations),
        "unknown_destinations_sample": unknown_destinations[:100],

        "method_note": (
            "A megyei bontás a settlement_county_lookup.json település-vármegye törzsadat alapján készül. "
            "A mennyiségi összesítés a 2517-es vámtarifaszám-oszlopokból készül. "
            "A forrás mennyiségi értékei kg-ként vannak kezelve, a dashboard tonnában (t) jeleníti meg őket. "
            "A logisztikai kitettség nem azonos a bizonyított azbesztszennyezettséggel."
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
    print(f"Időszak: {summary['year_min']}–{summary['year_max']}")
    print(f"Mennyiségi oszlopok: {summary['quantity_columns']}")
    print(f"Összesített mennyiség kg: {summary['quantity_total_kg']}")
    print(f"Összesített mennyiség t: {summary['quantity_total_t']}")
    print("Megyei településszám:")
    print(summary["county_destination_counts"])
    print(f"Ismeretlen települések száma: {summary['unknown_destination_count']}")


if __name__ == "__main__":
    main()
