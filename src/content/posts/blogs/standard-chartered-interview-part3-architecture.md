---
title: "渣打银行Java后端面试深度解析（三）：架构设计 — 核心账务、反欺诈风控、多活部署与灰度发布"
published: 2026-05-18
description: 从系统架构全局视角出发，剖析渣打银行Java后端面试中的五个核心话题：账务核心系统设计、反欺诈实时风控、单元化多活架构、监管合规审计与灰度发布回滚，附完整架构图和落地代码。
tags: [面试, Java, 系统架构, 风控, 多活, 灰度发布, 金融, 后端架构]
category: Architecture
lang: zh_CN
---

某次灰度发布，新版转账接口上线 5% 流量后，监控显示转账成功率从 99.99% 掉到了 99.2%。排查发现新版的金额校验逻辑对"0.01 元"的边界处理有 bug，但因为没有自动回滚机制，靠人工发现并回滚花了 12 分钟——这 12 分钟内影响了上千笔交易。

在银行核心系统里，架构设计不是"能跑就行"，而是要在万级 TPS、强一致性、99.99% 可用性这三个互相矛盾的目标之间找到平衡点。这篇文章从系统全局视角出发，拆解五个架构层面的核心问题。

---

## 一、银行账务核心系统架构设计

### 1.1 需求分析

设计银行账务核心系统，核心需求：
- **每秒万级交易**（TPS 10,000+）
- **强一致性**（不允许一分钱差错——银行的铁律）
- **高可用**（99.99%可用性，即全年停机不超过52.6分钟）

这三个需求是经典的"不可能三角"：强一致性会牺牲性能，高可用会增加一致性保障的难度。架构设计的本质就是在三者之间找到最优的平衡点。

### 1.2 整体架构

```
                        ┌──────────────────────────────────────┐
                        │           接入层 (LB/Gateway)         │
                        │  Nginx → API Gateway → 鉴权/限流      │
                        └───────────────┬──────────────────────┘
                                        │
                        ┌───────────────▼──────────────────────┐
                        │           服务层 (微服务)              │
                        │  账户服务 │ 交易服务 │ 清算服务         │
                        │  流水服务 │ 对账服务 │ 查询服务         │
                        └───────────────┬──────────────────────┘
                                        │
              ┌─────────────────────────┼─────────────────────────┐
              │                         │                         │
   ┌──────────▼─────────┐  ┌───────────▼──────────┐  ┌──────────▼─────────┐
   │   交易数据库集群     │  │   账户数据库集群       │  │   流水数据库集群     │
   │   (分库分表)        │  │   (分库分表)          │  │   (只追加不修改)    │
   └────────────────────┘  └──────────────────────┘  └────────────────────┘
              │                         │
   ┌──────────▼─────────────────────────▼────────────────────────┐
   │                    消息中间件 (Kafka集群)                     │
   └──────────────────────────────────────────────────────────────┘
              │                         │                         │
   ┌──────────▼─────────┐  ┌───────────▼──────────┐  ┌──────────▼─────────┐
   │   对账系统          │  │   风控系统            │  │   数据分析系统       │
   └────────────────────┘  └──────────────────────┘  └────────────────────┘
```

### 1.3 分库分表设计

**分库维度**：

账务系统的核心数据包括：账户表、交易流水表、交易明细表。分库策略通常按**机构号**（不同分行/支行）进行水平拆分。

```
分库策略：
  DB_001: 机构001-010的账户和交易数据
  DB_002: 机构011-020的账户和交易数据
  ...
  DB_010: 机构091-100的账户和交易数据

路由规则：账户所在机构号 % 10 → 对应数据库
```

**分表维度**：

在每个数据库内部，按照账户ID进行分表：

```
单库分表策略：
  account_000 ~ account_015: 按 account_id % 16 分表
  transaction_000 ~ transaction_015: 按 transaction_id % 16 分表
```

**交易流水表的特殊考虑**：
交易流水表是写入量最大的表，且通常是只追加（INSERT），很少更新。可以按**时间 + 账户ID**复合维度分表：

```
transaction_202401_00 ~ transaction_202401_15: 2024年1月的交易，按账户ID分16张表
transaction_202402_00 ~ transaction_202402_15: 2024年2月的交易
```

这样历史数据可以按月份快速归档和清理。

**Sharding中间件选型**：ShardingSphere或自研的SQL路由引擎。

