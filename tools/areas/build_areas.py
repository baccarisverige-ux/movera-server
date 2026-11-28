#!/usr/bin/env python3
"""v0.18.172 preferred areas (contract.json#preferredAreas): builds data/areas/*.geojson + manifest.json OFFLINE from the open
sources (never at server boot). Needs shapely (pip install shapely). No OSM (owner 2026-11-25).

  python3 -I tools/areas/build_areas.py <download dir> data/areas

<download dir> holds (downloaded by `--fetch`, or by hand with the same URLs):
  regso01.json   SCB RegSO 2025, Stockholms län (lanskod 01), EPSG:4326, CC0
                 https://geodata.scb.se/geoserver/stat/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=stat:RegSO_2025&outputFormat=application/json&srsName=EPSG:4326&CQL_FILTER=lanskod='01'
  fr_commune.json, fr_arr.json, fr_departement.json   IGN ADMIN EXPRESS COG CARTO (LATEST), Île-de-France (region 11), Licence Ouverte 2.0
                 https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature&TYPENAMES=ADMINEXPRESS-COG-CARTO.LATEST:<layer>&outputFormat=application/json&srsName=EPSG:4326&CQL_FILTER=...

Checks (any failure exits 1, nothing written):
  - every RegSO of kommun 0180 is tagged to exactly ONE of the 11 stadsdelsområden (DISTRICT_OF below); a RegSO name or a
    district name that matches nothing fails (no silent drop);
  - the union of the 11 districts equals kommun 0180: area difference both ways < 0.1 % and pairwise overlap < 0.1 % of the
    smaller district (GM edit 3: this geometry check runs here and in CI, never at boot);
  - every ring is valid for src/zones/geometry.ts polygonProblem (not closed, no repeated point, no self crossing, has area).
"""
import hashlib, json, os, sys, unicodedata, urllib.parse, urllib.request
from shapely.geometry import shape, mapping, MultiPolygon, Polygon
from shapely.ops import unary_union
import shapely

SE_ZONE, FR_ZONE = "Z001", "FR-PC"
KOMMUN = {"0114": "Upplands Väsby", "0115": "Vallentuna", "0117": "Österåker", "0120": "Värmdö", "0123": "Järfälla", "0125": "Ekerö",
          "0126": "Huddinge", "0127": "Botkyrka", "0128": "Salem", "0136": "Haninge", "0138": "Tyresö", "0139": "Upplands-Bro",
          "0140": "Nykvarn", "0160": "Täby", "0162": "Danderyd", "0163": "Sollentuna", "0180": "Stockholm", "0181": "Södertälje",
          "0182": "Nacka", "0183": "Sundbyberg", "0184": "Solna", "0186": "Lidingö", "0187": "Vaxholm", "0188": "Norrtälje",
          "0191": "Sigtuna", "0192": "Nynäshamn"}
# The 11 stadsdelsområden of Stockholms stad since 2023-07-01 (names are facts). Each RegSO 2025 of kommun 0180, by its
# regsonamn, to the district it lies in. Checked against Stockholms stad's official stadsdelsnämnd outlines 2023
# (dataportalen.stockholm.se, Stadskartans_Stadsdelsnamnder_2023.zip) with --check-official: every RegSO's largest share
# must fall in its tagged district (2026-11-28: Enskededalen moved to Skarpnäck; no other mismatch).
DISTRICTS = ["Norra innerstaden", "Kungsholmen", "Södermalm", "Järva", "Bromma", "Hässelby-Vällingby", "Enskede-Årsta-Vantör",
             "Skarpnäck", "Farsta", "Hägersten-Älvsjö", "Skärholmen"]
