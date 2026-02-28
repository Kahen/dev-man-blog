---
description: '适用于 GitHub Copilot 的通用代码审查指令模板，可按项目自定义'
applyTo: '**'
excludeAgent: ["coding-agent"]
---

# 通用代码审查指令（可按项目自定义）

这是一份可适配任意项目的代码审查指南。指令遵循提示工程最佳实践，提供代码质量、安全性、测试和架构审查的结构化方法。

## 审查语言

执行代码审查时，请使用**中文**回复（也可改为你偏好的语言）。

> **自定义提示**：可将“中文”替换为“English”“Portuguese (Brazilian)”“Spanish”“French”等语言。

## 审查优先级

执行代码审查时，请按以下顺序给出问题：

### 🔴 CRITICAL（阻止合并）
- **安全性**：漏洞、密钥暴露、认证/鉴权问题
- **正确性**：逻辑错误、数据损坏风险、竞态条件
- **破坏性变更**：未做版本化的 API 契约变更
- **数据丢失**：可能导致数据丢失或损坏的风险

### 🟡 IMPORTANT（需要讨论）
- **代码质量**：严重违反 SOLID、重复代码过多
- **测试覆盖**：关键路径或新增功能缺失测试
- **性能**：明显性能瓶颈（N+1 查询、内存泄漏）
- **架构**：显著偏离既有架构模式

### 🟢 SUGGESTION（非阻塞建议）
- **可读性**：命名不佳、逻辑复杂可简化
- **优化**：不影响功能的性能优化建议
- **最佳实践**：轻微偏离团队约定
- **文档**：注释/文档不完整或缺失

## 通用审查原则

执行代码审查时，请遵循以下原则：

1. **具体明确**：引用精确文件和行号，并给出具体例子
2. **说明上下文**：解释为什么是问题，以及潜在影响
3. **提供方案**：可行时给出修正代码，而不仅指出问题
4. **建设性表达**：聚焦改进代码，不针对作者
5. **认可亮点**：指出写得好的地方和优秀设计
6. **务实取舍**：并非所有建议都必须立即落地
7. **合并同类项**：避免对同一问题重复评论

## 代码质量标准

执行代码审查时，请检查：

### Clean Code
- 变量、函数、类命名语义清晰
- 单一职责原则：每个函数/类做好一件事
- DRY（不重复自己）：避免重复代码
- 函数保持小而聚焦（理想情况下 < 20~30 行）
- 避免过深嵌套（最多 3~4 层）
- 避免魔法数字/字符串（使用常量）
- 代码优先自解释，必要时再加注释

### 示例
```javascript
// ❌ 不佳：命名模糊 + 魔法数字
function calc(x, y) {
    if (x > 100) return y * 0.15;
    return y * 0.10;
}

// ✅ 更佳：命名清晰 + 常量化
const PREMIUM_THRESHOLD = 100;
const PREMIUM_DISCOUNT_RATE = 0.15;
const STANDARD_DISCOUNT_RATE = 0.10;

function calculateDiscount(orderTotal, itemPrice) {
    const isPremiumOrder = orderTotal > PREMIUM_THRESHOLD;
    const discountRate = isPremiumOrder ? PREMIUM_DISCOUNT_RATE : STANDARD_DISCOUNT_RATE;
    return itemPrice * discountRate;
}
```

### 错误处理
- 在合适层级处理错误
- 提供有意义的错误信息
- 不要静默失败或吞异常
- 快速失败：尽早做输入校验
- 使用合适的错误类型/异常类型

### 示例
```python
# ❌ 不佳：静默失败 + 兜底异常
def process_user(user_id):
    try:
        user = db.get(user_id)
        user.process()
    except:
        pass

# ✅ 更佳：显式处理异常
def process_user(user_id):
    if not user_id or user_id <= 0:
        raise ValueError(f"Invalid user_id: {user_id}")

    try:
        user = db.get(user_id)
    except UserNotFoundError:
        raise UserNotFoundError(f"User {user_id} not found in database")
    except DatabaseError as e:
        raise ProcessingError(f"Failed to retrieve user {user_id}: {e}")

    return user.process()
```

## 安全审查

执行代码审查时，请重点检查：

- **敏感数据**：代码或日志中不得出现密码、API Key、Token、PII
- **输入校验**：所有用户输入都应校验与清洗
- **SQL 注入**：使用参数化查询，禁止字符串拼接 SQL
- **认证**：访问资源前进行正确认证检查
- **鉴权**：校验用户是否拥有操作权限
- **密码学**：使用成熟库，不自行实现加密算法
- **依赖安全**：检查依赖是否存在已知漏洞