```java
// ShardingSphere配置示例
spring:
  shardingsphere:
    datasource:
      names: ds0, ds1, ds2, ds3
    rules:
      sharding:
        tables:
          account:
            actual-data-nodes: ds${0..3}.account_${0..15}
            database-strategy:
              standard:
                sharding-column: org_code
                sharding-algorithm-name: org-mod
            table-strategy:
              standard:
                sharding-column: account_id
                sharding-algorithm-name: account-mod
        sharding-algorithms:
          org-mod:
            type: MOD
            props:
              sharding-count: 4
          account-mod:
            type: MOD
            props:
              sharding-count: 16
```

### 1.4 多活部署

**同城双活 + 异地灾备**：

```
上海数据中心（主）
  ├── 机房A（承载50%流量）
  └── 机房B（承载50%流量）
       ↕ 同步复制（延迟 < 1ms）

新加坡数据中心（灾备）
  └── 异步复制（延迟 < 1s）

深圳数据中心（灾备）
  └── 异步复制（延迟 < 1s）
```

同城双活的关键技术：
- **数据库同步复制**：使用MySQL的半同步复制（Semi-Sync Replication），确保至少一个从库收到数据
- **流量路由**：基于用户维度进行流量分割（如用户ID哈希），确保同一用户的请求始终路由到同一机房
- **数据冲突避免**：同一用户的写操作只在一个机房执行，通过全局路由表保证

### 1.5 对账机制

除了前面文章讲的日终对账，核心系统还需要：

- **实时对账**：每笔交易完成后，异步发送交易事件到Kafka，实时对账服务消费并校验
- **准实时对账**：每小时汇总比对一次交易总额
- **日终全量对账**：与银联/网联的全量比对

### 1.6 一分钱不差的技术保障

```
资金安全保障体系：
1. 账务平衡校验：每笔交易完成后校验 借方金额合计 == 贷方金额合计
2. 账户余额校验：余额不允许为负数（除非有授信额度）
3. 分布式事务：TCC保证扣款和加款的原子性
4. 对账兜底：实时 + 准实时 + 日终三层对账
5. 审计追踪：每一笔资金变动都有完整日志链路
```

---

## 二、反欺诈实时风控系统

### 2.1 需求场景

设计实时反欺诈系统，核心要求：
- 交易发生后**100ms内**给出风控决策（通过/拒绝/人工审核）
- 识别"异地登录后大额转账"、"深夜异常交易"、"短时间内多次尝试"等异常行为
- 误判率低于0.1%，漏判率低于0.01%

### 2.2 整体架构

```
交易请求
    ↓
┌───────────────────────────────────────────┐
│              规则引擎层                    │
│  实时规则匹配（内存中，<10ms）             │
│  - 交易金额 > 50万?                        │
│  - 收款方在黑名单中?                       │
│  - 交易频率 > 阈值?                        │
└───────────────────┬───────────────────────┘
                    ↓
┌───────────────────────────────────────────┐
│              特征计算层                    │
│  实时特征聚合（Flink/Storm，<50ms）       │
│  - 过去1小时交易次数                       │
│  - 过去24小时交易金额合计                  │
│  - 当前IP与常用IP的距离                    │
└───────────────────┬───────────────────────┘
                    ↓
┌───────────────────────────────────────────┐
│              模型评分层                    │
│  机器学习模型评分（<30ms）                │
│  - XGBoost/LightGBM异常检测模型           │
│  - 输出风险评分 0-1000                    │
└───────────────────┬───────────────────────┘
                    ↓
┌───────────────────────────────────────────┐
│              决策引擎层                    │
│  综合规则结果 + 模型评分 → 最终决策        │
│  - 评分 < 200: 通过                       │
│  - 200 < 评分 < 600: 人工审核             │
│  - 评分 > 600: 拒绝                       │
└───────────────────────────────────────────┘
    ↓              ↓              ↓
  通过           人工审核         拒绝
```

### 2.3 核心模块详解

**模块一：规则引擎**

规则引擎是风控系统的第一道防线，基于明确的业务规则快速判断。使用Drools或自研的规则引擎：

```java
// Drools规则示例
rule "异地登录后大额转账"
    when
        $event: RiskEvent(
            loginCity != homeCity,
            amount > 50000,
            timeSinceLogin < 300 // 5分钟内
        )
    then
        $event.addRiskFactor("REMOTE_LOGIN_LARGE_TRANSFER", 300);
        update($event);
end

rule "深夜大额转账"
    when
        $event: RiskEvent(
            hour >= 1 && hour <= 5,
            amount > 10000
        )
    then
        $event.addRiskFactor("NIGHT_TRANSFER", 200);
        update($event);
end

rule "短时间多次密码错误"
    when
        $event: RiskEvent(
            failedAttempts > 3,
            timeSinceFirstAttempt < 600 // 10分钟内
        )
    then
        $event.addRiskFactor("MULTI_FAIL_ATTEMPT", 500);
        update($event);
end
```