_D = {
    "Norra innerstaden": ["Klara-Jacob", "Norra Adolf Fredrik", "Södra Adolf Fredrik", "Gustav Vasa", "Västra Matteus", "Östra Matteus",
                          "Norra Johannes", "Södra Johannes", "Engelbrekts kyrka", "Hedvig Eleonora", "Oscars kyrka", "Gärdet", "Djurgården",
                          "Hjorthagen-Värtahamnen", "Tekniska Högskolan", "Universitetet"],
    "Kungsholmen": ["Kungsholm", "Stadshagen", "Fredhäll", "Kristineberg", "Marieberg", "Lilla Essingen", "Stora Essingen", "Östra Sankt Göran"],
    "Södermalm": ["Storkyrkan", "Mariatorget", "Norra Högalid", "Mellersta Högalid", "Södra Högalid", "Reimersholme-Långholmen", "Västra Katarina",
                  "Östra Katarina", "Norra Sofia", "Södra Sofia", "Södra Station", "Södra Hammarbyhamnen"],
    "Järva": ["Akalla", "Husby", "Kista", "Rinkeby", "Tensta", "Bromsten", "Flysta", "Solhem-Lunda", "Sundby"],
    "Bromma": ["Abrahamsberg", "Alvik", "Beckomberga", "Blackeberg", "Bromma kyrka", "Bällsta", "Eneby", "Höglandet", "Mariehäll", "Nockeby",
               "Nockebyhov-Olovslund", "Norra Ängby", "Södra Ängby", "Riksby-Åkeshov", "Smedslätten", "Stora Mossen", "Traneberg", "Ulvsunda",
               "Ulvsunda Industriområde", "Ålsten", "Åkeslund", "Äppelviken"],
    "Hässelby-Vällingby": ["Hässelby Gård", "Hässelby Strand", "Hässelby Villastad", "Grimsta", "Kälvesta", "Nälsta", "Råcksta", "Vinsta", "Vällingby"],
    "Enskede-Årsta-Vantör": ["Enskede Gård", "Enskedefältet", "Gamla Enskede", "Johanneshov", "Stureby", "Årsta", "Östberga",
                             "Bandhagen", "Högdalen", "Rågsved", "Hagsätra", "Örby"],
    "Skarpnäck": ["Bagarmossen", "Björkhagen", "Enskededalen", "Hammarbyhöjden", "Kärrtorp", "Norra Skarpnäcks Gård", "Sydvästra Skarpnäcks gård-Orhem",
                  "Östra Skarpnäcks gård-Flaten-Skrubba"],
    "Farsta": ["Farsta", "Fagersjö", "Gubbängen", "Hökarängen", "Larsboda", "Sköndal", "Svedmyra", "Tallkrogen", "Västra Farsta Strand-Farstanäset",
               "Östra Farsta Strand"],
    "Hägersten-Älvsjö": ["Aspudden", "Fruängen", "Gröndal", "Hägersten", "Hägerstensåsen", "Liljeholmen", "Midsommarkransen", "Mälarhöjden",
                         "Västberga", "Västertorp", "Herrängen", "Långbro", "Långsjö", "Solberga", "Liseberg", "Älvsjö", "Örby Slott"],
    "Skärholmen": ["Bredäng", "Sätra", "Skärholmen", "Vårberg"],
}
DISTRICT_OF = {r: d for d, rs in _D.items() for r in rs}
TOL = 0.0004  # degrees, about 45 m north-south: the "~50 m" of the plan
SE_SOURCE = ("SCB RegSO 2025", "CC0", 2025)
FR_SOURCE = ("IGN ADMIN EXPRESS COG CARTO", "Licence Ouverte 2.0", None)


class BuildError(Exception):
    pass


def fail(msg):
    raise BuildError(msg)


