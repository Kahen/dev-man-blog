---
title: "字节跳动Java后端面试深度解析（五）：DDD 领域建模实战 — 从 AI 绘画订单看聚合根、实体与领域事件"
published: 2026-05-19
description: 以DDD思想对AI绘画订单进行领域建模，识别聚合根Order、实体ImageTask、值对象PaintingStyle和领域事件，附完整Java实现代码。
tags: [面试, Java, DDD, 领域驱动设计, 聚合根, 领域事件, Spring Boot]
category: Architecture
lang: zh_CN
---

产品经理提了一个需求："用户下单 AI 绘画，选风格、传参考图、付钱，然后等 AI 出图。出图后用户可以选择满意的一张下载，不满意可以免费重绘两次。"

拿到需求后，很多人的第一反应是建一张 order 表、一张 image_task 表，然后在 Service 层堆业务逻辑。但很快就会发现：订单状态和图片任务状态互相耦合，"免费重绘次数"的扣减逻辑散落在各个 Service 方法里，代码越来越难维护。

这篇文章用 DDD（领域驱动设计）的思想重新建模，把业务规则内聚到领域对象中。

---

## 一、需求分析与领域划分

### 1.1 业务流程

```
用户选择风格 + 上传参考图 + 填写 Prompt
            ↓
        创建订单（Order）
            ↓
        支付（Payment）
            ↓
    ┌─── AI 生成图片（ImageTask × N）
    │       ↓
    │   用户选择 / 重绘
    │       ↓
    └─── 下载最终图片
            ↓
        订单完成
```

### 1.2 领域概念识别

| 概念 | 类型 | 说明 |
|------|------|------|
| Order | 聚合根 | 订单的生命周期管理者 |
| ImageTask | 实体 | 单次 AI 生成任务 |
| PaintingStyle | 值对象 | 绘画风格（不可变） |
| Prompt | 值对象 | 用户输入的提示词 |
| ReferenceImage | 值对象 | 参考图片信息 |
| Money | 值对象 | 金额（包含币种） |
| OrderCreated | 领域事件 | 订单创建 |
| ImageGenerated | 领域事件 | 图片生成完成 |
| OrderCompleted | 领域事件 | 订单完成 |

---

## 二、值对象设计

### 2.1 值对象的核心特征

值对象（Value Object）是**不可变的、没有唯一标识的、通过属性值判断相等性**的对象。在 Java 中用 `record` 实现最合适。

### 2.2 PaintingStyle

```java
/**
 * 绘画风格 — 值对象
 * 不可变，通过 name 判断相等性
 */
public record PaintingStyle(
    String name,           // 风格名称，如 "油画"、"赛博朋克"
    String description,    // 风格描述
    String promptSuffix,   // 自动追加到用户 Prompt 后的风格指令
    int estimatedSeconds   // 该风格预估生成时间（秒）
) {
    public PaintingStyle {
        if (name == null || name.isBlank()) {
            throw new IllegalArgumentException("Style name cannot be blank");
        }
        if (estimatedSeconds <= 0) {
            throw new IllegalArgumentException("Estimated seconds must be positive");
        }
    }

    // 预定义风格
    public static final PaintingStyle OIL_PAINTING = new PaintingStyle(
        "油画", "经典油画风格，色彩浓郁", "in oil painting style, vibrant colors", 60
    );
    public static final PaintingStyle CYBERPUNK = new PaintingStyle(
        "赛博朋克", "未来科技风格，霓虹色调", "cyberpunk style, neon lights", 90
    );
    public static final PaintingStyle WATERCOLOR = new PaintingStyle(
        "水彩", "清新水彩风格，柔和色调", "watercolor style, soft tones", 45
    );
}
```

### 2.3 Money

```java
public record Money(
    BigDecimal amount,
    Currency currency
) {
    public Money {
        if (amount == null || amount.compareTo(BigDecimal.ZERO) < 0) {
            throw new IllegalArgumentException("Amount must be non-negative");
        }
        if (currency == null) {
            throw new IllegalArgumentException("Currency cannot be null");
        }
    }

    public static Money of(BigDecimal amount, String currencyCode) {
        return new Money(amount, Currency.getInstance(currencyCode));
    }

    public static Money cny(BigDecimal amount) {
        return new Money(amount, Currency.getInstance("CNY"));
    }

    public Money add(Money other) {
        if (!this.currency.equals(other.currency)) {
            throw new IllegalArgumentException("Cannot add different currencies");
        }
        return new Money(this.amount.add(other.amount), this.currency);
    }

    public Money subtract(Money other) {
        if (!this.currency.equals(other.currency)) {
            throw new IllegalArgumentException("Cannot subtract different currencies");
        }
        BigDecimal result = this.amount.subtract(other.amount);
        if (result.compareTo(BigDecimal.ZERO) < 0) {
            throw new IllegalArgumentException("Result cannot be negative");
        }
        return new Money(result, this.currency);
    }
}
```

