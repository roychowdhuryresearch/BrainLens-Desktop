"""Agent Runtime Demo

演示如何使用 Agent Runtime，包含：
1. Mock LLM：简单逻辑模拟 LLM 决策
2. Demo Tools：search_api（第一次失败）、backup_search_api
3. Demo Skills：parse_skill、research_skill（调用 tool + sub-skill）
4. 验证输出：final_answer、memory、history、trace

运行方式：
    python -m runtime.agent_runtime.example_main
"""

import asyncio
import json
import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .runtime import AgentRuntime
from .state import RuntimeState
from .actions import ActionDecision, ExecutionResult

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


# ==================== Mock 类 ====================

@dataclass
class MockSkillPackage:
    """Mock Skill Package"""
    name: str
    description: str
    content: str
    

class MockAIService:
    """Mock AI Service
    
    模拟 LLM 决策，根据简单逻辑返回决策。
    """
    
    def __init__(self):
        self.call_count = 0
        self.decision_sequence = []
    
    def set_decision_sequence(self, decisions: List[Dict[str, Any]]) -> None:
        """设置决策序列"""
        self.decision_sequence = decisions
        self.call_count = 0
    
    async def chat_completion(
        self,
        messages: List[Dict[str, str]],
        temperature: float = 0.1
    ) -> str:
        """模拟 chat completion"""
        self.call_count += 1
        
        # 如果有预设的决策序列，使用序列
        if self.decision_sequence:
            if self.call_count <= len(self.decision_sequence):
                decision = self.decision_sequence[self.call_count - 1]
                return json.dumps(decision, ensure_ascii=False)
        
        # 默认：根据消息内容简单决策
        content = messages[-1].get("content", "") if messages else ""
        
        if "最终回答" in content or "总结" in content:
            return "任务已执行完成。"
        
        # 默认返回 FINISH
        return json.dumps({
            "action_type": "FINISH",
            "action_name": "FINISH",
            "reason": "模拟完成"
        }, ensure_ascii=False)


class MockMCPManager:
    """Mock MCP Manager
    
    模拟 MCP 工具调用。
    """
    
    def __init__(self):
        self.tools = {
            "search_api": {
                "name": "search_api",
                "description": "搜索 API（第一次会失败）"
            },
            "backup_search_api": {
                "name": "backup_search_api",
                "description": "备用搜索 API"
            },
            "get_weather": {
                "name": "get_weather",
                "description": "获取天气信息"
            }
        }
        self.call_counts: Dict[str, int] = {}
    
    def list_tools(self) -> List[Dict[str, Any]]:
        """列出所有工具"""
        return list(self.tools.values())
    
    async def call_tool(
        self,
        tool_name: str,
        parameters: Dict[str, Any]
    ) -> Dict[str, Any]:
        """调用工具"""
        self.call_counts[tool_name] = self.call_counts.get(tool_name, 0) + 1
        
        if tool_name == "search_api":
            # 第一次调用失败
            if self.call_counts[tool_name] == 1:
                return {
                    "isError": True,
                    "error": "网络超时"
                }
            return {
                "isError": False,
                "content": [{"type": "text", "text": "搜索结果: 相关数据已找到"}]
            }
        
        elif tool_name == "backup_search_api":
            return {
                "isError": False,
                "content": [{"type": "text", "text": "备用搜索结果: 数据已获取"}]
            }
        
        elif tool_name == "get_weather":
            city = parameters.get("city", "北京")
            return {
                "isError": False,
                "content": [{"type": "text", "text": f"{city}今天晴，温度 25°C"}]
            }
        
        return {
            "isError": True,
            "error": f"未知工具: {tool_name}"
        }


class MockSkillRegistry:
    """Mock Skill Registry
    
    模拟 Skill 注册表。
    """
    
    def __init__(self):
        self.skills: Dict[str, MockSkillPackage] = {}
        self._init_skills()
    
    def _init_skills(self) -> None:
        """初始化 demo skills"""
        # 简单 skill
        self.skills["parse_skill"] = MockSkillPackage(
            name="parse_skill",
            description="解析数据的 skill",
            content="""
# Parse Skill

## Description
解析输入数据，提取关键信息。

## Workflow

1. **接收输入** - 接收用户输入的数据
2. **解析数据** - 使用 `parse_content` 工具解析
3. **返回结果** - 返回解析结果
"""
        )
        
        # 复杂 skill（调用 tool + sub-skill）
        self.skills["research_skill"] = MockSkillPackage(
            name="research_skill",
            description="研究问题的 skill",
            content="""
# Research Skill

## Description
研究用户问题，收集相关信息。

## Workflow

1. **搜索信息** - 使用 `search_api` 工具搜索相关信息
2. **解析结果** - 调用 `parse_skill` 解析搜索结果
3. **总结输出** - 生成最终回答
"""
        )
    
    def list_skills(self) -> List[MockSkillPackage]:
        """列出所有 skills"""
        return list(self.skills.values())
    
    def get_skill(self, skill_name: str) -> Optional[MockSkillPackage]:
        """获取 skill"""
        return self.skills.get(skill_name)


# ==================== Demo 函数 ====================

