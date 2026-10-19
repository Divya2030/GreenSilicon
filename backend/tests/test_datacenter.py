import math

from app import datacenter as dc


def _site(code):
    return next(d for d in dc.DCS if d["code"] == code)


def test_hourly_intensity_averages_to_annual_value():
    s = _site("PHX-1")
    day = [dc.intensity(s, h * 3600) for h in range(24 * 7)]
    assert abs(sum(day) / len(day) / s["ci"] - 1) < 0.03


def test_clean_grid_cuts_operational_carbon_and_raises_embodied_share():
    phx = dc.job_footprint(_site("PHX-1"), 100, 24, 0, 115_000)
    sto = dc.job_footprint(_site("STO-1"), 100, 24, 0, 115_000)
    assert sto["operational_g"] < 0.15 * phx["operational_g"]
    assert sto["embodied_g"] == phx["embodied_g"]
    assert sto["embodied_g"] / sto["total_g"] > phx["embodied_g"] / phx["total_g"]


def test_seawater_site_uses_no_freshwater_for_cooling():
    f = dc.job_footprint(_site("HAM-1"), 10, 10, 0, 0)
    assert f["water_onsite_l"] == 0
    assert math.isclose(f["freshwater_l"], f["water_offsite_l"])


def test_cache_scales_energy():
    a = dc.job_footprint(_site("IAD-3"), 50, 10, 0, 1000)
    b = dc.job_footprint(_site("IAD-3"), 50, 10, 0, 1000, load=0.6)
    assert math.isclose(b["it_kwh"], 0.6 * a["it_kwh"])


def test_seawater_cooling_only_feasible_on_the_coast():
    inland = {o["key"]: o for o in dc.cooling_options("PHX-1")["options"]}
    coastal = {o["key"]: o for o in dc.cooling_options("STO-1")["options"]}
    assert not inland["seawater_hx"]["feasible"] and coastal["seawater_hx"]["feasible"]
    assert inland["dry"]["carbon_t"] > inland["current"]["carbon_t"]          # fans cost energy
    assert inland["dry"]["freshwater_m3"] < inland["current"]["freshwater_m3"]  # but save cooling water
    assert inland["seawater_ro"]["carbon_t"] > inland["reclaimed"]["carbon_t"]  # desalination costs energy


def test_inference_levers_compound():
    p = dc.inference_plan(1_000_000, 0.3, 0.5, 0.15, 1.6, 0.85, 0.8, "PHX-1")
    expected = 0.7 * (1 - 0.5 + 0.5 * 0.15) / 1.6 * 0.85 * 0.8
    assert math.isclose(p["multiplier"], expected)
    assert math.isclose(p["optimised"]["wh_per_query"], dc.BASE_WH_PER_QUERY * expected)
    assert p["annual_saved_mwh"] > 0


def test_work_fingerprint_is_exact():
    assert dc.work_hash("m", "d", "p") == dc.work_hash(" m", "d ", "p")
    assert dc.work_hash("m", "d", "p") != dc.work_hash("m", "d2", "p")
