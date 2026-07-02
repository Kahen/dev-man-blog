---
title: AI Agent 面试题深度解析（四）：MCP 与 Agent Skills 篇
published: 2026-06-29
description: 覆盖 9 道 MCP 与 Agent Skills 高频面试题。Function Calling、MCP、Skills 是 Agent 工具生态的三个不同层次，本篇重点讲清楚它们的边界和组合方式。
tags: [AI Agent, 面试, LLM, MCP, Skills, Function Calling]
category: Guides
lang: zh_CN
---

> 本篇是 AI Agent 面试题系列的第四篇，覆盖 9 道 MCP 与 Agent Skills 高频面试题。Function Calling、MCP、Skills 是 Agent 工具生态的三个不同层次，本篇重点讲清楚它们的边界和组合方式。

---

## 题 1：MCP 解决什么问题？为什么常被类比成 AI 领域的 USB-C？

### 核心答案

MCP（Model Context Protocol，模型上下文协议）解决的是**工具如何被标准化发现、描述、调用和返回结果**的问题。在 MCP 出现之前，每个 Agent 框架都有自己的工具接入方式——LangChain 是一种、AutoGen 是另一种、CrewAI 又是一种，工具接入要按框架分别适配，生态碎片化严重。

MCP 的核心贡献是**统一了 Agent 和工具之间的协议层**。它规定了三件事：工具如何被描述（标准化 schema）、工具如何被发现（自动列举）、工具如何被调用和返回（标准化消息格式）。任何 Agent 宿主只要实现 MCP 客户端，任何工具只要实现 MCP 服务端，就能直接对接。

把它类比成"AI 领域的 USB-C"非常贴切。USB-C 之前，每种设备都有自己的接口（USB-A、HDMI、Lightning、MagSafe），充电和数据传输要带一堆不同的线。USB-C 之后，一个接口统一了所有设备的连接。MCP 在 AI 工具领域做的就是这件事——一个协议统一了所有 Agent 和工具的连接。

MCP 解决的具体问题有四个：

第一，**工具接入碎片化**。MCP 之前，每个 Agent 框架都要为每种工具做适配，工作量是 N×M。MCP 之后变成 N+M，因为工具只需要实现一次 MCP Server，就能被所有支持 MCP 的 Agent 接入。

第二，**工具发现能力不足**。MCP 之前，工具列表通常是硬编码或手工注册。MCP 定义了标准化的"工具列表"消息，Agent 可以动态发现可用工具。

第三，**工具描述不一致**。不同框架对工具 schema 的定义不同，导致 LLM 看到的工具描述质量参差不齐。MCP 用统一的 JSON Schema 描述工具，描述质量有保障。

第四，**工具调用结果混乱**。工具返回结果的格式在不同框架里五花八门，MCP 标准化了结果结构，包括成功、失败、超时、异常等情况的处理。

注意，MCP **不是 Function Calling 的替代**，而是 Function Calling 之上的协议层。Function Calling 解决"模型怎么表达要调工具"（输出结构化意图），MCP 解决"工具怎么接入宿主"（标准化通信）。

### 关键要点

- MCP 解决工具接入的标准化问题，统一 Agent 和工具之间的协议层。
- 类比 USB-C：一个接口连接所有设备。
- MCP 是协议层，不是 Function Calling 的替代。

### 容易踩的坑

- 把 MCP 讲成"工具调用的新方式"，忽略它的协议层定位。
- 把 MCP 和 Function Calling 混为一谈。
- 没意识到 MCP 解决的是"工具生态碎片化"。

### 示范话术

> MCP 我会用"AI 领域的 USB-C"来类比。USB-C 之前每种设备都有自己的接口，要带一堆线；USB-C 之后一个接口统一所有连接。MCP 在 AI 工具领域做的就是这件事——它统一了 Agent 和工具之间的协议层。在 MCP 出现之前，每个 Agent 框架都有自己的工具接入方式，工具要在每个框架里都适配一遍，工作量是 N×M；MCP 之后变成 N+M，工具只需要实现一次 MCP Server 就能被所有支持 MCP 的 Agent 接入。讲这一题我会强调两点：MCP 是协议层，不是 Function Calling 的替代；MCP 真正解决的问题是"工具生态碎片化"，不是"工具调用本身"。

---

## 题 2：MCP Client、MCP Server、Host 分别是什么？

### 核心答案

