---
title: 接口幂等方案总结：从理论到生产落地
description: 一文梳理接口幂等的核心概念、六种主流实现方案（Token 机制、唯一约束、Redis 去重、状态机、乐观锁、消息去重），并附 Kotlin 落地代码与生产上线清单。
published: 2026-05-18
tags: [幂等, 后端, 分布式, Redis, API 设计]
category: Guides
---

做后端开发，大概率遇到过这类事故：

- 用户连续点击两次"支付"，扣了两笔钱
- 网络超时重试，订单被创建了两条
- MQ 消费者重启，同一条消息被处理了两遍
- 回调接口重复通知，业务状态被错误覆盖

这些问题的根源都指向同一个词：**幂等性**。

这篇文章给你一份完整的幂等方案总结，从概念澄清到六种主流实现方式，再到常见坑和一份可执行的上线清单。

---

## 什么是幂等

一句话：**同一个请求，执行一次和执行多次，对系统状态的影响完全相同。**

严格来说，幂等要求：

- 第一次调用：正常执行，产生预期结果
- 第 N 次调用（N > 1）：系统状态不变，返回与第一次相同或合理的响应

注意，幂等不等于"不执行"。重复请求到达时，系统应该识别出"这个已经处理过了"，然后返回之前的结果，而不是重新执行一次业务逻辑。

### 哪些接口需要幂等

不是所有接口都需要幂等。GET、PUT、DELETE 在 HTTP 语义上天然是幂等的（或应该设计成幂等的），真正需要重点关注的是：

- **POST 类写入接口**：创建订单、发起支付、提交表单
- **回调/通知接口**：第三方支付回调、物流状态推送
- **MQ 消费逻辑**：消息至少投递一次（at-least-once）场景
- **重试场景下有副作用的接口**：任何会被框架或调用方自动重试的接口

> 一个判断标准：如果这个接口被重复调用，会不会产生重复数据、重复扣款、重复发券？如果会，就需要幂等。

---

## 方案一：Token 机制（防重提交令牌）

这是最经典、也是最适合"用户主动提交"场景的方案。

### 原理

1. 客户端在进入操作页面前，先向服务端申请一个唯一 Token
2. 服务端生成 Token 并存入 Redis（或 DB），设置过期时间
3. 客户端提交请求时携带该 Token
4. 服务端收到请求后，尝试删除 Redis 中的 Token：
   - 删除成功 → 说明是第一次请求，正常执行业务
   - 删除失败（已不存在）→ 说明是重复请求，直接返回

核心在于"**获取并删除**"这一步必须是原子操作，否则会有并发问题。

### Redis Lua 实现

```lua
-- KEYS[1]: token key
-- ARGV[1]: expected token value
-- 返回: 1 = 获取成功（首次），0 = token 已失效（重复请求）
if redis.call('get', KEYS[1]) == ARGV[1] then
    redis.call('del', KEYS[1])
    return 1
else
    return 0
end
```

### Kotlin 实现

```kotlin
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Component
import java.util.UUID
import java.util.concurrent.TimeUnit

@Component
class IdempotentTokenService(
    private val redisTemplate: StringRedisTemplate
) {
    companion object {
        private const val TOKEN_PREFIX = "idempotent:token:"
        private const val TOKEN_EXPIRE_MINUTES = 10L

        private val CHECK_AND_DELETE_SCRIPT = """
            if redis.call('get', KEYS[1]) == ARGV[1] then
                return redis.call('del', KEYS[1])
            else
                return 0
            end
        """.trimIndent()
    }

    /** 生成 Token，返回给客户端 */
    fun createToken(bizType: String): String {
        val token = UUID.randomUUID().toString()
        val key = "$TOKEN_PREFIX$bizType:$token"
        redisTemplate.opsForValue().set(key, "1", TOKEN_EXPIRE_MINUTES, TimeUnit.MINUTES)
        return token
    }

    /** 校验并消费 Token，返回 true 表示首次请求 */
    fun checkAndConsume(bizType: String, token: String): Boolean {
        val key = "$TOKEN_PREFIX$bizType:$token"
        val result = redisTemplate.execute(
            org.springframework.scripting.support.ResourceScriptSource(
                org.springframework.core.io.ClassPathResource("scripts/idempotent.lua")
            ),
            listOf(key),
            token
        )
        return result == 1L
    }
}
```

