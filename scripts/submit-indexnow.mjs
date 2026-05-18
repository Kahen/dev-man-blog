/**
 * IndexNow URL 提交脚本
 *
 * 构建完成后自动将所有页面 URL 提交到 IndexNow，通知 Bing/Yandex 等搜索引擎更新索引。
 * 用法：node scripts/submit-indexnow.mjs [url1] [url2] ...
 *   - 不传参数：读取 sitemap.xml 提交所有 URL
 *   - 传参数：只提交指定的 URL（用于增量更新）
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const HOST = "cyber.cc.cd";
const API_KEY = "43d3b715bb144880b337831e95ac0741";
const KEY_LOCATION = `https://${HOST}/${API_KEY}.txt`;

// IndexNow 支持的端点（提交到任一个即可，搜索引擎会共享数据）
const ENDPOINTS = [
	`https://api.indexnow.org/IndexNow`,
	`https://www.bing.com/IndexNow`,
];

/**
 * 从 sitemap 中提取所有 URL
 * Astro @astrojs/sitemap 生成 sitemap-index.xml → sitemap-0.xml 两级结构
 */
function getUrlsFromSitemap() {
	const distDir = resolve(ROOT, "dist");

	// 优先尝试 sitemap-index.xml（Astro 默认）
	const indexPath = resolve(distDir, "sitemap-index.xml");
	try {
		const indexContent = readFileSync(indexPath, "utf-8");
		const sitemapFiles = [];
		const indexRegex = /<loc>(.*?)<\/loc>/g;
		let m;
		while ((m = indexRegex.exec(indexContent)) !== null) {
			// loc 是线上 URL（如 https://cyber.cc.cd/sitemap-0.xml），取文件名映射到本地
			const filename = m[1].split("/").pop();
			sitemapFiles.push(resolve(distDir, filename));
		}

		const urls = [];
		for (const file of sitemapFiles) {
			const content = readFileSync(file, "utf-8");
			const regex = /<loc>(.*?)<\/loc>/g;
			let match;
			while ((match = regex.exec(content)) !== null) {
				urls.push(match[1]);
			}
		}
		if (urls.length > 0) return urls;
	} catch {
		// sitemap-index.xml 不存在，回退到 sitemap.xml
	}

	// 回退：直接读 sitemap.xml（单文件模式）
	const sitemapPath = resolve(distDir, "sitemap.xml");
	const content = readFileSync(sitemapPath, "utf-8");
	const urls = [];
	const regex = /<loc>(.*?)<\/loc>/g;
	let match;
	while ((match = regex.exec(content)) !== null) {
		urls.push(match[1]);
	}
	return urls;
}

/**
 * 向 IndexNow 端点提交 URL
 */
async function submitUrls(urls) {
	const body = JSON.stringify({
		host: HOST,
		key: API_KEY,
		keyLocation: KEY_LOCATION,
		urlList: urls,
	});

	for (const endpoint of ENDPOINTS) {
		try {
			const res = await fetch(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/json; charset=utf-8" },
				body,
			});

			if (res.ok || res.status === 202) {
				console.log(`[IndexNow] ✓ 提交成功 (${endpoint}) — ${urls.length} 个 URL`);
			} else {
				const text = await res.text();
				console.warn(`[IndexNow] ⚠ 提交返回 ${res.status} (${endpoint}): ${text}`);
			}
		} catch (err) {
			console.warn(`[IndexNow] ✗ 提交失败 (${endpoint}): ${err.message}`);
		}
	}
}

// 主逻辑
const args = process.argv.slice(2);
const urls = args.length > 0 ? args : getUrlsFromSitemap();

if (urls.length === 0) {
	console.log("[IndexNow] 没有需要提交的 URL");
	process.exit(0);
}

console.log(`[IndexNow] 准备提交 ${urls.length} 个 URL...`);
await submitUrls(urls);
