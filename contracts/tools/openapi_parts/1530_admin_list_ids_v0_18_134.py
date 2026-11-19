# Runs inside tools/gen_openapi.py in name order with its globals (rule 25 split). v0.18.134 (S5 J16/J17, owner item 109,
# Rules plan/NUMBERS.md): GET /admin/riders, /admin/drivers and /admin/trips take ids (1-200, comma separated or repeated),
# always inside the admin's zones and every other filter (contract.json#adminListFilters.ids). Additive: one optional key.
_IDS134 = C["adminListFilters"]["ids"]
for _route in _IDS134["lists"]:
    _op = PATHS[_route.split(" ", 1)[1]]["get"]
    assert not any(p.get("name") == "ids" for p in _op["parameters"]), _route + " had ids before v0.18.134"
    _op["parameters"].append({"name": "ids", "in": "query", "required": False, "style": "form", "explode": False,
                              "description": "v0.18.134 (contract.json#adminListFilters.ids): " + _IDS134["rule"],
                              "schema": {"type": "array", "items": ref("Id"), "minItems": 1, "maxItems": _IDS134["max"]}})
    _op["description"] = (_op.get("description", "") + " v0.18.134: ids narrows the page to those rows (contract.json#adminListFilters.ids).").strip()