MCP 架构里有三个核心角色：Host、Client、Server。它们的关系可以类比为"用户—浏览器—网站"或者"应用—驱动—硬件"。

**MCP Host** 是最终用户使用的 Agent 应用，比如 Claude Desktop、Cursor、一个内部 Agent 平台。Host 是"工具的消费者"，负责承载用户交互、管理多个 Client、整合工具结果返回给用户。Host 本身不直接和 Server 通信，它通过 Client 间接通信。

**MCP Client** 是 Host 内嵌的协议客户端，负责和 Server 建立连接、发送请求、接收响应。一个 Host 可以同时跑多个 Client，每个 Client 对应一个 Server。Client 的职责是协议通信本身——序列化、消息路由、状态维护。

**MCP Server** 是工具的提供方，它把具体的工具（API、数据库、文件系统等）包装成 MCP 协议暴露出来。Server 接收 Client 的工具调用请求，执行真实操作，返回标准化结果。Server 通常以独立进程或服务形式存在。

三者的关系可以用一个例子说明：用户在 Claude Desktop（Host）里要求"读取我桌面上的 todo.md"。Claude Desktop 内嵌的 Client 连接到文件系统 MCP Server，发送工具调用请求；Server 执行文件读取，返回 Markdown 内容；Client 把结果返回给 Host，Host 把结果展示给用户。

注意，Host 和 Client 经常被混用——在 Claude Desktop 这种"应用自带 Client"的实现里，Host 和 Client 是同一个进程。但从架构上，它们是两个独立角色：Host 是"应用"，Client 是"协议客户端"。

另外，**MCP Server 不一定等于"远程服务"**。Server 可以是本地进程（stdio 模式），也可以是远程服务（SSE 或 HTTP 模式）。本地模式适合敏感操作（直接访问本地文件、命令执行），远程模式适合共享工具（团队级 API 网关）。

### 关键要点

- Host 是 Agent 应用，Client 是协议客户端，Server 是工具提供方。
- 一个 Host 可以有多个 Client，一个 Client 对应一个 Server。
- Server 不一定远程，可以是本地进程。

### 容易踩的坑

- 把 Host 和 Client 混为一谈。
- 认为 Server 必须是远程服务。
- 不知道一个 Host 可以连多个 Server。

### 示范话术

> MCP 三个角色我会用"应用—驱动—硬件"来类比。Host 是最终用户用的 Agent 应用，比如 Claude Desktop 或 Cursor；Client 是 Host 内嵌的协议客户端，负责和 Server 通信；Server 是工具提供方，把真实工具包装成 MCP 协议。一个 Host 可以有多个 Client，一个 Client 对应一个 Server——比如 Claude Desktop 同时连文件系统的 Server、连 GitHub 的 Server、连数据库的 Server。讲这一题我会特别强调一点：Server 不一定是远程服务，可以是本地进程（stdio 模式），适合文件操作、命令执行这类敏感操作；远程模式（SSE/HTTP）适合团队级共享工具。

---

## 题 3：MCP 的 Tools、Resources、Prompts 分别解决什么问题？

### 核心答案

MCP Server 可以暴露三种能力：Tools、Resources、Prompts。它们解决的问题不同，组合起来构成完整的工具生态。

**Tools** 是**可调用的函数**——Agent 通过 Function Calling 触发，Server 执行后返回结果。Tools 解决"Agent 能做什么动作"的问题，比如发送邮件、查询数据库、调用 API、修改文件。每个 Tool 有明确的输入 schema 和输出 schema。

Tools 的特点：执行型、有副作用、需要参数、有返回值。Tools 是 MCP 最核心的能力，大多数 MCP Server 主要暴露的就是 Tools。

**Resources** 是**可读取的数据**——Agent 通过资源 URI 拉取，Server 返回数据内容（文本、二进制、流）。Resources 解决"Agent 能获取什么信息"的问题，比如读取文件、查看图片、查询配置、获取日志。每个 Resource 有唯一的 URI 标识。

Resources 的特点：只读或受控写、无副作用、按需拉取。Resources 类似文件系统的文件——有路径（URI）、有内容、可以读取。

**Prompts** 是**预定义的提示模板**——Agent 或用户可以显式触发，把模板渲染后注入上下文。Prompts 解决"怎么让 Agent 标准化执行某类任务"的问题，比如"代码审查模板""会议纪要生成模板""特定角色的指令模板"。

