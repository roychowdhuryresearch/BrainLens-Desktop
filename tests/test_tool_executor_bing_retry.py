import asyncio
import json

from runtime.agent_runtime.tool_executor import ToolExecutionRequest, ToolExecutor


class FakeServices:
    def __init__(self):
        self.calls = []

    def record_observability_span(self, **kwargs):
        return None

    def normalize_tool_args(self, function_args):
        return dict(function_args or {})

    def track_tool_call_signature(self, **kwargs):
        return {}

    def classify_tool_family(self, tool_name):
        return 'mcp'

    def tool_provider_name(self, tool_name):
        return 'bing'

    def extract_tool_focus_args(self, function_args):
        return function_args

    async def execute_tool(self, *, tool_name, args, conversation_id=None, user_role=None, user_id=None):
        self.calls.append((tool_name, dict(args)))
        query = args.get('query', '')
        if query == 'AI news 2026 latest':
            return {'query': query, 'results': []}
        if query == '人工智能 最新 新闻':
            return {'query': query, 'results': [{'title': 'news-hit'}]}
        return {'query': query, 'results': []}

    def summarize_tool_result(self, tool_result):
        return {'result_kind': 'object', 'result_count': len(tool_result.get('results', [])), 'result_size_chars': len(str(tool_result)), 'is_empty_result': len(tool_result.get('results', [])) == 0, 'sample_ids': [], 'sample_titles': []}

    def extract_sources_from_tool_result(self, result):
        return []

    def extract_knowledge_base_slugs_from_sources(self, sources):
        return []

    def tool_args_signature(self, function_name, function_args):
        return f"{function_name}:{function_args}"

    def infer_tool_error_type(self, error, status):
        return ''


async def _run_once():
    services = FakeServices()
    executor = ToolExecutor(services)
    semaphore = asyncio.Semaphore(1)
    result = await executor._execute_single_tool_call(
        tool_call={
            'tool_call_id': 't1',
            'function_name': 'bing_bing_search',
            'function_args': {'query': 'AI news 2026 latest', 'count': 10},
        },
        semaphore=semaphore,
        conversation_id='c1',
        user_role='USER',
    )
    return services.calls, result


def test_bing_search_retries_with_refined_query_on_empty_results():
    calls, result = asyncio.run(_run_once())

    assert calls[0][1]['query'] == 'AI news 2026 latest'
    assert any(call[1]['query'] == '人工智能 最新 新闻' for call in calls)
    assert result['success'] is True
    assert result['result']['results'][0]['title'] == 'news-hit'
    assert result['args']['query'] == '人工智能 最新 新闻'


def test_pyhfo_results_are_compacted_before_model_context():
    executor = ToolExecutor(FakeServices())
    tool_result = {
        'success': True,
        'tool': 'pyhfo_compute_spectral_profile',
        'result': {
            'psd_curve': list(range(1000)),
            'channel_metrics': [
                {'channel': f'POL ST{i}', 'samples': list(range(200)), 'rms': i / 10}
                for i in range(40)
            ],
        },
    }

    compact = executor._tool_result_for_model_context('pyhfo_compute_spectral_profile', tool_result)

    assert compact['result']['psd_curve']['count'] == 1000
    assert compact['result']['psd_curve']['max'] == 999
    assert compact['result']['channel_metrics']['count'] == 40
    assert compact['result']['channel_metrics']['sample'][0]['samples']['count'] == 200
    assert len(json.dumps(compact)) < 5000


def test_inspect_waveform_result_is_compacted_before_model_context():
    executor = ToolExecutor(FakeServices())
    compact = executor._tool_result_for_model_context(
        'inspect_waveform',
        {'success': True, 'result': 'visual finding. ' * 300, 'query': 'look ' * 300},
    )

    assert compact['success'] is True
    assert len(compact['result']) < 1400
    assert len(compact['query']) < 800
    assert 'do not repeat inspect_waveform' in compact['note']


async def _run_repeat_inspect_guard():
    services = FakeServices()
    executor = ToolExecutor(services)
    tool_call = {
        'id': 'call-2',
        'function': {'name': 'inspect_waveform', 'arguments': json.dumps({'query': 'look again'})},
    }
    request = ToolExecutionRequest(
        tool_calls=[tool_call],
        tools=[{'type': 'function', 'function': {'name': 'inspect_waveform'}}],
        messages=[{'role': 'tool', 'name': 'inspect_waveform', 'tool_call_id': 'call-1', 'content': '{"success": true}'}],
        ai_response={'content': '', 'tool_calls': [tool_call]},
        sources=[],
        active_skill_name_result='eeg-qc-cleaning',
        iteration=1,
        conversation_id='conv',
    )

    events = []
    async for event in executor.execute(request):
        events.append(event)
    return services.calls, events, request.messages


def test_repeated_inspect_waveform_is_skipped_within_one_turn():
    calls, events, messages = asyncio.run(_run_repeat_inspect_guard())

    assert calls == []
    result_events = [event for event in events if event['event'] == 'tool_result']
    assert result_events[0]['data']['success'] is True
    assert result_events[0]['data']['result']['repeat_skipped'] is True
    assert messages[-1]['name'] == 'inspect_waveform'
    assert 'repeat_skipped' in messages[-1]['content']


