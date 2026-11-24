Extract durable-memory candidates from the completed conversation turn below.

Original user request:
${user_message}

Final answer:
${final_content}

Skills executed:
${skills_executed_json}

Step summaries:
${step_summaries_json}

Source summary:
${sources_summary_json}

Existing user durable-memory summary:
${existing_memory_summary}

Additional constraints:
- You may extract `preference`, `working_style`, `long_term_goal`, `project_context`, `project_fact`, and `decision`.
- `preference` / `working_style` / `long_term_goal` may be written only when explicitly confirmed by the user.
- `project_fact` must be a user-confirmed, stable personal fact or durable preference that remains useful across sessions.
- `project_context` / `decision` must be stable, long-term context that affects future answers. Do not save one-off temporary tasks.
- If there is no suitable item, return `should_write=false`.