Prompts 的特点：可复用、标准化、可参数化。Prompts 类似 IDE 的代码片段（snippet）——预定义结构，按需展开。

三者的关系可以用一个例子说明：一个代码助手 MCP Server 暴露——Tools（执行代码、运行测试、提交代码）、Resources（读取文件、查看 Git 历史、查询 Issue）、Prompts（代码审查模板、PR 描述模板）。Agent 在执行"代码审查"任务时，会读取 Resources（被审查的代码）、调用 Tools（运行测试、查询相关 Issue）、使用 Prompts（套用审查模板组织输出）。

注意，**Tools 和 Resources 的边界有时模糊**。一个"查询天气"的工具既可以做成 Tool（按需调用），也可以做成 Resource（URI 标识为 weather://current?city=xxx）。经验法则是：**有副作用、需要参数执行、结果不固定**的做成 Tool；**只读、有 URI 标识、内容相对稳定**的做成 Resource。

### 关键要点

- Tools 解决"能做什么动作"，Resources 解决"能获取什么信息"，Prompts 解决"怎么标准化执行任务"。
- 三者组合构成完整的 MCP Server 能力。
- Tools 偏执行，Resources 偏读取，Prompts 偏模板。

### 容易踩的坑

- 把所有能力都做成 Tools，忽略 Resources 和 Prompts 的价值。
- 不理解 Tools 和 Resources 的边界。
- 不知道 Prompts 可以参数化。

### 示范话术

> MCP Server 能暴露三种能力。Tools 解决"Agent 能做什么动作"——执行型、有副作用、需要参数，比如发邮件、跑测试、调用 API。Resources 解决"Agent 能获取什么信息"——只读或受控写、按 URI 拉取，比如读文件、查日志、看图片。Prompts 解决"怎么标准化执行任务"——预定义模板，按需展开，比如代码审查模板、会议纪要模板。三者经常组合用——一个代码助手 Server 暴露 Tools（执行代码）、Resources（读取文件）、Prompts（审查模板），Agent 审查代码时读取文件、调用测试、套用模板。讲这一题我会强调经验法则：有副作用、不固定结果的做成 Tools；只读、URI 标识、内容相对稳定的做成 Resources。

---

## 题 4：MCP 和 Function Calling 有什么区别？

### 核心答案

MCP 和 Function Calling 经常被混为一谈，但它们解决的问题在**不同层次**。Function Calling 解决"模型怎么表达要调工具"，MCP 解决"工具怎么接入宿主"。前者是 LLM 层面的能力，后者是工程层面的协议。

**Function Calling** 是 LLM 厂商（OpenAI、Anthropic、Google）提供的原生能力。模型在推理时按预定义 schema 输出结构化的工具调用意图（工具名 + 参数），宿主程序解析这个意图并执行真实工具。Function Calling 是模型和宿主之间的"指令格式约定"。

**MCP** 是工具和宿主之间的"通信协议"。它不规定模型怎么输出（这是 Function Calling 的事），而是规定工具怎么暴露（标准化 schema）、Agent 怎么发现（动态列举）、请求怎么传（消息格式）、结果怎么回（结构化返回）。

两者的关系可以这样理解：**Function Calling 是"语言"，MCP 是"电话系统"**。Function Calling 让模型说出"我要调 send_email 工具，收件人是 xxx"，MCP 让这个请求被正确路由到 send_email 工具所在的 Server，Server 执行完后用标准格式把结果返回。

具体差异有五个维度：

第一，**作用对象不同**。Function Calling 在 LLM 内部生效，决定输出格式；MCP 在 LLM 之外生效，决定工具接入方式。

第二，**解决问题不同**。Function Calling 解决"模型意图结构化"；MCP 解决"工具生态碎片化"。

第三，**依赖关系不同**。Function Calling 是 MCP 的前提——没有 Function Calling，MCP 也没法被 LLM 触发；MCP 不是 Function Calling 的前提——没有 MCP，Function Calling 也能工作（手工适配工具）。

第四，**标准化范围不同**。Function Calling 标准化模型输出；MCP 标准化整个工具生态（发现、描述、调用、返回、安全、审计）。

第五，**生态价值不同**。Function Calling 让单个 LLM 能用工具；MCP 让工具一次开发、多处复用。

**生产里两者是组合关系**：Agent 用 Function Calling 输出工具调用意图，通过 MCP 协议把意图路由到对应 Server，Server 执行后通过 MCP 协议返回结果，Agent 解析后继续推理。