async def _run_mixed_valid_unknown_tools():
    services = FakeServices()
    executor = ToolExecutor(services)
    valid = {
        'id': 'call-valid',
        'function': {'name': 'known_tool', 'arguments': json.dumps({'query': 'ok'})},
    }
    unknown = {
        'id': 'call-unknown',
        'function': {'name': 'missing_tool', 'arguments': json.dumps({'query': 'bad'})},
    }
    request = ToolExecutionRequest(
        tool_calls=[valid, unknown],
        tools=[{'type': 'function', 'function': {'name': 'known_tool'}}],
        messages=[],
        ai_response={'content': '', 'tool_calls': [valid, unknown]},
        sources=[],
        active_skill_name_result='tool-contract',
        iteration=0,
        conversation_id='conv',
    )

    events = []
    async for event in executor.execute(request):
        events.append(event)
    return services.calls, events, request.messages


def test_mixed_valid_and_unknown_tool_calls_keep_one_assistant_transcript():
    calls, events, messages = asyncio.run(_run_mixed_valid_unknown_tools())

    assistant_messages = [msg for msg in messages if msg.get('role') == 'assistant']
    tool_messages = [msg for msg in messages if msg.get('role') == 'tool']
    result_events = [event for event in events if event.get('event') == 'tool_result']

    assert assistant_messages == [{'role': 'assistant', 'content': '', 'tool_calls': assistant_messages[0]['tool_calls']}]
    assert [call['function']['name'] for call in assistant_messages[0]['tool_calls']] == ['known_tool', 'missing_tool']
    assert calls == [('known_tool', {'query': 'ok'})]
    assert [msg['name'] for msg in tool_messages] == ['known_tool', 'missing_tool']
    assert [event['data']['success'] for event in result_events] == [True, False]
    assert result_events[0]['data']['provider_name'] == 'bing'
    call_event = next(event for event in events if event.get('event') == 'tool_call')
    assert call_event['data']['provider_name'] == 'bing'
    assert "not available" in tool_messages[1]['content']


async def _run_missing_id_valid_tool():
    services = FakeServices()
    executor = ToolExecutor(services)
    tool_call = {
        'function': {'name': 'known_tool', 'arguments': json.dumps({'query': 'ok'})},
    }
    request = ToolExecutionRequest(
        tool_calls=[tool_call],
        tools=[{'type': 'function', 'function': {'name': 'known_tool'}}],
        messages=[],
        ai_response={'content': '', 'tool_calls': [tool_call]},
        sources=[],
        active_skill_name_result='tool-contract',
        iteration=0,
        conversation_id='conv',
    )

    events = []
    async for event in executor.execute(request):
        events.append(event)
    return services.calls, events, request.messages


def test_missing_tool_call_id_is_normalized_and_executed():
    calls, events, messages = asyncio.run(_run_missing_id_valid_tool())

    assistant_call = messages[0]['tool_calls'][0]
    tool_message = messages[-1]

    assert assistant_call['id'].startswith('call_missing_')
    assert tool_message['tool_call_id'] == assistant_call['id']
    assert calls == [('known_tool', {'query': 'ok'})]
    assert [event['data']['success'] for event in events if event.get('event') == 'tool_result'] == [True]


async def _run_valid_and_malformed_args_tools():
    services = FakeServices()
    executor = ToolExecutor(services)
    valid = {
        'id': 'call-valid',
        'function': {'name': 'known_tool', 'arguments': json.dumps({'query': 'ok'})},
    }
    malformed = {
        'id': 'call-bad-args',
        'function': {'name': 'other_tool', 'arguments': '{"query": "bad'},  # truncated JSON
    }
    request = ToolExecutionRequest(
        tool_calls=[valid, malformed],
        tools=[
            {'type': 'function', 'function': {'name': 'known_tool'}},
            {'type': 'function', 'function': {'name': 'other_tool'}},
        ],
        messages=[],
        ai_response={'content': '', 'tool_calls': [valid, malformed]},
        sources=[],
        active_skill_name_result='tool-contract',
        iteration=0,
        conversation_id='conv',
    )

    events = []
    async for event in executor.execute(request):
        events.append(event)
    return services.calls, events, request.messages


def test_malformed_tool_arguments_are_fed_back_not_executed():
    """A weak model emitting truncated JSON for function.arguments must NOT have
    the tool fire with coerced {} (which it would read as a successful no-op);
    instead a structured 'Invalid tool arguments' result is fed back so it can
    retry with valid JSON."""
    calls, events, messages = asyncio.run(_run_valid_and_malformed_args_tools())

    tool_messages = [msg for msg in messages if msg.get('role') == 'tool']
    result_events = [event for event in events if event.get('event') == 'tool_result']

    # Only the well-formed call executed; the malformed one never reached the tool.
    assert calls == [('known_tool', {'query': 'ok'})]
    # Both calls are still represented back to the model, in order.
    assert [msg['name'] for msg in tool_messages] == ['known_tool', 'other_tool']
    assert [event['data']['success'] for event in result_events] == [True, False]
    # The model is told exactly why, so it can self-correct.
    assert 'Invalid tool arguments' in tool_messages[1]['content']