### 示例
```java
// ❌ 不佳：SQL 注入风险
String query = "SELECT * FROM users WHERE email = '" + email + "'";

// ✅ 更佳：参数化查询
PreparedStatement stmt = conn.prepareStatement(
    "SELECT * FROM users WHERE email = ?"
);
stmt.setString(1, email);
```

```javascript
// ❌ 不佳：密钥硬编码
const API_KEY = "sk_live_abc123xyz789";

// ✅ 更佳：使用环境变量
const API_KEY = process.env.API_KEY;
```

## 测试标准

执行代码审查时，请验证测试质量：

- **覆盖率**：关键路径与新增功能必须有测试
- **测试命名**：名称应清楚表达测试意图
- **测试结构**：采用 Arrange-Act-Assert 或 Given-When-Then
- **独立性**：测试之间不应互相依赖
- **断言**：使用具体断言，避免宽泛断言
- **边界场景**：覆盖边界值、null、空集合等情况
- **合理 Mock**：Mock 外部依赖，不 Mock 核心领域逻辑

### 示例
```typescript
// ❌ 不佳：名称与断言都过于模糊
test('test1', () => {
    const result = calc(5, 10);
    expect(result).toBeTruthy();
});

// ✅ 更佳：描述清晰 + 断言明确
test('should calculate 10% discount for orders under $100', () => {
    const orderTotal = 50;
    const itemPrice = 20;

    const discount = calculateDiscount(orderTotal, itemPrice);

    expect(discount).toBe(2.00);
});
```

## 性能考量

执行代码审查时，请检查性能问题：

- **数据库查询**：避免 N+1，使用合适索引
- **算法复杂度**：时间/空间复杂度符合场景需求
- **缓存**：对高成本/高频操作使用缓存
- **资源管理**：正确释放连接、文件、流等资源
- **分页**：大结果集必须分页
- **懒加载**：按需加载数据

### 示例
```python
# ❌ 不佳：N+1 查询
users = User.query.all()
for user in users:
    orders = Order.query.filter_by(user_id=user.id).all()  # N+1!

# ✅ 更佳：JOIN 或预加载
users = User.query.options(joinedload(User.orders)).all()
for user in users:
    orders = user.orders
```

## 架构与设计

执行代码审查时，请验证：

- **关注点分离**：层与模块边界清晰
- **依赖方向**：高层模块不依赖底层实现细节
- **接口隔离**：优先小而专注的接口
- **低耦合**：组件应易于独立测试
- **高内聚**：相关功能应聚合在一起
- **模式一致性**：遵循代码库既有模式

## 文档标准

执行代码审查时，请检查文档：

- **API 文档**：公共 API 需包含用途、参数、返回值
- **复杂逻辑**：不直观逻辑需补充解释
- **README 更新**：新增功能或改动需同步文档
- **破坏性变更**：需明确记录
- **示例**：复杂功能应提供使用示例

## 评论格式模板

执行代码审查时，请使用以下评论格式：

```markdown
**[PRIORITY] Category: Brief title**

Detailed description of the issue or suggestion.

**Why this matters:**
Explanation of the impact or reason for the suggestion.

**Suggested fix:**
[code example if applicable]

**Reference:** [link to relevant documentation or standard]
```

### 评论示例

#### Critical Issue
````markdown
**🔴 CRITICAL - Security: SQL Injection Vulnerability**

The query on line 45 concatenates user input directly into the SQL string,
creating a SQL injection vulnerability.

**Why this matters:**
An attacker could manipulate the email parameter to execute arbitrary SQL commands,
potentially exposing or deleting all database data.

**Suggested fix:**
```sql
-- Instead of:
query = "SELECT * FROM users WHERE email = '" + email + "'"

-- Use:
PreparedStatement stmt = conn.prepareStatement(
    "SELECT * FROM users WHERE email = ?"
);
stmt.setString(1, email);
```

**Reference:** OWASP SQL Injection Prevention Cheat Sheet
````

#### Important Issue
````markdown
**🟡 IMPORTANT - Testing: Missing test coverage for critical path**

The `processPayment()` function handles financial transactions but has no tests
for the refund scenario.

**Why this matters:**
Refunds involve money movement and should be thoroughly tested to prevent
financial errors or data inconsistencies.