### 2.4 Prompt

```java
public record Prompt(
    String text,
    String language,
    List<String> negativeTags  // 不希望出现的元素
) {
    public Prompt {
        if (text == null || text.isBlank()) {
            throw new IllegalArgumentException("Prompt text cannot be blank");
        }
        if (text.length() > 2000) {
            throw new IllegalArgumentException("Prompt too long (max 2000 chars)");
        }
        negativeTags = negativeTags == null ? List.of() : List.copyOf(negativeTags);
    }

    /** 将风格后缀追加到 prompt */
    public String withStyle(PaintingStyle style) {
        return text + ", " + style.promptSuffix();
    }

    /** 生成完整的 negative prompt */
    public String fullNegativePrompt() {
        return String.join(", ", negativeTags);
    }
}
```

---

## 三、实体设计

### 3.1 ImageTask

```java
/**
 * 图片生成任务 — 实体
 * 有唯一标识（taskId），生命周期独立于 Order
 */
public class ImageTask {

    public enum Status {
        QUEUED,       // 排队中
        GENERATING,   // AI 生成中
        COMPLETED,    // 生成完成
        FAILED,       // 生成失败
        CANCELLED     // 已取消
    }

    private final String taskId;
    private final String orderId;
    private final Prompt prompt;
    private final PaintingStyle style;
    private final ReferenceImage referenceImage;
    private Status status;
    private String generatedImageUrl;
    private String errorMessage;
    private int attemptNumber;  // 第几次尝试（重绘）
    private final LocalDateTime createdAt;
    private LocalDateTime completedAt;

    public ImageTask(String orderId, Prompt prompt, PaintingStyle style,
                     ReferenceImage referenceImage, int attemptNumber) {
        this.taskId = UUID.randomUUID().toString();
        this.orderId = Objects.requireNonNull(orderId);
        this.prompt = Objects.requireNonNull(prompt);
        this.style = Objects.requireNonNull(style);
        this.referenceImage = referenceImage;
        this.attemptNumber = attemptNumber;
        this.status = Status.QUEUED;
        this.createdAt = LocalDateTime.now();
    }

    /** 标记为生成中 */
    public void markGenerating() {
        if (status != Status.QUEUED) {
            throw new IllegalStateException(
                "Cannot start generating from status: " + status);
        }
        this.status = Status.GENERATING;
    }

    /** 生成完成 */
    public void complete(String imageUrl) {
        if (status != Status.GENERATING) {
            throw new IllegalStateException(
                "Cannot complete from status: " + status);
        }
        this.generatedImageUrl = Objects.requireNonNull(imageUrl);
        this.status = Status.COMPLETED;
        this.completedAt = LocalDateTime.now();
    }

    /** 生成失败 */
    public void fail(String errorMessage) {
        this.errorMessage = errorMessage;
        this.status = Status.FAILED;
        this.completedAt = LocalDateTime.now();
    }

    public boolean isCompleted() { return status == Status.COMPLETED; }
    public boolean isFailed() { return status == Status.FAILED; }
    public boolean isTerminal() {
        return status == Status.COMPLETED
            || status == Status.FAILED
            || status == Status.CANCELLED;
    }

    // getter 方法省略
}
```

---

## 四、聚合根设计

### 4.1 Order（聚合根）

