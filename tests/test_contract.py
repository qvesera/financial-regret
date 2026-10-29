"""Contract tests: the three library backends emit exactly the canonical game
row the client consumes -- {id, name, platform, hours, appid} -- with no
stray keys. All upstream HTTP is mocked; no network access.

Regression context: steam_games used to omit 'id' (crashing /api/prices with
a dropped connection) and all three used 'playtime_hours' instead of 'hours',
which the regret math would have read as undefined.
"""
import io
import json
import os
import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

CANONICAL_KEYS = {"id", "name", "platform", "hours", "appid"}


class TestConfigKeyShape(unittest.TestCase):
    """/api/config must say whether the visitor needs their own keys — and
    never leak key material while saying it. The landing page's keys card
    reads these booleans to choose its tag and blurb."""

    def _get(self, env):
        import config
        fake = mock.MagicMock()
        fake.path = "/api/config"
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(config, "send_json") as sj:
            config.handler.do_GET(fake)
        sj.assert_called_once()
        return sj.call_args.args[1], sj.call_args.args[2]

    def test_reports_key_presence_as_booleans_only(self):
        status, body = self._get({"ITAD_API_KEY": "super-secret"})
        self.assertEqual(status, 200)
        self.assertIs(body["requireUserKeys"], False)
        self.assertIs(body["keys"]["itad"], True)
        self.assertEqual(set(body["keys"]), {"steam", "itad", "platprices"})
        # Presence is deployment shape; material never leaves the server.
        self.assertNotIn("super-secret", json.dumps(body))

    def test_byo_mode_reports_required_even_with_keys_set(self):
        # In BYO-key mode the server ignores its own keys, so the card must
        # still read "needed" — the same rule health.py states.
        status, body = self._get({"REQUIRE_USER_KEYS": "1", "ITAD_API_KEY": "k"})
        self.assertEqual(status, 200)
        self.assertIs(body["requireUserKeys"], True)

    def test_keyless_deploy_says_so(self):
        status, body = self._get({})
        self.assertIs(body["requireUserKeys"], False)
        self.assertEqual(body["keys"], {"steam": False, "itad": False,
                                        "platprices": False})


def _resp(json_data, status=200):
    r = mock.MagicMock()
    r.status_code = status
    r.json.return_value = json_data
    return r


class TestSteamShape(unittest.TestCase):
    def test_canonical_row(self):
        import steam_games
        fake = mock.MagicMock()
        fake.path = "/api/steam_games?steamid=42"
        upstream = _resp({"response": {"games": [
            {"appid": 10, "name": "Counter-Strike", "playtime_forever": 120},
            {"appid": 730, "name": "Counter-Strike 2", "playtime_forever": 0},
        ]}})
        with mock.patch.dict(os.environ, {"STEAM_API_KEY": "k"}), \
                mock.patch.object(steam_games, "requests") as rq, \
                mock.patch.object(steam_games, "send_json") as sj:
            rq.get.return_value = upstream
            steam_games.handler.do_GET(fake)
        sj.assert_called_once()
        status, body = sj.call_args.args[1], sj.call_args.args[2]
        self.assertEqual(status, 200)
        first, second = body["games"]
        self.assertEqual(set(first), CANONICAL_KEYS)
        self.assertEqual(first["id"], "Steam:10")
        self.assertEqual(first["hours"], 2.0)
        self.assertEqual(first["platform"], "Steam")
        self.assertEqual(second["id"], "Steam:730")
        self.assertEqual(second["hours"], 0.0)


class TestGogShape(unittest.TestCase):
    def test_canonical_row(self):
        import gog_games
        fake = mock.MagicMock()
        fake.headers = {"X-GOG-Token": "tok"}   # real dict so .get() behaves

        def fake_get(url, **kw):
            if "getFilteredProducts" in url:
                return _resp({"products": [{"id": 100, "title": "Witcher 3"}], "totalPages": 1})
            return _resp({"totalTime": 3_600_000})   # playtime probe: 1.0 h

        with mock.patch.object(gog_games, "requests") as rq, \
                mock.patch.object(gog_games, "send_json") as sj:
            rq.get.side_effect = fake_get
            gog_games.handler.do_GET(fake)
        sj.assert_called_once()
        g = sj.call_args.args[2]["games"][0]
        self.assertEqual(set(g), CANONICAL_KEYS)
        self.assertEqual(g["id"], "GOG:100")
        self.assertEqual(g["platform"], "GOG")
        self.assertEqual(g["hours"], 1.0)


class TestEpicShape(unittest.TestCase):
    def test_canonical_row_and_non_game_filter(self):
        import epic_games
        fake = mock.MagicMock()
        fake.path = "/api/epic_games"
        fake.headers = {"X-Epic-Token": "tok", "X-Epic-Account-Id": "acc"}

        def fake_get(url, **kw):
            if "/items" in url:
                return _resp({
                    "records": [
                        {"appName": "Celeste", "namespace": "ns", "metadata": {"title": "Celeste"}},
                        {"appName": "UE_Thing", "namespace": "ue", "metadata": {"title": "UE Thing"}},
                    ],
                    "responseMetadata": {},
                })
            return _resp({"artifacts": [{"artifactId": "Celeste", "totalTime": 7_200_000}]})

        with mock.patch.object(epic_games, "requests") as rq, \
                mock.patch.object(epic_games, "send_json") as sj:
            rq.get.side_effect = fake_get
            epic_games.handler.do_GET(fake)
        sj.assert_called_once()
        body = sj.call_args.args[2]
        self.assertIsNone(body["next_cursor"], "no further pages in the fixture")
        self.assertEqual(len(body["games"]), 1)
        self.assertEqual(body["filtered_count"], 1, "UE namespace filtered")
        g = body["games"][0]
        self.assertEqual(set(g), CANONICAL_KEYS)
        self.assertEqual(g["id"], "Epic:Celeste")
        self.assertEqual(g["platform"], "Epic")
        self.assertEqual(g["hours"], 2.0)

