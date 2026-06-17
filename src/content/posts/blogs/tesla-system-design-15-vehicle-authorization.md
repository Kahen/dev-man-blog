---
title: "特斯拉级系统设计面试题（十五）：车主车辆授权系统 — 权限分级、有效期管理与撤销传播"
published: 2026-06-17
description: 从特斯拉车主授权他人使用车辆场景出发，拆解权限分级、临时授权、撤销传播三大核心挑战，深度解析 RBAC 模型、临时凭证、撤销机制、授权链、审计追踪，给出可落地的架构方案与 Kotlin 代码实现。
tags: [系统设计, 面试, 授权系统, RBAC, 临时凭证, 撤销传播, 后端架构]
category: Architecture
lang: zh_CN
---

2024 年一位 Model Y 车主把车借给朋友，结果朋友开了 3 天后不还，车主想撤销授权但系统说"已生效无法撤销"。最终车主只能报警。这个事故的根因是**授权撤销传播链设计有缺陷**——授权变更没有及时同步到车端。

车辆授权系统的"四大挑战"：

- **权限分级**：开锁、启动、驾驶、调节座椅、添加副驾驶员
- **临时授权**：按小时、按次数、按里程
- **撤销传播**：车端、云端、App 端实时同步
- **授权链审计**：谁授权给谁、何时生效、何时撤销

它不是"加个用户角色"那么简单，而是**"细粒度权限 + 临时凭证 + 撤销传播 + 审计追溯"**的综合性系统。

---

## 核心考察点

- **RBAC 权限模型**：基于角色的访问控制
- **临时凭证**：JWT、自定义 token
- **撤销传播**：事件驱动、车端同步
- **授权链**：多级授权的传递
- **审计追溯**：所有授权操作可追溯

> 面试误区：很多候选人只答"用 JWT + 角色"，没有考虑**撤销传播、临时凭证、审计追溯**这些工业级要素。

---

## 题目重述

**题目**：设计特斯拉车主车辆授权系统，支持：

1. **多级权限**：开锁、启动、限速、地理围栏等
2. **临时授权**：按时间、按次数、按里程
3. **多人授权**：车主授权家人、朋友、代驾
4. **实时撤销**：撤销后立即失效
5. **授权链审计**：可追溯每一次授权
6. **安全隔离**：被授权人不能二次授权
7. **多端同步**：车端、App 端、客服端实时一致

请给出整体架构、核心数据模型、关键流程、典型问题处理。

---

## 标准回答（架构设计）

### 1. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                  用户接入层 (App / Web / 客服)                 │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  授权服务 (Authorization Service)              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │
│  │ 权限管理  │  │ 凭证签发  │  │ 撤销服务  │  │ 审计服务  │    │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘    │
│       └──────────────┴──────────────┴──────────────┘         │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  实时同步层                                    │
│  - 事件总线  - 车端推送  - 多端同步                            │
└────────────────────────┬────────────────────────────────────┘
                         │