### 适用场景

- 用户表单提交（防止重复点击）
- 支付发起（防重扣款）
- 任何由客户端主动触发的写操作

### 注意点

- Token 要有合理的过期时间，不能无限有效
- Token 必须绑定业务维度，不能全局复用
- 生成 Token 和校验 Token 必须是原子操作

---

## 方案二：数据库唯一约束

最朴素、最可靠的兜底方案。即使上层所有防护全部失效，数据库唯一索引仍然是最后一道防线。

### 原理

在数据库表上为"业务幂等键"建立唯一索引。当重复数据插入时，数据库直接抛唯一键冲突异常，业务层捕获后返回"重复请求"。

### 常见的幂等键设计

| 场景 | 幂等键 | 说明 |
| --- | --- | --- |
| 创建订单 | 业务请求号 `request_id` | 由调用方生成，保证全局唯一 |
| 支付回调 | 第三方交易号 `trade_no` | 支付平台保证唯一 |
| 用户注册 | 手机号 / 邮箱 | 天然唯一标识 |
| 批量导入 | `批次号 + 行号` | 组合唯一 |

### Kotlin + JPA 示例

```kotlin
@Entity
@Table(
    name = "t_order",
    indexes = [Index(name = "uk_request_id", columnList = "requestId", unique = true)]
)
class Order(
    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    val id: Long = 0,

    @Column(nullable = false, unique = true, length = 64)
    val requestId: String,

    @Column(nullable = false)
    val userId: Long,

    @Column(nullable = false)
    val amount: BigDecimal,

    @Column(nullable = false, length = 20)
    var status: String = "CREATED"
)

@Service
class OrderService(private val orderRepo: OrderRepository) {

    fun createOrder(userId: Long, amount: BigDecimal, requestId: String): Order {
        // 先查询是否已存在（提升体验，避免直接抛异常）
        val existing = orderRepo.findByRequestId(requestId)
        if (existing != null) {
            return existing
        }

        return try {
            orderRepo.save(Order(requestId = requestId, userId = userId, amount = amount))
        } catch (e: DataIntegrityViolationException) {
            // 并发场景下，另一个请求先插入了，这里兜底返回
            orderRepo.findByRequestId(requestId)
                ?: throw IllegalStateException("订单创建异常，请重试")
        }
    }
}
```

### 适用场景

- 所有"插入"类操作的兜底防护
- 支付回调去重
- 批量导入去重

> 唯一约束是最强的幂等保障，但它只能防止"重复插入"，对于"重复更新"场景（如重复修改状态），需要结合状态机或乐观锁。

---

## 方案三：Redis 去重（SET NX）

适合高并发场景，用 Redis 做前置拦截，避免重复请求穿透到数据库。

### 原理

请求到达时，用业务幂等键作为 Redis key，执行 `SET key value NX EX ttl`：

- 设置成功（key 不存在）→ 首次请求，执行业务
- 设置失败（key 已存在）→ 重复请求，直接返回

### Kotlin 实现

```kotlin
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.stereotype.Component
import java.util.concurrent.TimeUnit

@Component
class RedisIdempotentService(
    private val redisTemplate: StringRedisTemplate
) {
    companion object {
        private const val KEY_PREFIX = "idempotent:dedup:"
        private const val EXPIRE_SECONDS = 3600L  // 1 小时过期
    }

    /**
     * 尝试标记请求，返回 true 表示首次请求
     * @param bizType   业务类型，如 "order_create"
     * @param bizKey    业务幂等键，如 requestId
     */
    fun tryAcquire(bizType: String, bizKey: String): Boolean {
        val key = "$KEY_PREFIX$bizType:$bizKey"
        return redisTemplate.opsForValue()
            .setIfAbsent(key, "1", EXPIRE_SECONDS, TimeUnit.SECONDS) == true
    }
}
```

