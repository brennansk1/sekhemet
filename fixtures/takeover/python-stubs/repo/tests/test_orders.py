from app.orders import total


def test_totals_an_order():
    assert total([1, 2]) == 3
