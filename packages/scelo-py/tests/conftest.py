import warnings

import numpy as np
import pandas as pd
import pytest

warnings.filterwarnings("ignore")

RAA = [
    [5012, 8269, 10907, 11805, 13539, 16181, 18009, 18608, 18662, 18834],
    [106, 4285, 5396, 10666, 13782, 15599, 15496, 16169, 16704, None],
    [3410, 8992, 13873, 16141, 18735, 22214, 22863, 23466, None, None],
    [5655, 11555, 15766, 21266, 23425, 26083, 27067, None, None, None],
    [1092, 9565, 15836, 22169, 25955, 26180, None, None, None, None],
    [1513, 6445, 11702, 12935, 15852, None, None, None, None, None],
    [557, 4020, 10946, 12314, None, None, None, None, None, None],
    [1351, 6947, 13112, None, None, None, None, None, None, None],
    [3133, 5395, None, None, None, None, None, None, None, None],
    [2063, None, None, None, None, None, None, None, None, None],
]


@pytest.fixture
def raa():
    import scelo as sc

    arr = np.array([[np.nan if v is None else v for v in r] for r in RAA], dtype=float)
    return sc.from_wide(arr, origins=list(range(1981, 1991)))


@pytest.fixture
def claims():
    import scelo as sc

    return sc.sample("claims")


@pytest.fixture
def dirty():
    import scelo as sc

    return sc.sample("dirty")
