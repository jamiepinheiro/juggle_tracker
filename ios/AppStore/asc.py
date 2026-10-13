"""Minimal App Store Connect API client for Juggle Tracker's listing.

Uses the team API key in ~/.appstoreconnect/private_keys (key ID and issuer below).
  python asc.py status        # what's on App Store Connect now
  python asc.py apply         # push listing.json (text, URLs, review notes, screenshots, ...)
  python asc.py attach-build  # attach the newest processed build to the version being prepared
  python asc.py submit        # send that version to App Review
  python asc.py review-status # version and review submission states
"""
import json, sys, time, hashlib, pathlib
import jwt, requests

KEY_ID, ISSUER = "J6ZFZ9ZR3T", "df7f6494-0334-44b2-9061-1f04d7fb1584"
BUNDLE_ID = "com.jamiepinheiro.JuggleTracker"
API = "https://api.appstoreconnect.apple.com/v1"
HERE = pathlib.Path(__file__).parent

def token():
    key = (pathlib.Path.home() / f".appstoreconnect/private_keys/AuthKey_{KEY_ID}.p8").read_text()
    now = int(time.time())
    return jwt.encode({"iss": ISSUER, "iat": now, "exp": now + 1200, "aud": "appstoreconnect-v1"},
                      key, algorithm="ES256", headers={"kid": KEY_ID, "typ": "JWT"})

S = requests.Session()
S.headers["Authorization"] = f"Bearer {token()}"

def call(method, path, body=None, **params):
    r = S.request(method, path if path.startswith("http") else API + path, json=body, params=params or None)
    if r.status_code >= 400:
        raise SystemExit(f"{method} {path} -> {r.status_code}\n{r.text[:1500]}")
    return r.json() if r.content else {}

def app():
    return call("GET", "/apps", **{"filter[bundleId]": BUNDLE_ID})["data"][0]

def status():
    a = app(); aid = a["id"]
    print("app", aid, a["attributes"]["name"])
    for info in call("GET", f"/apps/{aid}/appInfos")["data"]:
        print("appInfo", info["id"], info["attributes"].get("appStoreState"))
        for loc in call("GET", f"/appInfos/{info['id']}/appInfoLocalizations")["data"]:
            print("  info loc", loc["attributes"])
    for v in call("GET", f"/apps/{aid}/appStoreVersions")["data"]:
        print("version", v["id"], v["attributes"]["versionString"], v["attributes"]["appStoreState"])
        for loc in call("GET", f"/appStoreVersions/{v['id']}/appStoreVersionLocalizations")["data"]:
            print("  version loc", loc["id"], {k: (str(x)[:60] if x else x) for k, x in loc["attributes"].items()})
    for b in call("GET", "/builds", **{"filter[app]": aid})["data"]:
        print("build", b["id"], b["attributes"]["version"], b["attributes"]["processingState"])

def upload(create_path, rel_name, rel_id, path, rel_type):
    """Reserve, upload and commit one asset (screenshot or review attachment)."""
    data = path.read_bytes()
    r = call("POST", create_path, {"data": {"type": create_path.strip("/"), "attributes": {"fileName": path.name, "fileSize": len(data)},
             "relationships": {rel_name: {"data": {"type": rel_type, "id": rel_id}}}}})["data"]
    for op in r["attributes"]["uploadOperations"]:
        chunk = data[op["offset"]: op["offset"] + op["length"]]
        requests.request(op["method"], op["url"], data=chunk,
                         headers={h["name"]: h["value"] for h in op["requestHeaders"]}).raise_for_status()
    call("PATCH", f"{create_path}/{r['id']}", {"data": {"type": create_path.strip("/"), "id": r["id"],
         "attributes": {"uploaded": True, "sourceFileChecksum": hashlib.md5(data).hexdigest()}}})
    return r["id"]

