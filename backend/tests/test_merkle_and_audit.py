import os

from app import merkle
from app.ai import heuristic, verifier
from app.ai.schemas import StageDisclosure
from app.carbon import model as cm

DESIGN = cm.ChipDesign(product="t", units=1000, package=None, dies=[cm.DieSpec(node="7nm", area_mm2=120, fab_location="usa")])


def test_merkle_proofs_roundtrip_for_every_field():
    t = merkle.FieldTree({"a": 1, "b": "x", "c": 0.5, "d": True, "e": "y"})
    for k in t.keys:
        d = t.disclosure(k)
        assert merkle.verify(k, d["value"], bytes.fromhex(d["salt"][2:]), [bytes.fromhex(p[2:]) for p in d["proof"]], t.root)
    d = t.disclosure("c")
    assert not merkle.verify("c", "0.9", bytes.fromhex(d["salt"][2:]), [bytes.fromhex(p[2:]) for p in d["proof"]], t.root)


def test_salts_hide_values():
    a = merkle.FieldTree({"yield": 0.83})
    b = merkle.FieldTree({"yield": 0.83})
    assert a.root != b.root  # same value, different salts -> unlinkable roots


def _fab(**kw):
    expected = cm.estimate(DESIGN)["per_lot"]["carbon_kg"]
    base = dict(supplier_name="s", facility="f", stage="WaferFab", reporting_period="p", location="usa", process_node="7nm",
                units=1000, claimed_carbon_kgco2e=expected, certifications=["ISO 14064-1"])
    base.update(kw)
    return StageDisclosure(**base)


def test_honest_disclosure_verified():
    r = verifier.rule_checks("WaferFab", _fab(), DESIGN, has_evidence=True)
    assert r["verdict"] == "Verified" and 0.9 < r["ratio"] < 1.1


def test_underreported_disclosure_rejected():
    r = verifier.rule_checks("WaferFab", _fab(claimed_carbon_kgco2e=500, renewable_share=0.7, abatement_rate=0.999), DESIGN, True)
    assert r["verdict"] == "Rejected"
    titles = {f["title"] for f in r["findings"]}
    assert "Renewable claim lacks certificates" in titles and "Abatement rate implausibly high" in titles


def test_energy_floor_violation_is_critical():
    r = verifier.rule_checks("WaferFab", _fab(electricity_kwh=50_000, claimed_carbon_kgco2e=2300), DESIGN, True)
    assert any(f["title"] == "Total below electricity-only emissions" for f in r["findings"])


def test_certified_renewables_lower_expectation():
    plain = verifier.expected_stage_g("WaferFab", _fab(renewable_share=0.8), DESIGN)[0]
    cert = verifier.expected_stage_g("WaferFab", _fab(renewable_share=0.8, certifications=["I-REC certificates"]), DESIGN)[0]
    assert cert < plain


def test_logistics_expectation_uses_freight_factors():
    d = _fab(stage="Logistics", transport_mode="sea", distance_km=10000, shipment_mass_kg=1000, claimed_carbon_kgco2e=160)
    g, _ = verifier.expected_stage_g("Logistics", d, None)
    assert abs(g - 160_000) < 1


def test_offline_audit_has_summary(monkeypatch):
    monkeypatch.setattr("app.ai.claude.enabled", lambda: False)
    rep = verifier.audit_disclosure("WaferFab", _fab(), DESIGN, True)
    assert rep["engine"] == "rules+ml" and rep["summary"]


def test_heuristic_extractor_reads_supplier_report():
    doc = b"""Supplier: Mesa Foundry Inc.
Facility: Fab 3
Location: Arizona, USA
Stage: Wafer Fab
Good dies shipped: 1,000
Electricity attributed to lot: 3.24 MWh
Renewable electricity share: 70 %
Total product carbon footprint: 698 kg CO2e
Certifications: Corporate net-zero commitment
"""
    d = heuristic.extract(doc, "r.txt")
    assert d.location == "usa" and d.stage == "WaferFab"
    assert d.units == 1000 and abs(d.electricity_kwh - 3240) < 1e-6
    assert d.renewable_share == 0.7 and d.claimed_carbon_kgco2e == 698


def test_signer_must_match_supplier():
    ok = verifier.rule_checks("WaferFab", _fab(supplier_name="Northbay Foundry Co., Ltd."), DESIGN, True, "Northbay Foundry Fab 7 (Hsinchu, Taiwan)")
    bad = verifier.rule_checks("WaferFab", _fab(supplier_name="Quick-Turn Wafer Services"), DESIGN, True, "Northbay Foundry Fab 7 (Hsinchu, Taiwan)")
    assert not any(f["title"] == "Signer is not the reporting supplier" for f in ok["findings"])
    assert any(f["title"] == "Signer is not the reporting supplier" for f in bad["findings"])


def test_signer_check_is_brand_based():
    assert not verifier._same_org("Mesa Foundry Inc.", "Northbay Foundry Fab 7 (Hsinchu, Taiwan)")
    assert verifier._same_org("Penang Advanced Packaging Sdn. Bhd.", "Penang Advanced Packaging (Malaysia)")


def test_heuristic_labels_must_start_the_line():
    doc = b"""Supplier: Northbay Foundry Co., Ltd.
Location: Hsinchu, Taiwan
Stage: Wafer Fab
Fluorinated process gas emissions (after abatement): 3,702 kg CO2e
Abatement efficiency: 99 %
Die yield: 64 %
Total product carbon footprint (cradle-to-gate): 33,798 kg CO2e
"""
    d = heuristic.extract(doc, "r.txt")
    assert d.abatement_rate == 0.99
    assert d.scope1_process_gas_kgco2e == 3702
    assert d.die_yield == 0.64
