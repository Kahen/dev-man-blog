---
title: AI Agent 面试题 6 篇系列 · 索引
published: 2026-06-25
description: 本索引汇总 6 篇文章，覆盖 48 道 AI Agent 面试高频题。每一篇都按"核心答案 + 关键要点 + 容易踩的坑 + 示范话术"四个维度展开，并附上跨篇贯穿主线。
tags: [AI Agent, 面试, LLM, 后端]
category: Guides
lang: zh_CN
---

> 本索引汇总 6 篇文章，覆盖 48 道 AI Agent 面试高频题。每一篇都按"核心答案 + 关键要点 + 容易踩的坑 + 示范话术"四个维度展开，并附上跨篇贯穿主线。

---

## 总览：48 道题 × 6 篇文章

| 序号 | 主题 | 题数 | 文章 |
|---|---|---|---|
| 1 | Agent 基础 | 8 | [Agent 基础篇](/posts/ai-agent-interview-basics/) |
| 2 | Agent Memory | 8 | [Agent Memory 篇](/posts/ai-agent-interview-memory/) |
| 3 | Prompt 与 Context Engineering | 8 | [Prompt 与 Context Engineering 篇](/posts/ai-agent-interview-prompt-context/) |
| 4 | MCP 与 Agent Skills | 9 | [MCP 与 Agent Skills 篇](/posts/ai-agent-interview-mcp-skills/) |
| 5 | Harness Engineering | 7 | [Harness Engineering 篇](/posts/ai-agent-interview-harness/) |
| 6 | Workflow、Graph 与 Loop | 8 | [Workflow、Graph 与 Loop 篇](/posts/ai-agent-interview-workflow-graph-loop/) |

---

## 贯穿主线

> 面试时把这条主线讲出来，逻辑就立住了。

**Agent 不是神秘的自主意识，而是 Model + Harness 的工程系统。** 这套系统围绕 LLM 构建，由运行循环、上下文供给、记忆机制、工具调用、安全边界、失败恢复和评测闭环共同组成。面试里讲 Agent 不要只讲"智能"，要讲"约束"——真实项目里，Agent 最大的问题不是不会做事，而是不稳定、不可控、难排查、成本高。

---

## 各篇核心金句（面试可直接用）

### 第 1 篇 · Agent 基础

- **区分 Agent 和 Chatbot 的关键不是"用没用 LLM"，而是"有没有 Loop、有没有 Tools、有没有目标完成判断"。**
- **「Agent = LLM + Planning + Memory + Tools」是起点不是终点；生产公式是「Agent = Model + Harness」。**
- **生产里 Agentic Workflow 才是最常见的选择，纯 Agent 反而是少数。**
- **Multi-Agent 慎用——通信、调试、一致性是三个最常被低估的难题。**

### 第 2 篇 · Agent Memory

- **聊天记录是数据，记忆是能力。**
- **记忆系统不是"存起来"那么简单，而是要解决写入、读取、压缩、过期、冲突、安全、可观测性这一整套问题。**
- **Auto Memory 必须配写入门槛、置信度评估、人工 Review、可回滚四件套——记忆系统的"刹车"比"油门"更重要。**
- **团队记忆走 Git + Code Review，本质是把记忆当代码管；记忆分层比记忆存储更重要。**

### 第 3 篇 · Prompt 与 Context Engineering

- **Prompt 决定模型收到什么指令，Context 决定模型实际看到什么世界——Agent 多步执行里后者更重要。**
- **调 Prompt 是治标，调 Context 才是治本。**
- **Prompt 四要素按 Role → Task → Context → Format 顺序组织效果最好。**
- **防护 Prompt 注入靠系统设计，不靠模型自觉——假设注入一定会发生。**

### 第 4 篇 · MCP 与 Agent Skills

