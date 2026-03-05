import { appendFileSync } from "fs";

/**
 * 说明：
 * - 主域：secrets.HOST 或默认 ikuuu.nl
 * - 备用域：ikuuu.fyi（你提供的）
 * - 登录/签到遇到“连不上”的错误，会自动切到备用域
 */

const PRIMARY_HOST = (process.env.HOST || "ikuuu.nl").trim();
const FALLBACK_HOST = "ikuuu.fyi";

const callbackPrefix = "https://api.chuckfang.com/第五个季节/";

// 并发控制
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);

// 更抗抖：超时与重试
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 25000);
const FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 5);

// ---------------------- 工具函数 ----------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms) {
  const factor = 0.85 + Math.random() * 0.3;
  return Math.floor(ms * factor);
}

function classifyFetchError(err) {
  const name = err?.name || "";
  const msg = err?.message || "";
  const causeMsg = err?.cause?.message || "";
  const combined = `${name} ${msg} ${causeMsg}`.toLowerCase();

  if (name === "AbortError") return "TIMEOUT";
  if (combined.includes("connect timeout")) return "CONNECT_TIMEOUT";
  if (combined.includes("getaddrinfo") || combined.includes("enotfound")) return "DNS";
  if (combined.includes("certificate") || combined.includes("tls")) return "TLS";
  if (combined.includes("econnreset") || combined.includes("socket")) return "SOCKET";
  if (combined.includes("timed out") || combined.includes("timeout")) return "TIMEOUT";
  if (combined.includes("fetch failed")) return "FETCH_FAILED";

  return "UNKNOWN";
}

function isNetworkish(kind) {
  // 这些属于“连不上/网络抖动”，适合切备用域
  return ["CONNECT_TIMEOUT", "DNS", "TLS", "SOCKET", "TIMEOUT", "FETCH_FAILED"].includes(kind);
}

async function fetchWithRetry(url, options = {}, cfg = {}) {
  const retries = cfg.retries ?? FETCH_RETRIES;
  const timeoutMs = cfg.timeoutMs ?? FETCH_TIMEOUT_MS;

  let lastErr;

  for (let attempt = 1; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, { ...options, signal: controller.signal });
      clearTimeout(timeout);
      return res;
    } catch (err) {
      clearTimeout(timeout);
      lastErr = err;

      const kind = classifyFetchError(err);
      const cause = err?.cause?.message ? ` | cause: ${err.cause.message}` : "";
      console.error(`❌ fetch error [${kind}] (${attempt}/${retries}) ${url}${cause}`);

      if (attempt < retries) {
        const base = kind === "CONNECT_TIMEOUT" ? 1500 : 1000;
        const backoff = jitter(base * Math.pow(2, attempt - 1));
        await sleep(backoff);
      }
    }
  }

  throw lastErr;
}

async function readJsonSafely(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.length > 200 ? text.slice(0, 200) + "..." : text;
    throw new Error(`响应不是有效 JSON：${snippet}`);
  }
}

function formatCookie(rawCookieArray) {
  const cookiePairs = new Map();
  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);
    if (match) cookiePairs.set(match[1].trim(), match[2].trim());
  }
  return Array.from(cookiePairs)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let idx = 0;

  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const cur = idx++;
      if (cur >= items.length) break;
      results[cur] = await mapper(items[cur], cur);
    }
  });

  await Promise.all(workers);
  return results;
}

function setGitHubOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
}

function makeUrls(host) {
  const base = host.startsWith("http") ? host : `https://${host}`;
  return {
    host,
    logInUrl: `${base}/auth/login`,
    checkInUrl: `${base}/user/checkin`,
  };
}

// ---------------------- 核心：域名自动切换 ----------------------

async function logInWithHost(account, urls) {
  console.log(`${account.name}: 登录中... (${urls.host})`);

  const formData = new FormData();
  formData.append("host", urls.host); // 保持原逻辑
  formData.append("email", account.email);
  formData.append("passwd", account.passwd);
  formData.append("code", "");
  formData.append("remember_me", "off");

  const response = await fetchWithRetry(urls.logInUrl, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) throw new Error(`登录接口 HTTP 错误 - ${response.status}`);

  const responseJson = await readJsonSafely(response);
  if (responseJson?.ret !== 1) throw new Error(`登录失败: ${responseJson?.msg ?? "未知错误"}`);

  console.log(`${account.name}: ${responseJson.msg} (${urls.host})`);

  const rawCookieArray = response.headers.getSetCookie?.() || [];
  if (!rawCookieArray.length) throw new Error("获取 Cookie 失败（响应头无 Set-Cookie）");

  return { cooked: { ...account, cookie: formatCookie(rawCookieArray) }, usedUrls: urls };
}

