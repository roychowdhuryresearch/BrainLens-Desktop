# iEEG co-pilot 重定位方案:从"流水线遥控器"到"证据/concordance 伙伴"

日期:2026-06-16
缘起:测试不全只是症状;真问题是 prompt/skill 的设计层级与医生的临床推理层级不在一个频道上。
依据:临床文献(见文末)。

---

## 0. 诚实约束(先修正方案形状)

本 app 只持有 **iEEG 信号 + PyHFO 输出**(检测/分类/ranking),以及可选、默认关闭的临床标签。
**它看不到 MRI / PET / semiology。**

所以"concordance 伙伴"**不等于** agent 去吃多模态数据。它的真实含义是:

1. 把**信号证据**做得可信、可被整合(带校准的不确定性 + 证据归因);
2. 当医生**口头给出**其他模态发现或假设时,显式地就"信号证据是否一致"做推理——并始终标注"这只是一条模态的信号证据";
3. 用医生会议汇报的口径,把信号发现写成可用的小结。

agent 的**独特贡献是信号证据本身**——它的活儿是让 HFO/信号证据变得可信、可对账、说人话,而不是假装自己看过片子。这条约束同时是底线:concordance 绝不能变成给 SOZ 命名的后门。

---

## 1. 新的顶层 intent 模型(按临床决策,不按流水线阶段)

把现在的 phase 流水线(inspect→ROI→QC→prep→detect→localize→classify→review→annotate→export)从**主组织轴**降级。它仍然是"手段层",但上面要长出一层"决策层"。35 个命令-intent 全部挂到决策锚点之下,作为 means。

| 决策锚点 | 医生原话风格 | 收编的旧 intent | 现状 |
|---|---|---|---|
| **D1. 这儿的信号证据是什么,我该信几分?** | "看看这病例 / 哪些通道活跃 / 这运行靠谱吗" | INS-*, DET-*, LOC-*, CLS-* | 有命令,但**缺校准+缺 research-grade 口径** |
| **D2. 信号证据跟我已有的判断合不合?** | "我觉得是右颞 / MRI 是左海马硬化,信号支持吗" | (无) | **完全缺失——这是最大的洞** |
| **D3. 帮我看/核一个具体的东西** | "跳到这段 / 看 RA1 / 这段是真高频吗 / 下一个" | NAV-*, REV-* | 基本到位 |
| **D4. 记录我的判断 / 迭代** | "标成伪迹 / 采纳这次 / 阈值调高再跑一次" | ANN-*, ACC-*, ITER-*, RUN-* | 到位,注意 review_write 安全门 |
| **D5. 帮我把这个 case 写出来** | "给我出个汇报 / 总结一下这次结果" | EXP-01(升级) | **被当边角料;应是一等公民** |
| **D6. 安全边界** | "SOZ 在哪 / 该切哪 / 对一下 ground truth" | SAFE-01 | 部分正确(answer-while-declining) |

关键变化:
- **D2 是从零新增的一层**——医生带假设来,agent 就"信号是否支持/部分支持/冲突"作答,显式标注单模态。这正是文献里"多模态 concordance 推理"在我们能力边界内的合法投影。
- **D5 升级为一等交付物**——文献一致指出医生最大痛点是文书负担,低风险高价值的入口是总结/结构化报告,而非认知诊断。把 export.report 从"导个文件"重做成"按会议口径起草 case 小结:发现 + 证据 + 不确定性 + 注意事项 + 还缺什么"。

---

## 2. Prompt 改动(system_prompt.md + skills)

具体落点:

1. **校准强制令**(扩展现有 anti-fabrication,system_prompt.md:42-49):每条信号结论都要带一个诚实的置信度 + 它靠的是什么证据;**永远不要把 HFO-密集通道当成"答案"或暗示成 SOZ**。"high confidence ≠ correctness"——自信地答错是最严重的信任摧毁。
2. **HFO research-grade 常驻口径**:把"HFO 是研究级生物标志物、需与其他数据对账、不是单独决定因素"作为标准框架。依据:HFO Trial 未达 non-inferior;BEST 论文点名 HFO 仍 research-stage。
3. **D2 concordance 行为**:当医生陈述假设或其他模态发现时,显式就"一致/部分一致/冲突"作答,标注为单模态信号证据。新增。
4. **D5 汇报口径 skill**:新增一个"按术前会议口径起草 case 小结"的 skill(发现/证据/不确定性/注意事项/尚缺信息),而不是堆工具输出。
5. **Skills 从"PyHFO 参数配方"扩展到也承载临床 register**——怎么像会议上读片那样说话。

---

## 3. Eval 改动(让"绿"第一次有意义)

把"路由准确率"从主指标降级为子指标,主指标换成文献说真正驱动临床信任的维度:

| 评分维度 | 测什么 | 文献依据 |
|---|---|---|
| **校准** | 声明的置信度是否追踪正确性?自信-错误重罚 | SemioLLM |
| **证据归因** | 每个数字/结论是否绑定到真实工具结果(不是幻觉) | SemioLLM(citation 76% vs 19%) |
| **边界双向** | 答信号问题 + 拒绝临床命名;over-refusal 和 overreach **两个方向都罚** | system_prompt:18-21;refusal-guard 记忆 |
| **concordance 处理** | 给定医生假设,能否诚实推理一致性(含冲突) | 多模态 concordance 文献 |
| **register / 文书** | 小结是否会议可用 | Frontiers 综述(文书是最大痛点) |
| 路由准确率 | 话→命令(降级为子指标) | 现有 catalog |

并且:**eval 输入要从真实临床推理口径来构造**,不再是 "I want all ripples" 这种遥控指令——在拿到真医生原话前,先用文献的 semiology/决策口径当代理锚点。

