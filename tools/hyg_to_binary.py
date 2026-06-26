#!/usr/bin/env python3
"""
Convert the HYG v4 star catalog CSV to a compact binary asset for World42.

The output format is a simple flat binary:
  [uint32 count]              - number of stars, little-endian
  count × [f32 ra, f32 dec, f32 mag, f32 bv]  - star data, little-endian, radians

Usage:
  # 1. Download the HYG v4 CSV (one-time):
  #    curl -L https://raw.githubusercontent.com/astronexus/HYG-Database/master/hyg/v4/hyg_v41.csv -o tools/hyg_v41.csv
  # 2. Generate the binary asset:
  python tools/hyg_to_binary.py tools/hyg_v41.csv public/stars/hyg_mag8.bin

The output goes in public/stars/ which the rspack dev server serves at /stars/hyg_mag8.bin.
For production, upload public/stars/hyg_mag8.bin to the CDN alongside the skybox assets.

Column mapping (HYG v4):
  ra   - right ascension in hours  → converted to radians [0, 2π]
  dec  - declination in degrees    → converted to radians [-π/2, π/2]
  mag  - apparent visual magnitude (Johnson V)
  ci   - B-V color index (may be empty; defaults to 0.6 = solar-type G2V)
"""

import csv
import math
import struct
import sys
from pathlib import Path

MAG_LIMIT: float = 8.0

# HYG id=0 is Sol — already rendered by the star ray-march SDF sphere.
EXCLUDE_IDS: set[int] = {0}

# Default B-V when missing: 0.6 ≈ solar-type (G2V, slightly warm white).
DEFAULT_BV: float = 0.6


def parse_float(s: str, default: float) -> float:
    s = s.strip()
    if not s:
        return default
    try:
        return float(s)
    except ValueError:
        return default


def main(csv_path: str, bin_path: str) -> None:
    stars: list[tuple[float, float, float, float]] = []

    with open(csv_path, newline='', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            print("ERROR: empty or malformed CSV", file=sys.stderr)
            sys.exit(1)

        # Support both HYG v3 and v4 column names.
        fields = {n.strip().lower() for n in reader.fieldnames}

        def col(*names: str) -> str:
            for n in names:
                if n in fields:
                    return n
            return names[0]  # fallback (will KeyError if truly missing)

        id_col  = col('id', 'starid')
        ra_col  = col('ra')
        dec_col = col('dec')
        mag_col = col('mag')
        bv_col  = col('ci', 'colorindex', 'b-v')

        for row in reader:
            try:
                star_id = int(row.get(id_col, -1))
                if star_id in EXCLUDE_IDS:
                    continue

                mag = parse_float(row.get(mag_col, ''), float('inf'))
                if mag > MAG_LIMIT:
                    continue

                ra_hours = parse_float(row.get(ra_col, '0'), 0.0)
                dec_deg  = parse_float(row.get(dec_col, '0'), 0.0)

                ra  = ra_hours * math.pi / 12.0   # hours → radians
                dec = dec_deg  * math.pi / 180.0  # degrees → radians

                bv = parse_float(row.get(bv_col, ''), DEFAULT_BV)

                stars.append((ra, dec, mag, bv))

            except (ValueError, KeyError):
                continue

    # Sort brightest first (lowest magnitude) so the GPU processes bright stars
    # in order — useful if future culling ever truncates the tail.
    stars.sort(key=lambda s: s[2])

    out = Path(bin_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    with open(out, 'wb') as f:
        f.write(struct.pack('<I', len(stars)))
        for ra, dec, mag, bv in stars:
            f.write(struct.pack('<4f', ra, dec, mag, bv))

    size_kb = out.stat().st_size // 1024
    print(f"Written {len(stars):,} stars to {bin_path} ({size_kb} KB)")
    print(f"  Magnitude range: {stars[0][2]:.2f} (brightest) to {stars[-1][2]:.2f} (faintest)")


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <hyg_v41.csv> <output.bin>", file=sys.stderr)
        print(f"  Example: {sys.argv[0]} tools/hyg_v41.csv public/stars/hyg_mag8.bin", file=sys.stderr)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])