在业务层使用：

```kotlin
@Service
class PaymentService(
    private val redisIdempotent: RedisIdempotentService,
    private val orderRepo: OrderRepository
) {
    fun processPayment(orderId: Long, requestId: String): PaymentResult {
        // 前置去重
        if (!redisIdempotent.tryAcquire("payment", requestId)) {
            // 已处理过，查询并返回之前的结果
            return orderRepo.findByRequestId(requestId)
                ?.let { PaymentResult.alreadyProcessed(it) }
                ?: PaymentResult.duplicate()
        }

        return try {
            // 执行业务逻辑
            doPayment(orderId)
        } catch (e: Exception) {
            // 业务失败时，删除去重标记，允许重试
            redisIdempotent.release("payment", requestId)
            throw e
        }
    }
}
```

### 适用场景

- 高并发写入的前置拦截
- 回调通知去重
- 分布式环境下的全局去重

### 注意点

- 过期时间要合理：太短可能误放行重试请求，太长会浪费内存
- 业务失败时要考虑是否释放标记（允许重试还是不允许重试，需要按业务场景决定）
- Redis 故障时要有降级策略（如降级到数据库唯一约束）

---

## 方案四：状态机

适合"更新"类操作，特别是订单、工单等有明确生命周期的业务对象。

### 原理

为业务对象定义明确的状态流转规则。每次更新时，用"当前状态 + 目标状态"作为更新条件。如果当前状态不满足，更新影响行数为 0，视为重复或非法操作。

### SQL 核心

```sql
UPDATE t_order
SET status = 'PAID', paid_at = NOW()
WHERE order_id = #{orderId} AND status = 'CREATED'
```

如果返回 affected rows = 0，说明订单已经不在 CREATED 状态，要么已支付（重复回调），要么已取消（非法操作）。

### Kotlin 实现

```kotlin
enum class OrderStatus(val code: String) {
    CREATED("CREATED"),
    PAID("PAID"),
    SHIPPED("SHIPPED"),
    COMPLETED("COMPLETED"),
    CANCELLED("CANCELLED");

    /** 定义合法的状态流转 */
    fun canTransitionTo(target: OrderStatus): Boolean = when (this) {
        CREATED  -> target in setOf(PAID, CANCELLED)
        PAID     -> target in setOf(SHIPPED, CANCELLED)
        SHIPPED  -> target == COMPLETED
        else     -> false
    }
}

@Repository
class OrderRepository(private val jdbcTemplate: JdbcTemplate) {

    fun updateStatus(orderId: Long, from: OrderStatus, to: OrderStatus): Boolean {
        val affected = jdbcTemplate.update("""
            UPDATE t_order
            SET status = ?, updated_at = NOW()
            WHERE order_id = ? AND status = ?
        """, to.code, orderId, from.code)
        return affected > 0
    }
}

@Service
class OrderStatusService(private val orderRepo: OrderRepository) {

    fun payOrder(orderId: Long): PayResult {
        val success = orderRepo.updateStatus(orderId, OrderStatus.CREATED, OrderStatus.PAID)
        return if (success) {
            PayResult.success("支付成功")
        } else {
            // 已经不在 CREATED 状态，查询当前状态返回
            val current = orderRepo.findById(orderId)?.status
            PayResult.alreadyHandled("订单当前状态: $current")
        }
    }
}
```

### 适用场景

- 订单状态流转（创建 → 支付 → 发货 → 完成）
- 工单审批流程
- 任何有明确生命周期的业务对象