- **MCP 是 AI 领域的 USB-C——一个协议统一所有 Agent 和工具的连接。**
- **Function Calling 是"嘴和手"（模型怎么"说"），MCP 是"电话系统"（工具怎么"接"），Skills 是"工作经验"（Agent 按什么"经验"做）。**
- **MCP 把工具接入标准化了，但安全治理不能省——协议标准化不等于安全标准化。**
- **SKILL.md 的核心是"少而精"——一个 Skill 解决一类任务，多任务就拆多个。**

### 第 5 篇 · Harness Engineering

- **Harness 是"模型之外的那一层系统"——它编码了"模型做不好什么"的领域知识。**
- **Agent = Model + Harness——Harness 不是补丁，是领域知识的显式表达。**
- **Harness 的每个组件都需要独立评估和重新验证，模型换了 Harness 必须重新走一遍。**
- **一线 Agent 工程三大难题：上下文污染、代码熵积累、工具调用可靠性——三类共同治理思路是"假设问题一定会发生"。**

### 第 6 篇 · Workflow、Graph 与 Loop

- **工作流是 AI 系统的骨架，不是 AI 系统的枷锁。**
- **Workflow 是任务过程（抽象），Graph 是结构载体（具象），Loop 是控制模式（特定逻辑）——三者从不同维度描述 AI 系统。**
- **Graph Loop 和 Agent Loop 是不同概念——前者条件边驱动可控，后者 LLM 驱动不可控。**
- **Loop 防死循环要建四道闸门：继续条件、退出条件、最大步数、最大成本——任何 Loop 都必须设。**

---

## 答题框架（贯穿六篇）

面试时建议按这个五步框架回答 Agent 题：

1. **定义任务类型**：是问答、检索、工具调用、多步骤任务，还是长周期任务。
2. **选择编排方式**：纯 Agent、Workflow、Agentic Workflow 还是 Multi-Agent。
3. **讲核心组件**：Context、Memory、Tools、MCP、Skills、State。
4. **讲安全和稳定性**：权限、校验、超时、重试、审计、成本控制。
5. **讲评测**：任务完成率、工具调用准确率、轨迹质量、失败样本回放。

这个框架把"Agent 很智能"拉回到"系统怎么设计"——面试官听到这种回答，通常会判定你是真正做过 Agent 的人。

---

## 常见扣分点（务必避开）

- 把 Agent 讲成"会自动思考的机器人"，强调神秘智能，回避工程问题。
- 只讲 Prompt，不讲上下文供给、工具结果和状态管理。
- 把 Memory 等同于历史聊天记录。
- 把 MCP、Function Calling、Skills 混成一个概念。
- 盲目推 Multi-Agent，不考虑通信成本、调试成本和一致性问题。
- 不知道什么时候该用 Workflow，而不是纯 Agent。

---

## 复习顺序建议

1. **先看 Agent 基础**：讲清 Agent、Chatbot、Workflow 的区别。
2. **再看 Memory 和 Context Engineering**：理解 Agent 稳定性的关键。
3. **接着看 MCP、Skills、Function Calling**：掌握工具生态边界。
4. **最后看 Harness Engineering 和 Workflow**：把知识收敛到生产级架构。

复习时不要只问"Agent 是什么"，要继续追问：它如何拿到信息？如何调用工具？如何记住状态？如何失败恢复？如何评测？这些问题答清楚，才像真的做过 Agent。

---

## 各篇详细题目录

### 第 1 篇 · Agent 基础（8 题）

1. AI Agent 是什么？和普通 Chatbot 有什么区别？
2. Agent = LLM + Planning + Memory + Tools 这条公式怎么理解？
3. Agent Loop 的完整流程是什么？
4. Agent 和传统编程、Workflow 的核心区别是什么？
5. ReAct、Plan-and-Execute、Reflection、Multi-Agent 分别适合什么场景？
6. Tools 注册时，工具 description 为什么很关键？
7. 什么时候用纯 Agent，什么时候用 Workflow 或 Agentic Workflow？
8. Multi-Agent 协作的主要问题是什么？为什么生产里不能盲目上多 Agent？