### 关键要点

- Function Calling 是 LLM 层面的能力，MCP 是工程层面的协议。
- 两者是组合关系，不是替代关系。
- Function Calling 让模型"会说"，MCP 让工具"能接"。

### 容易踩的坑

- 把两者混为一谈，统称"工具调用"。
- 不知道 MCP 是 Function Calling 之上的协议层。
- 没意识到没有 Function Calling，MCP 也无法工作。

### 示范话术

> Function Calling 和 MCP 经常被混为一谈，但它们在不同层次。Function Calling 是 LLM 厂商提供的原生能力——模型在推理时按 schema 输出工具调用意图，本质是"模型的语言"。MCP 是工具和宿主之间的通信协议——它不规定模型怎么输出，而是规定工具怎么暴露、Agent 怎么发现、请求怎么传、结果怎么回，本质是"电话系统"。我的类比是：Function Calling 让模型"会说我要调什么工具"，MCP 让这个请求被正确路由到工具所在的 Server 并把结果返回。两者是组合关系：Agent 用 Function Calling 输出意图，通过 MCP 路由到 Server，Server 执行后通过 MCP 返回结果，Agent 解析后继续推理。

---

## 题 5：生产级 MCP Server 要做哪些安全治理？

### 核心答案

生产级 MCP Server 不能只实现协议规范就上线，必须做完整的安全治理。具体包括八个方面。

第一，**权限控制**。每个 Tool 都要明确权限级别——读权限、写权限、删权限、跨用户权限、跨系统权限。Agent 调用 Tool 前必须做权限校验，未授权调用直接拒绝。

第二，**参数校验**。所有 Tool 参数都要做类型、范围、长度、格式校验，避免恶意输入或 LLM 输出错误导致系统异常。比如"删除文件"工具的路径参数必须限制在指定目录内，不能接受任意路径。

第三，**输入净化**。对 LLM 输出的工具参数做敏感信息过滤（API Key、Token、个人隐私）和注入检测。

第四，**输出审计**。Tool 执行结果在返回给 Agent 前要做格式校验、敏感信息脱敏、长度限制。

第五，**超时和重试**。每个 Tool 调用都要有超时控制（避免 Agent 死等）、重试策略（仅对可重试错误）、降级方案（工具不可用时的备选）。

第六，**限流**。限制单位时间内的 Tool 调用次数，防止 Agent 失控循环把下游打爆。

第七，**审计日志**。所有 Tool 调用都要记录：调用者、时间、参数、结果、耗时、错误。这一步是事后排查和合规审计的基础。

第八，**隔离**。高敏感 Tool（删库、发邮件、付款）走独立进程、独立账号、独立网络区域，避免和低敏感 Tool 共用进程导致越权。

**安全治理的核心思想是"零信任"**——假设 Tool 调用一定会出问题，把每一步都加上防护。即使 LLM 被 Prompt 注入、即使参数被污染、即使 Server 被攻击，单点失败也不会导致系统级灾难。

### 关键要点

- 生产级 MCP Server 必须做权限、参数、输入、输出、超时、限流、审计、隔离八项治理。
- 核心思想是"零信任"——假设调用一定会出问题。
- 高敏感 Tool 必须独立进程、独立账号。

### 容易踩的坑

- 只实现协议规范就上线，忽略安全治理。
- Tool 没有参数校验，让恶意输入直达下游。
- 没有审计日志，出问题无法排查。

### 示范话术

> 生产级 MCP Server 不能只实现协议就上线，必须做八项治理：权限控制、参数校验、输入净化、输出审计、超时重试、限流、审计日志、隔离。核心思想是"零信任"——假设 Tool 调用一定会出问题。我举个例子：删除文件 Tool 的路径参数必须限制在指定目录内，不能接受任意路径；高敏感 Tool（删库、发邮件、付款）必须独立进程、独立账号；所有调用必须记审计日志，事后能反查"谁、什么时候、调用了什么、传了什么参数、返回了什么结果"。讲这一题我会强调：MCP 把工具接入标准化了，但安全治理不能省——协议标准化不等于安全标准化。

---

## 题 6：Agent Skills 是什么？它和 Prompt、MCP、Function Calling 的边界是什么？

### 核心答案

