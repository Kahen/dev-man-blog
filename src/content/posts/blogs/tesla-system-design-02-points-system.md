---
title: "特斯拉级系统设计面试题（二）：亿级车主积分管理系统 — 分布式事务、过期处理与高并发兑换"
published: 2026-06-17
description: 从特斯拉全球 600 万车主积分场景出发，拆解亿级积分获取/兑换/过期的核心挑战，深度解析分布式事务、最终一致性、Redis-Lua 原子兑换、过期扫描、补偿对账，给出可落地的架构方案与 Kotlin 代码实现。
tags: [系统设计, 面试, 积分系统, 分布式事务, Redis, Lua, 一致性, 后端架构]
category: Architecture
lang: zh_CN
---

2025 年特斯拉车主 App 做过一次大改版，"车主积分"模块上线第一周就翻车了：北美车主集中反馈"积分到账延迟 2 小时""兑换充电额度重复扣减""过期积分未清零导致账户虚高"。技术复盘会上，后端 TL 写了三页 PPT，核心就一句话：**积分系统看似简单，实则是分布式系统里"一致性与可用性"的极限拉扯**。

积分系统的"四性要求"：

- **准确性**：每一分积分的来去都可追溯
- **实时性**：获取秒级到账，兑换秒级扣减
- **高并发**：明星车主活动（推荐奖励）峰值 50 万 QPS
- **最终一致**：跨服务（积分 + 充电额度 + 商城）允许短时间不一致，但必须收敛

它不只是一个数字的加减，而是**资金类系统**的简化版——所有"看似不可能出错"的细节都会在百万车主面前被放大一万倍。

---

## 核心考察点

- **数据一致性模型选择**：强一致 vs 最终一致的取舍
- **高并发扣减的正确姿势**：避免超卖、避免重复
- **过期处理**：不能靠定时任务扫全表
- **对账与补偿**：分布式系统的"后悔药"
- **幂等性**：重复消息、重复请求如何处理

> 面试误区：很多候选人上来就答"用 Redis 原子操作 + 异步落库"——这只是冰山一角。要展示出你对**一致性级别、回滚机制、对账体系、容灾降级**的完整理解。

---

## 题目重述

**题目**：设计特斯拉车主积分管理系统，支持：

1. **亿级车主**：全球 600 万车主，每位车主有独立积分账户
2. **多渠道获取**：购车赠送、推荐奖励、驾驶里程、App 互动、节日活动
3. **多场景兑换**：充电额度、商城商品、超级充电服务、保险折扣
4. **过期管理**：积分有效期 3 年，到期前提醒，到期后清零
5. **高并发**：明星活动（推荐奖励）峰值 50 万 QPS
6. **数据准确**：积分增减可追溯、对账无差错

请给出整体架构、核心数据模型、关键流程、典型问题处理。

---

## 标准回答（架构设计）

### 1. 整体架构：账户 + 流水 + 账本三件套

```
┌─────────────────────────────────────────────────────────────┐
│                  业务接入层 (API Gateway)                     │
│  - 鉴权 / 限流  - 参数校验  - 幂等键校验                       │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  领域服务层                                    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐        │
│  │ 积分获取  │ │ 积分兑换  │ │ 积分过期  │ │ 积分查询  │        │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘        │
│       └────────────┴────────────┴────────────┘                │
│                    ┌─────────────┐                            │
│                    │ 账户核心服务 │ (Account Core)            │
│                    └──────┬──────┘                            │
└───────────────────────────┼──────────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────────┐
│                  基础设施层                                    │
│  Redis Cluster │ Kafka │ MySQL (分库分表) │ XXL-Job           │
└──────────────────────────────────────────────────────────────┘
```

**核心三件套**：

- **账户表**（Account）：存当前可用余额、低频读
- **流水表**（Ledger）：存每一次增减变动、append-only
- **账本表**（Wallet）：存过期时间分桶，便于快速到期处理

