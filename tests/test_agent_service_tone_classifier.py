import asyncio

from runtime.agent_runtime.prompt_assembly import PromptAssemblyService
from runtime.models.memory import DurableMemoryPromptContext, DurableMemoryPromptItem
from runtime.services.agent_service import AgentService
from runtime.skills.models import ExecutionPlan, ExecutionState, ExecutionStep, RoutingResult


class FakeToneAIService:
    def __init__(self, content='{"tone": "bright_positive", "reason": "low_risk_help", "style_notes": "Make it brighter and progress-oriented."}'):
        self.content = content
        self.calls = []
        self.config = type('Cfg', (), {'model': 'fake-tone-model'})()

    async def chat(self, *args, **kwargs):
        self.calls.append({'args': args, 'kwargs': kwargs})
        return {
            'content': self.content,
            'model_used': 'fake-tone-model',
            'usage': {'prompt_tokens': 2, 'completion_tokens': 3, 'total_tokens': 5},
        }


class SlowToneAIService(FakeToneAIService):
    def __init__(self, delay_seconds: float = 0.05):
        super().__init__()
        self.delay_seconds = delay_seconds

    async def chat(self, *args, **kwargs):
        self.calls.append({'args': args, 'kwargs': kwargs})
        await asyncio.sleep(self.delay_seconds)
        return await super().chat(*args, **kwargs)


def _make_service(ai=None):
    return AgentService(ai_service=ai or FakeToneAIService(), mcp_manager=None, router_model_config=None, ai_models=[])


def test_classify_response_tone_uses_prompt_classifier_and_normalizes_payload():
    service = _make_service()
    plan = ExecutionPlan(
        user_goal='帮我解释一下这个功能',
        routing_reason='general help',
        routing_method='runtime_bootstrap',
        steps=[
            ExecutionStep(
                step_id='s1',
                skill_name='general_assistant',
                goal='解释功能',
                instructions='解释功能。',
                step_type='general',
                is_final_step=True,
            )
        ],
    )
    routing = RoutingResult(skill_name='general_assistant', reason='general help', routing_method='runtime_bootstrap')
    memory = DurableMemoryPromptContext(
        user_preferences=[
            DurableMemoryPromptItem(
                id=1,
                scope_level='user',
                memory_kind='preference',
                namespace='assistant_style',
                key='tone_preference',
                title='语气偏好',
                summary='自然一点，不要太死板；可以稍微俏皮一点，但别太油',
                value='可以稍微俏皮一点，但别太油',
            )
        ]
    )

    result = asyncio.run(
        service.classify_response_tone(
            message='这个功能是干什么的？',
            execution_plan=plan,
            routing_result=routing,
            durable_memory_context=memory,
        )
    )

    assert result['tone'] == 'bright_positive'
    assert result['reason'] == 'low_risk_help'
    assert 'progress-oriented' in result['style_notes']
    assert len(service.ai_service.calls) == 1


def test_classify_response_tone_falls_back_to_steady_positive_on_invalid_output():
    service = _make_service(FakeToneAIService(content='not-json'))
    plan = ExecutionPlan(
        user_goal='帮我解释一下',
        routing_reason='general help',
        routing_method='runtime_bootstrap',
        steps=[],
    )
    routing = RoutingResult(skill_name='general_assistant', reason='general help', routing_method='runtime_bootstrap')

    result = asyncio.run(
        service.classify_response_tone(
            message='解释一下这个区别',
            execution_plan=plan,
            routing_result=routing,
            durable_memory_context=None,
        )
    )

    assert result['tone'] == 'steady_positive'
    assert result['reason'] == 'default_positive_supportive'


def test_classify_response_tone_times_out_and_falls_back(monkeypatch):
    monkeypatch.setattr(
        'runtime.services.agent_service._AUXILIARY_TONE_CLASSIFIER_TIMEOUT_SECONDS',
        0.01,
    )
    service = _make_service(SlowToneAIService(delay_seconds=0.05))
    plan = ExecutionPlan(
        user_goal='帮我解释一下',
        routing_reason='general help',
        routing_method='runtime_bootstrap',
        steps=[],
    )
    routing = RoutingResult(skill_name='general_assistant', reason='general help', routing_method='runtime_bootstrap')

    result = asyncio.run(
        service.classify_response_tone(
            message='解释一下这个区别',
            execution_plan=plan,
            routing_result=routing,
            durable_memory_context=None,
        )
    )

    assert result['tone'] == 'steady_positive'
    assert result['reason'] == 'default_positive_supportive'


def test_prompt_assembly_adds_tone_guidance_for_final_step_only():
    state = ExecutionState(
        conversation_id='conv-tone',
        current_turn_id='turn-tone',
        plan=ExecutionPlan(
            user_goal='回答用户问题',
            routing_reason='general help',
            routing_method='runtime_bootstrap',
            steps=[
                ExecutionStep(
                    step_id='s1',
                    skill_name='general_assistant',
                    goal='回答用户问题',
                    instructions='回答用户问题。',
                    step_type='general',
                    is_final_step=True,
                )
            ],
        ),
        response_tone={
            'tone': 'bright_positive',
            'reason': 'low_risk_help',
            'style_notes': 'Make it brighter and progress-oriented.',
        },
    )

    final_constraints = PromptAssemblyService().build_constraints_section(
        execution_state=state,
        current_step=state.get_runtime_step(0),
    )

    assert '### Response tone for this turn' in final_constraints
    assert 'bright_positive' in final_constraints
    assert 'brighter, positive, and encouraging' in final_constraints

    non_final_state = ExecutionState(
        conversation_id='conv-tone-2',
        current_turn_id='turn-tone-2',
        plan=ExecutionPlan(
            user_goal='分两步回答',
            routing_reason='multi-step',
            routing_method='runtime_bootstrap',
            steps=[
                ExecutionStep(
                    step_id='s1',
                    skill_name='general_assistant',
                    goal='先收集信息',
                    instructions='先收集信息。',
                    step_type='general',
                    is_final_step=False,
                ),
                ExecutionStep(
                    step_id='s2',
                    skill_name='final_synthesizer',
                    goal='最终回答',
                    instructions='最终回答。',
                    step_type='synthesis',
                    is_final_step=True,
                ),
            ],
        ),
        response_tone={
            'tone': 'steady_positive',
            'reason': 'default',
            'style_notes': 'Natural, positive, and progress-oriented.',
        },
    )

    mid_constraints = PromptAssemblyService().build_constraints_section(
        execution_state=non_final_state,
        current_step=non_final_state.get_runtime_step(0),
    )

    assert 'neutral, structured, and handoff-ready' in mid_constraints
    assert '### Response tone for this turn' in mid_constraints