> 状态机的核心价值不只是幂等，更是"业务规则的显式化"。当状态流转规则写在代码里而不是散落在各个接口中时，系统的可维护性会显著提升。

---

## 方案五：乐观锁（版本号）

适合"更新"类操作中需要防止并发覆盖的场景。

### 原理

为每条记录维护一个版本号（version）。更新时在 WHERE 条件中带上当前版本号，并将版本号 +1。如果版本号已被其他请求修改，更新影响行数为 0。

### SQL 核心

```sql
UPDATE t_account
SET balance = balance - #{amount}, version = version + 1
WHERE user_id = #{userId} AND version = #{currentVersion}
```

### Kotlin 实现

```kotlin
@Repository
class AccountRepository(private val jdbcTemplate: JdbcTemplate) {

    fun deductBalance(userId: Long, amount: BigDecimal, expectedVersion: Int): Boolean {
        val affected = jdbcTemplate.update("""
            UPDATE t_account
            SET balance = balance - ?, version = version + 1, updated_at = NOW()
            WHERE user_id = ? AND version = ? AND balance >= ?
        """, amount, userId, expectedVersion, amount)
        return affected > 0
    }
}
```

### 与状态机的区别

乐观锁和状态机都是"条件更新"思路，但侧重点不同：

- **状态机**：关注业务状态是否允许变更（CREATED → PAID）
- **乐观锁**：关注数据版本是否未被并发修改（version = 3 → version = 4）

两者可以组合使用：WHERE 条件同时带状态和版本号，既保证幂等，又防止并发覆盖。

---

## 方案六：消息去重（MQ 场景）

MQ 消费者面临的是"至少投递一次"（at-least-once）语义，消息重复几乎不可避免。

### 原理

消费端在处理消息前，先检查该消息的唯一标识（如 messageId）是否已处理过。常见做法：

1. **Redis SET NX**：与方案三类似，用 messageId 作为 key
2. **去重表**：将已处理的 messageId 插入数据库唯一索引表
3. **Redis + DB 双重保障**：Redis 做快速拦截，DB 做持久化兜底

### Kotlin + Redis 实现

```kotlin
@Component
class OrderMessageConsumer(
    private val redisTemplate: StringRedisTemplate,
    private val orderService: OrderService
) {
    companion object {
        private const val DEDUP_KEY_PREFIX = "mq:dedup:order:"
        private const val DEDUP_EXPIRE_HOURS = 24L
    }

    fun handleMessage(message: OrderMessage) {
        val dedupKey = "$DEDUP_KEY_PREFIX${message.messageId}"

        // 幂等校验：SET NX
        val isNew = redisTemplate.opsForValue()
            .setIfAbsent(dedupKey, "1", DEDUP_EXPIRE_HOURS, TimeUnit.HOURS)

        if (isNew != true) {
            // 已处理过，跳过
            return
        }

        try {
            orderService.processOrderMessage(message)
        } catch (e: Exception) {
            // 处理失败，删除去重标记，允许 MQ 重试
            redisTemplate.delete(dedupKey)
            throw e
        }
    }
}
```

### 注意点

- 消息去重窗口要覆盖最大重试周期（例如 24 小时）
- 如果 Redis 和业务处理之间发生异常，需要有补偿机制（如定时任务扫描去重表）
- 去重 key 的过期时间不能太短，否则 MQ 延迟重投时可能被误放过

---

## 方案选型：什么时候用什么

不同方案各有适用边界，下面是我在实际项目中的经验总结：

| 方案 | 最佳场景 | 优势 | 局限 |
| --- | --- | --- | --- |
| Token 机制 | 用户主动提交（表单、支付） | 用户体验好，前置拦截 | 需要客户端配合 |
| 唯一约束 | 插入类操作兜底 | 最强保障，不依赖外部组件 | 只防插入，不防更新 |
| Redis SET NX | 高并发前置拦截 | 性能好，分布式友好 | 依赖 Redis 可用性 |
| 状态机 | 有生命周期的业务对象 | 业务规则显式化 | 需要提前定义完整状态 |
| 乐观锁 | 并发更新防覆盖 | 实现简单 | 冲突频繁时重试成本高 |
| 消息去重 | MQ 消费幂等 | 与消息中间件解耦 | 需要维护去重存储 |