> **关键设计原则**：**账户余额 = 流水实时计算结果，不存"绝对值"**。余额只存 Redis 缓存，MySQL 中账户表的余额仅作"对账参考"。所有积分变动都通过流水表达。

### 2. 核心数据模型

```sql
-- 1. 账户表（按 user_id 分 64 库 × 16 表）
CREATE TABLE points_account (
    user_id         BIGINT       NOT NULL,
    available       BIGINT       NOT NULL DEFAULT 0 COMMENT '可用积分',
    frozen          BIGINT       NOT NULL DEFAULT 0 COMMENT '冻结积分（兑换中）',
    total_earned    BIGINT       NOT NULL DEFAULT 0 COMMENT '累计获取',
    total_used      BIGINT       NOT NULL DEFAULT 0 COMMENT '累计使用',
    total_expired   BIGINT       NOT NULL DEFAULT 0 COMMENT '累计过期',
    version         BIGINT       NOT NULL DEFAULT 0 COMMENT '乐观锁版本',
    updated_at      DATETIME(3)  NOT NULL,
    PRIMARY KEY (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 流水表（按月分表，append-only）
CREATE TABLE points_ledger_202606 (
    ledger_id       BIGINT       NOT NULL AUTO_INCREMENT,
    user_id         BIGINT       NOT NULL,
    biz_type        VARCHAR(32)  NOT NULL COMMENT 'EARN/USE/EXPIRE/FROZEN/UNFROZEN',
    biz_id          VARCHAR(64)  NOT NULL COMMENT '业务幂等键',
    amount          BIGINT       NOT NULL COMMENT '正数=获取，负数=使用',
    balance_after   BIGINT       NOT NULL COMMENT '操作后余额',
    expire_bucket   VARCHAR(16)  NULL COMMENT '过期分桶 YYYYMM',
    source          VARCHAR(32)  NOT NULL COMMENT '来源: 购车/推荐/里程/活动',
    ref_id          VARCHAR(64)  NULL COMMENT '业务关联 ID',
    operator        VARCHAR(32)  NOT NULL COMMENT '操作人/系统',
    remark          VARCHAR(256) NULL,
    created_at      DATETIME(3)  NOT NULL,
    PRIMARY KEY (ledger_id, created_at),
    UNIQUE KEY uk_biz_id (biz_id, biz_type),  -- 幂等键
    INDEX idx_user_created (user_id, created_at),
    INDEX idx_expire (expire_bucket, biz_type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  PARTITION BY RANGE (TO_DAYS(created_at)) (
    PARTITION p202606 VALUES LESS THAN (TO_DAYS('2026-07-01')),
    -- ...
  );

-- 3. 账本分桶表（按到期月份分桶，加速过期处理）
CREATE TABLE points_wallet_bucket (
    user_id         BIGINT       NOT NULL,
    expire_bucket   VARCHAR(16)  NOT NULL COMMENT '过期分桶 YYYYMM',
    balance         BIGINT       NOT NULL COMMENT '该桶内可用余额',
    source          VARCHAR(32)  NOT NULL,
    biz_id          VARCHAR(64)  NOT NULL COMMENT '关联流水',
    created_at      DATETIME(3)  NOT NULL,
    updated_at      DATETIME(3)  NOT NULL,
    PRIMARY KEY (user_id, expire_bucket, biz_id),
    INDEX idx_expire_bucket (expire_bucket, balance)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**三表协作流程**：

```
用户获取积分：
  1. 写 points_ledger (EARN, +1000)
  2. 更新 points_account.available += 1000
  3. 写 points_wallet_bucket (expire_bucket = 当前+3年)

用户兑换积分：
  1. 选最早过期分桶扣减（FIFO 过期）
  2. 写 points_ledger (USE, -1000)
  3. 更新 points_account.available -= 1000
  4. 更新 points_wallet_bucket.balance -= 1000
  5. 跨服务调用（充电/商城）— Outbox 模式

