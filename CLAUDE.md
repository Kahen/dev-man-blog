# dev-man-blog

Astro 驱动的中文技术博客，主题基于 Fuwari，部署在 Vercel。

## 技术栈

- **框架**: Astro 5 + Svelte 5
- **样式**: Tailwind CSS 3 + Stylus
- **代码高亮**: astro-expressive-code（github-dark 主题）
- **搜索**: Pagefind
- **数学公式**: remark-math + rehype-katex
- **包管理**: pnpm（强制使用，有 preinstall 校验）
- **Lint/Format**: Biome（tab 缩进，双引号）
- **部署**: Vercel

## 常用命令

```bash
pnpm dev          # 本地开发
pnpm build        # 构建（astro build + pagefind）
pnpm check        # Astro 类型检查
pnpm lint         # Biome lint
pnpm format       # Biome format
pnpm new-post -- <filename>  # 新建文章（放在 src/content/posts/）
```

## 项目结构

```
src/
├── content/
│   ├── posts/           # 文章目录
│   │   ├── blogs/       # 博客文章（主要写作位置）
│   │   └── guide/       # 指南类文章
│   ├── config.ts        # 内容集合 schema 定义
│   └── spec/            # about 页面
├── components/          # Astro + Svelte 组件
├── layouts/             # 页面布局
├── pages/               # 路由页面
├── plugins/             # remark/rehype 插件
├── config.ts            # 站点配置（标题、导航、个人资料）
├── constants/           # 常量
├── i18n/                # 国际化
└── styles/              # 全局样式
```

## 写博客文章

文章放在 `src/content/posts/blogs/` 目录，格式为 `.md`。如有附件（图片、SVG）可建同名文件夹用 `index.md`。

### Frontmatter 格式

```yaml
---
title: 文章标题
published: 2026-05-18
description: 一句话摘要
tags: [标签1, 标签2]
category: Guides          # 可选值：Guides / Architecture / 等
draft: false              # 可选，默认 false
lang: zh_CN               # 可选，中文文章建议填
image: ./cover.svg        # 可选，封面图（相对路径）
---
```

### 写作风格

- 使用中文写作，面向后端/全栈开发者
- 开头用实际场景或生产事故引入问题，避免泛泛而谈
- 每种方案/实践都附带可运行的代码示例（项目已用 Kotlin/Java）
- 用 `---` 分隔主要章节，`##` 用于大节，`###` 用于小节
- 结尾用"常见坑"列表 + 可执行 checklist 收尾
- 适当使用 blockquote（`>`）标注核心结论
- 代码块注明语言（```kotlin、```sql、```lua 等）
- 图片放在 `src/assets/images/` 下对应子目录

### Markdown 扩展

项目支持以下 Markdown 扩展语法：

- **数学公式**: `$...$`（行内）和 `$$...$$`（块级），通过 KaTeX 渲染
- **GitHub 风格提示框**: `> [!NOTE]`、`> [!TIP]`、`> [!WARNING]` 等
- **自定义指令**: `:::note`、`:::tip`、`:::warning`、`:::caution`、`:::important`
- **GitHub 卡片**: `::github{repo="user/repo"}`

## 代码规范

- Biome 强制 tab 缩进、双引号
- `.astro` 和 `.svelte` 文件中部分 lint 规则已关闭（useConst、noUnusedVariables 等）
- CSS 文件不在 Biome 检查范围内

## 路径别名

tsconfig 中定义了以下别名：

- `@components/*` → `src/components/*`
- `@assets/*` → `src/assets/*`
- `@utils/*` → `src/utils/*`
- `@layouts/*` → `src/layouts/*`
- `@/*` → `src/*`