实际项目中，**很少只用单一方案**。更常见的做法是分层组合：

1. **前置拦截**：Token 机制或 Redis SET NX，在请求入口快速过滤重复
2. **业务层保障**：状态机或乐观锁，保证业务逻辑的幂等
3. **兜底层保障**：数据库唯一约束，作为最后防线

> 分层防护的核心思想是：不把所有赌注押在单一机制上。每一层各自拦截一部分重复请求，层层递减，最终到达数据库的重复写入趋近于零。

---

## 常见坑（我见过最多的 6 个）

### 1. 把"不报错"当成幂等

重复请求返回 200 不代表幂等成功。如果第二次请求又扣了一次款，只是返回了相同的状态码，那不叫幂等，那叫"静默重复执行"。

幂等的判断标准是**系统状态不变**，不是响应码不变。

### 2. 幂等键设计不合理

幂等键的粒度很关键：

- 太粗（如只用 userId）：同一用户的不同请求被误判为重复
- 太细（如 userId + timestamp）：时间戳不同导致真正的重复请求无法拦截
- 正确做法：使用由调用方生成的全局唯一业务请求号（requestId / 业务流水号）

### 3. Redis 去重和业务执行之间没有原子性保证

```
// 错误示例：先去重再执行，中间如果宕机，去重标记在但业务没执行
redis.setIfAbsent(key, "1")  // 成功
// ← 这里服务宕机了
doBusiness()                   // 没执行
```

解决方案：

- 业务执行失败时删除去重标记（允许重试）
- 或使用 Redis + DB 双重保障（DB 做最终一致性校验）

### 4. 忘记处理"重复请求的返回值"

很多同学实现了去重逻辑，但重复请求到达时返回了空或错误码。正确做法是：**返回与第一次请求相同的结果**。这意味着你需要持久化第一次请求的结果，或者至少记录其状态。

### 5. 回调接口没有幂等处理

第三方支付回调、物流状态推送这类接口，重复通知是常态。很多同学只在主动调用时做幂等，却忘了回调接口同样需要。

```kotlin
// 支付回调必须幂等
@PostMapping("/callback/payment")
fun handlePaymentCallback(@RequestBody callback: PaymentCallback): Response {
    // 即使是回调，也要走幂等逻辑
    if (!idempotentService.tryAcquire("pay_callback", callback.tradeNo)) {
        return Response.success("已处理")
    }
    orderService.confirmPayment(callback)
    return Response.success("处理成功")
}
```

### 6. 测试只测正常流程，不测重复场景

上线前至少要验证：

- 同一请求快速连续发送两次
- 业务执行中途失败后重试
- MQ 消息重复消费
- 并发场景下的竞态条件

---

## 一份可执行的上线清单

上线前请至少确认：

- [ ] 已识别哪些接口需要幂等，并明确幂等键的设计
- [ ] 幂等键粒度合理，能区分"不同业务请求"和"同一请求的重复调用"
- [ ] 前置拦截层（Token 或 Redis）已接入，过期时间合理
- [ ] 数据库唯一索引已建立，作为最终兜底
- [ ] 重复请求的返回值与首次请求一致（或返回明确的"已处理"标识）
- [ ] 回调/通知接口已纳入幂等防护范围
- [ ] 业务执行失败时，去重标记的释放策略已明确
- [ ] 压测已覆盖重复请求场景，验证不会产生重复数据或重复扣款
- [ ] 监控已接入幂等拦截次数指标，便于观察和告警

做到这些，你的接口才算"生产可用"。