积分过期：
  1. 定时任务扫描 points_wallet_bucket.expire_bucket = 当月
  2. 写 points_ledger (EXPIRE, -balance)
  3. 更新 points_account.available -= balance
  4. 删除/归档 points_wallet_bucket 记录
```

### 3. 核心流程：积分获取

```kotlin
@Service
class PointsEarnService(
    private val accountRepo: PointsAccountRepository,
    private val ledgerRepo: PointsLedgerRepository,
    private val walletRepo: PointsWalletBucketRepository,
    private val redisTemplate: RedisTemplate,
    private val outboxService: OutboxService
) {
    /**
     * 积分获取（幂等）
     * @param userId    车主 ID
     * @param amount    获取数量（正数）
     * @param source    来源: 购车/推荐/里程/活动
     * @param bizId     业务幂等键（外部传入，保证唯一）
     * @param expireIn  过期时长，默认 3 年
     */
    fun earnPoints(
        userId: Long,
        amount: Long,
        source: String,
        bizId: String,
        expireIn: Duration = Duration.ofDays(365 * 3)
    ): EarnResult {
        // 1. 幂等校验：bizId 唯一键冲突即重复
        if (ledgerRepo.existsByBizId(bizId, "EARN")) {
            log.info("Duplicate earn request, bizId={}", bizId)
            return EarnResult.duplicate()
        }
        
        // 2. 计算过期分桶
        val expireBucket = LocalDate.now().plus(expireIn)
            .format(DateTimeFormatter.ofPattern("yyyyMM"))
        
        // 3. 数据库事务：账户 + 流水 + 账本 三表同写
        return transactionTemplate.execute {
            // 3.1 更新账户（乐观锁）
            val updated = accountRepo.incrementAvailable(userId, amount)
            if (updated == 0) {
                // 账户不存在则创建
                accountRepo.createIfAbsent(userId, amount)
            }
            
            // 3.2 写流水
            ledgerRepo.save(PointsLedger(
                userId = userId,
                bizType = "EARN",
                bizId = bizId,
                amount = amount,
                balanceAfter = updated + amount,
                expireBucket = expireBucket,
                source = source,
                operator = "system"
            ))
            
            // 3.3 写账本分桶
            walletRepo.save(PointsWalletBucket(
                userId = userId,
                expireBucket = expireBucket,
                balance = amount,
                source = source,
                bizId = bizId
            ))
            
            // 3.4 写 Outbox（跨服务事件，比如推荐奖励触发邀请人也加分）
            outboxService.save("points.earned", mapOf(
                "userId" to userId,
                "amount" to amount,
                "source" to source,
                "bizId" to bizId
            ))
            
            EarnResult.success(updated + amount)
        }!!
    }
}
```

> **为什么用 Outbox 模式？** 因为获取积分常常需要"联动加分"（推荐人获得奖励），如果在同一事务里直接 RPC 调用对方服务，会导致分布式事务复杂度爆炸。Outbox 把事件写入本地表，异步 MQ 投递，保证"本地事务 + 至少一次投递"。

### 4. 核心流程：积分兑换（核心难点）

兑换是"高并发 + 强一致 + 跨服务"的典型场景。设计要点：

```kotlin
@Service
class PointsRedeemService(
    private val accountRepo: PointsAccountRepository,
    private val walletRepo: PointsWalletBucketRepository,
    private val redisTemplate: RedisTemplate,
    private val outboxService: OutboxService
) {
    companion object {
        // Redis Key: lock:redeem:{userId}  防并发兑换同一用户
        // Redis Key: quota:sku:{skuId}      商品库存防超卖
        private const val LOCK_PREFIX = "lock:redeem"
        private const val QUOTA_PREFIX = "quota:sku"
    }
    
    /**
     * 兑换商品（核心流程）
     * 关键：FIFO 过期扣减 + 跨服务最终一致
     */
    fun redeem(userId: Long, skuId: Long, bizId: String): RedeemResult {
        // 1. 全局幂等：bizId 已存在则返回
        if (ledgerRepo.existsByBizId(bizId, "USE")) {
            return RedeemResult.duplicate()
        }
        
        // 2. 用户级分布式锁（防同一用户并发兑换）
        val lockKey = "$LOCK_PREFIX:$userId"
        if (!redisLock.tryLock(lockKey, timeout = 5, expire = 30)) {
            throw RedeemException("Concurrent redeem detected for user $userId")
        }
        
        try {
            // 3. 查询商品所需积分
            val sku = skuService.getSku(skuId)
            val requiredPoints = sku.pointsRequired
            
            // 4. 商品库存预扣（Redis DECR 原子操作）
            val stockKey = "$QUOTA_PREFIX:$skuId"
            val newStock = redisTemplate.opsForValue().decrement(stockKey)
            if (newStock == null || newStock < 0) {
                // 库存不足，回滚
                redisTemplate.opsForValue().increment(stockKey)
                return RedeemResult.outOfStock()
            }
            
            // 5. 核心：积分扣减（FIFO 过期顺序）
            val deductResult = deductPointsFifo(userId, requiredPoints, bizId)
            if (!deductResult.success) {
                // 余额不足，回滚库存
                redisTemplate.opsForValue().increment(stockKey)
                return RedeemResult.insufficient()
            }
            
            // 6. 写 Outbox（异步通知商城/充电/保险服务发货）
            outboxService.save("points.redeemed", mapOf(
                "userId" to userId,
                "skuId" to skuId,
                "amount" to requiredPoints,
                "bizId" to bizId
            ))
            
            return RedeemResult.success(deductResult.balanceAfter)
        } finally {
            redisLock.unlock(lockKey)
        }
    }
    
    /**
     * FIFO 过期扣减（按 expire_bucket 升序扣减）
     */
    private fun deductPointsFifo(
        userId: Long,
        amount: Long,
        bizId: String
    ): DeductResult {
        return transactionTemplate.execute {
            // 1. 查询用户所有未过期分桶，按 expire_bucket 升序
            val buckets = walletRepo.findByUserIdOrderByExpireBucket(userId)
            
            var remaining = amount
            val deductions = mutableListOf<Pair<String, Long>>()  // (bizId, amount)
            
            for (bucket in buckets) {
                if (remaining <= 0) break
                val deduct = minOf(remaining, bucket.balance)
                
                if (deduct == bucket.balance) {
                    // 整桶扣完
                    walletRepo.deleteByBizId(bucket.bizId)
                } else {
                    // 部分扣减
                    walletRepo.deductByBizId(bucket.bizId, deduct)
                }
                
                deductions.add(bucket.bizId to deduct)
                remaining -= deduct
            }
            
            if (remaining > 0) {
                // 余额不足，回滚
                throw InsufficientPointsException("Need $amount, have ${amount - remaining}")
            }
            
            // 2. 更新账户余额
            val updated = accountRepo.decrementAvailable(userId, amount)
            if (updated == 0) throw ConcurrentUpdateException("Account version conflict")
            
            // 3. 写流水（一条 USE 流水 + 多条原始 bizId 关联）
            ledgerRepo.save(PointsLedger(
                userId = userId,
                bizType = "USE",
                bizId = bizId,
                amount = -amount,
                balanceAfter = updated,
                source = "REDEEM",
                operator = "user"
            ))
            
            DeductResult.success(updated, deductions)
        }!!
    }
}
```

**FIFO 过期扣减的关键**：

- 不按"积分来源"扣减，按"过期时间"扣减
- 即将过期的积分先扣（避免用户损失）
- 这是合规要求：很多地区（如欧盟）规定过期前必须先用

### 5. 高并发：Redis-Lua 原子兑换脚本

面对 50 万 QPS 的明星活动，单纯靠数据库会打挂。Redis + Lua 是经典方案：

```lua
-- 兑换积分 Lua 脚本（Redis Cluster 中所有 key 必须同 slot，用 hashtag 保证）
-- KEYS[1]: 用户账户 key  e.g., points:account:{userId}
-- KEYS[2]: 库存 key      e.g., quota:sku:{skuId}
-- KEYS[3]: 幂等键         e.g., redeem:idem:{bizId}
-- ARGV[1]: 所需积分
-- ARGV[2]: 幂等值（用户传入的 bizId）
-- ARGV[3]: 幂等过期时间（秒）

