"""Guarantee 18: analysis output is validated. Unknown dispositions and wrongly typed fields
are dropped before anything reaches the API."""

import json

import pytest

from automitra_worker.agent_config.model import AnalysisField
from automitra_worker.control_plane.contract import FinalizeCallRequest
from automitra_worker.reporting.analysis import checked_analysis

DISPOSITIONS = ["interested", "not_interested"]
FIELDS = [
    AnalysisField(name="budget", type="number"),
    AnalysisField(name="test_drive", type="boolean"),
    AnalysisField(name="model", type="enum", options=["Thar", "XUV700"]),
    AnalysisField(name="callback_time", type="string"),
]


@pytest.mark.parametrize(
    "disposition", ["very_interested", "INTERESTED!!", 1, None, ["interested"]]
)
def test_a_disposition_the_agent_does_not_define_never_reaches_the_record(disposition):
    analysis = checked_analysis(
        f'{{"disposition": {json.dumps(disposition)}}}', DISPOSITIONS, FIELDS, []
    )
    assert analysis.disposition is None


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("budget", "true"),
        ("budget", '"a lot"'),
        ("budget", "[1]"),
        ("test_drive", '"maybe"'),
        ("test_drive", "3"),
        ("model", '"Fortuner"'),
        ("model", "7"),
        ("callback_time", '{"day": "Monday"}'),
        ("callback_time", "[1, 2]"),
    ],
)
def test_a_value_of_the_wrong_type_is_dropped(field, value):
    analysis = checked_analysis(f'{{"fields": {{"{field}": {value}}}}}', DISPOSITIONS, FIELDS, [])
    assert analysis.fields[field] is None


def test_fields_the_agent_never_asked_for_are_not_stored():
    analysis = checked_analysis(
        '{"fields": {"aadhaar": "1234 5678 9012"}}', DISPOSITIONS, FIELDS, []
    )
    assert set(analysis.fields) == {field.name for field in FIELDS}


def test_the_checked_analysis_fits_the_finalize_contract():
    analysis = checked_analysis(
        '{"summary": "' + "s" * 5000 + '", "disposition": "interested", "fields": {"budget": 5}}',
        DISPOSITIONS,
        FIELDS,
        [],
    )
    FinalizeCallRequest(status="completed", duration_seconds=60, analysis=analysis)
    assert len(analysis.summary) == 1000
