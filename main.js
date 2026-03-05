import { appendFileSync } from "fs";

// ==================== 配置区 ====================
const CONFIG = {
  host: process.env.HOST || "ikuuu.nl",
  timeout: 30000, // 请求超时 30 秒
  retryTimes: 3, // 重试次数
  retryDelay: 2000, // 重试延迟 2 秒
  concurrentLimit: 3, // 并发限制,避免服务器压力
  // 你原来的 notifyApi 保留；如不想通知，设为 "" 或删掉
  notifyApi: "https://api.chuckfang.com/第五个季节/",
};

const logInUrl = `https://${CONFIG.host}/auth/login`;
const checkInUrl = `https://${CONFIG.host}/user/checkin`;

// ==================== 工具函数 ====================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchWithTimeout(url, options = {}, timeout = CONFIG.timeout) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error?.name === "AbortError") {
      throw new Error(`请求超时 (${timeout}ms)`);
    }
    throw error;
  }
}

async function fetchWithRetry(url, options = {}, retryCount = 0) {
  try {
    return await fetchWithTimeout(url, options);
  } catch (error) {
    if (retryCount < CONFIG.retryTimes) {
      console.log(
        `请求失败, ${CONFIG.retryDelay / 1000} 秒后进行第 ${retryCount + 1} 次重试...`
      );
      await sleep(CONFIG.retryDelay);
      return fetchWithRetry(url, options, retryCount + 1);
    }
    throw error;
  }
}

function formatCookie(rawCookieArray) {
  if (!rawCookieArray || rawCookieArray.length === 0) return "";

  const cookieMap = new Map();
  for (const cookieString of rawCookieArray) {
    const parts = cookieString.split(";")[0].trim();
    const [key, ...valueParts] = parts.split("=");
    if (key) cookieMap.set(key.trim(), valueParts.join("=").trim());
  }
  return Array.from(cookieMap, ([k, v]) => `${k}=${v}`).join("; ");
}

function setGitHubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  try {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<EOF\n${value}\nEOF\n`);
  } catch (error) {
    console.error("写入 GitHub Output 失败:", error.message);
  }
}

async function sendNotification(message) {
  if (!CONFIG.notifyApi) return;

  try {
    const encodedMessage = encodeURIComponent(message);
    const notifyUrl = `${CONFIG.notifyApi}${encodedMessage}`;

    console.log(`发送通知到: ${CONFIG.notifyApi}`);

    const response = await fetchWithTimeout(
      notifyUrl,
      {
        method: "GET",
        headers: { "User-Agent": "IKUUU-Auto-Checkin/1.0" },
      },
      10000
    );

    if (!response.ok) {
      console.warn(`通知发送失败: HTTP ${response.status}`);
    }
  } catch (error) {
    console.error(`通知发送异常: ${error.message}`);
  }
}

// ==================== 核心业务逻辑 ====================

async function logIn(account) {
  console.log(`[${account.name}] 开始登录...`);

  const formData = new FormData();
  formData.append("email", account.email);
  formData.append("passwd", account.passwd);
  formData.append("code", "");

  const response = await fetchWithRetry(logInUrl, {
    method: "POST",
    body: formData,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    },
  });

  if (!response.ok) {
    throw new Error(`登录失败: HTTP ${response.status} - ${response.statusText}`);
  }

  const responseJson = await response.json();
  if (responseJson.ret !== 1) {
    throw new Error(`登录失败: ${responseJson.msg || "未知错误"}`);
  }

  const rawCookieArray = response.headers.getSetCookie?.() || [];
  const cookie = formatCookie(rawCookieArray);
  if (!cookie) {
    throw new Error("登录失败: 获取 Cookie 失败(可能账号密码错误或站点策略变化)");
  }

  return { ...account, cookie };
}

async function checkIn(account) {
  console.log(`[${account.name}] 开始签到...`);

  const response = await fetchWithRetry(checkInUrl, {
    method: "POST",
    headers: {
      Cookie: account.cookie,
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Content-Type": "application/x-www-form-urlencoded",
    },
  });

  if (!response.ok) {
    throw new Error(`签到失败: HTTP ${response.status} - ${response.statusText}`);
  }

  const data = await response.json();
  if (!data?.msg) {
    throw new Error("签到失败: 响应格式异常(缺少 msg)");
  }

  return String(data.msg);
}

async function processSingleAccount(account) {
  try {
    const cookedAccount = await logIn(account);
    await sleep(1000);
    const msg = await checkIn(cookedAccount);
    return { name: account.name, msg, ok: true };
  } catch (error) {
    // 失败也按你要的格式输出：名字: 错误信息（不带 emoji、不带“失败”字样也行）
    return { name: account.name, msg: error.message, ok: false };
  }
}

async function processAccountsWithLimit(accounts, limit = CONFIG.concurrentLimit) {
  const results = [];
  const executing = [];

  for (const account of accounts) {
    const promise = processSingleAccount(account).then((r) => {
      executing.splice(executing.indexOf(promise), 1);
      return r;
    });

    results.push(promise);
    executing.push(promise);

    if (executing.length >= limit) {
      await Promise.race(executing);
    }

    await sleep(500);
  }

  return Promise.all(results);
}

// ==================== 主函数 ====================

async function main() {
  console.log("========================================");
  console.log("IKUUU 自动签到脚本启动");
  console.log(`执行时间: ${new Date().toLocaleString("zh-CN")}`);
  console.log(`目标站点: ${CONFIG.host}`);
  console.log("========================================");

  let accounts;
  try {
    if (!process.env.ACCOUNTS) throw new Error("未配置 ACCOUNTS 环境变量");

    accounts = JSON.parse(process.env.ACCOUNTS);
    if (!Array.isArray(accounts) || accounts.length === 0) {
      throw new Error("账户列表为空或格式错误");
    }

    for (const account of accounts) {
      if (!account.name || !account.email || !account.passwd) {
        throw new Error(`账户配置不完整: ${JSON.stringify(account)}`);
      }
    }
  } catch (error) {
    const msg = `配置错误: ${error.message}`;
    console.error(msg);
    setGitHubOutput("result", msg);
    await sendNotification(msg);
    process.exit(1);
  }

  const results = await processAccountsWithLimit(accounts);

  // 只输出“名字: msg”
  const lines = results.map((r) => `${r.name}: ${r.msg}`);
  for (const line of lines) console.log(line);

  const fullResult = lines.join("\n");
  setGitHubOutput("result", fullResult);
  await sendNotification(fullResult);

  // 只要有一个失败，就退出码 1（便于 Actions 标红/告警）
  const hasFail = results.some((r) => !r.ok);
  if (hasFail) process.exit(1);
}

process.on("unhandledRejection", (error) => {
  console.error("未处理的 Promise 错误:", error);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("未捕获的异常:", error);
  process.exit(1);
});

main();