-- 1. 幂等检查
if redis.call('EXISTS', KEYS[3]) == 1 then
    return {-1, 'DUPLICATE'}  -- 重复请求
end

-- 2. 检查库存
local stock = tonumber(redis.call('GET', KEYS[2]) or '0')
if stock <= 0 then
    return {-2, 'OUT_OF_STOCK'}
end

-- 3. 检查余额
local balance = tonumber(redis.call('GET', KEYS[1]) or '0')
if balance < tonumber(ARGV[1]) then
    return {-3, 'INSUFFICIENT'}
end

-- 4. 扣减余额
redis.call('DECRBY', KEYS[1], ARGV[1])

-- 5. 扣减库存
redis.call('DECR', KEYS[2])

-- 6. 设置幂等标记
redis.call('SET', KEYS[3], ARGV[2], 'EX', ARGV[3])

return {0, 'SUCCESS', redis.call('GET', KEYS[1])}
```

```kotlin
// Kotlin 调用 Lua
@Component
class PointsRedisRedeemService(
    private val redisTemplate: RedisTemplate,
    private val outboxService: OutboxService
) {
    companion object {
        private val REDEEM_SCRIPT = """
            -- Lua 脚本内容
        """.trimIndent()
    }
    
    /**
     * Redis 原子兑换（前置拦截 + 异步落库）
     */
    fun tryRedeem(userId: Long, skuId: Long, amount: Long, bizId: String): RedeemResult {
        val keys = listOf(
            "points:account:{$userId}",       // {} 保证同 slot
            "quota:sku:{$skuId}",
            "redeem:idem:{$bizId}"
        )
        val args = listOf(
            amount.toString(),
            bizId,
            "86400"  // 幂等 1 天
        )
        
        val result = redisTemplate.execute(
            RedisScript.of(REDEEM_SCRIPT, List::class.java),
            keys,
            *args.toTypedArray()
        ) as List<*>
        
        return when (result[0] as Long) {
            0L -> {
                // 成功，异步落库
                outboxService.save("points.redeemed.async", mapOf(
                    "userId" to userId, "skuId" to skuId, 
                    "amount" to amount, "bizId" to bizId
                ))
                RedeemResult.success(balance = (result[2] as String).toLong())
            }
            -1L -> RedeemResult.duplicate()
            -2L -> RedeemResult.outOfStock()
            -3L -> RedeemResult.insufficient()
            else -> RedeemResult.unknown()
        }
    }
}
```

**双层防护**：

- **第一层 Redis Lua**：扛 50 万 QPS 峰值，做前置拦截
- **第二层 DB 事务**：保证最终落地，绝对准确
- **Outbox 异步**：将 Redis 成功转换为 DB 流水，失败可补偿

### 6. 过期处理：分桶扫表 + 滑动扫描

"几亿条积分记录到期后全表扫"是常见错误。**分桶表 + 月级扫描**才是正确做法：

```kotlin
@Component
class PointsExpireService(
    private val walletRepo: PointsWalletBucketRepository,
    private val ledgerRepo: PointsLedgerRepository,
    private val accountRepo: PointsAccountRepository,
    private val notificationService: NotificationService
) {
    companion object {
        private const val EXPIRE_WARN_DAYS = 30  // 到期前 30 天提醒
        private const val BATCH_SIZE = 1000
    }
    
    /**
     * 每日凌晨扫描过期积分
     */
    @Scheduled(cron = "0 0 3 * * *")  // 每天 3 点
    fun scanExpiredPoints() {
        val today = LocalDate.now()
        val currentBucket = today.format(DateTimeFormatter.ofPattern("yyyyMM"))
        
        // 1. 扫描到期分桶
        val expiredBuckets = walletRepo.findByExpireBucket(currentBucket, limit = BATCH_SIZE)
        
        for (bucket in expiredBuckets) {
            try {
                expirePointsInBucket(bucket)
            } catch (e: Exception) {
                log.error("Expire failed for bucket={}", bucket, e)
                // 不抛出，继续处理下一个（避免一条失败阻塞全部）
            }
        }
        
        // 2. 提醒即将过期
        val warnDate = today.plusDays(EXPIRE_WARN_DAYS.toLong())
        val warnBucket = warnDate.format(DateTimeFormatter.ofPattern("yyyyMM"))
        sendExpirationWarning(warnBucket)
    }
    
    private fun expirePointsInBucket(bucket: PointsWalletBucket) {
        transactionTemplate.execute {
            // 1. 写 EXPIRE 流水
            ledgerRepo.save(PointsLedger(
                userId = bucket.userId,
                bizType = "EXPIRE",
                bizId = "expire:${bucket.bizId}",
                amount = -bucket.balance,
                balanceAfter = 0,  // 实际计算后更新
                expireBucket = bucket.expireBucket,
                source = bucket.source,
                operator = "system.expire"
            ))
            
            // 2. 更新账户
            accountRepo.decrementAvailable(bucket.userId, bucket.balance)
            
            // 3. 删除分桶记录（逻辑删除，保留审计）
            walletRepo.softDeleteByBizId(bucket.bizId)
        }
    }
    
    private fun sendExpirationWarning(bucket: String) {
        val users = walletRepo.findUsersByBucket(bucket, minBalance = 100)
        for (user in users) {
            notificationService.send(
                userId = user.userId,
                template = "points.expiring",
                params = mapOf(
                    "amount" to user.totalBalance,
                    "expireDate" to bucket
                )
            )
        }
    }
}
```

> **关键设计**：**分桶表** 让过期扫描从"全表"变成"按月扫"。3 年后到期的积分，在 3 年前就被分到 `202906` 桶里，到期当天只需要扫这一个桶的几十行数据。

### 7. 对账与补偿：分布式系统的"后悔药"

```kotlin
@Component
class PointsReconciliationService(
    private val accountRepo: PointsAccountRepository,
    private val ledgerRepo: PointsLedgerRepository,
    private val redisTemplate: RedisTemplate
) {
    /**
     * 每日对账任务
     * 核对：账户余额 = Redis 余额 = 流水合计
     */
    @Scheduled(cron = "0 0 4 * * *")  // 每天 4 点
    fun dailyReconciliation() {
        log.info("Starting daily points reconciliation")
        
        // 1. 采样核对（前 1 万名活跃车主 + 随机 1 万名）
        val sampleUsers = accountRepo.sampleActiveUsers(10000) + 
                          accountRepo.sampleRandomUsers(10000)
        
        var mismatchCount = 0
        for (userId in sampleUsers) {
            val dbBalance = accountRepo.getAvailable(userId)
            val redisBalance = (redisTemplate.opsForValue().get("points:account:$userId") as Long?) ?: 0
            val ledgerSum = ledgerRepo.sumAmountByUserId(userId)
            
            if (dbBalance != redisBalance || dbBalance != ledgerSum) {
                log.error("Mismatch for user {}: db={}, redis={}, ledger={}",
                    userId, dbBalance, redisBalance, ledgerSum)
                
                // 触发补偿
                compensate(userId, dbBalance, redisBalance, ledgerSum)
                mismatchCount++
            }
        }
        
        if (mismatchCount > 100) {
            alertService.send("Points reconciliation mismatch > 100, investigate!")
        }
    }
    
    /**
     * 补偿策略：以"流水合计"为权威，修正账户余额
     */
    private fun compensate(userId: Long, db: Long, redis: Long, ledger: Long) {
        // 以 ledger 为准（流水是 append-only，最可信）
        accountRepo.updateAvailable(userId, ledger)
        redisTemplate.opsForValue().set("points:account:$userId", ledger.toString())
        log.warn("Compensated user {} to balance {}", userId, ledger)
    }
    
    /**
     * 全量对账（每周一次，比采样更严）
     */
    @Scheduled(cron = "0 0 5 * * SUN")  // 周日凌晨 5 点
    fun weeklyFullReconciliation() {
        // ... 全量对账逻辑（通过分片并行处理）
    }
}
```

**对账的核心原则**：

- **流水为权威**：append-only 的流水是唯一可信源
- **账户表是缓存**：可能与流水不一致
- **Redis 是热缓存**：可能丢失，要能重建
- **最终收敛**：发现不一致就修正，幂等补偿

---

## 追问深度

### Q1：跨服务（积分 → 充电额度 → 商城）如何保证一致性？

**答**：**Outbox + 最终一致**。

1. 积分服务在本地事务里写 Outbox 表
2. 定时任务或 Debezium 监听 binlog，投递到 Kafka
3. 充电/商城服务消费，幂等处理
4. 失败重试，幂等键保证不重复

> **为什么不用 2PC/TCC？** 因为跨服务强一致会牺牲可用性，且 2PC 协调者故障会"阻塞"。最终一致是绝大多数业务场景的更优解。

### Q2：明星活动 50 万 QPS，数据库扛不住怎么办？

**答**：**三级漏斗**：

1. **第一级 Redis Lua**：扛 90% 重复/失败请求
2. **第二级 MQ 削峰**：成功请求进 Kafka 排队
3. **第三级 DB 批量落库**：消费者批量写入流水表

```kotlin
// MQ 消费端批量落库
@KafkaListener(topics = ["points.redeemed.async"], batch = "100")
fun batchProcess(records: List<ConsumerRecord<String, String>>) {
    val items = records.map { parseJson(it.value()) }
    
    // 批量更新账户
    accountRepo.batchIncrement(items)
    
    // 批量写流水（单次 INSERT 多行）
    ledgerRepo.batchSave(items)
    
    // ACK（手动提交 offset）
    ack.acknowledge()
}
```

### Q3：积分被黑客恶意刷怎么办？

**答**：**多层防护**：

1. **业务侧限流**：单用户每日获取上限（普通 1000，Premium 10000）
2. **风控规则**：短时间高频、IP 异常、设备聚集 → 拒绝
3. **审计追溯**：所有获取操作记入审计日志
4. **冻结机制**：可疑操作先冻结，人工审核后解冻

```kotlin
// 风控规则示例
@Component
class PointsRiskControl {
    private val dailyLimit = 1000L
    private val hourlyLimit = 200L
    
