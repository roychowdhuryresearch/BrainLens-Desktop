# Implementation Plan

## [Overview]

实现一个 LLM-controlled Sequential Agent Runtime，按 Markdown 定义的 Workflow 逐步执行 Skill。

当前系统的 Skill 是 Markdown 文件，一次性注入到 system prompt 让 LLM 自行理解执行。新 Runtime 将解析 SKILL.md 中的 workflow 步骤，逐步执行每个步骤：每一步由 LLM 决定调用哪个 tool/sub-skill，支持 retry/fallback/trace。Skill 仍然是 Markdown 定义，但 Runtime 会按结构化流程驱动执行。

## [Types]

定义核心数据结构，用于统一状态管理、执行结果和追踪记录。

### RuntimeState

```python
@dataclass
class RuntimeState:
    """统一运行时状态"""
    user_input: str                           # 用户原始输入
    done: bool = False                        # 是否完成
    current_step: int = 0                     # 当前主循环步数
    max_steps: int = 10                       # 最大步数限制
    
    memory: Dict[str, Any] = field(default_factory=dict)      # 工作内存（结构化数据）
    history: List[Dict[str, Any]] = field(default_factory=list)  # 执行历史（给LLM看）
    trace: List[TraceEvent] = field(default_factory=list)     # 完整追踪（用于replay/debug）
    
    final_answer: Optional[str] = None        # 最终回答
    last_error: Optional[str] = None          # 最后错误信息
    
    # Skill 执行上下文
    active_skill_name: Optional[str] = None   # 当前激活的 skill
    skill_step_index: int = 0                 # 当前 skill workflow 步骤索引
```

### TraceEvent

```python
@dataclass
class TraceEvent:
    """追踪事件"""
    step_id: int                              # 主循环步数
    event_type: str                           # 事件类型
    payload: Dict[str, Any]                   # 事件详情
    timestamp: float = field(default_factory=time.time)
    
    # event_type 枚举值:
    # - select_action_start / select_action_end
    # - execute_action_start / execute_action_end
    # - retry
    # - fallback
    # - error
    # - skill_step_start / skill_step_end
    # - finalize_start / finalize_end
```

### ExecutionResult

```python
@dataclass
class ExecutionResult:
    """Tool/Skill 执行结果"""
    success: bool                             # 是否成功
    output: Dict[str, Any]                    # 结构化输出（写入 memory）
    message: str                              # 简洁描述
    error: Optional[str] = None               # 错误信息
    should_terminate: bool = False            # 是否要求立即结束
```

### ActionDecision

```python
@dataclass
class ActionDecision:
    """LLM 的 action 选择"""
    action_type: Literal["skill", "tool", "FINISH"]  # 动作类型
    action_name: str                          # 动作名称（或 FINISH）
    reason: str                               # 选择理由
```

### SkillWorkflowStep

```python
@dataclass
class SkillWorkflowStep:
    """从 SKILL.md 解析的 workflow 步骤"""
    step_id: int                              # 步骤编号
    title: str                                # 步骤标题
    description: str                          # 步骤描述
    suggested_tools: List[str] = field(default_factory=list)  # 建议使用的工具
    expected_output: Optional[str] = None     # 期望输出
```

## [Files]

### 新建文件

| 文件路径 | 用途 |
|---------|------|
| `backend/app/agent_runtime/__init__.py` | 模块初始化 |
| `backend/app/agent_runtime/state.py` | RuntimeState, TraceEvent 数据结构 |
| `backend/app/agent_runtime/actions.py` | ExecutionResult, ActionDecision 数据结构 |
| `backend/app/agent_runtime/exceptions.py` | 自定义异常类 |
| `backend/app/agent_runtime/tool_wrapper.py` | MCP Tool 包装器（支持 retry/fallback） |
| `backend/app/agent_runtime/skill_executor.py` | Skill 执行器（解析 workflow 并执行） |
| `backend/app/agent_runtime/llm_decision.py` | LLM 决策接口封装 |
| `backend/app/agent_runtime/runtime.py` | AgentRuntime 核心类 |
| `backend/app/agent_runtime/example_main.py` | 可运行 demo |

