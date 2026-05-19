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

const ENV = process.env;
const DEFAULT_HOST = "cyber.cc.cd";
const DEFAULT_API_KEY = "43d3b715bb144880b337831e95ac0741";

// IndexNow 端点
const ENDPOINTS = [
	`https://api.indexnow.org/indexNow`,
	`https://www.bing.com/indexNow`,
];

function isTruthy(value) {
	if (!value) return false;
	return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function normalizeHost(host) {
	if (!host) return "";
	try {
		const url = host.startsWith("http") ? new URL(host) : new URL(`https://${host}`);
		return url.host;
	} catch {
		return host.replace(/^https?:\/\//, "").replace(/\/+$/, "");
	}
}

function getHostFromUrls(urls) {
	for (const url of urls) {
		try {
			return new URL(url).host;
		} catch {
			// ignore
		}
	}
	return "";
}

function normalizeUrlList(urls, host) {
	return urls.map((url) => {
		if (url.startsWith("http")) return url;
		return `https://${host}/${url.replace(/^\/+/, "")}`;
	});
}

function filterUrlsByHost(urls, host) {
	return urls.filter((url) => {
		try {
			return new URL(url).host === host;
		} catch {
			return false;
		}
	});
}

function buildKeyLocation(host, key, keyLocation) {
	if (!keyLocation) return `https://${host}/${key}.txt`;
	if (keyLocation.startsWith("http")) return keyLocation;
	return `https://${host}/${keyLocation.replace(/^\/+/, "")}`;
}

async function verifyKeyFile(keyLocation, key) {
	try {
		const res = await fetch(keyLocation, { method: "GET" });
		if (!res.ok) {
			console.warn(
				`[IndexNow] ⚠ 无法验证 key 文件，返回 ${res.status}，将跳过提交`,
			);
			return false;
		}
		const text = (await res.text()).trim();
		if (text !== key) {
			console.warn("[IndexNow] ⚠ key 文件内容不匹配，将跳过提交");
			return false;
		}
		return true;
	} catch (err) {
		console.warn(`[IndexNow] ⚠ 无法验证 key 文件，将跳过提交: ${err.message}`);
		return false;
	}
}

/**
 * 从 sitemap 中提取所有 URL
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
 * 向 IndexNow 端点提交 URL（方案 1：key 文件在根目录，不传 keyLocation）
 */
async function submitUrls({ host, apiKey, urls, keyLocation, includeKeyLocation }) {
	// 方案 1：key 文件在根目录 https://host/key.txt
	// 不需要 keyLocation 字段
	const payload = {
		host,
		key: apiKey,
		urlList: urls,
	};
	if (includeKeyLocation) {
		payload.keyLocation = keyLocation;
	}
	const body = JSON.stringify(payload);

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

if (isTruthy(ENV.INDEXNOW_DISABLE)) {
	console.log("[IndexNow] 已禁用提交，跳过");
	process.exit(0);
}

const inferredHost = getHostFromUrls(urls);
const host = normalizeHost(ENV.INDEXNOW_HOST ?? inferredHost ?? DEFAULT_HOST);
const apiKey = (ENV.INDEXNOW_KEY ?? DEFAULT_API_KEY).trim();

if (!host || !apiKey) {
	console.log("[IndexNow] 缺少 host 或 key，跳过提交");
	process.exit(0);
}

const normalizedUrls = normalizeUrlList(urls, host);
const filteredUrls = filterUrlsByHost(normalizedUrls, host);
if (filteredUrls.length === 0) {
	console.log("[IndexNow] 没有匹配 host 的 URL，跳过提交");
	process.exit(0);
}
if (filteredUrls.length !== normalizedUrls.length) {
	console.log("[IndexNow] 部分 URL host 不匹配，已跳过");
}

const keyLocation = buildKeyLocation(host, apiKey, ENV.INDEXNOW_KEY_LOCATION);
const verified = await verifyKeyFile(keyLocation, apiKey);
if (!verified) {
	process.exit(0);
}

console.log(`[IndexNow] 准备提交 ${filteredUrls.length} 个 URL...`);
await submitUrls({
	host,
	apiKey,
	urls: filteredUrls,
	keyLocation,
	includeKeyLocation: Boolean(ENV.INDEXNOW_KEY_LOCATION),
});
