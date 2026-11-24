from pydantic import BaseModel, Field, model_validator
from typing import List, Optional, Dict, Any, Literal
from datetime import datetime
from enum import Enum
import time


# ============ Skill System Types ============

class SkillType(str, Enum):
    """Skill类型枚举"""
    INSTRUCTIONAL = "instructional"  # 只扩展prompt（当前实现）
    EXECUTABLE = "executable"        # prompt + script（后续扩展）
    AGENTIC = "agentic"              # prompt + subagent（后续扩展）


class SkillInvocationMode(str, Enum):
    """Skill触发模式"""
    AUTO = "auto"        # 自动触发
    MANUAL = "manual"    # 仅手动触发
    BOTH = "both"        # 自动和手动均可


class SkillManifest(BaseModel):
    """Skill元数据，从SKILL.md解析"""
    # 基础信息
    name: str = Field(..., description="Skill唯一标识名称")
    description: str = Field(..., description="Skill功能描述")
    path: str = Field(..., description="SKILL.md文件路径")
    skill_type: SkillType = Field(default=SkillType.INSTRUCTIONAL, description="Skill类型")
    invocation_mode: SkillInvocationMode = Field(default=SkillInvocationMode.BOTH, description="触发模式")
    
    # 匹配相关
    tags: List[str] = Field(default_factory=list, description="标签列表")
    keywords: List[str] = Field(default_factory=list, description="关键词列表")
    when_to_use: Optional[str] = Field(None, description="使用场景描述")
    do_not_use: Optional[str] = Field(None, description="不适用场景")
    examples: List[str] = Field(default_factory=list, description="示例查询")
    
    # 执行相关
    workflow: List[str] = Field(default_factory=list, description="工作流程步骤")
    output_format: Optional[str] = Field(None, description="输出格式说明")
    output_style: Optional[str] = Field(None, description="输出风格")
    
    # 资源文件
    scripts: List[str] = Field(default_factory=list, description="脚本文件列表")
    templates: List[str] = Field(default_factory=list, description="模板文件列表")
    references: List[str] = Field(default_factory=list, description="参考文档列表")
    
    # 元信息
    author: Optional[str] = Field(None, description="作者")
    version: Optional[str] = Field(None, description="版本号")
    category: Optional[str] = Field(None, description="分类")
    environment: Optional[str] = Field(None, description="技能环境: prod 或 test")
    user_id: Optional[str] = Field(None, description="用户ID（仅测试环境技能）")
    username: Optional[str] = Field(None, description="用户名称")
    submitted: bool = Field(default=False, description="是否已提交审核")
    submitted_at: Optional[str] = Field(None, description="提交时间")
    published: bool = Field(default=False, description="是否已发布")
    published_at: Optional[str] = Field(None, description="发布时间")


class SkillMatch(BaseModel):
    """Skill匹配结果"""
    skill: SkillManifest
    score: float = Field(..., ge=0, description="匹配分数")
    matched_keywords: List[str] = Field(default_factory=list, description="匹配的关键词")
    matched_tags: List[str] = Field(default_factory=list, description="匹配的标签")


class SkillDecision(BaseModel):
    """LLM决策结果"""
    use_skill: bool = Field(..., description="是否使用Skill")
    skill_name: Optional[str] = Field(None, description="选中的Skill名称")
    confidence: float = Field(..., ge=0, le=1, description="置信度")
    reason: Optional[str] = Field(None, description="判断理由")


class ActiveSkillContext(BaseModel):
    """激活的Skill上下文，用于注入Prompt"""
    name: str
    description: str
    when_to_use: Optional[str] = None
    do_not_use: Optional[str] = None
    workflow: List[str] = Field(default_factory=list)
    output_format: Optional[str] = None
    
    def to_xml(self) -> str:
        """转换为XML格式，用于注入System Prompt"""
        xml_parts = [f'<active_skill name="{self.name}">']
        xml_parts.append(f'  <description>{self.description}</description>')
        
        if self.when_to_use:
            xml_parts.append(f'  <when_to_use>{self.when_to_use}</when_to_use>')
        if self.do_not_use:
            xml_parts.append(f'  <do_not_use>{self.do_not_use}</do_not_use>')
        
        if self.workflow:
            xml_parts.append('  <workflow>')
            for step in self.workflow:
                xml_parts.append(f'    <step>{step}</step>')
            xml_parts.append('  </workflow>')
        
        if self.output_format:
            xml_parts.append(f'  <output_format>{self.output_format}</output_format>')
        
        xml_parts.append('</active_skill>')
        return '\n'.join(xml_parts)