class TestEpicPagination(unittest.TestCase):
    """One HTTP request fetches exactly one library page; the continuation
    cursor round-trips through the client so huge libraries stream in as
    many short requests instead of one hung one."""

    def setUp(self):
        import epic_games
        epic_games._playtime_cache.clear()

    def test_one_page_per_request_and_playtime_cached(self):
        import epic_games
        fake = mock.MagicMock()
        fake.path = "/api/epic_games"
        fake.headers = {"X-Epic-Token": "tok", "X-Epic-Account-Id": "acc-paged"}
        items_calls = []
        playtime_calls = []

        def fake_get(url, **kw):
            if "/items" in url:
                items_calls.append(dict(kw.get("params") or {}))
                if len(items_calls) == 1:
                    return _resp({
                        "records": [{"appName": "Celeste", "namespace": "ns",
                                     "metadata": {"title": "Celeste"}}],
                        "responseMetadata": {"nextCursor": "CURSOR-2"},
                    })
                return _resp({
                    "records": [{"appName": "Hades", "namespace": "ns",
                                 "metadata": {"title": "Hades"}}],
                    "responseMetadata": {},
                })
            playtime_calls.append(url)
            return _resp({"artifacts": [
                {"artifactId": "Celeste", "totalTime": 3_600_000},
                {"artifactId": "Hades", "totalTime": 3_600_000},
            ]})

        with mock.patch.object(epic_games, "requests") as rq, \
                mock.patch.object(epic_games, "send_json") as sj:
            rq.get.side_effect = fake_get
            epic_games.handler.do_GET(fake)
            status1, body1 = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status1, 200)
        self.assertEqual([g["id"] for g in body1["games"]], ["Epic:Celeste"])
        self.assertEqual(body1["games"][0]["hours"], 1.0)
        self.assertEqual(body1["next_cursor"], "CURSOR-2")
        self.assertEqual(len(items_calls), 1, "handler must fetch one page per request")
        self.assertNotIn("cursor", items_calls[0])

        # Page 2 arrives via the query-string cursor; playtime is not refetched.
        fake.path = "/api/epic_games?cursor=CURSOR-2"
        with mock.patch.object(epic_games, "requests") as rq, \
                mock.patch.object(epic_games, "send_json") as sj:
            rq.get.side_effect = fake_get
            epic_games.handler.do_GET(fake)
            status2, body2 = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status2, 200)
        self.assertEqual([g["id"] for g in body2["games"]], ["Epic:Hades"])
        self.assertEqual(body2["games"][0]["hours"], 1.0, "playtime cache reused across pages")
        self.assertIsNone(body2["next_cursor"], "cursor dried up")
        self.assertEqual(items_calls[-1].get("cursor"), "CURSOR-2", "cursor forwarded upstream")
        self.assertEqual(len(playtime_calls), 1, "playtime fetched once per account")

class TestEpicNonGameFilter(unittest.TestCase):
    """Real-world library-record shapes (legendary#696, Heroic#4200): Fab/UE
    marketplace plugins, Megascans packages, UE builds and DLC must never
    reach the dashboard; real games -- with or without category metadata --
    must survive."""

    def _filter(self, record):
        import epic_games
        return epic_games.is_non_game(record)

    def test_fab_marketplace_plugin_is_filtered(self):
        # Verbatim shape from Heroic#4200 (a real Fab asset record).
        plugin = {
            "appName": "PlatformFunctionsPlugin_5.4",
            "namespace": "89efe5924d3d467c839449ab6ab52e7f",
            "metadata": {
                "title": "Platform Functions",
                "entitlementType": "AUDIENCE",
                "categories": [
                    {"path": "plugins/engine"},
                    {"path": "plugins"},
                    {"path": "asset-format/game-engine"},
                    {"path": "asset-format/game-engine/unreal-engine"},
                    {"path": "type/format-item"},
                ],
                "releaseInfo": [
                    {"appId": "PlatformFunctionsPlugin_5.4", "compatibleApps": ["UE_5.4"]},
                ],
            },
        }
        self.assertTrue(self._filter(plugin))

    def test_megascans_package_is_filtered(self):
        self.assertTrue(self._filter({
            "appName": "ue/87ea817d833d4472995717050553442b",
            "namespace": "quixel",
            "metadata": {"title": "SM_Rock_A"},
        }))

    def test_dlc_pointing_at_a_base_game_is_filtered(self):
        self.assertTrue(self._filter({
            "appName": "SugarDLC",
            "namespace": "ns",
            "mainGameAppName": "Sugar",
            "metadata": {"title": "Rocket League - DLC"},
        }))

    def test_ue_engine_build_is_filtered(self):
        self.assertTrue(self._filter({
            "appName": "UE_5.4", "namespace": "ue", "metadata": {},
        }))

    def test_ue_only_release_info_is_filtered(self):
        self.assertTrue(self._filter({
            "appName": "MysteryTool_1.0",
            "namespace": "ns",
            "metadata": {"title": "Mystery Tool", "releaseInfo": [
                {"appId": "MysteryTool_1.0", "compatibleApps": ["UE_5.2", "UE_5.3"]},
            ]},
        }))

    def test_real_game_survives(self):
        self.assertFalse(self._filter({
            "appName": "Sugar",
            "namespace": "ns",
            "metadata": {"title": "Rocket League", "categories": [
                {"path": "games"}, {"path": "core"},
            ]},
        }))

    def test_game_without_category_metadata_survives(self):
        self.assertFalse(self._filter({
            "appName": "Quail", "namespace": "ns", "metadata": {"title": "20XX"},
        }))