### 无需修改的现有文件

新模块独立于现有代码，不修改 `agent_service.py` 等文件，保持向后兼容。

## [Functions]

### Runtime 核心函数

| 函数名 | 文件路径 | 用途 |
|-------|---------|------|
| `run(user_input: str) -> RuntimeState` | `runtime.py` | 主入口，执行主循环 |
| `select_next_action(state: RuntimeState) -> ActionDecision` | `runtime.py` | LLM 决定下一步 |
| `dispatch_action(decision: ActionDecision, state: RuntimeState) -> ExecutionResult` | `runtime.py` | 分发执行 |
| `execute_tool_by_name(tool_name: str, state: RuntimeState, visited: Set) -> ExecutionResult` | `runtime.py` | 执行 tool（含 retry/fallback） |
| `execute_skill_by_name(skill_name: str, state: RuntimeState, visited: Set) -> ExecutionResult` | `runtime.py` | 执行 skill（含 retry/fallback） |
| `apply_result_to_state(decision: ActionDecision, result: ExecutionResult, state: RuntimeState)` | `runtime.py` | 更新 state |
| `finalize(state: RuntimeState) -> str` | `runtime.py` | 生成最终回答 |

### 辅助函数

| 函数名 | 文件路径 | 用途 |
|-------|---------|------|
| `record_trace(state: RuntimeState, event_type: str, payload: Dict)` | `runtime.py` | 记录 trace 事件 |
| `record_history(state: RuntimeState, event: Dict)` | `runtime.py` | 记录执行历史 |
| `safe_merge_memory(state: RuntimeState, output: Dict)` | `runtime.py` | 安全合并 memory |
| `parse_action_decision(response: str) -> ActionDecision` | `llm_decision.py` | 解析 LLM JSON 响应 |
| `validate_action_decision(decision: ActionDecision, tool_registry: Dict, skill_registry: Dict) -> bool` | `llm_decision.py` | 验证 action 有效性 |

### Skill Workflow 解析函数

| 函数名 | 文件路径 | 用途 |
|-------|---------|------|
| `parse_workflow_from_skill(skill: SkillPackage) -> List[SkillWorkflowStep]` | `skill_executor.py` | 从 SKILL.md 解析 workflow |
| `execute_workflow_step(step: SkillWorkflowStep, state: RuntimeState, runtime: AgentRuntime) -> ExecutionResult` | `skill_executor.py` | 执行单个 workflow 步骤 |

## [Classes]

### AgentRuntime

```python
class AgentRuntime:
    """顺序执行 Agent Runtime
    
    核心职责：
    - 管理主循环
    - 调用 LLM 选择下一步 action
    - 执行 action（tool/skill）
    - 管理 retry/fallback
    - 更新 state
    - 记录 trace/history
    - finalize 输出
    """
    
    def __init__(
        self,
        ai_service: AIService,
        mcp_manager: MCPManager,
        skill_registry: SkillRegistry,
        max_steps: int = 10
    ):
        self.ai_service = ai_service
        self.mcp_manager = mcp_manager
        self.skill_registry = skill_registry
        self.max_steps = max_steps
        
        # Tool 配置（retry/fallback）
        self.tool_configs: Dict[str, ToolConfig] = {}
        
        # Skill 配置（retry/fallback）
        self.skill_configs: Dict[str, SkillConfig] = {}
```

### ToolWrapper

```python
class ToolWrapper:
    """MCP Tool 包装器
    
    为 MCP 工具添加 retry 和 fallback 支持。
    MCP 工具本身不可修改，通过包装器添加配置。
    """
    
    def __init__(
        self,
        tool_name: str,
        mcp_manager: MCPManager,
        max_retries: int = 0,
        fallback_tool_name: Optional[str] = None
    ):
        self.tool_name = tool_name
        self.mcp_manager = mcp_manager
        self.max_retries = max_retries
        self.fallback_tool_name = fallback_tool_name
    
    def run(self, state: RuntimeState) -> ExecutionResult:
        """执行工具，支持 retry 和 fallback"""
        pass
```

