---
title: 隐私自测：你的代理真的安全吗？浅谈 DNS 泄露与 WebRTC 漏洞
description: 挂了梯子就安全了？本文带你深入了解 DNS 泄露原理、WebRTC 导致的真实 IP 暴露问题，并提供主流浏览器的修复方案与在线检测工具。
published: 2026-01-22
tags: [隐私安全, DNS泄露, WebRTC, 科普, VPS]
---

很多朋友以为，只要打开 VPN 或代理软件，自己就在互联网上“隐身”了。

但现实往往很残酷：由于操作系统机制和浏览器默认行为，你的**真实 IP** 和 **访问记录 (DNS)** 很可能正在“裸奔”，直接暴露给了 ISP (运营商) 或网站管理员。

今天我们来聊聊两个最隐蔽的隐私杀手：**DNS Leaks (DNS 泄露)** 和 **WebRTC Leaks**，并教你如何自测和修复。

---

### 🕵️ 第一步：立刻自测

在继续阅读之前，建议先关掉你的代理，测一次；然后打开代理，再测一次。对比两者的结果。

推荐使用以下两个业界公认的检测工具：

1.  **BrowserLeaks DNS Test**
    * 👉 [https://browserleaks.com/dns](https://browserleaks.com/dns)
    * *看点：如果不开启代理时显示中国国旗，开启后依然显示中国国旗（或出现了国内运营商的名字），说明你已经泄露了。*

2.  **IPLeak.net**
    * 👉 [https://ipleak.net/](https://ipleak.net/)
    * *看点：这是一个综合体检，包含了 IP、DNS、WebRTC 和 Torrent 检测。*

---

### 💧 什么是 DNS 泄露 (DNS Leaks)?

简单来说，DNS 泄露是指：虽然你建立了一个加密的 VPN 隧道，但你的系统却**愚蠢地将 DNS 查询请求（即你输入的网址）发到了隧道之外**，直接发给了 ISP 的默认 DNS 服务器。

#### 为什么会发生这种情况？
主要锅在 Windows。Windows 系统缺乏“全局 DNS”的严格概念。每个网络接口（网卡）都可以有自己的 DNS。

在某些复杂网络环境下，系统核心进程 `svchost.exe` 可能会无视 VPN 隧道的路由表，直接通过默认网关发送 DNS 查询。这就导致了：流量走了代理，但“路牌查询”没走代理。

#### 我需要担心吗？
* **如果你在乎隐私：** 绝对需要。一旦泄露，ISP 就知道你访问了哪些网站（虽然不知道内容，但知道域名）。
* **如果你身处受限网络环境：** 这不仅是隐私问题，更是可用性问题。DNS 泄露通常伴随着 DNS 污染，导致你即便挂了梯子也打不开目标网页。

> 🚀 **实战教程**
>
> 明白了原理后，如何动手修改配置文件？请阅读我的详细实操指南：
> [**彻底解决 DNS 泄露：Mihomo (Clash Meta) 核心配置指南**](/blog/mihomo-dns-leak-guide)
---

### 🔓 什么是 WebRTC 泄露？

这是一个很容易被忽视的浏览器漏洞。

**WebRTC (Web Real-Time Communication)** 是一种允许浏览器直接进行音视频通话的技术（比如网页版 Google Meet 或 Discord）。为了实现点对点传输，它实现了一个叫 **STUN (Session Traversal Utilities for NAT)** 的协议。

**致命点在于：** STUN 协议允许网页通过 JavaScript 请求，绕过代理插件，直接发现并获取你的**真实公网 IP 地址**。

#### 🛡️ 如何修复 WebRTC 泄露？

不同浏览器有不同的关闭方法，建议根据你的主力浏览器进行设置：

* **🦊 Mozilla Firefox (最推荐，原生支持关闭):**
    1.  在地址栏输入 `about:config` 并回车（接受风险提示）。
    2.  搜索 `media.peerconnection.enabled`。
    3.  双击将其值设置为 **`false`**。

* **🟣 Opera:**
    1.  在地址栏输入 `about:config` 或直接去“设置”。
    2.  找到“隐私与安全 (Privacy & security)”。
    3.  在 WebRTC 选项中，选择 **"Disable non-proxied UDP" (禁用非代理 UDP)**。

* **🌈 Google Chrome / Edge:**
    Chrome 原生很难彻底关闭 WebRTC（因为这是 Google 亲儿子技术）。
    建议安装官方扩展：**[WebRTC Network Limiter](https://chrome.google.com/webstore/detail/webrtc-network-limiter/npeicpdbjetoah/njfpommpghlbhe)**，并在扩展设置中选择屏蔽策略。

---

### 🧲 关于 BT 下载 (Torrent) 检测

在 `ipleak.net` 上你会看到一个 Torrent Address 检测。它的原理很有趣：

检测网站会提供一个**假的磁力链接 (Magnet Link)**。当你用迅雷或 qBittorrent 下载这个链接时，你的下载客户端会向检测方的 Tracker 服务器汇报状态。

由于 BT 协议通常走 UDP，很多简易的 HTTP 代理无法接管 BT 流量。如果网页上显示出了你的真实 IP，说明你在下载“不可描述”资源时，其实是在裸奔。

---

### 🧱 安全的基石：纯净的 IP

软件层面的修补（关闭 WebRTC、配置 Clash/Mihomo DNS 防泄露）只是第一步。

要实现真正的隐私安全，你连接的**目标节点**必须足够干净、可控。相比于多人共享的“机场”节点，拥有一台**独享 IP 的 VPS** 是构建安全隧道的最佳基石。

以下是我自用并推荐的高性价比 VPS，适合用来搭建专属的隐私隧道：

#### 1. RackNerd (美西四大金刚，稳如磐石)
我的主力备用节点。如果不折腾，它就是目前市面上最稳的廉价机器。推荐选择 **洛杉矶 DC-02** 机房，延迟低且稳定。
* **推荐方案**：1GB 内存 / 2TB 流量 / 年付仅需 $11.29
* **[👉 点击查看 RackNerd 2025 特惠套餐](https://my.racknerd.com/aff.php?aff=17943)**

#### 2. DediRock (性价比新秀)
如果你追求极致的价格，比如只是为了偶尔查阅资料，DediRock 的黑五/新年套餐非常划算。KVM 架构意味着你可以完全掌控系统内核，配置防火墙规则。
* **推荐方案**：1核 2G / 15G SSD / 年付 $6.59 起
* **[👉 点击查看 DediRock 特价列表](https://billing.dedirock.com/aff.php?aff=294)**

---

**最后总结：** 隐私保护是一个系统工程。修补浏览器漏洞、配置正确的 DNS 分流策略、并使用可信的 VPS 节点，这三者缺一不可。