class TestEpicPlaytimeShapes(unittest.TestCase):
    """Epic's playtime endpoint returns a bare top-level list for some
    accounts; a dict-only parser raised AttributeError and 500'd the whole
    scan. Both shapes must yield hours without crashing."""

    def setUp(self):
        import epic_games
        epic_games._playtime_cache.clear()

    def test_bare_list_playtime_parses(self):
        import epic_games
        fake = mock.MagicMock()
        fake.path = "/api/epic_games"
        fake.headers = {"X-Epic-Token": "tok", "X-Epic-Account-Id": "acc-list"}

        def fake_get(url, **kw):
            if "/items" in url:
                return _resp({
                    "records": [{"appName": "Celeste", "namespace": "ns",
                                 "metadata": {"title": "Celeste"}}],
                    "responseMetadata": {},
                })
            return _resp([{"artifactId": "Celeste", "totalTime": 7_200_000}])

        with mock.patch.object(epic_games, "requests") as rq, \
                mock.patch.object(epic_games, "send_json") as sj:
            rq.get.side_effect = fake_get
            epic_games.handler.do_GET(fake)   # used to raise AttributeError here
            status, body = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        self.assertEqual(body["games"][0]["hours"], 2.0)

    def test_garbage_playtime_payload_degrades_to_no_hours(self):
        import epic_games
        fake = mock.MagicMock()
        fake.path = "/api/epic_games"
        fake.headers = {"X-Epic-Token": "tok", "X-Epic-Account-Id": "acc-junk"}

        def fake_get(url, **kw):
            if "/items" in url:
                return _resp({
                    "records": [{"appName": "Celeste", "namespace": "ns",
                                 "metadata": {"title": "Celeste"}}],
                    "responseMetadata": {},
                })
            return _resp({"artifacts": "not-a-list", "weird": None})

        with mock.patch.object(epic_games, "requests") as rq, \
                mock.patch.object(epic_games, "send_json") as sj:
            rq.get.side_effect = fake_get
            epic_games.handler.do_GET(fake)
            status, body = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        self.assertIsNone(body["games"][0]["hours"], "unknown playtime stays null")

class TestEpicNameShapes(unittest.TestCase):
    """Adobe Substance tools and Fab asset ids arrive WITHOUT the usual
    ue-namespace / category markers and must be dropped by name shape."""

    def _record(self, app_name, title=None):
        return {
            "appName": app_name, "namespace": "somecatalogslug",
            "metadata": {"title": title if title is not None else app_name},
        }

    def test_substance_tools_dropped(self):
        import epic_games
        for n in ("Substance_4.17", "Substance_5.0", "Substance_5.4",
                  "Substance 3D Painter", "Adobe Substance 3D Designer"):
            self.assertTrue(epic_games.is_non_game(self._record(n)), n)

    def test_fab_asset_ids_dropped(self):
        import epic_games
        # Truncated-name + hex + version ids seen in real libraries.
        for n in ("Substanc8f08b879e842V26", "Substanc62d2b1b7d197V27",
                  "Substanc16fa4e5b3fbcV28", "Substanc34306f24483V29"):
            self.assertTrue(epic_games.is_non_game(self._record(n)), n)

    def test_real_games_survive_name_shapes(self):
        import epic_games
        for n in ("Celeste", "Hades", "Subnautica", "Satisfactory",
                  "XCOM 2", "Frostpunk 2", "Death Stranding Director's Cut",
                  "The Witcher 3 Wild Hunt"):
            self.assertFalse(epic_games.is_non_game(self._record(n)), n)

class TestEpicClassifyAndDebug(unittest.TestCase):
    """classify() must return a stable reason string for drops (surfaced by
    ?debug=1 so the filter can be tuned against a real library)."""

    def test_classify_reasons(self):
        import epic_games
        self.assertEqual(epic_games.classify({"appName": "UE_5.4", "namespace": "ue"}), "namespace:ue")
        self.assertEqual(
            epic_games.classify({"appName": "Sugar", "namespace": "ns", "mainGameAppName": "Base"}),
            "dlc")
        self.assertEqual(
            epic_games.classify({"appName": "Sugar", "namespace": "ns",
                                 "metadata": {"entitlementType": "AUDIENCE"}}),
            "entitlement:AUDIENCE")
        self.assertEqual(epic_games.classify({"appName": "Substance_5.0", "namespace": "ns",
                                              "metadata": {"title": "Substance_5.0"}}),
                         "name-shape:tool-prefix")
        self.assertIsNone(epic_games.classify(
            {"appName": "Sugar", "namespace": "ns", "metadata": {"title": "Rocket League"}}))

    def test_debug_payload_carries_reasons_and_fields(self):
        import epic_games
        records = [
            {"appName": "Sugar", "namespace": "ns",
             "metadata": {"title": "Rocket League", "entitlementType": "EXECUTABLE",
                          "categories": [{"path": "games"}]}},
            {"appName": "Substance_5.0", "namespace": "ns",
             "metadata": {"title": "Substance_5.0", "entitlementType": "EXECUTABLE"}},
            {"appName": "AssetDeadbeefcafeV3", "namespace": "ns", "metadata": {"title": "Asset"}},
        ]
        fake = mock.MagicMock()
        fake.path = "/api/epic_games?debug=1"
        fake.headers = {"X-Epic-Token": "tok"}
        with mock.patch.object(epic_games, "fetch_library_page", return_value=(records, None)), \
                mock.patch.object(epic_games, "send_json") as sj:
            epic_games.handler.do_GET(fake)
            status, body = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        self.assertEqual([g["name"] for g in body["games"]], ["Rocket League"])
        self.assertEqual(body["filtered_count"], 2)
        dbg = {d["appName"]: d for d in body["debug"]}
        self.assertTrue(dbg["Sugar"]["kept"])
        self.assertIsNone(dbg["Sugar"]["reason"])
        self.assertFalse(dbg["Substance_5.0"]["kept"])
        self.assertEqual(dbg["Substance_5.0"]["reason"], "name-shape:tool-prefix")
        self.assertEqual(dbg["Substance_5.0"]["entitlementType"], "EXECUTABLE")
        self.assertFalse(dbg["AssetDeadbeefcafeV3"]["kept"])
        self.assertEqual(dbg["AssetDeadbeefcafeV3"]["reason"], "name-shape:fab-id")

    def test_no_debug_by_default(self):
        import epic_games
        fake = mock.MagicMock()
        fake.path = "/api/epic_games"
        fake.headers = {"X-Epic-Token": "tok"}
        with mock.patch.object(epic_games, "fetch_library_page", return_value=([], None)), \
                mock.patch.object(epic_games, "send_json") as sj:
            epic_games.handler.do_GET(fake)
            body = sj.call_args.args[2]
        self.assertNotIn("debug", body)