class SkillListResponse(BaseModel):
    """Skill列表API响应"""
    skills: List[SkillManifest]
    total: int


class SkillActivationRequest(BaseModel):
    """Skill激活请求"""
    skill_name: str = Field(..., description="要激活的Skill名称")


# ============ Existing Types ============


class AIModelConfig(BaseModel):
    provider: str  # e.g. 'zhipu', 'qianwen', 'openai', 'deepseek'
    model: str
    api_key: str
    api_base: Optional[str] = None
    temperature: float = 0.7
    max_tokens: int = 2000


class RouterModelConfig(BaseModel):
    """路由模型配置 - 用于 Skill Router 的独立模型配置
    
    可以使用更轻量、更快的模型进行路由决策，降低成本和延迟。
    """
    provider: str = Field(..., description="AI提供商，如 'zhipu'、'qianwen'、'openai'、'deepseek'")
    model: str = Field(..., description="模型名称，如 'qwen3.5-flash', 'glm-4-flash'")
    api_key: Optional[str] = Field(None, description="API Key（可选，默认复用同 provider 的 key）")
    api_base: Optional[str] = Field(None, description="API 基础 URL（可选）")
    temperature: float = Field(default=0.3, description="温度参数，路由建议使用较低值")
    max_tokens: int = Field(default=1000, description="最大输出 token 数")


class AttachmentData(BaseModel):
    """用户上传附件数据（图片、PDF、Office、TXT/MD 等统一入口）"""
    data: Optional[str] = Field(None, description="Base64 编码的原始附件数据")
    url: Optional[str] = Field(None, description="附件临时访问 URL")
    storage_key: Optional[str] = Field(None, description="对象存储引用，格式为 bucket/object_key")
    content_type: str = Field(default="application/octet-stream", description="MIME 类型")
    filename: Optional[str] = Field(None, description="原始文件名")
    size: Optional[int] = Field(None, description="附件字节数")
    sha256: Optional[str] = Field(None, description="原始附件 SHA-256")


class ImageData(AttachmentData):
    """Deprecated compatibility alias for older in-process callers."""


class ChatRequest(BaseModel):
    message: str
    conversation_id: Optional[str] = None
    knowledge_base_id: Optional[str] = None
    use_search: bool = Field(default=True, description="是否使用搜索功能")
    active_skill: Optional[str] = Field(None, description="手动指定的Skill名称")
    model: Optional[str] = Field(None, description="用户选择的模型，优先于配置文件中的active_model")
    skill_environment: str = Field(..., description="技能环境选择: 'prod' 或 'test'")
    user_id: Optional[str] = Field(None, description="用户ID，允许为空。如果不提供，默认使用'anonymous'")
    attachments: Optional[List[AttachmentData]] = Field(None, description="用户上传附件列表")


class ChatResponse(BaseModel):
    model_config = {"protected_namespaces": ()}
    
    message_id: str
    content: str
    sources: List[Dict[str, Any]]
    model_used: str
    tokens_used: Optional[int] = None
    active_skill: Optional[str] = Field(None, description="当前激活的Skill名称")
    skill_candidates: Optional[List[SkillMatch]] = Field(None, description="多Skill候选时返回")
    ui_commands: List[Dict[str, Any]] = Field(default_factory=list, description="Agent-emitted UI commands for the renderer to execute (view) or stage (write)")
    action_receipts: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="Authoritative action receipts retained from the terminal done event",
    )
    research_output: Optional[Dict[str, Any]] = Field(
        default=None,
        description="Validated research output retained from the terminal done event",
    )


class MCPServerType(str, Enum):
    """MCP服务器类型"""
    LOCAL = "local"      # 本地进程型 MCP
    REMOTE = "remote"    # 远程 HTTP 服务