Agent Skills 是 Agent 做某类任务时应该遵循的**经验、流程、规范**。它解决的是"Agent 做这类任务时按什么经验和流程执行"的问题。Skills 不是一个具体的技术，而是一类内容的组织形式——通常是 SKILL.md 文件，包含任务说明、流程步骤、注意事项、参考资料。

Skills 和 Prompt、MCP、Function Calling 的边界是：

- **Function Calling** 解决"模型怎么表达要调工具"——是 LLM 层面的输出格式。
- **MCP** 解决"工具怎么接入宿主"——是工程层面的通信协议。
- **Skills** 解决"Agent 做这类任务时按什么经验执行"——是知识层面的执行规范。

三者是**不同层次的组合**。Function Calling 是 LLM 的"嘴和手"，MCP 是工具的"接口标准"，Skills 是 Agent 的"工作经验"。

用一个具体例子说明三者关系。假设 Agent 要执行"为新项目写 README.md"任务：

- Function Calling 让模型输出"调用 create_file 工具，路径是 README.md"——这是模型怎么"说"。
- MCP 把 create_file 工具的请求路由到文件系统 Server——这是工具怎么"接"。
- Skills 提供"写 README 应该包含什么章节、应该用什么语气、应该避免什么错误"——这是 Agent"按什么经验做"。

Skills 的核心价值是**把团队或专家的经验沉淀下来，让 Agent 在做同类任务时直接复用**。没有 Skills，Agent 每次都要从零推理；有了 Skills，Agent 像是"接受过专项训练的工程师"，知道这类任务的标准做法。

Skills 通常以 **SKILL.md 文件**形式存在，包含 YAML front matter（name、description、触发场景）和 Markdown body（任务说明、流程、注意事项）。Skills 可以被 Skill 路由器识别和加载。

### 关键要点

- Skills 解决"按什么经验执行"，Function Calling 解决"怎么调工具"，MCP 解决"工具怎么接入"。
- 三者是不同层次的组合，不是替代。
- Skills 通常以 SKILL.md 文件形式存在，沉淀团队经验。

### 容易踩的坑

- 把 Skills 当成"更复杂的 Prompt"。
- 不知道 Skills、Function Calling、MCP 是不同层次。
- 忽视 Skills 的"经验沉淀"价值。

### 示范话术

> Skills、Prompt、MCP、Function Calling 这四个概念经常被混。我会用一句话概括它们的边界：Function Calling 让模型"会说要调什么工具"；MCP 让工具"能接入宿主"；Skills 让 Agent"按什么经验做任务"；Prompt 是"指令文本"。三者是不同层次的组合。举个例子，Agent 写 README 这个任务：Function Calling 让模型输出"调用 create_file"；MCP 把请求路由到文件 Server；Skills 提供"应该包含什么章节、什么语气、避免什么错误"的经验。讲这一题我会强调：Skills 的核心价值是把团队或专家经验沉淀下来，让 Agent 不必每次从零推理。

---

## 题 7：Skills 为什么要延迟加载？

### 核心答案

Skills 延迟加载（Lazy Loading）是指 Agent 不在每次启动时把全部 Skills 加载到上下文，而是**按当前任务动态发现和加载相关 Skills**。

延迟加载的原因有四个：

第一，**上下文窗口预算有限**。如果 Agent 有几十个 Skills，每个 Skill 几百到几千字，全量加载会迅速占满上下文窗口，留给实际任务的预算所剩无几。

第二，**信号噪声比下降**。大量无关 Skills 在上下文里会干扰模型判断——模型可能在不相关的 Skill 上浪费注意力，导致实际任务表现下降。

第三，**维护成本**。Skills 是会演化的，新 Skills 增加、旧 Skills 修订，如果全量加载，Skills 变化要重新训练或重新评估整个 Agent。

第四，**执行效率**。全量加载 Skills 会显著增加每次 Loop 的 Token 消耗和延迟，Agent 执行慢、成本高。

延迟加载的实现方式通常是**Skill 路由器**。Agent 启动时只加载 Skills 的"索引"（name、description、触发关键词），运行时根据当前任务判断需要哪些 Skills，动态加载完整内容到上下文。

Skill 路由的过程类似 RAG，但目标不同——RAG 召回的是"信息片段"用于回答问题，Skill 路由召回的是"执行规范"用于指导任务。

延迟加载的关键设计点有三个：

第一，**Skills 索引要写好**。name 和 description 必须清晰、准确、有区分度，否则路由器选不对。

