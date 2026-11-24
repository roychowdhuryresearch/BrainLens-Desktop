/**
 * Keeps the co-pilot transcript to the conversation.
 *
 * The runtime drives the model with a ReAct scaffold: it asks for plans as JSON
 * (`{"step_id","skill","step_type","goal","done_when"}`) and for workspace actions as UI commands
 * (`{"type":"severity.run","payload":{}}`), which are meant to travel over the tool channel. A model
 * that does not reliably tool-call writes them into the reply instead, so the user reads the app's
 * own scaffolding — plan envelopes, command envelopes, and imperative prompt lines the model is
 * parroting rather than following.
 *
 * Two jobs here: strip that machinery from what is displayed, and hand back any UI command found in
 * the text so the app can still ACT on it — a command the model typed instead of called should
 * behave like one it called, not vanish.
 */

export type ExtractedUiCommand = { type: string; payload: Record<string, unknown> };

export type FilteredAgentReply = {
  text: string;
  commands: ExtractedUiCommand[];
};

// Keys that mark a controller plan envelope rather than something said to the user.
// Tool-call wrappers a model writes when it narrates instead of calling: the command sits nested
// under the tool's own name -- {"emit_ui_command": {"type": "severity.run", "payload": {}}} -- or
// under an {arguments: …} shape. Unwrapping lets a typed-out command still reach the workspace, and
// keeps the raw JSON out of the transcript either way.
const TOOL_WRAPPER_KEYS = ['emit_ui_command', 'ui_command', 'command', 'arguments', 'parameters'];

function unwrapToolCall(value: Record<string, unknown>): Record<string, unknown> {
  let current = value;
  for (let depth = 0; depth < 3; depth += 1) {
    const wrapper = Object.keys(current).find((key) => TOOL_WRAPPER_KEYS.includes(key));
    const nested = wrapper ? current[wrapper] : undefined;
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) break;
    current = nested as Record<string, unknown>;
  }
  return current;
}

const PLAN_KEYS = ['step_id', 'done_when', 'step_type'];

function isPlanEnvelope(value: Record<string, unknown>): boolean {
  return PLAN_KEYS.some((key) => key in value);
}

function isCommandEnvelope(value: Record<string, unknown>): value is { type: string; payload?: Record<string, unknown> } {
  // A UI command is `type` plus an optional payload object and nothing else of substance. Requiring
  // the dotted namespace keeps a sentence about "type" in a JSON example from being swallowed.
  return typeof value.type === 'string' && /^[a-z][a-z_]*\.[a-z][a-z_]*$/.test(value.type);
}

/**
 * Imperative scaffolding the model echoes back verbatim. Matched conservatively — whole lines that
 * open with a prompt-style directive — so ordinary prose that merely contains "do not" survives.
 */
const ECHOED_INSTRUCTION = /^\s*(do not|don't|never|always)\b[^.!?]*[.!?]?\s*$/i;

function stripJsonEnvelopes(text: string, commands: ExtractedUiCommand[]): string {
  let output = '';
  let index = 0;
  while (index < text.length) {
    const brace = text.indexOf('{', index);
    if (brace === -1) {
      output += text.slice(index);
      break;
    }
    // Walk to the matching brace so nested objects come out whole.
    let depth = 0;
    let end = -1;
    for (let cursor = brace; cursor < text.length; cursor += 1) {
      if (text[cursor] === '{') depth += 1;
      else if (text[cursor] === '}') {
        depth -= 1;
        if (depth === 0) { end = cursor; break; }
      }
    }
    if (end === -1) {
      output += text.slice(index);
      break;
    }
    const candidate = text.slice(brace, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      output += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const record = unwrapToolCall(parsed as Record<string, unknown>);
      if (isCommandEnvelope(record)) {
        commands.push({
          type: record.type,
          payload: (record.payload && typeof record.payload === 'object' ? record.payload : {}) as Record<string, unknown>,
        });
        output += text.slice(index, brace);
        index = end + 1;
        continue;
      }
      if (typeof record.type === 'string' && record !== (parsed as Record<string, unknown>)) {
        // Unwrapped, but not a workspace command (a read-only tool such as get_ui_state). Machinery
        // either way: out of the transcript, and never into the command queue.
        output += text.slice(index, brace);
        index = end + 1;
        continue;
      }
      if (isPlanEnvelope(record)) {
        output += text.slice(index, brace);
        index = end + 1;
        continue;
      }
    }
    output += text.slice(index, end + 1);
    index = end + 1;
  }
  return output;
}

export function filterAgentReply(raw: string): FilteredAgentReply {
  const commands: ExtractedUiCommand[] = [];
  if (!raw) return { text: '', commands };

  // Fenced blocks first: ```json … ``` wrapping an envelope is the common shape, and the fence
  // markers would otherwise be left behind as stray backticks.
  const defenced = raw.replace(/```[a-z]*\s*([\s\S]*?)```/gi, (match, body: string) => {
    const inner = stripJsonEnvelopes(body, commands);
    return inner.trim() ? match : '';
  });

  const withoutEnvelopes = stripJsonEnvelopes(defenced, commands);

  const text = withoutEnvelopes
    .split(/\r?\n/)
    .filter((line) => !ECHOED_INSTRUCTION.test(line))
    .join('\n')
    // Collapse the blank runs the removals leave behind.
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*`+\s*$/gm, '')
    .trim();

  return { text, commands };
}
