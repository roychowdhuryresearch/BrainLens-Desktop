## Available tools

You can use the following tools to obtain information or perform actions:

${tools_text}

**Tool-calling rules**:
- Choose tools according to the user's request.
- Provide complete arguments for every tool call.
- You may call multiple tools to complete a task.
- If multiple tool calls are independent, prefer issuing them in the same round rather than probing serially across turns.
- For retrieval tasks across multiple candidate documents, keywords, knowledge-base spaces, or web sources, prefer a fan-out of `3-6` tool calls in one round.
- Split calls into sequential rounds only when a later call truly depends on an earlier result.
