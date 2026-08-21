from backend.application.services.world import BindKind, World, bind_market


def test_bind_market_is_closed_schema() -> None:
    assert bind_market("美国") == "US"
    assert bind_market("lazada") is None
    assert bind_market("tokopedia") is None


def test_world_lookup_uses_current_titles() -> None:
    world = World.from_ranked(
        [
            {"snapshot_id": "s1", "title": "JBL Live 660NC", "merchant": "shopify"},
            {"snapshot_id": "s2", "title": "Space One", "merchant": "amazon.sg"},
        ]
    )
    assert world.lookup("jbl") == ("s1",)
    assert world.lookup("tokopedia") == ()
    assert world.bind_needle("美国").kind == BindKind.MARKET
    assert world.bind_needle("lazada").kind == BindKind.UNBOUND
    assert world.merchants == ("shopify", "amazon.sg")