def apply():
    L = json.loads((HERE / "listing.json").read_text())
    a = app(); aid = a["id"]
    info = call("GET", f"/apps/{aid}/appInfos")["data"][0]
    version = next(v for v in call("GET", f"/apps/{aid}/appStoreVersions")["data"]
                   if v["attributes"]["appStoreState"] == "PREPARE_FOR_SUBMISSION")
    vid = version["id"]

    # App-level: subtitle, privacy URL, categories, content rights
    iloc = call("GET", f"/appInfos/{info['id']}/appInfoLocalizations")["data"][0]
    call("PATCH", f"/appInfoLocalizations/{iloc['id']}", {"data": {"type": "appInfoLocalizations", "id": iloc["id"],
         "attributes": {"subtitle": L["subtitle"], "privacyPolicyUrl": L["privacyPolicyUrl"]}}})
    call("PATCH", f"/appInfos/{info['id']}", {"data": {"type": "appInfos", "id": info["id"], "relationships": {
         "primaryCategory": {"data": {"type": "appCategories", "id": L["primaryCategory"]}},
         "secondaryCategory": {"data": {"type": "appCategories", "id": L["secondaryCategory"]}}}}})
    call("PATCH", f"/apps/{aid}", {"data": {"type": "apps", "id": aid,
         "attributes": {"contentRightsDeclaration": "DOES_NOT_USE_THIRD_PARTY_CONTENT"}}})
    print("app info, categories, content rights: set")

    # Age rating: no objectionable content, no ads, chat, web access or user content -> 4+
    ar = call("GET", f"/appInfos/{info['id']}/ageRatingDeclaration")["data"]
    no = ["advertising", "gambling", "healthOrWellnessTopics", "lootBox", "messagingAndChat", "parentalControls",
          "ageAssurance", "unrestrictedWebAccess", "userGeneratedContent", "socialMedia", "socialMediaAgeRestricted"]
    none = ["alcoholTobaccoOrDrugUseOrReferences", "contests", "gamblingSimulated", "gunsOrOtherWeapons",
            "medicalOrTreatmentInformation", "profanityOrCrudeHumor", "sexualContentGraphicAndNudity", "sexualContentOrNudity",
            "horrorOrFearThemes", "matureOrSuggestiveThemes", "violenceCartoonOrFantasy",
            "violenceRealisticProlongedGraphicOrSadistic", "violenceRealistic"]
    attrs = {k: False for k in no if k in ar["attributes"]} | {k: "NONE" for k in none if k in ar["attributes"]}
    call("PATCH", f"/ageRatingDeclarations/{ar['id']}", {"data": {"type": "ageRatingDeclarations", "id": ar["id"], "attributes": attrs}})
    print("age rating: all none")

    # Version: copyright, release after approval; localization text
    call("PATCH", f"/appStoreVersions/{vid}", {"data": {"type": "appStoreVersions", "id": vid,
         "attributes": {"copyright": L["copyright"], "releaseType": "AFTER_APPROVAL"}}})
    vloc = call("GET", f"/appStoreVersions/{vid}/appStoreVersionLocalizations")["data"][0]
    call("PATCH", f"/appStoreVersionLocalizations/{vloc['id']}", {"data": {"type": "appStoreVersionLocalizations", "id": vloc["id"],
         "attributes": {k: L[k] for k in ("description", "keywords", "promotionalText", "supportUrl")}}})
    print("version text: set")

    # App Review details (contact from this account's other app), notes and attachment
    other = call("GET", "/apps/6753701481/appStoreVersions", limit=1)["data"][0]
    contact = call("GET", f"/appStoreVersions/{other['id']}/appStoreReviewDetail")["data"]["attributes"]
    notes = (HERE / L["reviewNotesFile"]).read_text().split("---", 1)[1].strip()
    review = {"contactFirstName": contact["contactFirstName"], "contactLastName": contact["contactLastName"],
              "contactEmail": contact["contactEmail"], "contactPhone": contact["contactPhone"],
              "demoAccountRequired": False, "notes": notes}
    existing = call("GET", f"/appStoreVersions/{vid}/appStoreReviewDetail").get("data")
    if existing:
        rid = existing["id"]
        call("PATCH", f"/appStoreReviewDetails/{rid}", {"data": {"type": "appStoreReviewDetails", "id": rid, "attributes": review}})
    else:
        rid = call("POST", "/appStoreReviewDetails", {"data": {"type": "appStoreReviewDetails", "attributes": review,
                   "relationships": {"appStoreVersion": {"data": {"type": "appStoreVersions", "id": vid}}}}})["data"]["id"]
    have = call("GET", f"/appStoreReviewDetails/{rid}/appStoreReviewAttachments")["data"]
    if not have:
        upload("/appStoreReviewAttachments", "appStoreReviewDetail", rid, HERE / L["reviewAttachment"], "appStoreReviewDetails")
    print("review details, notes, attachment: set")

    # Screenshots: replace each display type's set with the exported PNGs, in order
    sets = {s["attributes"]["screenshotDisplayType"]: s for s in
            call("GET", f"/appStoreVersionLocalizations/{vloc['id']}/appScreenshotSets")["data"]}
    for display, folder in L["screenshots"].items():
        if display in sets:
            for shot in call("GET", f"/appScreenshotSets/{sets[display]['id']}/appScreenshots")["data"]:
                call("DELETE", f"/appScreenshots/{shot['id']}")
            sid = sets[display]["id"]
        else:
            sid = call("POST", "/appScreenshotSets", {"data": {"type": "appScreenshotSets", "attributes": {"screenshotDisplayType": display},
                       "relationships": {"appStoreVersionLocalization": {"data": {"type": "appStoreVersionLocalizations", "id": vloc["id"]}}}}})["data"]["id"]
        files = sorted((HERE / folder).glob("*.png"))
        for f in files:
            upload("/appScreenshots", "appScreenshotSet", sid, f, "appScreenshotSets")
        print(f"screenshots {display}: {len(files)} uploaded")