第二，**路由触发要精准**。路由器要在正确时机加载正确 Skills，加载太早会浪费 Token，加载太晚会错过关键指导。

第三，**加载粒度要合适**。可以全量加载一个 Skill，也可以只加载某个章节。粒度越细，Token 越省，但路由复杂度越高。

### 关键要点

- 延迟加载避免 Skills 全量注入挤占上下文。
- 实现方式是 Skill 路由器，类似 RAG 但目标不同。
- Skills 索引质量、路由触发精准度、加载粒度是三个关键设计点。

### 容易踩的坑

- 把所有 Skills 全量加载进上下文。
- Skills 索引写得太模糊，路由器选不对。
- 加载粒度太粗，浪费 Token。

### 示范话术

> Skills 延迟加载解决的是上下文窗口预算问题。如果 Agent 有几十个 Skills，每个几百到几千字，全量加载会迅速占满窗口，留给实际任务的预算所剩无几；同时大量无关 Skills 会干扰模型判断。延迟加载的实现方式是 Skill 路由器——Agent 启动时只加载 Skills 索引（name、description、触发关键词），运行时按当前任务动态加载完整内容。这类似 RAG 但目标不同：RAG 召回的是信息片段，Skill 路由召回的是执行规范。讲这一题我会强调三个关键设计点：Skills 索引质量、路由触发精准度、加载粒度。我见过太多团队把 Skills 全量塞进上下文，结果 Agent 越来越慢、Token 成本越来越高、表现反而下降。

---

## 题 8：Skill 路由怎么做？为什么它和 RAG 相似但目标不同？

### 核心答案

Skill 路由的实现通常分三步：**Skills 索引化、查询解析、Skill 召回与加载**。

第一步，**Skills 索引化**。每个 Skill 的 SKILL.md 文件提取元信息（name、description、触发场景、适用任务类型），形成索引。索引可以存在文件系统、数据库或向量数据库里。

第二步，**查询解析**。Agent 拿到当前任务后，提取任务的关键特征——任务类型、目标对象、关键动词、上下文实体。这一步可以用关键词提取、向量嵌入或 LLM 分类。

第三步，**Skill 召回与加载**。用任务特征去匹配 Skills 索引，召回最相关的若干 Skills（通常 1-3 个），把完整 SKILL.md 内容加载到上下文。

Skill 路由和 RAG 确实相似——都是"按相关性从大量候选项中召回若干"。但**目标完全不同**：

- **RAG** 召回的是**信息片段**——目标是为模型提供回答问题的事实依据。召回的内容是"被引用的材料"。
- **Skill 路由** 召回的是**执行规范**——目标是为模型提供完成任务的流程指导。召回的内容是"被遵循的指南"。

具体差异有四个：

第一，**召回内容的角色不同**。RAG 内容是"证据"，模型要"参考它"；Skill 内容是"指令"，模型要"按它做"。

第二，**作用机制不同**。RAG 内容即使漏掉几条，对回答影响有限（模型可以基于已有知识回答）；Skill 内容如果漏掉关键步骤，任务会失败。

第三，**匹配精度要求不同**。RAG 可以容许一定噪声（多条相似片段中选几条）；Skill 路由对精度要求高，召回错误的 Skill 会误导任务。

第四，**加载粒度不同**。RAG 召回的是文档片段，可以按段落切分；Skill 路由通常要加载完整 Skill（流程不能拆），或者精确切到章节。

所以虽然技术实现相似，但设计 Skill 路由时不能用 RAG 的思路简单套用——Skill 路由要更注重"召回精度"和"完整性"。

### 关键要点

- Skill 路由分索引化、查询解析、召回加载三步。
- 它和 RAG 相似但目标不同——RAG 召回信息片段，Skill 路由召回执行规范。
- Skill 路由对召回精度和完整性要求更高。

### 容易踩的坑

- 用 RAG 的设计思路直接套 Skill 路由，忽略精度要求差异。
- Skill 召回粒度太粗，把不相关的 Skills 也加载进来。
- 召回错误的 Skill，让任务走偏。

### 示范话术