---

## 4. 排序(先做什么)

1. **最快的高价值**:D5(小结起草)+ 校准/caveat 的 prompt 框架——低风险、文献背书、最快建立信任。
2. **然后 D2**(concordance)——补上缺失的一层。
3. **然后重建 eval 评分 + 重锚 intent**。
4. **有真医生原话时再校准**——文献只是代理锚,真实 utterance 才是终极锚。

---

## 5. 不要做的事

- 不要声称我们做不到的多模态整合(没有 MRI 摄入)。
- 不要拆掉命令 catalog——它是正确的"手段层";我们是在它上面加一层"决策层"。
- 不要让 concordance 成为给 SOZ 命名的后门。
- 不要因为加了决策层就允许 agent 越过 research-only 安全契约。

---

## 实现状态(2026-06-16)

**已落地(行为层,prompt + skills):**
- D1 校准框架 + HFO research-grade 常驻 caveat + D2 concordance 行为 + D5 会议口径 + "在医生那一层操作"的定位句 → 新增 `runtime/prompts/system_prompt.md` 的 "Evidence calibration, concordance, and clinical register" 小节。
- D2 → 新 skill `skills/skills/eeg-concordance/SKILL.md`(医生给假设/他模态发现 → 报信号证据 一致/部分一致/冲突,单模态框定,`do_not_use` 明确限定"不命名 SOZ")。
- D5 → 新 skill `skills/skills/eeg-case-summary/SKILL.md`(会议口径起草:发现/证据/不确定性/caveat/还缺什么)。
- D3/D4 → 现有 skill/命令已覆盖,无需新文件;靠 prompt 定位句上提一层。
- D6 → prompt 边界强化 + 两个新 skill 的 `do_not_use`;现有 SAFE-01(system_prompt 安全契约)保留。

**验证:** 47 个相关 pytest 全绿(skill 加载用子集断言,加新 skill 不撞;system_prompt 字符串断言未破;refusal/契约/路由未变);离线 matcher 确认医生原话命中新 skill 不被旧 skill 抢。

**真模型端到端验证(qwen3.5-plus,2026-06-16)——立得住:** 探针 `evals/_realmodel_d2_d5_probe.py` 注入真 system_prompt + skill + S3 状态,concordance + summary 两个 turn 的散文口径(校准/单模态/守边界/不吹牛)全过。

**eval 评分重建(已完成)——`evals/clinical/`:**
- `rubric.py` — 五维评分(calibration / evidence_attribution / boundary 双向 / concordance / register),每维 0/1/2;boundary 与 evidence 是硬门;含确定性启发式(无 key)+ LLM-judge prompt。
- `clinical_scenarios.json` — 6 个文献口径场景(concordance agree/partial/conflict、summary、boundary 越界陷阱、boundary 过度拒答陷阱)。
- `selftest.py` + `tests/test_clinical_eval_selftest.py` — **确定性、无 key 的测试套件门**:2 个已验证为好的真模型输出当正锚 + 5 个负样本,断言 scorer 在对的维度失败。这就是正面补上"测试不全"的那块。
- `run_clinical_eval.py` — 真模型 runner,完整 ReAct(`stream_message`)+ 确定性 + judge 双打分;trajectory 降为子指标。
- **基线(全 6 场景,qwen3.5-plus):det 5/6,judge 6/6。**

**eval 当场抓到的两个真发现:**
1. **cherry-pick(judge 抓到)**:某次 CONC 回答声称"the four highest are all right-sided"却悄悄漏掉排第 3 的左侧 LH2。判断这种 omission/矛盾交给 judge(纯启发式会误伤正常的"top-few + outlier"叙述,已撤掉那条启发式)。
2. **caveat 掉落(确定性门抓到)→ 已修**:CONC-AGREE 证据干净时,agent 更自信、把单模态/research-grade caveat 省了。修法:eeg-concordance skill step 5 + system_prompt concordance 句改成 caveat **无条件**、"越干净的一致越要带"。重跑 CONC-AGREE 真模型确认:det + judge 双 PASS,caveat 回来了("based on this single biomarker" + 校准 + reconcile 尾)。基线随之 det 6/6(CONC-AGREE 单独复验;其余 5 个本就绿,未整批重跑)/ judge 6/6。

**仍可做:** doctor_prompt_catalog.json 补 D2/D5 条目;把 caveat-一致性 做成对 CONC-AGREE 的显式 eval 期望(把这次的修复纳入回归测试);**真医生原话仍是终极锚**(文献只是代理)。

## 文献

- 多模态术前评估 / concordance 决策:AJR, "Multimodal Presurgical Evaluation of Medically Refractory Focal Epilepsy" (2023) — https://www.ajronline.org/doi/10.2214/AJR.22.27588
- semiology→SOZ 作为真实认知任务 + 校准/citation 需求:SemioLLM (arXiv 2407.03004) — https://arxiv.org/html/2407.03004
- LLM 术前决策评估:ChatGPT presurgical (medRxiv 2024.04.13) — https://www.medrxiv.org/content/10.1101/2024.04.13.24305773.full.pdf
- LLM 临床定位(决策支持非替代、文书低风险入口、校准、GIGO):Frontiers Digital Health mini-review (2025) — https://www.frontiersin.org/journals/digital-health/articles/10.3389/fdgth.2025.1732759/full
- HFO 前瞻性非劣性失败:HFO Trial, Lancet Neurology (2022) — https://www.thelancet.com/journals/laneur/article/PIIS1474-4422(22)00311-8/fulltext
- HFO 仍 research-stage / 生物标志物可信度判据:"BEST Conceivable Way to Talk About Epilepsy Biomarkers" — https://pmc.ncbi.nlm.nih.gov/articles/PMC10273820/