**模块二：CEP（Complex Event Processing）复杂事件处理**

CEP用于检测多个简单事件的组合模式，识别复杂的欺诈行为。以Flink CEP为例：

```java
// 使用Flink CEP检测"异地登录后大额转账"
Pattern<RiskEvent, ?> fraudPattern = Pattern
    .<RiskEvent>begin("login")
        .where(new SimpleCondition<RiskEvent>() {
            @Override
            public boolean filter(RiskEvent event) {
                return event.getType() == EventType.LOGIN
                    && !event.getCity().equals(event.getHomeCity());
            }
        })
    .followedBy("transfer")
        .where(new IterativeCondition<RiskEvent>() {
            @Override
            public boolean filter(RiskEvent event, Context<RiskEvent> ctx) {
                RiskEvent loginEvent = ctx.getEventsForPattern("login").iterator().next();
                return event.getType() == EventType.TRANSFER
                    && event.getAmount().compareTo(new BigDecimal("50000")) > 0
                    // 登录后10分钟内的转账
                    && event.getTimestamp() - loginEvent.getTimestamp() < 600_000
                    // 同一用户
                    && event.getUserId().equals(loginEvent.getUserId());
            }
        })
    .within(Time.minutes(15)); // 整个模式在15分钟内完成

// 应用模式到流
PatternStream<RiskEvent> patternStream = CEP.pattern(
    riskEventStream.keyBy(RiskEvent::getUserId),
    fraudPattern
);

// 匹配到模式后发送风控告警
patternStream.select(new PatternSelectFunction<RiskEvent, RiskAlert>() {
    @Override
    public RiskAlert select(Map<String, List<RiskEvent>> pattern) {
        RiskEvent login = pattern.get("login").get(0);
        RiskEvent transfer = pattern.get("transfer").get(0);
        return new RiskAlert(
            transfer.getUserId(),
            "REMOTE_LOGIN_LARGE_TRANSFER",
            RiskLevel.HIGH,
            "异地登录(" + login.getCity() + ")后" +
            "大额转账(" + transfer.getAmount() + ")"
        );
    }
});
```

**模块三：特征计算**

实时特征是风控模型的核心输入。需要预先计算并实时更新的特征包括：

```java
// Flink实时特征聚合
public class RiskFeatureCalculator {

    // 用户过去1小时交易次数
    public DataStream<UserFeature> calculateTxCount(DataStream<Transaction> txStream) {
        return txStream
            .keyBy(Transaction::getUserId)
            .window(TumblingEventTimeWindows.of(Time.hours(1)))
            .aggregate(new AggregateFunction<Transaction, Long, Long>() {
                @Override public Long createAccumulator() { return 0L; }
                @Override public Long add(Transaction tx, Long acc) { return acc + 1; }
                @Override public Long getResult(Long acc) { return acc; }
                @Override public Long merge(Long a, Long b) { return a + b; }
            })
            .map((count, out) -> out.collect(new UserFeature("tx_count_1h", count)));
    }

    // 用户过去24小时交易金额合计
    public DataStream<UserFeature> calculateAmountSum(DataStream<Transaction> txStream) {
        return txStream
            .keyBy(Transaction::getUserId)
            .window(SlidingEventTimeWindows.of(Time.hours(24), Time.hours(1)))
            .aggregate(new AmountSumAggregate());
    }

    // 交易IP与常用IP的地理距离
    public DataStream<UserFeature> calculateIpDistance(DataStream<Transaction> txStream) {
        return txStream.keyBy(Transaction::getUserId)
            .process(new KeyedProcessFunction<String, Transaction, UserFeature>() {
                // 用状态存储用户的常用IP列表
                private ValueState<List<String>> usualIps;

                @Override
                public void processElement(Transaction tx, Context ctx, Collector<UserFeature> out) {
                    List<String> ips = usualIps.value();
                    double minDistance = ips.stream()
                        .mapToDouble(ip -> GeoUtils.calculateDistance(ip, tx.getIp()))
                        .min().orElse(Double.MAX_VALUE);
                    out.collect(new UserFeature("ip_distance", minDistance));
                }
            });
    }
}
```

**模块四：模型评分**

特征计算完成后，输入机器学习模型进行评分：