def key(name):
    s = unicodedata.normalize("NFD", name.lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    s = "".join(ch if ch.isalnum() else " " for ch in s)
    return " ".join(s.split())


def slug(name):
    return key(name).upper().replace(" ", "-")


def check_districts(regso_0180, district_of=None, districts=None):
    district_of = DISTRICT_OF if district_of is None else district_of
    districts = DISTRICTS if districts is None else districts
    names = [f["properties"]["regsonamn"] for f in regso_0180]
    unknown = sorted(set(names) - set(district_of))
    if unknown: fail(f"RegSO of 0180 tagged to no district: {unknown}")
    missing = sorted(set(district_of) - set(names))
    if missing: fail(f"district list names a RegSO that does not exist: {missing}")
    bad = sorted(set(district_of.values()) - set(districts)) + sorted(set(districts) - set(district_of.values()))
    if bad: fail(f"district names do not match the 11: {bad}")
    dup = [n for n in set(names) if names.count(n) > 1]
    if dup: fail(f"RegSO names not unique in 0180: {dup}")


def geometry_check(kommun, districts):
    """Gaps and overlaps: union of the districts == kommun 0180 within 0.1 %; pairwise overlap < 0.1 % of the smaller."""
    u = unary_union(list(districts.values()))
    gap = kommun.difference(u).area / kommun.area
    extra = u.difference(kommun).area / kommun.area
    if gap >= 0.001 or extra >= 0.001: fail(f"districts vs kommun 0180: gap {gap:.5%}, outside {extra:.5%}")
    items = list(districts.items())
    for i in range(len(items)):
        for j in range(i + 1, len(items)):
            (a, ga), (b, gb) = items[i], items[j]
            ov = ga.intersection(gb).area / min(ga.area, gb.area)
            if ov >= 0.001: fail(f"districts {a} and {b} overlap {ov:.5%}")
    return gap, extra


def rings_of(geom):
    polys = [geom] if isinstance(geom, Polygon) else list(geom.geoms) if isinstance(geom, MultiPolygon) else [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]
    out = []
    for p in polys:
        if p.is_empty or p.area < 1e-9: continue
        rings = [p.exterior] + list(p.interiors)
        rr = []
        for k, ring in enumerate(rings):
            pts = [(round(y, 5), round(x, 5)) for x, y in ring.coords][:-1]
            clean = []
            for q in pts:
                if q not in clean: clean.append(q)
            if len(clean) < 3:
                if k == 0: rr = None; break
                continue
            rr.append([list(q) for q in clean])
        if rr: out.append(rr)
    return out


def ring_problem(r):
    n = len(r)
    if r[0] == r[-1]: return "polygon_closed"
    if len({tuple(p) for p in r}) != n: return "polygon_repeated_point"
    if not Polygon([(p[1], p[0]) for p in r]).is_valid: return "polygon_self_crossing"
    a = sum(r[i][1] * r[(i + 1) % n][0] - r[(i + 1) % n][1] * r[i][0] for i in range(n))
    if abs(a) < 1e-12: return "polygon_no_area"
    return None


def make_valid_rings(geom):
    """Round to 5 decimals, then make every ring valid (rounding can create a touching corner)."""
    for attempt in range(3):
        rings = rings_of(geom)
        if all(ring_problem(r) is None for poly in rings for r in poly): return rings
        geom = shapely.make_valid(shapely.set_precision(geom, 0.00001)).buffer(0)
    probs = [ring_problem(r) for poly in rings for r in poly if ring_problem(r)]
    fail(f"ring problems after repair: {probs[:3]}")


def feature(area_id, zone, country, kind, name, parent_id, parent_name, geom, derived, source):
    rings = make_valid_rings(geom)
    if not rings: fail(f"{area_id}: empty outline")
    return {"type": "Feature",
            "properties": {"areaId": area_id, "zoneId": zone, "country": country, "kind": kind, "name": name, "parentAreaId": parent_id,
                           "parentName": parent_name, "searchKey": key(name), "derived": derived, "source": source[0], "licence": source[1],
                           "sourceYear": source[2]},
            # rings in the zones format: [[lat, lng], ...], not closed; MULTIPOLYGON = [ polygon = [outer, hole, ...], ... ]
            "polygons": rings}


def simplify_coverage(geoms):
    out = shapely.coverage_simplify(list(geoms), TOL)
    return [shapely.make_valid(g) for g in out]


def build(src, out):
    regso = json.load(open(os.path.join(src, "regso01.json"), encoding="utf-8"))["features"]
    by_k = {}
    for f in regso:
        by_k.setdefault(f["properties"]["kommunkod"], []).append(f)
    if set(by_k) != set(KOMMUN): fail(f"kommun codes {sorted(by_k)} != the 26 of Stockholms län")
    check_districts(by_k["0180"])
    kommun_geo = {k: unary_union([shape(f["geometry"]) for f in fs]).buffer(0) for k, fs in by_k.items()}
    dist_geo = {d: unary_union([shape(f["geometry"]) for f in by_k["0180"] if DISTRICT_OF[f["properties"]["regsonamn"]] == d]).buffer(0) for d in DISTRICTS}
    gap, extra = geometry_check(kommun_geo["0180"], dist_geo)
    ks = sorted(kommun_geo)
    simp_k = dict(zip(ks, simplify_coverage(kommun_geo[k] for k in ks)))
    simp_d = dict(zip(DISTRICTS, simplify_coverage(dist_geo[d] for d in DISTRICTS)))
    geometry_check(simp_k["0180"], simp_d)  # still no gap or overlap after simplification
    se = [feature(f"SE-K-{k}", SE_ZONE, "SE", "kommun", KOMMUN[k], None, "Stockholms län", simp_k[k], False, SE_SOURCE) for k in ks]
    se += [feature(f"SE-SDO-{slug(d)}", SE_ZONE, "SE", "stadsdelsomrade", d, "SE-K-0180", "Stockholm", simp_d[d], True, SE_SOURCE) for d in DISTRICTS]

    com = json.load(open(os.path.join(src, "fr_commune.json"), encoding="utf-8"))["features"]
    arr = json.load(open(os.path.join(src, "fr_arr.json"), encoding="utf-8"))["features"]
    dep = json.load(open(os.path.join(src, "fr_departement.json"), encoding="utf-8"))["features"]
    year = 2025
    deps = {d["properties"]["code_insee"]: d for d in dep}
    if sorted(deps) != ["75", "77", "78", "91", "92", "93", "94", "95"]: fail(f"départements {sorted(deps)}")
    paris = [c for c in com if c["properties"]["code_insee"] == "75056"]
    others = [c for c in com if c["properties"]["code_insee"] != "75056"]
    if len(paris) != 1 or len(arr) != 20: fail(f"Paris {len(paris)} / arrondissements {len(arr)}")
    fr_src = (FR_SOURCE[0], FR_SOURCE[1], year)
    dname = {k: v["properties"]["nom_officiel"] for k, v in deps.items()}
    cg = [shape(c["geometry"]).buffer(0) for c in others]
    ag = [shape(a["geometry"]).buffer(0) for a in arr]
    simp = simplify_coverage(cg + ag)
    sc, sa = simp[:len(cg)], simp[len(cg):]
    fr = []
    for c, g in zip(others, sc):
        p = c["properties"]
        fr.append(feature(f"FR-C-{p['code_insee']}", FR_ZONE, "FR", "commune", p["nom_officiel"], f"FR-D-{p['code_insee_du_departement']}",
                          dname[p["code_insee_du_departement"]], g, False, fr_src))
    for a, g in sorted(zip(arr, sa), key=lambda t: t[0]["properties"]["code_insee"]):
        p = a["properties"]
        fr.append(feature(f"FR-A-{p['code_insee']}", FR_ZONE, "FR", "arrondissement", p["nom_officiel"], "FR-CITY-PARIS", "Paris", g, False, fr_src))
    fr.append(feature("FR-CITY-PARIS", FR_ZONE, "FR", "city", "Paris", "FR-D-75", dname["75"], unary_union(sa).buffer(0), False, fr_src))
    for k in sorted(deps):
        fr.append(feature(f"FR-D-{k}", FR_ZONE, "FR", "departement", dname[k], None, "Île-de-France",
                          shape(deps[k]["geometry"]).buffer(0).simplify(TOL, preserve_topology=True), False, fr_src))
    os.makedirs(out, exist_ok=True)
    manifest = {"note": "v0.18.172 preferred areas: written by tools/areas/build_areas.py; the boot seed checks every sha256 and the row count per country.",
                "files": {}, "rows": {}}
    for name, feats, country in (("se.geojson", se, "SE"), ("fr.geojson", fr, "FR")):
        ids = [f["properties"]["areaId"] for f in feats]
        if len(ids) != len(set(ids)): fail(f"{name}: duplicate areaId")
        body = json.dumps({"type": "AreaCollection", "features": feats}, ensure_ascii=False, separators=(",", ":")) + "\n"
        open(os.path.join(out, name), "w", encoding="utf-8").write(body)
        manifest["files"][name] = hashlib.sha256(body.encode("utf-8")).hexdigest()
        manifest["rows"][country] = len(feats)
    open(os.path.join(out, "manifest.json"), "w", encoding="utf-8").write(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
    print(f"build_areas: SE {len(se)} rows, FR {len(fr)} rows; Stockholm districts gap {gap:.5%}, outside {extra:.5%}")


def verify_manifest(out):
    """The written files still match manifest.json (sha256 of each file, row count per country)."""
    manifest = json.load(open(os.path.join(out, "manifest.json"), encoding="utf-8"))
    counts = {}
    for name, sha in manifest["files"].items():
        body = open(os.path.join(out, name), "rb").read()
        if hashlib.sha256(body).hexdigest() != sha: fail(f"{name}: checksum does not match manifest.json")
        for f in json.loads(body)["features"]:
            c = f["properties"]["country"]; counts[c] = counts.get(c, 0) + 1
    if counts != manifest["rows"]: fail(f"row counts {counts} != manifest.json {manifest['rows']}")


def check_official(src, official_dir):
    """Every RegSO of 0180 lies mostly (largest share) in the official stadsdelsnämnd outline of its tagged district."""
    import glob
    import shapefile
    from pyproj import Transformer
    t = Transformer.from_crs(3011, 4326, always_xy=True).transform
    r = shapefile.Reader(glob.glob(os.path.join(official_dir, "*.shp"))[0][:-4], encoding="utf-8")
    trim = {"Kungsholmens": "Kungsholmen", "Skärholmens": "Skärholmen", "Skarpnäcks": "Skarpnäck", "Södermalms": "Södermalm",
            "Enskede-Årsta-Vantörs": "Enskede-Årsta-Vantör", "Norra innerstadens": "Norra innerstaden"}
    sdn = {trim.get(rec[0], rec[0]): shapely.transform(shape(sh.__geo_interface__), lambda xy: __import__("numpy").column_stack(t(xy[:, 0], xy[:, 1]))).buffer(0)
           for sh, rec in zip(r.shapes(), r.records())}
    if set(sdn) != set(DISTRICTS): fail(f"official districts {sorted(sdn)} != the 11")
    regso = [f for f in json.load(open(os.path.join(src, "regso01.json"), encoding="utf-8"))["features"] if f["properties"]["kommunkod"] == "0180"]
    bad = []
    for f in regso:
        g = shape(f["geometry"]).buffer(0)
        share = {d: g.intersection(p).area / g.area for d, p in sdn.items()}
        best = max(share, key=share.get)
        if best != DISTRICT_OF[f["properties"]["regsonamn"]]: bad.append((f["properties"]["regsonamn"], DISTRICT_OF[f["properties"]["regsonamn"]], best))
    if bad: fail(f"RegSO tagged to another district than the city's outline: {bad}")
    return len(regso)


if __name__ == "__main__":
    try:
        if len(sys.argv) == 4 and sys.argv[1] == "--check-official":
            print("build_areas: official check OK,", check_official(sys.argv[2], sys.argv[3]), "RegSO")
        elif len(sys.argv) == 3 and sys.argv[1] == "--verify":
            verify_manifest(sys.argv[2]); print("build_areas: manifest OK")
        elif len(sys.argv) == 3:
            build(sys.argv[1], sys.argv[2])
        else:
            fail("usage: build_areas.py <download dir> <out dir> | --verify <out dir> | --check-official <download dir> <official shp dir>")
    except BuildError as error:
        print("build_areas: FAIL:", error, file=sys.stderr)
        sys.exit(1)
