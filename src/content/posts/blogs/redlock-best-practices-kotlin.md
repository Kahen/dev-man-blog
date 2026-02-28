---
title: Redlock 使用最佳实践：生产可用指南（含 Kotlin 示例）
description: 一文讲清 Redlock 在生产环境中的正确打开方式：TTL 设计、续期、重试抖动、幂等、防脑裂，以及基于 Kotlin + Redisson 的落地代码示例。
published: 2026-02-25
tags: [Redis, Redlock, Kotlin, 分布式锁, 后端]
category: Guides
---

很多团队第一次上分布式锁，都会踩同一个坑：

- 本地测没问题
- 压测开始偶发“重复执行”
- 线上高峰出现“锁还在，业务却超时”

`SET NX PX` 只是开始，真正难的是**锁的生命周期管理**。

这篇文章给你一份可落地的 Redlock 实战清单，并附上 Kotlin 示例代码。

---

## Redlock 适合解决什么问题？

Redlock 适合“**跨实例互斥**”类问题，例如：

- 定时任务防重跑（同一时刻只允许一个节点执行）
- 抢购扣减中的临界区保护
- 同一订单/同一用户的并发写保护

但不建议把 Redlock 当作“绝对线性一致”的万能方案。对资金结算、强一致账务，建议结合：

- 数据库唯一约束 / 状态机
- 幂等键
- fencing token（栅栏令牌）

> 一句话：分布式锁是“并发控制辅助工具”，不是“事务替代品”。

---

## 生产最佳实践（建议直接对照检查）

### 1) 锁值必须是唯一随机值

不要用固定字符串当 value。value 应该是 `UUID`（或高熵随机串），用于**安全释放**：

- 只允许“持有者”释放自己的锁
- 防止 A 的锁过期后，B 拿到锁，A 误删 B 的锁

---

### 2) 释放锁必须用 Lua 原子校验

不要先 `GET` 再 `DEL`，中间有竞态。

正确做法是 Lua：

```lua
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
```

---

### 3) TTL 不是越大越好，按公式估算

常见经验值：

$$
TTL \ge p99(业务耗时) + 2 \times RTT + 时钟漂移余量
$$

例如：业务 p99=350ms，网络往返+漂移预留 250ms，可以先从 `800ms~1200ms` 起步，压测再调。

---

### 4) 业务耗时不确定时，必须“续期”

长任务请启用 watchdog（看门狗自动续租）或手动续期。否则 TTL 到期后锁被别人拿走，旧任务还在跑，会出现并发写。

---

### 5) 获取失败后使用随机退避（jitter）

固定间隔重试会制造“惊群效应”。推荐：

- 指数退避 + 随机抖动
- 设置最大重试时间，避免无穷等待

---

### 6) 临界区逻辑必须幂等

即使有锁，也不能假设“只会执行一次”。

你仍然需要：

- 幂等键（如业务请求号）
- 唯一索引（数据库兜底）
- 可重入/可补偿设计

---

### 7) 监控比“上锁成功”更重要

至少打这些指标：

- `lock_acquire_latency`
- `lock_acquire_failure_rate`
- `lock_hold_duration`
- `lock_renewal_failure`
- `critical_section_timeout`

没有观测，你无法区分“业务慢”还是“锁策略错误”。

---

## Kotlin 落地示例（Redisson）

下面示例用 Redisson 的 `RLock`，演示：

- 尝试获取锁
- 在持锁状态执行临界区
- 安全释放

### 1) Gradle 依赖

```kotlin
dependencies {
    implementation("org.redisson:redisson:3.34.1")
}
```

### 2) Redisson 配置（单机示例）

```kotlin
import org.redisson.Redisson
import org.redisson.api.RedissonClient
import org.redisson.config.Config

fun createRedissonClient(): RedissonClient {
    val config = Config()
    config.useSingleServer()
        .setAddress("redis://127.0.0.1:6379")
        .setConnectionMinimumIdleSize(8)
        .setConnectionPoolSize(32)

    return Redisson.create(config)
}
```

### 3) 业务代码：带超时获取 + finally 释放

```kotlin
import org.redisson.api.RLock
import org.redisson.api.RedissonClient
import java.util.concurrent.TimeUnit

class InventoryService(private val redisson: RedissonClient) {

    fun deductSkuStock(skuId: Long, requestId: String): Boolean {
        val lockKey = "lock:sku:$skuId"
        val lock: RLock = redisson.getLock(lockKey)

        // waitTime: 最长等待 300ms 获取锁
        // leaseTime: 持锁 5s（若业务耗时不确定，可传 -1 使用 watchdog）
        val locked = lock.tryLock(300, 5, TimeUnit.MILLISECONDS)
        if (!locked) {
            return false
        }

        return try {
            // 1) 幂等判断（示例）
            if (isProcessed(requestId)) return true

            // 2) 临界区：查询库存并扣减
            val ok = doDeduct(skuId)
            if (ok) markProcessed(requestId)
            ok
        } finally {
            // 只在当前线程持有时释放，防止误解锁
            if (lock.isHeldByCurrentThread) {
                lock.unlock()
            }
        }
    }

    private fun isProcessed(requestId: String): Boolean {
        // TODO: 例如查 DB 唯一键 / 去重表
        return false
    }

    private fun markProcessed(requestId: String) {
        // TODO: 落库去重标记
    }

    private fun doDeduct(skuId: Long): Boolean {
        // TODO: 真正扣减逻辑
        return true
    }
}
```

---

## 多 Redis 节点下的 Redlock 注意点

如果你要按论文思路做“多主节点 Redlock”，请注意：

- 节点之间要尽量独立故障域（不要都在同一台宿主机）
- 获取锁要在多数节点成功（例如 5 节点中至少 3）
- 锁有效期要扣除获取过程耗时
- 任一异常都要尽快释放已成功节点上的锁

实践中，很多团队会选择：

- 普通场景：单 Redis + watchdog + 幂等兜底
- 高风险场景：再叠加数据库约束、消息去重、状态机

这样通常比“只押宝 Redlock 算法细节”更稳。

---

## 常见坑（我见过最多的 5 个）

1. 把锁当事务：加了锁就不做幂等和唯一约束。
2. TTL 设死：业务变慢后频繁过期，出现重入。
3. 无抖动重试：高并发下直接把 Redis 打满。
4. 释放不校验持有者：误删他人锁。
5. 只看成功率，不看持锁时长和续期失败。

---

## 一份可执行的上线清单

上线前请至少确认：

- [ ] 锁 key 设计包含业务维度（如 `skuId` / `orderId`）
- [ ] value 唯一、释放原子校验
- [ ] TTL 按压测 p99 推导，不拍脑袋
- [ ] 长任务续期策略已验证
- [ ] 临界区具备幂等 + DB 唯一约束
- [ ] 指标与告警已接入
- [ ] 故障演练覆盖：Redis 超时、网络抖动、业务慢请求

做到这些，你的 Redlock 才算“生产可用”。

