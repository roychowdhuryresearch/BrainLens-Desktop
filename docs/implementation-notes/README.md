# Implementation notes

Each production change set includes one note covering every impacted module.
The required fields and gate command are defined in the repository `AGENTS.md`.
Notes are durable compatibility decisions, not changelog prose: the reason must
state why the change preserves or changes the named contract, and every proof
must be a regular executable test added or changed with the implementation.