class ContextConfigModel(BaseModel):
    """上下文管理配置（简化版）
    
    只需配置 2 个核心参数，其他参数自动推导：
    - max_context_tokens: 最大上下文 token 数
    - recent_keep_turns: 保留最近 N 轮对话
    
    自动推导的参数（在 ContextConfig 中通过 property 计算）：
    - summary_trigger_turns: recent_keep_turns + 2
    - summary_trigger_tokens: max_context_tokens * 0.75
    """
    # === 核心参数（用户配置） ===
    max_context_tokens: int = Field(default=12000, description="最大上下文 token 数")
    recent_keep_turns: int = Field(default=6, description="保留最近 N 轮对话")
    
    # === 可选参数（有合理默认值） ===
    enable_context_summary: bool = Field(default=True, description="是否启用摘要功能")
    enable_noise_filter: bool = Field(default=True, description="是否启用噪音过滤")
    summarizer_temperature: float = Field(default=0.3, description="摘要生成温度")
    
    # === 兼容旧配置（可选，用于平滑迁移） ===
    # 这些字段保留以兼容旧配置文件，但不再必需
    summary_trigger_msg_count: Optional[int] = Field(default=None, description="触发摘要的消息数阈值（已废弃）")
    summary_trigger_tokens: Optional[int] = Field(default=None, description="触发摘要的 token 数阈值（已废弃）")
    summary_refresh_every_turns: Optional[int] = Field(default=None, description="每隔多少轮更新摘要（已废弃）")


class MCPServerConfig(BaseModel):
    """单个MCP服务器配置"""
    name: str = Field(..., description="服务器名称，如 'doc_search', 'web_search'")
    type: MCPServerType = Field(default=MCPServerType.LOCAL, description="服务器类型")
    enabled: bool = Field(default=True, description="是否启用")
    
    # 工具名前缀配置
    tool_prefix: Optional[str] = Field(None, description="工具名前缀，用于区分不同账号的同类MCP服务")
    guide_tool_names: List[str] = Field(default_factory=list, description="用于 guide 注入的精确工具名列表")
    
    # 本地进程型配置
    command: Optional[str] = Field(None, description="启动命令，如 'python -m my_mcp_server'")
    env: Optional[Dict[str, str]] = Field(None, description="环境变量")
    wait_time: int = Field(default=10, description="启动等待时间（秒）")
    
    # 远程服务型配置
    service_url: Optional[str] = Field(None, description="远程MCP服务URL")
    access_token: Optional[str] = Field(None, description="访问令牌（可选）")
    timeout: int = Field(default=30, description="请求超时时间（秒）")

    # MCP 使用指南（注入 system prompt，描述该 MCP 覆盖的数据域和优先使用场景）
    guide: Optional[str] = Field(None, description="MCP 使用指南文本，描述该 MCP 覆盖的数据域和优先使用场景")

    @model_validator(mode="before")
    @classmethod
    def validate_remote_auth(cls, values):
        # Avoid silently starting a previously authenticated remote connector anonymously.
        if isinstance(values, dict) and values.get("type") == "remote":
            if (values.get("app_id") or values.get("app_secret")) and not values.get("access_token"):
                raise ValueError("Authenticated remote MCP servers require access_token")
        return values


# 技能环境配置类
class SkillEnvironmentConfig(BaseModel):
    """技能环境配置"""
    admin_default: Optional[str] = Field(None, description="管理员默认技能环境: prod 或 test")
    developer_default: Optional[str] = Field(None, description="开发者默认技能环境: prod 或 test")
    user_default: Optional[str] = Field(None, description="普通用户默认技能环境: prod 或 test")


class BootstrapSkillPrefilterConfig(BaseModel):
    """Bootstrap 前的技能预筛选配置。"""
    enabled: bool = Field(default=False, description="是否启用 bootstrap skill 预筛选")
    top_k: int = Field(default=8, ge=1, description="高置信命中时保留的候选 skill 数量")
    min_top1_score: float = Field(default=10.0, ge=0.0, description="启用过滤所需的第一候选最低分数")
    min_skill_count: int = Field(default=12, ge=1, description="总 skill 数达到该值时才尝试过滤")


# ============ VL (Vision Language) Types ============
# 注意：VLMModelConfig 必须在 SystemConfig 之前定义

class VLMModelConfig(BaseModel):
    """VLM 模型配置（独立于文本模型）"""
    provider: str = Field(..., description="提供商，如 'zhipu' 或 'qianwen'")
    model: str = Field(..., description="VL 模型名称，如 'glm-4v', 'qwen-vl-max'")
    api_key: str = Field(..., description="API Key")
    api_base: Optional[str] = Field(None, description="API Base URL")
    max_tokens: int = Field(default=4096, description="最大输出 token")
    enabled: bool = Field(default=True, description="是否启用 VL 功能")


class TokenBucketConfig(BaseModel):
    """令牌桶算法配置"""
    qianwen_token_limit_per_minute: int = Field(default=10000000, description="千问API每分钟token限制")
    token_refill_rate: float = Field(default=166667.0, description="令牌生成速率（token/秒）")
    token_bucket_capacity: int = Field(default=1000000, description="令牌桶容量")