class TestEpicSandboxName(unittest.TestCase):
    """Verified against a live library dump: games carry a clean commercial
    `sandboxName` while `appName` is an internal codename (Sugar -> "Rocket
    League"); Fab/UE junk shows a technical sandboxName, a hex appName, or a
    dev-kit name."""

    def _rec(self, appName, sandboxName, namespace="ns", **md):
        return {"appName": appName, "sandboxName": sandboxName,
                "namespace": namespace, "metadata": md}

    def test_codename_games_survive(self):
        import epic_games
        for app, sandbox in [("Sugar", "Rocket League®"), ("Quail", "20XX"),
                             ("Hoatzin", "Totally Reliable Delivery Service"),
                             ("Lyrebird", "Hob"), ("Fortnite", "Fortnite")]:
            ns = "fn" if app == "Fortnite" else "ns"
            self.assertFalse(epic_games.is_non_game(self._rec(app, sandbox, namespace=ns)), sandbox)

    def test_fab_listing_and_namespace_dropped(self):
        import epic_games
        self.assertEqual(
            epic_games.classify(self._rec("MayaLiveLink", "fab-listing-live",
                                          namespace=epic_games.FAB_NAMESPACE)),
            f"namespace:{epic_games.FAB_NAMESPACE}")
        # A Fab listing under any other namespace is still caught by sandboxName.
        self.assertEqual(
            epic_games.classify(self._rec("SomePack", "fab-listing-live")), "sandbox-marker")

    def test_ut_marketplace_dropped_by_sandbox(self):
        import epic_games
        self.assertEqual(
            epic_games.classify(self._rec("UnrealTournamentDev", "UT Marketplace", namespace="ut")),
            "sandbox-marker")

    def test_devkit_dropped_by_app_name(self):
        import epic_games
        # ARKDevKit's sandboxName "Ark" looks like a game; appName gives it away.
        self.assertEqual(
            epic_games.classify(self._rec("ARKDevKit", "Ark", namespace="ark")), "name-shape:devkit")

    def test_hex_app_name_is_a_valid_game_record(self):
        # Epic uses hex catalog-item IDs as appNames for a huge number of real
        # games (the title lives in sandboxName). Sub-entitlements that share a
        # sandbox are collapsed by dedupe, not dropped here -- dropping hex
        # appNames wholesale wrongly removed ~440 real games (Heroic: 528).
        import epic_games
        self.assertIsNone(epic_games.classify(
            self._rec("aa31f9e94e844b299ca757d1d0b97a09", "Rocket League®", namespace="fn")))

    def test_sandbox_tool_names_and_service_buckets_dropped(self):
        import epic_games
        hexname = "ac8f20a7931e4d63a1db4dc1267ec3d1"
        # Creator-tool names ship in sandboxName behind a hex appName.
        self.assertEqual(epic_games.classify(self._rec(hexname, "Twinmotion", namespace="ns")), "name-shape:tool-prefix")
        self.assertEqual(epic_games.classify(self._rec(hexname, "RealityCapture", namespace="ns")), "name-shape:tool-prefix")
        # "<codename> Production" UE project sandboxes.
        self.assertEqual(epic_games.classify(self._rec(hexname, "mindaro Production", namespace="ns")), "sandbox:suffix")
        # Epic's online-service bucket (215 records under one sandbox in a real library).
        self.assertEqual(epic_games.classify(self._rec(hexname, "Live", namespace="ns")), "sandbox:junk-name")
        # Suffix safety: a game merely containing the word survives.
        self.assertIsNone(epic_games.classify(self._rec(hexname, "Production Line", namespace="ns")))

    def test_handler_titles_by_sandbox_name(self):
        import epic_games
        records = [
            {"appName": "Sugar", "sandboxName": "Rocket League®", "namespace": "ns",
             "metadata": {"title": "Sugar"}},
            {"appName": "MayaLiveLink", "sandboxName": "fab-listing-live",
             "namespace": epic_games.FAB_NAMESPACE, "metadata": {}},
            {"appName": "aa31f9e94e844b299ca757d1d0b97a09", "sandboxName": "Fortnite",
             "namespace": "fn", "metadata": {}},
        ]
        fake = mock.MagicMock()
        fake.path = "/api/epic_games"
        fake.headers = {"X-Epic-Token": "tok"}
        with mock.patch.object(epic_games, "fetch_library_page", return_value=(records, None)), \
                mock.patch.object(epic_games, "send_json") as sj:
            epic_games.handler.do_GET(fake)
            status, body = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        # The hex record is now a kept game too (titled by its sandboxName);
        # only the Fab listing is filtered.
        self.assertEqual([g["name"] for g in body["games"]], ["Rocket League®", "Fortnite"])
        self.assertEqual(body["games"][0]["appid"], "Sugar", "appid stays the codename for playtime")
        self.assertEqual(body["filtered_count"], 1)

    def test_handler_catalog_overrides_sandbox_and_filters_dlc(self):
        """The catalog's `categories`/`title` beat the sandboxName heuristics.

        A real game whose sandboxName is the generic "Live" (classify drops it
        as a junk bucket) must survive with its real catalog title; a codename
        sandbox must resolve to the commercial title; and a DLC the heuristics
        let through must be dropped because the catalog says `addons`.
        """
        import epic_games
        records = [
            {"appName": "112op", "sandboxName": "Live", "namespace": "ns112",
             "catalogItemId": "id112", "metadata": {}},       # classify -> sandbox:junk-name
            {"appName": "plaguecodename", "sandboxName": "MtWilliamson",
             "namespace": "nsplague", "catalogItemId": "idplague", "metadata": {}},
            {"appName": "somedlc", "sandboxName": "Some DLC", "namespace": "nsdlc",
             "catalogItemId": "iddlc", "metadata": {}},       # classify keeps, catalog -> addons
        ]
        catalog = {
            ("ns112", "id112"): {"title": "112 Operator",
                                 "categories": [{"path": "games"}, {"path": "applications"}]},
            ("nsplague", "idplague"): {"title": "A Plague Tale: Innocence",
                                       "categories": [{"path": "games"}]},
            ("nsdlc", "iddlc"): {"title": "Some Game DLC",
                                 "categories": [{"path": "addons"}]},
        }
        fake = mock.MagicMock()
        fake.path = "/api/epic_games"
        fake.headers = {"X-Epic-Token": "tok"}
        with mock.patch.object(epic_games, "fetch_library_page", return_value=(records, None)), \
                mock.patch.object(epic_games, "resolve_catalog_titles", return_value=catalog), \
                mock.patch.object(epic_games, "send_json") as sj:
            epic_games.handler.do_GET(fake)
            status, body = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        by_name = {g["name"]: g for g in body["games"]}
        # The "Live" game survives the junk bucket with its REAL catalog title.
        self.assertIn("112 Operator", by_name)
        # The codename sandbox resolves to the commercial title.
        self.assertIn("A Plague Tale: Innocence", by_name)
        # The catalog drops the DLC the heuristics would have let through.
        self.assertNotIn("Some Game DLC", by_name)
        # appid stays the library appName so playtime still resolves.
        self.assertEqual(by_name["112 Operator"]["appid"], "112op")
        self.assertEqual(body["filtered_count"], 1)

