import { appendFileSync } from "fs";

const host = process.env.HOST || "ikuuu.nl";
const logInUrl = `https://${host}/auth/login`;
const checkInUrl = `https://${host}/user/checkin`;

// 配置（从环境变量读取，提供默认值）
const CONCURRENCY = Number(process.env.CONCURRENCY || 3);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 15000);
const FETCH_RETRIES = Number(process.env.FETCH_RETRIES || 3);

// ---------------------- 工具函数 ----------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function jitter(ms) {
  const factor = 0.85 + Math.random() * 0.3;
  return Math.floor(ms * factor);
}

// 简化版错误分类
function classifyFetchError(err) {
  const msg = (err?.message || "").toLowerCase();
  if (msg.includes("timeout")) return "TIMEOUT";
  if (msg.includes("getaddrinfo") || msg.includes("enotfound")) return "DNS";
  if (msg.includes("certificate") || msg.includes("tls")) return "TLS";
  if (msg.includes("econnreset") || msg.includes("socket")) return "CONNECTION";
  if (msg.includes("fetch failed")) return "NETWORK";
  return "UNKNOWN";
}

// 优化的重试逻辑（更简单但有效）
async function fetchWithRetry(url, options = {}, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
      // 使用更基础的请求头
      headers: {
        'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...options.headers
      }
    });

    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    return res;
  } catch (err) {
    clearTimeout(timeout);

    const errorType = classifyFetchError(err);
    console.log(`⚠️ 请求失败 [${errorType}] (尝试 ${attempt}/${FETCH_RETRIES}): ${err.message}`);

    if (attempt < FETCH_RETRIES) {
      const backoff = jitter(800 * Math.pow(2, attempt - 1));
      console.log(`🔄 重试等待 ${backoff}ms`);
      await sleep(backoff);
      return fetchWithRetry(url, options, attempt + 1);
    }

    throw err;
  }
}

// 格式化 Cookie
function formatCookie(rawCookieArray) {
  const cookiePairs = new Map();
  for (const cookieString of rawCookieArray) {
    const match = cookieString.match(/^\s*([^=]+)=([^;]*)/);
    if (match) {
      cookiePairs.set(match[1].trim(), match[2].trim());
    }
  }
  return Array.from(cookiePairs).map(([key, value]) => `${key}=${value}`).join("; ");
}

function setGitHubOutput(name, value) {
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
}

// ---------------------- 核心逻辑 ----------------------

// 登录获取 Cookie
async function logIn(account) {
  console.log(`${account.name}: 登录中...`);

  const formData = new FormData();
  formData.append("host", host);
  formData.append("email", account.email);
  formData.append("passwd", account.passwd);
  formData.append("code", "");
  formData.append("remember_me", "off");

  const response = await fetchWithRetry(logInUrl, {
    method: "POST",
    body: formData,
    headers: {
      'Referer': logInUrl,
      'Origin': `https://${host}`,
    }
  });

  const responseJson = await response.json().catch(() => ({ ret: 0, msg: "响应不是JSON" }));

  if (responseJson.ret !== 1) {
    throw new Error(`登录失败: ${responseJson.msg || "未知错误"}`);
  }

  console.log(`${account.name}: ${responseJson.msg}`);

  const rawCookieArray = response.headers.getSetCookie?.() || [];
  if (!rawCookieArray || rawCookieArray.length === 0) {
    throw new Error("获取 Cookie 失败");
  }

  return { ...account, cookie: formatCookie(rawCookieArray) };
}

// 签到
async function checkIn(account) {
  const response = await fetchWithRetry(checkInUrl, {
    method: "POST",
    headers: {
      Cookie: account.cookie,
      'Referer': `https://${host}/user`,
      'Origin': `https://${host}`,
    },
  });

  const data = await response.json().catch(() => ({ msg: "响应不是JSON" }));
  console.log(`${account.name}: ${data.msg}`);

  return data.msg;
}

// 处理单个账号
async function processSingleAccount(account) {
  try {
    const cookedAccount = await logIn(account);
    const result = await checkIn(cookedAccount);
    return { status: "fulfilled", value: result };
  } catch (error) {
    return { status: "rejected", reason: error };
  }
}

// ---------------------- 入口 ----------------------