```java
@Component
public class ModelScoringService {

    // 模型加载（从ML平台或本地文件加载）
    private final XGBoostModel model;

    public int score(String userId, Map<String, Double> features) {
        // 特征向量化
        float[] featureVector = new float[]{
            features.getOrDefault("tx_count_1h", 0.0).floatValue(),
            features.getOrDefault("amount_sum_24h", 0.0).floatValue(),
            features.getOrDefault("ip_distance", 0.0).floatValue(),
            features.getOrDefault("failed_attempts", 0.0).floatValue(),
            features.getOrDefault("time_since_login", 0.0).floatValue(),
            features.getOrDefault("amount", 0.0).floatValue(),
            features.getOrDefault("is_night", 0.0).floatValue(),
            // ... 更多特征
        };

        // 模型推理
        float probability = model.predict(featureVector);
        return (int) (probability * 1000); // 映射到0-1000分
    }
}
```

### 2.4 实时决策流程的端到端延迟

```
交易请求到达
    → 规则引擎匹配（5-10ms）
    → 特征计算（从Redis/本地缓存读取，5-20ms）
    → 模型评分（10-30ms）
    → 决策输出（5ms）
    → 总延迟 < 50ms（满足100ms的要求）
```

特征数据需要预计算并缓存在Redis中，而不是在交易时实时计算，这是保证低延迟的关键。

---

## 三、单元化多活架构设计

### 3.1 为什么需要单元化

渣打银行的业务覆盖多个国家和地区（中国香港、新加坡、印度、英国等），每个区域有独立的监管要求和数据合规要求。传统的中心化架构面临的问题：

- 跨洲网络延迟高（上海到伦敦延迟约200ms）
- 单数据中心故障影响全球业务
- 不同国家的数据不能离开本国（数据主权）

单元化（Unitization）是将系统按照某种维度拆分成多个独立的"单元"（Unit），每个单元可以独立完成业务闭环。

### 3.2 单元化架构

```
┌─────────────────────────────────────────────────────────┐
│                    全局路由层（GSLB）                      │
│          根据用户属性将请求路由到对应单元                    │
└───────┬──────────────────┬──────────────────┬───────────┘
        │                  │                  │
┌───────▼──────┐  ┌───────▼──────┐  ┌───────▼──────┐
│   上海单元    │  │  新加坡单元   │  │   伦敦单元    │
│              │  │              │  │              │
│ API Gateway  │  │ API Gateway  │  │ API Gateway  │
│ 账户服务     │  │ 账户服务     │  │ 账户服务      │
│ 交易服务     │  │ 交易服务     │  │ 交易服务      │
│ 清算服务     │  │ 清算服务     │  │ 清算服务      │
│              │  │              │  │              │
│ 数据库       │  │ 数据库       │  │ 数据库        │
│ (完整副本)   │  │ (完整副本)   │  │ (完整副本)    │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └─────────────────┼─────────────────┘
                         │
                    数据同步通道
                  (异步 + 最终一致)
```

### 3.3 单元拆分维度

单元拆分的核心问题是：按什么维度把用户和数据划分到不同单元？

**方案一：按地理区域（推荐）**
```
上海单元：中国内地用户
新加坡单元：东南亚用户
伦敦单元：欧洲用户
香港单元：港澳用户
```
优点：符合数据主权要求（数据不出境），用户请求不需要跨洲。
缺点：跨国用户的账户可能需要在多个单元间协调。

**方案二：按机构/分行**
```
单元A：华东地区所有分行的账户
单元B：华南地区所有分行的账户
单元C：华北地区所有分行的账户
```
优点：行内业务自闭环，跨行交易走外部清算。
缺点：如果用户在多个分行都有账户，需要跨单元协调。

**方案三：按账户ID哈希**
```
账户ID % 3 == 0 → 单元A
账户ID % 3 == 1 → 单元B
账户ID % 3 == 2 → 单元C
```
优点：数据均匀分布。
缺点：同一用户的多个账户可能分布在不同单元，跨单元调用多。

**推荐方案**：以国家/地区为主维度，同一国家内的账户按机构号细分。

### 3.4 数据同步方案

单元化架构中，每个单元有完整的数据副本，单元间需要同步关键数据（如跨单元转账）。

**同单元交易**：在单元内部完成，不需要跨单元同步，延迟最低。

**跨单元交易**：通过消息队列异步同步：