```java
/**
 * AI 绘画订单 — 聚合根
 * 职责：管理订单生命周期、图片任务列表、重绘次数、金额计算
 */
public class Order {

    public enum Status {
        CREATED,      // 已创建，待支付
        PAID,         // 已支付
        PROCESSING,   // 生成中
        COMPLETED,    // 已完成
        CANCELLED,    // 已取消
        REFUNDED      // 已退款
    }

    // 最大免费重绘次数
    public static final int MAX_FREE_REDRAWS = 2;

    private final String orderId;
    private final String userId;
    private final Prompt prompt;
    private final PaintingStyle style;
    private final ReferenceImage referenceImage;
    private final int imageCount;           // 需要生成的图片数量
    private final Money unitPrice;
    private Status status;
    private final List<ImageTask> imageTasks;
    private int freeRedrawsRemaining;       // 剩余免费重绘次数
    private final List<DomainEvent> pendingEvents;  // 待发布的领域事件
    private final LocalDateTime createdAt;
    private LocalDateTime paidAt;
    private LocalDateTime completedAt;

    /** 创建订单（工厂方法） */
    public static Order create(
            String userId,
            Prompt prompt,
            PaintingStyle style,
            ReferenceImage referenceImage,
            int imageCount,
            Money unitPrice) {

        if (imageCount <= 0 || imageCount > 10) {
            throw new IllegalArgumentException("Image count must be 1-10");
        }

        Order order = new Order();
        order.orderId = UUID.randomUUID().toString();
        order.userId = Objects.requireNonNull(userId);
        order.prompt = Objects.requireNonNull(prompt);
        order.style = Objects.requireNonNull(style);
        order.referenceImage = referenceImage;
        order.imageCount = imageCount;
        order.unitPrice = Objects.requireNonNull(unitPrice);
        order.status = Status.CREATED;
        order.imageTasks = new ArrayList<>();
        order.freeRedrawsRemaining = MAX_FREE_REDRAWS;
        order.pendingEvents = new ArrayList<>();
        order.createdAt = LocalDateTime.now();

        // 发布领域事件
        order.pendingEvents.add(new OrderCreated(
            order.orderId,
            order.userId,
            order.totalPrice().amount(),
            order.style.name(),
            order.createdAt
        ));

        return order;
    }

    /** 支付成功 */
    public void markPaid() {
        if (status != Status.CREATED) {
            throw new IllegalStateException("Can only pay for CREATED orders");
        }
        this.status = Status.PAID;
        this.paidAt = LocalDateTime.now();

        // 支付后自动创建图片任务
        createImageTasks();
    }

    /** 创建图片任务 */
    private void createImageTasks() {
        for (int i = 0; i < imageCount; i++) {
            ImageTask task = new ImageTask(
                orderId, prompt, style, referenceImage, 1);
            imageTasks.add(task);
        }
        this.status = Status.PROCESSING;
    }

    /** 图片生成完成回调 */
    public void onImageCompleted(String taskId, String imageUrl) {
        ImageTask task = findTask(taskId);
        task.complete(imageUrl);

        pendingEvents.add(new ImageGenerated(
            orderId, taskId, imageUrl, LocalDateTime.now()
        ));

        // 检查是否所有图片都完成了
        if (imageTasks.stream().allMatch(ImageTask::isCompleted)) {
            this.status = Status.COMPLETED;
            this.completedAt = LocalDateTime.now();
            pendingEvents.add(new OrderCompleted(
                orderId, userId, completedAt
            ));
        }
    }

    /** 请求重绘 */
    public ImageTask requestRedraw(String originalTaskId) {
        ImageTask originalTask = findTask(originalTaskId);
        if (!originalTask.isCompleted()) {
            throw new IllegalStateException("Can only redraw completed tasks");
        }

        // 检查免费重绘次数
        if (freeRedrawsRemaining <= 0) {
            throw new NoFreeRedrawsException(orderId);
        }

        freeRedrawsRemaining--;

        // 创建新的图片任务（attemptNumber + 1）
        ImageTask newTask = new ImageTask(
            orderId,
            prompt,        // 使用原始 prompt
            style,
            referenceImage,
            originalTask.getAttemptNumber() + 1
        );
        imageTasks.add(newTask);

        return newTask;
    }

    /** 计算总价 */
    public Money totalPrice() {
        return new Money(
            unitPrice.amount().multiply(BigDecimal.valueOf(imageCount)),
            unitPrice.currency()
        );
    }

    /** 取消订单 */
    public void cancel() {
        if (status == Status.COMPLETED) {
            throw new IllegalStateException("Cannot cancel completed order");
        }
        if (status == Status.PROCESSING) {
            // 取消所有进行中的任务
            imageTasks.stream()
                .filter(t -> !t.isTerminal())
                .forEach(t -> t.cancel());
        }
        this.status = Status.CANCELLED;
    }

    /** 获取所有待发布的领域事件并清空 */
    public List<DomainEvent> collectPendingEvents() {
        List<DomainEvent> events = List.copyOf(pendingEvents);
        pendingEvents.clear();
        return events;
    }

    private ImageTask findTask(String taskId) {
        return imageTasks.stream()
            .filter(t -> t.getTaskId().equals(taskId))
            .findFirst()
            .orElseThrow(() -> new TaskNotFoundException(taskId));
    }

    // getter 方法省略
}
```

---

## 五、领域事件

