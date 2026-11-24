from evals.optimize.run_outcome_eval import conversation_id_for_recording, new_conversation_namespace


def test_conversation_namespace_is_unique_per_eval_run():
    first = new_conversation_namespace("ab:base")
    second = new_conversation_namespace("ab:base")

    assert first != second
    assert first.startswith("opt-ab-base-")
    assert second.startswith("opt-ab-base-")


def test_conversation_id_uses_safe_namespace_and_recording_stem():
    conv_id = conversation_id_for_recording("/data/sub-01_task-rest_ieeg.edf", "opt prompt/B 123")

    assert conv_id == "opt-prompt-B-123-sub-01_task-rest_ieeg"
    assert "/" not in conv_id
    assert " " not in conv_id