async function checkInWithHost(accountWithCookie, urls) {
  const response = await fetchWithRetry(urls.checkInUrl, {
    method: "POST",
    headers: { Cookie: accountWithCookie.cookie },
  });

  if (!response.ok) throw new Error(`签到接口 HTTP 错误 - ${response.status}`);

  const data = await readJsonSafely(response);
  const msg = data?.msg ?? "（无返回消息）";
  console.log(`${accountWithCookie.name}: ${msg} (${urls.host})`);
  return msg;
}

async function callbackToYourApi(accountName, msg) {
  const fullMsg = `${accountName}: ${msg}`;
  const url = `${callbackPrefix}${encodeURIComponent(fullMsg)}`;

  try {
    const res = await fetchWithRetry(url, { method: "GET" }, { retries: 4, timeoutMs: 10000 });
    if (!res.ok) console.error(`⚠️ 回调 API HTTP 错误 - ${res.status}`);
  } catch (err) {
    const kind = classifyFetchError(err);
    console.error(`⚠️ 回调 API 失败 [${kind}]：${err.message}`);
  }
}

async function processSingleAccount(account) {
  const primary = makeUrls(PRIMARY_HOST);
  const fallback = makeUrls(FALLBACK_HOST);

  // 1) 先尝试主域登录
  try {
    const { cooked, usedUrls } = await logInWithHost(account, primary);

    // 2) 主域签到
    const msg = await checkInWithHost(cooked, usedUrls);

    // 3) 回调（失败不影响主流程）
    await callbackToYourApi(account.name, msg);

    return msg;
  } catch (err) {
    const kind = classifyFetchError(err);
    const cause = err?.cause?.message ? ` | cause: ${err.cause.message}` : "";

    // 只有“网络类错误”才切备用域；账号密码错等就不切
    if (!isNetworkish(kind)) {
      throw new Error(`${err.message}${cause}`);
    }

    console.error(`⚠️ 主域异常（${PRIMARY_HOST}）[${kind}]，切换备用域：${FALLBACK_HOST}`);

    // 备用域登录 + 签到
    try {
      const { cooked, usedUrls } = await logInWithHost(account, fallback);
      const msg = await checkInWithHost(cooked, usedUrls);
      await callbackToYourApi(account.name, msg);
      return msg;
    } catch (err2) {
      const cause2 = err2?.cause?.message ? ` | cause: ${err2.cause.message}` : "";
      throw new Error(`${err2.message}${cause2}`);
    }
  }
}

// ---------------------- 入口 ----------------------

async function main() {
  let accounts;

  try {
    if (!process.env.ACCOUNTS) throw new Error("❌ 未配置账户信息（ACCOUNTS）。");
    accounts = JSON.parse(process.env.ACCOUNTS);
    if (!Array.isArray(accounts) || accounts.length === 0) throw new Error("❌ 账户信息为空或不是数组。");
  } catch (error) {
    const message = `❌ ${
      String(error.message).includes("JSON")
        ? "账户信息配置格式错误（不是合法 JSON）。"
        : error.message
    }`;
    console.error(message);
    setGitHubOutput("result", message);
    process.exit(1);
  }

  console.log(
    `共 ${accounts.length} 个账号，并发数：${CONCURRENCY}\n主域：${PRIMARY_HOST}\n备用域：${FALLBACK_HOST}\n`
  );

  const results = await mapLimit(accounts, CONCURRENCY, async (account) => {
    try {
      const msg = await processSingleAccount(account);
      return { status: "fulfilled", value: msg };
    } catch (err) {
      return { status: "rejected", reason: err };
    }
  });

  console.log("\n======== 签到结果 ========\n");

  let hasError = false;

  const lines = results.map((r, i) => {
    const name = accounts[i]?.name ?? `Account#${i + 1}`;
    const ok = r.status === "fulfilled";
    if (!ok) hasError = true;

    const icon = ok ? "✅" : "❌";
    const message = ok ? r.value : (r.reason?.message || String(r.reason));
    const line = `${name}: ${icon} ${message}`;

    ok ? console.log(line) : console.error(line);
    return line;
  });

  setGitHubOutput("result", lines.join("\n"));

  if (hasError) process.exit(1);
}

main();