**Suggested fix:**
Add test case:
```javascript
test('should process full refund when order is cancelled', () => {
    const order = createOrder({ total: 100, status: 'cancelled' });

    const result = processPayment(order, { type: 'refund' });

    expect(result.refundAmount).toBe(100);
    expect(result.status).toBe('refunded');
});
```
````

#### Suggestion
````markdown
**🟢 SUGGESTION - Readability: Simplify nested conditionals**

The nested if statements on lines 30-40 make the logic hard to follow.

**Why this matters:**
Simpler code is easier to maintain, debug, and test.

**Suggested fix:**
```javascript
// Instead of nested ifs:
if (user) {
    if (user.isActive) {
        if (user.hasPermission('write')) {
            // do something
        }
    }
}

// Consider guard clauses:
if (!user || !user.isActive || !user.hasPermission('write')) {
    return;
}
// do something
```
````

## 审查检查清单

执行代码审查时，请系统性核对：

### 代码质量
- [ ] 代码风格与约定一致
- [ ] 命名清晰，符合规范
- [ ] 函数/方法小而聚焦
- [ ] 无重复代码
- [ ] 复杂逻辑已拆解
- [ ] 错误处理合理
- [ ] 无注释掉代码或无工单 TODO

### 安全性
- [ ] 代码与日志中无敏感信息
- [ ] 所有用户输入都有校验
- [ ] 无 SQL 注入风险
- [ ] 认证与鉴权实现正确
- [ ] 依赖版本安全且可控

### 测试
- [ ] 新代码具备合理测试覆盖
- [ ] 测试命名清晰、职责单一
- [ ] 覆盖边界和错误场景
- [ ] 测试独立且可重复执行
- [ ] 无“永远通过”或被注释的测试

### 性能
- [ ] 无明显性能问题（N+1、内存泄漏）
- [ ] 缓存使用合理
- [ ] 算法与数据结构选择合适
- [ ] 资源释放正确

### 架构
- [ ] 遵循既有模式与约定
- [ ] 关注点分离明确
- [ ] 无明显架构违例
- [ ] 依赖方向正确

### 文档
- [ ] 公共 API 已文档化
- [ ] 复杂逻辑有必要说明
- [ ] README 已按需更新
- [ ] 破坏性变更已记录

## 项目级自定义建议

你可以按项目补充以下章节：

1. **语言/框架专项检查**
   - 示例：“代码审查时，验证 React Hooks 是否遵循 Hooks 规则”
   - 示例：“代码审查时，检查 Spring Boot Controller 注解是否规范”

2. **构建与部署**
   - 示例：“代码审查时，验证 CI/CD 流水线配置是否正确”
   - 示例：“代码审查时，检查数据库迁移是否可回滚”

3. **业务规则**
   - 示例：“代码审查时，验证价格计算是否包含全部税费规则”
   - 示例：“代码审查时，检查数据处理前是否获得用户同意”

4. **团队约定**
   - 示例：“代码审查时，验证提交信息是否符合 Conventional Commits”
   - 示例：“代码审查时，检查分支命名是否符合 type/ticket-description”

## 参考资源

关于高质量代码审查与 GitHub Copilot 自定义，参考：

- [GitHub Copilot Prompt Engineering](https://docs.github.com/en/copilot/concepts/prompting/prompt-engineering)
- [GitHub Copilot Custom Instructions](https://code.visualstudio.com/docs/copilot/customization/custom-instructions)
- [Awesome GitHub Copilot Repository](https://github.com/github/awesome-copilot)
- [GitHub Code Review Guidelines](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests)
- [Google Engineering Practices - Code Review](https://google.github.io/eng-practices/review/)
- [OWASP Security Guidelines](https://owasp.org/)

## 提示工程建议

执行代码审查时，请应用以下提示工程原则：

1. **先总后细**：先看架构，再看实现细节
2. **给出示例**：建议修改时引用代码库中的相似实现
3. **拆分复杂任务**：大 PR 按模块分段审查（安全 → 测试 → 逻辑 → 风格）
4. **避免模糊表达**：明确指出具体文件、位置与问题
5. **标注关联代码**：指出可能受影响的相关模块
6. **迭代复审**：首次审查后可用更聚焦的问题二次审查

## 项目上下文

这是通用模板，请按你的项目补充以下信息：

- **技术栈**：[例如 Java 17, Spring Boot 3.x, PostgreSQL]
- **架构**：[例如 Hexagonal/Clean Architecture, Microservices]
- **构建工具**：[例如 Gradle, Maven, npm, pip]
- **测试框架**：[例如 JUnit 5, Jest, pytest]
- **代码规范**：[例如 follows Google Style Guide]
