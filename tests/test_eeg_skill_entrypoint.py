from pathlib import Path

from runtime.skills.loader import SkillLoader
from runtime.skills.skill_registry import _resolve_default_skills_base_dir


REPO_ROOT = Path(__file__).resolve().parents[1]
SKILLS_ROOT = REPO_ROOT / "skills" / "skills"


def _load_skill(name):
    skill = SkillLoader().load_one(SKILLS_ROOT / name)
    assert skill is not None, name
    return skill


def test_system_prompt_is_lightly_eeg_oriented_not_pyhfo_recipe_heavy():
    prompt = (REPO_ROOT / "runtime" / "prompts" / "system_prompt.md").read_text(encoding="utf-8")

    assert "EEG/iEEG-oriented ReAct" in prompt
    assert "EEG/iEEG research workflow support" in prompt
    assert "Clinical labels such as SOZ" in prompt
    assert "disabled unless explicitly enabled by system configuration" in prompt
    assert "Final user-facing output must match" in prompt
    assert "English-first" in prompt
    # The prompt deliberately favours an auditable-but-conversational read over a
    # rigid "Decision trace" section (see system_prompt.md), so assert that intent.
    assert "Stay auditable" in prompt
    # Detailed recipes belong in skills, not the base prompt.
    assert "bipolar_montage=auto_adjacent" not in prompt
    assert "line_noise_notch_hz=60" not in prompt
    assert "0.95 * Nyquist" not in prompt


def test_eeg_ieeg_pyhfo_skill_is_legacy_alias_not_router_entrypoint():
    skill = _load_skill("eeg-ieeg-pyhfo")

    assert skill.name == "eeg-ieeg-pyhfo"
    assert "compatibility alias" in skill.description
    assert "not a router" in skill.instructions
    assert "Do not force every broad request through this alias" in skill.instructions
    assert skill.priority < _load_skill("pyhfo-detection").priority
    assert skill.priority < _load_skill("eeg-signal-roi").priority
    assert "Router entry skill" not in skill.description
    assert "Focused skill sequence" not in skill.instructions
    broad_routing_terms = {"eeg", "ieeg", "edf", "hfo", "pyhfo", "pathological channel"}
    alias_terms = {term.lower() for term in [*skill.keywords, *skill.triggers]}
    assert not (broad_routing_terms & alias_terms)
    for focused in [
        "eeg-format-understanding",
        "eeg-signal-roi",
        "eeg-qc-cleaning",
        "eeg-preprocessing",
        "pyhfo-detection",
        "eeg-result-interpretation",
        "eeg-iteration-optimization",
    ]:
        assert focused in skill.instructions
    assert "pyhfo_infer_brain_signal_roi" in skill.allowed_tools
    assert "pyhfo_detect_events" in skill.allowed_tools
    assert "pyhfo_rank_candidate_channels" in skill.allowed_tools


def test_focused_eeg_skills_are_loadable_and_tool_scoped():
    expected = {
        "eeg-format-understanding": ["pyhfo_get_recording_info"],
        "eeg-signal-roi": ["pyhfo_infer_brain_signal_roi"],
        "eeg-qc-cleaning": ["pyhfo_compute_channel_qc", "pyhfo_compute_spectral_profile"],
        "eeg-preprocessing": ["pyhfo_prepare_recording"],
        "pyhfo-detection": ["pyhfo_recommend_detector_plan", "pyhfo_detect_events"],
        "eeg-result-interpretation": ["pyhfo_rank_candidate_channels"],
        "eeg-iteration-optimization": ["pyhfo_detect_events", "pyhfo_rank_candidate_channels"],
        "eeg-clinical-label-evaluation": ["pyhfo_get_recording_info", "pyhfo_rank_candidate_channels"],
    }

    loaded = SkillLoader().load_from_root(SKILLS_ROOT)
    names = {skill.name for skill in loaded}
    assert set(expected) | {"eeg-ieeg-pyhfo"} <= names

    for name, required_tools in expected.items():
        skill = _load_skill(name)
        assert skill.description
        assert skill.triggers, name
        for tool in required_tools:
            assert tool in skill.allowed_tools, (name, tool)


def test_detection_and_classification_skills_require_ui_callback_tool():
    detection = _load_skill("pyhfo-detection")
    classification = _load_skill("eeg-classification")
    iteration = _load_skill("eeg-iteration-optimization")

    for skill in [detection, classification, iteration]:
        assert "emit_ui_command" in skill.allowed_tools
        assert "wait_for_ui_command" in skill.allowed_tools

    assert "result-shaping choices" in detection.instructions
    assert "Do not silently choose STE" in detection.instructions
    assert "filter bands, or all-channel scope" in detection.instructions
    assert "never emit `detector: \"STE\"` with `biomarker: \"Spindle\"`" in detection.instructions
    assert "call `wait_for_ui_command`" in detection.instructions
    assert "call `wait_for_ui_command`" in classification.instructions


def test_focused_skills_keep_label_and_clinical_boundaries():
    roi = _load_skill("eeg-signal-roi")
    interpretation = _load_skill("eeg-result-interpretation")
    label_eval = _load_skill("eeg-clinical-label-evaluation")

    assert "label-free" in roi.instructions
    assert "EKG/ECG/EOG/EMG" in roi.instructions
    assert "signal-derived candidate" in interpretation.instructions
    assert "never definitive" in interpretation.instructions
    assert "disabled by default" in label_eval.instructions
    assert "Do not use in ordinary doctor-side EDF analysis" in label_eval.do_not_use


def test_default_skill_resolution_finds_repo_local_skills(tmp_path, monkeypatch):
    repo_root = tmp_path / "project"
    (tmp_path / "skills" / "skills").mkdir(parents=True)
    monkeypatch.delenv("SKILLS_BASE_DIR", raising=False)
    assert _resolve_default_skills_base_dir(repo_root) == repo_root / "skills"

    monkeypatch.setenv("SKILLS_BASE_DIR", str(tmp_path / "skills"))
    assert _resolve_default_skills_base_dir(repo_root) == tmp_path / "skills"