class TokenEstimationConfig(BaseModel):
    """Token估算配置"""
    char_to_token_ratio: float = Field(default=2.0, description="字符到token的转换比例")
    overhead_tokens: int = Field(default=50, description="请求基础开销token数")


class RetryConfig(BaseModel):
    """重试策略配置"""
    max_retries: int = Field(default=3, description="最大重试次数")
    base_delay: float = Field(default=1.0, description="基础延迟（秒）")
    max_delay: float = Field(default=60.0, description="最大延迟（秒）")
    jitter_range: float = Field(default=1.0, description="抖动范围（秒）")
    retryable_status_codes: List[int] = Field(default_factory=lambda: [429, 500, 502, 503, 504], description="可重试的HTTP状态码")


class ModelSpecificConfig(BaseModel):
    """模型特定配置"""
    enabled: bool = Field(default=True, description="是否启用该模型的特定配置")
    token_bucket: Optional[TokenBucketConfig] = Field(default=None, description="令牌桶算法配置（可选，默认使用全局配置）")
    retry: Optional[RetryConfig] = Field(default=None, description="重试策略配置（可选，默认使用全局配置）")


class AIServiceConfig(BaseModel):
    """AI服务配置"""
    # 全局配置
    token_bucket: TokenBucketConfig = Field(default_factory=TokenBucketConfig, description="令牌桶算法配置")
    token_estimation: TokenEstimationConfig = Field(default_factory=TokenEstimationConfig, description="Token估算配置")
    retry: RetryConfig = Field(default_factory=RetryConfig, description="重试策略配置")
    
    # 模型特定配置
    model_specific: Optional[Dict[str, ModelSpecificConfig]] = Field(default=None, description="模型特定配置")


class ConversationConcurrencyConfig(BaseModel):
    """对话并发管理配置"""
    max_concurrent: int = Field(default=20, description="最大并发对话数")
    queue_maxsize: int = Field(default=1000, description="队列最大容量")
    default_timeout: Optional[float] = Field(default=None, description="默认任务超时时间（秒）")
    enable_priority: bool = Field(default=False, description="是否启用优先级队列")


class VerificationConfig(BaseModel):
    """回复对齐校验配置"""
    enabled: bool = Field(default=True, description="是否启用回复对齐校验")
    verification_model: Literal["qwen3.5-flash", "qwen-turbo"] = Field(
        default="qwen-turbo",
        description="校验模型，可选 qwen3.5-flash 或 qwen-turbo",
    )
    test_mode_enabled: bool = Field(
        default=False,
        description="测试模式开关，开启后强制输出 forced_verdict",
    )
    forced_verdict: Optional[
        Literal["success", "partial_success", "failure"]
    ] = Field(
        default=None,
        description="测试模式下强制返回的 verdict",
    )
    forced_reason: str = Field(
        default="forced_by_test_mode",
        description="测试模式下强制返回的 reason",
    )
    forced_confidence: Optional[float] = Field(
        default=0.99,
        ge=0.0,
        le=1.0,
        description="测试模式下强制返回的 confidence",
    )
    timeout_seconds: float = Field(default=30.0, description="校验超时时间（秒）")
    use_router_model: bool = Field(default=True, description="是否优先复用 router_model")
    min_answer_length: int = Field(
        default=10,
        description="最小回答长度，低于该值时仅对明显空洞内容快速判定 failure",
    )
    guide_message: str = Field(
        default="如果没有找到你需要的信息，可以尝试调整关键词或描述得更具体一些。",
        description="无实质内容 failure 时追加的引导语",
    )
    disclaimer_message: str = Field(
        default="以上回答可能未完整覆盖你的问题，建议进一步确认或联系支持团队。",
        description="跑题类 failure 且修复失败时追加的免责提示",
    )
    fallback_message: str = Field(
        default="抱歉，我暂时无法给出有效回答。请尝试重新表述你的问题。",
        description="极端情况下的最终保护信息",
    )


class GuardedToolPolicyConfig(BaseModel):
    tool_name: str = Field(..., description="需要进入人工确认流程的真实工具名")
    risk_level: str = Field(default="high", description="风险等级")
    requires_confirmation: bool = Field(default=True, description="是否要求前端确认")
    editable: bool = Field(default=True, description="前端是否允许修改参数")
    title: Optional[str] = Field(default=None, description="审批标题")
    description: Optional[str] = Field(default=None, description="审批说明")
    timeout_seconds: int = Field(default=300, description="审批超时时间（秒）")