### SkillExecutor

```python
class SkillExecutor:
    """Skill 执行器
    
    解析 SKILL.md 的 workflow，逐步执行每个步骤。
    每个步骤内部由 LLM 决定调用哪个 tool。
    """
    
    def __init__(self, skill: SkillPackage, runtime: AgentRuntime):
        self.skill = skill
        self.runtime = runtime
        self.workflow_steps = self._parse_workflow()
    
    def execute(self, state: RuntimeState) -> ExecutionResult:
        """执行整个 skill workflow"""
        pass
    
    def execute_step(self, step: SkillWorkflowStep, state: RuntimeState) -> ExecutionResult:
        """执行单个 workflow 步骤"""
        pass
```

### LLMDecisionMaker

```python
class LLMDecisionMaker:
    """LLM 决策接口
    
    构建 prompt，调用 LLM，解析 JSON 响应。
    """
    
    def __init__(self, ai_service: AIService):
        self.ai_service = ai_service
    
    async def select_next_action(
        self,
        state: RuntimeState,
        available_tools: List[Dict],
        available_skills: List[Dict]
    ) -> ActionDecision:
        """让 LLM 决定下一步 action"""
        pass
    
    def build_decision_prompt(
        self,
        state: RuntimeState,
        available_tools: List[Dict],
        available_skills: List[Dict]
    ) -> str:
        """构建决策 prompt"""
        pass
    
    def parse_decision_response(self, response: str) -> ActionDecision:
        """解析 LLM JSON 响应"""
        pass
```

## [Dependencies]

无需新增依赖包，使用现有依赖：
- `dataclasses` - 数据结构
- `typing` - 类型注解
- `json` - JSON 解析
- `logging` - 日志

复用现有模块：
- `app.services.ai_service` - AI 服务
- `app.core.mcp_manager` - MCP 工具管理
- `app.skills.skill_registry` - Skill 注册表
- `app.skills.loader` - Skill 加载器
- `app.skills.parser` - Skill 解析器

## [Testing]

### 测试文件

| 测试文件 | 测试内容 |
|---------|---------|
| `tests/unit/test_agent_runtime_state.py` | RuntimeState 数据结构 |
| `tests/unit/test_agent_runtime_actions.py` | ExecutionResult, ActionDecision |
| `tests/unit/test_agent_runtime_tool_wrapper.py` | ToolWrapper retry/fallback |
| `tests/unit/test_agent_runtime_skill_executor.py` | SkillExecutor workflow 解析和执行 |
| `tests/unit/test_agent_runtime_llm_decision.py` | LLMDecisionMaker |
| `tests/unit/test_agent_runtime_runtime.py` | AgentRuntime 主循环 |

### Demo 验证

`example_main.py` 包含：
1. **Mock LLM**：简单逻辑模拟 LLM 决策
2. **Demo Tools**：search_api（第一次失败）、backup_search_api
3. **Demo Skills**：parse_skill、research_skill（调用 tool + sub-skill）
4. **验证输出**：final_answer、memory、history、trace

## [Implementation Order]

1. **创建模块结构** - `__init__.py`，目录结构
2. **实现数据结构** - `state.py`, `actions.py`, `exceptions.py`
3. **实现 ToolWrapper** - `tool_wrapper.py`（MCP 工具包装，retry/fallback）
4. **实现 LLMDecisionMaker** - `llm_decision.py`（决策 prompt + JSON 解析）
5. **实现 SkillExecutor** - `skill_executor.py`（workflow 解析和执行）
6. **实现 AgentRuntime** - `runtime.py`（主循环、分发、状态管理）
7. **实现 Demo** - `example_main.py`（Mock LLM + Demo Tools/Skills）
8. **测试验证** - 确保所有特性工作正常