> Skill 路由分三步：Skills 索引化、查询解析、Skill 召回与加载。它和 RAG 确实相似——都是按相关性从大量候选项中召回若干。但目标完全不同：RAG 召回的是信息片段，目标是为模型提供回答问题的事实依据，召回内容是"被引用的材料"；Skill 路由召回的是执行规范，目标是为模型提供完成任务的流程指导，召回内容是"被遵循的指南"。具体差异有四点：RAG 内容是"证据"模型参考它，Skill 内容是"指令"模型按它做；RAG 容许一定噪声，Skill 漏掉关键步骤任务就失败；RAG 召回粒度可以很细按段落切分，Skill 通常要完整加载。讲这一题我会强调：Skill 路由对召回精度和完整性要求比 RAG 高，不能用 RAG 思路简单套用。

---

## 题 9：写一个 SKILL.md 最容易踩哪些坑？

### 核心答案

写一个高质量的 SKILL.md 是个手艺活。常见的坑至少有八个。

第一，**触发场景写得太模糊**。"这个 Skill 用于代码相关任务"这种描述等于没说。路由器根本判断不了什么时候该加载。应该写成"当用户要求 Review PR、提交代码、修复 CI 失败时加载"。

第二，**流程步骤写得太抽象**。"先分析问题，再写代码"——这种步骤模型自己也会做，Skill 没价值。应该写到"第一步：git fetch origin；第二步：git diff origin/main；第三步：用 rg 搜索 TODO 标记"这种具体粒度。

第三，**缺少反面案例**。只写"应该怎么做"，不写"不应该怎么做"。模型遇到边界情况会绕开 Skill 走自己的路径。要明确列出常见错误、应该避免的做法、危险信号。

第四，**缺少示例**。抽象描述再清楚也不如有示例。SKILL.md 至少要有 1-2 个"完整任务示例"——从用户输入到最终输出的完整流程。

第五，**过度复杂**。一个 Skill 塞太多内容，写成长篇大论。模型读不完也记不住，反而干扰。原则是"一个 Skill 解决一类任务"，多任务就拆多个 Skills。

第六，**缺少可验证的产出标准**。没有写"什么算完成"，模型不知道什么时候该停。应该明确"完成后必须包含 X、Y、Z 三项""长度控制在 N 字以内"。

第七，**没有版本管理**。Skill 修改后没有 changelog、不知道哪个版本好、不知道什么时候改坏了。应该走 Git，每个 Skill 有版本号和变更记录。

第八，**YAML front matter 不规范**。name、description 字段缺失或格式错误，路由器读不到。YAML 必须严格符合规范，引号、缩进、字段名都不能错。

### 关键要点

- SKILL.md 的核心是"可被路由器准确发现、可被模型准确执行"。
- 触发场景要具体、流程步骤要可操作、要包含反面案例和示例。
- 简洁比全面更重要——一个 Skill 解决一类任务。

### 容易踩的坑

- 触发场景太模糊，路由器加载不对。
- 流程步骤抽象，等于没写。
- 没有反面案例和示例，模型遇到边界绕开 Skill。
- 缺少版本管理，Skill 演化失控。

### 示范话术

> 写 SKILL.md 最容易踩的坑有八个：触发场景太模糊、流程步骤太抽象、缺少反面案例、缺少示例、过度复杂、缺少可验证产出标准、没有版本管理、YAML front matter 不规范。讲这一题我会强调几个关键点：触发场景要写到"用户做什么动作时加载"这种粒度，路由器才能识别；流程步骤要写到"第一步 git fetch、第二步 git diff"这种具体粒度，模型才能照做；必须有反面案例，模型遇到边界才知道不绕开；必须可验证产出标准，模型才知道什么时候停；一个 Skill 解决一类任务，多任务就拆多个。我见过太多 SKILL.md 写成长篇大论，结果模型读不完，路由也加载不对，反而把任务做坏。好的 SKILL.md 是"少而精"，不是"大而全"。

---

## 小结

MCP 与 Agent Skills 这 9 道题，本质在考三件事：

第一，**工具生态的层次划分**。Function Calling（模型怎么"说"）、MCP（工具怎么"接"）、Skills（Agent 按什么"经验"做）是三个不同层次。

第二，**MCP 的核心价值**。标准化工具接入，一次开发、多处复用，类似 AI 领域的 USB-C。

第三，**Skills 的工程实践**。延迟加载、Skill 路由、SKILL.md 写作规范是落地关键。

回答时抓住一句话：**Function Calling 是嘴和手，MCP 是电话系统，Skills 是工作经验**。把三者讲清楚，面试官就能看出你对 Agent 工具生态的完整理解。