### 第 2 篇 · Agent Memory（8 题）

1. Agent 的短期记忆和长期记忆有什么区别？
2. Agent 记忆系统要解决哪些核心问题？
3. 向量记忆和 Markdown 记忆分别适合什么场景？
4. Auto Memory 是什么？它为什么不能无限自动写入？
5. 团队共享记忆为什么适合走 Git 和 Code Review？
6. 记忆压缩、记忆过期、记忆冲突应该怎么处理？
7. 如何避免长期记忆污染上下文？
8. 面试里怎么讲"有记忆"不是简单保存聊天记录？

### 第 3 篇 · Prompt 与 Context Engineering（8 题）

1. Prompt Engineering 和 Context Engineering 有什么区别？
2. Prompt 四要素 Role、Task、Context、Format 分别解决什么问题？
3. Few-Shot、CoT、任务分解、结构化输出分别适合什么场景？
4. Prompt 注入攻击是什么？常见防护方式有哪些？
5. 为什么 Agent 场景下只优化 Prompt 不够？
6. Context Engineering 要解决哪些问题？
7. 静态规则、动态信息、工具结果、记忆应该如何进入上下文？
8. 长任务上下文溢出时，Compaction、结构化笔记、Sub-agent 分别怎么用？

### 第 4 篇 · MCP 与 Agent Skills（9 题）

1. MCP 解决什么问题？为什么常被类比成 AI 领域的 USB-C？
2. MCP Client、MCP Server、Host 分别是什么？
3. MCP 的 Tools、Resources、Prompts 分别解决什么问题？
4. MCP 和 Function Calling 有什么区别？
5. 生产级 MCP Server 要做哪些安全治理？
6. Agent Skills 是什么？它和 Prompt、MCP、Function Calling 的边界是什么？
7. Skills 为什么要延迟加载？
8. Skill 路由怎么做？为什么它和 RAG 相似但目标不同？
9. 写一个 SKILL.md 最容易踩哪些坑？

### 第 5 篇 · Harness Engineering（7 题）

1. Harness Engineering 是什么？它和 Prompt Engineering、Context Engineering 有什么关系？
2. 为什么说 Agent = Model + Harness？
3. Harness 的六层架构分别解决什么问题？
4. 模型能力升级后，Harness 里的某些机制为什么需要重新验证？
5. 上下文污染、代码熵积累、工具调用可靠性分别怎么治理？
6. Agent 工程里为什么需要评测器、验证器和任务状态管理？
7. 一线团队做 Agent 工程化时，共同遇到的难点是什么？

### 第 6 篇 · Workflow、Graph 与 Loop（8 题）

1. 为什么 AI 系统需要工作流？
2. Workflow、Graph、Loop 三者是什么关系？
3. Graph Loop 和 Agent Loop 有什么区别？
4. Loop 如何防止死循环？
5. State 的更新策略怎么选？Replace、Append、Reducer 分别适合什么字段？
6. 条件边和动态路由有什么区别？
7. 工作流中断后怎么恢复？
8. 工作流有哪些特有的安全风险？

---

## 写在最后

AI Agent 面试最容易出现两种极端：一种是把 Agent 讲得像"全自动数字员工"，什么都能自己规划、自己执行；另一种是把 Agent 讲得像"几个 Prompt 串起来"，完全看不出和普通工作流的区别。

真正好的回答要落到中间：Agent 的核心不是神秘的自主意识，而是一套围绕大模型构建的任务执行系统。**回答 Agent 题时，建议少讲"智能"，多讲"约束"**——因为真实项目里，Agent 最大的问题不是不会做事，而是不稳定、不可控、难排查、成本高。

把这条主线贯穿六篇 48 题，面试时通常就能从"看过概念"上升到"做过系统"。