```java
// 跨单元转账流程
public class CrossUnitTransferService {

    public void transfer(String fromAccount, String toAccount, BigDecimal amount) {
        String fromUnit = routingService.getUnit(fromAccount);
        String toUnit = routingService.getUnit(toAccount);

        if (fromUnit.equals(toUnit)) {
            // 同单元：直接本地事务
            localTransfer(fromAccount, toAccount, amount);
        } else {
            // 跨单元：两阶段
            // 阶段1：扣款方单元扣减金额
            debitInUnit(fromUnit, fromAccount, amount);
            // 发送跨单元消息
            CrossUnitMessage msg = new CrossUnitMessage(fromAccount, toAccount, amount, "DEBITED");
            kafkaTemplate.send("cross-unit-topic", toUnit, JsonUtil.toJson(msg));
        }
    }
}

// 加款方单元消费者
@KafkaListener(topics = "cross-unit-topic", groupId = "shanghai-unit")
public void onCrossUnitMessage(CrossUnitMessage msg) {
    // 阶段2：加款方单元增加金额
    creditInUnit(msg.getToAccount(), msg.getAmount());
}
```

**数据同步不丢的保障**：
1. Kafka消息持久化 + acks=all（具体配置参见本系列第二篇《基础设施》中的 Kafka 可靠性章节）
2. 消费端幂等（通过唯一交易ID去重）
3. 定期对账：跨单元间每日比对跨单元交易流水
4. 补偿机制：对账发现缺失后自动补发

### 3.5 上海机房故障切到新加坡

```
故障切换流程：
1. 监控系统检测到上海机房异常（健康检查失败、流量锐减）
2. GSLB将上海的流量路由到新加坡单元
3. 新加坡单元从本地数据库读取数据（因为有完整副本）
4. 新加坡单元处理新的交易请求
5. 上海恢复后，反向同步在新加坡期间产生的增量数据
6. 数据一致后，将流量切回上海
```

**关键问题：切流期间的数据一致性**

切换瞬间，可能有些交易正在上海处理中。解决方案：
- 切换前：暂停上海单元的写入，等待所有进行中的交易完成
- 切换后：新加坡单元接管，所有新交易只写新加坡
- 恢复前：同步新加坡的增量数据到上海，校验一致后再切回

```java
@Component
public class FailoverOrchestrator {

    /**
     * 执行故障切换
     */
    public FailoverResult failover(String failedUnit, String targetUnit) {
        // 1. 标记故障单元为READ_ONLY，停止接受新写入
        unitRegistry.markReadOnly(failedUnit);
        log.info("Marked {} as READ_ONLY", failedUnit);

        // 2. 等待进行中的交易完成（设置超时）
        boolean drained = waitForDrain(failedUnit, Duration.ofMinutes(5));
        if (!drained) {
            log.warn("Not all transactions drained, forcing failover");
        }

        // 3. 切换GSLB路由
        gslb.redirect(failedUnit, targetUnit);
        log.info("GSLB redirected {} → {}", failedUnit, targetUnit);

        // 4. 标记目标单元为主单元
        unitRegistry.markPrimary(targetUnit);
        log.info("Marked {} as PRIMARY", targetUnit);

        // 5. 启动增量同步（故障单元恢复后反向同步）
        syncService.startIncrementalSync(failedUnit, targetUnit);

        return FailoverResult.success(failedUnit, targetUnit);
    }
}
```

---

## 四、监管合规与审计设计

### 4.1 需求分析

银行系统面临严格的监管要求：
- **所有操作可审计追溯**：谁在什么时间做了什么操作
- **敏感操作双人复核**：大额转账需要主管审批
- **日志保留7年**：监管要求的最低保留期限
- **合规报告**：定期向监管机构提交报告

### 4.2 全链路审计日志设计

**审计日志的核心要素**（5W1H）：

```java
public class AuditLog {
    private String traceId;       // 链路追踪ID（贯穿整个请求链路）
    private String spanId;        // 当前操作的spanID
    private String userId;        // 操作人
    private String userName;      // 操作人姓名
    private String userRole;      // 操作人角色
    private String clientIp;      // 客户端IP
    private String targetResource;// 操作对象（如账户号）
    private String action;        // 操作类型（QUERY/TRANSFER/APPROVE）
    private String method;        // 接口方法名
    private String requestParams; // 请求参数（脱敏后）
    private String responseCode;  // 响应码
    private String responseMsg;   // 响应消息
    private Long   duration;      // 耗时
    private LocalDateTime timestamp; // 操作时间
    private String deviceInfo;    // 设备信息
    private String riskLevel;     // 风险等级（LOW/MEDIUM/HIGH）
}
```

**全链路日志采集方案**：

```
客户端 → API Gateway → 业务服务 → 数据库
   │           │            │          │
   └───────────┴────────────┴──────────┘
                ↓
           日志收集器（Filebeat/Fluentd）
                ↓
           消息队列（Kafka）
                ↓
           日志处理（Logstash/Flink）
                ↓
           存储（Elasticsearch）
                ↓
           可视化（Kibana）
```

