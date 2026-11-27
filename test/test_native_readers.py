"""Run: python -m pytest test/test_native_readers.py  (set PRICE_SAMPLES to a folder holding the Nov 2026 sample files)"""
import glob, os, sys
from datetime import date
import pytest
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "hubdb"))
import native_readers as nr

SAMPLES = os.environ.get("PRICE_SAMPLES", "samples")
FILES = sorted(glob.glob(os.path.join(SAMPLES, "*")))

def test_detect():
    assert nr.detect("20261124_POW_ACQ_R.csv") == "flatfile_pow"
    assert nr.detect("20261124_GAS_REN_P_UR.csv") == "flatfile_gas"
    assert nr.detect("rate_card_261126_EDFKraken.csv") == "edf_kraken"
    assert nr.detect("BGL_quote_tool.xlsb") == "bgl_tool"
    assert nr.detect("UD_TROO_YU_E_ACQ_241126.xlsx") is None

@pytest.mark.skipif(not FILES, reason="no sample files")
@pytest.mark.parametrize("path", FILES)
def test_reads_clean(path):
    if not nr.detect(path):
        pytest.skip("not a native format")
    df = nr.read(path, supplier="TEST", today=date(2026, 11, 26))
    assert len(df) > 0
    assert nr.problems(df) == []


def test_loader_native_path():
    """The loader sends native files through native_readers and splits them by fuel and contract type."""
    import load_price_books as L
    edf = [f for f in FILES if nr.detect(f) == "edf_kraken"]
    if not edf:
        pytest.skip("no EDF sample")
    with open(edf[0], "rb") as fh:
        loads = L.process(os.path.basename(edf[0]), fh.read(), "2026-11-26")
    assert {(l[2], l[1]) for l in loads} == {("E", "ACQ"), ("E", "REN"), ("G", "ACQ"), ("G", "REN")}
    assert all(not l[7] for l in loads)
    rates = {r["rate_type"] for l in loads for r in l[3]}
    assert rates <= {"single", "daynight", "ew", "ewn"}


def test_flatfile_needs_supplier_code():
    import load_price_books as L
    with pytest.raises(ValueError, match="supplier code"):
        L.native_supplier("20261124_POW_ACQ_R.csv")
    assert L.native_supplier("YU_20261124_POW_ACQ_R.csv") == "Yu Energy"


def test_eco_files_dont_replace_standard():
    import load_price_books as L
    assert L.file_variant("YU_20261124_POW_ACQ_R_ECO.csv (123)") == "ECO"
    assert L.file_variant("YU_20261124_POW_ACQ_R.csv (124)") == ""