def pricing():
    """Free, available in every territory (and new ones as Apple adds them)."""
    aid = app()["id"]
    sched = S.get(f"{API}/apps/{aid}/appPriceSchedule")
    have = sched.status_code == 200 and sched.json().get("data")
    free = None if have else next(p for p in call("GET", f"/apps/{aid}/appPricePoints", **{"filter[territory]": "USA", "limit": 200})["data"]
                if float(p["attributes"]["customerPrice"]) == 0)
    if free: call("POST", "/appPriceSchedules", {"data": {"type": "appPriceSchedules", "relationships": {
            "app": {"data": {"type": "apps", "id": aid}},
            "baseTerritory": {"data": {"type": "territories", "id": "USA"}},
            "manualPrices": {"data": [{"type": "appPrices", "id": "${price}"}]}}},
         "included": [{"type": "appPrices", "id": "${price}", "attributes": {"startDate": None},
                       "relationships": {"appPricePoint": {"data": {"type": "appPricePoints", "id": free["id"]}}}}]})
    print("price: free")
    territories, url = [], f"{API}/territories?limit=200"
    while url:
        page = call("GET", url); territories += [t["id"] for t in page["data"]]; url = page["links"].get("next")
    inc = [{"type": "territoryAvailabilities", "id": f"${{{t}}}", "attributes": {"available": True},
            "relationships": {"territory": {"data": {"type": "territories", "id": t}}}} for t in territories]
    call("POST", API.replace("/v1", "/v2") + "/appAvailabilities", {"data": {"type": "appAvailabilities",
         "attributes": {"availableInNewTerritories": True},
         "relationships": {"app": {"data": {"type": "apps", "id": aid}},
                           "territoryAvailabilities": {"data": [{"type": "territoryAvailabilities", "id": i["id"]} for i in inc]}}},
         "included": inc})
    print(f"availability: {len(territories)} territories")

def submit():
    """Send the version that's being prepared to App Review."""
    aid = app()["id"]
    version = next(v for v in call("GET", f"/apps/{aid}/appStoreVersions")["data"]
                   if v["attributes"]["appStoreState"] in ("PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED"))
    sub = call("POST", "/reviewSubmissions", {"data": {"type": "reviewSubmissions", "attributes": {"platform": "IOS"},
               "relationships": {"app": {"data": {"type": "apps", "id": aid}}}}})["data"]
    call("POST", "/reviewSubmissionItems", {"data": {"type": "reviewSubmissionItems", "relationships": {
         "reviewSubmission": {"data": {"type": "reviewSubmissions", "id": sub["id"]}},
         "appStoreVersion": {"data": {"type": "appStoreVersions", "id": version["id"]}}}}})
    call("PATCH", f"/reviewSubmissions/{sub['id']}", {"data": {"type": "reviewSubmissions", "id": sub["id"], "attributes": {"submitted": True}}})
    print("submitted", version["attributes"]["versionString"], "submission", sub["id"])

def review_status():
    aid = app()["id"]
    for v in call("GET", f"/apps/{aid}/appStoreVersions")["data"]:
        print("version", v["attributes"]["versionString"], v["attributes"]["appStoreState"])
    for sub in call("GET", "/reviewSubmissions", **{"filter[app]": aid})["data"]:
        print("submission", sub["id"], sub["attributes"]["state"], sub["attributes"].get("submittedDate"))

def attach_build():
    a = app(); aid = a["id"]
    builds = call("GET", "/builds", **{"filter[app]": aid, "sort": "-uploadedDate"})["data"]
    valid = [b for b in builds if b["attributes"]["processingState"] == "VALID"]
    if not valid:
        print("no processed build yet:", [(b["attributes"]["version"], b["attributes"]["processingState"]) for b in builds]); return
    version = next(v for v in call("GET", f"/apps/{aid}/appStoreVersions")["data"]
                   if v["attributes"]["appStoreState"] == "PREPARE_FOR_SUBMISSION")
    call("PATCH", f"/appStoreVersions/{version['id']}/relationships/build", {"data": {"type": "builds", "id": valid[0]["id"]}})
    print("attached build", valid[0]["attributes"]["version"])

if __name__ == "__main__":
    {"status": status, "apply": apply, "attach-build": attach_build, "pricing": pricing, "submit": submit, "review-status": review_status}[sys.argv[1]]()