┌────────────────────────▼────────────────────────────────────┐
│                  存储层                                        │
│  MySQL (授权关系) │ Redis (凭证) │ Kafka (事件)             │
└──────────────────────────────────────────────────────────────┘
```

### 2. 核心数据模型

```sql
-- 1. 授权关系表
CREATE TABLE vehicle_authorization (
    auth_id         VARCHAR(64)  NOT NULL,
    vehicle_id      VARCHAR(32)  NOT NULL,
    grantor_id      BIGINT       NOT NULL COMMENT '授权人',
    grantee_id      BIGINT       NOT NULL COMMENT '被授权人',
    permissions     JSON         NOT NULL COMMENT '权限列表',
    valid_from      DATETIME(3)  NOT NULL,
    valid_to        DATETIME(3)  NULL COMMENT 'null=永久',
    max_uses        INT          NULL COMMENT '最多使用次数',
    used_count      INT          NOT NULL DEFAULT 0,
    max_mileage_km  INT          NULL,
    status          VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE/REVOKED/EXPIRED',
    revoked_at      DATETIME(3)  NULL,
    revoked_by      BIGINT       NULL,
    revoke_reason   VARCHAR(256) NULL,
    created_at      DATETIME(3)  NOT NULL,
    PRIMARY KEY (auth_id),
    INDEX idx_vehicle (vehicle_id, status),
    INDEX idx_grantee (grantee_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 授权使用记录
CREATE TABLE auth_usage_log (
    log_id          BIGINT       NOT NULL AUTO_INCREMENT,
    auth_id         VARCHAR(64)  NOT NULL,
    vehicle_id      VARCHAR(32)  NOT NULL,
    grantee_id      BIGINT       NOT NULL,
    action          VARCHAR(32)  NOT NULL,
    result          VARCHAR(16)  NOT NULL,
    timestamp       DATETIME(3)  NOT NULL,
    PRIMARY KEY (log_id, timestamp),
    INDEX idx_auth (auth_id, timestamp)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  PARTITION BY RANGE (TO_DAYS(timestamp)) (
    PARTITION p202606 VALUES LESS THAN (TO_DAYS('2026-07-01'))
  );
```

### 3. 权限模型（细粒度）

```kotlin
/**
 * 细粒度权限定义
 */
enum class VehiclePermission(val code: String, val description: String) {
    UNLOCK("unlock", "解锁车辆"),
    START("start", "启动车辆"),
    DRIVE("drive", "驾驶车辆"),
    MAX_SPEED_100("max_speed_100", "限速 100km/h"),
    MAX_SPEED_80("max_speed_80", "限速 80km/h"),
    GEOFENCE("geofence", "地理围栏限制"),
    TIME_RESTRICT("time_restrict", "时间限制"),
    ADJUST_SEAT("adjust_seat", "调节座椅"),
    USE_AC("use_ac", "使用空调"),
    CHARGE("charge", "充电"),
    TRUNK("trunk", "后备箱"),
    ADD_DRIVER("add_driver", "添加副驾驶"),  // 重要：禁止二次授权
    OTA_UPDATE("ota_update", "OTA 升级")  // 仅车主
}

data class PermissionSet(
    val permissions: Set<VehiclePermission>,
    val maxSpeed: Int? = null,
    val geofence: Geofence? = null,
    val timeWindow: TimeWindow? = null,
    val maxMileageKm: Int? = null
)
```

### 4. 授权签发

```kotlin
/**
 * 授权签发服务
 */
@Service
class AuthorizationIssueService(
    private val authRepo: VehicleAuthorizationRepository,
    private val credentialService: CredentialService,
    private val eventBus: EventBus
) {
    /**
     * 签发授权
     */
    fun grant(request: GrantRequest): GrantResult {
        // 1. 验证授权人权限
        if (!isOwnerOrHasDelegateAuth(request.grantorId, request.vehicleId)) {
            return GrantResult.deny("授权人无权限")
        }
        
        // 2. 禁止被授权人再次授权
        if (request.permissions.contains(VehiclePermission.ADD_DRIVER)) {
            // 只有车主能添加副驾驶
            if (!isOwner(request.grantorId, request.vehicleId)) {
                return GrantResult.deny("仅车主能添加副驾驶")
            }
        }
        
        // 3. 创建授权关系
        val auth = authRepo.save(VehicleAuthorization(
            authId = UUID.randomUUID().toString(),
            vehicleId = request.vehicleId,
            grantorId = request.grantorId,
            granteeId = request.granteeId,
            permissions = request.permissions,
            validFrom = request.validFrom,
            validTo = request.validTo,
            maxUses = request.maxUses,
            maxMileageKm = request.maxMileageKm,
            status = "ACTIVE"
        ))
        
        // 4. 签发凭证
        val credential = credentialService.issue(
            authId = auth.authId,
            granteeId = request.granteeId,
            vehicleId = request.vehicleId,
            validTo = request.validTo
        )
        
        // 5. 同步到车端
        eventBus.publish("vehicle.auth.granted", AuthGrantedEvent(
            authId = auth.authId,
            vehicleId = request.vehicleId,
            granteeId = request.granteeId,
            credential = credential
        ))
        
        return GrantResult.success(auth.authId, credential)
    }
}
```

### 5. 凭证管理

```kotlin
/**
 * 凭证服务：签发 + 撤销
 */
@Service
class CredentialService(
    private val redisTemplate: RedisTemplate,
    private val jwtSigner: JwtSigner
) {
    /**
     * 签发凭证（JWT）
     */
    fun issue(
        authId: String,
        granteeId: Long,
        vehicleId: String,
        validTo: Instant?
    ): String {
        val claims = mapOf(
            "authId" to authId,
            "granteeId" to granteeId.toString(),
            "vehicleId" to vehicleId,
            "exp" to (validTo?.epochSecond ?: (Instant.now().plus(Duration.ofDays(365)).epochSecond))
        )
        val token = jwtSigner.sign(claims)
        
        // 凭证缓存（用于撤销）
        redisTemplate.opsForValue().set(
            "auth:credential:$authId",
            token,
            Duration.between(Instant.now(), validTo ?: Instant.now().plus(Duration.ofDays(365)))
        )
        
        return token
    }
    
    /**
     * 撤销凭证
     */
    fun revoke(authId: String) {
        // 1. 凭证加入黑名单
        redisTemplate.opsForValue().set(
            "auth:blacklist:$authId",
            "1",
            Duration.ofDays(7)  // 保留 7 天黑名单
        )
        
        // 2. 删除凭证缓存
        redisTemplate.delete("auth:credential:$authId")
    }
    
    /**
     * 验证凭证
     */
    fun verify(token: String): VerifyResult {
        val claims = jwtSigner.verify(token)
        val authId = claims["authId"] as String
        
        // 检查黑名单
        if (redisTemplate.hasKey("auth:blacklist:$authId") == true) {
            return VerifyResult.fail("CREDENTIAL_REVOKED")
        }
        
        return VerifyResult.success(claims)
    }
}
```

### 6. 撤销传播（核心难点）

```kotlin
/**
 * 撤销服务：实时传播到所有端
 */
@Service
class RevocationService(
    private val authRepo: VehicleAuthorizationRepository,
    private val credentialService: CredentialService,
    private val mqttClient: MqttClient,
    private val eventBus: EventBus
) {
    /**
     * 撤销授权
     */
    fun revoke(authId: String, operatorId: Long, reason: String): RevokeResult {
        // 1. 更新数据库
        val auth = authRepo.findById(authId) ?: return RevokeResult.fail("AUTH_NOT_FOUND")
        auth.status = "REVOKED"
        auth.revokedAt = Instant.now()
        auth.revokedBy = operatorId
        auth.revokeReason = reason
        authRepo.save(auth)
        
        // 2. 凭证加入黑名单
        credentialService.revoke(authId)
        
        // 3. 车端同步（MQTT 推送）
        mqttClient.publish(
            "vehicle/${auth.vehicleId}/auth/revoke",
            MqttMessage(
                JacksonUtil.toJson(mapOf(
                    "authId" to authId,
                    "granteeId" to auth.granteeId,
                    "timestamp" to Instant.now()
                )).toByteArray()
            ).apply { qos = 1 }
        )
        
        // 4. App 端推送
        pushService.push(
            userId = auth.granteeId,
            title = "授权已撤销",
            content = "您对车辆 ${auth.vehicleId} 的授权已被撤销"
        )
        
        // 5. 事件总线广播（其他服务订阅）
        eventBus.publish("auth.revoked", RevokedEvent(
            authId = authId,
            vehicleId = auth.vehicleId,
            granteeId = auth.granteeId
        ))
        
        return RevokeResult.success()
    }
}
```

### 7. 授权使用校验

```kotlin
/**
 * 授权使用校验（车端 + 云端双重）
 */
@Service
class AuthCheckService(
    private val authRepo: VehicleAuthorizationRepository,
    private val credentialService: CredentialService
) {
    /**
     * 校验是否有权限执行某操作
     */
    fun checkPermission(
        granteeId: Long,
        vehicleId: String,
        permission: VehiclePermission
    ): CheckResult {
        // 1. 查询有效授权
        val auth = authRepo.findValidAuthorization(granteeId, vehicleId)
            ?: return CheckResult.deny("NO_ACTIVE_AUTHORIZATION")
        
        // 2. 检查时间窗口
        val now = Instant.now()
        if (now.isBefore(auth.validFrom) || (auth.validTo != null && now.isAfter(auth.validTo))) {
            return CheckResult.deny("AUTHORIZATION_EXPIRED")
        }
        
        // 3. 检查使用次数
        if (auth.maxUses != null && auth.usedCount >= auth.maxUses) {
            return CheckResult.deny("MAX_USES_REACHED")
        }
        
        // 4. 检查具体权限
        if (!auth.permissions.contains(permission)) {
            return CheckResult.deny("PERMISSION_NOT_GRANTED")
        }
        
        return CheckResult.success(auth)
    }
}
```

---

## 追问深度

### Q1：被授权人能二次授权吗？

**答**：**禁止默认 + 可配置**。

```kotlin
// 除非明确授权 ADD_DRIVER 权限，否则不能二次授权
if (auth.permissions.contains(VehiclePermission.ADD_DRIVER) && 
    !isOwner(auth.granteeId, vehicleId)) {
    return GrantResult.deny("被授权人不能添加副驾驶")
}
```

### Q2：撤销后车端网络断开怎么办？

**答**：**车端本地缓存黑名单 + 心跳同步**。

```kotlin
// 车端本地黑名单缓存
class VehicleAuthCache {
    fun onRevokeNotify(authId: String) {
        localBlacklist.add(authId)
        // 立即生效
    }
}
```

### Q3：临时授权（1 小时）怎么实现？

**答**：**JWT exp + 服务端校验**。

```kotlin
// JWT exp 字段
val claims = mapOf(
    "exp" to Instant.now().plus(Duration.ofHours(1)).epochSecond
)
```

### Q4：多设备同时使用怎么管理？

**答**：**单设备 + 抢占式**。同一时间只能一个设备用蓝牙钥匙。

### Q5：授权过期后还有效吗？

**答**：**JWT 过期 + 数据库状态**。双重校验。

---

## 常见坑

**1. 撤销不同步到车端**：车端继续允许已撤销的用户。
**2. JWT 无法撤销**：用 JWT 但没黑名单机制。
**3. 二次授权失控**：被授权人能无限扩展权限。
**4. 时间窗口计算错误**：时区、跨天等边界问题。
**5. 授权链审计缺失**：无法追溯"谁授权给谁"。

---

## 可执行 Checklist

- [ ] 细粒度权限模型
- [ ] JWT 凭证签发
- [ ] 凭证黑名单机制
- [ ] 撤销传播（车端、App、客服）
- [ ] 二次授权控制
- [ ] 临时凭证（时间/次数/里程）
- [ ] 授权使用审计
- [ ] 多端同步一致性
- [ ] 异常处理（网络断、凭证过期）

---

## 写在最后

车辆授权系统的核心是**"权限可控 + 撤销可及 + 审计可追"**。授权错了可能威胁车辆安全，撤销慢了可能让车被开走。

**三大要点**：

- **权限细粒度**：不同人不同权限
- **撤销实时**：必须立即生效
- **审计完整**：所有操作可追溯

**下篇预告：第 16 篇 — 特斯拉自动驾驶数据备份系统（PB 级增量备份、异地容灾、快速恢复）**