async def demo_basic_runtime():
    """基本 Runtime 演示"""
    print("\n" + "=" * 60)
    print("Demo 1: 基本 Runtime 演示")
    print("=" * 60)
    
    # 创建 mock 服务
    ai_service = MockAIService()
    mcp_manager = MockMCPManager()
    skill_registry = MockSkillRegistry()
    
    # 设置决策序列
    ai_service.set_decision_sequence([
        {"action_type": "tool", "action_name": "get_weather", "reason": "获取天气信息", "parameters": {"city": "上海"}},
        {"action_type": "FINISH", "action_name": "FINISH", "reason": "天气信息已获取"}
    ])
    
    # 创建 runtime
    runtime = AgentRuntime(
        ai_service=ai_service,
        mcp_manager=mcp_manager,
        skill_registry=skill_registry,
        max_steps=5
    )
    
    # 执行
    state = await runtime.run("上海今天天气怎么样？")
    
    # 输出结果
    print_state_result(state)


async def demo_retry_fallback():
    """Retry/Fallback 演示"""
    print("\n" + "=" * 60)
    print("Demo 2: Retry/Fallback 演示")
    print("=" * 60)
    
    # 创建 mock 服务
    ai_service = MockAIService()
    mcp_manager = MockMCPManager()
    skill_registry = MockSkillRegistry()
    
    # 设置决策序列
    ai_service.set_decision_sequence([
        {"action_type": "tool", "action_name": "search_api", "reason": "搜索数据"},
        {"action_type": "FINISH", "action_name": "FINISH", "reason": "搜索完成"}
    ])
    
    # 创建 runtime
    runtime = AgentRuntime(
        ai_service=ai_service,
        mcp_manager=mcp_manager,
        skill_registry=skill_registry,
        max_steps=5
    )
    
    # 配置 retry/fallback
    runtime.configure_tool(
        tool_name="search_api",
        max_retries=1,  # 重试一次
        fallback_tool_name="backup_search_api",  # 失败后使用备用
        retry_delay=0.1  # 快速重试
    )
    
    # 执行
    state = await runtime.run("帮我搜索一些数据")
    
    # 输出结果
    print_state_result(state)
    
    # 验证 fallback 是否触发
    print("\n--- Fallback 验证 ---")
    print(f"search_api 调用次数: {mcp_manager.call_counts.get('search_api', 0)}")
    print(f"backup_search_api 调用次数: {mcp_manager.call_counts.get('backup_search_api', 0)}")


async def demo_skill_execution():
    """Skill 执行演示"""
    print("\n" + "=" * 60)
    print("Demo 3: Skill 执行演示")
    print("=" * 60)
    
    # 创建 mock 服务
    ai_service = MockAIService()
    mcp_manager = MockMCPManager()
    skill_registry = MockSkillRegistry()
    
    # 设置决策序列
    ai_service.set_decision_sequence([
        {"action_type": "skill", "action_name": "research_skill", "reason": "使用研究 skill"},
        {"action_type": "tool", "action_name": "search_api", "reason": "搜索信息"},
        {"action_type": "FINISH", "action_name": "FINISH", "reason": "研究完成"}
    ])
    
    # 创建 runtime
    runtime = AgentRuntime(
        ai_service=ai_service,
        mcp_manager=mcp_manager,
        skill_registry=skill_registry,
        max_steps=5
    )
    
    # 配置 search_api 的 fallback
    runtime.configure_tool(
        tool_name="search_api",
        max_retries=0,
        fallback_tool_name="backup_search_api"
    )
    
    # 执行
    state = await runtime.run("帮我研究一下这个问题")
    
    # 输出结果
    print_state_result(state)


def print_state_result(state: RuntimeState) -> None:
    """打印状态结果"""
    print("\n--- 执行结果 ---")
    print(f"用户输入: {state.user_input}")
    print(f"完成状态: {'完成' if state.done else '未完成'}")
    print(f"执行步数: {state.current_step}/{state.max_steps}")
    print(f"最终回答: {state.final_answer or '无'}")
    print(f"错误信息: {state.last_error or '无'}")
    
    print("\n--- 工作内存 ---")
    if state.memory:
        for key, value in state.memory.items():
            print(f"  {key}: {value}")
    else:
        print("  (空)")
    
    print("\n--- 执行历史 ---")
    if state.history:
        for i, event in enumerate(state.history):
            status = "✓" if event.get("success") else "✗"
            print(f"  {i+1}. [{status}] {event.get('action_type')}/{event.get('action_name')}: {event.get('message', '')[:50]}")
    else:
        print("  (空)")
    
    print("\n--- 追踪事件 ---")
    if state.trace:
        for event in state.trace[:10]:  # 只显示前 10 个
            print(f"  [{event.step_id}] {event.event_type}")
    else:
        print("  (空)")


async def main():
    """主函数"""
    print("=" * 60)
    print("Agent Runtime Demo")
    print("=" * 60)
    
    # 运行所有 demo
    await demo_basic_runtime()
    await demo_retry_fallback()
    await demo_skill_execution()
    
    print("\n" + "=" * 60)
    print("所有 Demo 执行完成！")
    print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())