### 5.1 事件定义

```java
/** 领域事件基础接口 */
public sealed interface DomainEvent permits
    OrderCreated, ImageGenerated, OrderCompleted, OrderCancelled {

    String eventId();
    LocalDateTime occurredAt();
    String eventType();
}

/** 订单创建事件 */
public record OrderCreated(
    String eventId,
    String orderId,
    String userId,
    BigDecimal totalAmount,
    String styleName,
    LocalDateTime occurredAt
) implements DomainEvent {

    public OrderCreated(String orderId, String userId,
                        BigDecimal totalAmount, String styleName,
                        LocalDateTime occurredAt) {
        this(UUID.randomUUID().toString(), orderId, userId,
             totalAmount, styleName, occurredAt);
    }

    @Override
    public String eventType() { return "order.created"; }
}

/** 图片生成完成事件 */
public record ImageGenerated(
    String eventId,
    String orderId,
    String taskId,
    String imageUrl,
    LocalDateTime occurredAt
) implements DomainEvent {

    public ImageGenerated(String orderId, String taskId,
                          String imageUrl, LocalDateTime occurredAt) {
        this(UUID.randomUUID().toString(), orderId, taskId, imageUrl, occurredAt);
    }

    @Override
    public String eventType() { return "image.generated"; }
}

/** 订单完成事件 */
public record OrderCompleted(
    String eventId,
    String orderId,
    String userId,
    LocalDateTime occurredAt
) implements DomainEvent {

    public OrderCompleted(String orderId, String userId, LocalDateTime occurredAt) {
        this(UUID.randomUUID().toString(), orderId, userId, occurredAt);
    }

    @Override
    public String eventType() { return "order.completed"; }
}

/** 订单取消事件 */
public record OrderCancelled(
    String eventId,
    String orderId,
    String reason,
    LocalDateTime occurredAt
) implements DomainEvent {

    @Override
    public String eventType() { return "order.cancelled"; }
}
```

### 5.2 事件发布

```java
@Component
public class DomainEventPublisher {

    private final ApplicationEventPublisher springPublisher;
    private final KafkaTemplate<String, Object> kafkaTemplate;

    /**
     * 发布聚合根中的待处理事件
     * 在 Repository 的 save 方法中调用
     */
    public void publishEvents(Order order) {
        List<DomainEvent> events = order.collectPendingEvents();
        for (DomainEvent event : events) {
            // 本地事件（Spring Event）
            springPublisher.publishEvent(event);
            // 跨服务事件（Kafka）
            kafkaTemplate.send("order-events", event.eventType(), event);
        }
    }
}
```

### 5.3 事件消费者

```java
@Component
public class OrderEventHandlers {

    @KafkaListener(topics = "order-events", groupId = "notification-service")
    public void handleOrderEvent(DomainEvent event) {
        switch (event) {
            case OrderCreated e -> {
                // 发送订单创建通知
                notificationService.sendOrderCreatedNotification(
                    e.userId(), e.orderId());
                // 记录分析埋点
                analyticsService.track("order_created", Map.of(
                    "orderId", e.orderId(),
                    "style", e.styleName(),
                    "amount", e.totalAmount()
                ));
            }
            case ImageGenerated e -> {
                // 发送图片生成完成通知
                notificationService.sendImageReadyNotification(
                    e.orderId(), e.imageUrl());
            }
            case OrderCompleted e -> {
                // 发送订单完成通知
                notificationService.sendOrderCompletedNotification(
                    e.userId(), e.orderId());
            }
            case OrderCancelled e -> {
                // 处理退款逻辑
                paymentService.refund(e.orderId(), e.reason());
            }
        }
    }
}
```

---

## 六、Repository 与持久化

### 6.1 Repository 接口（领域层）

```java
/**
 * 订单仓储接口 — 定义在领域层
 * 实现在基础设施层，领域层不依赖具体持久化技术
 */
public interface OrderRepository {
    Order findById(String orderId);
    Order findByUserIdAndId(String userId, String orderId);
    void save(Order order);
    List<Order> findByUserId(String userId, Pageable pageable);
}
```

### 6.2 Repository 实现（基础设施层）

```java
@Repository
public class JpaOrderRepository implements OrderRepository {

    private final OrderJpaRepository jpaRepo;
    private final OrderEventPublisher eventPublisher;

    @Override
    @Transactional
    public void save(Order order) {
        // 1. 转换为持久化实体
        OrderEntity entity = OrderMapper.toEntity(order);
        jpaRepo.save(entity);

        // 2. 发布领域事件
        eventPublisher.publishEvents(order);
    }

    @Override
    public Order findById(String orderId) {
        OrderEntity entity = jpaRepo.findById(orderId)
            .orElseThrow(() -> new OrderNotFoundException(orderId));
        return OrderMapper.toDomain(entity);
    }
}
```

