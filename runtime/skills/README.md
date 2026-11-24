# iEEG Runtime Skills

启动时，`SkillRegistry.scan_skills()` 会扫描项目中的 `skills/skills/`。每个子目录是一个技能包，由 `SkillLoader` 读取其中的 `SKILL.md`。例如，信号质量技能描述了如何检查坏道、平坦通道和伪迹，以及如何向用户报告结果。[信号质量技能](../../skills/skills/eeg-qc-cleaning/SKILL.md)

## 开发技能

1. 在 `skills/skills/<skill-name>/` 创建 `SKILL.md`。
2. 在文件开头的 YAML front matter 中指定 `name`、`version`、`description`，按需设置 `keywords`、`triggers` 和 `allowed_tools`。
3. 在 Markdown 正文中写明工作步骤、需要的证据和输出格式。工具执行和审批仍受 runtime 的能力契约约束。[能力契约](../docs/contracts/README.md)
4. 在仓库根目录运行 `python -m pytest -q tests/test_eeg_skill_entrypoint.py`，验证已发布的 iEEG 技能入口。

## 使用其他技能目录

可通过 `SKILLS_BASE_DIR` 显式指定技能根目录。该目录下的 `skills/` 存放正式技能，`test/user-<id>/` 存放对应用户的测试技能。运行时监听已存在的技能目录，文件变化时刷新缓存。
