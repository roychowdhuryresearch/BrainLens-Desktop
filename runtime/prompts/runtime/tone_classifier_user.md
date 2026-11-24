Choose the final-response tone based on the information below.

User message: ${user_message}
Routing summary: ${routing_summary_json}
Execution plan: ${execution_plan_json}
Relevant long-term memory/preferences: ${durable_memory_section}

Requirements:
- Choose tone only for the final user-visible writing layer; do not change facts or decisions.
- If the execution plan looks diagnostic, current-information-heavy, strongly tool-dependent, or structurally professional, prefer a conservative tone and choose `serious_grounded`.
- If the execution plan is ordinary help, explanation, or low-risk communication, default to `steady_positive`.
- If the user's own tone is light, needs encouragement, and the task is low-risk, you may upgrade to `bright_positive`.
- The focus is not being witty; it is being natural, optimistic, and progress-oriented.
- Output JSON only.
