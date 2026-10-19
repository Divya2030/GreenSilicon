import math

import pytest

from app.carbon import model as cm


def test_dies_per_wafer_matches_textbook():
    # 100 mm2 die on 300 mm wafer: 706.9 - 66.6 = ~640 gross dies
    assert 635 <= cm.dies_per_wafer(100) <= 645


def test_yield_decreases_with_area_and_defects():
    assert cm.nb_yield(50, 0.001, 10) > cm.nb_yield(500, 0.001, 10)
    assert cm.nb_yield(100, 0.0007, 10) > cm.nb_yield(100, 0.002, 10)
    assert math.isclose(cm.nb_yield(100, 0.0, 10), 1.0)


def test_newer_nodes_cost_more_carbon_per_area():
    a = cm.die_footprint(cm.DieSpec(node="28nm", area_mm2=100))["carbon_g"]["total"]
    b = cm.die_footprint(cm.DieSpec(node="3nm", area_mm2=100))["carbon_g"]["total"]
    assert b > 2 * a


def test_cleaner_grid_and_renewables_reduce_footprint():
    tw = cm.die_footprint(cm.DieSpec(fab_location="taiwan"))["carbon_g"]["total"]
    eu = cm.die_footprint(cm.DieSpec(fab_location="europe"))["carbon_g"]["total"]
    re = cm.die_footprint(cm.DieSpec(fab_location="taiwan", renewable_share=1.0, renewable_source="wind"))["carbon_g"]["total"]
    assert eu < tw and re < eu


def test_abatement_matters():
    hi = cm.die_footprint(cm.DieSpec(abatement="99"))["carbon_g"]["process_gases"]
    lo = cm.die_footprint(cm.DieSpec(abatement="95"))["carbon_g"]["process_gases"]
    assert lo > hi


def test_model_within_band_of_imec_reference():
    # Independent dataset; our model uses Taiwan's grid so should be same order of magnitude
    r = cm.estimate(cm.ChipDesign(package=None))["cross_check"]["ratio"]
    assert 0.8 < r < 2.5


def test_bare_die_lot_has_no_packaging():
    e = cm.estimate(cm.ChipDesign(package=None))
    assert e["per_unit"]["breakdown_g"]["packaging_and_bonding"] == 0


def test_breakdown_sums_to_total():
    d = cm.ChipDesign(dies=[cm.DieSpec(count=2)], memory=[cm.MemorySpec()],
                      package=cm.PackageSpec(integration="2.5d", interposer_area_mm2=800))
    e = cm.estimate(d)["per_unit"]
    assert math.isclose(sum(e["breakdown_g"].values()), e["carbon_g"], rel_tol=1e-9)


def test_recommendations_are_real_savings():
    d = cm.ChipDesign(dies=[cm.DieSpec(area_mm2=600, abatement="95")],
                      package=cm.PackageSpec(integration="2.5d", interposer_area_mm2=900))
    recs = cm.recommendations(d)
    assert recs and all(r["saving_g"] > 0 for r in recs)
    assert {r["category"] for r in recs} >= {"energy", "process-gases", "packaging"}


def test_unknown_location_rejected():
    with pytest.raises(ValueError):
        cm.grid_intensity("atlantis")