async function main() {
  console.log("🚀 IKUUU-Auto-Checkin 启动");
  console.log(`📡 目标主机: ${host}`);
  console.log(`👥 并发数: ${CONCURRENCY}`);
  console.log(`⏱️ 超时: ${FETCH_TIMEOUT_MS}ms, 重试: ${FETCH_RETRIES}次\n`);

  let accounts;

  try {
    if (!process.env.ACCOUNTS) {
      throw new Error("❌ 未配置账户信息（ACCOUNTS）。");
    }

    accounts = JSON.parse(process.env.ACCOUNTS);
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error("❌ 账户信息为空或不是数组。");
    }

    // 账户信息验证
    accounts.forEach((account, index) => {
      if (!account.email || !account.passwd) {
        throw new Error(`❌ 账户 #${index + 1} 缺少 email 或 passwd 字段`);
      }
      if (!account.name) {
        account.name = `Account#${index + 1}`;
      }
    });

  } catch (error) {
    const message = `❌ ${String(error.message).includes("JSON") ? "账户信息配置格式错误（不是合法 JSON）。" : error.message}`;
    console.error(message);
    setGitHubOutput("result", message);
    setGitHubOutput("success", "false");
    process.exit(1);
  }

  console.log(`📋 账户列表: ${accounts.map(a => a.name).join(", ")}\n`);
  console.log("🔄 开始执行签到流程...\n");

  const startTime = Date.now();

  // 使用初代代码的简单并行方式，但添加并发限制
  const results = [];
  const chunks = [];

  // 将账户分组，实现软并发限制
  for (let i = 0; i < accounts.length; i += CONCURRENCY) {
    chunks.push(accounts.slice(i, i + CONCURRENCY));
  }

  for (const chunk of chunks) {
    const chunkResults = await Promise.allSettled(
      chunk.map(account => processSingleAccount(account))
    );
    results.push(...chunkResults);

    // 如果还有待处理的账户，增加延迟，避免对服务器造成压力
    if (chunks.length > 1 && chunk !== chunks[chunks.length - 1]) {
      console.log("⏸️  间隔等待 2秒...");
      await sleep(2000);
    }
  }

  const duration = Date.now() - startTime;
  console.log(`\n⏱️ 总执行时间: ${duration}ms`);

  // 结果汇总
  const msgHeader = "\n======== 签到结果 ========\n\n";
  console.log(msgHeader);

  let successCount = 0;
  let failedCount = 0;
  const resultLines = results.map((result, index) => {
    const accountName = accounts[index]?.name ?? `Account#${index + 1}`;
    const isSuccess = result.status === "fulfilled";

    if (isSuccess) successCount++;
    else failedCount++;

    const icon = isSuccess ? "✅" : "❌";
    const message = isSuccess ? result.value : result.reason.message;
    const line = `${accountName}: ${icon} ${message}`;

    isSuccess ? console.log(line) : console.error(line);
    return line;
  });

  const resultMsg = resultLines.join("\n");
  setGitHubOutput("result", resultMsg);
  setGitHubOutput("success", failedCount === 0 ? "true" : "false");
  setGitHubOutput("success_count", successCount.toString());
  setGitHubOutput("failed_count", failedCount.toString());

  console.log("\n" + "=".repeat(50));
  console.log(`✅ 成功: ${successCount}/${accounts.length}`);
  console.log(`❌ 失败: ${failedCount}/${accounts.length}`);
  console.log("=".repeat(50));

  if (failedCount > 0) {
    console.log("\n💡 建议:");
    console.log("1. 检查网络连接");
    console.log("2. 尝试调整 CONCURRENCY 环境变量（建议 1-3）");
    console.log("3. 检查目标网站是否正常");
    console.log("4. 如果问题持续，考虑使用代理");
  }

  if (failedCount > 0) {
    console.error(`\n❌ 执行完成，${failedCount} 个账号失败`);
    process.exit(1);
  } else {
    console.log(`\n✅ 执行成功，所有 ${successCount} 个账号签到完成`);
    process.exit(0);
  }
}

// 错误处理
process.on('uncaughtException', (err) => {
  console.error('🚨 未捕获的异常:', err);
  setGitHubOutput("result", `❌ 程序崩溃: ${err.message}`);
  setGitHubOutput("success", "false");
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('🚨 未处理的 Promise 拒绝:', reason);
  setGitHubOutput("result", `❌ 异步操作失败: ${reason}`);
  setGitHubOutput("success", "false");
  process.exit(1);
});

main();