    fun check(userId: Long, amount: Long, source: String): RiskResult {
        // 单日上限
        val todayEarn = ledgerRepo.sumTodayEarn(userId)
        if (todayEarn + amount > dailyLimit) {
            return RiskResult.deny("DAILY_LIMIT_EXCEEDED")
        }
        
        // 单小时上限
        val hourlyEarn = ledgerRepo.sumHourlyEarn(userId)
        if (hourlyEarn + amount > hourlyLimit) {
            return RiskResult.deny("HOURLY_LIMIT_EXCEEDED")
        }
        
        // 设备/IP 异常检测
        val deviceCount = deviceService.getRecentDeviceCount(userId, hours = 1)
        if (deviceCount > 3) {
            return RiskResult.review("MULTI_DEVICE")
        }
        
        return RiskResult.allow()
    }
}
```

### Q4：积分有效期是 3 年，那 3 年前的积分没过期怎么办？

**答**：**滚动过期**。每笔积分的过期时间从"获取时刻"开始计算 3 年，而不是按自然年。所以 2023 年 5 月获取的积分 2026 年 5 月过期，2023 年 12 月获取的 2026 年 12 月过期，分散到不同月份。

> **分桶表**就是为此设计。每月一个 bucket，过期扫描时只需要扫当前月。

### Q5：怎么保证"用户看到的余额"和"实际余额"一致？

**答**：**余额显示的真相来源**：

- **App 显示**：从 Redis 读（亚毫秒）
- **下单时校验**：从 Redis 读 + 分布式锁
- **最终落账**：从 DB 流水算

用户看到 5000，下单扣 4500，过程中可能有人送他 1000 积分（用户没看到），下单时实际余额是 5500——这不叫"不一致"，叫"实时性"。

---

## 常见坑

**1. 账户表余额字段被当作真相来源**：账户表是缓存，流水才是真相。一旦发生不一致，账户表被改回流水值就对了。

**2. 用定时任务扫全表做过期处理**：几亿条记录扫全表，数据库直接挂。要用分桶表。

**3. 兑换超卖没防住**：100 件商品卖 150 个。Redis 库存 DECR 必须有"扣减 + 校验"原子操作。

**4. 幂等键设计粒度太粗**：用 `userId` 做幂等键，同一用户两次正常请求都被误判重复。幂等键必须是"用户 + 业务 + 唯一编号"。

**5. 跨服务用 2PC**：TCC 适合单服务的多资源场景，跨服务强一致代价太高。用 Outbox + 最终一致。

**6. 流水表忘了分表**：流水是 append-only，半年就上亿条。必须按月分表。

**7. 忘了写 Outbox 表**：跨服务直接 RPC 调用，分布式事务一塌糊涂。所有跨服务调用先写 Outbox。

**8. 对账发现不一致没修**：对账任务是"补漏"用的，不是"检查"用的。不一致要自动补偿 + 告警。

**9. Redis Lua 脚本 key 没放同 slot**：Redis Cluster 下跨 slot 报错。用 `{userId}` hashtag 保证同 slot。

**10. 积分增减不写流水**：直接 UPDATE 账户表，过半年想做活动复盘，发现没有历史。

---

## 可执行 Checklist

- [ ] 账户表与流水表分离（账户是缓存，流水是真相）
- [ ] 流水表按月分表 + 唯一索引（幂等键）
- [ ] 账本分桶表存在且按 expire_bucket 索引
- [ ] 兑换接口有 Redis Lua 原子操作
- [ ] 跨服务调用走 Outbox 模式
- [ ] 过期扫描用分桶而非全表
- [ ] 每日对账任务运行（采样 + 补偿）
- [ ] 限流规则在风控层生效
- [ ] 幂等键粒度正确（userId + bizType + bizId）
- [ ] Redis Cluster 用 hashtag 保证同 slot
- [ ] 监控指标接入（兑换 QPS、过期积压、对账差异）
- [ ] 应急方案明确（Redis 挂掉降级到 DB、MQ 积压告警）
- [ ] 容量评估完成（峰值 QPS、流水增长、Redis 内存）

---

## 写在最后

积分系统的本质是**资金系统的"简化但不失真"**。设计它的过程会让你深刻理解：

- **一致性的代价**：强一致 vs 最终一致，选择决定一切
- **可追溯的价值**：所有变动都要可追，否则就是埋雷
- **对账的必要性**：分布式系统没有 100% 一致，只有"能发现不一致 + 能修复"
- **幂等的重要性**：没有幂等，分布式系统寸步难行

把这四点刻在脑子里，下一个系统设计题就成功了一半。

**下篇预告：第 3 篇 — 特斯拉超级充电桩网络调度系统（空间索引、调度算法、利用率最大化）**