### 4.3 敏感操作日志

敏感操作需要额外记录，且不能与普通日志混淆：

```java
@Aspect
@Component
public class SensitiveOperationAspect {

    @Around("@annotation(sensitiveOp)")
    public Object logSensitiveOperation(ProceedingJoinPoint pjp, SensitiveOperation sensitiveOp) throws Throwable {
        SensitiveAuditLog log = new SensitiveAuditLog();
        log.setOperation(sensitiveOp.value());
        log.setOperator(UserContext.getCurrentUserId());
        log.setTimestamp(LocalDateTime.now());

        // 记录请求参数（脱敏后）
        Object[] args = pjp.getArgs();
        log.setParams(maskSensitiveData(args));

        try {
            Object result = pjp.proceed();
            log.setResult("SUCCESS");
            log.setResultSummary(maskSensitiveData(result));
            return result;
        } catch (Exception e) {
            log.setResult("FAILURE");
            log.setErrorMessage(e.getMessage());
            throw e;
        } finally {
            // 写入专门的审计日志存储（与业务数据库分离）
            sensitiveAuditLogService.save(log);
        }
    }

    private Object maskSensitiveData(Object data) {
        // 脱敏处理：手机号→138****1234，身份证→110***********1234
        return DataMasker.deepMask(data);
    }
}

// 使用示例
@SensitiveOperation("大额转账审批")
@PostMapping("/transfer/approve")
public Result approveTransfer(@RequestBody TransferApprovalRequest request) {
    // 审批逻辑
}
```

### 4.4 日志存储方案（保留7年）

**存储策略：热温冷分级**

```
热数据（0-7天）：Elasticsearch集群，SSD存储，支持实时查询
    存储格式：JSON索引
    副本数：2
    查询延迟：< 1秒

温数据（7天-6个月）：Elasticsearch集群，HDD存储
    存储格式：JSON索引
    副本数：1
    查询延迟：< 5秒

冷数据（6个月-7年）：对象存储（S3/MinIO） + Parquet格式
    存储格式：Parquet列式存储，按日期分区
    副本数：3（跨机房）
    查询延迟：分钟级（需要时通过Presto/Spark查询）

过期处理（7年后）：安全销毁（符合数据保留政策）
```

**ELK架构**：

```
Filebeat(每台应用服务器)
    ↓
Kafka(日志缓冲，削峰)
    ↓
Logstash(日志解析、字段提取、脱敏校验)
    ↓
Elasticsearch(热/温数据)
    ↓
Kibana(可视化、告警)
```

```yaml
# Filebeat配置
filebeat.inputs:
  - type: log
    paths:
      - /var/log/bank/app-audit.log
    json.keys_under_root: true
    fields:
      log_type: audit
    fields_under_root: true

output.kafka:
  hosts: ["kafka1:9092", "kafka2:9092", "kafka3:9092"]
  topic: "audit-logs"
  partition.round_robin:
    reachable_only: true
  required_acks: 1
  compression: gzip
```

### 4.5 日志查询与审计

审计人员通常需要以下查询能力：

```java
// 审计查询服务
@Component
public class AuditQueryService {

    @Autowired
    private ElasticsearchClient esClient;

    // 查询某个用户的所有操作
    public List<AuditLog> queryByUser(String userId, LocalDateTime from, LocalDateTime to) {
        SearchResponse<AuditLog> response = esClient.search(s -> s
            .index("audit-logs-*")
            .query(q -> q.bool(b -> b
                .must(m -> m.term(t -> t.field("userId").value(userId)))
                .must(m -> m.range(r -> r.field("timestamp")
                    .gte(JsonData.of(from.toString()))
                    .lte(JsonData.of(to.toString()))))
            ))
            .sort(so -> so.field(f -> f.field("timestamp").order(SortOrder.Desc)))
            .size(1000),
            AuditLog.class
        );
        return response.hits().hits().stream()
            .map(hit -> hit.source())
            .collect(Collectors.toList());
    }

    // 查询某个账户的所有交易
    public List<AuditLog> queryByAccount(String accountNo, LocalDateTime from, LocalDateTime to) {
        // 类似实现
    }

    // 查询高风险操作
    public List<AuditLog> queryHighRiskOps(LocalDateTime from, LocalDateTime to) {
        SearchResponse<AuditLog> response = esClient.search(s -> s
            .index("audit-logs-*")
            .query(q -> q.bool(b -> b
                .must(m -> m.term(t -> t.field("riskLevel").value("HIGH")))
                .must(m -> m.range(r -> r.field("timestamp")
                    .gte(JsonData.of(from.toString()))
                    .lte(JsonData.of(to.toString()))))
            ))
            .size(1000),
            AuditLog.class
        );
        return response.hits().hits().stream()
            .map(hit -> hit.source())
            .collect(Collectors.toList());
    }
}
```

