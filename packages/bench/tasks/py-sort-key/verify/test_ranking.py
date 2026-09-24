from ranking import rank

def test_rank_orders_by_score_descending():
    players = [{"name": "a", "score": 10}, {"name": "b", "score": 30}, {"name": "c", "score": 20}]
    result = rank(players)
    assert [p["name"] for p in result] == ["b", "c", "a"]