---

## 七、应用服务（编排层）

```java
@Service
@Transactional
public class OrderApplicationService {

    private final OrderRepository orderRepository;
    private final PaymentGateway paymentGateway;
    private final AiGenerationService aiService;

    /** 创建订单并发起支付 */
    public OrderDTO createOrder(CreateOrderCommand command) {
        // 1. 创建订单（聚合根内部完成业务规则校验）
        Order order = Order.create(
            command.userId(),
            command.prompt(),
            command.style(),
            command.referenceImage(),
            command.imageCount(),
            command.unitPrice()
        );

        // 2. 持久化（同时发布领域事件）
        orderRepository.save(order);

        // 3. 返回 DTO
        return OrderDTO.from(order);
    }

    /** 支付回调 */
    @Transactional
    public void onPaymentSuccess(String orderId, String paymentId) {
        Order order = orderRepository.findById(orderId);
        order.markPaid();  // 聚合根内部处理状态流转和任务创建
        orderRepository.save(order);

        // 触发 AI 生成任务
        for (ImageTask task : order.getImageTasks()) {
            aiService.submitGeneration(task);
        }
    }

    /** AI 生成完成回调 */
    @Transactional
    public void onImageGenerated(String orderId, String taskId, String imageUrl) {
        Order order = orderRepository.findById(orderId);
        order.onImageCompleted(taskId, imageUrl);
        orderRepository.save(order);
    }

    /** 请求重绘 */
    @Transactional
    public ImageTaskDTO requestRedraw(String userId, String orderId, String taskId) {
        Order order = orderRepository.findByUserIdAndId(userId, orderId);
        ImageTask newTask = order.requestRedraw(taskId);
        orderRepository.save(order);

        aiService.submitGeneration(newTask);
        return ImageTaskDTO.from(newTask);
    }
}
```

---

## 八、常见坑

**1. 聚合根边界过大**

把所有相关实体都放进一个聚合根会导致并发冲突和性能问题。Order 和 ImageTask 是聚合根内部的关系，但 Order 和 User 不是——User 应该是另一个聚合根。

**2. 在聚合根中依赖基础设施层**

聚合根不应该依赖 Repository、数据库连接、消息队列等基础设施。业务规则的校验和状态流转应该在聚合根内部完成，持久化和事件发布由应用服务编排。

**3. 领域事件的发布时机**

领域事件应该在事务提交后发布，否则可能出现"事件发了但数据没落库"的情况。使用 Spring 的 `@TransactionalEventListener(phase = AFTER_COMMIT)` 或在 Repository 实现中手动控制。

**4. 值对象的相等性判断**

Java record 自动实现了 `equals()` 和 `hashCode()`，基于所有字段判断相等性。但如果值对象包含可变字段（如 List），需要注意 `List.copyOf()` 保证不可变性。

**5. 重绘逻辑的边界情况**

免费重绘次数是订单级别的，不是图片级别的。如果用户有 3 张图片，免费重绘 2 次，用户可以选择给哪张图重绘，但总共只能免费重绘 2 次。

---

## 九、上线 Checklist

- [ ] 聚合根内部的所有状态流转都有前置条件校验，不会出现非法状态跳转
- [ ] 领域事件在事务提交后才发布，保证数据一致性
- [ ] 值对象都是不可变的，没有 setter 方法
- [ ] Repository 接口定义在领域层，实现在基础设施层，依赖方向正确
- [ ] 聚合根的并发更新有乐观锁保护（version 字段）
- [ ] 重绘次数的扣减在聚合根内部完成，不会被绕过
- [ ] 领域事件的消费者有幂等处理（事件可能重复投递）

---

## 十、总结

DDD 领域建模的核心不是"写更多的类"，而是**让业务规则内聚到领域对象中**：

1. **值对象**封装了业务概念（风格、金额、提示词），保证了不可变性和类型安全
2. **实体**有唯一标识和生命周期，状态流转有严格的前置条件校验
3. **聚合根**是一致性边界，所有对内部实体的修改都通过聚合根的方法完成
4. **领域事件**解耦了聚合根之间的关系，让副作用（通知、分析、退款）异步化

> 业务逻辑在哪里，领域对象就在哪里。Service 层只做编排，不做业务判断。