class TestPricesTitleResolution(unittest.TestCase):
    """ITAD titles differ from a library's by ®/™ symbols and leading articles;
    the resolver must still match them (regression: famous games showed an
    'unknown' price because the exact-match guard rejected a correct hit)."""

    def setUp(self):
        import prices
        prices._title_cache.clear()
        prices._price_cache.clear()

    def test_alnum_folds_symbols_and_case(self):
        import prices
        self.assertEqual(prices._alnum("Sid Meier's Civilization® VI"),
                         prices._alnum("Sid Meier's Civilization VI"))
        self.assertEqual(prices._alnum("STAR WARS™: Squadrons"),
                         prices._alnum("Star Wars Squadrons"))
        self.assertNotEqual(prices._alnum("Doom"), prices._alnum("Doom Eternal"))

    def test_best_search_match_picks_base_not_bundle(self):
        import prices
        cands = [
            {"id": "a", "title": "The Jackbox Party Pack 4"},
            {"id": "b", "title": "The Jackbox Party Pack 4 - Soundtrack"},
            {"id": "c", "title": "The Jackbox Party Pack 4 - Game + Soundtrack Bundle"},
        ]
        self.assertEqual(prices._best_search_match("Jackbox Party Pack 4", cands), "a")

    def test_best_search_match_exact_wins_and_rejects_far_titles(self):
        import prices
        self.assertEqual(
            prices._best_search_match("Doom", [{"id": "x", "title": "Doom Eternal"}, {"id": "y", "title": "Doom"}]),
            "y")
        self.assertIsNone(prices._best_search_match("Hob", [{"id": "z", "title": "Hogwarts Legacy"}]))

    def test_resolve_matches_lookup_despite_registered_symbol(self):
        import prices

        def fake_get(url, **kw):
            r = mock.MagicMock(); r.status_code = 200
            r.json.return_value = ({"found": True, "game": {"id": "civ", "title": "Sid Meier's Civilization® VI"}}
                                   if url.endswith("/lookup/v1") else [])
            return r

        with mock.patch.object(prices, "requests") as rq:
            rq.get.side_effect = fake_get
            rq.RequestException = Exception
            self.assertEqual(prices._resolve_title("k", "Sid Meier's Civilization VI"), ("civ", False))

    def test_resolve_falls_back_to_search_for_missing_article(self):
        import prices

        def fake_get(url, **kw):
            r = mock.MagicMock(); r.status_code = 200
            r.json.return_value = ({"found": False, "game": None} if url.endswith("/lookup/v1") else
                                   [{"id": "jb", "title": "The Jackbox Party Pack 4"},
                                    {"id": "jbs", "title": "The Jackbox Party Pack 4 - Soundtrack"}])
            return r

        with mock.patch.object(prices, "requests") as rq:
            rq.get.side_effect = fake_get
            rq.RequestException = Exception
            self.assertEqual(prices._resolve_title("k", "Jackbox Party Pack 4"), ("jb", False))

    def test_confirmed_miss_is_cached_but_rate_limit_is_not(self):
        import prices

        def miss_get(url, **kw):
            r = mock.MagicMock(); r.status_code = 200
            r.json.return_value = {"found": False, "game": None} if url.endswith("/lookup/v1") else []
            return r

        def limited_get(url, **kw):
            r = mock.MagicMock(); r.status_code = 429
            return r

        # A genuine miss is cached as _MISS so the next scan skips it.
        with mock.patch.object(prices, "requests") as rq:
            rq.get.side_effect = miss_get
            rq.RequestException = Exception
            self.assertIsNone(prices._lookup_by_title("k", "Nonexistent Game"))
            self.assertIs(prices._cache_get(prices._title_cache, "Nonexistent Game"), prices._MISS)

        prices._title_cache.clear()
        # A rate-limited scan must NOT poison the cache (nothing cached).
        with mock.patch.object(prices, "requests") as rq:
            rq.get.side_effect = limited_get
            rq.RequestException = Exception
            self.assertIsNone(prices._lookup_by_title("k", "Some Game"))
            self.assertIsNone(prices._cache_get(prices._title_cache, "Some Game"))

    def test_titles_resolve_via_batched_lookup(self):
        """Titles resolve through ONE batched /lookup/id/title/v1 call, not a
        call per game: the per-title lookup+search path exceeded ITAD's rate
        limit (1000 req / 5 min) and blanked large Epic scans, while Steam's
        batched appid lookup stayed fine. A title the batch can't match still
        falls back to the fuzzy search."""
        import prices
        body = json.dumps({"games": [
            {"id": "Epic:1", "title": "Hob", "platform": "Epic"},
            {"id": "Epic:2", "title": "Witness", "platform": "Epic"},
            {"id": "Epic:3", "title": "Celeste", "platform": "Epic"},
        ]}).encode()
        fake = mock.MagicMock()
        fake.path = "/api/prices"
        fake.headers = {"Content-Length": str(len(body)), "X-ITAD-Key": "K"}
        fake.rfile = io.BytesIO(body)
        bulk_calls = []

        def fake_post(url, params=None, json=None, timeout=None):
            r = mock.MagicMock()
            r.status_code = 200
            if "/lookup/id/title/v1" in str(url):
                bulk_calls.append(list(json or []))
                r.json.return_value = {"hob": "id-hob", "witness": None,
                                       "celeste": "id-celeste"}
                return r
            # prices/v3
            r.json.return_value = [
                {"id": "id-hob", "deals": [{"price": {"amount": 10.0, "currency": "INR"}}]},
                {"id": "id-witness", "deals": [{"price": {"amount": 30.0, "currency": "INR"}}]},
                {"id": "id-celeste", "deals": [{"price": {"amount": 20.0, "currency": "INR"}}]},
            ]
            return r

        def fake_get(url, params=None, timeout=None):
            r = mock.MagicMock()
            r.status_code = 200
            # fuzzy search resolves the batch's miss; lookup finds nothing
            r.json.return_value = ([{"id": "id-witness", "title": "The Witness"}]
                                   if "/search/" in str(url) else {"found": False})
            return r

        with mock.patch.object(prices, "requests") as rq, \
                mock.patch.object(prices, "send_json") as sj:
            rq.post.side_effect = fake_post
            rq.get.side_effect = fake_get
            rq.RequestException = Exception
            prices.handler.do_POST(fake)
            status, payload = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        self.assertEqual(len(bulk_calls), 1, "all titles resolved in one batch")
        self.assertEqual(set(bulk_calls[0]), {"hob", "witness", "celeste"})
        self.assertEqual(payload["resolved"]["Epic:1"], "id-hob")
        self.assertEqual(payload["resolved"]["Epic:3"], "id-celeste")
        self.assertEqual(payload["resolved"]["Epic:2"], "id-witness",
                         "fuzzy fallback caught the batch's miss")
        self.assertEqual(payload["prices"]["Epic:1"], 10.0)

