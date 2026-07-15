#!/usr/bin/env python3
import json
import time
import urllib.parse
import urllib.request
from pathlib import Path

STREETS = [
    'Borostyánkő utca','Lékai út','Malomárok utca','Meskó utca','Kálvária utca',
    'Bechtold utca','Királyvölgyi utca','Erdő utca','Mélyút utca','Arborétum utca',
    'Freh Alfonz utca','Szent Anna utca','Hadik utca','Óház utca','Bersek József utca',
    'Kórház utca','Szent György utca','József Forrás utca','Csőszház utca',
    'Szelestey László utca','Hermina utca','Fehér Sáfrány utca','Dr. Ambró Gyula utca',
    'Kenyérhegyi út','Zrínyi utca','Sörgyár utca','Vízmű utca','Lóránt Gyula utca',
    'Posztógyár utca','Forintos Mátyás utca','Napsugár utca','Kankalin utca','Tüskevár utca',
    'Faludi utca','Hunyadi utca','Rómer Flóris utca','Táncsics Mihály utca','Sáncárok utca',
    'Vámház utca','Pocichter utca','Libaszőlő utca','Hidegvölgy út','Panoráma körút',
    'Strand sétány','Károlyi Mihály utca','Liszt Ferenc utca','Dózsa György utca',
    'Bajcsy-Zsilinszky utca','Rőtivölgyi utca'
]

ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.nchc.org.tw/api/interpreter',
]


def fetch_json(query: str) -> dict:
    payload = urllib.parse.urlencode({'data': query}).encode('utf-8')
    last_error = None
    for endpoint in ENDPOINTS:
        try:
            request = urllib.request.Request(
                endpoint,
                data=payload,
                headers={'User-Agent': 'Koszeg-Asbestos-Monitor/1.0'},
                method='POST',
            )
            with urllib.request.urlopen(request, timeout=120) as response:
                return json.load(response)
        except Exception as exc:
            last_error = exc
            print(f'Overpass endpoint failed: {endpoint}: {exc}')
            time.sleep(3)
    raise RuntimeError(f'No Overpass endpoint succeeded: {last_error}')


def main() -> None:
    escaped = '|'.join(name.replace('\\', '\\\\').replace('"', '\\"') for name in STREETS)
    query = (
        '[out:json][timeout:90];'
        f'way(47.345,16.485,47.435,16.605)["highway"]["name"~"^({escaped})$",i];'
        'out geom;'
    )
    data = fetch_json(query)
    features = []

    for element in data.get('elements', []):
        geometry = element.get('geometry') or []
        if element.get('type') != 'way' or len(geometry) < 2:
            continue
        coordinates = [[point['lon'], point['lat']] for point in geometry]
        tags = element.get('tags') or {}
        features.append({
            'type': 'Feature',
            'properties': {
                'osm_id': element.get('id'),
                'name': tags.get('name', 'Érintett utca'),
                'source': 'OpenStreetMap / Overpass',
            },
            'geometry': {
                'type': 'LineString',
                'coordinates': coordinates,
            },
        })

    if not features:
        raise RuntimeError('The Overpass response contained no matching street geometries.')

    output = {
        'type': 'FeatureCollection',
        'generated_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
        'features': features,
    }
    path = Path('data/affected_streets.geojson')
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'Wrote {len(features)} street geometries to {path}')


if __name__ == '__main__':
    main()