---

## 五、灰度发布与回滚方案

### 5.1 银行系统上线的特殊挑战

银行核心系统的上线不同于普通互联网应用：
- 不允许停机（99.99%可用性要求）
- 数据变更必须向后兼容（不能因为新版本导致旧数据读不了）
- 出问题需要秒级回滚
- 新功能可能影响资金计算，必须逐步验证

### 5.2 灰度发布方案

**流量灰度策略**：

```
灰度阶段:
  阶段1(金丝雀): 内部测试账号 → 1%流量 → 验证基本功能
  阶段2(小流量): 5%流量 → 验证性能和稳定性
  阶段3(中流量): 20%流量 → 验证业务指标
  阶段4(大流量): 50% → 80% → 100%
```

**灰度路由实现**：

```java
@Component
public class GrayscaleRouter {

    @Autowired
    private GrayscaleConfig config;

    /**
     * 决定请求路由到新版还是旧版
     */
    public String route(HttpServletRequest request) {
        String userId = UserContext.getCurrentUserId();
        String target = "stable"; // 默认走稳定版

        // 规则1：白名单用户强制走新版
        if (config.getWhitelistUsers().contains(userId)) {
            return "canary";
        }

        // 规则2：按用户ID哈希取模，决定流量比例
        int hash = Math.abs(userId.hashCode()) % 10000;
        if (hash < config.getGrayscalePercent() * 100) {
            return "canary";
        }

        return target;
    }
}
```

在网关层实现路由：

```java
@Component
public class GrayscaleGatewayFilter implements GlobalFilter {

    @Autowired
    private GrayscaleRouter router;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String target = router.route(exchange.getRequest());

        if ("canary".equals(target)) {
            // 路由到新版服务实例
            exchange.getRequest().mutate()
                .header("X-Grayscale", "canary")
                .build();
            // 修改路由目标为canary服务
            Route route = exchange.getAttribute(GATEWAY_ROUTE_ATTR);
            // 修改route的uri为canary服务地址
        }

        return chain.filter(exchange);
    }
}
```

### 5.3 数据兼容性

灰度发布的核心难点是**数据兼容性**——新旧版本的服务可能同时访问同一个数据库。

**原则：只加不改不删**

```
数据库变更兼容性规则:
  ✅ 新增表 → 旧版不访问，兼容
  ✅ 新增列（有默认值） → 旧版忽略，兼容
  ❌ 修改列类型 → 可能不兼容，禁止
  ❌ 删除列 → 旧版会报错，禁止
  ❌ 重命名列 → 旧版会报错，禁止

如果必须改字段：
  1. 先新增列 new_column
  2. 新版代码同时写 old_column 和 new_column
  3. 旧版代码仍然读 old_column
  4. 全量切换到新版后，停止写 old_column
  5. 确认旧版下线后，删除 old_column
```

**API兼容性**：

```
API变更兼容性规则:
  ✅ 新增接口 → 旧客户端不调用，兼容
  ✅ 新增返回字段 → 旧客户端忽略，兼容
  ✅ 新增请求参数（有默认值） → 旧客户端不传，兼容
  ❌ 删除接口 → 旧客户端报错，禁止
  ❌ 删除返回字段 → 旧客户端取值为空，可能异常
  ❌ 修改参数类型 → 旧客户端报错，禁止
```

### 5.4 快速回滚方案

**方案一：蓝绿部署**
```
蓝环境（当前版本） ← 100%流量
绿环境（新版本） ← 0%流量（部署和测试）

发布流程：
1. 在绿环境部署新版本
2. 测试绿环境
3. 切换流量到绿环境
4. 如果出问题，秒级切回蓝环境

回滚时间：< 1分钟（只需要修改路由规则）
```

**方案二：金丝雀发布 + 快速摘除**
```
旧版本集群（80%流量）
新版本集群（20%流量）

回滚：
1. 监控检测到异常指标
2. 将新版本实例从负载均衡摘除
3. 流量全部回到旧版本
4. 回滚时间：< 30秒
```

**方案三：代码级回滚（Feature Toggle）**