class TestUserSuppliedKeys(unittest.TestCase):
    """A caller's own X-ITAD-Key / X-Steam-Key must override the server .env
    key so each user brings their own rate-limit quota (public-hosting mode)."""

    def setUp(self):
        import prices
        prices._title_cache.clear()
        prices._price_cache.clear()

    def test_itad_header_key_overrides_env(self):
        import prices
        body = json.dumps({"games": [{"id": "Epic:X", "title": "Hob", "platform": "Epic"}]}).encode()
        fake = mock.MagicMock()
        fake.path = "/api/prices"
        fake.headers = {"Content-Length": str(len(body)), "X-ITAD-Key": "USERKEY"}
        fake.rfile = io.BytesIO(body)
        seen = []

        def fake_get(url, **kw):
            seen.append((kw.get("params") or {}).get("key"))
            r = mock.MagicMock(); r.status_code = 200
            r.json.return_value = {"found": True, "game": {"id": "hob-id", "title": "Hob"}}
            return r

        with mock.patch.dict(os.environ, {"ITAD_API_KEY": "ENVKEY"}), \
                mock.patch.object(prices, "requests") as rq, \
                mock.patch.object(prices, "send_json") as sj:
            rq.get.side_effect = fake_get
            rq.RequestException = Exception
            rq.post.return_value = _resp([])
            prices.handler.do_POST(fake)

        self.assertTrue(seen, "a title lookup should have run")
        self.assertEqual(seen[0], "USERKEY", "the X-ITAD-Key header must beat the env key")

    def test_steam_header_key_overrides_env(self):
        import steam_games
        fake = mock.MagicMock()
        fake.path = "/api/steam_games?steamid=42"
        fake.headers = {"X-Steam-Key": "STEAMUSER"}
        seen = {}

        def fake_get(url, **kw):
            seen["key"] = (kw.get("params") or {}).get("key")
            return _resp({"response": {"games": []}})

        with mock.patch.dict(os.environ, {"STEAM_API_KEY": "STEAMENV"}), \
                mock.patch.object(steam_games, "requests") as rq, \
                mock.patch.object(steam_games, "send_json") as sj:
            rq.get.side_effect = fake_get
            steam_games.handler.do_GET(fake)

        self.assertEqual(seen.get("key"), "STEAMUSER", "X-Steam-Key must beat the env key")