class SystemConfig(BaseModel):
    ai_models: List[AIModelConfig]
    active_model: str
    mcp_server_url: Optional[str] = None  # 保留兼容性
    
    # MCP服务器配置（统一配置方式）
    mcp_servers: Optional[List[MCPServerConfig]] = Field(default=None, description="MCP服务器列表")
    
    # 默认可用的 MCP 服务器列表（DB 中 allowed_mcp_servers=NULL 的用户使用此配置）
    default_mcp_servers: Optional[List[str]] = Field(default=None, description="默认可用的MCP服务器列表")
    
    # 上下文管理配置
    context_config: Optional[ContextConfigModel] = Field(default=None, description="上下文管理配置")
    
    # 对话并发管理配置
    conversation_concurrency: Optional[ConversationConcurrencyConfig] = Field(default=None, description="对话并发管理配置")
    
    # 技能环境配置
    skill_environment_config: Optional[SkillEnvironmentConfig] = Field(default=None, description="技能环境配置")
    
    # 路由模型配置（可选，用于 Skill Router）
    router_model: Optional[RouterModelConfig] = Field(default=None, description="路由模型配置，使用轻量模型进行路由决策")
    
    # 压缩模型配置（可选，用于 reasoning_content 压缩）
    compress_model: Optional[Dict[str, Any]] = Field(default=None, description="压缩模型配置，使用轻量模型进行 reasoning 压缩")

    # 摘要模型配置（可选，用于工具结果摘要）
    summarizer_model: Optional[Dict[str, Any]] = Field(default=None, description="摘要模型配置，用于工具返回结果的 LLM 摘要，默认使用 qwen3.5-flash")
    
    
    # VLM 配置（独立于文本模型）
    vlm_config: Optional[VLMModelConfig] = Field(default=None, description="VLM 视觉模型配置")
    
    # AI服务配置（新增）
    ai_service: Optional[AIServiceConfig] = Field(default=None, description="AI服务配置，包括速率限制和token管理")

    # 回复校验配置
    verification: Optional[VerificationConfig] = Field(default=None, description="回复质量校验配置")

    # 内容脱敏替换规则
    # 格式: List[List[str]]，每个元素是 [原词, 替换词]，顺序敏感（先匹配更具体的词组）
    sanitize_replacements: Optional[List[List[str]]] = Field(default=None, description="内容脱敏替换规则")


    guarded_tool_policies: Optional[List[GuardedToolPolicyConfig]] = Field(
        default=None,
        description="需要走人工确认流程的工具策略",
    )

    bootstrap_skill_prefilter: Optional[BootstrapSkillPrefilterConfig] = Field(
        default=None,
        description="bootstrap 前的 skill 预筛选配置",
    )


class ImageReference(BaseModel):
    """图片引用（存储在 ImageReferenceStore 中）"""
    ref_id: str = Field(..., description="引用ID，如 'img_ref_001'")
    source_type: str = Field(..., description="来源: 'upload'(前端上传base64), 'mcp_url'(MCP返回URL)")
    content_type: str = Field(default="image/jpeg", description="MIME 类型")
    # 图片数据二选一：data 或 url
    data: Optional[str] = Field(None, description="Base64 编码的图片数据（前端上传时使用）")
    url: Optional[str] = Field(None, description="图片 URL（MCP 返回时使用）")
    metadata: Dict[str, Any] = Field(default_factory=dict, description="元数据（如文件名、大小等）")
    created_at: float = Field(default_factory=time.time, description="创建时间戳")
    description: Optional[str] = Field(None, description="图片描述")
    
    def has_data(self) -> bool:
        """是否为 base64 数据类型"""
        return self.data is not None
    
    def has_url(self) -> bool:
        """是否为 URL 类型"""
        return self.url is not None


class MemoryReference(BaseModel):
    """Memory 引用类型（预留，供后续 Reference-based Working Memory 使用）"""
    ref_id: str = Field(..., description="引用ID")
    ref_type: str = Field(..., description="引用类型: 'image', 'document', 'tool_result', 'skill_output'")
    content_preview: Optional[str] = Field(None, description="内容预览（前200字符）")
    source_ref: Optional[str] = Field(None, description="来源引用（如原图引用）")
    created_at: float = Field(default_factory=time.time, description="创建时间戳")
