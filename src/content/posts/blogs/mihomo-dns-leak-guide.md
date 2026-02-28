---
title: 彻底解决 DNS 泄露：Mihomo (Clash Meta) 核心配置指南
description: Mihomo (原 Clash Meta) 的 DNS 泄露是很多人的隐私痛点。本文深入解析 Fake-IP 模式、分流策略以及如何编写一份无泄露的 DNS 配置。
published: 2026-01-22
tags: [Mihomo, Clash, DNS, 隐私安全, 教程]
category: Guides
---

在折腾软路由或使用代理工具时，**DNS 泄露 (DNS Leak)** 是一个老生常谈但极其致命的问题。

如果你配置不当，即使你的流量走了代理，你的 DNS 请求（即你去过哪些网站）依然是明文发送给运营商 ISP 的。这不仅暴露了隐私，还可能导致 DNS 污染，让你无法访问目标网站。

今天我们来聊聊目前最强大的内核 **Mihomo (原 Clash Meta)**，如何通过配置彻底堵死 DNS 泄露。

---

### 🧐 为什么会泄露？

Mihomo 作为一个三层（Layer 3）接管工具，如果 DNS 模块配置不当，操作系统会绕过内核直接向系统默认的 DNS 服务器（通常是 ISP 分配的）发起请求。

要解决这个问题，我们需要做两件事：
1.  **劫持流量**：强制所有 DNS 请求走 Mihomo 内核。
2.  **分流解析**：国内域名走国内 DNS（快），国外域名走加密 DNS（安全）。

### 🛠️ 核心配置方案 (Copy & Paste)

推荐使用 **Fake-IP (虚假 IP)** 模式。这种模式不仅解析速度最快，而且能最大程度避免 DNS 泄露，因为客户端根本拿不到真实的 IP，所有的解析工作都由远端节点完成。

打开你的配置文件（`config.yaml` 或各类 GUI 的设置区），找到 `dns` 字段，参考以下配置：

```yaml
dns:
  enable: true
  listen: 0.0.0.0:1053
  ipv6: false # 除非你有原生 IPv6 环境，否则建议关闭
  prefer-h3: true # H3基于QUIC协议，相比传统TCP+TLS (DoT) 减少了连接建立的握手次数，降低了延迟
  # 核心模式：fake-ip
  enhanced-mode: fake-ip
  fake-ip-range: 198.18.0.1/16
  fake-ip-filter:
    - "*.lan"
    - "*.local"
  
  # 默认 DNS (用于解析 DoH 域名的 IP，必须是纯 IP)
  default-nameserver:
    - 223.5.5.5
    - 119.29.29.29

  # 核心 Nameserver (国外/兜底 DNS)
  # 建议使用 DoH (https) 或 DoT (tls) 防止中间人监听
  nameserver:
    - https://1.1.1.1/dns-query
    - https://dns.google/dns-query
  # 备用 DNS
  fallback:
    - https://cloudflare-dns.com/dns-query
    - tls://8.8.4.4:853
  
  # 关键设置：启用 fallback 筛选
  # 当 nameserver 返回的 IP 是非 CN IP 时，才会使用 fallback 的结果
  fallback-filter:
    geoip: true
    geoip-code: CN
    ipcidr:
      - 240.0.0.0/4

  # 国内域名特殊处理 (分流)
  # 强制国内大站走阿里/腾讯 DNS，速度起飞且无污染
  nameserver-policy:
    "geosite:cn,private":
      - https://dns.alidns.com/dns-query
      - https://doh.pub/dns-query
```

### 💡 配置解读

1. **`enhanced-mode: fake-ip`**:
这是防泄露的关键。你的浏览器请求 `google.com` 时，Mihomo 会立即返回一个假 IP `198.18.0.x`，浏览器直接向这个假 IP 发包，Mihomo 捕获后，再通过代理节点在远端进行真正的 DNS 解析。**本地 ISP 根本不知道你在解析什么。**
2. **`nameserver-policy`**:
这是**速度与隐私的平衡点**。我们通过 `geosite:cn` 规则，让淘宝、百度、B站等国内流量，直接走阿里云/腾讯云的 DoH 解析，既快又准，不会把国内流量绕地球一圈。
3. **加密协议 (DoH/DoT)**:
注意看，我所有的上游 DNS 都使用了 `https://` 或 `tls://`。这意味着你和 DNS 服务器之间的通讯是加密的，运营商无法通过抓包看到你的 DNS 请求内容。

### 🧪 如何验证？

配置完成后，重启 Mihomo 内核。

1. 打开浏览器，访问 [https://dnsleaktest.com](https://dnsleaktest.com) 或 [https://browserleaks.com/dns](https://browserleaks.com/dns)。
2. 点击 **Extended Test**。
3. **观察结果**：
* ✅ **成功**：如果你看到的 IP 都是 Google、Cloudflare 或你的 VPS 厂商的 IP，且**没有中国运营商的 IP**。
* ❌ **失败**：如果你看到了“China Telecom (中国电信)”或“China Unicom”的字眼，说明依然存在泄露。



---

### ⚡️ 进阶：自建节点的必要性

配置再好的 DNS，如果你的代理节点本身不稳定或者不安全，那也是白搭。

对于注重隐私和折腾的朋友，我强烈建议**购买 VPS 自建节点**。相比于万人骑的“机场”，自建节点独享 IP，配合 Mihomo 的 Reality 协议，隐蔽性和安全性都是顶级的。

这里推荐两个我常年用作“后端/梯子”的 VPS 商家，性价比极高：

#### 1. RackNerd (稳如老狗首选)

大名鼎鼎的美国四大金刚之首。除了用来做节点，我还用它跑了一些 Docker 服务和 Uptime Kuma 监控。

* **推荐配置**：1GB 内存 / 2TB 流量 / 洛杉矶 DC-02 机房
* **价格**：**$11.29 / 年** (简直是白送)
* [👉 **点击直达 RackNerd 2025 新年特惠页](https://my.racknerd.com/aff.php?aff=17943)**

#### 2. DediRock (黑五新秀)

最近很火的特价机，KVM 架构，纽约/洛杉矶可选。

* **推荐配置**：1核 2G / 15G SSD
* **价格**：**$6.59 / 年** (打破地板价)
* [👉 **点击直达 DediRock 特惠套餐](https://billing.dedirock.com/aff.php?aff=294)**

---

### 📝 总结

Mihomo 的强大在于其灵活的路由和 DNS 控制能力。通过 **Fake-IP + DoH + Nameserver Policy** 的组合，我们可以在享受国内直连速度的同时，确保海外访问的绝对隐私。

折腾网络就是这样，多配置一行代码，多一份掌控感。Happy Hacking! 🚀