class TestCurrencySelection(unittest.TestCase):
    """The chosen currency is forwarded to ITAD, the store region follows it
    (USD -> US store) so the amount is denominated correctly, and the response
    reports the currency the amounts are actually in."""

    def setUp(self):
        import prices
        prices._title_cache.clear()
        prices._price_cache.clear()

    @staticmethod
    def _req(currency):
        body = json.dumps({
            "games": [{"id": "Steam:730", "title": "Counter-Strike 2",
                       "appid": 730, "platform": "Steam"}],
            "currency": currency,
        }).encode()
        fake = mock.MagicMock()
        fake.path = "/api/prices"
        fake.headers = {"Content-Length": str(len(body)), "X-ITAD-Key": "TESTKEY"}
        fake.rfile = io.BytesIO(body)
        return fake

    def test_currency_forwarded_and_region_follows(self):
        import prices
        fake = self._req("USD")
        price_params = []

        def fake_post(url, params=None, json=None, timeout=None):
            r = mock.MagicMock()
            r.status_code = 200
            if "/lookup/id/shop/" in url:
                r.json.return_value = {"app/730": "itad-1"}
                return r
            price_params.append(dict(params or {}))
            r.json.return_value = [
                {"id": "itad-1", "deals": [{"price": {"amount": 24.99, "currency": "USD"}}]},
            ]
            return r

        with mock.patch.object(prices, "requests") as rq, \
                mock.patch.object(prices, "send_json") as sj:
            rq.post.side_effect = fake_post
            rq.RequestException = Exception
            prices.handler.do_POST(fake)
            status, payload = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        self.assertEqual(price_params[0].get("country"), "US", "region follows USD")
        self.assertEqual(price_params[0].get("currency"), "USD", "currency is forwarded")
        self.assertEqual(payload["currency"], "USD", "reported currency matches ITAD's label")
        self.assertEqual(payload["prices"]["Steam:730"], 24.99)

    def test_currency_rejected_falls_back_to_region_pricing(self):
        import prices
        fake = self._req("EUR")
        price_params = []

        def fake_post(url, params=None, json=None, timeout=None):
            r = mock.MagicMock()
            if "/lookup/id/shop/" in url:
                r.status_code = 200
                r.json.return_value = {"app/730": "itad-1"}
                return r
            price_params.append(dict(params or {}))
            if "currency" in (params or {}):
                r.status_code = 400            # ITAD rejects the currency param
                return r
            r.status_code = 200
            r.json.return_value = [
                {"id": "itad-1", "deals": [{"price": {"amount": 19.99, "currency": "EUR"}}]},
            ]
            return r

        with mock.patch.object(prices, "requests") as rq, \
                mock.patch.object(prices, "send_json") as sj:
            rq.post.side_effect = fake_post
            rq.RequestException = Exception
            prices.handler.do_POST(fake)
            status, payload = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        self.assertEqual(price_params[0].get("currency"), "EUR")
        self.assertEqual(price_params[0].get("country"), "DE", "EUR maps to the DE store")
        # 400 on the currency param -> retried region-only, still priced.
        self.assertEqual(len(price_params), 2)
        self.assertNotIn("currency", price_params[1])
        self.assertEqual(price_params[1].get("country"), "DE")
        self.assertEqual(payload["currency"], "EUR")
        self.assertEqual(payload["prices"]["Steam:730"], 19.99)

    def test_high_and_low_bounds_are_returned(self):
        """Each game also reports its all-time high (the top list price any
        shop asks) and its all-time low so the dashboard can bound the
        library value instead of showing a single point estimate."""
        import prices
        fake = self._req("INR")

        def fake_post(url, params=None, json=None, timeout=None):
            r = mock.MagicMock()
            r.status_code = 200
            if "/lookup/id/shop/" in url:
                r.json.return_value = {"app/730": "itad-1"}
                return r
            r.json.return_value = [
                {"id": "itad-1",
                 "historyLow": {"all": {"amount": 275, "currency": "INR"}},
                 "deals": [
                     {"price": {"amount": 1100, "currency": "INR"},
                      "regular": {"amount": 1100, "currency": "INR"}},
                     {"price": {"amount": 1591.81, "currency": "INR"},
                      "regular": {"amount": 1591.81, "currency": "INR"}},
                 ]},
            ]
            return r

        with mock.patch.object(prices, "requests") as rq, \
                mock.patch.object(prices, "send_json") as sj:
            rq.post.side_effect = fake_post
            rq.RequestException = Exception
            prices.handler.do_POST(fake)
            status, payload = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        self.assertEqual(payload["prices"]["Steam:730"], 1100, "cheapest current deal")
        self.assertEqual(payload["highs"]["Steam:730"], 1591.81, "highest list price")
        self.assertEqual(payload["lows"]["Steam:730"], 275, "all-time low from historyLow")

    def test_null_regular_and_store_low_do_not_crash(self):
        """ITAD sends null for regular/storeLow on some deals. `.get(key, {})`
        only defaults on a MISSING key, so a null value used to raise
        AttributeError and take the entire pricing request down with it."""
        import prices
        fake = self._req("INR")

        def fake_post(url, params=None, json=None, timeout=None):
            r = mock.MagicMock()
            r.status_code = 200
            if "/lookup/id/shop/" in url:
                r.json.return_value = {"app/730": "itad-1"}
                return r
            r.json.return_value = [
                {"id": "itad-1",
                 "historyLow": {"all": {"amount": 100, "currency": "INR"}},
                 "deals": [
                     {"price": {"amount": 200, "currency": "INR"},
                      "regular": None, "storeLow": None},
                     {"price": {"amount": 150, "currency": "INR"},
                      "regular": None, "storeLow": None},
                 ]},
            ]
            return r

        with mock.patch.object(prices, "requests") as rq, \
                mock.patch.object(prices, "send_json") as sj:
            rq.post.side_effect = fake_post
            rq.RequestException = Exception
            prices.handler.do_POST(fake)
            status, payload = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200, "null fields must not crash the handler")
        self.assertEqual(payload["prices"]["Steam:730"], 150, "cheapest deal")
        self.assertEqual(payload["highs"]["Steam:730"], 200,
                         "no regular -> falls back to the top current price")
        self.assertEqual(payload["lows"]["Steam:730"], 100, "historyLow still wins")


class TestCovers(unittest.TestCase):
    """Grid-view cover art comes from SteamGridDB: the caller's own key, a
    direct appid lookup for Steam games, a title search for everything else,
    and a placeholder-friendly 401 when no key is configured."""

    def setUp(self):
        import covers
        covers._cache.clear()

    @staticmethod
    def _req(games, with_key=True):
        body = json.dumps({"games": games}).encode()
        fake = mock.MagicMock()
        fake.path = "/api/covers"
        fake.headers = {"Content-Length": str(len(body))}
        if with_key:
            fake.headers["X-SGDB-Key"] = "SGDBKEY"
        fake.rfile = io.BytesIO(body)
        return fake

    def test_missing_key_is_401(self):
        import covers
        fake = self._req([{"id": "Steam:730", "title": "Counter-Strike 2", "appid": 730}],
                         with_key=False)
        with mock.patch.dict(os.environ, {"SGDB_API_KEY": ""}), \
                mock.patch.object(covers, "send_json") as sj:
            covers.handler.do_POST(fake)
        status, payload = sj.call_args.args[1], sj.call_args.args[2]
        self.assertEqual(status, 401)
        self.assertIn("SteamGridDB", payload["error"])

    def test_steam_game_resolves_directly_from_appid(self):
        import covers
        fake = self._req([{"id": "Steam:730", "title": "Counter-Strike 2", "appid": 730}])
        calls = []

        def fake_get(url, params=None, headers=None, timeout=None):
            calls.append(url)
            r = mock.MagicMock()
            r.status_code = 200
            r.json.return_value = {
                "success": True,
                "data": [{"id": 1, "url": "https://cdn2.steamgriddb.com/grid/x.jpg"}],
            }
            return r

        with mock.patch.object(covers, "requests") as rq, \
                mock.patch.object(covers, "send_json") as sj:
            rq.get.side_effect = fake_get
            rq.RequestException = Exception
            covers.handler.do_POST(fake)
            status, payload = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        self.assertEqual(payload["covers"]["Steam:730"],
                         "https://cdn2.steamgriddb.com/grid/x.jpg")
        self.assertTrue(any("/grids/steam/730" in u for u in calls), "direct appid lookup")
        self.assertFalse(any("/search/" in u for u in calls), "no search needed for Steam")

    def test_non_steam_game_searches_by_title(self):
        import covers
        fake = self._req([{"id": "Epic:1", "title": "Celeste"}])
        calls = []

        def fake_get(url, params=None, headers=None, timeout=None):
            calls.append(url)
            r = mock.MagicMock()
            r.status_code = 200
            if "/search/" in url:
                r.json.return_value = {"success": True, "data": [{"id": 42, "name": "Celeste"}]}
            else:
                r.json.return_value = {
                    "success": True,
                    "data": [{"url": "https://cdn2.steamgriddb.com/grid/c.jpg"}],
                }
            return r

        with mock.patch.object(covers, "requests") as rq, \
                mock.patch.object(covers, "send_json") as sj:
            rq.get.side_effect = fake_get
            rq.RequestException = Exception
            covers.handler.do_POST(fake)
            status, payload = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        self.assertEqual(payload["covers"]["Epic:1"],
                         "https://cdn2.steamgriddb.com/grid/c.jpg")
        self.assertTrue(any("/grids/game/42" in u for u in calls),
                        "searched first, then fetched by game id")