```java
@Component
public class FeatureToggle {

    @Autowired
    private ConfigCenter configCenter;

    public boolean isEnabled(String featureKey) {
        // 从配置中心（如Apollo、Nacos）动态读取开关状态
        return configCenter.getBoolean(featureKey, false);
    }
}

// 业务代码中使用
public TransferResult transfer(TransferRequest request) {
    if (featureToggle.isEnabled("new_transfer_validation_v2")) {
        return newTransferService.transfer(request);
    } else {
        return oldTransferService.transfer(request);
    }
}

// 回滚时：通过配置中心关闭开关，秒级生效
```

### 5.5 监控指标与自动回滚

```java
@Component
public class GrayscaleMonitor {

    // 监控新版本的关键指标
    @Scheduled(fixedDelay = 30000) // 每30秒检查一次
    public void checkCanaryHealth() {
        CanaryMetrics metrics = metricsCollector.collectCanaryMetrics();

        // 错误率
        if (metrics.getErrorRate() > 0.01) { // 1%
            log.warn("Canary error rate too high: {}", metrics.getErrorRate());
            triggerRollback("ERROR_RATE_HIGH");
        }

        // 延迟
        if (metrics.getP99Latency() > 500) { // 500ms
            log.warn("Canary P99 latency too high: {}ms", metrics.getP99Latency());
            triggerRollback("LATENCY_HIGH");
        }

        // 业务指标
        if (metrics.getTransferSuccessRate() < 0.99) { // 成功率低于99%
            log.warn("Canary transfer success rate too low: {}", metrics.getTransferSuccessRate());
            triggerRollback("SUCCESS_RATE_LOW");
        }
    }

    private void triggerRollback(String reason) {
        log.error("Triggering automatic rollback, reason: {}", reason);
        grayscaleService.rollback();
        alertService.sendAlert("灰度发布自动回滚，原因：" + reason);
    }
}
```

---

## 常见坑

架构层面的坑往往代价最大，影响范围最广：

- **分库分表跨库 JOIN**：拆分后发现业务上有大量跨库查询需求（如查同一用户在不同机构的账户），被迫把数据冗余一份到 ES 做聚合查询，运维成本翻倍。分库维度一定要提前和业务方确认查询模式。
- **同城双活但数据没隔离**：两个机房都能写同一个账户，出现数据冲突。必须确保同一用户的写操作只路由到一个机房。
- **风控规则引擎没有降级方案**：规则引擎依赖的外部服务（如 IP 地理位置查询）挂了，整个风控链路超时，交易被误拦截。必须有降级策略——外部服务不可用时跳过该规则，而不是阻塞交易。
- **CEP 窗口时间设置不当**：窗口太短（5分钟），用户跨设备操作被遗漏；窗口太长（1小时），内存压力大且告警不及时。需要根据实际欺诈模式数据调整。
- **审计日志和业务日志存同一个 ES 集群**：审计日志量巨大，把业务日志的查询性能拖垮了。审计日志必须独立集群。
- **灰度发布数据库字段直接改名**：灰度期间新旧版本共存，旧版本代码读不到改名后的字段直接报错。必须遵循"先加后改再删"的三步流程。
- **Feature Toggle 没有超时自动回退**：灰度开关打开了但忘记手动关闭，新旧版本长期共存，代码维护成本越来越高。应该设置灰度超时自动回退。
- **多活故障切换没有演练**：架构图画得很漂亮但从没实际演练过，真出故障时切流脚本跑不通、数据同步不一致。必须每季度做一次故障切换演练。
- **自动回滚阈值设置太敏感**：错误率阈值设 0.1%，正常的偶发抖动就触发回滚，灰度永远推不上去。阈值需要基于历史数据合理设定，并设置连续 N 次超过阈值才触发。

---

## Checklist

架构评审时逐项检查：

- [ ] 分库分表维度已和业务方确认查询模式，不存在高频跨库查询
- [ ] 同城双活的流量路由保证同一用户只写一个机房
- [ ] 风控规则引擎有降级策略，外部依赖不可用时不阻塞交易
- [ ] 审计日志独立存储，不和业务日志共享 ES 集群
- [ ] 灰度发布遵循"只加不改不删"的数据兼容原则
- [ ] Feature Toggle 有超时自动回退机制
- [ ] 自动回滚阈值基于历史数据设定，有连续 N 次触发逻辑
- [ ] 故障切换流程每季度演练一次，演练结果有记录
- [ ] 冷数据存储方案已到位（Parquet + S3），7 年保留策略已配置
- [ ] 全链路 traceId 贯穿所有服务，审计日志可通过 traceId 串联