class TestApiDispatch(unittest.TestCase):
    """A handler crash must always produce a response. HTTP/1.1 keep-alive
    reuses the connection object, so `_response_sent` is still True from the
    previous request -- without a per-request reset the 500 fallback is skipped
    and the browser sits on 'pending' forever instead of getting an error."""

    def test_crash_returns_500_even_on_a_reused_connection(self):
        import server
        fake = mock.MagicMock()
        fake.path = "/api/boom"
        fake.headers = {}
        fake._response_sent = True          # stale flag from the previous response

        boom = mock.MagicMock()
        boom.do_POST.side_effect = RuntimeError("boom")

        with mock.patch.object(server, "_load_api_handler", return_value=boom):
            server.DevRequestHandler._dispatch_api(fake, "do_POST")

        fake._send_json.assert_called_once()
        self.assertEqual(fake._send_json.call_args.args[0], 500)
        self.assertEqual(fake._send_json.call_args.args[1],
                         {"error": "Internal server error"})


class TestAmazonLibrary(unittest.TestCase):
    """Amazon has no public library API: the exchange mirrors the launcher's
    device registration, and the library is the AGS GetEntitlements call (DLC
    rides in the same list, and there is no playtime). Both must emit the
    canonical game row the client consumes."""

    def test_exchange_reads_bearer_from_register_response(self):
        import amazon_exchange
        body = json.dumps({
            "code": "CODE123", "client_id": "abc", "code_verifier": "v", "serial": "SER",
        }).encode()
        fake = mock.MagicMock()
        fake.path = "/api/amazon_exchange"
        fake.headers = {"Content-Length": str(len(body))}
        fake.rfile = io.BytesIO(body)
        upstream = _resp({
            "response": {"success": {
                "tokens": {"bearer": {"access_token": "TOK", "refresh_token": "REF",
                                      "expires_in": 3600}},
                "extensions": {
                    "device_info": {"device_serial_number": "SER"},
                    "customer_info": {"customer_id": "cust-1"},
                },
            }},
        })

        with mock.patch.object(amazon_exchange, "requests") as rq, \
                mock.patch.object(amazon_exchange, "send_json") as sj:
            rq.post.return_value = upstream
            rq.RequestException = Exception
            amazon_exchange.handler.do_POST(fake)
            status, payload = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        self.assertEqual(payload["access_token"], "TOK")
        self.assertEqual(payload["refresh_token"], "REF")
        self.assertEqual(payload["user_id"], "cust-1")
        self.assertEqual(payload["serial"], "SER")

    def test_exchange_rejects_missing_fields(self):
        import amazon_exchange
        body = json.dumps({"code": "ONLY"}).encode()
        fake = mock.MagicMock()
        fake.path = "/api/amazon_exchange"
        fake.headers = {"Content-Length": str(len(body))}
        fake.rfile = io.BytesIO(body)
        with mock.patch.object(amazon_exchange, "send_json") as sj:
            amazon_exchange.handler.do_POST(fake)
            status, payload = sj.call_args.args[1], sj.call_args.args[2]
        self.assertEqual(status, 400)
        self.assertIn("client_id", payload["error"])

    def test_games_emit_canonical_rows_and_drop_dlc(self):
        import amazon_games
        fake = mock.MagicMock()
        fake.path = "/api/amazon_games"
        fake.headers = {"X-Amazon-Token": "TOK", "X-Amazon-Serial": "SER"}
        entitlements = [
            {"product": {"id": "p1", "title": "Hades"}},
            {"product": {"id": "p2", "title": "Hades - DLC"}},
            {"product": {"id": "p3", "title": "The Witness"}},
            {"product": {"id": "p1", "title": "Hades"}},   # duplicate product
        ]
        upstream = _resp({"entitlements": entitlements, "nextToken": None})

        with mock.patch.object(amazon_games, "requests") as rq, \
                mock.patch.object(amazon_games, "send_json") as sj:
            rq.post.return_value = upstream
            rq.RequestException = Exception
            amazon_games.handler.do_GET(fake)
            status, payload = sj.call_args.args[1], sj.call_args.args[2]

        self.assertEqual(status, 200)
        rows = payload["games"]
        self.assertEqual({g["id"] for g in rows}, {"Amazon:p1", "Amazon:p3"},
                         "DLC dropped and duplicate product collapsed")
        # The exact X-Amz-Target / operation Amazon requires (a wrong FQN yields
        # coral UnknownOperationException 404) — regression-guarded.
        sent = rq.post.call_args.kwargs
        self.assertEqual(sent["headers"]["X-Amz-Target"],
                         "com.amazon.animusdistributionservice.entitlement."
                         "AnimusEntitlementsService.GetEntitlements")
        self.assertEqual(sent["json"]["Operation"], "GetEntitlements")
        for g in rows:
            self.assertEqual(set(g), CANONICAL_KEYS)
            self.assertEqual(g["platform"], "Amazon")
            self.assertIsNone(g["hours"], "Amazon exposes no playtime")
            self.assertIsNone(g["appid"])

    def test_games_surfaces_expired_session(self):
        import amazon_games
        fake = mock.MagicMock()
        fake.path = "/api/amazon_games"
        fake.headers = {"X-Amazon-Token": "STALE", "X-Amazon-Serial": "SER"}
        upstream = _resp({"error": "unauthorized"}, status=401)
        with mock.patch.object(amazon_games, "requests") as rq, \
                mock.patch.object(amazon_games, "send_json") as sj:
            rq.post.return_value = upstream
            rq.RequestException = Exception
            amazon_games.handler.do_GET(fake)
            status, payload = sj.call_args.args[1], sj.call_args.args[2]
        self.assertEqual(status, 401)
        self.assertIn("reconnect", payload["error"])


if __name__ == "__main__":
    unittest.main()
